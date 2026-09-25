/**
 * The window in a browser (the page server, `src/main/window/page-server.ts`): the HTTP transport.
 *
 * The page opens with a one-time code in its URL fragment, trades it for a session once, keeps the
 * session in memory and `sessionStorage` (never a cookie), and removes the fragment from the
 * address bar. Every request carries the session in `Authorization`; nothing reusable ever sits in
 * a URL, a `Referer` or the history.
 *
 * A call is followed with `fetch` rather than `EventSource`, so the page can send its session and
 * name the last event it applied in `Last-Event-ID` when it reconnects.
 */

import type { LogEvent } from "../core/log/events.ts";
import { sseFrames } from "../core/net/sse.ts";
import { boot, showFatal } from "./app.ts";
import type {
  AppStatus,
  AskSink,
  FollowSink,
  Method,
  PartialLine,
  ReadLines,
  Reply,
  Transport,
} from "./protocol.ts";

const SESSION_KEY = "akou.session";

async function openSession(): Promise<string | null> {
  const m = /(?:^#|&)k=([A-Za-z0-9_-]{16,})/.exec(location.hash);
  if (m) {
    // Out of the address bar and the history at once, used or not.
    history.replaceState(null, "", location.pathname + location.search);
    const r = await fetch("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: m[1] }),
    });
    if (r.ok) {
      const { session } = (await r.json()) as { session: string };
      sessionStorage.setItem(SESSION_KEY, session);
      return session;
    }
  }
  return sessionStorage.getItem(SESSION_KEY);
}

class HttpTransport implements Transport {
  readonly kind = "browser" as const;

  constructor(private readonly session: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.session}`, ...extra };
  }

  async request<T = unknown>(method: Method, path: string, body?: unknown): Promise<Reply<T>> {
    const r = await fetch(`/api/v1${path}`, {
      method,
      headers: this.headers(method === "GET" ? {} : { "content-type": "application/json" }),
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    if (r.status === 401) sessionEnded();
    const text = await r.text();
    // A text reply (a transcript as Markdown) arrives as the string itself.
    if (r.headers.get("content-type")?.startsWith("text/"))
      return { status: r.status, body: text as T };
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = { error: "not_json", message: text.slice(0, 200) };
    }
    return { status: r.status, body: parsed as T };
  }

  follow(call: string, after: number, sink: FollowSink): { close(): void } {
    const ctl = new AbortController();
    void (async () => {
      let why = "ended";
      try {
        const r = await fetch(`/api/v1/calls/${encodeURIComponent(call)}/stream`, {
          headers: this.headers(after > 0 ? { "last-event-id": String(after) } : {}),
          signal: ctl.signal,
          cache: "no-store",
        });
        if (r.status === 401) sessionEnded();
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        sink.open();
        for await (const f of sseFrames(r.body)) {
          if (f.event === "event") sink.event(JSON.parse(f.data) as LogEvent);
          else if (f.event === "partial") sink.partial(JSON.parse(f.data) as PartialLine[]);
          else if (f.event === "level") sink.level(JSON.parse(f.data));
          else if (f.event === "read") sink.read(JSON.parse(f.data) as ReadLines);
          else sink.alive();
        }
      } catch (err) {
        why = (err as Error).message;
      }
      if (!ctl.signal.aborted) sink.closed(why);
    })();
    return { close: () => ctl.abort() };
  }

  ask(call: string, question: string, sink: AskSink): { cancel(): void } {
    const ctl = new AbortController();
    void (async () => {
      try {
        const r = await fetch(`/api/v1/calls/${encodeURIComponent(call)}/ask`, {
          method: "POST",
          headers: this.headers({ "content-type": "application/json" }),
          body: JSON.stringify({ question, stream: true }),
          signal: ctl.signal,
        });
        if (!r.ok || !r.body) {
          const b = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
          sink.error({ error: b.error ?? "failed", message: b.message ?? `HTTP ${r.status}` });
          return;
        }
        for await (const f of sseFrames(r.body)) {
          if (f.event === "comment") continue;
          const data = JSON.parse(f.data);
          if (f.event === "excerpts") sink.excerpts(data);
          else if (f.event === "token") sink.token(data.t);
          else if (f.event === "answer") sink.answer(data);
          else if (f.event === "error") sink.error(data);
        }
      } catch (err) {
        if (!ctl.signal.aborted) sink.error({ error: "failed", message: (err as Error).message });
      }
    })();
    return { cancel: () => ctl.abort() };
  }

  async audio(call: string, part: number): Promise<Blob> {
    const r = await fetch(`/api/v1/calls/${encodeURIComponent(call)}/audio/${part}`, {
      headers: this.headers(),
    });
    if (!r.ok) throw new Error(`the audio of part ${part} is not available (HTTP ${r.status})`);
    return r.blob();
  }

  watchStatus(fn: (s: AppStatus) => void): { close(): void } {
    const ctl = new AbortController();
    let wait = 250;
    const loop = async () => {
      while (!ctl.signal.aborted) {
        try {
          const r = await fetch("/app/stream", { headers: this.headers(), signal: ctl.signal });
          if (r.status === 401) sessionEnded();
          if (r.ok && r.body) {
            wait = 250;
            for await (const f of sseFrames(r.body)) {
              if (f.event === "status") fn(JSON.parse(f.data) as AppStatus);
            }
          }
        } catch {}
        if (ctl.signal.aborted) return;
        await new Promise((res) => setTimeout(res, wait));
        wait = Math.min(wait * 2, 5000);
      }
    };
    void loop();
    return { close: () => ctl.abort() };
  }

  async openSettingsPane(pane: "microphone" | "system-audio"): Promise<boolean> {
    const r = await fetch("/app/open-settings", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ pane }),
    });
    if (!r.ok) return false;
    return ((await r.json()) as { opened: boolean }).opened;
  }
}

let ended = false;
function sessionEnded(): void {
  if (ended) return;
  ended = true;
  sessionStorage.removeItem(SESSION_KEY);
  showFatal("This window's session has ended (akou restarted). Run `akou open` for a new one.");
}

void (async () => {
  const session = await openSession();
  if (!session) {
    showFatal("This link was used already or has expired. Run `akou open` for a new one.");
    return;
  }
  boot(new HttpTransport(session));
})();
