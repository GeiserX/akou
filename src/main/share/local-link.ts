/**
 * The v1 share transport, `local-link` (docs/DESIGN.md section 8.3): a second listener, GET only,
 * on one chosen interface, serving the read-only viewer at `http://<addr>:<port>/s/<token>/` fed by
 * Server-Sent Events.
 *
 * - **Where.** The tailnet address when there is one (the tailnet encrypts it), else only what the
 *   user asks for: `lan` (with a warning that plain HTTP is visible to that network) or a typed
 *   address. Never `0.0.0.0` unless typed.
 * - **Who.** The 128-bit token in the path is the whole credential, as the design says; the page
 *   sends no `Referer` and runs under a strict Content Security Policy, so it cannot leak it.
 * - **What.** The call as the fold renders it: names and vocabulary applied, echo removed, the
 *   notepad only when asked for. Never audio, raw text, questions, answers or health.
 * - **How long.** Until the call ends plus the grace (or a fixed time), `akou share off`, or quit:
 *   it never survives a restart. `share.started` and `share.stopped` go into the log.
 *
 * The feed is incremental: a viewer gets the rendered transcript once when it connects, then only
 * the lines that changed, from the fold's change feed. A viewer that reconnects names the last
 * event it had (`Last-Event-ID`) and gets only what changed after it.
 */

import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { formatWall, formatZone } from "../../core/log/clock.ts";
import type { EventDraft, LogEvent } from "../../core/log/events.ts";
import type { CallView, Line } from "../../core/log/fold.ts";
import { tokenMatches } from "../api/guard.ts";
import { HttpError } from "../api/http.ts";
import { lastEventId } from "../api/routes/follow.ts";
import type { CallController } from "../call/call.ts";
import type { UiBundle } from "../window/bundle.ts";
import { CSP } from "../window/page-server.ts";
import {
  expiryAt,
  type ShareHandle,
  type ShareOptions,
  type ShareStatus,
  type ShareTransport,
} from "./transport.ts";

export const DEFAULT_SHARE_PORT = 8477;
const KEEPALIVE_MS = 15_000;
const TICK_MS = 500;

/** Events after which every line a viewer holds may render differently. */
const RENAMING: ReadonlySet<string> = new Set([
  "speaker.name",
  "speaker.merge",
  "speaker.unmerge",
  "speaker.map",
  "vocab.add",
  "vocab.propose",
  "final.part.done",
]);

export interface ShareApp {
  call(id: string): Promise<CallController>;
  events(id: string, after: number): Promise<LogEvent[]>;
  subscribe(id: string, fn: (e: LogEvent) => void): () => void;
  write(id: string, draft: EventDraft): Promise<unknown>;
  now(): number;
}

export interface LocalLinkOptions {
  app: ShareApp;
  bundle: () => Promise<UiBundle>;
  /** Port for the next share; 0 picks a free one. */
  port?: number;
  /** The machine's interfaces (tests pass their own). */
  interfaces?: () => ReturnType<typeof networkInterfaces>;
  /** A viewer came or went: the window's "N viewers" pill is redrawn. */
  onViewers?: () => void;
  onError?: (err: unknown) => void;
}

/** One line as a viewer sees it: the corrected text only, never the raw recognition. */
export interface SharedLine {
  id: string;
  seq: number;
  w0: number;
  ch: "mic" | "call";
  spk: string;
  speaker: string;
  time: string;
  text: string;
}

export interface SharedNote {
  id: string;
  time: string;
  text: string;
  author: "human" | "agent";
}

