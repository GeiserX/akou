/**
 * The window's way into the app (docs/DESIGN.md sections 6.3 rule 7 and 7): the same routes as the
 * local API, run in process, never over HTTP. The ElectroBun window reaches it through typed RPC
 * (`rpc.ts`); a browser reaches it through the page server (`page-server.ts`), which is how the
 * headless app, the Linux CLI tarball and the UI tests show the window.
 *
 * Everything the window writes is the user's own (`by: "user"`), so a note typed in the notepad and
 * a name given from a speaker chip are never mistaken for an agent's.
 *
 * Following a call goes through `openFollow`, the one follower the SSE route uses too: every event
 * after a cursor, once and in order, plus the provisional line and the levels. The window resumes
 * from the last `seq` it applied, so a dropped connection or a webview frozen by sleep (ElectroBun
 * #550) recovers by reconnecting, never by the old connection surviving.
 */

import type { LogEvent } from "../../core/log/events.ts";
import { sseFrames } from "../../core/net/sse.ts";
import { HttpError } from "../api/http.ts";
import { resolveRef } from "../api/routes/common.ts";
import { type FollowSink, openFollow } from "../api/routes/follow.ts";
import { API_PREFIX, type ApiApp, buildRouter, routeRequest } from "../api/server.ts";

export const WINDOW_AUTHOR = "user";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export const METHODS: readonly Method[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];

/** The app as the bridge sees it: the API's view, plus a feed of every call's events. */
export interface BridgeApp extends ApiApp {
  /** Every event appended to any call. Returns the unsubscribe function. */
  watch(fn: (call: string, e: LogEvent) => void): () => void;
  /** Status changes that are not log events (a share viewer came or went). */
  onStatusChange(fn: () => void): () => void;
}

export interface ApiReply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: the reply is the route's JSON, read by the page.
  body: any;
}

/** The streamed answer of the ask box: `excerpts` at once, `token`s, then `answer` or `error`. */
export interface AskSink {
  excerpts(data: unknown): void;
  token(t: string): void;
  answer(data: unknown): void;
  error(data: { error: string; message: string }): void;
}

/** Event types after which the page reads the app's status again: a call began or ended. */
const LIFECYCLE: ReadonlySet<string> = new Set([
  "call.created",
  "call.ended",
  "call.failed",
  "part.started",
  "part.ended",
  "pause",
  "resume",
  "mute",
  "unmute",
  "share.started",
  "share.stopped",
]);

/** Checks a path from the page: under the API, no scheme, no host, no dot segments. */
export function checkPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /(^|\/)\.\.?(\/|$|\?)/.test(path)) {
    throw new HttpError(400, "bad_path", "the path must be an API path such as /calls/live");
  }
  return path;
}

export class Bridge {
  private readonly router = buildRouter();

  constructor(
    readonly app: BridgeApp,
    private readonly onError?: (err: unknown) => void,
  ) {}

  /** One API request, in process, as the user. `path` is under `/v1` and may carry a query. */
  async request(
    method: Method,
    path: string,
    o: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    if (!METHODS.includes(method)) {
      return Response.json({ error: "bad_method", message: "unknown method" }, { status: 405 });
    }
    try {
      checkPath(path);
    } catch (err) {
      const e = err as HttpError;
      return Response.json({ error: e.code, message: e.message }, { status: e.status });
    }
    const withBody = method !== "GET" && o.body !== undefined;
    const req = new Request(`http://akou.window${API_PREFIX}${path}`, {
      method,
      headers: { ...(withBody ? { "content-type": "application/json" } : {}), ...o.headers },
      body: withBody ? JSON.stringify(o.body) : undefined,
      signal: o.signal,
    });
    return routeRequest(this.router, this.app, req, {
      by: WINDOW_AUTHOR,
      onError: (err) => this.onError?.(err),
    });
  }

  /** A request whose reply is JSON (every route but the streams and the audio). */
  async json(method: Method, path: string, body?: unknown): Promise<ApiReply> {
    const res = await this.request(method, path, { body });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = { error: "not_json", message: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  }

  /** Follows a call from a cursor. `call` is an id, `live` or `last`. */
  async follow(call: string, after: number, sink: FollowSink): Promise<() => void> {
    await this.app.manager.init();
    const id = resolveRef(this.app, call, { allowLast: true });
    return openFollow(this.app, id, after, sink);
  }

  /** The ask box: the question answered by the provider, streamed. Aborting cancels the run. */
  async ask(call: string, question: string, sink: AskSink, signal?: AbortSignal): Promise<void> {
    const res = await this.request("POST", `/calls/${encodeURIComponent(call)}/ask`, {
      body: { question, stream: true },
      signal,
    });
    if (!res.ok || !res.body) {
      let body: { error?: string; message?: string } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {}
      sink.error({ error: body.error ?? "failed", message: body.message ?? `HTTP ${res.status}` });
      return;
    }
    for await (const frame of sseFrames(res.body)) {
      let data: unknown = null;
      try {
        data = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (frame.event === "excerpts") sink.excerpts(data);
      else if (frame.event === "token") sink.token((data as { t: string }).t);
      else if (frame.event === "answer") sink.answer(data);
      else if (frame.event === "error") sink.error(data as { error: string; message: string });
    }
  }

  /**
   * Calls `fn` (at most once per `debounceMs`) after any call starts, ends, pauses, resumes or
   * changes its sharing, so the page re-reads the status instead of polling it.
   */
  watchLifecycle(fn: () => void, debounceMs = 50): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, debounceMs);
    };
    const stop = this.app.watch((_call, e) => {
      if (LIFECYCLE.has(e.type)) soon();
    });
    const stopStatus = this.app.onStatusChange(soon);
    return () => {
      if (timer) clearTimeout(timer);
      stop();
      stopStatus();
    };
  }
}
