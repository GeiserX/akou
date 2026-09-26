/**
 * The dictation pill's RPC with the main process (docs/ux/DICTATION.md section 5.1, DC-O1, DC-D2,
 * DC-L4). Types only; the main side (the window and its RPC handlers) is lane B's, not yet written.
 *
 * The pill never receives dictated text: no state below has a field for it, and the main side
 * rebuilds every message field by field, as the indicator's does, so a stray `text` never reaches
 * the page. The only words it shows are the learn chip's term and heard form, and an error's
 * message. The words-as-I-speak preview (DC-O2) is a later, separate field under DC-D2's rule.
 */

/** A key the backend swallows during a session (DC-A4), shown as a hint only when it does. */
export type PillKey = "escape" | "enter" | "shift-enter";

/** What the error state offers (DC-O1, DC-R3). */
export type PillAction = "retry" | "copy" | "open-draft";

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
    }
  | { state: "transcribing"; since: number; note?: string }
  | {
      state: "done";
      how: "inserted" | "copied";
      /** `press ⌘V` after a clipboard-only insert; `best failed, used fast` after a fallback. */
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

export interface PillRpc {
  bun: {
    requests: {
      /** Stop and Cancel while listening; Retry, Copy and Open draft on an error. */
      control: { params: { action: "stop" | "cancel" | PillAction }; response: boolean };
      chip: { params: ChipAnswer; response: boolean };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      state: PillState;
      /** The mic level in dBFS, -60 to 0, about 20 a second while listening. */
      level: { db: number };
      chip: Chip;
    };
  };
}
