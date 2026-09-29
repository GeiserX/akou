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
 * The keys during a session (DC-A4, DC-S3): the helper swallows Escape, Enter and Shift+Enter from
 * the press until the insert settles and reports each as `key`, and this decides what they do to
 * the press. While listening, Enter asks for the text and then the send key (DC-S2) and Shift+Enter
 * for the draft box, taking the keyboard; the helper ends the session on either (`key`), and on
 * Escape (`cancel`). While the last dictation is still transcribing, Enter still means send after
 * the insert, Shift+Enter the draft box, and Escape keeps its text in history as `cancelled` and
 * inserts nothing. Once the text went to the helper it is too late for either. The dictation key
 * pressed while transcribing starts nothing (the helper refuses it) and flashes the pill.
 *
 * How the text goes in (DC-S2): `dictation.insert` picks paste, typing (DC-N7) or the clipboard
 * only. A text holding a line break is pasted even under `type`, since a typed line break is a
 * Return key press, which sends in a chat app and runs a line in a terminal. The send key goes
 * with the insert, and the helper presses it only after the target read the clipboard, never on
 * a timer. Nothing is sent after a clipboard-only insert, since nothing was pasted.
 *
 * Spacing and case (DC-S4): with `smartSpacing` in the insert policy the helper reads the field
 * just before the insert and fits the text to what sits around the cursor; with
 * `trailingSpace`, a text whose field was not read ends in a space. Never for a password field.
 *
 * Per-app rules (DC-U9): the rule for the app captured at the press (`dictation.apps`) picks the
 * session's engine, language and formatting pass, how its text goes in and its send key, and
 * with `mode` `draft` or `draft-send` sends the text to the draft box instead of the app, where
 * Enter inserts (and with `draft-send` presses the send key). A field the rule leaves out follows
 * the global setting.
 *
 * The focus guard (DC-N9): when the helper refuses an insert because the keyboard moved
 * (`focus-changed`) or the field cannot take it (`not-editable`, `field-unknown`), the text goes to
 * the draft box (`onDraft`) and the dictation is `drafted`, never lost. The draft box's own insert
 * (`insertText`) first asks the helper to bring the captured target forward, then inserts there.
 *
 * The read-back (DC-L2): with `readField` in the insert policy, a paste asks the helper to read the
 * field back (`read_field`), and its one answer is logged as `dictation.edit`: the runs of words the
 * user changed there (`onEdit`, for learning), or why the field could not be read.
 *
 * A password field gets nothing logged but that the dictation happened (DC-N8): no text, no words,
 * and the text goes to the helper for the clipboard only.
 *
 * Two guards stand before an insert (DC-E6): a buffer in which the VAD finds no speech is never
 * decoded, so no engine can invent a sentence from room noise; and an answer that is the engine's
 * context echoed back is decoded again with no context. After the vocabulary, filler words leave
 * the inserted text (DC-S7), and spoken marks that stand alone become punctuation when
 * `dictation.spokenPunctuation` is on (DC-S6); the log keeps what the engine heard. With
 * `dictation.spokenSend` on, a spoken dictation that ends in "send it" leaves those words out and
 * presses the send key as Enter would (DC-S5).
 *
 * A session ends by itself too (DC-A3): any session at `dictation.maxMinutes` of audio, after a
 * pill line one minute before, and a latched one (tapped on, not held) after
 * `dictation.silenceStopSeconds` in which the VAD heard no speech. The app asks the helper for
 * `session.stop`, and the dictation is logged as ended by `max` or `silence`; its audio is
 * transcribed like any other. A session is latched when the tray or the CLI started it, when
 * `dictation.activation` is `toggle`, or when the helper says so (`latched`).
 *
 * The words as you speak (DC-E5): while a session listens and someone wants them (`preview`), the
 * last `PREVIEW_TAIL_SECONDS` of its audio are decoded again every `PREVIEW_EVERY_SECONDS` on the
 * preview engine, one decode at a time, and each answer goes out as a partial (`onPartial`) while
 * the same session still listens. A partial is only ever shown: the inserted text is the decode of
 * the whole buffer at the release. A password field's session has no partials (DC-N8).
 *
 * The session's language (DC-E4, akou-5v8): the pill's language chip forces one for the session
 * listening (`setLanguage`), and so does `command("start", { language })` for the session it opens
 * (`akou dictate start --language`); its decode at the release asks for that one instead of
 * `dictation.language`. The last dictation decoded in a chosen language keeps it
 * (`chosenLanguage`), so the error's Retry decodes it in that language again.
 */

import { isEcho } from "../../core/dictation/echo.ts";
import type { DictationDraft, Target } from "../../core/dictation/events.ts";
import { removeFillers } from "../../core/dictation/fillers.ts";
import { type PunctuationLists, spokenPunctuation } from "../../core/dictation/punctuation.ts";
import { spokenSend } from "../../core/dictation/send.ts";
import type { CueMoment } from "../../ui/dictation-cues.ts";
import type { Decoded } from "../asr/live-worker.ts";
import { CAPTURE_RATE, type Packet } from "../capture/protocol.ts";
import type { AppRule } from "../config/schema.ts";
import { forcesLanguage } from "./engines.ts";
import type {
  AppToHelper,
  Bindings,
  EditHunk,
  EndReason,
  HelperToApp,
  InsertMethod,
  SendKey,
} from "./protocol.ts";
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
  /**
   * DC-R6: opens the dictation's request at the press, for an engine that takes the audio while
   * the key is held (the remote). Absent, the whole buffer is decoded at release.
   */
  open?(o: DecodeRequest): EngineHold;
}

