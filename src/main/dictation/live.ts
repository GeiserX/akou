/**
 * A dictation's words from a streaming model (docs/ux/DICTATION.md DC-E5, DC-E7): the same
 * Nemotron a call's live pass runs, fed the dictation's audio as it records, on the live Worker
 * (`LiveAsr.openDictation`), so the model is loaded once whoever uses it.
 *
 * - `LiveWords` is one dictation's stream: its audio in, the whole text so far out each time the
 *   engine gives new words (the pill's words, never re-decoded), and at the release its last words
 *   and the whole as a decode (`dictation.final` `live`: inserted with no second decode).
 * - `liveDecode` streams a whole buffer at once, for a dictation with no stream open at its press
 *   (a password field, a retry, a clip sent to the API).
 *
 * Words are cut from the engine's tokens as the live transcript cuts them: a token with a leading
 * space starts a word. A word starts at its first token's time and ends where the next word starts.
 */

import type { LiveToken } from "../asr/engine.ts";
import type { LiveChoice } from "../asr/live-engines.ts";
import { tokenText } from "../asr/live-stream.ts";
import type { DictationStream } from "../asr/live-worker.ts";
import { CAPTURE_RATE } from "../capture/protocol.ts";
import type { EngineDecoded, WordStream } from "./session.ts";

/** Opens a stream on the live Worker, its words to `onWords`. */
export type OpenStream = (onWords: (tokens: LiveToken[]) => void) => DictationStream;

/** The words of a stream's tokens, with their times: a leading space starts a word. */
export function tokenWords(tokens: readonly LiveToken[]): EngineDecoded["words"] {
  const words: { w: string; s: number; c: number }[] = [];
  for (const t of tokens) {
    const last = words.at(-1);
    if (last && !t.text.startsWith(" ")) {
      last.w += t.text;
      last.c = Math.min(last.c, t.conf);
    } else if (t.text.trim() !== "") words.push({ w: t.text.trim(), s: t.t, c: t.conf });
  }
  return words.map((w, i) => {
    const next = words[i + 1];
    return {
      w: w.w,
      s: round3(w.s),
      e: round3(next ? next.s : w.s),
      c: round3(w.c),
    };
  });
}

/** A stream's tokens as a dictation engine's answer. */
export function streamDecoded(
  tokens: readonly LiveToken[],
  choice: LiveChoice | null,
  ms: number,
): EngineDecoded {
  // The stream's language when it was told one; `auto` names none (Nemotron says nothing).
  const language = choice && choice.lang !== "auto" ? choice.lang : null;
  return {
    text: tokenText(tokens),
    words: tokenWords(tokens),
    language,
    model: choice?.engine ?? "nemotron",
    ms: Math.round(ms),
    spans: 1,
    engine: "live",
  };
}

/** One dictation's stream: `open` is asked at once, and its words come to `onText` whole. */
export class LiveWords implements WordStream {
  private readonly tokens: LiveToken[] = [];
  private readonly stream: DictationStream;
  private choice: LiveChoice | null = null;
  private failed = false;
  /** Engine time spent at the release, ms: the flush of its last audio. */
  private readonly now: () => number;

  constructor(
    open: OpenStream,
    private readonly onText: (text: string) => void,
    o: { now?: () => number; onLog?(msg: string): void } = {},
  ) {
    this.now = o.now ?? (() => performance.now());
    this.stream = open((tokens) => {
      this.tokens.push(...tokens);
      const text = tokenText(this.tokens);
      if (text !== "") this.onText(text);
    });
    this.stream.opened.then(
      (c) => {
        this.choice = c;
      },
      (err: Error) => {
        this.failed = true;
        o.onLog?.(`dictation: no live words (${err.message})`);
      },
    );
    // Lost after it opened (the Worker died mid-dictation): the preview decodes again from here.
    void this.stream.lost.then((err) => {
      if (this.failed) return;
      this.failed = true;
      o.onLog?.(`dictation: live words lost (${err.message})`);
    });
  }

  /** False once the stream could not open or died: the preview falls back to re-decoding. */
  ok(): boolean {
    return !this.failed;
  }

  push(samples: Float32Array): void {
    if (!this.failed) this.stream.push(samples);
  }

  async finish(): Promise<EngineDecoded> {
    const t = this.now();
    const choice = await this.stream.opened;
    await this.stream.finish();
    return streamDecoded(this.tokens, choice ?? this.choice, this.now() - t);
  }

  cancel(): void {
    this.stream.cancel();
  }
}

/** Seconds of audio pushed to a stream at once when a whole buffer is streamed. */
const CHUNK_SECONDS = 1;

/**
 * A whole buffer through a fresh stream: the words the live model gives it, as if spoken now. For
 * a dictation that had no stream at its press, and for retries and clips.
 */
export async function liveDecode(open: OpenStream, samples: Float32Array): Promise<EngineDecoded> {
  const tokens: LiveToken[] = [];
  const t = performance.now();
  const s = open((got) => tokens.push(...got));
  const choice = await s.opened;
  const step = CHUNK_SECONDS * CAPTURE_RATE;
  for (let at = 0; at < samples.length; at += step) s.push(samples.subarray(at, at + step));
  await s.finish();
  return streamDecoded(tokens, choice, performance.now() - t);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
