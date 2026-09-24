/**
 * akou's side of `akou-diarize` (docs/DESIGN.md section 3.4): NVIDIA's Nemotron 3 Diarization in a
 * Rust child process on ONNX Runtime, the runtime measured to give NeMo's decisions. sherpa-onnx
 * has no Sortformer, and ONNX Runtime's Node addon cannot share a Windows process with
 * sherpa-onnx's own `onnxruntime.dll`, so the model runs in a process of its own. A helper that
 * dies or hangs costs speaker labels, never the transcript or the recording.
 *
 * - `NemotronDiarizer` is the final pass: one helper per pass at the 30.4 s latency, the call
 *   channel of every part in, turns out, smoothed where the pass will cut (`smoothTurns`).
 * - `NemotronStream` is the live labeller: one helper at the 2.0 s latency, one stream per call.
 *   A reset is fenced: the helper answers it, and every turn read before that answer belongs to
 *   the stream that was reset and is dropped.
 */

import type { FileSink, Subprocess } from "bun";
import {
  ASR_RATE,
  type DiarizedSpan,
  type Diarizer,
  type SpeakerTurn,
  type StreamDiarizer,
  type StreamListener,
} from "./engine.ts";
import { smoothTurns } from "./speakers.ts";

export const DIARIZE_PROTOCOL = "akou-diarize/1";
export const DIARIZE_HELPER_NAME =
  process.platform === "win32" ? "akou-diarize.exe" : "akou-diarize";
/** Samples per audio frame: 4 MiB, about 65 s. The helper refuses frames over 16 MiB. */
const FRAME_SAMPLES = 1 << 20;
/** How long `close` waits for the helper to exit at the end of its input before killing it. */
const EXIT_GRACE_MS = 2000;

/**
 * How long the final pass waits for the helper's turns: a quarter of the audio's length, and never
 * under 30 s. CI measures under 3 s for 25 s of audio, model load included. It stays within half
 * the pass's own budget (`finalBudgetMs`), so a helper that hangs still leaves time to decode.
 */
export function diarizeDeadlineMs(samples: number): number {
  return Math.max(30_000, Math.round((samples / ASR_RATE) * 250));
}

export interface DiarizeHelperSpec {
  /** Program and leading arguments (`locateHelper`). */
  command: readonly string[];
  /** The ONNX file. */
  model: string;
  mode: "final" | "live";
  threads: number;
}

export type HelperMessage =
  | { type: "ready"; protocol: string; version: string; mode: string; latency: number }
  | { type: "turn"; spk: number; start: number; end: number }
  | { type: "decided" | "flushed"; at: number }
  | { type: "reset" }
  | { type: "error"; message: string };

/** One `akou-diarize/1` frame: kind, u32 little-endian length, payload. */
export function frame(kind: "a" | "f" | "r", samples?: Float32Array): Uint8Array {
  const n = samples ? samples.byteLength : 0;
  const out = new Uint8Array(5 + n);
  out[0] = kind.charCodeAt(0);
  new DataView(out.buffer).setUint32(1, n, true);
  if (samples) {
    // f32 little-endian on the wire; written one by one so the host's byte order never matters.
    const v = new DataView(out.buffer, 5);
    for (let i = 0; i < samples.length; i++) v.setFloat32(i * 4, samples[i] as number, true);
  }
  return out;
}

/** Parses one stdout line; anything that is not a known message is null. */
export function parseLine(line: string): HelperMessage | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const num = (k: string) => typeof m[k] === "number" && Number.isFinite(m[k]);
  switch (m.type) {
    case "ready":
      return typeof m.protocol === "string" ? (m as unknown as HelperMessage) : null;
    case "turn":
      return num("spk") && num("start") && num("end") ? (m as unknown as HelperMessage) : null;
    case "decided":
    case "flushed":
      return num("at") ? (m as unknown as HelperMessage) : null;
    case "reset":
      return { type: "reset" };
    case "error":
      return { type: "error", message: String(m.message ?? "") };
    default:
      return null;
  }
}

