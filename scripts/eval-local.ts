#!/usr/bin/env bun

/**
 * The evaluation on your own calls (docs/TESTING.md TS-21): the nightly's scoring (scripts/eval/
 * score.ts) run on the calls on this machine, with your own fixes as the hand reference. Only
 * numbers leave it; no word of a call is ever written.
 *
 *   bun scripts/eval-local.ts [--root ~/Recordings/akou] [--rttm <dir>] [--out docs/gates/eval-local-<date>.json]
 *
 * - **WER against hand corrections.** A fix is a correction a person or an agent made once the
 *   transcript had begun: a `vocab.add` not written by the app, after the call's first line, and a
 *   line's text rewritten by hand (a `seg` revision with `by`). The reference is each line as it
 *   reads with those fixes, the hypothesis the same line without them. `wer_fixed_lines` scores the
 *   lines a fix changed; `wer_lower_bound` spreads the same errors over every line of the calls that
 *   have a fix, the floor of the whole-call WER, since a line nobody fixed may still be wrong.
 * - **Recall.** Of the times a vocabulary term (every `vocab.add` term of the call) appears in the
 *   reference, the share the recognizer already wrote right.
 * - **DER**, with `--rttm`: `<dir>/<call folder>.rttm` holds the speakers you labelled by hand, in
 *   seconds of the call's audio. The hypothesis is akou's speaker per line. Calls with more than one
 *   part are skipped and counted, because an RTTM file has one timeline.
 *
 * The result is checked before it is written: every value must be a number (or null where nothing
 * was scored), so a string, and with it any text of a call, makes the script refuse and write
 * nothing. Keep the RTTM files outside the repository: they are yours, not the project's.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { readLog } from "../src/core/log/reader.ts";
import { EVENTS_FILE } from "../src/core/log/writer.ts";
import { listCallDirs } from "../src/main/call/recovery.ts";
import { der, normalizeText, parseRttm, type Turn, wordErrors } from "./eval/score.ts";

export interface LocalResult {
  calls: number;
  calls_with_fixes: number;
  lines: number;
  lines_fixed: number;
  ref_words_fixed_lines: number;
  ref_words_all_lines: number;
  word_errors: number;
  /** Percent; null when no line was fixed. */
  wer_fixed_lines: number | null;
  wer_lower_bound: number | null;
  term_occurrences: number;
  term_recall: number | null;
  der_calls: number;
  der_skipped_multipart: number;
  der: number | null;
}

/** The events with every hand fix taken out: what the recognizer and the app wrote. */
export function withoutFixes(events: readonly LogEvent[]): LogEvent[] {
  const firstSeg = events.find((e) => e.type === "seg")?.seq ?? Number.POSITIVE_INFINITY;
  const fixIds = new Set(
    events
      .filter((e) => e.type === "vocab.add" && e.rev === 1 && e.by !== "app" && e.seq > firstSeg)
      .map((e) => (e as Extract<LogEvent, { type: "vocab.add" }>).id),
  );
  return events.filter((e) => {
    if (e.type === "vocab.add") return !fixIds.has(e.id);
    if (e.type === "seg") return !(e.rev > 1 && e.by !== undefined);
    return true;
  });
}

/** How many times `term` occurs in `words`, as a run of normalized words. */
function count(words: readonly string[], term: readonly string[]): number {
  if (term.length === 0) return 0;
  let n = 0;
  for (let i = 0; i + term.length <= words.length; i++)
    if (term.every((w, k) => words[i + k] === w)) n++;
  return n;
}

export interface CallScore {
  lines: number;
  linesFixed: number;
  refWordsFixed: number;
  refWordsAll: number;
  errors: number;
  termOccurrences: number;
  termHits: number;
  parts: number;
  /** akou's speaker per line, part 1's audio seconds. */
  turns: Turn[];
}

