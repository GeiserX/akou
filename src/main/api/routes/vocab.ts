/**
 * The custom vocabulary over the API (docs/DESIGN.md sections 3, 5.4 and 6.2):
 *
 * - Per call: `GET /calls/{id}/vocab` (what is in force), `POST /calls/{id}/vocab` (a call-scoped
 *   `vocab.add`, which applies forward to decoding and backward to reading at once), `DELETE
 *   /calls/{id}/vocab/{vid}` (its retraction, a new revision with `term: null`).
 * - The files: `GET /vocab`, `POST /vocab`, `DELETE /vocab/{term}`, and approving or rejecting
 *   entries and a call's proposals. A proposal is inert until approved; approving it writes the
 *   entry, confirmed, into the workspace file. akou never grows the files on its own.
 *
 * - The post-call pass (`POST /calls/{id}/vocab/pass`, layer 3): the configured provider corrects
 *   known terms and proposes new ones, every item through the pass's span check (`vocab/pass.ts`).
 *   Only on request, like Enhance, and only on a call that has ended.
 * - The words to review: `GET /calls/{id}/vocab` carries `review`, the call's open proposals with
 *   the lines they rest on, and the workspace's unconfirmed entries.
 * - `POST /vocab/suggest`: ranked candidate words from a call or a text (`vocab/suggest.ts`).
 *
 * Not built yet, answered `501`: `check` (it needs the model's tokenizer on disk).
 */

