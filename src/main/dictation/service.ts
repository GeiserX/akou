/**
 * Dictation in the app (docs/ux/DICTATION.md): the log, the engine, and the helper's `dictate`
 * process with the session over it. `dictation.enabled` is the master switch (DC-A1): off, no
 * helper process runs and no key is taken; on, `akou-capture dictate` is started and bound.
 *
 * `POST /v1/dictations` goes through `transcribeClip`: the same engine and the same log as a
 * spoken dictation, with no helper, no key and no insert. `control` is the tray's and the CLI's
 * door to the live session (DC-G1, DC-O4): a latched session started, stopped or cancelled as if
 * the key were tapped.
 *
 * Retention (DC-H2): `dictation.retainDays` is applied when the service starts, every hour, and at
 * each new dictation, so with 0 the one before is deleted as the next one begins. A spoken
 * dictation's audio is kept beside the log for Retry and the learning check; deleting a dictation
 * deletes its audio. With `dictation.keepAudio` off, the audio goes when the dictation's learn
 * window closes: at once for one that was not inserted or with `dictation.learn` off, else
 * `LEARN_WINDOW_MS` after the insert, DC-L2's longest read-back. A drafted one's stays open while
 * the draft waits in the box, and closes when the box answers it. A window never outlives the app:
 * at the next start, and at every sweep, the audio of a finished dictation with no open window goes.
 *
 * The learning check (DC-L3) runs on that audio: a fix made in the draft box, or in the app's own
 * field after a direct insert, is decoded again from the kept file by `check`, a local Qwen, while
 * the learn window holds the file open.
 *
 * Learning from the app's field (DC-L2): with `dictation.readField` on, the helper reads the field
 * back after a paste and sends the runs of words the user changed. Their candidates go through the
 * same offer as the draft box's, and the chip goes to the followers (`chip`): the pill shows it,
 * and with the pill off the shell shows one notification and releases it, so its pairs wait in the
 * words to review (DC-O4). Its answers come back through `answerChip`.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DictationEvent, DictationItem } from "../../core/dictation/events.ts";
import { applyHunks, type Redecode } from "../../core/dictation/learn.ts";
import type { CueMoment } from "../../ui/dictation-cues.ts";
import type { Chip, ChipAnswer } from "../../ui/pill-protocol.ts";
import { realClock, withDeadline } from "../capture/engine.ts";
import { LineSplitter, PacketDecoder } from "../capture/protocol.ts";
import { DICTATION_AUDIO, DictationAudio } from "./audio.ts";
import { DraftBox, type DraftBoxOptions } from "./draft.ts";
import { forcesLanguage } from "./engines.ts";
import { Learner } from "./learner.ts";
import {
  type Bindings,
  type EditHunk,
  encodeCommand,
  type Grant,
  parseHelperLine,
} from "./protocol.ts";
import type { RemoteFallback, RemoteHealth } from "./remote.ts";
import {
  type AutoStop,
  type DictationEngine,
  DictationSession,
  decodeDictation,
  type InsertPolicy,
  type PreviewDecode,
  type RebindAnswer,
  type SessionState,
  type TextRules,
  textEvent,
} from "./session.ts";
import { DICTATION_DIR, DictationLog, expiredDictations, FINAL, newDictationId } from "./store.ts";

/** How long `stop` waits for the helper to exit before it is killed. */
const STOP_MS = 2000;

/**
 * How long the grants a probe read are reused (DC-U2, DC-N3): the setup reads them once a second
 * while a grant step waits, so each read runs at most one probe.
 */
export const PROBE_MS = 1000;

/** A probe that has not printed its `ready` line by then answers nothing. */
const PROBE_DEADLINE_MS = 5000;

export type Grants = { mic: Grant; accessibility: Grant };

/** A grant dictation can work with: given, one the OS does not ask for, or one not asked yet. */
const grantOk = (g: Grant) => g !== "denied";

/** How often `dictation.retainDays` is applied while the app runs. */
const SWEEP_MS = 60 * 60 * 1000;

/** How long `control` waits for the helper to act on a session command. */
export const CONTROL_MS = 3000;

/**
 * How long a dictation's audio outlives its insert with `dictation.keepAudio` off: DC-L2 reads the
 * field back within 60 s of the insert, and the learning check runs on the audio after that read;
 * the 5 s more let the helper's last read arrive. An answer from the helper closes it sooner.
 */
export const LEARN_WINDOW_MS = 65_000;

/** The events after which a dictation's learn window can open or close. */
const SETTLED = new Set([
  "dictation.inserted",
  "dictation.drafted",
  "dictation.discarded",
  "dictation.cancelled",
  "dictation.empty",
  "dictation.failed",
]);

