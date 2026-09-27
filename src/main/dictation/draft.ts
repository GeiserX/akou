/**
 * The draft box's main side (docs/ux/DICTATION.md section 5.2, DC-S1, DC-L1, DC-L4): what opens it,
 * what its keys do, and the offer to learn a word the user fixed in it. Like `pill.ts`, no
 * ElectroBun import: the shell owns the window and hands it here as a `DraftWindow`.
 *
 * - **Opens.** Automatically when the focus guard refused an insert (DC-N9), without the keyboard,
 *   so keys meant for another window never land in it; deliberately from the API or the history
 *   page (`POST /v1/dictations/{id}/insert`), taking the keyboard. Fix (`fix: true`) opens the same
 *   box for teaching only: Enter learns and inserts nothing, so the app the dictation went into is
 *   left alone.
 * - **Enter** hides the box, has the helper bring the captured target forward and pastes there
 *   (DC-N9), pressing `dictation.sendKey` after the receipt for Ctrl/Cmd+Enter (DC-S2). A refused
 *   insert opens the box again with the user's text, without the keyboard. **Escape** writes
 *   `dictation.discarded` for a dictation that never reached the app; one already inserted keeps
 *   its state. **Copy** goes through the helper's clipboard-only insert. **Retry** decodes the kept
 *   audio again and shows the new reading in the box.
 * - **Learning.** On Enter, Ctrl/Cmd+Enter and Copy, the field is diffed against the text the box
 *   opened with (DC-L3). Each candidate is written `proposed`; the chip goes under the field only
 *   the first time a fix is seen and once more at its third time, never after Not a word (DC-L4).
 *   Learn writes a `scope: dictation` vocabulary entry and `accepted`; Not a word `rejected`;
 *   closing or the 8 s timeout `ignored`; Undo takes the entry back out. With `dictation.learn`
 *   `auto` the entries are written first and the chip only offers Undo; with `off` no candidate is
 *   computed. The audio check needs a local Qwen that takes a glossary (DC-L7), so today every
 *   candidate records `evidence: none`.
 */

import type { DictationItem, Target } from "../../core/dictation/events.ts";
import {
  type Candidate,
  learn,
  pairHistory,
  pairKey,
  shouldAsk,
} from "../../core/dictation/learn.ts";
import type { DraftOpen, DraftRpc, DraftWord } from "../../ui/dictation-protocol.ts";
import type { Chip, ChipAnswer } from "../../ui/pill-protocol.ts";
import type { SendKey } from "./protocol.ts";
import type { DictationSession } from "./session.ts";
import type { DictationLog } from "./store.ts";

type Requests = DraftRpc["bun"]["requests"];
type Handler<K extends keyof Requests> = (
  p: Requests[K]["params"],
) => Promise<Requests[K]["response"]>;

/** The draft box's window as the shell hands it over. */
export interface DraftWindow {
  /** Shows the page on `d`: taking the keyboard with `d.focus`, else without. */
  open(d: DraftOpen): void;
  chip(c: Chip): void;
  /** Shows the window again without the keyboard, for a chip after an insert. */
  showInactive(): void;
  hide(): void;
}

/** A new reading of a dictation's audio, as `DictationService.retry` answers it. */
export interface RetryReading {
  text: string;
  words: DictationItem["words"];
  engine: string;
  model: string | null;
  ms: number | null;
}

export interface DraftBoxOptions {
  log: DictationLog;
  platform: string;
  /** The session over the running helper, or null with dictation off. */
  session(): DictationSession | null;
  /** `dictation.sendKey`. */
  sendKey(): SendKey;
  /** `dictation.learn`: `off`, `ask` or `auto`. */
  learnMode(): string;
  /** The engines a retry can use, from the installed ones. */
  engines(): string[];
  retry(
    id: string,
    engine: string,
  ): Promise<{ ok: true; answer: RetryReading } | { ok: false; message: string }>;
  /** Reads the vocabulary: whether it maps `heard` to `term` already. */
  knownPairs?(): Promise<(heard: string, term: string) => boolean>;
  /** The dictionary check for a language: a pair of common words is never a mishearing. */
  commonWords?(language: string | null): ((word: string) => boolean) | undefined;
  /** Writes the `scope: dictation` entry for a learned pair (DC-L6). */
  learnEntry(p: { id: string; term: string; heard: string }): Promise<void>;
  /** Takes a learned pair back out (Undo). */
  unlearnEntry(p: { id: string; term: string; heard: string }): Promise<void>;
  /** The offer to learn from dictation `id` is over: its audio may go (DC-H2). */
  closeLearnWindow?(id: string): void;
  /** Runs `fn` after `ms`; returns the cancel. Tests pass their own. */
  later?(ms: number, fn: () => void): () => void;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
}