/** A dictation's request opened at the press (DC-R6): packets as they arrive, then the release. */
export interface EngineHold {
  push(samples: Float32Array): void;
  /** At release, with the whole buffer: the decode, as `DictationEngine.decode` answers it. */
  decode(samples: Float32Array): Promise<EngineDecoded>;
  /** The dictation is not decoded (cancelled, no speech, the helper gone): drop the request. */
  cancel(): void;
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
  /**
   * `dictation.format: provider` (DC-U6): the text to insert through the user's provider, after
   * every other rule; the raw text and why when the pass was skipped; null while it is off.
   * `mode`, from a per-app rule (DC-U9), stands in for `dictation.format`.
   */
  format?(
    text: string,
    mode?: AppRule["format"],
  ): Promise<{ text: string; skipped: string | null } | null>;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
}

/** The helper's answer to a `rebind` (DC-A7): on a refusal the old binding stays. */
export type RebindAnswer = { ok: true } | { ok: false; reason: string };

export type SessionState = "starting" | "idle" | "listening" | "transcribing" | "inserting";

/**
 * How a spoken dictation's text goes in (DC-S2): `dictation.insert`, `dictation.sendKey`,
 * `dictation.sendAlways` and `dictation.restoreClipboard`.
 */
export interface InsertPolicy {
  method: InsertMethod;
  sendKey: SendKey;
  /** Press the send key after every direct insert, not only after Enter. */
  sendAlways: boolean;
  restore: boolean;
  /**
   * `dictation.readField` while `dictation.learn` is not `off` (DC-L2): the helper reads the field
   * back after a paste, and the fix the user makes there can be learned. Absent, nothing is read.
   */
  readField?: boolean;
  /**
   * `dictation.smartSpacing` while `dictation.readField` is on (DC-S4): the helper reads the field
   * before the insert and fits the text's spaces and first letter to it.
   */
  smartSpacing?: boolean;
  /** `dictation.trailingSpace` (DC-S4): a space after the text where the field was not read. */
  trailingSpace?: boolean;
}

/** With no settings: paste, restore the clipboard, and never a send key. */
export const DEFAULT_INSERT: InsertPolicy = {
  method: "paste",
  sendKey: "none",
  sendAlways: false,
  restore: true,
};

/**
 * What the keys during a session asked of a press (DC-A4, DC-S3): the text inserted, inserted and
 * then sent, opened in the draft box, or dropped.
 */
export type Asked = "insert" | "send" | "draft" | "cancel";

/** The key the helper reports during a session, and what it asks for. */
const KEY_ASKS: Readonly<Record<string, Asked>> = {
  Enter: "send",
  "Shift+Enter": "draft",
  Escape: "cancel",
};

export interface SessionOptions extends TextRules {
  log: DictationLog;
  /**
   * The engine now (`dictation.engine`, or the one a per-app rule names), or null when none is
   * loaded (the models are missing).
   */
  engine(name?: string): DictationEngine | null;
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
  /**
   * Opens the draft box on a dictation and answers whether it did: without the keyboard when the
   * helper refused its insert for the focus guard (DC-N9), taking it (`focus`) for Shift+Enter
   * (DC-A4). False: the dictation fails.
   */
  onDraft?(id: string, reason: string, focus: boolean, rule?: DraftRule): boolean;
  /** How the text goes in (DC-S2); `DEFAULT_INSERT` when absent. */
  insertPolicy?(): InsertPolicy;
  /** The per-app rule for `app` (DC-U9), from `dictation.apps`; none, the globals apply. */
  appRule?(app: string): AppRule | undefined;
  /** The dictation key was pressed while a dictation is still transcribing: refused (DC-A4). */
  onBusy?(): void;
  /**
   * `dictation.silenceStopSeconds` and `dictation.maxMinutes` as they are now (DC-A3); absent, a
   * session ends only when the helper ends it.
   */
  autoStop?(): AutoStop;
  /** A line for the pill while listening (`1 minute left`), never logged (DC-A3). */
  onWarning?(note: string): void;
  /** `dictation.spokenSend`: a dictation ending in "send it" presses the send key (DC-S5). */
  spokenSend?(): boolean;
  /**
   * The field read back after dictation `id` was pasted (DC-L2): the runs of words the user
   * changed there, possibly none, or null when the field could not be read. Called once
   * `dictation.edit` is written.
   */
  onEdit?(id: string, hunks: EditHunk[] | null): void;
  /**
   * The decoder for the words as you speak (DC-E5), or null when nobody wants them now or no
   * engine can give them. Asked before each partial, so a setting changed mid-session applies.
   */
  preview?(): PreviewDecode | null;
  /** A partial of the session listening: shown, never inserted (DC-E5). */
  onPartial?(p: PreviewPartial): void;
  /**
   * A moment of a spoken dictation for its cue (DC-O3): `start` when its audio starts, `stop` once
   * the post-roll ended and it goes to the engine, `cancel` when it is dropped, `done` when its text
   * went in.
   */
  onCue?(moment: CueMoment): void;
  /** A key the helper reported while the Dictation page's recorder is open (DC-U3). */
  onRecordedKey?(name: string): void;
  /**
   * A grant `ready` reported is gone (DC-N1): on macOS a revoked Accessibility grant kills the key
   * tap without a word, so the dictation key does nothing until the grant is back.
   */
  onGrantLost?(name: string): void;
  /**
   * macOS Secure Input turned on or off (DC-N1, DC-A2): while it is on the OS hands no keyed chord
   * to the tap, and only a modifier alone still reaches it.
   */
  onSecureInput?(on: boolean): void;
  /**
   * `dictation.mic` (`default` when empty) and `dictation.preferBuiltInOverBluetooth`, sent as
   * `rebuild_mic` after `ready` (DC-U4, DC-N5); absent, the helper keeps its default.
   */
  mic?(): { device: string; preferBuiltIn: boolean };
  /**
   * Whether the Dictation page's meter is on (DC-U4, DC-N3): sent as `meter` after `ready`, so a
   * helper started again while the page shows its meter keeps it moving.
   */
  metering?(): boolean;
}

