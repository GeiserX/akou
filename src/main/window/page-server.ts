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
 *
 * In server mode (docs/ux/SERVER.md SV-U1) there is no listener of its own: the API's listener
 * hands it every path that is not the API (`mounted`), the `Host` rule is server mode's, a request
 * whose `Origin` is not the page's own is refused, and `POST /session` also takes the admin
 * password or an `admin` key; a wrong one is answered after 2 s, and logins run one at a time.
 */

import { randomBytes } from "node:crypto";
import { MAX_BODY_BYTES, tokenMatches } from "../api/guard.ts";
import { HttpError, readCapped } from "../api/http.ts";
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

/**
 * The ElectroBun window's policy, carried by `index.html` as a meta tag because `views://` has no
 * server to add the header (DESIGN 6.3 rule 7). The same as `CSP` except: the `views:` scheme is
 * named beside `'self'` in case the webview treats the custom scheme's origin as opaque, the RPC
 * socket (`ws://127.0.0.1:<port>`) is allowed, and `frame-ancestors`, which a meta policy cannot
 * carry, is left out. The browser page gets both this and the header; their intersection is `CSP`.
 */
export const WINDOW_CSP = [
  "default-src 'none'",
  "script-src 'self' views:",
  "style-src 'self' views:",
  "connect-src 'self' views: ws://127.0.0.1:*",
  "media-src 'self' views: blob:",
  "img-src 'self' views: data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The policy a page's `<meta http-equiv="Content-Security-Policy">` sets, or null. */
export function metaCsp(html: string): string | null {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/i.exec(html);
  return m ? (m[1] as string) : null;
}

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

/** A wrong admin password or key is answered after this long (SV-U1). */
export const LOGIN_FAIL_MS = 2_000;

/**
 * Server mode (docs/ux/SERVER.md SV-U1): the page is served by the API's own listener behind the
 * proxy, not by a loopback listener of its own, and a session is opened with the admin password
 * or an `admin` key as well as with a one-time code.
 */
export interface MountedPage {
  /** The API listener's origin, for `openUrl`. */
  origin: string;
  /** The server-mode Host rule (`serverHostAllowed`). */
  hostAllowed(host: string | null): boolean;
  /** Checks the admin password or an `admin` key. */
  login(c: { password?: string; key?: string }): Promise<boolean>;
  /**
   * False when the listener is on a network address with no proxy in front: then the page
   * refuses to load, since it would go over plain HTTP. startApp refuses that bind already.
   */
  pageAllowed: boolean;
}

export interface PageServerOptions {
  bridge: Bridge;
  bundle: UiBundle;
  /** 0 picks a free port. */
  port?: number;
  /** Mounted on the API's listener in server mode; absent, a loopback listener of its own. */
  mounted?: MountedPage;
  /** How long a failed login waits before its 401 (`LOGIN_FAIL_MS`). */
  loginFailMs?: number;
  now?: () => number;
  /** Opens a system settings pane (the permission banner's button); false when it cannot. */
  openSettings?: (pane: SettingsPane) => Promise<boolean>;
  onError?: (err: unknown) => void;
}

function refuse(status: number, error: string, message: string): Response {
  return withHeaders(Response.json({ error, message }, { status }));
}

/** Does an `Origin` header name the host the request was sent to? */
function sameOrigin(origin: string, host: string | null): boolean {
  try {
    return host !== null && new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
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
  private readonly server: ReturnType<typeof Bun.serve> | null;
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Set<string>();
  /** Open streams, so a quit (or a test) can close them all at once. */
  private readonly streams = new Set<AbortController>();
  /**
   * The admin logins, one at a time across the process: a wrong one holds the line for its delay,
   * so the delay is a rate (one guess per `LOGIN_FAIL_MS`) whatever runs in parallel, and only one
   * password check runs at once.
   */
  private logins: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private stopping = false;

  constructor(private readonly o: PageServerOptions) {
    this.now = o.now ?? Date.now;
    if (o.mounted) {
      this.server = null;
      this.origin = o.mounted.origin;
      this.port = Number(new URL(o.mounted.origin).port);
      return;
    }
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
    if (this.server) await Promise.race([this.server.stop(true), Bun.sleep(STOP_BUDGET_MS)]);
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

  /** A request on the API's listener in server mode, with the page's own headers added. */
  async fetch(
    req: Request,
    srv: { timeout(req: Request, seconds: number): void },
  ): Promise<Response> {
    try {
      return withHeaders(await this.handle(req, srv));
    } catch (err) {
      this.o.onError?.(err);
      return refuse(500, "internal", (err as Error).message);
    }
  }

  private async handle(
    req: Request,
    srv: { timeout(req: Request, seconds: number): void },
  ): Promise<Response> {
    if (this.stopping) return refuse(503, "stopping", "akou is quitting");
    const host = req.headers.get("host");
    const mounted = this.o.mounted;
    if (mounted) {
      if (!mounted.hostAllowed(host)) {
        return refuse(403, "bad_host", "Host must be server.public_host, or loopback");
      }
      if (!mounted.pageAllowed) {
        return refuse(
          403,
          "no_tls",
          "the page is not served over plain HTTP on a network address; set server.behind_proxy with a TLS proxy in front",
        );
      }
    } else if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return refuse(403, "bad_host", "Host must be this listener's own address");
    }
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") {
      return refuse(403, "cross_site", "requests from another site are refused");
    }
    // On the network a browser is a client (SV-D2), so the cross-origin refusal is here: a page on
    // another origin may not use this one's session or open one.
    const origin = req.headers.get("origin");
    if (mounted && origin !== null && !sameOrigin(origin, host)) {
      return refuse(403, "cross_site", "requests from another origin are refused");
    }
    if (req.method === "OPTIONS") return refuse(405, "method_not_allowed", "no CORS here");
    // Mounted on the API's listener, Bun's body limit is the upload cap (SV-D3); the page takes
    // JSON only, 64 KB as the API does, refused by its declared size before a byte is read.
    if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
      return refuse(413, "body_too_large", `bodies are capped at ${MAX_BODY_BYTES} bytes`);
    }
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "GET" && path === "/session") {
      // What the page offers when it has no session: a login form in server mode.
      return Response.json({ login: mounted !== undefined });
    }

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
      let body: { code?: unknown; password?: unknown; key?: unknown } = {};
      try {
        body = JSON.parse(await readCapped(req)) as typeof body;
      } catch (err) {
        if (err instanceof HttpError) return refuse(err.status, err.code, err.message);
      }
      if (mounted && (typeof body.password === "string" || typeof body.key === "string")) {
        const credentials = {
          password: typeof body.password === "string" ? body.password : undefined,
          key: typeof body.key === "string" ? body.key : undefined,
        };
        const attempt = this.logins.then(async () => {
          const ok = await mounted.login(credentials).catch(() => false);
          if (!ok) await Bun.sleep(this.o.loginFailMs ?? LOGIN_FAIL_MS);
          return ok;
        });
        this.logins = attempt;
        if (!(await attempt)) return refuse(401, "bad_login", "wrong admin password or key");
        const session = randomBytes(32).toString("hex");
        this.sessions.add(session);
        return Response.json({ session });
      }
      const code = String(body.code ?? "");
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
        pane = String((JSON.parse(await readCapped(req)) as { pane?: unknown }).pane ?? "");
      } catch (err) {
        if (err instanceof HttpError) return refuse(err.status, err.code, err.message);
      }
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
        let text: string;
        try {
          text = await readCapped(req);
        } catch (err) {
          if (err instanceof HttpError) return refuse(err.status, err.code, err.message);
          throw err;
        }
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