import { formatWall } from "../../../core/log/clock.ts";
import { isAgentAuthor } from "../../../core/log/events.ts";
import type { CallView } from "../../../core/log/fold.ts";
import { ProviderError } from "../../llm/provider.ts";
import { reasonText } from "../../query/ask.ts";
import { STOPWORDS } from "../../query/bm25.ts";
import {
  emptyVocab,
  importGlossary,
  type LoadedVocab,
  mergeVocab,
  readVocabFile,
  removeEntry,
  termKey,
  upsertEntry,
  type VocabEntry,
  type VocabFile,
  validateTerm,
  validWorkspace,
  vocabPaths,
  writeVocabFile,
} from "../../vocab/files.ts";
import { type KnownTerm, type PassInput, runPass } from "../../vocab/pass.ts";
import { suggestTerms } from "../../vocab/suggest.ts";
import { HttpError, json, type RouteDoc, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { CALL_ID, callId, callOf, nextItemId, resolveRef } from "./common.ts";

function notBuilt(what: string, when: string): never {
  throw new HttpError(501, "not_implemented", `${what} is not built yet (${when})`);
}

function checkTermOr400(term: unknown): string {
  const bad = validateTerm(term);
  if (bad) throw new HttpError(400, "bad_term", `${JSON.stringify(term)}: ${bad}`, { term });
  return term as string;
}

function checkWorkspace(ws: string | undefined | null): string | undefined {
  if (ws === undefined || ws === null || ws === "") return undefined;
  if (!validWorkspace(ws)) throw new HttpError(400, "bad_workspace", `invalid workspace "${ws}"`);
  return ws;
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Calls with a vocabulary pass running: one at a time per call. */
const passing = new Set<string>();

/** Edits of one file run one at a time, so two requests never lose each other's change. */
const fileLocks = new Map<string, Promise<unknown>>();
async function editFile<T>(
  path: string,
  edit: (file: VocabFile, loaded: LoadedVocab) => { file: VocabFile; result: T } | null,
): Promise<T | null> {
  const prev = fileLocks.get(path) ?? Promise.resolve();
  const run = prev.then(async () => {
    const loaded = await readVocabFile(path);
    // A rewrite keeps only what parsed: an edit to a file with any error would delete the bad part.
    if (loaded.errors.length > 0 && loaded.exists) {
      throw new HttpError(409, "vocab_file_invalid", `${path}: ${loaded.errors[0]?.message}`);
    }
    const out = edit(loaded.file, loaded);
    if (!out) return null;
    await writeVocabFile(path, out.file);
    return out.result;
  });
  const settled = run.catch(() => {});
  fileLocks.set(path, settled);
  settled.then(() => {
    if (fileLocks.get(path) === settled) fileLocks.delete(path);
  });
  return run;
}

function targetPath(app: ApiApp, workspace: string | undefined): string {
  const paths = vocabPaths({ configDir: app.configDir, workspace });
  return (paths.find((p) => p.scope === (workspace ? "workspace" : "global")) as { path: string })
    .path;
}

async function mergedFor(app: ApiApp, workspace: string | undefined) {
  const extra = app.config().settings["vocab.extraFiles"];
  const paths = vocabPaths({ configDir: app.configDir, workspace, extra });
  const layers = await Promise.all(
    paths.map(async (p) => ({ ...p, loaded: await readVocabFile(p.path) })),
  );
  return {
    files: layers.map((l) => ({
      scope: l.scope,
      path: l.path,
      exists: l.loaded.exists,
      sha256: l.loaded.sha256,
      errors: l.loaded.errors,
      warnings: l.loaded.warnings,
    })),
    entries: mergeVocab(layers.map((l) => ({ scope: l.scope, path: l.path, file: l.loaded.file }))),
    rejected: [...new Set(layers.flatMap((l) => l.loaded.file.rejected))],
  };
}

/**
 * What a call's pass and suggestions treat as known (confirmed file entries, the call's own words,
 * accepted proposals, speaker names, the user's name) and what the user rejected.
 */
async function vocabState(app: ApiApp, view: CallView) {
  const files = await mergedFor(app, view.call?.workspace);
  const known = new Map<string, KnownTerm & { heard: string[] }>();
  const put = (term: string, heard: readonly string[]) => {
    const key = termKey(term);
    if (key === "") return;
    const cur = known.get(key) ?? { term, heard: [] };
    for (const h of heard) if (!cur.heard.some((x) => termKey(x) === termKey(h))) cur.heard.push(h);
    known.set(key, cur);
  };
  for (const e of files.entries) if (e.confirmed) put(e.term, e.heard);
  for (const v of view.callVocabulary()) put(v.term, v.heard);
  for (const p of view.proposals("accepted")) put(p.term, p.heard);
  for (const r of view.roster()) if (r.name) put(r.name, []);
  if (view.call?.user) put(view.call.user, []);
  const rejected = new Set(files.rejected);
  for (const p of view.proposals("rejected")) rejected.add(p.term);
  const input: PassInput = { known: [...known.values()], rejected: [...rejected] };
  return { input, files };
}

/** The words to review for a call: its open proposals with the lines they rest on. */
function reviewList(view: CallView, unconfirmed: readonly VocabEntry[]) {
  const tz = view.call?.tz ?? "UTC";
  return {
    proposals: view.proposals("proposed").map((p) => {
      const ev = (p.evidence ?? {}) as { lines?: unknown; why?: unknown };
      const ids = Array.isArray(ev.lines) ? ev.lines.filter((x) => typeof x === "string") : [];
      return {
        id: p.id,
        term: p.term,
        heard: p.heard,
        by: p.by,
        why: typeof ev.why === "string" ? ev.why : undefined,
        lines: (ids as string[]).flatMap((id) => {
          const l = view.resolve(id);
          if (!l || l.retracted) return [];
          return [{ id, time: formatWall(l.w0, tz), speaker: l.speaker, text: l.raw ?? l.text }];
        }),
      };
    }),
    unconfirmed: unconfirmed.map((e) => ({ term: e.term, heard: e.heard, source: e.source })),
  };
}

/** A route of this file: app mode, admin. */
function doc(d: Omit<RouteDoc, "access" | "modes">): RouteDoc {
  return { access: "admin", modes: ["app"], ...d };
}

const WORKSPACE = {
  type: "string",
  doc: "The workspace whose file this is; default: the global file.",
} as const;

export function vocabRoutes(r: Router<ApiApp>): void {
  // --- per call ---------------------------------------------------------------------------------

  r.add(
    "GET",
    "/calls/:id/vocab",
    doc({
      id: "callVocab.list",
      doc: "The vocabulary in force for a call: its own words, the files it used, the pass's proposals, and the words waiting for the user's review.",
      params: { id: CALL_ID },
      ok: 200,
    }),
    async (c) => {
      const call = await callOf(c);
      const v = call.view;
      const files = await mergedFor(c.app, v.call?.workspace);
      return json(200, {
        call: call.id,
        callVocab: v.callVocabulary(),
        used: v.vocabUsed
          ? { entries: v.vocabUsed.entries, files: v.vocabUsed.files, model: v.vocabUsed.model }
          : null,
        proposals: v.proposals(),
        review: reviewList(
          v,
          files.entries.filter((e) => !e.confirmed),
        ),
        files: files.files,
        entries: files.entries,
      });
    },
  );

  r.add(
    "POST",
    "/calls/:id/vocab",
    doc({
      id: "callVocab.add",
      doc: "Add a word to this call only: `term` as it should read, `heard` the ways the recognizer wrote it, `segs` the lines it corrects. It applies to reading at once and to decoding from now on; `decode: false` keeps it out of decoding.",
      params: { id: CALL_ID },
      body: { term: "string", "heard?": "string[]", "segs?": "string[]", "decode?": "boolean" },
      ok: 201,
    }),
    async (c) => {
      const b = await c.body<{
        term: string;
        heard?: string[];
        segs?: string[];
        decode?: boolean;
      }>();
      const term = checkTermOr400(b.term);
      const heard = (b.heard ?? []).map((h) => h.trim()).filter((h) => h !== "");
      for (const h of heard) checkTermOr400(h);
      const id = callId(c);
      const e = await c.app.write(id, (call) => ({
        type: "vocab.add",
        id: nextItemId("v", call.view.lastSeq),
        rev: 1,
        term,
        heard: heard.filter((h) => termKey(h) !== termKey(term)),
        by: c.by,
        ...(b.segs ? { segs: b.segs } : {}),
        ...(b.decode === false ? { decode: false } : {}),
      }));
      return json(201, { ok: true, call: id, vocab: e });
    },
  );

  r.add(
    "DELETE",
    "/calls/:id/vocab/:vid",
    doc({
      id: "callVocab.delete",
      doc: "Retract a word added to this call. The log keeps it, with the retraction after it.",
      params: { id: CALL_ID, vid: "The entry id (`v0012`)." },
      body: {},
      ok: 200,
    }),
    async (c) => {
      await c.body();
      const id = callId(c);
      const e = await c.app.write(id, (call) => {
        const cur = call.view.callVocabulary().find((x) => x.id === c.params.vid);
        if (!cur) throw new HttpError(404, "not_found", `no call vocabulary entry ${c.params.vid}`);
        return { type: "vocab.add", id: cur.id, rev: cur.rev + 1, term: null, by: c.by };
      });
      return json(200, { ok: true, call: id, vocab: e });
    },
  );

  r.add(
    "POST",
    "/calls/:id/vocab/pass",
    doc({
      id: "callVocab.pass",
      doc: "Run the vocabulary pass on an ended call: the configured provider corrects known words and proposes new ones. A proposal does nothing until the user approves it.",
      params: { id: CALL_ID },
      body: {},
      ok: 200,
    }),
    async (c) => {
      await c.body();
      const id = callId(c, { allowLast: true });
      const q = await c.app.query(id);
      const view = q.view;
      if (view.live) {
        throw new HttpError(
          409,
          "not_ended",
          "the vocabulary pass reads a finished call; run it after the call ends",
        );
      }
      const provider = c.app.provider();
      const avail = await provider.available();
      if (!avail.ok) {
        return json(503, {
          error: "provider_unavailable",
          message: `no provider can run the vocabulary pass (${avail.reason}); an agent can propose words with akou_vocab_propose`,
          reason: avail.reason,
          kind: avail.kind,
        });
      }
      if (passing.has(id)) {
        throw new HttpError(409, "pass_running", "the vocabulary pass of this call is running");
      }
      passing.add(id);
      c.timeout?.(0);
      try {
        const { input } = await vocabState(c.app, view);
        let r: Awaited<ReturnType<typeof runPass>>;
        try {
          r = await runPass({
            view,
            tz: q.tz,
            input,
            provider,
            signal: c.req.signal,
            timeoutMs: c.app.providerTimeoutMs(),
          });
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err;
          if (err.kind === "cancelled") {
            return json(499, { error: "cancelled", message: "the vocabulary pass was cancelled" });
          }
          const reason = reasonText(err, q.tz);
          return json(503, {
            error: "provider_unavailable",
            message: `the provider could not run the vocabulary pass (${reason})`,
            reason,
            kind: err.kind,
            resetsAt: err.resetsAt,
          });
        }
        const written: unknown[] = [];
        for (const d of r.drafts) {
          const prefix = d.type === "vocab.add" ? "v" : "p";
          // Ids come from the seq each event gets, so they never collide with another writer's.
          written.push(
            await c.app.write(id, (call) => ({
              ...d,
              id: nextItemId(prefix, call.view.lastSeq),
            })),
          );
        }
        return json(200, {
          ok: true,
          call: id,
          model: r.model,
          calls: r.calls,
          lines: r.lines,
          corrections: r.corrections,
          proposals: r.proposals,
          dropped: r.dropped,
          written: written.length,
        });
      } finally {
        passing.delete(id);
      }
    },
  );

  // --- the files ----------------------------------------------------------------------------------

  r.add(
    "GET",
    "/vocab",
    doc({
      id: "vocab.list",
      doc: "The user's vocabulary: the files read and their entries, global and for a workspace.",
      query: {
        workspace: WORKSPACE,
        unconfirmed: { type: "boolean", doc: "Only the entries waiting for the user's yes." },
      },
      ok: 200,
    }),
    async (c) => {
      const workspace = checkWorkspace(c.query.raw("workspace"));
      const out = await mergedFor(c.app, workspace);
      const unconfirmed = c.query.raw("unconfirmed");
      const entries =
        unconfirmed === "true" || unconfirmed === ""
          ? out.entries.filter((e) => !e.confirmed)
          : out.entries;
      return json(200, { workspace: workspace ?? null, files: out.files, entries });
    },
  );

  r.add(
    "POST",
    "/vocab",
    doc({
      id: "vocab.add",
      doc: "Add or update a word in the user's vocabulary file. A word the user stated goes in confirmed; send `confirmed: false` for an inferred one, which does nothing until the user approves it.",
      body: {
        term: "string",
        "heard?": "string[]",
        "workspace?": "string",
        "decode?": "boolean",
        "note?": "string",
        "confirmed?": "boolean",
      },
      ok: 201,
    }),
    async (c) => {
      const b = await c.body<{
        term: string;
        heard?: string[];
        workspace?: string;
        decode?: boolean;
        note?: string;
        confirmed?: boolean;
      }>();
      const term = checkTermOr400(b.term);
      const workspace = checkWorkspace(b.workspace);
      // A word the user stated goes in confirmed; an inferred one is sent with `confirmed: false`
      // (or as a call proposal) and does nothing until the user approves it.
      const confirmed = b.confirmed ?? true;
      const entry: VocabEntry = {
        term,
        heard: (b.heard ?? [])
          .map((h) => h.trim())
          .filter((h) => h !== "" && termKey(h) !== termKey(term)),
        source: isAgentAuthor(c.by) ? `agent:${c.by.slice("agent:".length)}` : "user",
        confirmed,
        added_at: today(c.app.now()),
        ...(b.decode === false ? { decode: false } : {}),
        ...(b.note ? { note: b.note } : {}),
      };
      const path = targetPath(c.app, workspace);
      try {
        await editFile(path, (file) => ({ file: upsertEntry(file, entry), result: null }));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, "bad_entry", (err as Error).message);
      }
      c.app.vocabChanged();
      return json(201, { ok: true, path, entry });
    },
  );

  r.add(
    "DELETE",
    "/vocab/:term",
    doc({
      id: "vocab.delete",
      doc: "Remove a word from the user's vocabulary file.",
      params: { term: "The word, as written in the file." },
      query: { workspace: WORKSPACE },
      body: {},
      ok: 200,
    }),
    async (c) => {
      await c.body();
      const workspace = checkWorkspace(c.query.raw("workspace"));
      const path = targetPath(c.app, workspace);
      const term = c.params.term as string;
      const removed = await editFile(path, (file) => {
        const next = removeEntry(file, term);
        return next.entries.length === file.entries.length ? null : { file: next, result: true };
      });
      if (!removed) throw new HttpError(404, "not_found", `"${term}" is not in ${path}`);
      c.app.vocabChanged();
      return json(200, { ok: true, path, term });
    },
  );

  for (const action of ["approve", "reject"] as const) {
    r.add(
      "POST",
      `/vocab/${action}`,
      doc({
        id: `vocab.${action}`,
        doc:
          action === "approve"
            ? "Approve words: unconfirmed entries of the file, or a call's proposals when `call` is named, which are then written into the file, confirmed."
            : "Reject words: unconfirmed entries of the file, or a call's proposals when `call` is named. A rejected word is not proposed again.",
        body: { terms: "string[]", "call?": "string", "workspace?": "string" },
        ok: 200,
      }),
      async (c) => {
        const b = await c.body<{ terms: string[]; call?: string; workspace?: string }>();
        if (b.terms.length === 0) throw new HttpError(400, "bad_field", "terms is empty");
        const keys = new Set(b.terms.map(termKey));
        const status = action === "approve" ? "accepted" : "rejected";
        let workspace = checkWorkspace(b.workspace);
        const done: string[] = [];
        const accepted: VocabEntry[] = [];
        if (b.call) {
          // Outside `/calls`, so the server did not wait for recovery to index the calls: wait here.
          await c.app.manager.init();
          const id = resolveRef(c.app, b.call, { allowLast: false });
          const call = await c.app.call(id);
          workspace ??= call.view.call?.workspace;
          const open = call.view.proposals("proposed").filter((p) => keys.has(termKey(p.term)));
          for (const p of open) {
            await c.app.write(id, {
              type: "vocab.propose",
              id: p.id,
              rev: p.rev + 1,
              term: p.term,
              heard: p.heard,
              by: c.by,
              evidence: p.evidence,
              status,
            });
            done.push(p.term);
            if (status === "accepted") {
              accepted.push({
                term: p.term,
                heard: p.heard,
                source: `call:${id}`,
                confirmed: true,
                added_at: today(c.app.now()),
              });
            }
          }
        }
        const path = targetPath(c.app, workspace);
        await editFile(path, (file) => {
          let next: VocabFile = file;
          for (const e of accepted) {
            // A proposal for a term the file has adds its heard forms; it never drops the old ones.
            const cur = next.entries.find((x) => termKey(x.term) === termKey(e.term));
            const heard = [...(cur?.heard ?? [])];
            for (const h of e.heard)
              if (!heard.some((x) => termKey(x) === termKey(h))) heard.push(h);
            next = upsertEntry(next, cur ? { ...cur, heard, confirmed: true } : e);
          }
          // Over `next`, not `file`: a term a call's proposal just confirmed keeps its merged heard
          // forms, and is counted once.
          for (const e of next.entries) {
            if (!keys.has(termKey(e.term)) || e.confirmed) continue;
            next =
              action === "approve"
                ? upsertEntry(next, { ...e, confirmed: true })
                : removeEntry(next, e.term);
            done.push(e.term);
          }
          if (action === "reject") {
            const rejected = new Set(next.rejected);
            for (const t of b.terms) rejected.add(t);
            next = { ...next, rejected: [...rejected] };
          }
          return next === file ? null : { file: next, result: null };
        });
        c.app.vocabChanged();
        return json(200, {
          ok: true,
          path,
          [action === "approve" ? "approved" : "rejected"]: done,
        });
      },
    );
  }

  r.add(
    "POST",
    "/vocab/import",
    doc({
      id: "vocab.import",
      doc: "Import a word list into the user's vocabulary file, confirmed: one word per line, or the predecessor's `Word <= heard | heard` lines.",
      body: { text: "string", "workspace?": "string" },
      ok: 200,
    }),
    async (c) => {
      const b = await c.body<{ text: string; workspace?: string }>();
      const workspace = checkWorkspace(b.workspace);
      const res = importGlossary(b.text, { source: "import:api", date: today(c.app.now()) });
      const path = targetPath(c.app, workspace);
      if (res.entries.length > 0) {
        await editFile(path, (file) => {
          let next = file ?? emptyVocab();
          for (const e of res.entries) next = upsertEntry(next, e);
          return { file: next, result: null };
        });
        c.app.vocabChanged();
      }
      return json(200, { ok: true, path, imported: res.entries.length, skipped: res.skipped });
    },
  );

  r.add(
    "POST",
    "/vocab/suggest",
    doc({
      id: "vocab.suggest",
      doc: "Ranked candidate words from a call or from a text, leaving out words already known or rejected. Suggests only; nothing is written.",
      body: { "text?": "string", "call?": "string", "k?": "integer" },
      ok: 200,
    }),
    async (c) => {
      const b = await c.body<{ text?: string; call?: string; k?: number }>();
      const k = b.k ?? 20;
      if (k < 1 || k > 200) throw new HttpError(400, "bad_field", "k must be 1 to 200");
      if (b.text === undefined && b.call === undefined) {
        throw new HttpError(400, "bad_field", "suggest needs `text` or `call`");
      }
      const stopwords = new Set(Object.values(STOPWORDS).flatMap((set) => [...set]));
      const sources: { text: string; id?: string }[] = [];
      let known: string[];
      let rejected: string[];
      let call: string | undefined;
      if (b.call !== undefined) {
        await c.app.manager.init();
        call = resolveRef(c.app, b.call, { allowLast: true });
        const view = (await c.app.call(call)).view;
        for (const l of view.lines("best")) sources.push({ text: l.raw ?? l.text, id: l.id });
        const st = await vocabState(c.app, view);
        known = st.input.known.map((x) => x.term);
        rejected = [...st.input.rejected];
        for (const e of st.files.entries) if (!e.confirmed) known.push(e.term);
        for (const p of view.proposals("proposed")) known.push(p.term);
      } else {
        const files = await mergedFor(c.app, undefined);
        known = files.entries.map((e) => e.term);
        rejected = files.rejected;
      }
      if (b.text !== undefined) sources.push({ text: b.text });
      const suggestions = suggestTerms(sources, { known, rejected, stopwords, k });
      return json(200, { call: call ?? null, suggestions });
    },
  );

  r.add(
    "POST",
    "/vocab/check",
    doc({
      id: "vocab.check",
      doc: "How the recognizer's tokenizer splits a word. Not built yet: answers 501.",
      body: { term: "string" },
      ok: 200,
    }),
    async (c) => {
      await c.body();
      notBuilt("the decode check", "it needs the recognizer's tokenizer from the models folder");
    },
  );
}