/**
 * How long a chip for a fix in the app's field waits for an answer before it is released, so its
 * learn window closes even when no pill or shell took it: the page's 8 s question, its 6 s Undo
 * line, and a margin.
 */
export const CHIP_RELEASE_MS = 20_000;

/** A retry's answer (DC-G1): the same audio decoded again, beside the dictation, never over it. */
export interface RetryAnswer {
  id: string;
  text: string;
  raw: string;
  language: string | null;
  words: DictationItem["words"];
  engine: string;
  model: string | null;
  ms: number | null;
  fallback_from?: string;
  language_forced?: boolean;
  echo_retry?: boolean;
}

export type RetryResult =
  | { ok: true; answer: RetryAnswer }
  | {
      ok: false;
      code: "not_found" | "no_audio" | "models_missing" | "transcription_failed";
      message: string;
    };

/** The session commands of the tray and the CLI (DC-G1). */
export type ControlAction = "start" | "stop" | "cancel";

/** Why a session command was refused: the code the API answers with, and a sentence. */
export type ControlResult =
  | { ok: true; state: DictationStatus["state"] }
  | {
      ok: false;
      code: "dictation_off" | "dictation_starting" | "dictation_busy" | "not_dictating";
      message: string;
    };

export interface DictationServiceOptions extends TextRules {
  /** The config folder: the log is `dictation/events.jsonl` in it. */
  configDir: string;
  /** The engine `dictation.engine` picks, or the one named (`fast`, `remote`); null with none. */
  engine(name?: string): DictationEngine | null;
  now(): number;
  /** `dictation.language` when it is set, else undefined: the engine chooses (DC-E4). */
  language?(): string | undefined;
  /** Why the engine is the one it is ("best on metal"), for `GET /v1/dictation` (DC-E3). */
  verdict?(): string;
  /** Whether the engine is loading its model now: a press is kept and decoded once it is ready. */
  loading?(): boolean;
  /** The remote engine's standing while `dictation.engine` is `remote`, else null (DC-R3). */
  remote?(): DictationRemoteStatus | null;
  /**
   * The helper's `dictate --probe` command, which prints the `ready` line with the grants read
   * without asking and exits (DC-U2, DC-N3). Absent, the grants are known only while it runs.
   */
  probe?(): readonly string[];
  /** Plays the cue for a moment of a spoken dictation, or nothing, as the settings say (DC-O3). */
  cue?(moment: CueMoment): void;
  /** `dictation.mic` and `dictation.preferBuiltInOverBluetooth`, for `rebuild_mic` (DC-U4). */
  mic?(): { device: string; preferBuiltIn: boolean };
  /** `dictation.retainDays` as it is now; absent, nothing is ever deleted by age. */
  retainDays?(): number;
  /** `dictation.keepAudio` as it is now; absent, the audio is kept. */
  keepAudio?(): boolean;
  /** Whether `dictation.learn` is on: off, no candidate is computed, so no learn window opens. */
  learns?(): boolean;
  /** How long a learn window stays open after an insert; `LEARN_WINDOW_MS` by default. */
  learnWindowMs?: number;
  /**
   * How a spoken dictation's text goes in (DC-S2): `dictation.insert`, `dictation.sendKey`,
   * `dictation.sendAlways`, `dictation.restoreClipboard`. Absent: paste, and never a send key.
   */
  insert?(): InsertPolicy;
  /** `dictation.silenceStopSeconds` and `dictation.maxMinutes` (DC-A3); absent, never. */
  autoStop?(): AutoStop;
  /** `dictation.spokenSend` (DC-S5); absent, off. */
  spokenSend?(): boolean;
  /**
   * The audio check of DC-L3 as it can run now: a local Qwen decoding a dictation's audio again
   * with the given words as its only context, or null when none is warm for it. Absent, never.
   */
  check?():
    | ((samples: Float32Array, glossary: readonly string[], language?: string) => Promise<string>)
    | null;
  /**
   * What the draft box needs beside the log and the session (DC-S1, DC-L1, DC-L4); absent, the
   * box sends nothing, learns nothing and inserts with no send key.
   */
  draft?: Partial<
    Pick<
      DraftBoxOptions,
      | "platform"
      | "sendKey"
      | "learnMode"
      | "engines"
      | "knownPairs"
      | "commonWords"
      | "learnEntry"
      | "unlearnEntry"
      | "later"
    >
  >;
}

/** The remote engine as `GET /v1/dictation` shows it. */
export interface DictationRemoteStatus {
  url: string;
  /** `dictation.remote.fallback` as it applies: `error` with no local model to fall back to. */
  fallback: RemoteFallback;
  /** Null before the first remote dictation of this run. */
  health: RemoteHealth | null;
}

