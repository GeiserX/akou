/**
 * The window in a browser (docs/DESIGN.md sections 1.4 and 7): a second loopback listener that
 * serves the window's bundle and runs its requests through the bridge, in process. The ElectroBun
 * window never uses it (it talks over typed RPC); it is how the headless app shows the window
 * (`akou open` prints its address), and how the UI tests drive the real page in a headless
 * browser.
 *
 * The local API's guard refuses every browser request by design (DESIGN 6.3), so the page cannot
 * carry the API token. It gets a session of its own instead, delivered so that nothing reusable
 * ever sits in a URL:
 *
 * 1. `openUrl()` mints a one-time code, valid for one minute, and puts it in the URL's fragment
 *    (`http://127.0.0.1:PORT/?call=ID#k=CODE`). A fragment is never sent to a server and never in
 *    a `Referer`.
 * 2. The page trades the code for a session with `POST /session` (the code is burned on first use,
 *    so a copy left in the browser's history is worth nothing) and removes the fragment.
 * 3. Every later request carries `Authorization: Bearer <session>`; the session lives in the page's
 *    memory and `sessionStorage`, never in a cookie, so there is no ambient credential a cross-site
 *    page could ride on, and nothing to forge.
 *
 * The rest of the guard: `Host` must be this listener's own (DNS rebinding); a request a browser
 * marks as cross-site is refused; no CORS header is ever sent; every page carries a strict Content
 * Security Policy (scripts only from this origin, no inline script) and `Referrer-Policy:
 * no-referrer`.
 */

import { randomBytes } from "node:crypto";
import { tokenMatches } from "../api/guard.ts";
import type { Bridge, Method } from "./bridge.ts";
import { METHODS } from "./bridge.ts";
import type { UiBundle } from "./bundle.ts";

/** A one-time code is good for this long. */
export const CODE_TTL_MS = 60_000;
export const STATUS_KEEPALIVE_MS = 15_000;
/** How long quit waits for the listener to close its connections. */
export const STOP_BUDGET_MS = 1000;

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

/** Panes the permission banner's button may open. */
export const SETTINGS_PANES = ["microphone", "system-audio"] as const;
export type SettingsPane = (typeof SETTINGS_PANES)[number];

export interface PageServerOptions {
  bridge: Bridge;
  bundle: UiBundle;
  /** 0 picks a free port. */
  port?: number;
  now?: () => number;
  /** Opens a system settings pane (the permission banner's button); false when it cannot. */
  openSettings?: (pane: SettingsPane) => Promise<boolean>;
  onError?: (err: unknown) => void;
}

function refuse(status: number, error: string, message: string): Response {
  return withHeaders(Response.json({ error, message }, { status }));
}

function withHeaders(res: Response): Response {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(k)) res.headers.set(k, v);
  }
  return res;
}

export class PageServer {
  readonly port: number;
  readonly origin: string;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Set<string>();
  /** Open streams, so a quit (or a test) can close them all at once. */
  private readonly streams = new Set<AbortController>();
  private readonly now: () => number;
  private stopping = false;

