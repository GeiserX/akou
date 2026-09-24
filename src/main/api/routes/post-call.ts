/**
 * After the call (docs/DESIGN.md sections 5.2, 6.2 and 8.2): the final pass, audio, enhancement and
 * export. `last` is accepted on `finalize`, `export` and `enhance`.
 *
 * Built: `POST /calls/{id}/finalize` and `GET /calls/{id}/audio/{part}` (with range requests).
 * Not built yet, answered plainly: enhancement needs a provider (`503 provider_unavailable`) or the
 * notes module (`501`, M2), and export is the hand-off module (`501`, M1 hand-off).
 */

import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { HttpError, json, outcome, type Router, readBody } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { callId, callOf } from "./common.ts";

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
    await readBody(c.req, { "template?": "string" });
    callId(c, { allowLast: true });
    return json(503, {
      error: "provider_unavailable",
      message: "no provider is configured; enhancement by akou needs one",
      reason: "no provider in this build",
    });
  });

  r.add("GET", "/calls/:id/enhance/context", async (c) => {
    callId(c);
    throw new HttpError(501, "not_implemented", "the enhancement context is not built yet (M2)");
  });

  r.add("PUT", "/calls/:id/enhanced", async (c) => {
    await readBody(c.req, { markdown: "string", coversSeq: "integer" });
    callId(c);
    throw new HttpError(501, "not_implemented", "enhanced notes are not built yet (M2)");
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