/** A running helper: frames in, parsed messages out, and one `onExit` however it ends. */
export class DiarizeHelper {
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private readonly stdin: FileSink;
  private stderrTail = "";
  private done = false;
  private closing = false;

  constructor(
    spec: DiarizeHelperSpec,
    private readonly onMessage: (m: HelperMessage) => void,
    private readonly onExit: (why: string) => void,
  ) {
    const [program, ...lead] = spec.command;
    if (!program) throw new Error("no akou-diarize command");
    this.proc = Bun.spawn(
      [
        program,
        ...lead,
        "run",
        "--model",
        spec.model,
        "--mode",
        spec.mode,
        "--threads",
        String(spec.threads),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    this.stdin = this.proc.stdin;
    void this.read();
    void this.readErr();
    void this.proc.exited.then((code) => {
      const tail = this.stderrTail.trim().split("\n").slice(-3).join("; ");
      this.finish(
        this.closing && code === 0
          ? "closed"
          : `akou-diarize exited with code ${code}${tail ? `: ${tail}` : ""}`,
      );
    });
  }

  private finish(why: string): void {
    if (this.done) return;
    this.done = true;
    this.onExit(why);
  }

  get alive(): boolean {
    return !this.done;
  }

  private async read(): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of this.proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === "") continue;
          const m = parseLine(line);
          if (!m) {
            this.kill(
              `akou-diarize wrote a line that is not ${DIARIZE_PROTOCOL}: ${line.slice(0, 120)}`,
            );
            return;
          }
          if (m.type === "ready" && m.protocol !== DIARIZE_PROTOCOL) {
            this.kill(`akou-diarize speaks ${m.protocol}, akou needs ${DIARIZE_PROTOCOL}`);
            return;
          }
          if (this.done) return;
          this.onMessage(m);
        }
      }
    } catch {}
  }

  private async readErr(): Promise<void> {
    const dec = new TextDecoder();
    try {
      for await (const chunk of this.proc.stderr) {
        this.stderrTail = (this.stderrTail + dec.decode(chunk, { stream: true })).slice(-2000);
      }
    } catch {}
  }

  /** Writes a frame. False once the helper is gone. */
  send(bytes: Uint8Array): boolean {
    if (this.done || this.closing) return false;
    try {
      this.stdin.write(bytes);
      void Promise.resolve(this.stdin.flush()).catch(() => {});
      return true;
    } catch (err) {
      this.kill(`writing to akou-diarize failed: ${(err as Error).message}`);
      return false;
    }
  }

  /** Writes a frame and waits until the pipe has taken it (bounded memory for long streams). */
  async sendAll(bytes: Uint8Array): Promise<void> {
    if (this.done || this.closing) throw new Error("akou-diarize is not running");
    this.stdin.write(bytes);
    await this.stdin.flush();
  }

  /** Ends the input; the helper exits on its own, or is killed after a grace period. */
  close(): void {
    if (this.done || this.closing) return;
    this.closing = true;
    try {
      void Promise.resolve(this.stdin.end()).catch(() => {});
    } catch {}
    const t = setTimeout(() => this.proc.kill(), EXIT_GRACE_MS);
    void this.proc.exited.then(() => clearTimeout(t));
  }

  kill(why: string): void {
    this.finish(why);
    try {
      this.proc.kill();
    } catch {}
  }
}

const toSeconds = (t: { spk: number; start: number; end: number }): DiarizedSpan => ({
  speaker: t.spk,
  start: t.start / ASR_RATE,
  end: t.end / ASR_RATE,
});

