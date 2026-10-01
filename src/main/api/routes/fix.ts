/**
 * Fix once, applied everywhere (docs/DESIGN.md section 5.4, "A fix on a line"):
 *
 * - `POST /calls/{id}/fix {line, text}`: the person fixed one line; `text` is how it should read.
 *   akou aligns it with the line's raw text (`core/vocab/fix.ts`) and, for each pair it finds:
 *   - a **term** (a name, a product, a project, a jargon word) is learned with no review step: a
 *     call-scoped `vocab.add`, so decoding takes the word from now on, and an entry in the
 *     workspace's vocabulary file (`source: correction`, confirmed), so the next calls and every
 *     engine that takes a word list know it. When its heard form is no common word (`versal`, a run
 *     of words, or `vercel` for `Vercel`), the call's entry has no line restriction, so every line
 *     with the same heard form reads corrected at once, live and saved, and the file keeps the
 *     heard form. A common heard form (`mark` for `Marc`) stays on its word of the line.
 *   - a **rewording** of common words, and a word added or removed, is kept to its one word of the
 *     line (`segs` and `nth`, `decode: false`); the fold also reads it on the final lines that cover
 *     this one where that word occurs once.
 *   A rewording, and a term when the engine transcribing the call takes no word list (streaming
 *   Nemotron, Parakeet decoding greedy), also goes into the call's Notes as one line
 *   `Fixed: heard -> term` marked `from: fix`, for the people and agents reading the call.
 *   A word the person writes back as heard, under a correction of the call, takes that correction
 *   off the call and the heard form out of the word a fix learned (`reverted` in the answer).
 *   `rev`, when sent, is the line's revision as shown: a line rewritten since answers 409.
 * - `POST /calls/{id}/fix {term, heard}`: the same for a correction stated with no line, as an
 *   agent passes on "it's Vercel, not versal": the person said it, so it applies to the whole call
 *   even for common words. A rewording is not learned into the workspace, and is noted.
 * - `POST /calls/{id}/fix/undo {vocab, notes, words, learned, renames}`: takes a fix back, given the
 *   `undo` of its answer: the call's entries are retracted, the note deleted, the word (or only the
 *   heard form the fix added) leaves the vocabulary file again, and a rename goes back. The log keeps
 *   every event.
 * - `POST /calls/{id}/fix/forget {learned}`: takes a term a fix learned out of the call and out of the
 *   file it was learned into, at any time after the fix.
 *
 * Every term a fix learns, renames or takes back writes a `vocab.learned` revision, so an agent
 * following the call is told (`learned` on read answers). A new spelling typed over a word that a
 * correction of the call gives renames that term instead of adding a second one.
 */

