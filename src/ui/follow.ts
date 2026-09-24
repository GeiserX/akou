/**
 * Following one call from the page (docs/DESIGN.md sections 4.6 and 7; TRAPS "Page refetched the
 * whole transcript every second", "Wake from sleep"): the page keeps its own fold of the call's
 * events and redraws only what the fold's change feed names. The transcript is read once, as the
 * stream's backlog when the page opens the call, and never again.
 *
 * - Every event is applied once, in `seq` order. One already applied is dropped (a duplicate); one
 *   that skips a `seq` means something was lost on the way, so the page reconnects from the last
 *   one it applied rather than draw a hole.
 * - The page recovers by reconnecting, never by trusting a connection to survive: a stream that
 *   ends or fails, silence past two keep-alives, a timer that jumped (the machine slept, or the
 *   webview froze, ElectroBun #550), the page becoming visible again or the network coming back
 *   all reconnect from the cursor, with `Last-Event-ID` set to it.
 */

import type { LogEvent } from "../core/log/events.ts";
import { type CallView, fold } from "../core/log/fold.ts";
import type { Levels, PartialLine, Transport } from "./protocol.ts";

export const STALE_MS = 35_000;
export const WAKE_JUMP_MS = 10_000;
const TICK_MS = 2_000;
const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000];

export interface FollowEvents {
  /** The fold changed: redraw these line ids, or every line. Also after the first backlog. */
  changed(c: { all: boolean; ids: string[]; events: LogEvent[] }): void;
  partial(lines: PartialLine[]): void;
  level(l: Levels): void;
  connection(state: "open" | "reconnecting"): void;
}

export class Follower {
  readonly view: CallView = fold([]);
  /** How the follow went, for the window's own diagnostics (and the UI tests). */
  readonly stats = { opens: 0, reconnects: 0, duplicates: 0, gaps: 0, applied: 0 };
  private feed = 0;
  private handle: { close(): void } | null = null;
  private attempt = 0;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: LogEvent[] = [];
  private lastAlive = Date.now();
  private lastTick = Date.now();
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly onVisible = () => {
    if (document.visibilityState === "visible" && Date.now() - this.lastAlive > TICK_MS * 2) {
      this.reconnect("visible again");
    }
  };
  private readonly onOnline = () => this.reconnect("network back");

  constructor(
    private readonly t: Transport,
    readonly call: string,
    private readonly on: FollowEvents,
  ) {
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    document.addEventListener("visibilitychange", this.onVisible);
    addEventListener("online", this.onOnline);
    this.connect();
  }

  /** The last `seq` applied: where a reconnect resumes. */
  get cursor(): number {
    return this.view.lastSeq;
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.ticker);
    if (this.retry) clearTimeout(this.retry);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    document.removeEventListener("visibilitychange", this.onVisible);
    removeEventListener("online", this.onOnline);
    this.handle?.close();
    this.handle = null;
  }

  /** Drops the connection and opens a new one from the cursor. */
  reconnect(why: string): void {
    if (this.stopped) return;
    this.handle?.close();
    this.handle = null;
    this.stats.reconnects++;
    this.on.connection("reconnecting");
    this.schedule(why);
  }

  private schedule(_why: string): void {
    if (this.stopped || this.retry) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] as number;
    this.attempt++;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, wait);
  }

  private tick(): void {
    const now = Date.now();
    const jumped = now - this.lastTick > WAKE_JUMP_MS;
    this.lastTick = now;
    if (!this.handle) return;
    if (jumped) this.reconnect("woke from sleep");
    else if (now - this.lastAlive > STALE_MS) this.reconnect("no keep-alive");
  }

  private connect(): void {
    if (this.stopped) return;
    this.lastAlive = Date.now();
    let closed = false;
    const handle = this.t.follow(this.call, this.cursor, {
      open: () => {
        if (closed) return;
        this.attempt = 0;
        this.stats.opens++;
        this.lastAlive = Date.now();
        this.on.connection("open");
      },
      event: (e) => {
        if (closed) return;
        this.lastAlive = Date.now();
        this.accept(e);
      },
      partial: (p) => {
        if (closed) return;
        this.lastAlive = Date.now();
        this.on.partial(p);
      },
      level: (l) => {
        if (closed) return;
        this.lastAlive = Date.now();
        this.on.level(l);
      },
      alive: () => {
        this.lastAlive = Date.now();
      },
      closed: (why) => {
        if (closed || this.stopped) return;
        closed = true;
        if (this.handle === handle) this.handle = null;
        this.stats.reconnects++;
        this.on.connection("reconnecting");
        this.schedule(why);
      },
    });
    const wrapped = {
      close: () => {
        closed = true;
        handle.close();
      },
    };
    this.handle = wrapped;
  }

  private accept(e: LogEvent): void {
    const last = this.view.lastSeq;
    if (e.seq <= last) {
      this.stats.duplicates++;
      return;
    }
    if (e.seq !== last + 1) {
      // Something between was lost: never draw a hole, fetch it again from the cursor.
      this.stats.gaps++;
      this.reconnect(`gap after ${last}`);
      return;
    }
    this.view.apply(e);
    this.stats.applied++;
    this.pending.push(e);
    this.flushTimer ??= setTimeout(() => this.flush(), 16);
  }

  private flush(): void {
    this.flushTimer = null;
    const events = this.pending;
    this.pending = [];
    const ch = this.view.changesSince(this.feed);
    this.feed = ch.cursor;
    this.on.changed({ all: ch.all, ids: ch.ids, events });
  }
}
