/**
 * After the call (docs/DESIGN.md sections 5.2, 6.2 and 8.2): the final pass, audio, enhancement and
 * export. `last` is accepted on `finalize`, `export` and `enhance`.
 *
 * - `POST /calls/{id}/finalize` and `GET /calls/{id}/audio/{part}` (with range requests).
 * - `POST /calls/{id}/enhance {template}`: the configured provider writes the notes (on a live call:
 *   "enhance so far"). `503 provider_unavailable` with the reason when it cannot, never an empty
 *   success.
 * - `GET /calls/{id}/enhance/context?template=` and `PUT /calls/{id}/enhanced {markdown,
 *   coversSeq}`: an agent writes the notes itself; the same citation check and verbatim rule apply.
 * - Export is the hand-off module and answers `501` until it is built.
 */

import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { ProviderError } from "../../llm/provider.ts";
import {
  buildEnhanceInput,
  composeNotes,
  ENHANCE_SYSTEM,
  type EnhanceResult,
  enhance,
  enhancedDraft,
  nextEnhancedRev,
  storeEnhanced,
  userNotes,
} from "../../notes/enhance.ts";
import { chooseTemplate, type Template, TemplateError } from "../../notes/templates.ts";
import { reasonText } from "../../query/ask.ts";
import type { CallQuery } from "../../query/context.ts";
import { HttpError, json, outcome, type Router, readBody } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { callId, callOf } from "./common.ts";

/** Calls with an enhancement being written: one at a time per call, so revisions never race. */
const enhancing = new Set<string>();

async function exclusive(id: string, fn: () => Promise<Response>): Promise<Response> {
  if (enhancing.has(id)) {
    throw new HttpError(409, "enhance_running", "the notes of this call are being written already");
  }
  enhancing.add(id);
  try {
    return await fn();
  } finally {
    enhancing.delete(id);
  }
}

function pickTemplate(app: ApiApp, q: CallQuery, explicit: string | undefined): Template {
  try {
    return chooseTemplate(app.templates(), {
      explicit,
      callTemplate: q.view.call?.template,
      title: q.view.call?.title,
    });
  } catch (err) {
    if (err instanceof TemplateError) throw new HttpError(400, "bad_template", err.message);
    throw err;
  }
}