import type { EventDraft, LearnedKept, VocabAdd } from "../../../core/log/events.ts";
import type { CallView, LearnedTerm, Line } from "../../../core/log/fold.ts";
import { type Correction, occurrences, tokenize } from "../../../core/vocab/correct.ts";
import {
  type FixPair,
  fixPairs,
  keptWords,
  type PairKind,
  pairKind,
  spreads,
} from "../../../core/vocab/fix.ts";
import { noteDraft } from "../../notes/notepad.ts";
import {
  MAX_HEARD,
  removeEntry,
  termKey,
  upsertEntry,
  validateTerm,
  validWorkspace,
} from "../../vocab/files.ts";
import { HttpError, json, type RouteDoc, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { CALL_ID, callId, callOf, nextItemId } from "./common.ts";
import { editFile, targetPath } from "./vocab.ts";

const MAX_LINE = 2000;

function doc(d: Omit<RouteDoc, "access" | "modes">): RouteDoc {
  return { access: "admin", modes: ["app"], ...d, params: { id: CALL_ID, ...d.params } };
}

/** What a fix did to one pair. */
export interface FixedPair {
  heard: string;
  term: string;
  kind: PairKind;
  /** In the call's and the workspace's vocabulary. */
  learned: boolean;
  /** The word learned, when it is not `term`: the added word of `on` to `on Vercel`. */
  learnedTerm?: string;
  /** A rename of a term the call already corrected this word to: the term it had. */
  renamed?: string;
  /** Written into the call's Notes. */
  noted: boolean;
  /** Lines of the call that read corrected by it now. */
  lines: number;
}

/** A word the fix put into a vocabulary file, so Undo can take out exactly that. */
export interface FixedWord {
  workspace?: string;
  term: string;
  /** The heard form the fix added, if any. */
  heard?: string;
  /** The fix wrote the entry; otherwise it only added `heard` to one that was there. */
  created: boolean;
}

/** A term a fix renamed, so Undo can name it back. */
export interface FixRename {
  /** The call's entry that was renamed. */
  vocab: string;
  /** The `vocab.learned` id that says so. */
  learned: string;
  from: string;
  to: string;
  workspace?: string;
  /** The vocabulary file's entry was renamed too. */
  file: boolean;
}

export interface FixUndo {
  vocab: string[];
  notes: string[];
  words: FixedWord[];
  /** `vocab.learned` ids the fix wrote; Undo takes them back. */
  learned: string[];
  renames: FixRename[];
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The note a fix leaves: `Fixed: versal -> Vercel; their -> there`. */
export function fixNote(pairs: readonly { heard: string; term: string }[]): string {
  return `Fixed: ${pairs.map((p) => (p.heard ? `${p.heard} -> ${p.term}` : p.term)).join("; ")}`;
}

function workspaceOf(view: CallView): string | undefined {
  const ws = view.call?.workspace;
  return ws && validWorkspace(ws) ? ws : undefined;
}

function keptIn(workspace: string | undefined): LearnedKept {
  return workspace ? "workspace" : "global";
}

/** Writes a `vocab.learned` revision with `term: null` for the first term `match` picks. */
async function retractLearned(
  c: { app: ApiApp; by: string },
  id: string,
  match: (x: LearnedTerm, view: CallView) => boolean,
): Promise<boolean> {
  const e = await c.app
    .write(id, (cc) => {
      const l = cc.view.learnedTerms().find((x) => match(x, cc.view));
      if (!l) throw new HttpError(404, "not_found", "no learned term");
      return { type: "vocab.learned", id: l.id, rev: l.rev + 1, term: null, by: c.by };
    })
    .catch((err) => {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    });
  return e !== null;
}

/**
 * Renames a term in a vocabulary file, keeping its heard forms. Answers whether the file changed.
 * A file that already holds the new term is left alone (409): merging the two would lose the other
 * entry for good on Undo, which has nothing to restore it from.
 */
async function renameInFile(
  app: ApiApp,
  workspace: string | undefined,
  from: string,
  to: string,
): Promise<boolean> {
  const out = await editFile(targetPath(app, workspace), (file) => {
    const had = file.entries.find((e) => termKey(e.term) === termKey(from));
    if (!had || had.term === to) return null;
    const into = file.entries.find((e) => e !== had && termKey(e.term) === termKey(to));
    if (into) throw new HttpError(409, "term_exists", `the file already has ${into.term}`);
    return {
      file: { ...file, entries: file.entries.map((e) => (e === had ? { ...had, term: to } : e)) },
      result: true,
    };
  });
  return out === true;
}

/** Takes a learned term out of the file it went into: the entry a fix wrote, or the forms it added. */
async function forgetInFile(
  app: ApiApp,
  workspace: string | undefined,
  l: Pick<LearnedTerm, "term" | "heard">,
): Promise<boolean> {
  const out = await editFile(targetPath(app, workspace), (file) => {
    const had = file.entries.find((e) => termKey(e.term) === termKey(l.term));
    if (!had) return null;
    if (had.source === "correction") return { file: removeEntry(file, had.term), result: true };
    const heard = had.heard.filter((h) => !l.heard.some((x) => termKey(x) === termKey(h)));
    if (heard.length === had.heard.length) return null;
    return { file: upsertEntry(file, { ...had, heard }), result: true };
  });
  return out === true;
}

/**
 * The correction of the call a new spelling was typed over, when there is one: the word as it read
 * came from a call entry, and the pair's words are that word. Typing another spelling renames it.
 */
function renameTarget(view: CallView, l: Line & { raw: string }, p: FixPair) {
  if (p.op !== "replace" || !p.heard) return null;
  const toks = tokenize(l.raw);
  const first = toks[p.from];
  const last = toks[p.from + tokenize(p.heard).length - 1];
  if (!first || !last) return null;
  const x = l.corrections.find(
    (x) =>
      x.scope === "call" &&
      x.kind === "heard" &&
      x.term !== p.term &&
      x.start >= first.start &&
      x.end <= last.end,
  );
  if (!x) return null;
  const cur = view
    .callVocabulary()
    .find((v) => v.term === x.term && v.heard.some((h) => termKey(h) === termKey(x.heard)));
  return cur ? { from: x.term, vocab: cur.id } : null;
}

/**
 * A correction the person wrote back as heard: the call's entry giving it is retracted (or loses
 * only that heard form), and the workspace's word learned from a fix loses the heard form too.
 * Answers whether the vocabulary file changed.
 */
async function takeBack(
  c: { app: ApiApp; by: string },
  id: string,
  workspace: string | undefined,
  x: Correction,
): Promise<boolean> {
  if (x.kind !== "heard") return false;
  const form = termKey(x.heard);
  const call = await c.app
    .write(id, (cc) => {
      const cur = cc.view
        .callVocabulary()
        .find((v) => v.term === x.term && v.heard.some((h) => termKey(h) === form));
      if (!cur) throw new HttpError(404, "not_found", x.term);
      const rest = cur.heard.filter((h) => termKey(h) !== form);
      if (rest.length === 0) {
        return { type: "vocab.add", id: cur.id, rev: cur.rev + 1, term: null, by: c.by };
      }
      return {
        type: "vocab.add",
        id: cur.id,
        rev: cur.rev + 1,
        term: cur.term,
        heard: rest,
        by: c.by,
        ...(cur.segs ? { segs: cur.segs } : {}),
        ...(cur.nth !== undefined ? { nth: cur.nth } : {}),
        decode: cur.decode,
      };
    })
    .catch((err) => {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    });
  if (!call) return false;
  const vid = (call as EventDraft & { id: string }).id;
  // The learned term is taken back only once none of its call entries reads it any more: an entry
  // that keeps other heard forms, or another entry the same fix wrote, still spells it that way.
  await retractLearned(
    c,
    id,
    (l, view) =>
      l.vocab.includes(vid) &&
      !view.callVocabulary().some((v) => l.vocab.includes(v.id) && v.term === l.term),
  );
  const out = await editFile(targetPath(c.app, workspace), (file) => {
    const had = file.entries.find(
      (e) => termKey(e.term) === termKey(x.term) && e.source === "correction",
    );
    if (!had) return null;
    const heard = had.heard.filter((h) => termKey(h) !== form);
    if (heard.length === had.heard.length) return null;
    return { file: upsertEntry(file, { ...had, heard }), result: true };
  }).catch(() => null);
  return out === true;
}

function checkPart(v: unknown, what: string): string {
  if (typeof v !== "string") throw new HttpError(400, "bad_field", `${what} must be a string`);
  const bad = validateTerm(v.trim());
  if (bad) throw new HttpError(400, "bad_term", `${JSON.stringify(v)}: ${bad}`, { term: v });
  return v.trim();
}

/** Lines of the call whose rendering now carries this pair's correction. */
function linesCorrected(view: CallView, p: { heard: string; term: string }): number {
  const key = termKey(p.heard);
  return view
    .lines("best")
    .filter((l) =>
      l.corrections.some((c) => c.term === p.term && (!key || termKey(c.heard) === key)),
    ).length;
}

export function fixRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/calls/:id/fix",
    doc({
      id: "callVocab.fix",
      doc: "Fix a line, or a word with no line: `line` and `text` (the line as it should read, with the line's `rev` as it was shown, so a line rewritten meanwhile answers 409), or `term` and `heard`. A name, product or jargon word is learned into the call's and the workspace's vocabulary with no review, and every line of the call with the same heard form reads corrected, unless that form is a common word: then only the fixed line does. A rewording of common words stays on the one word of its line and goes into the call's Notes, as does any word when the engine transcribing the call takes no word list. A word written back as heard under a correction takes that correction off the call (`reverted`). `undo` in the answer takes the fix back with `POST /calls/{id}/fix/undo`.",
      body: {
        "line?": "string",
        "text?": "string",
        "rev?": "number",
        "term?": "string",
        "heard?": "string[]",
      },
      ok: 200,
    }),
    async (c) => {
      const b = await c.body<{
        line?: string;
        text?: string;
        rev?: number;
        term?: string;
        heard?: string[];
      }>();
      const id = callId(c);
      const call = await callOf(c);
      const view = call.view;
      const isDict = view.options.isDictionaryWord;
      let pairs: FixPair[];
      let line: { id: string; w: number; raw: string } | null = null;
      let fixed: (Line & { raw: string }) | null = null;
      const reverted: { heard: string; term: string }[] = [];
      const undo: FixUndo = { vocab: [], notes: [], words: [], learned: [], renames: [] };
      let filesChanged = false;
      if (b.line !== undefined) {
        if (typeof b.text !== "string" || b.text.trim() === "") {
          throw new HttpError(400, "bad_field", "text must be the line as it should read");
        }
        const text = b.text.trim();
        if (text.length > MAX_LINE) {
          throw new HttpError(400, "bad_field", `text is over ${MAX_LINE} characters`);
        }
        const l = view.visibleIn(b.line, "best") ? view.resolve(b.line) : null;
        if (!l || l.raw === null) throw new HttpError(404, "not_found", `no line ${b.line}`);
        if (typeof b.rev === "number" && b.rev !== l.rev) {
          throw new HttpError(409, "line_changed", "the line changed while it was being fixed", {
            line: l.id,
            rev: l.rev,
            text: l.text,
          });
        }
        line = { id: l.id, w: l.w0, raw: l.raw };
        fixed = l as Line & { raw: string };
        // Aligned with the raw text, so every pair matches what the recognizer wrote; a word the
        // vocabulary already corrects on this line, left as it reads, is no new pair.
        pairs = fixPairs(l.raw, text).filter(
          (p) =>
            !l.corrections.some((x) => termKey(x.heard) === termKey(p.heard) && x.term === p.term),
        );
        // A word written back as heard, under a call's correction, says that correction is wrong.
        const kept = keptWords(l.raw, text);
        const raw = tokenize(l.raw);
        for (const x of l.corrections) {
          if (x.scope !== "call" || x.term === x.heard) continue;
          const words = raw.filter((t) => t.start >= x.start && t.end <= x.end);
          if (words.length === 0 || !words.every((t) => kept.has(t.start))) continue;
          if (await takeBack(c, id, workspaceOf(view), x)) {
            filesChanged = true;
          }
          reverted.push({ heard: x.heard, term: x.term });
        }
      } else if (b.term !== undefined) {
        const term = checkPart(b.term, "term");
        const heard = (b.heard ?? []).map((h) => checkPart(h, "heard")).filter((h) => h !== term);
        // A stated word is never at the start of a sentence: its capitals are the person's.
        const stated = (h: string): FixPair => ({
          heard: h,
          term,
          at: 1,
          from: 0,
          op: "replace",
          lead: false,
        });
        pairs = heard.length > 0 ? heard.map(stated) : [stated("")];
      } else {
        throw new HttpError(400, "bad_field", "send `line` and `text`, or `term` and `heard`");
      }

      const takesWords = c.app.takesWords?.(id) ?? false;
      const workspace = workspaceOf(view);
      const warnings: string[] = [];
      const done: Omit<FixedPair, "lines">[] = [];
      // What each learned term's `vocab.learned` will say, written once the call reads it.
      const learned: {
        term: string;
        heard: string[];
        vocab: string[];
        kept: LearnedKept;
        was?: string;
        /** A rename of a term learned before: its id. */
        prev?: string;
        rename?: FixRename;
      }[] = [];
      const add = async (draft: Pick<VocabAdd, "term" | "heard" | "segs" | "nth" | "decode">) => {
        const e = await c.app.write(id, (cc) => ({
          type: "vocab.add",
          id: nextItemId("v", cc.view.lastSeq),
          rev: 1,
          by: c.by,
          ...draft,
        }));
        const vid = (e as EventDraft & { id: string }).id;
        undo.vocab.push(vid);
        return vid;
      };
      for (const p of pairs) {
        const kind = pairKind(p, isDict);
        const target = fixed ? renameTarget(view, fixed, p) : null;
        if (target) {
          // A new spelling over a word the call already corrects: that term is renamed, in the
          // call and in the file it was learned into, instead of a second term being added.
          await c.app.write(id, (cc) => {
            const cur = cc.view.callVocabulary().find((v) => v.id === target.vocab);
            if (!cur)
              throw new HttpError(409, "line_changed", "the word changed while it was fixed");
            return {
              type: "vocab.add",
              id: cur.id,
              rev: cur.rev + 1,
              term: p.term,
              heard: cur.heard,
              by: c.by,
              ...(cur.segs ? { segs: cur.segs } : {}),
              ...(cur.nth !== undefined ? { nth: cur.nth } : {}),
              decode: cur.decode,
            };
          });
          const prev = view.learnedTerms().find((x) => x.vocab.includes(target.vocab));
          const kept = prev?.kept ?? "call";
          let file = false;
          if (kept !== "call") {
            try {
              file = await renameInFile(c.app, workspace, target.from, p.term);
              if (file) filesChanged = true;
            } catch (err) {
              warnings.push(`${p.term} was not renamed in the file: ${(err as Error).message}`);
            }
          }
          const rename: FixRename = {
            vocab: target.vocab,
            learned: prev?.id ?? "",
            from: target.from,
            to: p.term,
            ...(workspace ? { workspace } : {}),
            file,
          };
          undo.renames.push(rename);
          learned.push({
            term: p.term,
            heard: prev?.heard ?? [p.heard],
            vocab: prev?.vocab ?? [target.vocab],
            kept,
            was: target.from,
            ...(prev ? { prev: prev.id } : {}),
            rename,
          });
          done.push({
            heard: p.heard,
            term: p.term,
            kind,
            learned: true,
            renamed: target.from,
            noted: !takesWords,
          });
          continue;
        }
        const heard = p.heard && termKey(p.heard) !== "" ? [p.heard] : [];
        // A stated pair is the person's own word for the whole call; a line's pair spreads to the
        // other lines only when it is a term whose heard form is no common word.
        const wide =
          heard.length > 0 &&
          (line === null || (kind === "term" && p.op === "replace" && spreads(p, isDict)));
        const learnt = kind === "term" ? (p.op === "insert" ? (p.added ?? "") : p.term) : "";
        const had = (term: string, forms: readonly string[]) =>
          view
            .callVocabulary()
            .some(
              (v) => !v.segs && v.term === term && forms.every((h) => v.heard.some((x) => x === h)),
            );
        const ids: string[] = [];
        // The call reads a term it did not before: the whole call, or decoding.
        let newToCall = false;
        if (wide) {
          if (!had(p.term, heard)) {
            ids.push(
              await add({ term: p.term, heard, ...(kind === "term" ? {} : { decode: false }) }),
            );
            newToCall = true;
          }
        } else if (line && heard.length > 0) {
          const words = tokenize(p.heard).map((t) => t.folded);
          const nth = Math.max(0, occurrences(tokenize(line.raw), words).indexOf(p.from));
          ids.push(await add({ term: p.term, heard, segs: [line.id], nth, decode: false }));
        }
        if (learnt && !wide && !had(learnt, [])) {
          // The term alone, for decoding: the heard form stays on its line.
          ids.push(await add({ term: learnt, heard: [] }));
          newToCall = true;
        }
        if (learnt) {
          let kept = keptIn(workspace);
          let word: FixedWord | null = null;
          try {
            word = await learn(c.app, workspace, learnt, wide ? p.heard : "");
            if (word) {
              undo.words.push(word);
              filesChanged = true;
            }
          } catch (err) {
            kept = "call";
            warnings.push(`${learnt} was not kept for later calls: ${(err as Error).message}`);
          }
          // Told once per term the fix taught. The same word fixed on one more line is no news.
          if (newToCall || word) {
            learned.push({
              term: learnt,
              heard: p.op === "replace" && heard.length > 0 ? heard : [],
              vocab: ids,
              kept,
            });
          }
        }
        done.push({
          heard: p.heard,
          term: p.term,
          kind,
          learned: learnt !== "",
          ...(learnt && learnt !== p.term ? { learnedTerm: learnt } : {}),
          noted: !learnt || !takesWords,
        });
      }
      if (filesChanged) c.app.vocabChanged();
      const noted = done.filter((p) => p.noted);
      if (noted.length > 0) {
        const now = c.app.now();
        const e = await c.app.write(
          id,
          (cc) =>
            ({
              ...(noteDraft(cc.view, {
                text: fixNote(noted),
                by: c.by.startsWith("agent:") || c.by === "user" ? c.by : "user",
                now,
                w: line ? Math.min(line.w, now) : now,
              }) as EventDraft),
              from: "fix",
            }) as EventDraft,
        );
        undo.notes.push((e as EventDraft & { id: string }).id);
      }
      let after = (await callOf(c)).view;
      // One notice per term: a stated word with several heard forms is one term taught.
      const byTerm = new Map<string, (typeof learned)[number]>();
      for (const k of learned) {
        const had = byTerm.get(k.term);
        if (!had) byTerm.set(k.term, { ...k, heard: [...k.heard], vocab: [...k.vocab] });
        else {
          for (const h of k.heard) if (!had.heard.includes(h)) had.heard.push(h);
          had.vocab.push(...k.vocab);
        }
      }
      for (const k of byTerm.values()) {
        const lines = linesCorrected(after, { heard: "", term: k.term });
        const e = await c.app.write(id, (cc) => {
          const prev = k.prev ? cc.view.learnedTerms().find((x) => x.id === k.prev) : undefined;
          return {
            type: "vocab.learned",
            id: prev?.id ?? nextItemId("k", cc.view.lastSeq),
            rev: (prev?.rev ?? 0) + 1,
            term: k.term,
            heard: k.heard,
            by: c.by,
            lines,
            kept: k.kept,
            vocab: k.vocab,
            ...(k.was ? { was: k.was } : {}),
          };
        });
        const lid = (e as EventDraft & { id: string }).id;
        if (k.rename) k.rename.learned = lid;
        else undo.learned.push(lid);
      }
      if (byTerm.size > 0) after = (await callOf(c)).view;
      return json(200, {
        ok: true,
        call: id,
        ...(line ? { line: line.id } : {}),
        takesWords,
        pairs: done.map((p) => ({ ...p, lines: linesCorrected(after, p) })),
        ...(reverted.length > 0 ? { reverted } : {}),
        undo,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  );

  r.add(
    "POST",
    "/calls/:id/fix/undo",
    doc({
      id: "callVocab.fixUndo",
      doc: "Take a fix back: send the `undo` its answer gave. The call's entries are retracted, its note deleted, the words it put into a vocabulary file taken out again, the terms it learned taken back (a `vocab.learned` revision with `term: null`), and a term it renamed named back. The log keeps every event.",
      body: {
        "vocab?": "string[]",
        "notes?": "string[]",
        "words?": "any",
        "learned?": "string[]",
        "renames?": "any",
      },
      ok: 200,
    }),
    async (c) => {
      const b = await c.body<Partial<FixUndo>>();
      const id = callId(c);
      let vocab = 0;
      let notes = 0;
      let words = 0;
      let learned = 0;
      for (const r of b.renames ?? []) {
        if (
          typeof r?.vocab !== "string" ||
          typeof r.from !== "string" ||
          typeof r.to !== "string"
        ) {
          continue;
        }
        const e = await c.app
          .write(id, (cc) => {
            const cur = cc.view.callVocabulary().find((x) => x.id === r.vocab && x.term === r.to);
            if (!cur) throw new HttpError(404, "not_found", r.vocab);
            return {
              type: "vocab.add",
              id: cur.id,
              rev: cur.rev + 1,
              term: r.from,
              heard: cur.heard,
              by: c.by,
              ...(cur.segs ? { segs: cur.segs } : {}),
              ...(cur.nth !== undefined ? { nth: cur.nth } : {}),
              decode: cur.decode,
            };
          })
          .catch((err) => {
            if (err instanceof HttpError && err.status === 404) return null;
            throw err;
          });
        if (!e) continue;
        vocab++;
        const ws =
          typeof r.workspace === "string" && validWorkspace(r.workspace) ? r.workspace : undefined;
        // A file that cannot be edited must not stop the rest of the Undo.
        if (r.file && (await renameInFile(c.app, ws, r.to, r.from).catch(() => false))) words++;
        await c.app
          .write(id, (cc) => {
            const l = cc.view.learnedTerms().find((x) => x.id === r.learned && x.term === r.to);
            if (!l) throw new HttpError(404, "not_found", String(r.learned));
            return {
              type: "vocab.learned",
              id: l.id,
              rev: l.rev + 1,
              term: r.from,
              was: r.to,
              heard: l.heard,
              by: c.by,
              ...(l.kept ? { kept: l.kept } : {}),
              vocab: l.vocab,
            };
          })
          .then(() => learned++)
          .catch((err) => {
            if (!(err instanceof HttpError && err.status === 404)) throw err;
          });
      }
      for (const vid of b.vocab ?? []) {
        if (typeof vid !== "string") continue;
        const e = await c.app
          .write(id, (cc) => {
            const cur = cc.view.callVocabulary().find((x) => x.id === vid);
            if (!cur) throw new HttpError(404, "not_found", vid);
            return { type: "vocab.add", id: cur.id, rev: cur.rev + 1, term: null, by: c.by };
          })
          .catch((err) => {
            if (err instanceof HttpError && err.status === 404) return null;
            throw err;
          });
        if (e) vocab++;
      }
      for (const nid of b.notes ?? []) {
        if (typeof nid !== "string") continue;
        const e = await c.app
          .write(id, (cc) => {
            if (!cc.view.notes().some((n) => n.id === nid)) {
              throw new HttpError(404, "not_found", nid);
            }
            return { type: "note.del", id: nid, by: c.by.startsWith("agent:") ? c.by : "user" };
          })
          .catch((err) => {
            if (err instanceof HttpError && err.status === 404) return null;
            throw err;
          });
        if (e) notes++;
      }
      for (const w of b.words ?? []) {
        if (typeof w?.term !== "string") continue;
        const ws =
          typeof w.workspace === "string" && validWorkspace(w.workspace) ? w.workspace : undefined;
        const out = await editFile(targetPath(c.app, ws), (file) => {
          const had = file.entries.find((e) => termKey(e.term) === termKey(w.term));
          if (!had) return null;
          if (w.created && had.source === "correction") {
            // A heard form a later fix added to the entry keeps it.
            const rest =
              typeof w.heard === "string"
                ? had.heard.filter((h) => termKey(h) !== termKey(w.heard as string))
                : had.heard;
            if (rest.length === 0) return { file: removeEntry(file, had.term), result: true };
            return { file: upsertEntry(file, { ...had, heard: rest }), result: true };
          }
          if (typeof w.heard !== "string") return null;
          const heard = had.heard.filter((h) => termKey(h) !== termKey(w.heard as string));
          if (heard.length === had.heard.length) return null;
          return { file: upsertEntry(file, { ...had, heard }), result: true };
        });
        if (out) words++;
      }
      for (const lid of b.learned ?? []) {
        if (typeof lid === "string" && (await retractLearned(c, id, (x) => x.id === lid))) {
          learned++;
        }
      }
      if (words > 0) c.app.vocabChanged();
      return json(200, { ok: true, call: id, undone: { vocab, notes, words, learned } });
    },
  );

  r.add(
    "POST",
    "/calls/:id/fix/forget",
    doc({
      id: "callVocab.forget",
      doc: "Forget a term a fix learned, at any time after the fix: `learned` is its `vocab.learned` id. The call's entries it came with are retracted, so its lines read as heard again, and it leaves the vocabulary file it was learned into (the whole entry when a fix wrote it, else only the heard forms the fix added). A `vocab.learned` revision with `term: null` tells the agents following the call.",
      body: { learned: "string" },
      ok: 200,
    }),
    async (c) => {
      const b = await c.body<{ learned?: unknown }>();
      if (typeof b.learned !== "string") {
        throw new HttpError(400, "bad_field", "learned must be a vocab.learned id");
      }
      const id = callId(c);
      const view = (await callOf(c)).view;
      const l = view.learnedTerms().find((x) => x.id === b.learned);
      if (!l) throw new HttpError(404, "not_found", `no learned term ${b.learned}`);
      let vocab = 0;
      // The entries it came with, and the same term fixed on more lines since.
      const ids = new Set([
        ...l.vocab,
        ...view
          .callVocabulary()
          .filter((v) => v.term === l.term)
          .map((v) => v.id),
      ]);
      for (const vid of ids) {
        const e = await c.app
          .write(id, (cc) => {
            const cur = cc.view.callVocabulary().find((x) => x.id === vid);
            if (!cur) throw new HttpError(404, "not_found", vid);
            return { type: "vocab.add", id: cur.id, rev: cur.rev + 1, term: null, by: c.by };
          })
          .catch((err) => {
            if (err instanceof HttpError && err.status === 404) return null;
            throw err;
          });
        if (e) vocab++;
      }
      let file = false;
      const warnings: string[] = [];
      if (l.kept && l.kept !== "call") {
        // A file that cannot be edited is reported; the call still forgets the term.
        try {
          const ws = l.kept === "workspace" ? workspaceOf(view) : undefined;
          file = await forgetInFile(c.app, ws, l);
          if (file) c.app.vocabChanged();
        } catch (err) {
          warnings.push(`${l.term} was not taken out of the file: ${(err as Error).message}`);
        }
      }
      await retractLearned(c, id, (x) => x.id === l.id);
      return json(200, {
        ok: true,
        call: id,
        forgotten: { term: l.term, vocab, file },
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  );
}

/**
 * Puts a learned term into the workspace's vocabulary file (the global one for a call with no
 * workspace), confirmed: the person wrote it. An entry already there only gains the heard form.
 */
async function learn(
  app: ApiApp,
  workspace: string | undefined,
  term: string,
  heard: string,
): Promise<FixedWord | null> {
  // A heard form differing from the term only in case or accents (`vercel`) is kept too: it
  // corrects that exact spelling on later calls.
  const form = heard && tokenize(heard).length > 0 && heard.trim() !== term.trim() ? heard : "";
  return editFile<FixedWord>(targetPath(app, workspace), (file) => {
    const had = file.entries.find((e) => termKey(e.term) === termKey(term));
    if (had) {
      if (!form || had.heard.length >= MAX_HEARD) return null;
      if (had.heard.some((h) => termKey(h) === termKey(form))) return null;
      return {
        file: upsertEntry(file, { ...had, heard: [...had.heard, form] }),
        result: {
          ...(workspace ? { workspace } : {}),
          term: had.term,
          heard: form,
          created: false,
        },
      };
    }
    return {
      file: upsertEntry(file, {
        term,
        heard: form ? [form] : [],
        source: "correction",
        confirmed: true,
        added_at: today(app.now()),
      }),
      result: {
        ...(workspace ? { workspace } : {}),
        term,
        ...(form ? { heard: form } : {}),
        created: true,
      },
    };
  });
}
