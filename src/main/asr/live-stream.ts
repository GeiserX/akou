/**
 * One channel of the streaming live path (docs/research/asr-architecture.md section 3.1), as plain
 * code the pipeline drives and CI runs against a fake `LiveEngine`:
 *
 * 1. **Causal gain** in front of the engine: toward -3 dBFS peak, instant attack, 5 s release, at
 *    most +20 dB, never below unity. `prepareSpan`'s rule made continuous: a stream has no span to
 *    measure a peak over first.
 * 2. **One stream per channel for the whole call.** The engine's tokens are appended in place and
 *    never taken back, so a word on screen stays there.
 * 3. **Lines.** A line closes at a gap of `pause` seconds between two tokens, when `pause` plus the
 *    engine's chunk of new audio brings no token (the speaker stopped), or when a word would take
 *    it past `window` seconds. A line breaks only before a token that starts a word: one with a
 *    leading space, or one that starts with a Chinese, Japanese or Thai character, since those
 *    scripts put no spaces between words. Should no such token come, a line past `window` plus a
 *    second breaks before any token. The quiet is counted from the last token the engine returned,
 *    not from that token's time: an engine returns a word some way behind its audio, and counting
 *    from its time would close a line with the rest of a word still to come.
 *
 * Times: the stream has its own timeline, the samples pushed to it. Each run of contiguous audio
 * of one part sits somewhere on it (`runs`), which maps a line back to the part's file timeline. A
 * part change or skipped audio flushes the stream first, so no line spans two runs.
 */

import { ASR_RATE, type LiveStream, type LiveToken } from "./engine.ts";
import { MAX_GAIN, TARGET_PEAK } from "./pad.ts";

/** Gain release, seconds: how fast the gain climbs back after a loud passage. */
export const GAIN_RELEASE_SECONDS = 5;
/** A line starts this long before its first token (the token's time is where the model emitted it). */
export const LINE_LEAD_SECONDS = 0.3;
/** A line ends this long after its last token, at most. */
export const LINE_TAIL_SECONDS = 0.5;
/** Audio kept before an open line, or before now when none is open, beyond the engine's chunk. */
const KEEP_SECONDS = 2;
/**
 * A token that starts a word without a leading space: Chinese, Japanese and Thai write no spaces
 * between words, so their tokens rarely carry one. A combining mark continues the token before it.
 */
const SPACELESS_WORD =
  /^(?!\p{M})[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
/** Past the window by this much, a line breaks before any token, word start or not. */
const WINDOW_GRACE_SECONDS = 1;

/** A peak follower turned into a gain: a copy of each block, never the recording. */
export class CausalGain {
  private env = 0;
  private readonly decay: number;

  constructor(rate = ASR_RATE, releaseSeconds = GAIN_RELEASE_SECONDS) {
    this.decay = Math.exp(-1 / (releaseSeconds * rate));
  }

  apply(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length);
    let env = this.env;
    for (let i = 0; i < x.length; i++) {
      const v = x[i] as number;
      const a = Math.abs(v);
      env = a > env ? a : env * this.decay;
      const g = env === 0 ? MAX_GAIN : Math.max(1, Math.min(MAX_GAIN, TARGET_PEAK / env));
      out[i] = v * g;
    }
    this.env = env;
    return out;
  }
}

/** A closed line, in samples on the part's file timeline. */
export interface StreamLine {
  part: number;
  from: number;
  to: number;
  text: string;
}