/** A decode of the end of the audio so far, for the preview only. */
export type PreviewDecode = (samples: Float32Array) => Promise<Pick<Decoded, "text" | "language">>;

/** The words heard so far in the session listening, and the language the engine heard them in. */
export interface PreviewPartial {
  text: string;
  language: string | null;
}

/**
 * What a per-app rule (DC-U9) asks of the draft box it opens: Enter presses the send key too
 * (`draft-send`), and the rule's send key in place of `dictation.sendKey`.
 */
export interface DraftRule {
  enterSends: boolean;
  sendKey?: SendKey;
}

/** How often a listening session's audio is decoded again for the preview (DC-E5). */
export const PREVIEW_EVERY_SECONDS = 0.5;
/**
 * How much of the end of the audio each preview decode takes. The pill's ticker shows one line, the
 * newest words, so the start of a long dictation is never decoded again and a decode stays short:
 * it shares the live Worker with the release's whole-buffer decode and a recorded call's segments,
 * which wait behind the one in flight.
 */
export const PREVIEW_TAIL_SECONDS = 8;

/** When a session ends by itself (DC-A3). */
export interface AutoStop {
  /** A latched session ends after this many seconds without speech; 0 never. */
  silenceSeconds: number;
  /** Any session ends at this length. */
  maxMinutes: number;
}

/** The pill's line one minute before `dictation.maxMinutes` (DC-A3). */
export const MAX_WARNING = "1 minute left";

/** The VAD judges a latched session's audio in windows of this many samples: one second. */
export const SILENCE_WINDOW = CAPTURE_RATE;

/**
 * How long after the tray's or the CLI's `session.start` a `session.started` is taken as its
 * answer, so latched: `CONTROL_MS` of the service. A start the helper dropped then marks nothing.
 */
const DOOR_MS = 3000;

/** The helper's refusals that send the text to the draft box rather than failing it (DC-N9). */
export const DRAFT_REASONS: ReadonlySet<string> = new Set([
  "focus-changed",
  "not-editable",
  "field-unknown",
]);

/** How an insert the app asked for outside a session ended (the draft box's, DC-S1). */
export type InsertOutcome = { ok: true; method: string } | { ok: false; reason: string };

/** An insert the app asked for outside a session: the dictation it logs to, if any. */
interface Explicit {
  /** The dictation whose `dictation.inserted` it writes; none for a copy. */
  id: string | null;
  resolve(o: InsertOutcome): void;
}

