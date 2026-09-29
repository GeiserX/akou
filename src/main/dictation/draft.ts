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
 * - **Per-app rules** (DC-U9) open it too, taking the keyboard, for an app whose rule has `mode`
 *   `draft` or `draft-send`; with `draft-send` Enter presses the send key as Ctrl/Cmd+Enter does,
 *   and the rule's `sendKey` stands in for `dictation.sendKey`.
 * - **Enter** hides the box, has the helper bring the captured target forward and pastes there
 *   (DC-N9), pressing `dictation.sendKey` after the receipt for Ctrl/Cmd+Enter (DC-S2). A refused
 *   insert opens the box again with the user's text, without the keyboard. **Escape** writes
 *   `dictation.discarded` for a dictation that never reached the app; one already inserted keeps
 *   its state. **Copy** goes through the helper's clipboard-only insert. **Retry** decodes the kept
 *   audio again and shows the new reading in the box.
 * - **The language chip** (akou-5v8) says the reading's language. With two or more of the user's
 *   languages and an engine that takes a forced one, a click decodes the kept audio again forced
 *   into the next of them, on the reading's own engine when it takes one (`best`, `remote`), else
 *   the first installed engine that does; the new reading replaces the text in the box.
 * - **Learning.** On Enter, Ctrl/Cmd+Enter and Copy, the field is diffed against the text the box
 *   opened with (DC-L3). Each candidate is written `proposed`; the chip goes under the field only
 *   the first time a fix is seen and once more at its third time, never after Not a word (DC-L4).
 *   Learn writes a `scope: dictation` vocabulary entry and `accepted`; Not a word `rejected`;
 *   closing or the 8 s timeout `ignored`; Undo takes the entry back out. With `dictation.learn`
 *   `auto` the entries are written first and the chip only offers Undo; with `off` no candidate is
 *   computed. The audio check (DC-L3) runs on the dictation's kept audio when a local Qwen is warm
 *   for it (`recheck`); otherwise the candidate records `evidence: none`. Learning runs beside the
 *   insert, never in front of it: the chip comes once both are done.
 */

import type { DictationItem, Target } from "../../core/dictation/events.ts";
import type { Redecode } from "../../core/dictation/learn.ts";
import type { DraftOpen, DraftRpc, DraftWord } from "../../ui/dictation-protocol.ts";
import type { Chip } from "../../ui/pill-protocol.ts";
import { forcesLanguage } from "./engines.ts";
import { Learner } from "./learner.ts";
import type { SendKey } from "./protocol.ts";
import type { DictationSession, DraftRule } from "./session.ts";
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
  /** The language the engine heard or was forced into, when it names one. */
  language?: string | null;
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
  /** The user's languages the chip moves between: `dictation.languages`, else `asr.languages`. */
  languages?(): readonly string[];
  /** Decodes the kept audio again on `engine`, forced into `language` when one is given. */
  retry(
    id: string,
    engine: string,
    language?: string,
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
  /**
   * DC-L3's audio check on dictation `id`'s kept audio, or null when it cannot run (no local Qwen
   * warm for it, or no audio kept): the candidate then records `evidence: none`.
   */
  recheck?(id: string): Redecode | null;
  /** Runs `fn` after `ms`; returns the cancel. Tests pass their own. */
  later?(ms: number, fn: () => void): () => void;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
}

/** Why the box did not open. */
export type DraftOpenResult =
  | { ok: true }
  | { ok: false; code: "not_found" | "no_text" | "no_target" | "no_draft_box"; message: string };

/** How long the box stays up after Learn: the chip's Undo line (`CHIP_UNDO_MS` of the page). */
export { LEARNED_MS } from "./learner.ts";

/** The target of a dictation that went to no app: the helper's own word for "nothing known". */
export const NO_TARGET: Target = { app: "", pid: 0, window: "", field: "unknown" };

interface Open {
  id: string;
  /** Teaching only: Enter learns and inserts nothing. */
  fix: boolean;
  /** The text the box opened with, which an edit is diffed against. */
  base: string;
  /** The words of `base` with their confidences, when the engine gave any. */
  words: DictationItem["words"];
  language: string | null;
  /** The engine of the reading shown (`best`), which a language switch decodes on when it can. */
  engine: string;
  /** The language chip chose `language`. */
  forced: boolean;
  target: Target | null;
  /** Enter, Escape or a refused insert answered it; the box waits to be hidden or reopened. */
  answered: boolean;
  /** The per-app rule that opened it (DC-U9), or null. */
  rule: DraftRule | null;
}

export class DraftBox {
  private win: DraftWindow | null = null;
  private cur: Open | null = null;
  /** The offer to learn from an edit in the box (DC-L1, DC-L4). */
  private readonly learner: Learner;
  /** Whether the window is up, so it is hidden once. */
  private up = false;
  readonly handlers: { [K in keyof Requests]: Handler<K> };

