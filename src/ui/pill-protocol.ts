/**
 * The dictation pill's RPC with the main process (docs/ux/DICTATION.md section 5.1, DC-O1, DC-D2,
 * DC-L4). Types only; the main side is `src/main/window/pill.ts`.
 *
 * The pill never receives dictated text: no state below has a field for it, and the main side
 * rebuilds every message field by field, as the indicator's does, so a stray `text` never reaches
 * the page. The only words it shows are the learn chip's term and heard form, an error's message,
 * and the words-as-I-speak preview (DC-O2), a message of its own that the main side sends only
 * when `pillPreview` below lets it (DC-D2). The language chip carries a language tag, never words.
 */

/** A key the backend swallows during a session (DC-A4), shown as a hint only when it does. */
export type PillKey = "escape" | "enter" | "shift-enter";

/** What the error state offers (DC-O1, DC-R3). */
export type PillAction = "retry" | "copy" | "open-draft";

/**
 * The language chip on the listening island (akou-5v8): the language the session is heard in, a
 * BCP-47 tag, as the engine found it or as the chip forced it. `switchable`: a click moves the
 * session to the next of the user's languages (the engine takes a forced one); otherwise it only
 * says what was heard (`fast` picks its own, DC-E4).
 */
export interface PillLanguage {
  tag: string;
  switchable: boolean;
  forced: boolean;
}

export type PillState =
  | { state: "hidden" }
  | {
      state: "listening";
      /** When audio started arriving, epoch ms: the elapsed time counts from here. */
      since: number;
      /** The keys the backend can honour; empty on the portal and the CLI. */
      keys: PillKey[];
      /** The dictation key's label (`Right ⌘`), for the one hint every backend has. */
      hotkey: string;
      /** A one-line notice under the hints (`still transcribing`, `1 minute left`). */
      note?: string;
      /** The language chip, once the session's language is known. */
      language?: PillLanguage;
    }
  | { state: "transcribing"; since: number; note?: string }
  | {
      state: "done";
      how: "inserted" | "copied";
      /** The paste key (`⌘V`, `Ctrl+V`) after a clipboard-only insert; `best failed, used fast` after a fallback. */
      note?: string;
    }
  | {
      state: "error";
      message: string;
      actions: PillAction[];
      /** The Retry button's words, `Retry locally` after a remote failure. */
      retryLabel?: string;
    };

/** One candidate of the learn chip (DC-L4). */
export interface ChipCandidate {
  term: string;
  heard: string;
}

/** The learn chip: at most one per dictation, every candidate of that dictation. */
export interface Chip {
  /** The dictation it belongs to. */
  id: string;
  candidates: ChipCandidate[];
  /** `learned`: `dictation.learn` is `auto`, the entries are written already and only Undo is left. */
  mode: "ask" | "learned";
}

/** What the user did with a chip. `terms`: the candidates ticked, for Learn. */
export interface ChipAnswer {
  id: string;
  action: "learn" | "reject" | "ignore" | "undo";
  terms?: string[];
}

/**
 * The preview the main side may send for a partial (DC-O2 under DC-D2's rule): its words when
 * `dictation.pillPreview` is on, otherwise null, and then nothing is sent. The main side passes
 * every partial through this, as `indicatorStatus` cuts the indicator's status, so with the preview
 * off no message to the pill carries dictated text.
 */
export function pillPreview(
  partial: unknown,
  rule: { pillPreview: unknown },
): { text: string } | null {
  if (rule.pillPreview !== true) return null;
  return typeof partial === "string" && partial.trim() !== "" ? { text: partial } : null;
}

export interface PillRpc {
  bun: {
    requests: {
      /**
       * Stop and Cancel while listening, and the language chip's click; Retry, Copy and Open
       * draft on an error.
       */
      control: {
        params: { action: "stop" | "cancel" | "language" | PillAction };
        response: boolean;
      };
      chip: { params: ChipAnswer; response: boolean };
      /**
       * The state now, pulled once the page has booted: a message sent while it was still loading
       * is lost, and the window is created hidden before the first session.
       */
      state: { params: Record<string, never>; response: PillState };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      state: PillState;
      /** The mic level in dBFS, -60 to 0, about 20 a second while listening. */
      level: { db: number };
      /**
       * The words recognised so far while listening, only as `pillPreview` allows (DC-O2).
       * `settled`: how many characters at the start the last partial had too; the rest may still
       * change.
       */
      preview: { text: string; settled?: number };
      chip: Chip;
    };
  };
}
