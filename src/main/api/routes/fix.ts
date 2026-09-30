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
 * - `POST /calls/{id}/fix/undo {vocab, notes, words}`: takes a fix back, given the `undo` of its
 *   answer: the call's entries are retracted, the note deleted, and the word (or only the heard form
 *   the fix added) leaves the vocabulary file again. The log keeps every event.
 */

import type { EventDraft, VocabAdd } from "../../../core/log/events.ts";
import type { CallView } from "../../../core/log/fold.ts";
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

export interface FixUndo {
  vocab: string[];
  notes: string[];
  words: FixedWord[];
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
      const reverted: { heard: string; term: string }[] = [];
      const undo: FixUndo = { vocab: [], notes: [], words: [] };
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
      const add = async (draft: Pick<VocabAdd, "term" | "heard" | "segs" | "nth" | "decode">) => {
        const e = await c.app.write(id, (cc) => ({
          type: "vocab.add",
          id: nextItemId("v", cc.view.lastSeq),
          rev: 1,
          by: c.by,
          ...draft,
        }));
        undo.vocab.push((e as EventDraft & { id: string }).id);
      };
      for (const p of pairs) {
        const kind = pairKind(p, isDict);
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
        if (wide) {
          if (!had(p.term, heard)) {
            await add({ term: p.term, heard, ...(kind === "term" ? {} : { decode: false }) });
          }
        } else if (line && heard.length > 0) {
          const words = tokenize(p.heard).map((t) => t.folded);
          const nth = Math.max(0, occurrences(tokenize(line.raw), words).indexOf(p.from));
          await add({ term: p.term, heard, segs: [line.id], nth, decode: false });
        }
        if (learnt && !wide && !had(learnt, [])) {
          // The term alone, for decoding: the heard form stays on its line.
          await add({ term: learnt, heard: [] });
        }
        if (learnt) {
          try {
            const word = await learn(c.app, workspace, learnt, wide ? p.heard : "");
            if (word) {
              undo.words.push(word);
              filesChanged = true;
            }
          } catch (err) {
            warnings.push(`${learnt} was not kept for later calls: ${(err as Error).message}`);
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
      const after = (await callOf(c)).view;
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
      doc: "Take a fix back: send the `undo` its answer gave. The call's entries are retracted, its note deleted, and the words it put into a vocabulary file taken out again. The log keeps every event.",
      body: { "vocab?": "string[]", "notes?": "string[]", "words?": "any" },
      ok: 200,
    }),
    async (c) => {
      const b = await c.body<Partial<FixUndo>>();
      const id = callId(c);
      let vocab = 0;
      let notes = 0;
      let words = 0;
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
      if (words > 0) c.app.vocabChanged();
      return json(200, { ok: true, call: id, undone: { vocab, notes, words } });
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