  constructor(private readonly o: DraftBoxOptions) {
    this.learner = new Learner({
      log: o.log,
      learnMode: o.learnMode,
      ...(o.knownPairs ? { knownPairs: o.knownPairs } : {}),
      ...(o.commonWords ? { commonWords: o.commonWords } : {}),
      learnEntry: o.learnEntry,
      unlearnEntry: o.unlearnEntry,
      ...(o.recheck ? { recheck: o.recheck } : {}),
      // A chip over: its learn window closes, and the box goes once nothing is left in it.
      onDone: (id) => {
        this.o.closeLearnWindow?.(id);
        this.settle();
      },
      ...(o.later ? { later: o.later } : {}),
      ...(o.onLog ? { onLog: o.onLog } : {}),
    });
    this.handlers = {
      insert: (p) => this.insert(p.id, p.text, p.send),
      discard: async (p) => this.discard(p.id),
      copy: (p) => this.copy(p.id, p.text),
      retry: (p) => this.retry(p.id, p.engine),
      language: (p) => this.switchLanguage(p.id),
      chip: (a) => this.learner.answer(a),
    };
  }

  /** The shell's window, or null when it closes. */
  attach(w: DraftWindow | null): void {
    this.win = w;
    this.up = false;
    if (!w) {
      this.cur = null;
      this.learner.clear();
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
   * of the one in the log; `reading` for a new decode with its engine, time and language (the
   * pill's Retry after an error).
   */
  open(
    id: string,
    o: { focus: boolean; fix?: boolean; text?: string; reading?: RetryReading; rule?: DraftRule },
  ): DraftOpenResult {
    const w = this.win;
    if (!w)
      return { ok: false, code: "no_draft_box", message: "the draft box needs the desktop window" };
    const it = this.o.log.item(id);
    if (!it) return { ok: false, code: "not_found", message: `no dictation ${id}` };
    const r = o.reading;
    const base = r?.text ?? o.text ?? it.text ?? "";
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
      words: r ? r.words : o.text === undefined ? it.words : [],
      ...(r
        ? {
            engine: r.model ? `${r.engine} (${r.model})` : r.engine,
            engineName: r.engine,
            ms: r.ms,
            language: r.language ?? it.language,
          }
        : {}),
      ...(o.rule ? { rule: o.rule } : {}),
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
      /** The reading's engine by name (`best`), when it is not the dictation's own. */
      engineName?: string;
      ms?: number | null;
      /** The reading's language, when it is not the dictation's own. */
      language?: string | null;
      forced?: boolean;
      rule?: DraftRule | null;
    },
  ): void {
    // Another dictation's draft left unanswered in the box: its learn window closes with it.
    const prev = this.cur;
    if (prev && prev.id !== it.id && !prev.answered && !this.learner.has(prev.id))
      this.o.closeLearnWindow?.(prev.id);
    const language = o.language !== undefined ? o.language : it.language;
    const forced = o.forced === true;
    const engineName = o.engineName ?? it.engine;
    this.cur = {
      id: it.id,
      fix: o.fix === true,
      base: o.base,
      words: o.words,
      language,
      engine: engineName,
      forced,
      target: it.target,
      answered: false,
      rule: o.rule ?? null,
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
      local: !engine.startsWith("remote"),
      ...(it.seconds ? { seconds: it.seconds } : {}),
      ...(language ? { language } : {}),
      ...(this.switchEngine(engineName) ? { languageSwitch: true } : {}),
      ...(forced && language ? { languageForced: true } : {}),
      engines: this.o.engines(),
      focus: o.focus,
      platform: this.o.platform,
      ...(o.rule?.enterSends ? { enterSends: true } : {}),
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
    // The audio check can take a decode's time: the insert does not wait for it.
    const learning = this.learnFrom(c, text);
    if (c.fix) {
      this.afterAnswer(c, await learning);
      return true;
    }
    const s = this.o.session();
    if (!s || !c.target) {
      this.reopen(c, text, "dictation is off");
      const chip = await learning;
      if (chip) this.win?.chip(chip);
      return false;
    }
    // The keyboard goes back to the target, so the box steps aside first.
    this.hide();
    const sendKey = c.rule?.sendKey ?? this.o.sendKey();
    const r = await s.insertText(id, text, c.target, send ? sendKey : "none");
    // A refused insert reopens at once: another dictation's draft may take the box during the check.
    if (!r.ok) this.reopen(c, text, r.reason);
    const chip = await learning;
    if (!r.ok) {
      if (chip) this.win?.chip(chip);
      return false;
    }
    this.afterAnswer(c, chip);
    return true;
  }

  /** A refused insert: the box again with the user's text, never taking the keyboard. */
  private reopen(c: Open, text: string, reason: string): void {
    this.o.onLog?.("warn", `dictation ${c.id}: the draft's insert was refused (${reason})`);
    const w = this.win;
    const it = this.o.log.item(c.id);
    if (!w || !it) return;
    this.show(w, it, {
      focus: false,
      fix: c.fix,
      text,
      base: c.base,
      words: c.words,
      engineName: c.engine,
      language: c.language,
      forced: c.forced,
      rule: c.rule,
    });
  }

  private discard(id: string): boolean {
    const c = this.cur;
    if (!c || c.id !== id || c.answered) return false;
    c.answered = true;
    // Only a dictation that never reached the app is discarded; an inserted one stays inserted.
    if (this.o.log.item(id)?.state === "drafted") this.write({ type: "dictation.discarded", id });
    this.afterAnswer(c, null);
    return true;
  }

  private async copy(id: string, text: string): Promise<boolean> {
    const c = this.cur;
    if (!c || c.id !== id) return false;
    const learning = this.learnFrom(c, text);
    const s = this.o.session();
    const r = s ? await s.copyText(text, c.target ?? NO_TARGET) : null;
    const chip = await learning;
    if (chip) this.win?.chip(chip);
    if (!r) return false;
    if (!r.ok) this.o.onLog?.("warn", `dictation ${id}: copy refused (${r.reason})`);
    return r.ok;
  }

  private retry(id: string, engine: string): Promise<boolean> {
    return this.redecode(id, engine);
  }

  /**
   * The engine a language switch decodes on: the reading's own when it takes a forced language,
   * else the first installed one that does; null when none can or the user has fewer than two
   * languages, and then the chip only says what was heard.
   */
  private switchEngine(engine: string): string | null {
    if ((this.o.languages?.() ?? []).length < 2) return null;
    if (forcesLanguage(engine)) return engine;
    return this.o.engines().find(forcesLanguage) ?? null;
  }

  /** The language chip's click: the same audio again, in the next of the user's languages. */
  private switchLanguage(id: string): Promise<boolean> {
    const c = this.cur;
    if (!c || c.id !== id || c.answered) return Promise.resolve(false);
    const engine = this.switchEngine(c.engine);
    if (!engine) return Promise.resolve(false);
    const langs = this.o.languages?.() ?? [];
    // A language outside the list (or none heard) moves to the first of them.
    const next = langs[(langs.indexOf(c.language ?? "") + 1) % langs.length] as string;
    return this.redecode(id, engine, next);
  }

  /** Decodes the kept audio again and shows the new reading in place of the text in the box. */
  private async redecode(id: string, engine: string, language?: string): Promise<boolean> {
    const c = this.cur;
    const w = this.win;
    if (!c || c.id !== id || !w) return false;
    const r = await this.o.retry(id, engine, language);
    const it = this.o.log.item(id);
    // Enter or Escape during a slow retry answered this draft: the new reading comes too late.
    if (!r.ok || !it || r.answer.text === "" || this.cur !== c || c.answered) return false;
    const a = r.answer;
    this.show(w, it, {
      focus: true,
      fix: c.fix,
      base: a.text,
      words: a.words,
      engine: a.model ? `${a.engine} (${a.model})` : a.engine,
      engineName: a.engine,
      ms: a.ms,
      language: a.language ?? language ?? it.language,
      forced: language !== undefined,
      rule: c.rule,
    });
    return true;
  }

  /** The offer to learn from the box's edit (DC-L1, DC-L3), beside the insert. */
  private learnFrom(c: Open, edited: string): Promise<Chip | null> {
    return this.learner.offer({
      id: c.id,
      base: c.base,
      edited,
      words: c.words,
      language: c.language,
    });
  }

  /**
   * Draft `c` was answered: the box goes, or stays without the keyboard for the chip. The audio
   * check may have let another dictation's draft into the box meanwhile; that one stays open.
   */
  private afterAnswer(c: Open, chip: Chip | null): void {
    if (chip && this.win) {
      if (!this.up) this.win.showInactive();
      this.up = true;
      this.win.chip(chip);
      // `auto`: nothing to answer but Undo, which has its time.
      this.learner.shown(chip);
      return;
    }
    this.o.closeLearnWindow?.(c.id);
    this.settle();
  }

  /** The box goes when no draft waits in it and no chip is up. */
  private settle(): void {
    if (this.learner.size > 0 || (this.cur !== null && !this.cur.answered)) return;
    this.cur = null;
    this.hide();
  }

  private write(d: Parameters<DictationLog["append"]>[0]): void {
    try {
      this.o.log.append(d);
    } catch (err) {
      this.o.onLog?.("error", `dictation log: ${(err as Error).message}`);
    }
  }
}
