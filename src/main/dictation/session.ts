/**
 * The dictation session on the app's side (docs/ux/DICTATION.md sections 4 and 9): the state
 * machine over what the helper reports. The helper owns the keys and the audio; this owns what a
 * session becomes: the decode, the log, and the text sent back to insert.
 *
 * One session at a time: `ready` → `idle`; `session.started` → `listening` (the audio packets are
 * kept); `session.ended` → `transcribing` (the buffer goes to the engine) → `inserting` (the text
 * goes back as `insert`) → `idle` on `inserted` or `insert.failed`. A `cancel` (Escape, or
 * another key during a confirmed hold, DC-A1) or a `stop` keeps the dictation as `cancelled` with
 * no text. A press interrupted before it became a session never reaches the app at all.
 *
 * A session that will not be inserted (empty, failed, no model) is `settled` back to the helper at
 * once, so it stops holding Escape and Enter then rather than 8 s later (DC-A4).
 *
 * A password field gets nothing logged but that the dictation happened (DC-N8): no text, no words,
 * and the text goes to the helper for the clipboard only.
 *
 * Two guards stand before an insert (DC-E6): a buffer in which the VAD finds no speech is never
 * decoded, so no engine can invent a sentence from room noise; and an answer that is the engine's
 * context echoed back is decoded again with no context. After the vocabulary, filler words leave
 * the inserted text (DC-S7), and spoken marks that stand alone become punctuation when
 * `dictation.spokenPunctuation` is on (DC-S6); the log keeps what the engine heard.
 */

import { isEcho } from "../../core/dictation/echo.ts";
import type { DictationDraft, Target } from "../../core/dictation/events.ts";
import { removeFillers } from "../../core/dictation/fillers.ts";
import { type PunctuationLists, spokenPunctuation } from "../../core/dictation/punctuation.ts";
import type { Decoded } from "../asr/live-worker.ts";
import type { Packet } from "../capture/protocol.ts";
import { forcesLanguage } from "./engines.ts";
import type { AppToHelper, Bindings, EndReason, HelperToApp } from "./protocol.ts";
import { type DictationLog, newDictationId } from "./store.ts";

/**
 * What an engine answers: the decode, and when an engine fell back to another (the remote to the
 * local engine, DC-R3; `best` to `fast`, DC-E2), the engine that decoded it, the one it fell back
 * from, and the pill's line saying so.
 */
export type EngineDecoded = Decoded & {
  engine?: string;
  fallback_from?: string;
  notice?: string | null;
};

/**
 * How a decode is asked for: the forced language, and `context: false` for DC-E6's second decode,
 * which an engine that sends context (DC-L7's glossary) must send without it. No engine sends
 * context today, so every one ignores it.
 */
export interface DecodeRequest {
  language?: string;
  context?: boolean;
}

/** Decodes a dictation's buffer: the live Worker (`fast`), a remote akou (`remote`). */
export interface DictationEngine {
  /** What the log records as the engine: `fast`, `best`, `remote`. */
  readonly name: string;
  decode(samples: Float32Array, o: DecodeRequest): Promise<EngineDecoded>;
}

/** What turns a dictation's buffer into the text to insert, beside the engine (DC-E6, DC-S7). */
export interface TextRules {
  /**
   * The decoded text after the dictation vocabulary (DC-L6), in the language the engine found.
   * Absent, the text is inserted as decoded.
   */
  correct?(raw: string, language: string | null): Promise<string>;
  /**
   * Whether the VAD hears speech in the buffer; null when no VAD is loaded (a machine with no local
   * model, whose remote runs its own guard). False: nothing is decoded.
   */
  speech?(samples: Float32Array): Promise<boolean | null>;
  /** `dictation.fillers`: leave filler words out of the inserted text. */
  fillers?(): boolean;
  /** The languages a dictation may be in when the engine names none: the fillers' gate. */
  languages?(): readonly string[];
  /**
   * `dictation.spokenPunctuation`: the lists to replace spoken marks from (DC-S6), or null while
   * it is off. Throws when the user's file cannot be read; the text then goes in as it was.
   */
  punctuation?(): PunctuationLists | null;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
}

