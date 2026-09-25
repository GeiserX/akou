/**
 * The local HTTP API (docs/DESIGN.md sections 6.2 and 6.3): `http://127.0.0.1:<port>/v1`, bound to
 * IPv4 loopback only, every request through the guard before any route, no CORS header ever.
 *
 * The CLI and the MCP server are thin clients of it; the window never uses it (it talks to the main
 * process over ElectroBun's typed RPC). The routes live in `routes/*.ts` and see the app only
 * through `ApiApp`, so they can be driven by the real app or by a test double.
 */

import type { EventDraft, LogEvent } from "../../core/log/events.ts";
import type { ModelsStatus } from "../asr/models.ts";
import type { CallController, StartOk } from "../call/call.ts";
import type { CallManager, StartRequest } from "../call/manager.ts";
import type { Outcome } from "../call/state.ts";
import type { HookStage, LoadedConfig, SettingKey, SettingValue } from "../config/schema.ts";
import type { ExportResult } from "../handoff/export.ts";
import type { HookReport } from "../handoff/hooks.ts";
import type { ImportResult } from "../import/hark-viewer.ts";
import type { Provider } from "../llm/provider.ts";
import type { Template } from "../notes/templates.ts";
import type { SessionStore } from "../query/ask.ts";
import type { CallQuery } from "../query/context.ts";
import type { ShareHandle, ShareStatus } from "../share/transport.ts";
import { guard as defaultGuard, type Guard } from "./guard.ts";
import {
  authorOf,
  DRAIN_BODY_BYTES,
  drainBody,
  errorResponse,
  HttpError,
  json,
  Router,
} from "./http.ts";
import { callRoutes } from "./routes/calls.ts";
import { followRoutes } from "./routes/follow.ts";
import { handoffRoutes } from "./routes/handoff.ts";
import { modelRoutes } from "./routes/models.ts";
import { notesRoutes } from "./routes/notes.ts";
import { postCallRoutes } from "./routes/post-call.ts";
import { queryRoutes } from "./routes/query.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { vocabRoutes } from "./routes/vocab.ts";

export const API_PREFIX = "/v1";
export const DEFAULT_PORT = 8476;

/** Levels of the live call, dBFS, from the last packets. */
export interface Levels {
  mic: number;
  call: number;
  at: number;
}

/** What the routes need of the app. `index.ts` implements it. */
export interface ApiApp {
  readonly version: string;
  readonly manager: CallManager;
  readonly configDir: string;
  now(): number;
  status(): Promise<Record<string, unknown>>;
  /** The provider the settings name (a fake in tests). */
  provider(): Provider;
  /** How long one provider answer may take. */
  providerTimeoutMs(): number;
  /** Kept harness sessions for follow-up questions, when `provider.harnessResume` is on. */
  askSessions?(): SessionStore | undefined;
  /** The shipped templates, replaced or added to by the user's folder. */
  templates(): Template[];
  /** The speech models on disk, or the download in progress (`GET /models`). */
  models(): ModelsStatus;
  /** Starts the one download of the missing models and answers at once (`POST /models/pull`). */
  pullModels(): ModelsStatus;
  /** `POST /calls`: reads the workspace's vocabulary, then starts the call. */
  start(req: StartRequest): Promise<Outcome<StartOk>>;
  /** The controller of a known call id (loaded from disk if needed). Throws 404 otherwise. */
  call(id: string): Promise<CallController>;
  /** The query engine over a call's view, kept per call so its index updates incrementally. */
  query(id: string): Promise<CallQuery>;
  /**
   * Appends an event through the call's one writer, reopening a finished call's log for it. A
   * function draft is built from the call's view at the moment of the append, with nothing in
   * between, so ids and revisions computed from the view cannot race another write.
   */
  write(id: string, draft: EventDraft | ((c: CallController) => EventDraft)): Promise<LogEvent>;
  /** Raw events after `after`, from the log on disk. */
  events(id: string, after: number): Promise<LogEvent[]>;
  /** Every event appended to a call from now on. Returns the unsubscribe function. */
  subscribe(id: string, fn: (e: LogEvent) => void): () => void;
  levels(id: string): Levels | null;
  config(): LoadedConfig;
  /** Writes `config.json` and applies it; the running parts pick up what they can. */
  saveConfig(file: Partial<Record<SettingKey, SettingValue>>): Promise<LoadedConfig>;
  /** Vocabulary files changed on disk: forget what was read. */
  vocabChanged(): void;
  /** Runs the final pass for an ended call. */
  finalize(
    id: string,
    opts: { force?: boolean },
  ): Promise<Outcome<{ call: string; started: boolean }>>;
  /** `POST /calls/{id}/export`: the export folder, or the folder `to` names. */
  exportCall(id: string, o: { to?: string }): Promise<Outcome<ExportResult>>;
  /** `POST /calls/{id}/hooks`: the hooks of the stages named (default: every stage reached). */
  runHooks(id: string, stages?: readonly HookStage[]): Promise<Outcome<{ runs: HookReport[] }>>;
  /** `POST /import/hark-viewer`: predecessor call folders into calls. */
  importHarkViewer(
    dirs: readonly string[],
    o: { workspace?: string },
  ): Promise<{ imported: ImportResult[]; skipped: { source: string; reason: string }[] }>;
  /** Active share links (DESIGN 8.3). */
  shares(): ShareStatus[];
  startShare(
    call: string,
    o: { bind?: string; notes?: boolean; expires?: string },
  ): Promise<ShareStatus>;
  stopShare(call?: string): Promise<ShareHandle[]>;
  /**
   * `POST /window`: shows the window on a call, or, with no window (headless), answers the address
   * of the window in a browser with a one-time code.
   */
  openWindow(call?: string): Promise<{ shown: true } | { url: string }>;
  /** The clean shutdown, after the answer is sent. */
  quit(): void;
}