/** Writes the revision's files, then its `enhanced` event. */
async function store(
  app: ApiApp,
  id: string,
  o: {
    markdown: string;
    template: string;
    coversSeq: number;
    by: string;
    model: string;
    cites: string[];
  },
): Promise<{ rev: number; file: string; seq: number }> {
  const call = await app.call(id);
  const rev = nextEnhancedRev(call.view);
  const file = storeEnhanced(call.dir, rev, o.template, o.markdown);
  const e = await app.write(id, enhancedDraft({ rev, ...o }));
  return { rev, file, seq: e.seq };
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`, one range only. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

export function postCallRoutes(r: Router<ApiApp>): void {
  r.add("POST", "/calls/:id/finalize", async (c) => {
    const b = await readBody<{ force?: boolean }>(c.req, { "force?": "boolean" });
    const id = callId(c, { allowLast: true });
    return outcome(await c.app.finalize(id, { force: b.force }), 202);
  });

  r.add("POST", "/calls/:id/export", async (c) => {
    await readBody(c.req, { "to?": "string" });
    callId(c, { allowLast: true });
    throw new HttpError(501, "not_implemented", "export is not built yet (the hand-off module)");
  });

  r.add("POST", "/calls/:id/enhance", async (c) => {
    const b = await readBody<{ template?: string }>(c.req, { "template?": "string" });
    const id = callId(c, { allowLast: true });
    const q = await c.app.query(id);
    const template = pickTemplate(c.app, q, b.template);
    const provider = c.app.provider();
    const avail = await provider.available();
    if (!avail.ok) {
      return json(503, {
        error: "provider_unavailable",
        message: `no provider can write the notes (${avail.reason}); an agent can write them with GET enhance/context and PUT enhanced`,
        reason: avail.reason,
        kind: avail.kind,
      });
    }
    c.timeout?.(0);
    return exclusive(id, async () => {
      let r: EnhanceResult;
      try {
        r = await enhance({
          q,
          template,
          provider,
          now: c.app.now(),
          write: (d) => c.app.write(id, d),
          signal: c.req.signal,
          timeoutMs: c.app.providerTimeoutMs(),
        });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (err.kind === "cancelled") {
          return json(499, { error: "cancelled", message: "the enhancement was cancelled" });
        }
        const reason = reasonText(err, q.tz);
        return json(503, {
          error: "provider_unavailable",
          message: `the provider could not write the notes (${reason})`,
          reason,
          kind: err.kind,
          resetsAt: err.resetsAt,
        });
      }
      const stored = await store(c.app, id, {
        markdown: r.markdown,
        template: template.name,
        coversSeq: r.coversSeq,
        by: c.by,
        model: r.model,
        cites: r.cites,
      });
      return json(200, {
        ok: true,
        call: id,
        ...stored,
        template: template.name,
        markdown: r.markdown,
        model: r.model,
        mode: r.mode,
        coversSeq: r.coversSeq,
        cites: r.cites,
        dropped: r.dropped,
        appended: r.appended,
        mapCalls: r.mapCalls,
        live: q.view.live,
      });
    });
  });

  r.add("GET", "/calls/:id/enhance/context", async (c) => {
    const id = callId(c);
    const q = await c.app.query(id);
    const template = pickTemplate(c.app, q, c.url.searchParams.get("template") || undefined);
    const input = buildEnhanceInput(q, template, { now: c.app.now() });
    return json(200, {
      call: id,
      template: template.name,
      instructions: ENHANCE_SYSTEM,
      input: input.prompt,
      tokens: input.tokens,
      mode: input.mode,
      coversSeq: input.coversSeq,
      notes: input.userNotes.map((n) => ({ id: n.id, text: n.text, w: n.w })),
      missingSummaries: input.pending.map((p) => ({ from: p.from, to: p.to })),
      hint:
        input.mode === "chunked"
          ? "the transcript is too long to include whole; read the stretches not summarised yet with akou_read or akou_search"
          : undefined,
    });
  });

  r.add("PUT", "/calls/:id/enhanced", async (c) => {
    const b = await readBody<{ markdown: string; coversSeq: number; template?: string }>(c.req, {
      markdown: "string",
      coversSeq: "integer",
      "template?": "string",
    });
    if (b.markdown.trim() === "") throw new HttpError(400, "bad_field", "markdown is empty");
    if (b.markdown.length > 60_000) {
      throw new HttpError(400, "bad_field", "markdown is over 60000 characters");
    }
    const id = callId(c);
    const q = await c.app.query(id);
    if (b.coversSeq < 0 || b.coversSeq > q.view.lastSeq) {
      throw new HttpError(400, "bad_field", `coversSeq must be 0 to ${q.view.lastSeq}`);
    }
    const template = pickTemplate(c.app, q, b.template);
    return exclusive(id, async () => {
      // The same rules as a provider's notes: the user's lines verbatim, every bullet cited.
      const composed = composeNotes(b.markdown, {
        view: q.view,
        tz: q.tz,
        maxSeq: b.coversSeq,
        notes: userNotes(q.view),
      });
      const stored = await store(c.app, id, {
        markdown: composed.markdown,
        template: template.name,
        coversSeq: b.coversSeq,
        by: c.by,
        model: c.by,
        cites: composed.check.cites,
      });
      return json(200, {
        ok: true,
        call: id,
        ...stored,
        template: template.name,
        markdown: composed.markdown,
        cites: composed.check.cites,
        dropped: composed.check.dropped,
        appended: composed.appended,
      });
    });
  });

  r.add("GET", "/calls/:id/audio/:part", async (c) => {
    const call = await callOf(c);
    const n = Number(c.params.part);
    const part = Number.isInteger(n) ? call.view.part(n) : undefined;
    if (!part)
      throw new HttpError(404, "not_found", `call ${call.id} has no part ${c.params.part}`);
    const path = normalize(join(call.dir, part.file));
    if (!path.startsWith(normalize(call.dir) + sep) || !existsSync(path)) {
      throw new HttpError(404, "not_found", `the audio of part ${n} is missing`);
    }
    const size = statSync(path).size;
    const file = Bun.file(path);
    const headers = {
      "content-type": "audio/ogg",
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    };
    const range = c.req.headers.get("range");
    if (range === null) {
      return new Response(file, { headers: { ...headers, "content-length": String(size) } });
    }
    const rg = parseRange(range, size);
    if (!rg) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    return new Response(file.slice(rg.start, rg.end + 1), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${rg.start}-${rg.end}/${size}`,
        "content-length": String(rg.end - rg.start + 1),
      },
    });
  });
}