/** The helper's answer to a `rebind` (DC-A7): on a refusal the old binding stays. */
export type RebindAnswer = { ok: true } | { ok: false; reason: string };

export type SessionState = "starting" | "idle" | "listening" | "transcribing" | "inserting";

export interface SessionOptions extends TextRules {
  log: DictationLog;
  /** The engine now, or null when none is loaded (the models are missing). */
  engine(): DictationEngine | null;
  send(c: AppToHelper): void;
  bindings(): Bindings;
  now(): number;
  /** `dictation.language` when it is set, else undefined: the engine chooses (DC-E4). */
  language?(): string | undefined;
  onState?(state: SessionState): void;
  /** The helper's mic level during a session, 20 a second, for the pill and the stream (DC-G2). */
  onLevel?(rms: number): void;
  /** The engine's line for the pill about a dictation (`best failed, used fast`), never logged. */
  onNotice?(id: string, notice: string): void;
  /**
   * Keeps a dictation's audio for Retry and the learning check (DC-H2), called once its
   * `dictation.started` is written. Never called for a password field (DC-N8).
   */
  saveAudio?(id: string, samples: Float32Array): void;
}

interface Listening {
  helperId: string;
  target: Target;
  chunks: Float32Array[];
  samples: number;
  /** Secure Input was on at the start, or the field is a password field (DC-N8). */
  secure: boolean;
  /** Set by `session.ended`: the reason, and the timer that waits for the pipe to drain. */
  end: { reason: EndReason; timer: ReturnType<typeof setTimeout> } | null;
}

/**
 * How long a session that ended waits after its last packet before it is transcribed. The helper
 * writes every packet of a session to stdout before `session.ended` goes to stderr, but those are
 * two pipes with no order between them, so the end can be read before the last packets. They are
 * already in the pipe by then, so a short quiet window collects them.
 */
export const AUDIO_DRAIN_MS = 100;

/**
 * The same two pipes the other way round: a session's first packets can be read before its
 * `session.started` line. The helper sends audio only inside a session and numbers it from 0
 * (`fileSeconds`), so what arrives with no session open, from a packet at 0 on, is the next
 * session's start. A Windows runner lost the first half second of every hold before this.
 */
interface Early {
  chunks: Float32Array[];
  samples: number;
}

export class DictationSession {
  state: SessionState = "starting";
  ready: Extract<HelperToApp, { type: "ready" }> | null = null;
  private cur: Listening | null = null;
  /** Audio read before its `session.started` line (see `Early`). */
  private early: Early = { chunks: [], samples: 0 };
  /** macOS Secure Input, as the helper last reported it. */
  private secureInput = false;
  /** Dictations waiting for their insert's result, by the helper's session id. */
  private readonly inserts = new Map<string, string>();
  /** Dictations ended and not yet decoded: a decode runs one at a time, after the last. */
  private decoding = 0;
  /** Every decode and insert in flight, for tests and a clean stop. */
  private work: Promise<void> = Promise.resolve();
  /** The `rebind`s sent and not answered yet, in order: the helper answers each in turn. */
  private readonly rebinds: ((a: RebindAnswer) => void)[] = [];

  constructor(private readonly o: SessionOptions) {}

  private set(state: SessionState): void {
    if (state === this.state) return;
    this.state = state;
    this.o.onState?.(state);
  }

  /**
   * The state once a dictation's decode or insert settles: what is still in flight, else `idle`.
   * A newer session listening owns the state, and so does a helper starting again.
   */
  private settle(): void {
    if (this.cur || this.state === "starting") return;
    this.set(this.decoding > 0 ? "transcribing" : this.inserts.size > 0 ? "inserting" : "idle");
  }

  private write(d: DictationDraft): void {
    try {
      this.o.log.append(d);
    } catch (err) {
      this.o.onLog?.("error", `dictation log: ${(err as Error).message}`);
    }
  }