interface Listening {
  helperId: string;
  target: Target;
  chunks: Float32Array[];
  samples: number;
  /** Secure Input was on at the start, or the field is a password field (DC-N8). */
  secure: boolean;
  /**
   * The engine picked at the press, its request opened then (DC-R6), and the language that request
   * asked for; null for the others.
   */
  hold: { engine: DictationEngine; request: EngineHold; language: string | undefined } | null;
  /** Set by `session.ended`: the reason, and the timer that waits for the pipe to drain. */
  end: { reason: EndReason; timer: ReturnType<typeof setTimeout> } | null;
  /** What the keys during the session, or while it transcribes, asked for (DC-A4). */
  asked: Asked;
  /** Tapped on rather than held: only such a session ends after silence (DC-A3). */
  latched: boolean;
  /** Why the app asked the helper to stop it (DC-A3): its `tap` is logged as this. */
  stopping: "silence" | "max" | null;
  /** The pill was told one minute is left. */
  /** The second of audio at which the pill was warned of the maximum length, or null. */
  warned: number | null;
  /** The audio not judged by the VAD yet, less than a window of it. */
  window: Float32Array;
  filled: number;
  /** Samples judged so far, and where the last window with speech ended. */
  judged: number;
  heard: number;
  /** The VAD's verdicts run one at a time, in order. */
  vad: Promise<void>;
  /** The samples the last preview decode took, and whether one is running (DC-E5). */
  previewAt: number;
  previewing: boolean;
  /** The language the pill's chip forced for this session, else null (akou-5v8). */
  language: string | null;
  /** The per-app rule for the app captured at the press (DC-U9), or null. */
  rule: AppRule | null;
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
  /** The grants the helper said were taken back since its `ready` (DC-N1). */
  readonly lost = new Set<string>();
  /** Dictations waiting for their insert's result, by the helper's session id. */
  private readonly inserts = new Map<string, string>();
  /** Dictations whose field the helper reads back after the insert (DC-L2), by its session id. */
  private readonly reads = new Map<string, string>();
  /** The draft box's inserts and copies waiting for the helper's answer, by the id sent. */
  private readonly explicit = new Map<string, Explicit>();
  private explicitSeq = 0;
  /** Dictations ended and not yet decoded: a decode runs one at a time, after the last. */
  private decoding = 0;
  /**
   * The last session ended whose text has not gone to the helper yet: the one the helper's keys
   * still belong to while it waits for the insert (DC-A4).
   */
  private latest: Listening | null = null;
  /** Every decode and insert in flight, for tests and a clean stop. */
  private work: Promise<void> = Promise.resolve();
  /** The `rebind`s sent and not answered yet, in order: the helper answers each in turn. */
  private readonly rebinds: ((a: RebindAnswer) => void)[] = [];
  /** When the tray or the CLI last asked for `session.start`: its session is latched (DC-A3). */
  private doorAt = Number.NEGATIVE_INFINITY;
  /** The language the door's `session.start` asked for, for the session it opens. */
  private doorLanguage: string | null = null;
  /** The last dictation decoded in a language the user chose for its session, and that language. */
  private chosen: { id: string; language: string } | null = null;
  /** The recorder is open: the helper reports every key and starts no session (DC-U3). */
  private recording = false;

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
   * Opens or closes the Dictation page's key recorder (DC-U3): while it is open the helper reports
   * every key it sees, Fn included, and starts no session. False before `ready`.
   */
  recordKeys(on: boolean): boolean {
    if (!this.ready) return false;
    this.recording = on;
    this.o.send({ type: "record_keys", on });
    return true;
  }

  /**
   * Turns the Dictation page's meter on or off (DC-U4, DC-N3): while it is on the helper keeps
   * the mic open and sends `level` with no session. False before `ready`.
   */
  meter(on: boolean): boolean {
    if (!this.ready) return false;
    this.o.send({ type: "meter", on });
    return true;
  }

  /** Sends the helper the microphone the settings pick (DC-U4, DC-N5); nothing before `ready`. */
  rebuildMic(): void {
    const m = this.o.mic?.();
    if (!this.ready || !m) return;
    this.o.send({
      type: "rebuild_mic",
      device: m.device === "" ? "default" : m.device,
      prefer_built_in: m.preferBuiltIn,
    });
  }

  /**
   * The tray's and the CLI's door (DC-G1): `session.start`, `session.stop` or `session.cancel`. The
   * helper answers with `session.started` and `session.ended` as for a key.
   */
  command(action: "start" | "stop" | "cancel", o: { language?: string } = {}): void {
    if (action === "start") {
      this.doorAt = this.o.now();
      this.doorLanguage = o.language ?? null;
    }
    this.o.send({ type: `session.${action}` });
  }

  /** The language chosen for the session listening (the pill's chip, the door), else null. */
  listeningLanguage(): string | null {
    const c = this.cur;
    return c && !c.end ? c.language : null;
  }

  /** The language dictation `id` was decoded in when the user chose it for its session, else null. */
  chosenLanguage(id: string): string | null {
    return this.chosen?.id === id ? this.chosen.language : null;
  }

  /**
   * Inserts `text` where dictation `id` was going (the draft box's Enter, DC-S1): the helper first
   * brings `target` forward (DC-N9), then pastes there and presses `sendKey` after the receipt.
   * Writes `dictation.inserted` when it lands; a refusal writes nothing and is answered, so the
   * caller can open the box again with the user's text.
   */
  insertText(id: string, text: string, target: Target, sendKey: SendKey): Promise<InsertOutcome> {
    if (!this.ready)
      return Promise.resolve({ ok: false, reason: "the dictation helper is not up" });
    const hid = `draft-${++this.explicitSeq}`;
    const done = new Promise<InsertOutcome>((resolve) => this.explicit.set(hid, { id, resolve }));
    this.o.send({ type: "focus", target });
    this.o.send({
      type: "insert",
      id: hid,
      text,
      method: "paste",
      send_key: sendKey,
      target,
      ...spacing(this.o.insertPolicy?.() ?? DEFAULT_INSERT),
    });
    return done;
  }

  /**
   * Puts `text` on the clipboard for the user to paste (the draft box's Copy), through the helper's
   * clipboard-only insert, which pastes nothing and restores nothing. Nothing is logged.
   */
  copyText(text: string, target: Target): Promise<InsertOutcome> {
    if (!this.ready)
      return Promise.resolve({ ok: false, reason: "the dictation helper is not up" });
    const hid = `copy-${++this.explicitSeq}`;
    const done = new Promise<InsertOutcome>((resolve) =>
      this.explicit.set(hid, { id: null, resolve }),
    );
    this.o.send({ type: "insert", id: hid, text, method: "clipboard", send_key: "none", target });
    return done;
  }

  /** Resolves once every decode and insert started so far has settled. */
  settled(): Promise<void> {
    return this.work;
  }