export interface DictationStatus {
  enabled: boolean;
  /** `off` with dictation disabled or the helper gone, else the session's state. */
  state: "off" | SessionState;
  engine: string | null;
  /** Why it is that engine on this machine: "best on metal", "fast: best needs a GPU" (DC-E3). */
  verdict: string | null;
  /** The engine is loading its model: a press now is kept and decoded once it is ready. */
  loading: boolean;
  grants: Grants | null;
  backend: string | null;
  /** Whether the key source can hold Escape and Enter during a session (DC-A4); null before ready. */
  swallow_keys: boolean | null;
  remote: DictationRemoteStatus | null;
}

/**
 * What a follower of the dictation stream gets (DC-G2): every event the log appends, and the
 * helper's mic level during a session, which is never written anywhere.
 */
export type DictationFollow =
  | { kind: "event"; e: DictationEvent }
  | { kind: "level"; rms: number }
  /** The engine's line for the pill about dictation `id` (DC-E2, DC-R3), never written anywhere. */
  | { kind: "notice"; id: string; notice: string }
  /** The dictation key was pressed while a dictation transcribes: refused, never queued (DC-A4). */
  | { kind: "busy" }
  /** A line for the pill while listening (`1 minute left`, DC-A3), never written anywhere. */
  | { kind: "warning"; note: string }
  /**
   * The words heard so far in the session listening and their language (DC-E5), produced only
   * while a follower asks for them, never written anywhere and never inserted.
   */
  | { kind: "partial"; text: string; language: string | null }
  /**
   * The learn chip for a fix made in the app's field after a direct insert (DC-L2, DC-L4): the
   * pill shows it, or with the pill off the shell notifies and releases it (DC-O4).
   */
  | { kind: "chip"; chip: Chip };

interface Helper {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  session: DictationSession;
  exited: Promise<void>;
  /** Started again because a grant arrived: it is not started again for one more. */
  regranted?: boolean;
}

export class DictationService {
  readonly log: DictationLog;
  /** A spoken dictation's audio, beside the log (DC-H2). */
  readonly audio: DictationAudio;
  /** The draft box's main side (DC-S1); the shell attaches the window. */
  readonly draft: DraftBox;
  /** The offer to learn from a fix made in the app's own field (DC-L2, DC-L4). */
  private readonly field: Learner;
  /** The open learn windows with `dictation.keepAudio` off: the timer that closes each. */
  private readonly windows = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  private helper: Helper | null = null;
  /** The helper being stopped: a new one waits for it, so two never hold the key at once. */
  private stopping: Promise<void> | null = null;
  /** A start asked for while the last helper was stopping; a `stop` drops it. */
  private wanted: { argv: readonly string[]; bindings: () => Bindings } | null = null;
  /** The keys of the last start, for the pill's hint. */
  private keys: (() => Bindings) | null = null;
  /** The command of the last start, to start it again when a grant arrives. */
  private argv: readonly string[] | null = null;
  /** Counts the stops, so a start again after a grant does not undo a stop asked meanwhile. */
  private stops = 0;
  /** The Dictation page's key recorder while it is open (DC-U3). */
  private recorder: ((name: string) => void) | null = null;
  /** The last probe's grants and when it ran. */
  private probed: { at: number; grants: Promise<Grants | null> } | null = null;