  /**
   * Sends the helper these bindings (the settings' by default) and resolves with its answer. Before
   * `ready` nothing is sent: the helper is bound from the settings once it is up.
   */
  rebind(b?: Bindings): Promise<RebindAnswer> {
    if (!this.ready) return Promise.resolve({ ok: true });
    this.o.send({ type: "rebind", ...(b ?? this.o.bindings()) });
    return new Promise((res) => this.rebinds.push(res));
  }

  /**
   * The tray's and the CLI's door (DC-G1): `session.start`, `session.stop` or `session.cancel`. The
   * helper answers with `session.started` and `session.ended` as for a key.
   */
  command(action: "start" | "stop" | "cancel"): void {
    this.o.send({ type: `session.${action}` });
  }

  /** Resolves once every decode and insert started so far has settled. */
  settled(): Promise<void> {
    return this.work;
  }

  onMessage(m: HelperToApp): void {
    switch (m.type) {
      case "ready":
        this.ready = m;
        this.set("idle");
        void this.rebind();
        return;
      case "rebound":
        this.rebinds.shift()?.({ ok: true });
        return;
      case "rebind.failed":
        this.o.onLog?.("warn", `dictation key ${m.hotkey} not bound: ${m.reason}`);
        this.rebinds.shift()?.({ ok: false, reason: m.reason });
        return;
      case "secure_input":
        this.secureInput = m.on;
        return;
      case "warn":
        this.o.onLog?.("warn", `dictation helper: ${m.code}: ${m.msg}`);
        return;
      case "level":
        this.o.onLevel?.(m.rms);
        return;
      case "session.started":
        // The last session is still draining its pipe: it ends now, with the audio it has, since
        // everything it sent was written before this line.
        if (this.cur?.end) this.ended(this.cur);
        this.cur = {
          helperId: m.id,
          target: m.target,
          chunks: this.early.chunks,
          samples: this.early.samples,
          secure: this.secureInput || m.target.field === "secure",
          end: null,
        };
        this.early = { chunks: [], samples: 0 };
        this.set("listening");
        return;
      case "session.ended": {
        const c = this.cur;
        if (!c || c.helperId !== m.id || c.end) return;
        c.end = { reason: m.reason, timer: setTimeout(() => this.ended(c), AUDIO_DRAIN_MS) };
        return;
      }
      case "inserted": {
        const id = this.inserts.get(m.id);
        if (!id) return;
        this.inserts.delete(m.id);
        this.write({
          type: "dictation.inserted",
          id,
          method: m.method,
          receipt_ms: m.receipt_ms,
        });
        this.settle();
        return;
      }
      case "insert.failed": {
        const id = this.inserts.get(m.id);
        if (!id) return;
        this.inserts.delete(m.id);
        this.write({ type: "dictation.failed", id, error: `insert: ${m.reason}` });
        this.settle();
        return;
      }
      default:
        // key, grant.lost, edit, edit.unreadable, mic, stopped: the pill's and learning's,
        // in later items.
        return;
    }
  }

  /** An `AKP1` packet from the helper's stdout: a session's audio, mic channel. */
  onPacket(p: Packet): void {
    if (p.ch !== "mic") return;
    let c = this.cur;
    // A packet at 0 while the last session drains, once that one has audio, is the next session's
    // first: the last one got every packet of its own before it.
    if (c?.end && c.samples > 0 && p.fileSeconds === 0) {
      this.ended(c);
      c = null;
    }
    if (!c) {
      // A session's first packet starts it again; a later one with none before it is the tail
      // of a session already transcribed.
      if (p.fileSeconds === 0) this.early = { chunks: [], samples: 0 };
      else if (this.early.chunks.length === 0) return;
      this.early.chunks.push(p.samples);
      this.early.samples += p.samples.length;
      return;
    }
    c.chunks.push(p.samples);
    c.samples += p.samples.length;
    // Audio read after the end: the pipe is still draining, so the quiet window starts again.
    if (c.end) c.end.timer.refresh();
  }