function isTailnet(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivate(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** The address a share listens on, and the warning to show with it. */
export function chooseBind(
  bind: string | undefined,
  ifaces: ReturnType<typeof networkInterfaces>,
): { address: string; label: string; warning?: string } {
  const addrs: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) addrs.push(a.address);
  }
  const want = bind ?? "tailnet";
  if (want === "tailnet") {
    const t = addrs.find(isTailnet);
    if (!t) {
      throw new HttpError(
        409,
        "no_tailnet",
        "no tailnet address on this machine; share on the LAN with bind: lan, or name an address",
      );
    }
    return { address: t, label: "tailnet" };
  }
  if (want === "lan") {
    const l = addrs.find(isPrivate);
    if (!l) throw new HttpError(409, "no_lan", "no private LAN address on this machine");
    return {
      address: l,
      label: "lan",
      warning: "plain HTTP on a LAN: anyone on this network who sees the traffic can read the call",
    };
  }
  if (!IPV4.test(want)) {
    throw new HttpError(400, "bad_bind", "bind must be tailnet, lan or an IPv4 address");
  }
  return {
    address: want,
    label: want,
    warning: isTailnet(want) || want.startsWith("127.") ? undefined : "plain HTTP on this address",
  };
}

/** The rendered, filtered view of one call that every viewer reads. */
export function sharedLine(l: Line, tz: string): SharedLine {
  return {
    id: l.id,
    seq: l.seq,
    w0: l.w0,
    ch: l.ch,
    spk: l.spk,
    speaker: l.speaker,
    time: formatWall(l.w0, tz),
    text: l.text,
  };
}

export function sharedNotes(v: CallView, tz: string): SharedNote[] {
  return v.notes().map((n) => ({
    id: n.id,
    time: formatWall(n.w, tz),
    text: n.text,
    author: n.author,
  }));
}

interface Share {
  handle: ShareHandle;
  status: ShareStatus;
  token: string;
  server: ReturnType<typeof Bun.serve>;
  viewers: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  unwatch: () => void;
  stopping: boolean;
}

export class LocalLink implements ShareTransport {
  readonly kind = "local-link" as const;
  private readonly shares = new Map<string, Share>();

  constructor(private readonly o: LocalLinkOptions) {}

  status(): ShareStatus[] {
    return [...this.shares.values()].map((s) => ({ ...s.status, viewers: s.viewers.size }));
  }

  /** The share of a call, if any. */
  of(call: string): ShareStatus | undefined {
    const s = this.shares.get(call);
    return s ? { ...s.status, viewers: s.viewers.size } : undefined;
  }

  async start(call: string, opts: ShareOptions): Promise<ShareHandle> {
    const existing = this.shares.get(call);
    if (existing) return existing.handle;
    const c = await this.o.app.call(call);
    const bind = chooseBind(opts.bind, (this.o.interfaces ?? networkInterfaces)());
    const bundle = await this.o.bundle();
    const token = randomBytes(16).toString("hex");
    const since = this.o.app.now();
    let server: ReturnType<typeof Bun.serve>;
    const share = { viewers: new Set<() => void>() } as Share;
    try {
      server = Bun.serve({
        hostname: bind.address,
        port: this.o.port ?? DEFAULT_SHARE_PORT,
        idleTimeout: 60,
        fetch: (req) => this.serve(share, c, req, bundle),
      });
    } catch (err) {
      throw new HttpError(
        409,
        "share_port",
        `cannot listen on ${bind.address}:${this.o.port ?? DEFAULT_SHARE_PORT}: ${(err as Error).message}`,
      );
    }
    const url = `http://${bind.address}:${server.port}/s/${token}/`;
    const endedAt = c.view.live ? null : this.o.app.now();
    const handle: ShareHandle = {
      id: randomBytes(6).toString("hex"),
      call,
      url,
      expiresAt: expiryAt(opts.expires, since, endedAt),
    };
    Object.assign(share, {
      handle,
      token,
      server,
      timer: null,
      stopping: false,
      unwatch: () => {},
      status: {
        ...handle,
        kind: "local-link",
        bind: bind.label,
        since,
        viewers: 0,
        bytes: 0,
        include: opts.include,
        expires: opts.expires,
        ...(bind.warning ? { warning: bind.warning } : {}),
      },
    } satisfies Omit<Share, "viewers">);
    this.shares.set(call, share);
    const arm = () => {
      if (share.timer) clearTimeout(share.timer);
      const at = share.handle.expiresAt;
      if (at === null) return;
      share.timer = setTimeout(
        () => void this.stop(share.handle).catch((err) => this.o.onError?.(err)),
        Math.max(0, at - this.o.app.now()),
      );
      share.timer.unref?.();
    };
    share.unwatch = this.o.app.subscribe(call, (e) => {
      if (e.type !== "call.ended" || typeof opts.expires === "object") return;
      share.handle.expiresAt = expiryAt(opts.expires, since, e.t);
      share.status.expiresAt = share.handle.expiresAt;
      arm();
    });
    arm();
    await this.o.app.write(call, {
      type: "share.started",
      bind: bind.label,
      expires: opts.expires,
      include: opts.include,
    });
    return handle;
  }

