/**
 * Word times for Qwen3-ASR's words (bead akou-chp.15): Qwen3-ForcedAligner-0.6B, run by CrispASR's
 * `--align-only` on the same audio Qwen decoded and the text it wrote. Each unit is one short child
 * process that loads the model, aligns and exits, so nothing stays in memory between units and
 * nothing outlives a job: the pid goes to the host like llama-server's (`onChild`), and a Worker
 * that is stopped has it killed.
 *
 * - **The text goes in on stdin** (`--text-file -`), never in the arguments, so a transcript never
 *   shows in `ps`. The audio is a private 16-bit WAV in a folder of its own, deleted after.
 * - **Always `-t 1`.** With more threads and the CPU under contention, CrispASR v0.8.44 on Linux
 *   gave some units times hundreds of seconds past their end (8 of 60 at `-t 8`); with one thread
 *   none of 38 runs did, and the GPU builds lose 12 to 15 % of their speed.
 * - **Every answer is checked**: a time outside the audio, or a word that starts before the one
 *   before it, fails the unit. Units that passed scored 99.97 % within 0.2 s, so the check let no
 *   plausible wrong time through.
 * - **The aligner's words are laid back over Qwen's, letter by letter.** CrispASR cuts the text its
 *   own way: it splits a hyphenated word (`good-looking,` comes back as `good-` and `looking,`) and
 *   moves an opening quote onto the word before (`says, "In` comes back as `says,"` and `In`). Its
 *   words, joined, spell Qwen's words joined; each of Qwen's words starts where the aligner's word
 *   holding its first letter or digit starts, and ends where the one holding its last ends. An
 *   answer that does not spell the text exactly fails the unit, and its words keep no times: a time
 *   is never guessed.
 *
 * A failed unit costs only its times; the words and the text are Qwen's either way. A unit that
 * runs past its deadline stops the aligner for the rest of the job (`Aligner` lives one job): a
 * hung or starved GPU would make every later unit wait out its own deadline for no times.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASR_RATE } from "./engine.ts";
import { wavBytes } from "./qwen.ts";

export interface AlignerOptions {
  /** The catalog id, named in a job's `engine.models` when it timed any word. */
  id: string;
  /** The GGUF, under its published name (CrispASR reads the family from it). */
  model: string;
  /** CrispASR and any arguments of its own, or a function that makes it (unpacking a build). */
  command: readonly string[] | (() => readonly string[]);
  /** Told of every process started (`true`) and ended (`false`), so a host can kill orphans. */
  onChild?(pid: number, alive: boolean): void;
  /**
   * Seconds a unit may take: this plus twice its length. Default 30. The first unit this process
   * runs on a model gets `FIRST_RUN_EXTRA_S` more, once, not once per job: CrispASR's first run on
   * a machine compiles its GPU shaders.
   */
  baseTimeoutS?: number;
  /** The first unit's extra seconds; default `FIRST_RUN_EXTRA_S`. */
  firstRunExtraS?: number;
}

/**
 * What one unit came back with: a start and an end per word, or why there are none. `timedOut`
 * marks a unit past its deadline, or one after it in the same job, which never ran.
 */
export type Alignment = { times: [number, number][] } | { error: string; timedOut?: true };

/** The models a first run was already given its extra time for, in this process. */
const warmed = new Set<string>();

/** Extra seconds for the first unit: shader compilation took 21 s idle and minutes under load. */
export const FIRST_RUN_EXTRA_S = 300;

/** How far past the audio's end a word may end, seconds: the aligner's 80 ms frame, rounded. */
const END_SLACK_S = 0.1;

/** The command line, the text aside (it goes on stdin). */
export function alignerArgs(command: readonly string[], model: string, wav: string): string[] {
  return [
    ...command,
    "--align-only",
    "-am",
    model,
    "-f",
    wav,
    "--text-file",
    "-",
    "--align-granularity",
    "word",
    "--align-format",
    "json",
    "-t",
    "1",
  ];
}

/**
 * The aligner's words, checked and laid back over `words` (Qwen's, split on whitespace): one
 * `[start, end]` per word, or why the answer cannot be used.
 */