  /** The helper exited: a session in progress is lost with it, and says so. */
  helperGone(): void {
    const c = this.cur;
    this.cur = null;
    this.early = { chunks: [], samples: 0 };
    if (c?.end) clearTimeout(c.end.timer);
    if (c) {
      const id = newDictationId(this.o.now());
      this.write({ type: "dictation.started", id, target: c.target, engine: "auto", by: "user" });
      // What was heard before the helper died can still be retried.
      this.keep(id, c, concat(c.chunks, c.samples));
      this.write({ type: "dictation.failed", id, error: "the dictation helper stopped" });
    }
    for (const id of this.inserts.values()) {
      this.write({ type: "dictation.failed", id, error: "the dictation helper stopped" });
    }
    this.inserts.clear();
    // Nothing refused them: the next helper is bound from the settings when it is ready.
    for (const answer of this.rebinds.splice(0)) answer({ ok: true });
    this.ready = null;
    this.set("starting");
  }

  private ended(c: Listening): void {
    if (this.cur !== c || !c.end) return;
    this.cur = null;
    clearTimeout(c.end.timer);
    const reason = c.end.reason;
    const id = newDictationId(this.o.now());
    const engine = this.o.engine();
    const seconds = Math.round((c.samples / 16000) * 1000) / 1000;
    this.write({
      type: "dictation.started",
      id,
      target: c.target,
      engine: engine?.name ?? "fast",
      by: "user",
    });
    const samples = concat(c.chunks, c.samples);
    // A cancelled dictation keeps its audio too, so it can still be retried from history.
    this.keep(id, c, samples);
    this.write({ type: "dictation.ended", id, reason, seconds });
    if (reason === "cancel" || reason === "stop") {
      this.write({ type: "dictation.cancelled", id });
      this.settle();
      return;
    }
    this.decoding++;
    this.set("transcribing");
    this.work = this.work.then(() => this.transcribe(id, c, samples, engine));
  }

  /** Hands the audio to be kept, never a password field's (DC-N8); a failure costs only Retry. */
  private keep(id: string, c: Listening, samples: Float32Array): void {
    if (c.secure || !this.o.saveAudio) return;
    try {
      this.o.saveAudio(id, samples);
    } catch (err) {
      this.o.onLog?.("warn", `dictation audio not kept: ${(err as Error).message}`);
    }
  }

  /** The session will not be inserted: the helper stops holding Escape and Enter now. */
  private notInserted(helperId: string, d: DictationDraft): void {
    this.decoding--;
    this.write(d);
    this.o.send({ type: "settled", id: helperId });
    this.settle();
  }

  private async transcribe(
    id: string,
    c: Listening,
    samples: Float32Array,
    engine: DictationEngine | null,
  ): Promise<void> {
    if (!engine) {
      this.notInserted(c.helperId, {
        type: "dictation.failed",
        id,
        error: "no speech model is loaded",
      });
      return;
    }
    const language = this.o.language?.();
    let r: DictationResult;
    try {
      r = await decodeDictation(this.o, engine, samples, language, c.secure);
    } catch (err) {
      this.notInserted(c.helperId, { type: "dictation.failed", id, error: (err as Error).message });
      return;
    }
    if (r.kind === "text" && r.d.notice) this.o.onNotice?.(id, r.d.notice);
    // Never a password field's anything in the log (DC-N8): its text goes to the helper only.
    if (r.kind === "text" && !c.secure) this.write(textEvent(id, r, engine.name, language));
    if (r.kind === "empty" || r.text === "") {
      this.notInserted(c.helperId, { type: "dictation.empty", id });
      return;
    }
    const text = r.text;
    this.decoding--;
    this.inserts.set(c.helperId, id);
    this.settle();
    this.o.send({
      type: "insert",
      id: c.helperId,
      text,
      // Nothing is ever pasted or typed into a password field (DC-N8): the clipboard only.
      method: c.secure ? "clipboard" : "paste",
      send_key: "none",
      target: c.target,
    });
  }
}

/** What a dictation's buffer became: nothing heard, or the text to insert and what was decoded. */
export type DictationResult =
  | { kind: "empty" }
  | { kind: "text"; d: EngineDecoded; text: string; echoRetry: boolean };