  async stop(handle: ShareHandle): Promise<void> {
    const s = this.shares.get(handle.call);
    if (!s || s.handle.id !== handle.id || s.stopping) return;
    s.stopping = true;
    if (s.timer) clearTimeout(s.timer);
    s.unwatch();
    for (const close of [...s.viewers]) close();
    this.shares.delete(handle.call);
    await s.server.stop(true);
    try {
      await this.o.app.write(handle.call, { type: "share.stopped", bind: s.status.bind });
    } catch (err) {
      this.o.onError?.(err);
    }
  }

  async stopAll(): Promise<void> {
    for (const s of [...this.shares.values()]) await this.stop(s.handle);
  }

  private serve(share: Share, c: CallController, req: Request, bundle: UiBundle): Response {
    const headers = {
      "content-security-policy": CSP,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
    };
    const notFound = () => new Response("not found", { status: 404, headers });
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("read only", { status: 405, headers });
    }
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    const addr = share.status.url.slice("http://".length).split("/")[0];
    if (host !== addr) return new Response("bad host", { status: 403, headers });
    const m = /^\/s\/([0-9a-f]{32})\/(.*)$/.exec(url.pathname);
    if (!m || !tokenMatches(m[1] as string, share.token)) return notFound();
    const rest = m[2] as string;
    const file =
      rest === ""
        ? "/share.html"
        : rest === "share.js"
          ? "/share.js"
          : rest === "theme.css"
            ? "/theme.css"
            : null;
    if (file) {
      const f = bundle.get(file);
      if (!f) return notFound();
      share.status.bytes += f.body.length;
      return new Response(f.body, { headers: { ...headers, "content-type": f.type } });
    }
    if (rest === "stream") return this.stream(share, c, req, headers);
    return notFound();
  }

  /** The viewer's feed: `snapshot` or `lines` (id = the log's `seq`), `partial`, `state`, `notes`. */
  private stream(
    share: Share,
    c: CallController,
    req: Request,
    headers: Record<string, string>,
  ): Response {
    const app = this.o.app;
    const include = share.status.include;
    const enc = new TextEncoder();
    const resumeAfter = lastEventId(req);
    let close = () => {};
    const body = new ReadableStream<Uint8Array>({
      start: async (ctl) => {
        const v = c.view;
        const tz = v.call?.tz ?? "UTC";
        let closed = false;
        const send = (event: string, data: unknown, id?: number) => {
          if (closed) return;
          const text = `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          share.status.bytes += text.length;
          try {
            ctl.enqueue(enc.encode(text));
          } catch {
            close();
          }
        };
        const held: LogEvent[] = [];
        let holding = true;
        let cursor = 0;
        const sent = new Map<string, string>();
        const render = (l: Line) => sharedLine(l, tz);
        const snapshot = () => {
          sent.clear();
          const lines = v.lines("best").map(render);
          for (const l of lines) sent.set(l.id, JSON.stringify(l));
          cursor = v.changesSince(Number.MAX_SAFE_INTEGER).cursor;
          send(
            "snapshot",
            {
              title: v.call?.title ?? "",
              tz,
              zone: formatZone(tz, v.parts()[0]?.wallStart ?? app.now()),
              state: v.state,
              live: v.live,
              lines,
              ...(include.notes ? { notes: sharedNotes(v, tz) } : {}),
            },
            v.lastSeq,
          );
        };
        const delta = (seq: number) => {
          const ch = v.changesSince(cursor);
          cursor = ch.cursor;
          const ids = ch.all
            ? [...new Set([...sent.keys(), ...v.lines("best").map((l) => l.id)])]
            : ch.ids;
          const lines: SharedLine[] = [];
          const removed: string[] = [];
          for (const id of ids) {
            const line = v.visibleIn(id, "best") ? v.resolve(id) : null;
            if (!line) {
              if (sent.delete(id)) removed.push(id);
              continue;
            }
            const r = render(line);
            const json = JSON.stringify(r);
            if (sent.get(id) === json) continue;
            sent.set(id, json);
            lines.push(r);
          }
          if (lines.length > 0 || removed.length > 0) send("lines", { lines, removed }, seq);
        };
        const onEvent = (e: LogEvent) => {
          if (holding) {
            held.push(e);
            return;
          }
          delta(e.seq);
          if (e.type === "note" || e.type === "note.del") {
            if (include.notes) send("notes", { notes: sharedNotes(v, tz) });
          }
          if (
            ["call.ended", "pause", "resume", "part.started", "part.ended", "call.failed"].includes(
              e.type,
            )
          ) {
            send("state", { state: v.state, live: v.live });
          }
        };
        const unsubscribe = app.subscribe(c.id, onEvent);
        let lastPartial = "";
        const tick = setInterval(() => {
          const p = v.provisional.current(app.now()).map((x) => {
            const spk = x.ch === "mic" ? "you" : (x.spk ?? "c?");
            return {
              ch: x.ch,
              spk,
              speaker: v.speakerLabel(spk),
              time: formatWall(x.w0, tz),
              text: x.text,
            };
          });
          const json = JSON.stringify(p);
          if (json !== lastPartial) {
            lastPartial = json;
            send("partial", p);
          }
        }, TICK_MS);
        const keepalive = setInterval(() => {
          if (closed) return;
          try {
            ctl.enqueue(enc.encode(": keep-alive\n\n"));
          } catch {
            close();
          }
        }, KEEPALIVE_MS);
        close = () => {
          if (closed) return;
          closed = true;
          clearInterval(tick);
          clearInterval(keepalive);
          unsubscribe();
          share.viewers.delete(close);
          this.o.onViewers?.();
          try {
            ctl.close();
          } catch {}
        };
        share.viewers.add(close);
        this.o.onViewers?.();
        req.signal.addEventListener("abort", close, { once: true });
        try {
          ctl.enqueue(enc.encode("retry: 1000\n\n"));
        } catch {}
        try {
          if (resumeAfter > 0 && resumeAfter <= v.lastSeq) {
            // Resume: only what changed after the viewer's last event, unless a rename touched all.
            const missed = await app.events(c.id, resumeAfter);
            if (missed.some((e) => RENAMING.has(e.type))) snapshot();
            else {
              for (const [id, json] of v
                .lines("best")
                .map((l) => [l.id, JSON.stringify(render(l))] as const))
                sent.set(id, json);
              const changed = new Set(
                missed.filter((e) => e.type === "seg").map((e) => (e as { id: string }).id),
              );
              const lines: SharedLine[] = [];
              const removed: string[] = [];
              for (const id of changed) {
                const line = v.visibleIn(id, "best") ? v.resolve(id) : null;
                if (line) lines.push(render(line));
                else {
                  sent.delete(id);
                  removed.push(id);
                }
              }
              cursor = v.changesSince(Number.MAX_SAFE_INTEGER).cursor;
              send("lines", { lines, removed }, v.lastSeq);
              send("state", { state: v.state, live: v.live });
            }
          } else snapshot();
        } catch (err) {
          this.o.onError?.(err);
          close();
          return;
        }
        holding = false;
        for (const e of held.splice(0)) onEvent(e);
      },
      cancel: () => close(),
    });
    return new Response(body, {
      headers: { ...headers, "content-type": "text/event-stream; charset=utf-8" },
    });
  }
}