  constructor(private readonly o: PageServerOptions) {
    this.now = o.now ?? Date.now;
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: o.port ?? 0,
      idleTimeout: 60,
      maxRequestBodySize: 64 * 1024,
      fetch: async (req, srv) => {
        try {
          return withHeaders(await this.handle(req, srv));
        } catch (err) {
          o.onError?.(err);
          return refuse(500, "internal", (err as Error).message);
        }
      },
    });
    this.port = this.server.port as number;
    this.origin = `http://127.0.0.1:${this.port}`;
  }

  /** A fresh address for one browser tab: a one-time code in the fragment, the call in the query. */
  openUrl(call?: string): string {
    const code = randomBytes(24).toString("base64url");
    const now = this.now();
    for (const [c, at] of this.codes) if (now - at > CODE_TTL_MS) this.codes.delete(c);
    this.codes.set(code, now);
    const q = call ? `?call=${encodeURIComponent(call)}` : "";
    return `${this.origin}/${q}#k=${code}`;
  }

  /** Closes every open stream: the pages see a dropped connection and resume from their cursor. */
  closeStreams(): number {
    const n = this.streams.size;
    for (const s of this.streams) s.abort();
    this.streams.clear();
    return n;
  }

  get openStreams(): number {
    return this.streams.size;
  }

  /**
   * Stops the listener. New requests are refused first, so a page that reconnects the moment its
   * stream is closed cannot open another one; a request that still hangs does not hold up quit.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.closeStreams();
    await Promise.race([this.server.stop(true), Bun.sleep(STOP_BUDGET_MS)]);
  }

  /** A signal for one stream: aborted when the client goes away or `closeStreams` runs. */
  private stream(req: Request): AbortSignal {
    const ctl = new AbortController();
    this.streams.add(ctl);
    ctl.signal.addEventListener("abort", () => this.streams.delete(ctl), { once: true });
    if (req.signal.aborted) ctl.abort();
    else req.signal.addEventListener("abort", () => ctl.abort(), { once: true });
    return ctl.signal;
  }

  private authorized(req: Request): boolean {
    const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
    if (!m) return false;
    for (const s of this.sessions) if (tokenMatches(m[1] as string, s)) return true;
    return false;
  }

  private async handle(
    req: Request,
    srv: { timeout(req: Request, seconds: number): void },
  ): Promise<Response> {
    if (this.stopping) return refuse(503, "stopping", "akou is quitting");
    const host = req.headers.get("host");
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return refuse(403, "bad_host", "Host must be this listener's own address");
    }
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") {
      return refuse(403, "cross_site", "requests from another site are refused");
    }
    if (req.method === "OPTIONS") return refuse(405, "method_not_allowed", "no CORS here");
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/app/")) {
      const file = this.o.bundle.get(path === "/" ? "/index.html" : path);
      if (!file || path === "/share.html" || path === "/share.js") {
        return refuse(404, "not_found", "no such file");
      }
      return new Response(file.body, { headers: { "content-type": file.type } });
    }

    if (req.method === "POST" && path === "/session") {
      if (site !== "same-origin" && site !== null) {
        return refuse(403, "cross_site", "a session is opened by the page itself");
      }
      let code = "";
      try {
        code = String(((await req.json()) as { code?: unknown }).code ?? "");
      } catch {}
      const at = this.codes.get(code);
      // One use only: a code is gone whether or not it was still fresh.
      this.codes.delete(code);
      if (at === undefined || this.now() - at > CODE_TTL_MS) {
        return refuse(403, "bad_code", "this link was used already or has expired; open a new one");
      }
      const session = randomBytes(32).toString("hex");
      this.sessions.add(session);
      return Response.json({ session });
    }

    if (!this.authorized(req)) {
      return new Response(
        JSON.stringify({ error: "unauthorized", message: "open the window again for a session" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    if (path === "/app/stream" && req.method === "GET") return this.statusStream(req);

    if (path === "/app/open-settings" && req.method === "POST") {
      let pane = "";
      try {
        pane = String(((await req.json()) as { pane?: unknown }).pane ?? "");
      } catch {}
      if (!(SETTINGS_PANES as readonly string[]).includes(pane)) {
        return refuse(400, "bad_pane", `pane must be one of ${SETTINGS_PANES.join(", ")}`);
      }
      const opened = (await this.o.openSettings?.(pane as SettingsPane)) ?? false;
      return Response.json({ opened });
    }

    if (path.startsWith("/api/v1/")) {
      const method = req.method as Method;
      if (!METHODS.includes(method)) return refuse(405, "method_not_allowed", "not here");
      const apiPath = `${path.slice("/api/v1".length)}${url.search}`;
      const streaming =
        (method === "GET" && /\/stream$/.test(path)) || (method === "POST" && /\/ask$/.test(path));
      if (streaming) srv.timeout(req, 0);
      let body: unknown;
      if (method !== "GET") {
        const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim();
        if (type !== "application/json") {
          return refuse(415, "json_required", "requests that change something need JSON");
        }
        const text = await req.text();
        if (text.trim() !== "") {
          try {
            body = JSON.parse(text);
          } catch {
            return refuse(400, "bad_json", "the body is not valid JSON");
          }
        } else body = {};
      }
      const pass: Record<string, string> = {};
      for (const h of ["last-event-id", "range"]) {
        const v = req.headers.get(h);
        if (v !== null) pass[h] = v;
      }
      const res = await this.o.bridge.request(method, apiPath, {
        body,
        signal: streaming ? this.stream(req) : req.signal,
        headers: pass,
      });
      return new Response(res.body, { status: res.status, headers: res.headers });
    }

    return refuse(404, "not_found", "no such route");
  }

  /** The app's status as Server-Sent Events: once at once, then after every lifecycle change. */
  private statusStream(req: Request): Response {
    const signal = this.stream(req);
    const bridge = this.o.bridge;
    const enc = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: (ctl) => {
        let closed = false;
        const send = (text: string) => {
          if (closed) return;
          try {
            ctl.enqueue(enc.encode(text));
          } catch {
            stop();
          }
        };
        const push = async () => {
          try {
            send(`event: status\ndata: ${JSON.stringify(await bridge.app.status())}\n\n`);
          } catch {}
        };
        const unwatch = bridge.watchLifecycle(() => void push());
        const keepalive = setInterval(() => send(": keep-alive\n\n"), STATUS_KEEPALIVE_MS);
        stop = () => {
          if (closed) return;
          closed = true;
          unwatch();
          clearInterval(keepalive);
          try {
            ctl.close();
          } catch {}
        };
        signal.addEventListener("abort", stop, { once: true });
        send("retry: 1000\n\n");
        void push();
      },
      cancel: () => stop(),
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" },
    });
  }
}
