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
 * Not built yet, answered `501`: the post-call pass (`/calls/{id}/vocab/pass`, M2), `suggest` (M2)
 * and `check` (it needs the model's tokenizer on disk).
 */

import { isAgentAuthor } from "../../../core/log/events.ts";
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
import { HttpError, json, type Router, readBody } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { callId, callOf, nextItemId, resolveRef } from "./common.ts";

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
  };
}

export function vocabRoutes(r: Router<ApiApp>): void {
  // --- per call ---------------------------------------------------------------------------------

  r.add("GET", "/calls/:id/vocab", async (c) => {
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
      files: files.files,
      entries: files.entries,
    });
  });

  r.add("POST", "/calls/:id/vocab", async (c) => {
    const b = await readBody<{ term: string; heard?: string[]; segs?: string[]; decode?: boolean }>(
      c.req,
      { term: "string", "heard?": "string[]", "segs?": "string[]", "decode?": "boolean" },
    );
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
  });

  r.add("DELETE", "/calls/:id/vocab/:vid", async (c) => {
    await readBody(c.req, {});
    const id = callId(c);
    const e = await c.app.write(id, (call) => {
      const cur = call.view.callVocabulary().find((x) => x.id === c.params.vid);
      if (!cur) throw new HttpError(404, "not_found", `no call vocabulary entry ${c.params.vid}`);
      return { type: "vocab.add", id: cur.id, rev: cur.rev + 1, term: null, by: c.by };
    });
    return json(200, { ok: true, call: id, vocab: e });
  });

  r.add("POST", "/calls/:id/vocab/pass", async (c) => {
    await readBody(c.req, {});
    resolveRef(c.app, c.params.id as string, { allowLast: false });
    notBuilt("the post-call vocabulary pass", "M2");
  });

  // --- the files ----------------------------------------------------------------------------------

  r.add("GET", "/vocab", async (c) => {
    const workspace = checkWorkspace(c.url.searchParams.get("workspace"));
    const out = await mergedFor(c.app, workspace);
    const unconfirmed = c.url.searchParams.get("unconfirmed");
    const entries =
      unconfirmed === "true" || unconfirmed === ""
        ? out.entries.filter((e) => !e.confirmed)
        : out.entries;
    return json(200, { workspace: workspace ?? null, files: out.files, entries });
  });

  r.add("POST", "/vocab", async (c) => {
    const b = await readBody<{
      term: string;
      heard?: string[];
      workspace?: string;
      decode?: boolean;
      note?: string;
      confirmed?: boolean;
    }>(c.req, {
      term: "string",
      "heard?": "string[]",
      "workspace?": "string",
      "decode?": "boolean",
      "note?": "string",
      "confirmed?": "boolean",
    });
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
  });

  r.add("DELETE", "/vocab/:term", async (c) => {
    await readBody(c.req, {});
    const workspace = checkWorkspace(c.url.searchParams.get("workspace"));
    const path = targetPath(c.app, workspace);
    const term = c.params.term as string;
    const removed = await editFile(path, (file) => {
      const next = removeEntry(file, term);
      return next.entries.length === file.entries.length ? null : { file: next, result: true };
    });
    if (!removed) throw new HttpError(404, "not_found", `"${term}" is not in ${path}`);
    c.app.vocabChanged();
    return json(200, { ok: true, path, term });
  });

  for (const action of ["approve", "reject"] as const) {
    r.add("POST", `/vocab/${action}`, async (c) => {
      const b = await readBody<{ terms: string[]; call?: string; workspace?: string }>(c.req, {
        terms: "string[]",
        "call?": "string",
        "workspace?": "string",
      });
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
        for (const e of accepted) next = upsertEntry(next, e);
        for (const e of file.entries) {
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
      return json(200, { ok: true, path, [action === "approve" ? "approved" : "rejected"]: done });
    });
  }

  r.add("POST", "/vocab/import", async (c) => {
    const b = await readBody<{ text: string; workspace?: string }>(c.req, {
      text: "string",
      "workspace?": "string",
    });
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
  });

  r.add("POST", "/vocab/suggest", async (c) => {
    await readBody(c.req, { "text?": "string", "call?": "string", "k?": "integer" });
    notBuilt("vocabulary suggestions", "M2");
  });

  r.add("POST", "/vocab/check", async (c) => {
    await readBody(c.req, { term: "string" });
    notBuilt("the decode check", "it needs the recognizer's tokenizer from the models folder");
  });
}
