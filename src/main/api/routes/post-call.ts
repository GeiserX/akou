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
 * - Export and hooks are the hand-off, in `handoff.ts`.
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
  enhanceExclusive,
  nextEnhancedRev,
  reEnhanceState,
  storeEnhanced,
  userNotes,
} from "../../notes/enhance.ts";
import { chooseTemplate, type Template, TemplateError } from "../../notes/templates.ts";
import { reasonText } from "../../query/ask.ts";
import type { CallQuery } from "../../query/context.ts";
import { HttpError, json, outcome, type RouteDoc, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { CALL_ID, callId, callOf } from "./common.ts";

async function exclusive(id: string, fn: () => Promise<Response>): Promise<Response> {
  const r = await enhanceExclusive(id, fn);
  if (r === null) {
    throw new HttpError(409, "enhance_running", "the notes of this call are being written already");
  }
  return r;
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

/** A route of this file: app mode, admin, on one call. */
function doc(d: Omit<RouteDoc, "access" | "modes">): RouteDoc {
  return { access: "admin", modes: ["app"], ...d, params: { id: CALL_ID, ...d.params } };
}

export function postCallRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/calls/:id/finalize",
    doc({
      id: "calls.finalize",
      doc: "Run the final pass on an ended call, the best transcript akou can make. Answers at once; the pass runs after. It runs by itself after every call, so this is for a pass that failed or for `force` to run it again.",
      body: { "force?": "boolean" },
      ok: 202,
    }),
    async (c) => {
      const b = await c.body<{ force?: boolean }>();
      const id = callId(c, { allowLast: true });
      return outcome(await c.app.finalize(id, { force: b.force }), 202);
    },
  );

  r.add(
    "POST",
    "/calls/:id/enhance",
    doc({
      id: "enhanced.create",
      doc: "Write the call's enhanced notes with the configured provider, from the transcript and the user's notepad, in a template's sections, citing the transcript. With no provider, an agent writes them with enhanced.context and enhanced.put.",
      body: { "template?": "string" },
      ok: 200,
    }),
    async (c) => {
      const b = await c.body<{ template?: string }>();
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
    },
  );

  r.add(
    "GET",
    "/calls/:id/enhance/context",
    doc({
      id: "enhanced.context",
      doc: "What an agent needs to write the enhanced notes itself: the instructions, the input built from the transcript and the notepad, and the log position it covers. Send the result with enhanced.put.",
      query: { template: { type: "string", doc: "The template to use; default: the call's own." } },
      ok: 200,
    }),
    async (c) => {
      const id = callId(c);
      const q = await c.app.query(id);
      const template = pickTemplate(c.app, q, c.query.raw("template") || undefined);
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
    },
  );

  r.add(
    "PUT",
    "/calls/:id/enhanced",
    doc({
      id: "enhanced.put",
      doc: "Store enhanced notes an agent wrote, covering the log up to `coversSeq`. Citations are checked against the transcript and the user's notes are kept.",
      body: { markdown: "string", coversSeq: "integer", "template?": "string" },
      ok: 200,
    }),
    async (c) => {
      const b = await c.body<{ markdown: string; coversSeq: number; template?: string }>();
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
    },
  );

  r.add(
    "GET",
    "/calls/:id/enhanced",
    doc({
      id: "enhanced.get",
      doc: "The call's enhanced notes as Markdown, the latest revision or the one `rev` names, with the list of revisions.",
      query: {
        rev: { type: "integer", min: 1, max: 1_000_000, doc: "One revision; default: the latest." },
      },
      ok: 200,
    }),
    async (c) => {
      const call = await callOf(c);
      const all = call.view.enhanced();
      const want = c.query.int("rev");
      const e = want === undefined ? call.view.latestEnhanced() : all.find((x) => x.rev === want);
      if (!e) {
        if (want === undefined) {
          return json(200, { call: call.id, enhanced: null, revisions: [], reEnhance: null });
        }
        throw new HttpError(404, "not_found", `call ${call.id} has no enhanced notes rev ${want}`);
      }
      const path = normalize(join(call.dir, e.file));
      if (!path.startsWith(normalize(call.dir) + sep) || !existsSync(path)) {
        throw new HttpError(404, "not_found", `the file of enhanced notes rev ${e.rev} is missing`);
      }
      return json(200, {
        call: call.id,
        enhanced: {
          rev: e.rev,
          template: e.template,
          coversSeq: e.coversSeq,
          by: e.by,
          model: e.model,
          cites: e.cites,
          markdown: await Bun.file(path).text(),
        },
        revisions: all.map((x) => ({ rev: x.rev, template: x.template, by: x.by, model: x.model })),
        reEnhance: reEnhanceState(call.view, c.app.provider().id),
      });
    },
  );

  r.add(
    "GET",
    "/calls/:id/audio/:part",
    doc({
      id: "audio.get",
      doc: "The audio of one part of the call, as Ogg. Honours `Range`.",
      params: { part: "The part number, from 1." },
      ok: 200,
      type: "audio",
    }),
    async (c) => {
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
    },
  );
}