export function joinAligned(words: readonly string[], raw: unknown, seconds: number): Alignment {
  if (!Array.isArray(raw)) return { error: "the aligner's answer is not a list of words" };
  let prev = Number.NEGATIVE_INFINITY;
  const got: { word: string; start: number; end: number }[] = [];
  for (const x of raw as { word?: unknown; start?: unknown; end?: unknown }[]) {
    const { word, start, end } = x ?? {};
    if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number")
      return { error: "the aligner's answer has a word with no time" };
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end > seconds + END_SLACK_S
    )
      return { error: `the aligner put a word outside the ${seconds.toFixed(2)} s of audio` };
    if (start < prev) return { error: "the aligner put a word before the one before it" };
    prev = start;
    got.push({ word, start, end });
  }
  // Which of the aligner's words each letter of the joined text is in.
  const owner: number[] = [];
  for (const [i, g] of got.entries()) for (const _ of g.word) owner.push(i);
  if (got.map((g) => g.word).join("") !== words.join(""))
    return { error: "the aligner's words do not spell the text" };
  const times: [number, number][] = [];
  let at = 0;
  for (const w of words) {
    const chars = [...w];
    const solid = chars.flatMap((c, i) => (/[\p{L}\p{N}]/u.test(c) ? [i] : []));
    const first = at + (solid[0] ?? 0);
    const last = at + (solid.at(-1) ?? chars.length - 1);
    at += chars.length;
    const t0 = (got[owner[first] as number] as (typeof got)[number]).start;
    const t1 = (got[owner[last] as number] as (typeof got)[number]).end;
    times.push([t0, Math.max(t0, t1)]);
  }
  return { times };
}

/** Runs CrispASR's aligner over units, one child process each. */
export class Aligner {
  readonly id: string;
  /** Set once a unit timed out: the units after it are not run. */
  private stopped: string | undefined;

  constructor(private readonly o: AlignerOptions) {
    this.id = o.id;
  }

  /** Times for `words` (Qwen's, in order) over `samples`, seconds into `samples`. */
  async align(samples: Float32Array, words: readonly string[]): Promise<Alignment> {
    const seconds = samples.length / ASR_RATE;
    if (this.stopped) return { error: this.stopped, timedOut: true };
    let command: readonly string[];
    try {
      command = typeof this.o.command === "function" ? this.o.command() : this.o.command;
    } catch (err) {
      return { error: `the aligner cannot start: ${(err as Error).message}` };
    }
    const dir = mkdtempSync(join(tmpdir(), "akou-align-"));
    try {
      const wav = join(dir, "unit.wav");
      writeFileSync(wav, wavBytes(samples), { mode: 0o600 });
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(alignerArgs(command, this.o.model, wav), {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (err) {
        return { error: `the aligner cannot start: ${(err as Error).message}` };
      }
      const pid = proc.pid;
      this.o.onChild?.(pid, true);
      const first = !warmed.has(this.o.model);
      warmed.add(this.o.model);
      const limitS =
        (this.o.baseTimeoutS ?? 30) +
        2 * seconds +
        (first ? (this.o.firstRunExtraS ?? FIRST_RUN_EXTRA_S) : 0);
      let timedOut = false;
      // clock: the unit's deadline; past it the process is killed and the unit keeps no times.
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, limitS * 1000);
      try {
        const stdin = proc.stdin as import("bun").FileSink;
        stdin.write(words.join(" "));
        await stdin.end();
      } catch {
        // The process went away before it read the text: its exit says why.
      }
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      this.o.onChild?.(pid, false);
      if (timedOut) {
        this.stopped = `the aligner took longer than ${Math.round(limitS)} s on an earlier piece`;
        return { error: `the aligner took longer than ${Math.round(limitS)} s`, timedOut: true };
      }
      if (code !== 0) {
        const tail = err.trim().split("\n").slice(-2).join(" | ").slice(0, 200);
        return { error: `the aligner exited with ${code}${tail ? `: ${tail}` : ""}` };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(out);
      } catch {
        return { error: "the aligner's answer is not JSON" };
      }
      return joinAligned(words, raw, seconds);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