/** Why the box did not open. */
export type DraftOpenResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "no_text" | "no_target" | "no_draft_box"; message: string };

/** How long the box stays up after Learn: the chip's Undo line (`CHIP_UNDO_MS` of the page). */
export const LEARNED_MS = 6000;

/** The target of a dictation that went to no app: the helper's own word for "nothing known". */
const NO_TARGET: Target = { app: "", pid: 0, window: "", field: "unknown" };

interface Open {
  id: string;
  /** Teaching only: Enter learns and inserts nothing. */
  fix: boolean;
  /** The text the box opened with, which an edit is diffed against. */
  base: string;
  /** The words of `base` with their confidences, when the engine gave any. */
  words: DictationItem["words"];
  language: string | null;
  target: Target | null;
  /** Enter, Escape or a refused insert answered it; the box waits to be hidden or reopened. */
  answered: boolean;
}

interface PendingChip {
  candidates: Candidate[];
  /** The pairs written to the vocabulary, for Undo. */
  learned: Candidate[];
  /** Cancels the timer of its Undo line. */
  cancel: () => void;
}

const realLater = (ms: number, fn: () => void) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export class DraftBox {
  private win: DraftWindow | null = null;
  private cur: Open | null = null;
  private readonly chips = new Map<string, PendingChip>();
  /** Whether the window is up, so it is hidden once. */
  private up = false;
  readonly handlers: { [K in keyof Requests]: Handler<K> };

  constructor(private readonly o: DraftBoxOptions) {
    this.handlers = {
      insert: (p) => this.insert(p.id, p.text, p.send),
      discard: async (p) => this.discard(p.id),
      copy: (p) => this.copy(p.id, p.text),
      retry: (p) => this.retry(p.id, p.engine),
      chip: (a) => this.answer(a),
    };
  }

  /** The shell's window, or null when it closes. */
  attach(w: DraftWindow | null): void {
    this.win = w;
    this.up = false;
    if (!w) {
      this.cur = null;
      for (const p of this.chips.values()) p.cancel();
      this.chips.clear();
    }
  }

  available(): boolean {
    return this.win !== null;
  }

  /** The dictation the box holds, or null. */
  holding(): string | null {
    return this.cur && !this.cur.answered ? this.cur.id : null;
  }

  /**
   * Opens the box on dictation `id`: `focus` for a deliberate open, which takes the keyboard;
   * `fix` for teaching only; `text` for another reading of it (a retry's, from history) in place
   * of the one in the log.
   */
  open(id: string, o: { focus: boolean; fix?: boolean; text?: string }): DraftOpenResult {
    const w = this.win;
    if (!w)
      return { ok: false, code: "no_draft_box", message: "the draft box needs the desktop window" };
    const it = this.o.log.item(id);
    if (!it) return { ok: false, code: "not_found", message: `no dictation ${id}` };
    const base = o.text ?? it.text ?? "";
    if (base === "")
      return { ok: false, code: "no_text", message: `dictation ${id} has no text to show` };
    if (!o.fix && it.target === null) {
      return {
        ok: false,
        code: "no_target",
        message: `dictation ${id} was a clip sent to the API and went to no app: fix it instead`,
      };
    }
    this.show(w, it, {
      focus: o.focus,
      ...(o.fix ? { fix: true } : {}),
      base,
      words: o.text === undefined ? it.words : [],
    });
    return { ok: true };
  }

  private show(
    w: DraftWindow,
    it: DictationItem,
    o: {
      focus: boolean;
      fix?: boolean;
      text?: string;
      base: string;
      words: DictationItem["words"];
      engine?: string;
      ms?: number | null;
    },
  ): void {
    this.cur = {
      id: it.id,
      fix: o.fix === true,
      base: o.base,
      words: o.words,
      language: it.language,
      target: it.target,
      answered: false,
    };
    const engine = o.engine ?? it.engine;
    const model = o.engine ? null : it.model;
    const d: DraftOpen = {
      id: it.id,
      text: o.text ?? o.base,
      words: o.text === undefined ? o.words.map((x): DraftWord => ({ w: x.w, c: x.c })) : [],
      ...(it.target?.app ? { to: it.target.app } : {}),
      engine: model ? `${engine} (${model})` : engine,
      ms: o.ms ?? it.ms ?? 0,
      engines: this.o.engines(),
      focus: o.focus,
      platform: this.o.platform,
    };
    this.up = true;
    w.open(d);
  }

  private hide(): void {
    if (!this.up) return;
    this.up = false;
    this.win?.hide();
  }

  private async insert(id: string, text: string, send: boolean): Promise<boolean> {
    const c = this.cur;
    if (!c || c.id !== id || c.answered) return false;
    c.answered = true;
    const chip = await this.learnFrom(c, text);
    if (c.fix) {
      this.afterAnswer(chip);
      return true;
    }
    const s = this.o.session();
    if (!s || !c.target) {
      this.reopen(c, text, "dictation is off");
      return false;
    }
    // The keyboard goes back to the target, so the box steps aside first.
    this.hide();
    const r = await s.insertText(id, text, c.target, send ? this.o.sendKey() : "none");
    if (!r.ok) {
      this.reopen(c, text, r.reason);
      if (chip) this.win?.chip(chip);
      return false;
    }
    this.afterAnswer(chip);
    return true;
  }

  /** A refused insert: the box again with the user's text, never taking the keyboard. */
  private reopen(c: Open, text: string, reason: string): void {
    this.o.onLog?.("warn", `dictation ${c.id}: the draft's insert was refused (${reason})`);
    const w = this.win;
    const it = this.o.log.item(c.id);
    if (!w || !it) return;
    this.show(w, it, { focus: false, fix: c.fix, text, base: c.base, words: c.words });
  }

  private discard(id: string): boolean {
    const c = this.cur;
    if (!c || c.id !== id || c.answered) return false;
    c.answered = true;
    // Only a dictation that never reached the app is discarded; an inserted one stays inserted.
    if (this.o.log.item(id)?.state === "drafted") this.write({ type: "dictation.discarded", id });
    this.afterAnswer(null);
    return true;
  }

  private async copy(id: string, text: string): Promise<boolean> {
    const c = this.cur;
    if (!c || c.id !== id) return false;
    const chip = await this.learnFrom(c, text);
    if (chip) this.win?.chip(chip);
    const s = this.o.session();
    if (!s) return false;
    const r = await s.copyText(text, c.target ?? NO_TARGET);
    if (!r.ok) this.o.onLog?.("warn", `dictation ${id}: copy refused (${r.reason})`);
    return r.ok;
  }

  private async retry(id: string, engine: string): Promise<boolean> {
    const c = this.cur;
    const w = this.win;
    if (!c || c.id !== id || !w) return false;
    const r = await this.o.retry(id, engine);
    const it = this.o.log.item(id);
    if (!r.ok || !it || r.answer.text === "" || this.cur !== c) return false;
    const a = r.answer;
    this.show(w, it, {
      focus: true,
      fix: c.fix,
      base: a.text,
      words: a.words,
      engine: a.model ? `${a.engine} (${a.model})` : a.engine,
      ms: a.ms,
    });
    return true;
  }

  /**
   * The candidates of an edit (DC-L1, DC-L3): each written `proposed`, and the chip for those the
   * ask rule lets through; with `dictation.learn` `auto` those are learned at once.
   */
  private async learnFrom(c: Open, edited: string): Promise<Chip | null> {
    const mode = this.o.learnMode();
    if (mode === "off" || edited === c.base) return null;
    const learnt = this.o.log.events().filter((e) => e.type === "dictation.learn");
    const history = pairHistory(learnt);
    // A fix of this dictation already offered (Copy, then Enter; a refused insert, then Enter
    // again) is one correction, not another.
    const offered = new Set(
      learnt.filter((e) => e.id === c.id).map((e) => pairKey(e.heard, e.term)),
    );
    const rejected = (heard: string, term: string) =>
      history.get(pairKey(heard, term))?.rejected === true;
    let found: Candidate[];
    try {
      const common = this.o.commonWords?.(c.language);
      const known = await this.o.knownPairs?.();
      found = await learn(
        {
          inserted: c.base,
          edited,
          ...(c.words.length > 0 ? { words: c.words } : {}),
          language: c.language,
          ...(common ? { isCommonWord: common } : {}),
          ...(known ? { known } : {}),
          rejected,
        },
        null,
      );
    } catch (err) {
      this.o.onLog?.("warn", `dictation ${c.id}: no learning: ${(err as Error).message}`);
      return null;
    }
    found = found.filter((x) => !offered.has(pairKey(x.heard, x.term)));
    const ask = found.filter((x) => shouldAsk(history.get(pairKey(x.heard, x.term))));
    for (const x of found) this.learnEvent(c.id, x, "proposed");
    if (ask.length === 0) return null;
    const pending: PendingChip = { candidates: ask, learned: [], cancel: () => {} };
    // One chip per dictation: a newer edit of the same one replaces the question.
    this.chips.get(c.id)?.cancel();
    this.chips.set(c.id, pending);
    if (mode === "auto") {
      for (const x of ask) await this.accept(c.id, x, pending);
      if (pending.learned.length === 0) {
        this.chips.delete(c.id);
        return null;
      }
    }
    const shown = mode === "auto" ? pending.learned : ask;
    return {
      id: c.id,
      candidates: shown.map((x) => ({ term: x.term, heard: x.heard })),
      mode: mode === "auto" ? "learned" : "ask",
    };
  }

  private async accept(id: string, x: Candidate, p: PendingChip): Promise<void> {
    try {
      await this.o.learnEntry({ id, term: x.term, heard: x.heard });
    } catch (err) {
      this.o.onLog?.("warn", `dictation ${id}: "${x.term}" not learned: ${(err as Error).message}`);
      return;
    }
    p.learned.push(x);
    this.learnEvent(id, x, "accepted");
  }

  /** The chip's answer (DC-L4). */
  private async answer(a: ChipAnswer): Promise<boolean> {
    const p = this.chips.get(a.id);
    if (!p) return false;
    const ticked = (x: Candidate) => (a.terms ?? []).includes(x.term);
    switch (a.action) {
      case "learn":
        for (const x of p.candidates) {
          if (ticked(x)) await this.accept(a.id, x, p);
          else this.learnEvent(a.id, x, "ignored");
        }
        // The Undo line stays for its time.
        this.chipDone(a.id, p.learned.length > 0 ? LEARNED_MS : 0);
        return true;
      case "reject":
        for (const x of p.candidates) this.learnEvent(a.id, x, ticked(x) ? "rejected" : "ignored");
        this.chipDone(a.id, 0);
        return true;
      case "ignore":
        for (const x of p.candidates) this.learnEvent(a.id, x, "ignored");
        this.chipDone(a.id, 0);
        return true;
      case "undo":
        for (const x of p.learned.splice(0)) {
          try {
            await this.o.unlearnEntry({ id: a.id, term: x.term, heard: x.heard });
            this.learnEvent(a.id, x, "ignored");
          } catch (err) {
            this.o.onLog?.("warn", `dictation ${a.id}: undo failed: ${(err as Error).message}`);
          }
        }
        this.chipDone(a.id, 0);
        return true;
      default:
        return false;
    }
  }

  /**
   * The chip of `id` is over, now or once its Undo line has had `afterMs`: its learn window closes,
   * and the box goes once nothing is left in it.
   */
  private chipDone(id: string, afterMs: number): void {
    const p = this.chips.get(id);
    if (!p) return;
    p.cancel();
    if (afterMs > 0) {
      p.cancel = (this.o.later ?? realLater)(afterMs, () => this.chipDone(id, 0));
      return;
    }
    this.chips.delete(id);
    this.o.closeLearnWindow?.(id);
    this.settle();
  }

  /** The draft was answered: the box goes, or stays without the keyboard for the chip. */
  private afterAnswer(chip: Chip | null): void {
    const c = this.cur;
    if (chip && this.win) {
      if (!this.up) this.win.showInactive();
      this.up = true;
      this.win.chip(chip);
      // `auto`: nothing to answer but Undo, which has its time.
      if (chip.mode === "learned") this.chipDone(chip.id, LEARNED_MS);
      return;
    }
    if (c) this.o.closeLearnWindow?.(c.id);
    this.settle();
  }

  /** The box goes when no draft waits in it and no chip is up. */
  private settle(): void {
    if (this.chips.size > 0 || (this.cur !== null && !this.cur.answered)) return;
    this.cur = null;
    this.hide();
  }

  private learnEvent(
    id: string,
    x: Candidate,
    status: "proposed" | "accepted" | "rejected" | "ignored",
  ) {
    this.write({
      type: "dictation.learn",
      id,
      term: x.term,
      heard: x.heard,
      status,
      evidence: x.evidence,
    });
  }

  private write(d: Parameters<DictationLog["append"]>[0]): void {
    try {
      this.o.log.append(d);
    } catch (err) {
      this.o.onLog?.("error", `dictation log: ${(err as Error).message}`);
    }
  }
}