  onMessage(m: HelperToApp): void {
    switch (m.type) {
      case "ready":
        this.ready = m;
        this.lost.clear();
        this.recording = false;
        this.set("idle");
        void this.rebind();
        this.rebuildMic();
        if (this.o.metering?.()) this.meter(true);
        return;
      case "rebound":
        this.rebinds.shift()?.({ ok: true });
        return;
      case "rebind.failed":
        this.o.onLog?.("warn", `dictation key ${m.hotkey} not bound: ${m.reason}`);
        this.rebinds.shift()?.({ ok: false, reason: m.reason });
        return;
      case "secure_input":
        if (m.on === this.secureInput) return;
        this.secureInput = m.on;
        this.o.onSecureInput?.(m.on);
        return;
      case "grant.lost": {
        const r = this.ready;
        if (this.lost.has(m.name)) return;
        this.lost.add(m.name);
        // `ready` said granted: from now on the grant reads as the OS holds it, so a probe that
        // finds it given again starts the helper again (the tap is made at the start).
        if (r && (m.name === "mic" || m.name === "accessibility"))
          this.ready = { ...r, grants: { ...r.grants, [m.name]: "denied" } };
        this.o.onLog?.("warn", `dictation: the ${m.name} grant was taken back`);
        this.o.onGrantLost?.(m.name);
        return;
      }
      case "warn":
        this.o.onLog?.("warn", `dictation helper: ${m.code}: ${m.msg}`);
        return;
      case "level":
        this.o.onLevel?.(m.rms);
        return;
      case "key":
        if (this.recording) this.o.onRecordedKey?.(m.name);
        else this.key(m.name);
        return;
      case "session.started": {
        // The last session is still draining its pipe: it ends now, with the audio it has, since
        // everything it sent was written before this line.
        if (this.cur?.end) this.ended(this.cur);
        // A start with no end before it (a helper that restarted or misbehaved): the old session
        // is dropped, and so is the request it opened, rather than left open on the remote.
        else this.cur?.hold?.request.cancel();
        const door = this.o.now() - this.doorAt <= DOOR_MS;
        this.doorAt = Number.NEGATIVE_INFINITY;
        const chosen = door ? this.doorLanguage : null;
        this.doorLanguage = null;
        const rule = (m.target.app !== "" && this.o.appRule?.(m.target.app)) || null;
        const c: Listening = {
          helperId: m.id,
          target: m.target,
          chunks: [],
          samples: 0,
          secure: this.secureInput || m.target.field === "secure",
          hold: this.open(rule, chosen),
          end: null,
          asked: "insert",
          latched: door || this.o.bindings().activation === "toggle",
          stopping: null,
          warned: null,
          window: new Float32Array(SILENCE_WINDOW),
          filled: 0,
          judged: 0,
          heard: 0,
          vad: Promise.resolve(),
          previewAt: 0,
          previewing: false,
          language: chosen,
          rule,
        };
        this.cur = c;
        const early = this.early.chunks;
        this.early = { chunks: [], samples: 0 };
        this.set("listening");
        this.o.onCue?.("start");
        for (const chunk of early) this.take(c, chunk);
        return;
      }
      case "latched":
        if (this.cur?.helperId === m.id) this.cur.latched = true;
        return;
      case "session.ended": {
        const c = this.cur;
        if (!c || c.helperId !== m.id || c.end) return;
        // The helper ends the app's `session.stop` as a tap: the log says why the app asked.
        const reason = c.stopping && m.reason === "tap" ? c.stopping : m.reason;
        c.end = { reason, timer: setTimeout(() => this.ended(c), AUDIO_DRAIN_MS) };
        return;
      }
      case "inserted": {
        const x = this.explicit.get(m.id);
        if (x) {
          this.explicit.delete(m.id);
          if (x.id !== null)
            this.write({
              type: "dictation.inserted",
              id: x.id,
              method: m.method,
              receipt_ms: m.receipt_ms,
            });
          x.resolve({ ok: true, method: m.method });
          return;
        }
        const id = this.inserts.get(m.id);
        if (!id) return;
        this.inserts.delete(m.id);
        // Nothing was pasted after a clipboard-only insert, so nothing is read back.
        if (m.method === "clipboard") this.reads.delete(m.id);
        this.write({
          type: "dictation.inserted",
          id,
          method: m.method,
          receipt_ms: m.receipt_ms,
        });
        this.o.onCue?.("done");
        this.settle();
        return;
      }
      case "edit":
      case "edit.unreadable": {
        const id = this.reads.get(m.id);
        if (!id) return;
        this.reads.delete(m.id);
        // Only the runs the user changed, never the field's other text (DC-L2).
        const hunks =
          m.type === "edit" ? m.hunks.map((h) => ({ inserted: h.inserted, now: h.now })) : [];
        this.write(
          m.type === "edit"
            ? { type: "dictation.edit", id, hunks }
            : { type: "dictation.edit", id, hunks, reason: m.reason },
        );
        this.o.onEdit?.(id, m.type === "edit" ? m.hunks : null);
        return;
      }
      case "insert.failed": {
        const x = this.explicit.get(m.id);
        if (x) {
          this.explicit.delete(m.id);
          x.resolve({ ok: false, reason: m.reason });
          return;
        }
        const id = this.inserts.get(m.id);
        if (!id) return;
        this.inserts.delete(m.id);
        this.reads.delete(m.id);
        // The keyboard moved or the field cannot take it: the text waits in the draft box.
        if (DRAFT_REASONS.has(m.reason) && this.o.onDraft?.(id, m.reason, false)) {
          this.write({ type: "dictation.drafted", id, reason: m.reason });
        } else {
          this.write({ type: "dictation.failed", id, error: `insert: ${m.reason}` });
        }
        this.settle();
        return;
      }
      default:
        // mic, stopped: nothing for the app to do.
        return;
    }
  }