  /** Where `POST /v1/dictations` spools a clip while it is decoded; emptied at every start. */
  readonly uploadDir: string;
  private readonly watchers = new Set<(state: DictationStatus["state"]) => void>();
  private readonly followers = new Set<(m: DictationFollow) => void>();
  /** The followers that asked for partials, each with its own say on whether it wants them now. */
  private readonly partialWants = new Map<(m: DictationFollow) => void, () => boolean>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly o: DictationServiceOptions) {
    this.log = new DictationLog(join(o.configDir, DICTATION_DIR), o.now);
    this.audio = new DictationAudio(join(o.configDir, DICTATION_DIR, DICTATION_AUDIO));
    this.uploadDir = join(o.configDir, DICTATION_DIR, "uploads");
    const d = o.draft ?? {};
    this.draft = new DraftBox({
      log: this.log,
      platform: d.platform ?? process.platform,
      session: () => this.session(),
      sendKey: d.sendKey ?? (() => "none"),
      learnMode: d.learnMode ?? (() => "off"),
      engines: d.engines ?? (() => []),
      retry: async (id, engine) => {
        const r = await this.retry(id, engine === "auto" ? {} : { engine });
        return r.ok ? r : { ok: false, message: r.message };
      },
      ...(d.knownPairs ? { knownPairs: d.knownPairs } : {}),
      ...(d.commonWords ? { commonWords: d.commonWords } : {}),
      learnEntry: d.learnEntry ?? (async () => {}),
      unlearnEntry: d.unlearnEntry ?? (async () => {}),
      closeLearnWindow: (id) => this.closeLearnWindow(id),
      recheck: (id) => this.recheck(id),
      ...(d.later ? { later: d.later } : {}),
      ...(o.onLog ? { onLog: o.onLog } : {}),
    });
    this.field = new Learner({
      log: this.log,
      learnMode: d.learnMode ?? (() => "off"),
      ...(d.knownPairs ? { knownPairs: d.knownPairs } : {}),
      ...(d.commonWords ? { commonWords: d.commonWords } : {}),
      learnEntry: d.learnEntry ?? (async () => {}),
      unlearnEntry: d.unlearnEntry ?? (async () => {}),
      recheck: (id) => this.recheck(id),
      onDone: (id) => this.closeLearnWindow(id),
      ...(d.later ? { later: d.later } : {}),
      ...(o.onLog ? { onLog: o.onLog } : {}),
    });
    // A clip left by a crash mid-decode: akou keeps no copy of an upload.
    rmSync(this.uploadDir, { recursive: true, force: true });
    mkdirSync(this.uploadDir, { recursive: true, mode: 0o700 });
    const r = this.log.report;
    if (r.truncated > 0)
      o.onLog?.("warn", `dictation log: a torn last line was cut (${r.truncated} bytes)`);
    if (r.invalidLines > 0) o.onLog?.("warn", `dictation log: ${r.invalidLines} bad lines skipped`);
    // A new dictation is where `retainDays: 0` lets the one before go; after the append returns.
    this.log.onAppend = (e) => {
      if (e.type === "dictation.started") queueMicrotask(() => this.sweep());
      if (SETTLED.has(e.type)) this.settledAudio(e.id, e.type);
      this.tell({ kind: "event", e });
    };
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref?.();
  }

  /**
   * Deletes what `dictation.retainDays` no longer keeps (DC-H2), leaving a tombstone each. Returns
   * the ids deleted.
   */
  sweep(): string[] {
    const days = this.o.retainDays?.();
    let gone: string[] = [];
    try {
      if (days !== undefined) {
        gone = this.forget(expiredDictations(this.log.items(), this.o.now(), days));
        if (gone.length > 0)
          this.o.onLog?.("info", `dictation: ${gone.length} past retention deleted`);
      }
      this.sweepAudio();
    } catch (err) {
      this.o.onLog?.("error", `dictation retention: ${(err as Error).message}`);
    }
    return gone;
  }

  /**
   * Deletes dictations (DC-H2): the log keeps a tombstone each, and their audio is gone. Returns
   * the ids deleted.
   */
  forget(ids: Iterable<string>): string[] {
    const gone = this.log.forget(ids);
    for (const id of gone) this.dropAudio(id);
    return gone;
  }

  /**
   * The audio no dictation needs any more: a file whose dictation is gone (a crash between the
   * tombstone and the delete), and with `dictation.keepAudio` off, a finished dictation's whose
   * learn window is not open.
   */
  private sweepAudio(): void {
    const keep = this.o.keepAudio?.() ?? true;
    const items = new Map(this.log.items().map((it) => [it.id, it]));
    for (const id of this.audio.ids()) {
      const it = items.get(id);
      if (!it || (!keep && FINAL.has(it.state) && !this.windows.has(id))) this.dropAudio(id);
    }
  }

  /** A dictation settled: with `dictation.keepAudio` off, its learn window opens or it is closed. */
  private settledAudio(id: string, type: string): void {
    if ((this.o.keepAudio?.() ?? true) || !this.audio.has(id)) return;
    clearTimeout(this.windows.get(id));
    this.windows.delete(id);
    // A draft waits in the box for as long as the user takes, and the box's Retry decodes this
    // audio again: its window has no timer, and the box closes it when the draft is answered.
    if (type === "dictation.drafted") {
      this.windows.set(id, undefined);
      return;
    }
    // Only an inserted dictation can be fixed and learned from.
    if (type !== "dictation.inserted" || !(this.o.learns?.() ?? true)) {
      this.dropAudio(id);
      return;
    }
    const t = setTimeout(() => this.closeLearnWindow(id), this.o.learnWindowMs ?? LEARN_WINDOW_MS);
    t.unref?.();
    this.windows.set(id, t);
  }

  /**
   * The learning of this dictation is over (the chip closed or ignored, the read-back done or past
   * its time): with `dictation.keepAudio` off, its audio is deleted now, and its text stays.
   */
  closeLearnWindow(id: string): void {
    clearTimeout(this.windows.get(id));
    this.windows.delete(id);
    if (!(this.o.keepAudio?.() ?? true)) this.dropAudio(id);
  }

  /**
   * DC-L3's audio check on dictation `id`: its kept audio decoded again with a fixed word as the
   * only context. Null when no local Qwen can run it now or no audio is kept.
   */
  private recheck(id: string): Redecode | null {
    const run = this.o.check?.();
    if (!run || !this.audio.has(id)) return null;
    const language = this.o.language?.();
    return async (glossary) => {
      const samples = await this.audio.read(id);
      if (!samples) throw new Error("the dictation's audio is gone");
      return run(samples, glossary, language);
    };
  }

  /**
   * The field read back after dictation `id` was pasted (DC-L2): the user's fix there is offered
   * like one made in the draft box, and the chip goes to the followers. Null hunks, a field that
   * could not be read, or an edit with nothing to offer ends the learn window now.
   */
  private async fromField(id: string, hunks: EditHunk[] | null): Promise<void> {
    const it = this.log.item(id);
    const base = it?.text
      ? it.text
          .split(/\s+/)
          .filter((w) => w !== "")
          .join(" ")
      : null;
    const edited = base !== null && hunks && hunks.length > 0 ? applyHunks(base, hunks) : null;
    if (!it || base === null || edited === null) {
      if (it && base !== null && hunks && hunks.length > 0)
        this.o.onLog?.("warn", `dictation ${id}: the field's edit does not match the insert`);
      this.closeLearnWindow(id);
      return;
    }
    // The learning runs on the audio: the window stays open until the chip is over.
    clearTimeout(this.windows.get(id));
    if (this.windows.has(id)) this.windows.set(id, undefined);
    const chip = await this.field.offer({
      id,
      base,
      edited,
      words: it.words,
      language: it.language,
    });
    if (!chip) {
      this.closeLearnWindow(id);
      return;
    }
    this.field.shown(chip);
    const later =
      this.o.draft?.later ??
      ((ms: number, fn: () => void) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return () => clearTimeout(t);
      });
    later(CHIP_RELEASE_MS, () => this.field.release(id));
    this.tell({ kind: "chip", chip });
  }

  /** The user's answer to a chip the pill showed for a fix in the app's field (DC-L4). */
  answerChip(a: ChipAnswer): Promise<boolean> {
    return this.field.answer(a);
  }

  /**
   * The chip for dictation `id` has nowhere to show (the pill is off): it is over with nothing
   * written, so its pairs wait in the words to review (DC-O4, DC-L5).
   */
  releaseChip(id: string): void {
    this.field.release(id);
  }

  private dropAudio(id: string): void {
    clearTimeout(this.windows.get(id));
    this.windows.delete(id);
    try {
      this.audio.remove(id);
    } catch (err) {
      this.o.onLog?.("error", `dictation audio ${id} not deleted: ${(err as Error).message}`);
    }
  }

  /**
   * Decodes a dictation's kept audio again with `engine` (DC-G1, DC-H1): the same guards and text
   * rules as a new dictation, answered beside the first reading. The dictation and its log are not
   * changed.
   */
  async retry(id: string, o: { engine?: string } = {}): Promise<RetryResult> {
    if (!this.log.item(id)) return { ok: false, code: "not_found", message: `no dictation ${id}` };
    const samples = await this.audio.read(id);
    if (!samples) {
      return {
        ok: false,
        code: "no_audio",
        message: `dictation ${id} has no audio kept (a clip sent to the API, a password field, or dictation.keepAudio off)`,
      };
    }
    const engine = this.o.engine(o.engine);
    if (!engine) return { ok: false, code: "models_missing", message: "no speech model is loaded" };
    const language = this.o.language?.();
    try {
      const r = await decodeDictation(this.o, engine, samples, language);
      if (r.kind === "empty") {
        return {
          ok: true,
          answer: {
            id,
            text: "",
            raw: "",
            language: null,
            words: [],
            engine: engine.name,
            model: null,
            ms: null,
          },
        };
      }
      const { type: _, ...t } = textEvent(id, r, engine.name, language) as Extract<
        ReturnType<typeof textEvent>,
        { type: "dictation.text" }
      >;
      return { ok: true, answer: t };
    } catch (err) {
      return { ok: false, code: "transcription_failed", message: (err as Error).message };
    }
  }

  /** Called with the session's state at every change, `off` included. Returns the unsubscribe. */
  watch(fn: (state: DictationStatus["state"]) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /**
   * Called with every event the log appends and every mic level, from now on (DC-G2). Returns the
   * unsubscribe. `partials`: while it answers true, the session listening is decoded again for the
   * words as you speak (DC-E5); with no follower asking, no partial is ever decoded.
   */
  follow(fn: (m: DictationFollow) => void, o: { partials?: () => boolean } = {}): () => void {
    this.followers.add(fn);
    if (o.partials) this.partialWants.set(fn, o.partials);
    return () => {
      this.followers.delete(fn);
      this.partialWants.delete(fn);
    };
  }

  /**
   * The preview's decoder (DC-E5): the local `fast` engine, which decodes a few seconds in a
   * fraction of a second, whatever engine the dictation's own text comes from. Parakeet names no
   * language, so its partials carry none. Null while no follower wants partials or no local model
   * is loaded.
   */
  private previewDecode(): PreviewDecode | null {
    if (![...this.partialWants.values()].some((wants) => wants())) return null;

    const fast = this.o.engine("fast");
    if (!fast) return null;
    return (samples) => fast.decode(samples, {});
  }

  /**
   * The languages the pill's chip moves between (akou-5v8): `dictation.languages`, else
   * `asr.languages`; `switchable` when there are two or more and the engine takes a forced one
   * (`fast` picks its own, DC-E4); `language`, the one a session asks for before the chip moves
   * it: `dictation.language`, else null (the engine chooses).
   */
  languageChoice(): {
    languages: readonly string[];
    switchable: boolean;
    language: string | null;
  } {
    const languages = this.o.languages?.() ?? [];
    const engine = this.o.engine()?.name ?? "fast";
    return {
      languages,
      switchable: languages.length >= 2 && forcesLanguage(engine),
      language: this.o.language?.() ?? null,
    };
  }

  /** Forces `language` for the session listening, from the pill's chip; false with none. */
  setLanguage(language: string): boolean {
    return this.helper?.session.setLanguage(language) ?? false;
  }

  private tell(m: DictationFollow): void {
    for (const fn of this.followers) {
      try {
        fn(m);
      } catch (err) {
        this.o.onLog?.("error", `dictation follower: ${(err as Error).message}`);
      }
    }
  }

  private emit(): void {
    const state = this.helper?.session.state ?? "off";
    for (const fn of this.watchers) fn(state);
  }

  /**
   * The tray's and the CLI's door (DC-G1, DC-O4): `start` a latched session as if the key were
   * tapped, `stop` it (its audio is transcribed and inserted), or `cancel` it (nothing is). Resolves
   * once the helper acted; a helper that did not act within `CONTROL_MS` is a refusal.
   */
  async control(action: ControlAction, waitMs = CONTROL_MS): Promise<ControlResult> {
    const s = this.helper?.session;
    if (!s)
      return { ok: false, code: "dictation_off", message: "dictation is off (dictation.enabled)" };
    if (!s.ready)
      return { ok: false, code: "dictation_starting", message: "the dictation helper is starting" };
    if (action === "start" && s.state !== "idle") {
      return { ok: false, code: "dictation_busy", message: `a dictation is ${s.state} already` };
    }
    if (action !== "start" && s.state !== "listening") {
      return { ok: false, code: "not_dictating", message: "no dictation is listening" };
    }
    s.command(action);
    const done = () => (action === "start" ? s.state !== "idle" : s.state !== "listening");
    const t0 = Date.now();
    while (!done() && Date.now() - t0 < waitMs) await Bun.sleep(10);
    const state = this.helper?.session.state ?? "off";
    // The helper can drop the command (still settling an insert, say): a script must not be told
    // it is dictating when nothing started.
    if (!done()) {
      return {
        ok: false,
        code: action === "start" ? "dictation_busy" : "not_dictating",
        message: `the dictation helper did not ${action} within ${waitMs / 1000} s (still ${state})`,
      };
    }
    return { ok: true, state };
  }

  /** The dictation key the helper is bound to, or null before the first start. */
  hotkey(): string | null {
    return this.keys?.().hotkey ?? null;
  }

  /** The session over the running helper, or null with dictation off. */
  session(): DictationSession | null {
    return this.helper?.session ?? null;
  }

  status(): DictationStatus {
    const s = this.helper?.session;
    return {
      enabled: this.helper !== null,
      state: s ? s.state : "off",
      engine: this.o.engine()?.name ?? null,
      verdict: this.o.verdict?.() ?? null,
      loading: this.o.loading?.() ?? false,
      grants: s?.ready?.grants ?? null,
      backend: s?.ready?.backend ?? null,
      swallow_keys: s?.ready?.swallow_keys ?? null,
      remote: this.o.remote?.() ?? null,
    };
  }

  /**
   * Starts `argv` (the helper's program and its `dictate` subcommand) and binds the keys once it
   * is ready. A second start while one runs does nothing; a start while the last helper is still
   * stopping runs once it has exited.
   */
  start(argv: readonly string[], bindings: () => Bindings): void {
    if (this.helper) return;
    if (this.stopping) {
      const first = this.wanted === null;
      this.wanted = { argv, bindings };
      if (first)
        void this.stopping.then(() => {
          const w = this.wanted;
          this.wanted = null;
          if (w) this.start(w.argv, w.bindings);
        });
      return;
    }
    this.keys = bindings;
    this.argv = argv;
    this.recorder = null;
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      this.o.onLog?.("error", `dictation helper did not start: ${(err as Error).message}`);
      return;
    }
    const session = new DictationSession({
      log: this.log,
      engine: this.o.engine,
      bindings,
      now: this.o.now,
      ...textRules(this.o),
      ...(this.o.language ? { language: this.o.language } : {}),
      onState: () => this.emit(),
      onLevel: (rms) => this.tell({ kind: "level", rms }),
      onNotice: (id, notice) => this.tell({ kind: "notice", id, notice }),
      saveAudio: (id, samples) => this.audio.write(id, samples),
      onDraft: (id, _reason, focus) => this.draft.open(id, { focus }).ok,
      ...(this.o.insert ? { insertPolicy: this.o.insert } : {}),
      onBusy: () => this.tell({ kind: "busy" }),
      onWarning: (note) => this.tell({ kind: "warning", note }),
      ...(this.o.autoStop ? { autoStop: this.o.autoStop } : {}),
      ...(this.o.spokenSend ? { spokenSend: this.o.spokenSend } : {}),
      onEdit: (id, hunks) => void this.fromField(id, hunks),
      preview: () => this.previewDecode(),
      onPartial: (p) => this.tell({ kind: "partial", ...p }),
      onCue: (m) => this.o.cue?.(m),
      onRecordedKey: (name) => this.recorder?.(name),
      ...(this.o.mic ? { mic: this.o.mic } : {}),
      send: (c) => {
        try {
          proc.stdin.write(encodeCommand(c));
          proc.stdin.flush();
        } catch {
          // The helper is gone; its exit is reported below.
        }
      },
      onLog: this.o.onLog,
    });
    const out = (async () => {
      const dec = new PacketDecoder();
      try {
        for await (const chunk of proc.stdout) for (const p of dec.push(chunk)) session.onPacket(p);
      } catch (err) {
        this.o.onLog?.("error", `dictation helper audio: ${(err as Error).message}`);
        proc.kill("SIGKILL");
      }
    })();
    const err = (async () => {
      const lines = new LineSplitter();
      const handle = (line: string) => {
        const m = parseHelperLine(line);
        if (m.kind === "msg") session.onMessage(m.msg);
        else this.o.onLog?.("info", `dictation helper: ${m.line}`);
      };
      try {
        for await (const chunk of proc.stderr) for (const l of lines.push(chunk)) handle(l);
        for (const l of lines.flush()) handle(l);
      } catch {
        // The pipe broke because the helper died; the exit is reported below.
      }
    })();
    const h: Helper = { proc, session, exited: Promise.resolve() };
    h.exited = (async () => {
      await proc.exited;
      await Promise.all([out, err]);
      session.helperGone();
      if (this.helper === h) {
        this.helper = null;
        this.o.onLog?.("warn", `dictation helper exited (code ${proc.exitCode})`);
        this.emit();
      }
    })();
    this.helper = h;
    this.emit();
  }

  /**
   * Sends the running helper the keys (a setting changed, DC-A7) and resolves with its answer; with
   * no helper up there is nothing to refuse.
   */
  rebind(b?: Bindings): Promise<RebindAnswer> {
    return this.helper?.session.rebind(b) ?? Promise.resolve({ ok: true });
  }

  /**
   * Opens the Dictation page's key recorder (DC-U3), which gets every key the helper sees, Fn
   * included, while no session can start; null closes it. False with no helper ready.
   */
  recordKeys(fn: ((name: string) => void) | null): boolean {
    const s = this.helper?.session;
    if (!s?.ready) return false;
    this.recorder = fn;
    return s.recordKeys(fn !== null);
  }

  /** `dictation.mic` or `dictation.preferBuiltInOverBluetooth` changed: the helper opens it now. */
  rebuildMic(): void {
    this.helper?.session.rebuildMic();
  }

  /**
   * The grants as the OS holds them now (DC-U2, DC-N3). The running helper's, while each is given;
   * else a probe's, read without asking, so the setup sees a grant arrive and the switch sees one
   * missing before any helper starts. A helper that started without a grant the probe now finds
   * is started again once idle, since the macOS key tap is made at the start. Null when nothing
   * can say.
   */
  async grants(): Promise<Grants | null> {
    const h = this.helper;
    const ready = h?.session.ready?.grants ?? null;
    if (ready && grantOk(ready.mic) && grantOk(ready.accessibility)) return ready;
    const fresh = await this.probeGrants();
    if (!fresh) return ready;
    if (
      h &&
      ready &&
      this.helper === h &&
      !h.regranted &&
      h.session.state === "idle" &&
      ((!grantOk(ready.mic) && grantOk(fresh.mic)) ||
        (!grantOk(ready.accessibility) && grantOk(fresh.accessibility)))
    ) {
      this.restartForGrant(h);
    }
    return fresh;
  }

  private probeGrants(): Promise<Grants | null> {
    const argv = this.o.probe?.();
    if (!argv) return Promise.resolve(null);
    const at = Date.now();
    if (this.probed && at - this.probed.at < PROBE_MS) return this.probed.grants;
    const grants = (async (): Promise<Grants | null> => {
      let proc: Bun.Subprocess<"ignore", "ignore", "pipe">;
      try {
        proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      } catch (err) {
        this.o.onLog?.("warn", `dictation probe did not start: ${(err as Error).message}`);
        return null;
      }
      const r = await withDeadline(realClock, new Response(proc.stderr).text(), PROBE_DEADLINE_MS);
      if (!r.ok) {
        proc.kill("SIGKILL");
        return null;
      }
      for (const line of r.value.split("\n")) {
        const m = parseHelperLine(line);
        if (m.kind === "msg" && m.msg.type === "ready") return m.msg.grants;
      }
      return null;
    })();
    this.probed = { at, grants };
    return grants;
  }

  /** Stops helper `h` and starts it again with the same command and keys, unless stopped meanwhile. */
  private restartForGrant(h: Helper): void {
    const argv = this.argv;
    const keys = this.keys;
    if (!argv || !keys) return;
    this.o.onLog?.(
      "info",
      "dictation: a grant arrived since the helper started; starting it again",
    );
    h.regranted = true;
    const stop = this.stop();
    const mine = this.stops;
    void stop.then(() => {
      if (this.stops !== mine || this.helper) return;
      this.start(argv, keys);
      // `start` sets the helper; the check above narrowed it to null.
      const started = this.helper as Helper | null;
      if (started) started.regranted = true;
    });
  }

  /** Stops the helper: `stop`, then a kill if it has not exited within 2 s. */
  async stop(): Promise<void> {
    this.stops++;
    this.wanted = null;
    const h = this.helper;
    if (!h) return this.stopping ?? undefined;
    this.helper = null;
    this.emit();
    const done = (async () => {
      try {
        h.proc.stdin.write(encodeCommand({ type: "stop" }));
        h.proc.stdin.end();
      } catch {
        // Already gone.
      }
      const r = await withDeadline(realClock, h.exited, STOP_MS);
      if (!r.ok) {
        h.proc.kill("SIGKILL");
        await h.exited;
      }
    })();
    this.stopping = done;
    await done;
    if (this.stopping === done) this.stopping = null;
  }

  /**
   * One clip through the dictation path with no key and no insert (`POST /v1/dictations`): the
   * same engine and the same log as a spoken dictation.
   */
  async transcribeClip(
    samples: Float32Array,
    o: { by: string; language?: string; engine?: string },
  ): Promise<DictationItem> {
    const engine = this.o.engine(o.engine);
    const language = o.language ?? this.o.language?.();
    const id = newDictationId(this.o.now());
    const seconds = Math.round((samples.length / 16000) * 1000) / 1000;
    this.log.append({
      type: "dictation.started",
      id,
      target: null,
      engine: engine?.name ?? "fast",
      by: o.by,
    });
    this.log.append({ type: "dictation.ended", id, reason: "clip", seconds });
    if (!engine) {
      this.log.append({ type: "dictation.failed", id, error: "no speech model is loaded" });
    } else {
      try {
        const r = await decodeDictation(this.o, engine, samples, language);
        if (r.kind === "text") this.log.append(textEvent(id, r, engine.name, language));
        if (r.kind === "empty" || r.text === "") this.log.append({ type: "dictation.empty", id });
      } catch (err) {
        this.log.append({ type: "dictation.failed", id, error: (err as Error).message });
      }
    }
    const it = this.log.item(id);
    if (!it) throw new Error("the dictation was deleted while it was decoded");
    return it;
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.field.clear();
    for (const t of this.windows.values()) clearTimeout(t);
    this.windows.clear();
    await this.stop();
    this.log.close();
  }
}

/** The text rules the service hands each session (DC-E6, DC-L6, DC-S7, DC-S6). */
function textRules(o: TextRules): TextRules {
  const r: TextRules = {};
  if (o.correct) r.correct = o.correct;
  if (o.speech) r.speech = o.speech;
  if (o.fillers) r.fillers = o.fillers;
  if (o.languages) r.languages = o.languages;
  if (o.punctuation) r.punctuation = o.punctuation;
  if (o.format) r.format = o.format;
  return r;
}
