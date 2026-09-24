/**
 * Questions about a call (docs/DESIGN.md sections 5.4, 5.5 and 6.2):
 *
 * - `POST /calls/{id}/context {question, budget}`: the pack, with `cursor`, `state`, `memoStale`
 *   and `provisional`. No model is called; this is what an agent answers from.
 * - `GET /calls/{id}/search?q=&k=`: BM25 hits with wall-time citations.
 * - `POST /calls/{id}/ask {question, stream}`: needs a provider. This build has none, so it answers
 *   `503 provider_unavailable` with the reason and the pack, which is what the ask box shows then:
 *   the excerpts, never nothing (TRAPS "Provider unavailable answered with nothing").
 */

import { MCP_BUDGET, SEARCH_K } from "../../query/context.ts";
import { HttpError, intParam, json, type Router, readBody } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { callId } from "./common.ts";

export const MAX_BUDGET = 32_000;

export function queryRoutes(r: Router<ApiApp>): void {
  // A question is read, not a change, so `last` is accepted like on GET routes.
  r.add("POST", "/calls/:id/context", async (c) => {
    const b = await readBody<{ question: string; budget?: number }>(c.req, {
      question: "string",
      "budget?": "integer",
    });
    if (b.question.trim() === "") throw new HttpError(400, "bad_field", "question is empty");
    if (b.budget !== undefined && (b.budget < 1 || b.budget > MAX_BUDGET)) {
      throw new HttpError(400, "bad_field", `budget must be 1 to ${MAX_BUDGET}`);
    }
    const q = await c.app.query(callId(c, { allowLast: true }));
    const pack = q.context(b.question, { now: c.app.now(), budget: b.budget ?? MCP_BUDGET });
    return json(200, {
      call: q.view.call?.id ?? null,
      pack: pack.text,
      tokens: pack.tokens,
      budget: pack.budget,
      mode: pack.mode,
      state: pack.state,
      status: pack.status,
      cursor: pack.cursor,
      memoStale: pack.memoStale,
      memo: pack.memo,
      provisional: pack.provisional,
      analysis: pack.analysis.line,
      blocks: pack.blocks,
    });
  });

  r.add("GET", "/calls/:id/search", async (c) => {
    const query = c.url.searchParams.get("q") ?? "";
    if (query.trim() === "") throw new HttpError(400, "bad_param", "q is required", { param: "q" });
    const k = intParam(c.url, "k", SEARCH_K, 1, 50) as number;
    const q = await c.app.query(callId(c));
    const hits = q.search(query, k);
    return json(200, {
      call: q.view.call?.id ?? null,
      hits: hits.map((h) => ({
        score: h.score,
        w0: h.w0,
        w1: h.w1,
        citation: h.citation,
        ids: h.lines.map((l) => l.id),
        lines: h.rendered,
      })),
    });
  });

  r.add("POST", "/calls/:id/ask", async (c) => {
    const b = await readBody<{ question: string; stream?: boolean }>(c.req, {
      question: "string",
      "stream?": "boolean",
    });
    const q = await c.app.query(callId(c, { allowLast: true }));
    const pack = q.context(b.question, { now: c.app.now(), surface: "app" });
    return json(503, {
      error: "provider_unavailable",
      message: "no provider is configured; answer from the context pack, or use POST /context",
      reason: "no provider in this build",
      context: pack.text,
      cursor: pack.cursor,
      state: pack.state,
    });
  });
}