  /**
   * A key the helper swallowed and reported (DC-A4): Escape, Enter or Shift+Enter for the session
   * listening or the last one still transcribing; any other name is the dictation key, pressed
   * while a dictation transcribes, which the helper refused.
   */
  private key(name: string): void {
    const asked = KEY_ASKS[name];
    if (asked === undefined) {
      if (!this.cur && (this.state === "transcribing" || this.state === "inserting"))
        this.o.onBusy?.();
      return;
    }
    const c = this.cur ?? this.latest;
    if (!c) {
      // The text is on its way into the app already: too late to send it or hold it back.
      this.o.onLog?.("info", `dictation: ${name} came after the insert began, so it did nothing`);
      return;
    }
    c.asked = asked;
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
    this.take(c, p.samples);
    // Audio read after the end: the pipe is still draining, so the quiet window starts again.
    if (c.end) c.end.timer.refresh();
  }

  /**
   * Forces `language` for the session listening, from the pill's chip (akou-5v8): its decode at the
   * release asks for it. False with no session listening.
   */
  setLanguage(language: string): boolean {
    const c = this.cur;
    if (!c || c.end) return false;
    c.language = language;
    return true;
  }

  /** A session's audio: kept, sent on to a request opened at the press, and watched (DC-A3). */
  private take(c: Listening, samples: Float32Array): void {
    c.chunks.push(samples);
    c.samples += samples.length;
    c.hold?.request.push(samples);
    if (c.end || c.stopping) return;
    this.previewTick(c);
    const a = this.o.autoStop?.();
    if (!a) return;
    const limit = a.maxMinutes * 60 * CAPTURE_RATE;
    if (c.warned === null && c.samples >= limit - 60 * CAPTURE_RATE) {
      c.warned = Math.round((c.samples / CAPTURE_RATE) * 1000) / 1000;
      this.o.onWarning?.(MAX_WARNING);
    }
    if (c.samples >= limit) {
      this.stopBy(c, "max");
      return;
    }
    if (!c.latched || a.silenceSeconds <= 0 || !this.o.speech) return;
    // The VAD hears the audio a window at a time; the last window with speech in it sets the time.
    let at = 0;
    while (at < samples.length) {
      const n = Math.min(SILENCE_WINDOW - c.filled, samples.length - at);
      c.window.set(samples.subarray(at, at + n), c.filled);
      c.filled += n;
      at += n;
      if (c.filled < SILENCE_WINDOW) break;
      const window = c.window.slice();
      c.filled = 0;
      c.judged += SILENCE_WINDOW;
      const end = c.judged;
      c.vad = c.vad.then(() => this.judge(c, window, end, a.silenceSeconds));
    }
  }

  /**
   * The next partial of the session listening (DC-E5), once `PREVIEW_EVERY_SECONDS` more audio came
   * in and the last decode answered. An answer that comes after the session stopped listening is
   * dropped, so a partial never outlives it; a failed one costs only that partial.
   */
  private previewTick(c: Listening): void {
    if (c.secure || c.previewing) return;
    if (c.samples - c.previewAt < PREVIEW_EVERY_SECONDS * CAPTURE_RATE) return;
    const decode = this.o.preview?.();
    if (!decode) return;
    c.previewAt = c.samples;
    c.previewing = true;
    const tail = lastSamples(c.chunks, c.samples, PREVIEW_TAIL_SECONDS * CAPTURE_RATE);
    void decode(tail)
      .then((d) => {
        if (this.cur !== c || c.end || c.stopping) return;
        const text = d.text.trim();
        if (text !== "") this.o.onPartial?.({ text, language: d.language });
      })
      .catch((err) => this.o.onLog?.("info", `dictation preview: ${(err as Error).message}`))
      .finally(() => {
        c.previewing = false;
      });
  }

  /**
   * The VAD's verdict on one window of a latched session: speech moves the last time heard, and
   * `silenceSeconds` with none since stops the session. A VAD that has no verdict or fails counts
   * as speech: a guard that cannot hear never ends a session.
   */
  private async judge(
    c: Listening,
    window: Float32Array,
    end: number,
    silenceSeconds: number,
  ): Promise<void> {
    if (this.cur !== c || c.end || c.stopping) return;
    let speech: boolean | null = null;
    try {
      speech = (await this.o.speech?.(window)) ?? null;
    } catch {
      speech = null;
    }
    if (speech !== false) c.heard = end;
    if (this.cur !== c || c.end || c.stopping) return;
    if (end - c.heard >= silenceSeconds * CAPTURE_RATE) this.stopBy(c, "silence");
  }

  /** Asks the helper to end the session (DC-A3); its audio is transcribed as for a tap. */
  private stopBy(c: Listening, why: "silence" | "max"): void {
    c.stopping = why;
    this.o.onLog?.("info", `dictation: stopped by ${why === "max" ? "the maximum length" : why}`);
    this.o.send({ type: "session.stop" });
  }