/** Tokens joined into text: one space between words, none at the ends. */
export function tokenText(tokens: readonly LiveToken[]): string {
  return tokens
    .map((t) => t.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

interface Run {
  part: number;
  /** `[from, to)` on the part's file timeline. */
  from: number;
  to: number;
  /** Where `from` sits on the stream's timeline. */
  at: number;
}

interface OpenLine {
  tokens: LiveToken[];
  /** Seconds on the stream's timeline. */
  first: number;
  last: number;
}

export interface StreamChannelOptions {
  /** Seconds between tokens that close a line (`asr.segmentPause`). */
  pause: number;
  /** Longest line, seconds (`asr.segmentWindow`). */
  window: number;
  /** The engine's chunk, milliseconds. */
  tierMs: number;
}

/** One channel's stream, its gain, and the line being written. */
export class StreamChannel {
  private readonly gain = new CausalGain();
  private runs: Run[] = [];
  /** Samples pushed so far: the stream's own timeline. */
  private pos = 0;
  private line: OpenLine | null = null;
  /** `pos` when the engine last returned a token. */
  private heard = 0;
  /** Where the last closed line ended, seconds on the stream's timeline. */
  private lastEnd = 0;
  private closed = false;

  constructor(
    private readonly stream: LiveStream,
    private readonly o: StreamChannelOptions,
  ) {}

  /**
   * Audio of `part` at `filePos`. The caller flushes first when the audio does not continue the
   * last run (a new part, or audio skipped). Returns the lines this closed.
   */
  push(part: number, filePos: number, samples: Float32Array): StreamLine[] {
    if (this.closed || samples.length === 0) return [];
    const last = this.runs.at(-1);
    if (last && last.part === part && last.to === filePos) last.to += samples.length;
    else this.runs.push({ part, from: filePos, to: filePos + samples.length, at: this.pos });
    this.pos += samples.length;
    const tokens = this.stream.push(this.gain.apply(samples));
    if (tokens.length > 0) this.heard = this.pos;
    const out = this.take(tokens);
    const quiet = Math.round((this.o.pause + this.o.tierMs / 1000) * ASR_RATE);
    if (this.line && this.pos - this.heard >= quiet) out.push(...this.end(this.now()));
    this.runs = this.runs.filter((r, i, all) => i === all.length - 1 || this.keeps(r));
    return out;
  }

  /** Decodes everything pushed so far and closes the open line (a part end, a gap, the call's end). */
  flush(): StreamLine[] {
    if (this.closed) return [];
    const out = this.take(this.stream.flush());
    out.push(...this.end(this.now()));
    return out;
  }

  /** The open line as it stands, for the provisional view; null when none is open. */
  open(): { part: number; from: number; text: string } | null {
    const l = this.line;
    if (!l) return null;
    const span = this.toFile(this.startOf(l), l.first);
    return span ? { part: span.part, from: span.from, text: tokenText(l.tokens) } : null;
  }

  /** The earliest file position of `part` a later line can still start at: audio before it can go. */
  keepFrom(part: number): number | null {
    const r = this.runs.at(-1);
    if (!r || r.part !== part) return null;
    const back = this.o.tierMs / 1000 + this.o.pause + KEEP_SECONDS;
    const at = this.line ? this.startOf(this.line) : Math.max(this.lastEnd, this.now() - back);
    return r.from + Math.max(0, Math.round(at * ASR_RATE) - r.at);
  }

  close(): void {
    this.closed = true;
    this.stream.close();
  }

  private now(): number {
    return this.pos / ASR_RATE;
  }

  private keeps(r: Run): boolean {
    // A run can still hold the open line, or the lead of the next one.
    const back = this.o.tierMs / 1000 + this.o.pause + KEEP_SECONDS + this.o.window;
    return (r.at + (r.to - r.from)) / ASR_RATE >= this.now() - back;
  }

  private startOf(l: OpenLine): number {
    return Math.max(this.lastEnd, l.first - LINE_LEAD_SECONDS, 0);
  }

  /** New tokens: appended to the open line, closing it first at a gap or at the window. */
  private take(tokens: readonly LiveToken[]): StreamLine[] {
    const out: StreamLine[] = [];
    for (const tok of tokens) {
      const l = this.line;
      const word = !l || tok.text.startsWith(" ") || SPACELESS_WORD.test(tok.text);
      const overdue = l !== null && tok.t - l.first >= this.o.window + WINDOW_GRACE_SECONDS;
      if (
        l &&
        (word || overdue) &&
        (tok.t - l.last >= this.o.pause || tok.t - l.first >= this.o.window)
      ) {
        out.push(...this.end(tok.t));
      }
      if (!this.line) {
        if (tok.text.trim() === "") continue;
        this.line = { tokens: [], first: tok.t, last: tok.t };
      }
      const open = this.line as OpenLine;
      open.tokens.push(tok);
      open.last = Math.max(open.last, tok.t);
    }
    return out;
  }

  /** Closes the open line no later than `limit` (seconds on the stream's timeline). */
  private end(limit: number): StreamLine[] {
    const l = this.line;
    if (!l) return [];
    this.line = null;
    const from = this.startOf(l);
    const to = Math.max(from, Math.min(limit, l.last + LINE_TAIL_SECONDS, this.now()));
    this.lastEnd = to;
    const text = tokenText(l.tokens);
    const span = this.toFile(from, l.first, to);
    return text && span ? [{ ...span, text }] : [];
  }

  /**
   * `[from, to)` (seconds on the stream's timeline) on the file timeline of the run that holds
   * `anchor`, clamped to that run.
   */
  private toFile(
    from: number,
    anchor: number,
    to = from,
  ): { part: number; from: number; to: number } | null {
    const a = Math.round(anchor * ASR_RATE);
    let run: Run | undefined;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const r = this.runs[i] as Run;
      if (a >= r.at) {
        run = r;
        break;
      }
    }
    if (!run) return null;
    const len = run.to - run.from;
    const clamp = (x: number) => Math.min(len, Math.max(0, Math.round(x * ASR_RATE) - run.at));
    return { part: run.part, from: run.from + clamp(from), to: run.from + clamp(to) };
  }
}
