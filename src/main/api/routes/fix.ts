/**
 * Fix once, applied everywhere (docs/DESIGN.md section 5.4, "A fix on a line"):
 *
 * - `POST /calls/{id}/fix {line, text}`: the person fixed one line; `text` is how it should read.
 *   akou aligns it with the line's raw text (`core/vocab/fix.ts`) and, for each pair it finds:
 *   - a **term** (a name, a product, a project, a jargon word) is learned with no review step: a
 *     call-scoped `vocab.add` with no line restriction, so every line of the call with the same
 *     heard form reads corrected at once, live and saved, and decoding takes the word from now on;
 *     and an entry in the workspace's vocabulary file (`source: correction`, confirmed), so the next
 *     calls and every engine that takes a word list know it;
 *   - a **rewording** of common words is kept to this line (`segs`, `decode: false`); the fold also
 *     reads it on the final lines that cover this one.
 *   A rewording, and a term when the engine transcribing the call takes no word list (streaming
 *   Nemotron, Parakeet decoding greedy), also goes into the call's Notes as one line
 *   `Fixed: heard -> term` marked `from: fix`, so the final pass and anyone reading the notes see it.
 * - `POST /calls/{id}/fix {term, heard}`: the same for a correction stated with no line, as an
 *   agent passes on "it's Vercel, not versal". A rewording with no line is only noted.
 * - `POST /calls/{id}/fix/undo {vocab, notes, words}`: takes a fix back, given the `undo` of its
 *   answer: the call's entries are retracted, the note deleted, and the word (or only the heard form
 *   the fix added) leaves the vocabulary file again. The log keeps every event.
 */

import type { EventDraft } from "../../../core/log/events.ts";
import type { CallView } from "../../../core/log/fold.ts";
import { tokenize } from "../../../core/vocab/correct.ts";
import { type FixPair, fixPairs, type PairKind, pairKind } from "../../../core/vocab/fix.ts";
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
      doc: "Fix a line, or a word with no line: `line` and `text` (the line as it should read), or `term` and `heard`. Each word the fix changes is applied to the whole call at once. A name, product or jargon word is learned into the call's and the workspace's vocabulary with no review; a rewording of common words stays on its line and goes into the call's Notes, as does any word when the engine transcribing the call takes no word list. `undo` in the answer takes it all back with `POST /calls/{id}/fix/undo`.",
      body: { "line?": "string", "text?": "string", "term?": "string", "heard?": "string[]" },
      ok: 200,
    }),
    async (c) => {
      const b = await c.body<{ line?: string; text?: string; term?: string; heard?: string[] }>();
      const id = callId(c);
      const call = await callOf(c);
      const view = call.view;
      const isDict = view.options.isDictionaryWord;
      let pairs: FixPair[];
      let line: { id: string; w: number } | null = null;
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
        line = { id: l.id, w: l.w0 };
        // Aligned with the raw text, so every pair matches what the recognizer wrote; a word the
        // vocabulary already corrects on this line, left as it reads, is no new pair.
        pairs = fixPairs(l.raw, text).filter(
          (p) =>
            !l.corrections.some((x) => termKey(x.heard) === termKey(p.heard) && x.term === p.term),
        );
      } else if (b.term !== undefined) {
        const term = checkPart(b.term, "term");
        const heard = (b.heard ?? []).map((h) => checkPart(h, "heard")).filter((h) => h !== term);
        // A stated word is never at the start of a line: its capitals are the person's.
        pairs =
          heard.length > 0
            ? heard.map((h) => ({ heard: h, term, at: 1 }))
            : [{ heard: "", term, at: 1 }];
      } else {
        throw new HttpError(400, "bad_field", "send `line` and `text`, or `term` and `heard`");
      }

      const takesWords = c.app.takesWords?.(id) ?? false;
      const workspace =
        view.call?.workspace && validWorkspace(view.call.workspace)
          ? view.call.workspace
          : undefined;
      const undo: FixUndo = { vocab: [], notes: [], words: [] };
      const warnings: string[] = [];
      const done: Omit<FixedPair, "lines">[] = [];
      let filesChanged = false;
      for (const p of pairs) {
        const kind = pairKind(p, isDict);
        const heard = p.heard && termKey(p.heard) !== "" ? [p.heard] : [];
        if (kind === "term") {
          const had = view
            .callVocabulary()
            .find(
              (v) =>
                !v.segs && v.term === p.term && heard.every((h) => v.heard.some((x) => x === h)),
            );
          if (!had) {
            const e = await c.app.write(id, (cc) => ({
              type: "vocab.add",
              id: nextItemId("v", cc.view.lastSeq),
              rev: 1,
              term: p.term,
              heard,
              by: c.by,
            }));
            undo.vocab.push((e as EventDraft & { id: string }).id);
          }
          try {
            const word = await learn(c.app, workspace, p.term, p.heard);
            if (word) {
              undo.words.push(word);
              filesChanged = true;
            }
          } catch (err) {
            warnings.push(`${p.term} was not kept for later calls: ${(err as Error).message}`);
          }
          done.push({ heard: p.heard, term: p.term, kind, learned: true, noted: !takesWords });
        } else {
          if (line && heard.length > 0) {
            const lineId = line.id;
            const e = await c.app.write(id, (cc) => ({
              type: "vocab.add",
              id: nextItemId("v", cc.view.lastSeq),
              rev: 1,
              term: p.term,
              heard,
              by: c.by,
              segs: [lineId],
              decode: false,
            }));
            undo.vocab.push((e as EventDraft & { id: string }).id);
          }
          done.push({ heard: p.heard, term: p.term, kind, learned: false, noted: true });
        }
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
            return { file: removeEntry(file, had.term), result: true };
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
  const form = heard && tokenize(heard).length > 0 && termKey(heard) !== termKey(term) ? heard : "";
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