/**
 * A dictation's buffer through the guards and the text rules (DC-E6, DC-L6, DC-S7, DC-S6): no
 * speech is no decode; an echoed context is decoded again without it; the text is the
 * vocabulary's, less its fillers, with its spoken marks replaced. A password field (`secure`) gets exactly what was heard. Throws when the engine fails.
 */
export async function decodeDictation(
  o: TextRules,
  engine: DictationEngine,
  samples: Float32Array,
  language: string | undefined,
  secure = false,
): Promise<DictationResult> {
  if ((await hearsSpeech(o, samples)) === false) return { kind: "empty" };
  const ask = language ? { language } : {};
  let d = await engine.decode(samples, ask);
  let echoRetry = false;
  // No engine sends a glossary yet (DC-L7), so only the wrapper text can give an echo away.
  if (isEcho(d.text)) {
    o.onLog?.("warn", `dictation: ${d.engine ?? engine.name} echoed its context, decoding again`);
    d = await engine.decode(samples, { ...ask, context: false });
    // Sent with no context, the second answer is what was said, even if it reads like the wrapper.
    echoRetry = true;
  }
  if (d.text === "") return { kind: "empty" };
  if (secure) return { kind: "text", d, text: d.text, echoRetry };
  let text = await correctOrRaw(o, d);
  const known = d.language ?? language;
  const langs = known ? [known] : (o.languages?.() ?? []);
  if (o.fillers?.()) text = removeFillers(text, langs);
  const lists = punctuationLists(o);
  if (lists) text = spokenPunctuation(text, d.words, langs, lists);
  return { kind: "text", d, text, echoRetry };
}

/** The spoken punctuation lists, or null when it is off or its file is broken (which is said). */
function punctuationLists(o: TextRules): PunctuationLists | null {
  try {
    return o.punctuation?.() ?? null;
  } catch (err) {
    o.onLog?.("warn", `dictation: spoken punctuation not applied: ${(err as Error).message}`);
    return null;
  }
}

/** The VAD's verdict, or null when it has none or fails: a guard that breaks never loses audio. */
async function hearsSpeech(o: TextRules, samples: Float32Array): Promise<boolean | null> {
  if (!o.speech) return null;
  try {
    return await o.speech(samples);
  } catch (err) {
    o.onLog?.(
      "warn",
      `dictation: the speech check failed, decoding anyway: ${(err as Error).message}`,
    );
    return null;
  }
}

/** The log's `dictation.text` for a decoded dictation. */
export function textEvent(
  id: string,
  r: Extract<DictationResult, { kind: "text" }>,
  engine: string,
  language: string | undefined,
): DictationDraft {
  const d = r.d;
  return {
    type: "dictation.text",
    id,
    raw: d.text,
    text: r.text,
    language: d.language,
    words: d.words,
    engine: d.engine ?? engine,
    model: d.model,
    ms: d.ms,
    ...(d.fallback_from ? { fallback_from: d.fallback_from } : {}),
    ...languageForced(language, d.engine ?? engine),
    ...(r.echoRetry ? { echo_retry: true } : {}),
  };
}

/**
 * The text to insert: the decoded text through the dictation vocabulary, or the decoded text as it
 * is when that fails, since a vocabulary file that cannot be read must not lose the dictation.
 */
export async function correctOrRaw(
  o: Pick<SessionOptions, "correct" | "onLog">,
  d: { text: string; language: string | null },
): Promise<string> {
  if (!o.correct) return d.text;
  try {
    return await o.correct(d.text, d.language);
  } catch (err) {
    o.onLog?.("warn", `dictation vocabulary not applied: ${(err as Error).message}`);
    return d.text;
  }
}

/**
 * `language_forced` for the log: with a language set, whether the engine that decoded took it;
 * with none, nothing (DC-E4).
 */
export function languageForced(
  language: string | undefined,
  engine: string,
): { language_forced?: boolean } {
  return language ? { language_forced: forcesLanguage(engine) } : {};
}

function concat(chunks: readonly Float32Array[], n: number): Float32Array {
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