export interface ServerOptions {
  app: ApiApp;
  /** 0 picks a free port. */
  port: number;
  /** The token as of this request (it follows `akou token rotate`). */
  token: () => string;
  /**
   * The guard. Only the security tests pass another one (`openGuard`, their positive control);
   * no setting, variable or argument reaches this.
   */
  guard?: Guard;
  onError?(err: unknown, req: Request): void;
}

export interface ApiServer {
  readonly port: number;
  readonly url: string;
  /** The address the listener is bound to, as the server reports it. */
  readonly hostname: string;
  routes(): { method: string; path: string }[];
  stop(): Promise<void>;
}

export function buildRouter(): Router<ApiApp> {
  const r = new Router<ApiApp>();
  settingsRoutes(r);
  modelRoutes(r);
  callRoutes(r);
  followRoutes(r);
  queryRoutes(r);
  notesRoutes(r);
  vocabRoutes(r);
  postCallRoutes(r);
  handoffRoutes(r);
  return r;
}

/**
 * Runs one request that is already past the guard through the routes: the HTTP server does this
 * for every request, and the window's bridge does it in process for the user's own window, with
 * `by: "user"`.
 */
export async function routeRequest(
  router: Router<ApiApp>,
  app: ApiApp,
  req: Request,
  o: {
    by: string;
    timeout?: (seconds: number) => void;
    onError?(err: unknown, req: Request): void;
  },
): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
    return json(404, { error: "not_found", message: "the API is under /v1" });
  }
  const m = router.match(req.method, url.pathname.slice(API_PREFIX.length));
  if ("status" in m) {
    return m.status === 405
      ? json(405, { error: "method_not_allowed", message: `${req.method} is not allowed here` })
      : json(404, { error: "not_found", message: `no route ${url.pathname}` });
  }
  try {
    // Calls are known once recovery has indexed the root; a route that names a call waits for it.
    if (/^\/v1\/(calls|window|share)(\/|$)/.test(url.pathname)) await app.manager.init();
    return await m.handler({
      req,
      url,
      params: m.params,
      app,
      by: o.by,
      timeout: o.timeout,
    });
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    o.onError?.(err, req);
    return json(500, { error: "internal", message: (err as Error).message ?? String(err) });
  }
}

export function startApiServer(o: ServerOptions): ApiServer {
  const router = buildRouter();
  const check = o.guard ?? defaultGuard;
  const server = Bun.serve({
    // IPv4 loopback only, by address, so no name is resolved at bind (DESIGN 6.3 rule 1).
    hostname: "127.0.0.1",
    port: o.port,
    // The 64 KB limit is the guard's and `readBody`'s, so an oversized body is refused with an
    // answer the client can read (see `DRAIN_BODY_BYTES`); Bun only refuses past the drain cap.
    maxRequestBodySize: DRAIN_BODY_BYTES,
    // Long polls wait up to 30 s; streams send a keep-alive every 15 s.
    idleTimeout: 60,
    fetch: async (req, srv) => {
      const refused = check(req, { port: srv.port as number, token: o.token() });
      const res =
        refused ??
        (await routeRequest(router, o.app, req, {
          by: authorOf(req),
          timeout: (seconds) => srv.timeout(req, seconds),
          onError: o.onError,
        }));
      // An answer never closes the socket on unread bytes: the client would get a reset, not it.
      if (!req.bodyUsed && req.body) await drainBody(req.body.getReader());
      return res;
    },
  });
  const port = server.port as number;
  return {
    port,
    url: `http://127.0.0.1:${port}${API_PREFIX}`,
    hostname: server.hostname ?? "",
    routes: () => router.list(),
    stop: async () => {
      await server.stop(true);
    },
  };
}
