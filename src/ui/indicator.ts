/**
 * The floating indicator (docs/ux/DESKTOP.md section 7, DK-F1): a small always-on-top window that
 * shows a recording at a glance while the main window is not in front. A dot, the elapsed time,
 * the two levels, Mute and Stop; a click on the dot and time opens the main window. Asking goes
 * through the palette, not here (PRINCIPLES.md).
 *
 * It shows no transcript text, no title, no names and no answers, so it can stay up during a
 * screen share. The rule is enforced on the main side (`src/main/window/indicator.ts`): this page
 * is only ever sent the shapes in `indicator-protocol.ts`.
 *
 * The elapsed time is the call's recorded time: from its first part, carried across a new part (a
 * capture rebuild, a wake), and standing still while paused.
 *
 * A degraded capture turns the dot into the warning mark with one word, never by colour alone
 * (PRINCIPLES 12).
 */

import { elapsedText, recordedMs } from "./indicator-clock.ts";
import type { IndicatorEvent, IndicatorStatus } from "./indicator-protocol.ts";
import type { Levels } from "./protocol.ts";

/** What a followed call feeds the page. */
export interface IndicatorSink {
  event(e: IndicatorEvent): void;
  level(l: Levels): void;
  closed(reason: string): void;
}

export interface IndicatorTransport {
  follow(call: string, after: number, sink: IndicatorSink): { close(): void };
  watchStatus(fn: (s: IndicatorStatus) => void): { close(): void };
  control(action: "stop" | "mute" | "unmute"): Promise<unknown>;
}

/** What the main process does for a click on the indicator. */
export interface IndicatorHost {
  open(): void;
}

type Health = Record<"mic" | "call", string>;

const WARN_WORD: Record<"mic" | "call", string> = { call: "call side silent", mic: "mic silent" };

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`the indicator page has no #${id}`);
  return e as T;
}

export function mountIndicator(
  t: IndicatorTransport,
  host: IndicatorHost,
  now: () => number = Date.now,
): { close(): void } {
  let live: IndicatorStatus["live"] = null;
  let followed: string | null = null;
  let follow: { close(): void } | null = null;
  let events: IndicatorEvent[] = [];
  let health: Health = { mic: "ok", call: "ok" };

  const draw = () => {
    const dot = el("dot");
    const state = el("state");
    const warn = (["call", "mic"] as const).find((ch) => health[ch] !== "ok");
    const mode = !live ? "idle" : warn ? "warn" : live.state === "paused" ? "paused" : "recording";
    dot.dataset.state = mode;
    // The mark says it by shape, the word says it in words.
    dot.textContent = { idle: "○", warn: "⚠", paused: "❚❚", recording: "●" }[mode];
    state.textContent = warn
      ? WARN_WORD[warn]
      : { idle: "Not recording", paused: "Paused", recording: "Recording", warn: "" }[mode];
    const mute = el<HTMLButtonElement>("mute");
    mute.textContent = live?.muted ? "Unmute" : "Mute";
    mute.setAttribute("aria-pressed", String(!!live?.muted));
    for (const id of ["mute", "stop"]) el<HTMLButtonElement>(id).disabled = !live;
    tick();
  };

  const tick = () => {
    const e = el("elapsed");
    const r = recordedMs(events, now());
    if (!live || r.since === null) {
      e.textContent = "";
      e.removeAttribute("title");
      return;
    }
    e.textContent = elapsedText(r.ms);
    const at = new Date(r.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    e.title = `recording since ${at}`;
  };

  const level = (l: Levels) => {
    for (const ch of ["mic", "call"] as const) {
      const m = el<HTMLMeterElement>(`lvl-${ch}`);
      m.value = Math.max(-60, Math.min(0, l[ch]));
    }
  };

  /** Follows the call from its first event: the page keeps no cursor, and the events are few. */
  const start = (call: string) => {
    events = [];
    health = { mic: "ok", call: "ok" };
    follow = t.follow(call, 0, sink);
  };

  const sink: IndicatorSink = {
    event: (e) => {
      events.push(e);
      if (e.type === "part.started") health = { mic: "ok", call: "ok" };
      else if (e.type === "health") health = { ...health, [e.ch]: e.state };
      draw();
    },
    level,
    closed: () => {
      if (followed && live?.call === followed) {
        const call = followed;
        setTimeout(() => {
          if (live?.call === call) start(call);
        }, 500);
      }
    },
  };

  const status = t.watchStatus((s) => {
    live = s.live;
    const call = live?.call ?? null;
    if (call !== followed) {
      follow?.close();
      follow = null;
      followed = call;
      events = [];
      health = { mic: "ok", call: "ok" };
      if (call) start(call);
    }
    draw();
  });

  el("stop").addEventListener("click", () => {
    if (live) void t.control("stop");
  });
  el("mute").addEventListener("click", () => {
    if (live) void t.control(live.muted ? "unmute" : "mute");
  });
  el("open").addEventListener("click", () => host.open());

  const timer = setInterval(tick, 1000);
  draw();
  return {
    close: () => {
      clearInterval(timer);
      status.close();
      follow?.close();
    },
  };
}
