/**
 * The main process's half of the dictation pill's RPC (docs/ux/DICTATION.md section 5.1, DC-O1,
 * DC-D2). Like `indicator.ts`, no ElectroBun import: the shell opens the window, this decides what
 * its page is told.
 *
 * The pill shows the session's state, never its words: every state is built here from named
 * fields (the dictation key's label, the times, a notice, an insert method, an error), so a
 * transcript in the log never reaches the page. The one way words do, the preview of DC-O2, goes
 * through `pillPreview`, which lets them through only with `dictation.pillPreview` on.
 *
 * While the pill exists it asks the session for partials (DC-E5): their language sets the chip on
 * the listening island (akou-5v8), and with the preview on their words go to the ticker, with the
 * part that did not change since the last partial marked as settled. A click on the chip moves the
 * session to the next of the user's languages when the engine takes a forced one.
 *
 * - `listening` from the session's state, with the hints the key source can honour (DC-A4):
 *   Escape, Enter and Shift+Enter where it swallows keys; only the dictation key's on the portal
 *   and the CLI, where no other key does anything in a session. `1 minute left` under them one
 *   minute before `dictation.maxMinutes` (DC-A3).
 * - `transcribing` while the engine decodes and the helper inserts, `loading model` under it when
 *   the engine was still loading at the release, and `still transcribing` for `BUSY_MS` when the
 *   dictation key is pressed then (the helper refuses the press, DC-A4).
 * - `inserted` or `copied` for `DONE_MS` after the helper's receipt, with the engine's notice
 *   (`best failed, used fast`) or, after a clipboard-only insert, the paste hint.
 * - `error` with the log's message for `ERROR_MS`. Its buttons (Retry, Copy, Open draft) wait for
 *   the draft box (DC-S1), so it offers none yet.
 * - hidden otherwise: an empty or cancelled dictation, dictation off, the helper starting.
 * - the learn chip (DC-L4) for a fix made in the app's field after a direct insert (DC-L2): shown
 *   with the window, whatever the state, until it is answered, and after Learn for its Undo line;
 *   a page that never answers is taken as ignoring it after `CHIP_WAIT_MS`. The chip carries only
 *   the fixed word and its heard form, the words DC-D2 lets it show.
 *
 * Only the spoken session's dictations count: a clip sent to `POST /v1/dictations` has no target
 * and never shows here.
 */

import type {
  ChipAnswer,
  PillKey,
  PillLanguage,
  PillRpc,
  PillState,
} from "../../ui/pill-protocol.ts";
import { pillPreview } from "../../ui/pill-protocol.ts";
import { LEARNED_MS } from "../dictation/learner.ts";
import type { DictationFollow } from "../dictation/service.ts";

type Messages = PillRpc["webview"]["messages"];
type Requests = PillRpc["bun"]["requests"];
type Handler<K extends keyof Requests> = (
  p: Requests[K]["params"],
) => Promise<Requests[K]["response"]>;

/** What the handlers push to the pill page; ElectroBun's `rpc.send`. */
export interface PillSend {
  state(s: Messages["state"]): void;
  level(l: Messages["level"]): void;
  preview(p: Messages["preview"]): void;
  chip(c: Messages["chip"]): void;
}

/** Dictation as the pill sees it: the app's `DictationService` behind the shell. */
export interface PillDictation {
  status(): { state: string; loading: boolean; swallow_keys: boolean | null };
  /**
   * The log's events, the mic level and the engine's notices, from now on; the session's partials
   * while `partials` answers true (DC-E5).
   */
  follow(fn: (m: DictationFollow) => void, o?: { partials?: () => boolean }): () => void;
  /** Stop and Cancel, the same session door as `POST /v1/dictation/stop` and `/cancel`. */
  control(action: "stop" | "cancel"): Promise<boolean>;
  /** The languages the chip moves between, and whether the engine takes a forced one (akou-5v8). */
  languageChoice?(): { languages: readonly string[]; switchable: boolean };
  /** Forces a language for the session listening; false with none listening. */
  setLanguage?(language: string): boolean;
  /** The answer to a learn chip the pill showed (DC-L4); absent, no chip is answered. */
  chip?(a: ChipAnswer): Promise<boolean>;
}

export interface PillOptions {
  platform: string;
  /** The dictation key as the helper binds it (`RightCommand`), read at each session. */
  hotkey(): string;
  now(): number;
  /** Shows the window (true) without taking the focus, or hides it. */
  onVisible(visible: boolean): void;
  /** DC-D2's rule: `dictation.pillPreview`. */
  preview: { setting(): unknown };
  /** Runs `fn` after `ms`; returns the cancel. Tests pass their own. */
  later?(ms: number, fn: () => void): () => void;
  /** The label for a binding (`Right ⌘`). */
  label(binding: string, platform: string): string;
}