/** The final pass's diarizer: the whole call channel through one helper at the final latency. */
export class NemotronDiarizer implements Diarizer {
  constructor(
    private readonly spec: Omit<DiarizeHelperSpec, "mode">,
    private readonly onLoad: () => void = () => {},
    /** The deadline for the helper's answer; `diarizeDeadlineMs` of the audio by default. */
    private readonly deadlineMs?: number,
  ) {}

  process(samples: Float32Array): Promise<DiarizedSpan[]> {
    return new Promise<DiarizedSpan[]>((resolve, reject) => {
      const turns: DiarizedSpan[] = [];
      let settled = false;
      const settle = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        h.close();
        if (err) reject(err);
        else resolve(smoothTurns(turns));
      };
      const h = new DiarizeHelper(
        { ...this.spec, mode: "final" },
        (m) => {
          if (m.type === "turn") turns.push(toSeconds(m));
          else if (m.type === "flushed") settle(null);
          else if (m.type === "error") settle(new Error(`akou-diarize: ${m.message}`));
        },
        (why) => settle(new Error(why)),
      );
      const ms = this.deadlineMs ?? diarizeDeadlineMs(samples.length);
      const timer = setTimeout(() => h.kill(`akou-diarize gave no answer within ${ms} ms`), ms);
      this.onLoad();
      void (async () => {
        try {
          for (let at = 0; at < samples.length; at += FRAME_SAMPLES)
            await h.sendAll(frame("a", samples.subarray(at, at + FRAME_SAMPLES)));
          await h.sendAll(frame("f"));
        } catch (err) {
          settle(new Error(`sending audio to akou-diarize failed: ${(err as Error).message}`));
        }
      })();
    });
  }
}

/** The live labeller: one helper at the live latency, one stream per call. */
export class NemotronStream implements StreamDiarizer {
  private readonly h: DiarizeHelper;
  private batch: SpeakerTurn[] = [];
  private readonly flushes: { resolve(): void; reject(e: Error): void }[] = [];
  /** Resets sent and not yet answered: lines read meanwhile belong to the old stream. */
  private resets = 0;
  private dead: string | null = null;

  constructor(
    spec: Omit<DiarizeHelperSpec, "mode">,
    private readonly listener: StreamListener,
  ) {
    this.h = new DiarizeHelper(
      { ...spec, mode: "live" },
      (m) => this.message(m),
      (why) => this.die(why),
    );
  }

  private message(m: HelperMessage): void {
    switch (m.type) {
      case "turn":
        if (this.resets === 0) this.batch.push({ speaker: m.spk, start: m.start, end: m.end });
        return;
      case "decided":
        if (this.resets === 0) this.report(m.at);
        return;
      case "flushed":
        if (this.resets === 0) this.report(m.at);
        this.flushes.shift()?.resolve();
        return;
      case "reset":
        this.resets = Math.max(0, this.resets - 1);
        this.batch = [];
        return;
      case "error":
        this.h.kill(`akou-diarize: ${m.message}`);
        return;
      default:
        return;
    }
  }

  private report(at: number): void {
    const b = this.batch;
    this.batch = [];
    this.listener.turns(b, at);
  }

  private die(why: string): void {
    if (this.dead !== null) return;
    this.dead = why;
    for (const f of this.flushes.splice(0)) f.reject(new Error(why));
    if (why !== "closed") this.listener.dead(why);
  }

  push(samples: Float32Array): void {
    if (this.dead !== null) return;
    for (let at = 0; at < samples.length; at += FRAME_SAMPLES)
      this.h.send(frame("a", samples.subarray(at, at + FRAME_SAMPLES)));
  }

  flush(): Promise<void> {
    if (this.dead !== null) return Promise.reject(new Error(this.dead));
    return new Promise<void>((resolve, reject) => {
      this.flushes.push({ resolve, reject });
      this.h.send(frame("f"));
    });
  }

  reset(): void {
    if (this.dead !== null) return;
    this.resets++;
    this.batch = [];
    this.h.send(frame("r"));
  }

  close(): void {
    this.h.close();
  }
}