  /** The helper exited: a session in progress is lost with it, and says so. */
  helperGone(): void {
    const c = this.cur;
    this.cur = null;
    this.latest = null;
    this.early = { chunks: [], samples: 0 };
    if (c?.end) clearTimeout(c.end.timer);
    c?.hold?.request.cancel();
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
    this.reads.clear();
    for (const x of this.explicit.values())
      x.resolve({ ok: false, reason: "the dictation helper stopped" });
    this.explicit.clear();
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
    // A request opened at the press is decoded by the engine that opened it.
    const engine = c.hold?.engine ?? this.o.engine(c.rule?.engine);
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
    this.write({
      type: "dictation.ended",
      id,
      reason,
      seconds,
      ...(c.warned !== null ? { warned: c.warned } : {}),
    });
    if (reason === "cancel" || reason === "stop") {
      c.hold?.request.cancel();
      this.write({ type: "dictation.cancelled", id });
      // The app stopping the helper (dictation turned off) is not the user's cancel.
      if (reason === "cancel") this.o.onCue?.("cancel");
      this.settle();
      return;
    }
    this.o.onCue?.("stop");
    this.decoding++;
    this.latest = c;
    this.set("transcribing");
    this.work = this.work.then(() => this.transcribe(id, c, samples, engine));
  }