export interface PillRpcHandlers {
  handlers: { [K in keyof Requests]: Handler<K> };
  /** The session's state changed: the shell calls this from its own watch. */
  update(): void;
  /** A partial while listening, sent only as DC-D2 allows (DC-O2; the session's come here too). */
  preview(partial: unknown): void;
  /** What the page shows now. */
  shown(): PillState;
  close(): void;
}

/** How long `inserted` or `copied` stays before the pill hides (DC-O1). */
export const DONE_MS = 1500;
/** How long an error stays: it has no button to close it until the draft box exists. */
export const ERROR_MS = 5000;
/** The line under `transcribing` while the engine was loading its model at the release. */
export const LOADING_NOTE = "loading model";
/** The flash under `transcribing` when the dictation key is pressed then (DC-A4). */
export const BUSY_NOTE = "still transcribing";
/** How long that flash stays. */
export const BUSY_MS = 1200;

/**
 * How long a question chip may stay without an answer: the page's own 8 s (`CHIP_ASK_MS`) and a
 * margin. A page that never answers (not booted, closed) is taken as ignoring it then.
 */
export const CHIP_WAIT_MS = 10_000;

/** The key hints of a key source that swallows keys during a session (DC-A4). */
const SWALLOWED: readonly PillKey[] = ["escape", "enter", "shift-enter"];

/** The mic level in dBFS for the meter, -60 (silence) to 0 (full scale). */
export function levelDb(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return -60;
  return Math.max(-60, Math.min(0, Math.round(20 * Math.log10(rms) * 10) / 10));
}

/** The shortcut beside `Copied` after a clipboard-only insert: nothing was pasted, so the user pastes. */
export function pasteHint(platform: string): string {
  return platform === "darwin" ? "⌘V" : "Ctrl+V";
}

/**
 * How many words at the start of a partial are settled: the longest run of them the last partial
 * had too, in order, from wherever it began there. The preview decodes the end of the audio, so
 * once a dictation outgrows it the words slide left and the run starts later in the last one.
 */
export function settledWords(last: readonly string[], next: readonly string[]): number {
  let best = 0;
  for (let j = 0; j < last.length; j++) {
    let k = 0;
    while (j + k < last.length && k < next.length && last[j + k] === next[k]) k++;
    best = Math.max(best, k);
  }
  return best;
}

