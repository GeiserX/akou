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
 * With the preview on the pill asks the session for partials (DC-E5): their words go to the ticker,
 * with the part that did not change since the last partial marked as settled. The chip on the
 * listening island (akou-5v8) is up from the start when the engine takes a forced language: it
 * shows `dictation.language`, or `auto` while the engine chooses, and a click moves the session to
 * the next of the user's languages. A partial that names its language shows it; Parakeet's name
 * none, so on `fast` the chip stays down. A session started with a language (`akou dictate start
 * --language`) shows it as chosen from the start.
 *
 * - `listening` from the session's state, with the hints the key source can honour (DC-A4):
 *   Escape, Enter and Shift+Enter where it swallows keys; only the dictation key's on the portal
 *   and the CLI, where no other key does anything in a session. `1 minute left` under them one
 *   minute before `dictation.maxMinutes` (DC-A3).
 * - `transcribing` while the engine decodes and the helper inserts, `loading model` under it when
 *   the engine was still loading at the release, and `still transcribing` for `BUSY_MS` when the
 *   dictation key is pressed then (the helper refuses the press, DC-A4).
 * - `inserted` or `copied` for `DONE_MS` after the helper's receipt, with the engine's notice
 *   (`best failed, used fast`) or, after a clipboard-only insert, the paste hint, and the language
 *   the engine heard or was told when the user speaks two or more (akou-5v8), read-only.
 * - `error` with the log's message for `ERROR_MS`, or `NOTICE_MS` when it has buttons, so they can be
 *   reached (DC-O1, DC-R3): Retry where the dictation's audio is kept (`Retry locally` after a
 *   remote failure), which decodes it again and opens the draft box on the new reading; Copy and
 *   Open draft where it has text. Nothing is inserted from the pill: the draft box's Enter does it,
 *   into the app captured when the session began.
 * - hidden otherwise: an empty or cancelled dictation, dictation off, the helper starting.
 * - `notice` for `NOTICE_MS` when the dictation key does nothing (macOS): the helper lost the
 *   Accessibility grant (DC-N1), with a button to its pane, shown once the island is free, so a
 *   session keeps its Stop and its outcome; or Secure Input turned on while the key is a keyed
 *   chord, which the OS then keeps from the tap (DC-A2), at most once per `SECURE_REPEAT_MS`, and
 *   only with nothing else showing. Secure Input off takes it down.
 * - the learn chip (DC-L4) for a fix made in the app's field after a direct insert (DC-L2): shown
 *   with the window, whatever the state, until it is answered, and after Learn for its Undo line;
 *   a page that never answers is taken as ignoring it after `CHIP_WAIT_MS`. The chip carries only
 *   the fixed word and its heard form, the words DC-D2 lets it show.
 *
 * Only the spoken session's dictations count: a clip sent to `POST /v1/dictations` has no target
 * and never shows here.
 */

import { parseBinding } from "../../core/dictation/activation.ts";
import type {
  ChipAnswer,
  PillKey,
  PillLanguage,
  PillRpc,
  PillState,
} from "../../ui/pill-protocol.ts";
import { pillPreview } from "../../ui/pill-protocol.ts";
import { LEARNED_MS } from "../dictation/learner.ts";
import type { DictationFollow, ErrorAction } from "../dictation/service.ts";

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
  status(): {
    state: string;
    loading: boolean;
    swallow_keys: boolean | null;
    /** The grants the running helper lost (DC-N1); absent, none. */
    lost?: readonly string[];
  };
  /**
   * The log's events, the mic level and the engine's notices, from now on; the session's partials
   * while `partials` answers true (DC-E5).
   */
  follow(fn: (m: DictationFollow) => void, o?: { partials?: () => boolean }): () => void;
  /** Stop and Cancel, the same session door as `POST /v1/dictation/stop` and `/cancel`. */
  control(action: "stop" | "cancel"): Promise<boolean>;
  /**
   * The languages the chip moves between, whether the engine takes a forced one, and the one a
   * session asks for before a click: `dictation.language`, else null (akou-5v8).
   */
  languageChoice?(): {
    languages: readonly string[];
    switchable: boolean;
    language?: string | null;
    /** The language chosen for the session listening (the door's start), else null. */
    chosen?: string | null;
  };
  /** Forces a language for the session listening; false with none listening. */
  setLanguage?(language: string): boolean;
  /** The answer to a learn chip the pill showed (DC-L4); absent, no chip is answered. */
  chip?(a: ChipAnswer): Promise<boolean>;
  /**
   * What a failed dictation offers (DC-O1, DC-R3): `retry` where its audio is kept, `copy` and
   * `open-draft` where it has text; `retryLabel` names a retry that runs locally after the remote.
   */
  errorActions?(id: string): { actions: ErrorAction[]; retryLabel?: string };
  /** One of those buttons, for dictation `id`: true when it did what it says. */
  errorAction?(id: string, action: ErrorAction): Promise<boolean>;
}

