/**
 * The draft box's RPC with the main process (docs/ux/DICTATION.md section 5.2, DC-S1). Types only;
 * the main side opens the window and answers these requests.
 *
 * The main side opens the box `showInactive` for an automatic open (the focus guard, a remote that
 * is down) and says so with `focus: false`: the page then leaves the keyboard where it is, and a
 * click moves it into the box. A deliberate open (the draft key, Shift+Enter, Fix) says
 * `focus: true` and the page puts the caret in the field.
 */

import type { Chip, ChipAnswer } from "./pill-protocol.ts";

/** One recognised word, with its confidence (0 to 1) where the engine gives one. */
export interface DraftWord {
  w: string;
  c?: number;
  /** What the other engine heard here, when two ran. */
  alt?: string[];
}

export interface DraftOpen {
  /** The dictation. */
  id: string;
  text: string;
  /** The engine's words; empty or absent when it gives no confidences (the remote, today). */
  words?: DraftWord[];
  /** The app the text goes to, captured when the session began. */
  to?: string;
  /** The engine that ran, as the user reads it (`fast (Parakeet)`), and how long it took. */
  engine: string;
  ms: number;
  /** It ran on this machine rather than a remote akou. */
  local?: boolean;
  /** The length of the dictated audio in seconds, when known. */
  seconds?: number;
  /** The language the engine heard or was told (`es`), when known. */
  language?: string;
  /**
   * A click on the language chip decodes the same audio again in the next of the user's languages
   * (akou-5v8): there are two or more, and an engine that takes a forced language can run.
   */
  languageSwitch?: boolean;
  /** The chip chose the language, rather than the engine hearing it. */
  languageForced?: boolean;
  /** The engines a retry can use (`best`, `remote`), from the installed ones. */
  engines: string[];
  /** A deliberate open takes the keyboard; an automatic one never does. */
  focus: boolean;
  /** The machine's OS, from the main process: Cmd+Enter sends on macOS, Ctrl+Enter elsewhere. */
  platform: string;
  /** A per-app rule's `draft-send` (DC-U9): Enter inserts and presses the send key. */
  enterSends?: boolean;
}

export interface DraftRpc {
  bun: {
    requests: {
      /** Enter (`send: false`) or Ctrl/Cmd+Enter (`send: true`): insert where the session began. */
      insert: { params: { id: string; text: string; send: boolean }; response: boolean };
      /** Escape or the close: the text stays in history as `discarded`. */
      discard: { params: { id: string }; response: boolean };
      copy: { params: { id: string; text: string }; response: boolean };
      /** Decode the same audio again; the answer comes back as a new `open`. */
      retry: { params: { id: string; engine: string }; response: boolean };
      /**
       * The language chip's click: decode the same audio again forced into the next of the user's
       * languages; the answer comes back as a new `open`.
       */
      language: { params: { id: string }; response: boolean };
      chip: { params: ChipAnswer; response: boolean };
      /**
       * The box's window took or lost the keyboard: while it has it, a dictation is appended to
       * the field instead of inserted (DC-A4).
       */
      focused: { params: { on: boolean }; response: boolean };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: Record<string, never>;
    /** `append`: a dictation made while the box had the keyboard goes at the end of its field. */
    messages: { open: DraftOpen; chip: Chip; append: { text: string } };
  };
}