/** One call's numbers. */
export function scoreCall(events: readonly LogEvent[]): CallScore {
  const ref = fold(events);
  const hyp = fold(withoutFixes(events));
  const terms = [
    ...new Set(
      events
        .filter((e): e is Extract<LogEvent, { type: "vocab.add" }> => e.type === "vocab.add")
        .map((e) => e.term)
        .filter((t): t is string => typeof t === "string"),
    ),
  ]
    .map(normalizeText)
    .filter((t) => t.length > 0);
  const s: CallScore = {
    lines: 0,
    linesFixed: 0,
    refWordsFixed: 0,
    refWordsAll: 0,
    errors: 0,
    termOccurrences: 0,
    termHits: 0,
    parts: ref.parts().length,
    turns: [],
  };
  for (const line of ref.lines("best")) {
    const r = normalizeText(line.text);
    const h = normalizeText(hyp.resolve(line.id)?.text ?? "");
    s.lines++;
    s.refWordsAll += r.length;
    s.turns.push({ start: line.a0, end: line.a1, speaker: line.spk });
    for (const t of terms) {
      const inRef = count(r, t);
      s.termOccurrences += inRef;
      s.termHits += Math.min(inRef, count(h, t));
    }
    if (r.join(" ") === h.join(" ")) continue;
    s.linesFixed++;
    s.refWordsFixed += r.length;
    s.errors += wordErrors(r, h);
  }
  return s;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((10000 * a) / b) / 100 : null);

/** Every call under `root`, scored; DER for the calls with an RTTM file in `rttmDir`. */
export async function evaluate(root: string, rttmDir?: string): Promise<LocalResult> {
  const out: LocalResult = {
    calls: 0,
    calls_with_fixes: 0,
    lines: 0,
    lines_fixed: 0,
    ref_words_fixed_lines: 0,
    ref_words_all_lines: 0,
    word_errors: 0,
    wer_fixed_lines: null,
    wer_lower_bound: null,
    term_occurrences: 0,
    term_recall: null,
    der_calls: 0,
    der_skipped_multipart: 0,
    der: null,
  };
  let termHits = 0;
  let derSpeech = 0;
  let derErrors = 0;
  for (const { dir } of listCallDirs(root)) {
    const { events } = await readLog(join(dir, EVENTS_FILE));
    const s = scoreCall(events);
    out.calls++;
    out.lines += s.lines;
    out.term_occurrences += s.termOccurrences;
    termHits += s.termHits;
    if (s.linesFixed > 0) {
      out.calls_with_fixes++;
      out.lines_fixed += s.linesFixed;
      out.ref_words_fixed_lines += s.refWordsFixed;
      out.ref_words_all_lines += s.refWordsAll;
      out.word_errors += s.errors;
    }
    const rttm = rttmDir ? join(rttmDir, `${basename(dir)}.rttm`) : null;
    if (rttm && existsSync(rttm)) {
      if (s.parts > 1) {
        out.der_skipped_multipart++;
        continue;
      }
      const d = der(parseRttm(readFileSync(rttm, "utf8")), s.turns);
      out.der_calls++;
      derSpeech += d.speech;
      derErrors += d.missed + d.falseAlarm + d.confusion;
    }
  }
  out.wer_fixed_lines = pct(out.word_errors, out.ref_words_fixed_lines);
  out.wer_lower_bound = pct(out.word_errors, out.ref_words_all_lines);
  out.term_recall = pct(termHits, out.term_occurrences);
  out.der = pct(derErrors, derSpeech);
  return out;
}

/**
 * The JSON to write, or an error when any value is not a number, a boolean or null: the one gate
 * between a call's text and the repository.
 */
export function numbersOnly(result: object): string {
  const walk = (v: unknown, at: string): void => {
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`${at} is not a finite number`);
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${at}.${k}`);
      return;
    }
    throw new Error(`${at} is a ${typeof v}: eval-local writes numbers only, never text`);
  };
  walk(result, "result");
  return `${JSON.stringify(result, null, 2)}\n`;
}

async function main(argv: string[]): Promise<number> {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = flag("--root") ?? join(homedir(), "Recordings", "akou");
  const day = new Date().toISOString().slice(0, 10);
  const out =
    flag("--out") ?? join(import.meta.dir, "..", "docs", "gates", `eval-local-${day}.json`);
  const result = await evaluate(root, flag("--rttm"));
  if (result.calls === 0) {
    console.error(`eval-local: no call under ${root}; pass --root`);
    return 66;
  }
  let text: string;
  try {
    text = numbersOnly(result);
  } catch (err) {
    console.error(`eval-local: refusing to write ${out}: ${(err as Error).message}`);
    return 65;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(text.trimEnd());
  console.error(`eval-local: wrote ${out}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