const ERROR_ACTIONS: readonly string[] = ["retry", "copy", "open-draft"];

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
  /** Opens the Accessibility pane: the notice's button after the grant was lost (DC-N1). */
  grant?(): Promise<boolean>;
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

/** How long a notice stays: long enough to reach its button. */
export const NOTICE_MS = 10_000;
/**
 * A Secure Input notice comes back at most this often: a terminal with secure entry turns Secure
 * Input on each time it comes to the front.
 */
export const SECURE_REPEAT_MS = 10 * 60_000;

/** A binding with a key that is not a modifier: the kind Secure Input keeps from the tap (DC-A2). */
export function keyedChord(binding: string): boolean {
  try {
    return parseBinding(binding).kind === "chord";
  } catch {
    return false;
  }
}

/** How long `inserted` or `copied` stays before the pill hides (DC-O1). */
export const DONE_MS = 1500;
/** How long an error with no button stays; one with buttons stays `NOTICE_MS`. */
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
/** The chip's tag while the engine chooses the language and no partial has named one. */
export const AUTO_LANGUAGE = "auto";

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
  /** The dictation whose error the island shows, for its buttons. */
  let failed: string | null = null;
  /** The language the current dictation's text was decoded in, from its `dictation.text`. */
  let heard: string | null = null;
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
  /** When the last Secure Input notice showed. */
  let secureAt = Number.NEGATIVE_INFINITY;
  /**
   * The grant was lost while the island showed something else (DC-N1): a session's island keeps
   * its Stop, the only way out of a latched session with a dead tap, and its outcome its time. The
   * notice shows when the island would hide, if the grant is still lost then.
   */
  let grantPending = false;

  const visible = () => shown.state !== "hidden" || chipUp !== null;

  const put = (s: PillState) => {
    if (s.state === "hidden" && grantPending) {
      grantPending = false;
      if (d.status().lost?.includes("accessibility") ?? true) {
        showNotice("grant-lost");
        return;
      }
    }
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
        heard = null;
        forced = d.languageChoice?.()?.chosen ?? null;
        const keys: PillKey[] = st.swallow_keys === true ? [...SWALLOWED] : [];
        const language = chipFor(null);
        put({
          state: "listening",
          since: o.now(),
          keys,
          hotkey: o.label(o.hotkey(), o.platform),
          ...(language ? { language } : {}),
        });
        return;
      }
      case "transcribing":
      case "inserting":
        if (shown.state === "transcribing") return;
        // Whatever was due to hide the island must not hide the session's.
        cancelHide();
        put({
          state: "transcribing",
          since: o.now(),
          ...(st.loading ? { note: LOADING_NOTE } : {}),
        });
        return;
      case "idle":
        // An outcome or a notice stays for its time; anything else (empty, cancelled) hides now.
        if (shown.state === "done" || shown.state === "error" || shown.state === "notice") return;
        cancelHide();
        if (shown.state !== "hidden") put({ state: "hidden" });
        return;
      default:
        cancelHide();
        if (shown.state !== "hidden") put({ state: "hidden" });
    }
  };

  /**
   * The chip on the listening island for `heard`, the language of the last partial. An engine that
   * takes a forced language has it from the start: the session's own until a partial names one.
   */
  const chipFor = (heard: string | null): PillLanguage | undefined => {
    const c = d.languageChoice?.();
    const switchable = c?.switchable ?? false;
    const tag = forced ?? heard ?? (switchable ? (c?.language ?? AUTO_LANGUAGE) : null);
    if (!tag) return undefined;
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

  /** Says why the dictation key does nothing now, for `NOTICE_MS`. */
  const showNotice = (reason: "grant-lost" | "secure-input") => {
    const key = o.label(o.hotkey(), o.platform);
    put(
      reason === "grant-lost"
        ? {
            state: "notice",
            reason,
            message: `${key} does nothing without Accessibility`,
            detail:
              "macOS took the grant back. Turn akou on under Accessibility and dictation starts again.",
            actions: o.grant ? ["grant"] : [],
          }
        : {
            state: "notice",
            reason,
            message: `${key} cannot reach akou while Secure Input is on`,
            detail:
              "A password field or a terminal’s secure entry holds the keyboard. A key alone, such as Right ⌘, still works.",
            actions: [],
          },
    );
    hideAfter(NOTICE_MS);
  };

  /** Secure Input changed: a keyed chord is dead while it is on (DC-A2). */
  const secureInput = (on: boolean) => {
    if (!on) {
      if (shown.state === "notice" && shown.reason === "secure-input") {
        cancelHide();
        put({ state: "hidden" });
      }
      return;
    }
    // Only when it matters (a keyed chord), with nothing else on the island, and not every time.
    if (
      o.platform !== "darwin" ||
      !keyedChord(o.hotkey()) ||
      shown.state !== "hidden" ||
      chipUp !== null
    )
      return;

    if (o.now() - secureAt < SECURE_REPEAT_MS) return;
    secureAt = o.now();
    showNotice("secure-input");
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
      if (m.kind === "grant-lost") {
        // The words and the pane are macOS's; elsewhere the Dictation page says it.
        if (m.name !== "accessibility" || o.platform !== "darwin") return;
        if (shown.state === "hidden" || shown.state === "notice") showNotice("grant-lost");
        else grantPending = true;
        return;
      }
      if (m.kind === "secure-input") {
        secureInput(m.on);
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
      if (e.type === "dictation.text") heard = e.language;
      else if (e.type === "dictation.inserted") {
        const copied = e.method === "clipboard";
        const note = copied ? pasteHint(o.platform) : notice;
        // Which of the user's languages it went in as; with one language there is nothing to say.
        const language = heard && (d.languageChoice?.()?.languages.length ?? 0) >= 2 ? heard : null;
        put({
          state: "done",
          how: copied ? "copied" : "inserted",
          ...(note ? { note } : {}),
          ...(language ? { language } : {}),
        });
        hideAfter(DONE_MS);
      } else if (e.type === "dictation.failed") {
        const a = d.errorActions?.(e.id) ?? { actions: [] };
        failed = e.id;
        put({
          state: "error",
          message: e.error,
          actions: a.actions,
          ...(a.retryLabel ? { retryLabel: a.retryLabel } : {}),
        });
        hideAfter(a.actions.length > 0 ? NOTICE_MS : ERROR_MS);
      }
    },
    // Partials are decoded only for the ticker: Parakeet's carry no language for the chip.
    { partials: () => o.preview.setting() === true },
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

  /**
   * An error's button: the island steps aside (Retry shows `transcribing` while it decodes) and
   * comes back with the error if the button could not do it.
   */
  const onError = async (action: ErrorAction): Promise<boolean> => {
    const was = shown;
    const id = failed;
    if (was.state !== "error" || !id || !was.actions.includes(action) || !d.errorAction)
      return false;
    cancelHide();
    let mine: PillState = was;
    if (action === "retry") {
      mine = { state: "transcribing", since: o.now() };
      put(mine);
    }
    const ok = await d.errorAction(id, action);
    // A new session took the island meanwhile: it is that one's now.
    if (shown !== mine) return ok;
    if (!ok) {
      put(was);
      hideAfter(NOTICE_MS);
    } else if (action === "copy") {
      put({ state: "done", how: "copied", note: pasteHint(o.platform) });
      hideAfter(DONE_MS);
    } else put({ state: "hidden" });
    return ok;
  };

  return {
    handlers: {
      control: async ({ action }) => {
        if (action === "language") return nextLanguage();
        if (ERROR_ACTIONS.includes(action)) return onError(action as ErrorAction);
        if (action === "grant") {
          if (shown.state !== "notice" || shown.reason !== "grant-lost" || !o.grant) return false;
          cancelHide();
          put({ state: "hidden" });
          return o.grant();
        }
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
