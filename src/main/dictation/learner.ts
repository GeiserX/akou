/**
 * The offer to learn a word the user fixed (docs/ux/DICTATION.md DC-L3, DC-L4), shared by the two
 * places a fix is seen: the draft box (DC-L1) and the app's own field after a direct insert
 * (DC-L2). Each owns one `Learner`, and its chips are answered through it.
 *
 * An edit's candidates (DC-L3) are each written `proposed`; the chip holds those the ask rule lets
 * through: the first time a fix is seen and once more at its third time, never after Not a word.
 * Learn writes a `scope: dictation` vocabulary entry and `accepted`; Not a word `rejected`; closing
 * or the 8 s timeout `ignored`; Undo takes the entry back out. With `dictation.learn` `auto` the
 * entries are written first and the chip only offers Undo; with `off` no candidate is computed. The
 * audio check runs on the dictation's kept audio when a local Qwen is warm for it (`recheck`);
 * otherwise the candidate records `evidence: none`.
 */

import type { DictationItem } from "../../core/dictation/events.ts";
import {
  type Candidate,
  learn,
  pairHistory,
  pairKey,
  type Redecode,
  shouldAsk,
} from "../../core/dictation/learn.ts";
import type { Chip, ChipAnswer } from "../../ui/pill-protocol.ts";
import type { DictationLog } from "./store.ts";

/** How long a chip stays after Learn: the chip's Undo line (`CHIP_UNDO_MS` of the page). */
export const LEARNED_MS = 6000;

export interface LearnerOptions {
  log: DictationLog;
  /** `dictation.learn`: `off`, `ask` or `auto`. */
  learnMode(): string;
  /** Reads the vocabulary: whether it maps `heard` to `term` already. */
  knownPairs?(): Promise<(heard: string, term: string) => boolean>;
  /** The dictionary check for a language: a pair of common words is never a mishearing. */
  commonWords?(language: string | null): ((word: string) => boolean) | undefined;
  /** Writes the `scope: dictation` entry for a learned pair (DC-L6). */
  learnEntry(p: { id: string; term: string; heard: string }): Promise<void>;
  /** Takes a learned pair back out (Undo). */
  unlearnEntry(p: { id: string; term: string; heard: string }): Promise<void>;
  /** DC-L3's audio check on dictation `id`'s kept audio, or null when it cannot run. */
  recheck?(id: string): Redecode | null;
  /** The chip of dictation `id` is over (answered, timed out or released). */
  onDone?(id: string): void;
  /** Runs `fn` after `ms`; returns the cancel. Tests pass their own. */
  later?(ms: number, fn: () => void): () => void;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
}

/** One edit of a dictation, as the learner reads it. */
export interface LearnFrom {
  id: string;
  /** The text the user saw before fixing it. */
  base: string;
  /** The text after the fix. */
  edited: string;
  /** The words of `base` with their confidences, when the engine gave any. */
  words: DictationItem["words"];
  language: string | null;
}

interface PendingChip {
  candidates: Candidate[];
  /** The pairs written to the vocabulary, for Undo. */
  learned: Candidate[];
  /** Cancels the timer of its Undo line. */
  cancel: () => void;
}

const realLater = (ms: number, fn: () => void) => {
  // clock: the real timer behind the injected `later`; tests pass their own.
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/**
 * What a learn or undo failure puts in the app log: the error's code or name, never its message.
 * Those messages quote the dictated word and its heard form, and the app log never holds what the
 * user dictated.
 */
export function failure(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown } | null;
  if (typeof e?.code === "string") return e.code;
  return typeof e?.name === "string" ? e.name : "error";
}

export class Learner {
  private readonly chips = new Map<string, PendingChip>();

  constructor(private readonly o: LearnerOptions) {}

  /** Whether dictation `id` has a chip up. */
  has(id: string): boolean {
    return this.chips.has(id);
  }

  /** How many chips are up. */
  get size(): number {
    return this.chips.size;
  }

  /** Every chip is dropped with nothing written (the window it was in closed). */
  clear(): void {
    for (const p of this.chips.values()) p.cancel();
    this.chips.clear();
  }

  /**
   * The candidates of an edit (DC-L1, DC-L2, DC-L3): each written `proposed`, and the chip for
   * those the ask rule lets through; with `dictation.learn` `auto` those are learned at once. Null
   * when there is nothing to put to the user.
   */
  async offer(c: LearnFrom): Promise<Chip | null> {
    const mode = this.o.learnMode();
    if (mode === "off" || c.edited === c.base) return null;
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
          edited: c.edited,
          ...(c.words.length > 0 ? { words: c.words } : {}),
          language: c.language,
          ...(common ? { isCommonWord: common } : {}),
          ...(known ? { known } : {}),
          rejected,
        },
        this.o.recheck?.(c.id) ?? null,
      );
    } catch (err) {
      this.o.onLog?.("warn", `dictation ${c.id}: no learning (${failure(err)})`);
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

  /** A chip went up: `learned` has nothing to answer but Undo, which has its time. */
  shown(chip: Chip): void {
    if (chip.mode === "learned") this.done(chip.id, LEARNED_MS);
  }

  /**
   * The chip of `id` will never be seen (no pill to show it in): it is over with nothing written,
   * so its `proposed` pairs wait in the words to review (DC-O4, DC-L5).
   */
  release(id: string): void {
    this.done(id, 0);
  }

  private async accept(id: string, x: Candidate, p: PendingChip): Promise<void> {
    try {
      await this.o.learnEntry({ id, term: x.term, heard: x.heard });
    } catch (err) {
      this.o.onLog?.("warn", `dictation ${id}: a word was not learned (${failure(err)})`);
      return;
    }
    p.learned.push(x);
    this.learnEvent(id, x, "accepted");
  }

  /** The chip's answer (DC-L4). */
  async answer(a: ChipAnswer): Promise<boolean> {
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
        this.done(a.id, p.learned.length > 0 ? LEARNED_MS : 0);
        return true;
      case "reject":
        for (const x of p.candidates) this.learnEvent(a.id, x, ticked(x) ? "rejected" : "ignored");
        this.done(a.id, 0);
        return true;
      case "ignore":
        for (const x of p.candidates) this.learnEvent(a.id, x, "ignored");
        this.done(a.id, 0);
        return true;
      case "undo":
        for (const x of p.learned.splice(0)) {
          try {
            await this.o.unlearnEntry({ id: a.id, term: x.term, heard: x.heard });
            this.learnEvent(a.id, x, "ignored");
          } catch (err) {
            this.o.onLog?.("warn", `dictation ${a.id}: undo failed (${failure(err)})`);
          }
        }
        this.done(a.id, 0);
        return true;
      default:
        return false;
    }
  }

  /** The chip of `id` is over, now or once its Undo line has had `afterMs`. */
  private done(id: string, afterMs: number): void {
    const p = this.chips.get(id);
    if (!p) return;
    p.cancel();
    if (afterMs > 0) {
      p.cancel = (this.o.later ?? realLater)(afterMs, () => this.done(id, 0));
      return;
    }
    this.chips.delete(id);
    this.o.onDone?.(id);
  }

  private learnEvent(
    id: string,
    x: Candidate,
    status: "proposed" | "accepted" | "rejected" | "ignored",
  ): void {
    try {
      this.o.log.append({
        type: "dictation.learn",
        id,
        term: x.term,
        heard: x.heard,
        status,
        evidence: x.evidence,
      });
    } catch (err) {
      this.o.onLog?.("error", `dictation log: ${(err as Error).message}`);
    }
  }
}