const realLater = (ms: number, fn: () => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function pillRpc(d: PillDictation, send: () => PillSend, o: PillOptions): PillRpcHandlers {
  const later = o.later ?? realLater;
  let shown: PillState = { state: "hidden" };
  /** The spoken dictation the pill follows, from its `dictation.started` on. */
  let current: string | null = null;
  /** The engine's notice for it (`best failed, used fast`). */
  let notice: string | null = null;
  let cancelHide: () => void = () => {};
  let cancelBusy: () => void = () => {};
  /** The dictation whose learn chip is up, and the timer that takes it down. */
  let chipUp: string | null = null;
  let cancelChip: () => void = () => {};
  /** The words of the last partial sent, to mark what the next one did not change. */
  let lastWords: string[] = [];
  /** The language the chip forced for the session listening, else null. */
  let forced: string | null = null;

  const visible = () => shown.state !== "hidden" || chipUp !== null;

  const put = (s: PillState) => {
    shown = s;
    send().state(s);
    o.onVisible(visible());
  };

  /** The chip of `id` is down; the window goes with it unless a state is showing. */
  const chipOver = (id: string) => {
    if (chipUp !== id) return;
    cancelChip();
    chipUp = null;
    o.onVisible(visible());
  };

  const hideAfter = (ms: number) => {
    cancelHide();
    cancelHide = later(ms, () => put({ state: "hidden" }));
  };

  const update = () => {
    const st = d.status();
    switch (st.state) {
      case "listening": {
        if (shown.state === "listening") return;
        cancelHide();
        current = null;
        notice = null;
        lastWords = [];
        forced = null;
        const keys: PillKey[] = st.swallow_keys === true ? [...SWALLOWED] : [];
        put({ state: "listening", since: o.now(), keys, hotkey: o.label(o.hotkey(), o.platform) });
        return;
      }
      case "transcribing":
      case "inserting":
        if (shown.state === "transcribing") return;
        put({
          state: "transcribing",
          since: o.now(),
          ...(st.loading ? { note: LOADING_NOTE } : {}),
        });
        return;
      case "idle":
        // An outcome stays for its time; anything else (empty, cancelled) hides now.
        if (shown.state === "done" || shown.state === "error") return;
        cancelHide();
        if (shown.state !== "hidden") put({ state: "hidden" });
        return;
      default:
        cancelHide();
        if (shown.state !== "hidden") put({ state: "hidden" });
    }
  };

  /** The chip on the listening island for `heard`, the language of the last partial. */
  const chipFor = (heard: string | null): PillLanguage | undefined => {
    const tag = forced ?? heard;
    if (!tag) return undefined;
    const switchable = d.languageChoice?.().switchable ?? false;
    return { tag, switchable, forced: forced !== null };
  };

  /** The listening island with its chip for `heard`, when that changes what the chip shows. */
  const showLanguage = (heard: string | null) => {
    if (shown.state !== "listening") return;
    const language = chipFor(heard ?? shown.language?.tag ?? null);
    const was = shown.language;
    if (
      was?.tag === language?.tag &&
      was?.switchable === language?.switchable &&
      was?.forced === language?.forced
    )
      return;
    const { language: _, ...rest } = shown;
    put(language ? { ...rest, language } : rest);
  };

  /** A partial's words to the ticker, as the preview's rule allows, with its settled start. */
  const sendPreview = (partial: unknown) => {
    if (shown.state !== "listening") return;
    const p = pillPreview(partial, { pillPreview: o.preview.setting() });
    if (!p) return;
    const words = p.text.split(/\s+/).filter(Boolean);
    const n = settledWords(lastWords, words);
    lastWords = words;
    send().preview({ text: words.join(" "), settled: words.slice(0, n).join(" ").length });
  };

  const unfollow = d.follow(
    (m) => {
      if (m.kind === "partial") {
        showLanguage(m.language);
        sendPreview(m.text);
        return;
      }
      if (m.kind === "level") {
        if (shown.state === "listening") send().level({ db: levelDb(m.rms) });
        return;
      }
      if (m.kind === "notice") {
        if (m.id === current) notice = m.notice;
        return;
      }
      if (m.kind === "warning") {
        // `1 minute left` before `dictation.maxMinutes` (DC-A3), under the hints until it ends.
        if (shown.state === "listening") put({ ...shown, note: m.note });
        return;
      }
      if (m.kind === "chip") {
        const c = m.chip;
        cancelChip();
        chipUp = c.id;
        send().chip(c);
        o.onVisible(true);
        cancelChip =
          c.mode === "learned"
            ? later(LEARNED_MS, () => chipOver(c.id))
            : later(CHIP_WAIT_MS, () => {
                void d.chip?.({ id: c.id, action: "ignore" });
                chipOver(c.id);
              });
        return;
      }
      if (m.kind === "busy") {
        const s = shown;
        if (s.state !== "transcribing") return;
        cancelBusy();
        put({ ...s, note: BUSY_NOTE });
        cancelBusy = later(BUSY_MS, () => {
          // Back to the line it had, unless the pill moved on meanwhile.
          if (shown.state === "transcribing" && shown.note === BUSY_NOTE) put(s);
        });
        return;
      }
      const e = m.e;
      if (e.type === "dictation.started") {
        // A clip from the API has no target: never the pill's.
        if (e.target !== null) {
          current = e.id;
          notice = null;
        }
        return;
      }
      if (e.id !== current) return;
      if (e.type === "dictation.inserted") {
        const copied = e.method === "clipboard";
        const note = copied ? pasteHint(o.platform) : notice;
        put({ state: "done", how: copied ? "copied" : "inserted", ...(note ? { note } : {}) });
        hideAfter(DONE_MS);
      } else if (e.type === "dictation.failed") {
        put({ state: "error", message: e.error, actions: [] });
        hideAfter(ERROR_MS);
      }
    },
    // The chip wants the language of every session, so partials are decoded while the pill exists.
    { partials: () => true },
  );

  /** The chip's click: the session listening moves to the next of the user's languages. */
  const nextLanguage = (): boolean => {
    if (shown.state !== "listening" || !d.setLanguage) return false;
    const c = d.languageChoice?.();
    if (!c?.switchable) return false;
    const at = c.languages.indexOf(shown.language?.tag ?? "");
    const next = c.languages[(at + 1) % c.languages.length];
    if (!next || !d.setLanguage(next)) return false;
    forced = next;
    showLanguage(null);
    return true;
  };

  return {
    handlers: {
      control: async ({ action }) => {
        if (action === "language") return nextLanguage();
        if (action !== "stop" && action !== "cancel") return false;
        return d.control(action);
      },
      chip: async (a: ChipAnswer) => {
        const ok = d.chip ? await d.chip(a) : false;
        if (a.id !== chipUp) return ok;
        // After Learn the Undo line stays for its time; any other answer takes the chip down.
        if (ok && a.action === "learn") {
          cancelChip();
          cancelChip = later(LEARNED_MS, () => chipOver(a.id));
        } else chipOver(a.id);
        return ok;
      },
      state: async () => shown,
    },
    update,
    preview: sendPreview,
    shown: () => shown,
    close: () => {
      cancelHide();
      cancelBusy();
      cancelChip();
      unfollow();
    },
  };
}