  /**
   * DC-R6: the request of an engine that takes the audio during the hold, opened at the press with
   * the engine the settings pick now; null for any other engine, or when opening it fails, and the
   * buffer then goes at release.
   */
  private open(rule: AppRule | null, chosen: string | null): Listening["hold"] {
    const engine = this.o.engine(rule?.engine);
    if (!engine?.open) return null;
    const language = chosen ?? this.language(rule);
    try {
      return { engine, request: engine.open(language ? { language } : {}), language };
    } catch (err) {
      this.o.onLog?.(
        "warn",
        `dictation: ${engine.name} not opened at the press: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The language a session asks for before the chip moves it: the per-app rule's (`auto` lets the
   * engine choose), else `dictation.language` (DC-E4, DC-U9).
   */
  private language(rule: AppRule | null): string | undefined {
    const l = rule?.language;
    if (l === undefined) return this.o.language?.();
    return l === "auto" ? undefined : l;
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
  private notInserted(c: Listening, d: DictationDraft): void {
    this.decoding--;
    if (this.latest === c) this.latest = null;
    this.write(d);
    this.o.send({ type: "settled", id: c.helperId });
    this.settle();
  }

  private async transcribe(
    id: string,
    c: Listening,
    samples: Float32Array,
    engine: DictationEngine | null,
  ): Promise<void> {
    if (!engine) {
      this.notInserted(c, {
        type: "dictation.failed",
        id,
        error: "no speech model is loaded",
      });
      return;
    }
    const language = c.language ?? this.language(c.rule);
    if (c.language !== null) this.chosen = { id, language: c.language };
    // A request opened at the press asked for the language of then: a different language chosen
    // since on the chip drops it, and the buffer goes whole with the new one.
    let hold = c.hold?.request;
    if (hold && c.language !== null && c.language !== c.hold?.language) {
      hold.cancel();
      hold = undefined;
    }
    let r: DictationResult;
    try {
      r = await decodeDictation(this.o, engine, samples, language, c.secure, hold, {
        spokenSend: this.o.spokenSend?.() ?? false,
        ...(c.rule?.format ? { format: c.rule.format } : {}),
      });
    } catch (err) {
      this.notInserted(c, { type: "dictation.failed", id, error: (err as Error).message });
      return;
    }
    // "send it" at the very end (DC-S5): the words went, and the send key goes with the insert.
    const spoken = r.kind === "text" && r.send;
    if (r.kind === "text" && r.d.notice) this.o.onNotice?.(id, r.d.notice);
    // Never a password field's anything in the log (DC-N8): its text goes to the helper only.
    if (r.kind === "text" && !c.secure) this.write(textEvent(id, r, engine.name, language));
    if (r.kind === "empty" || r.text === "") {
      this.notInserted(c, { type: "dictation.empty", id });
      return;
    }
    // Escape while it transcribed: the text stays in history, and nothing goes in (DC-A4).
    if (c.asked === "cancel") {
      this.notInserted(c, { type: "dictation.cancelled", id });
      this.o.onCue?.("cancel");
      return;
    }
    // Shift+Enter: the draft box, taking the keyboard. Never a password field's text in it.
    if (c.asked === "draft" && !c.secure) {
      const opened = this.o.onDraft?.(id, "key", true) ?? false;
      this.notInserted(
        c,
        opened
          ? { type: "dictation.drafted", id, reason: "key" }
          : { type: "dictation.failed", id, error: "the draft box needs the desktop window" },
      );
      return;
    }
    const p = this.o.insertPolicy?.() ?? DEFAULT_INSERT;
    const rule = c.rule;
    const sendKey = (rule?.sendKey as SendKey | undefined) ?? p.sendKey;
    // A per-app rule's draft box (DC-U9), taking the keyboard as Shift+Enter's does. A key the
    // user pressed during the session (Enter, Escape) still wins over the rule.
    if (
      c.asked === "insert" &&
      !c.secure &&
      (rule?.mode === "draft" || rule?.mode === "draft-send")
    ) {
      const opened =
        this.o.onDraft?.(id, "rule", true, {
          enterSends: rule.mode === "draft-send",
          ...(rule.sendKey ? { sendKey: rule.sendKey as SendKey } : {}),
        }) ?? false;
      this.notInserted(
        c,
        opened
          ? { type: "dictation.drafted", id, reason: "rule" }
          : { type: "dictation.failed", id, error: "the draft box needs the desktop window" },
      );
      return;
    }
    // Nothing is ever pasted or typed into a password field (DC-N8): the clipboard only. A line
    // break is never typed: the typed path turns it into a Return key press (DC-N7), which would
    // send in a chat app or run a line in a terminal, so such a text is pasted.
    const wanted = rule?.insert ?? p.method;
    const method: InsertMethod =
      c.secure || wanted === "clipboard"
        ? "clipboard"
        : wanted === "type" && !r.text.includes("\n")
          ? "type"
          : "paste";
    // Nothing was pasted after a clipboard-only insert, so there is nothing to send (DC-S2).
    const send = method !== "clipboard" && (c.asked === "send" || p.sendAlways || spoken);
    // DC-L2: the helper reads the field back after a paste; never a password field's.
    const read = p.readField === true && method === "paste" && !c.secure;
    this.decoding--;
    if (this.latest === c) this.latest = null;
    this.inserts.set(c.helperId, id);
    if (read) this.reads.set(c.helperId, id);
    this.settle();
    this.o.send({
      type: "insert",
      id: c.helperId,
      text: r.text,
      method,
      send_key: send ? sendKey : "none",
      target: c.target,
      ...(p.restore ? {} : { restore: false }),
      ...(read ? { read_field: true } : {}),
      // A password field gets its text exactly as heard (DC-N8).
      ...(c.secure ? {} : spacing(p)),
    });
  }
}

/**
 * What a dictation's buffer became: nothing heard, or the text to insert and what was decoded;
 * `send` when it ended in a spoken send (DC-S5), whose words are gone from `text`.
 */
export type DictationResult =
  | { kind: "empty" }
  | { kind: "text"; d: EngineDecoded; text: string; echoRetry: boolean; send?: boolean };

/**
 * A dictation's buffer through the guards and the text rules (DC-E6, DC-L6, DC-S7, DC-S6): no
 * speech is no decode; an echoed context is decoded again without it; the text is the
 * vocabulary's, less its fillers, with its spoken marks replaced. A password field (`secure`) gets exactly what was heard. Throws when the engine fails.
 *
 * With `spokenSend`, a trailing "send it" is judged on the text before the formatting pass
 * (DC-U6), which could drop the phrase or add one: its words leave and `send` is set.
 */
export async function decodeDictation(
  o: TextRules,
  engine: DictationEngine,
  samples: Float32Array,
  language: string | undefined,
  secure = false,
  hold?: EngineHold,
  x: { spokenSend?: boolean; format?: AppRule["format"] } = {},
): Promise<DictationResult> {
  if ((await hearsSpeech(o, samples)) === false) {
    hold?.cancel();
    return { kind: "empty" };
  }
  const ask = language ? { language } : {};
  // The request opened at the press (DC-R6) takes the tail; any other decode sends the buffer.
  let d = await (hold ? hold.decode(samples) : engine.decode(samples, ask));
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
  let send = false;
  if (x.spokenSend) ({ text, send } = spokenSend(text));
  const f = await formatted(o, text, x.format);
  if (f?.skipped)
    d = { ...d, notice: d.notice ? `${d.notice}; ${FORMAT_SKIPPED}` : FORMAT_SKIPPED };
  return { kind: "text", d, text: f?.text ?? text, echoRetry, ...(send ? { send } : {}) };
}

/** The pill's line when the formatting pass was skipped and the raw text went in (DC-U6). */
export const FORMAT_SKIPPED = "formatting skipped";

/** The formatting pass (DC-U6), or null while it is off; a pass that throws is a skip. */
async function formatted(
  o: TextRules,
  text: string,
  mode?: AppRule["format"],
): Promise<{ text: string; skipped: string | null } | null> {
  if (!o.format || text.trim() === "") return null;
  try {
    return await (mode ? o.format(text, mode) : o.format(text));
  } catch (err) {
    o.onLog?.("warn", `format.skipped: ${(err as Error).message}`);
    return { text, skipped: (err as Error).message };
  }
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

/** The insert's spacing fields (DC-S4) from the policy. */
function spacing(p: InsertPolicy): { smart_spacing?: true; trailing_space?: true } {
  return {
    ...(p.smartSpacing ? { smart_spacing: true as const } : {}),
    ...(p.trailingSpace ? { trailing_space: true as const } : {}),
  };
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

/** The last `n` of the `total` samples in `chunks` (all of them when there are fewer). */
function lastSamples(chunks: readonly Float32Array[], total: number, n: number): Float32Array {
  if (total <= n) return concat(chunks, total);
  const out = new Float32Array(n);
  let end = n;
  for (let i = chunks.length - 1; i >= 0 && end > 0; i--) {
    const ch = chunks[i] as Float32Array;
    const take = Math.min(ch.length, end);
    out.set(ch.subarray(ch.length - take), end - take);
    end -= take;
  }
  return out;
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
