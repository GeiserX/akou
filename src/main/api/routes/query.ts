/**
 * Questions about a call (docs/DESIGN.md sections 5.4, 5.5 and 6.2):
 *
 * - `POST /calls/{id}/context {question, budget}`: the pack, with `cursor`, `state`, `memoStale`
 *   and `provisional`. No model is called; this is what an agent answers from.
 * - `GET /calls/{id}/search?q=&k=`: BM25 hits with wall-time citations.
 * - `POST /calls/{id}/ask {question, stream}`: the configured provider answers over the pack. The
 *   question and the answer are logged (`ask`, `answer`). When no provider can answer, the reply is
 *   still 200: the matching excerpts, labelled, with the reason, `answered: false`, and the pack
 *   for "Copy context for my agent", never nothing (TRAPS "Provider unavailable answered with
 *   nothing"). With `stream`, Server-Sent Events: `excerpts` at once, a `token` per piece of the
 *   answer, then `answer` with the same body as the plain reply. A client that goes away cancels
 *   the provider run.
 */

import type { EventDraft } from "../../../core/log/events.ts";
import type { CallView } from "../../../core/log/fold.ts";
import { ProviderError } from "../../llm/provider.ts";
import { type AskOptions, ask } from "../../query/ask.ts";
import { MCP_BUDGET, SEARCH_K } from "../../query/context.ts";
import { HttpError, json, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { CALL_ID, callId } from "./common.ts";
import { KEEPALIVE_MS } from "./follow.ts";

export const MAX_BUDGET = 32_000;
export const MAX_QUESTION = 2000;

export function queryRoutes(r: Router<ApiApp>): void {
  // A question is read, not a change, so `last` is accepted like on GET routes.
  r.add(
    "POST",
    "/calls/:id/context",
    {
      id: "calls.context",
      doc: "A small, cited context for a question about the call: the lines that answer it, the memo and the call's state, within `budget` tokens. Changes nothing.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      body: { question: "string", "budget?": "integer" },
      ok: 200,
    },
    async (c) => {
      const b = await c.body<{ question: string; budget?: number }>();
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
    },
  );

  r.add(
    "GET",
    "/calls/:id/search",
    {
      id: "calls.search",
      doc: "Search one call's transcript for words, best matches first, each hit with its citation and lines. Never searches across calls.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      query: {
        q: { type: "string", required: true, doc: "The words to look for." },
        k: { type: "integer", min: 1, max: 50, default: SEARCH_K, doc: "At most this many hits." },
      },
      ok: 200,
    },
    async (c) => {
      const query = c.query.raw("q") ?? "";
      if (query.trim() === "")
        throw new HttpError(400, "bad_param", "q is required", { param: "q" });
      const k = c.query.int("k") as number;
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
    },
  );

  r.add(
    "POST",
    "/calls/:id/ask",
    {
      id: "calls.ask",
      doc: "Ask the configured provider a question about the call and get its cited answer, written to the log as an `answer` event. `stream` sends the answer as server-sent events while it is written.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      body: { question: "string", "stream?": "boolean" },
      ok: 200,
    },
    async (c) => {
      const b = await c.body<{ question: string; stream?: boolean }>();
      const question = b.question.trim();
      if (question === "") throw new HttpError(400, "bad_field", "question is empty");
      if (question.length > MAX_QUESTION) {
        throw new HttpError(400, "bad_field", `question is over ${MAX_QUESTION} characters`);
      }
      const id = callId(c, { allowLast: true });
      const q = await c.app.query(id);
      // A model may take longer than the server's idle limit; the deadline is the provider's.
      c.timeout?.(0);
      const opts = {
        q,
        question,
        now: c.app.now(),
        provider: c.app.provider(),
        by: c.by,
        write: (d: EventDraft | ((view: CallView) => EventDraft)) =>
          c.app.write(id, typeof d === "function" ? (call) => d(call.view) : d),
        timeoutMs: c.app.providerTimeoutMs(),
        sessions: c.app.askSessions?.(),
      };
      if (!b.stream) {
        try {
          const r = await ask({ ...opts, signal: c.req.signal });
          return json(200, { call: id, ...r });
        } catch (err) {
          if (err instanceof ProviderError && err.kind === "cancelled") {
            return json(499, { error: "cancelled", message: "the question was cancelled" });
          }
          throw err;
        }
      }
      return sseAnswer(id, opts, c.req.signal);
    },
  );
}

/** Server-Sent Events: `excerpts` at once, `token` as the answer streams, then `answer`. */
function sseAnswer(
  id: string,
  opts: Omit<AskOptions, "signal" | "onToken" | "onExcerpts">,
  reqSignal: AbortSignal,
): Response {
  const enc = new TextEncoder();
  const ac = new AbortController();
  const onReqAbort = () => ac.abort();
  reqSignal.addEventListener("abort", onReqAbort, { once: true });
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: async (ctl) => {
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open = false;
        }
      };
      keepAlive = setInterval(() => {
        if (!open) return;
        try {
          ctl.enqueue(enc.encode(": keep-alive\n\n"));
        } catch {
          open = false;
        }
      }, KEEPALIVE_MS);
      try {
        const r = await ask({
          ...opts,
          signal: ac.signal,
          onExcerpts: (excerpts) => send("excerpts", { call: id, excerpts }),
          onToken: (t) => send("token", { t }),
        });
        send("answer", { call: id, ...r });
      } catch (err) {
        if (!(err instanceof ProviderError && err.kind === "cancelled")) {
          send("error", { error: "internal", message: (err as Error).message });
        }
      } finally {
        clearInterval(keepAlive);
        reqSignal.removeEventListener("abort", onReqAbort);
        open = false;
        try {
          ctl.close();
        } catch {}
      }
    },
    cancel: () => {
      clearInterval(keepAlive);
      ac.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
