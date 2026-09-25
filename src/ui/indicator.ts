/**
 * The floating indicator (docs/ux/DESKTOP.md section 7, DK-F1): a small always-on-top window that
 * shows a recording at a glance while the main window is not in front. A dot, the elapsed time,
 * the two levels, Mute, Ask and Stop; a click on the dot and time opens the main window.
 *
 * It shows no transcript text, no title, no names and no answers, so it can stay up during a
 * screen share. The rule is structural: the page reads the status for the call's id, state and
 * mute, and of the followed events only `part.started`, `part.ended` and `health`; nothing else a
 * call holds is ever put on the page.
 *
 * A degraded capture turns the dot into the warning mark with one word, never by colour alone
 * (PRINCIPLES 12).
 */

import type { LogEvent } from "../core/log/events.ts";
import type { AppStatus, FollowSink, Levels, Transport } from "./protocol.ts";

export type IndicatorTransport = Pick<Transport, "request" | "follow" | "watchStatus">;

/** What the main process does for the page's Ask and for a click on it. */
export interface IndicatorHost {
  ask(): void;
  open(): void;
}

type Health = Record<"mic" | "call", string>;

const WARN_WORD: Record<"mic" | "call", string> = { call: "call side silent", mic: "mic silent" };

/** `h:mm:ss`, or `m:ss` under an hour: a duration, never a time of day. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh > 0 ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

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
  let live: AppStatus["live"] = null;
  let followed: string | null = null;
  let follow: { close(): void } | null = null;
  let since: number | null = null;
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
    if (!live || since === null) {
      e.textContent = "";
      e.removeAttribute("title");
      return;
    }
    e.textContent = elapsedText(now() - since);
    const at = new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    e.title = `recording since ${at}`;
  };

  const level = (l: Levels) => {
    for (const ch of ["mic", "call"] as const) {
      const m = el<HTMLMeterElement>(`lvl-${ch}`);
      m.value = Math.max(-60, Math.min(0, l[ch]));
    }
  };

  const sink: FollowSink = {
    open: () => {},
    event: (e: LogEvent) => {
      if (e.type === "part.started") {
        since = e.wallStart;
        health = { mic: "ok", call: "ok" };
      } else if (e.type === "part.ended") {
        since = null;
      } else if (e.type === "health") {
        health = { ...health, [e.ch]: e.state };
      } else return;
      draw();
    },
    partial: () => {},
    level,
    read: () => {},
    alive: () => {},
    closed: () => {
      // Reconnect from the start: the page keeps no cursor, and the events it reads are few.
      if (followed && live?.call === followed) {
        const call = followed;
        setTimeout(() => {
          if (live?.call === call) follow = t.follow(call, 0, sink);
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
      since = null;
      health = { mic: "ok", call: "ok" };
      if (call) follow = t.follow(call, 0, sink);
    }
    draw();
  });

  const control = (name: string) => {
    if (live) void t.request("POST", `/calls/${encodeURIComponent(live.call)}/${name}`, {});
  };
  el("stop").addEventListener("click", () => control("stop"));
  el("mute").addEventListener("click", () => control(live?.muted ? "unmute" : "mute"));
  el("ask").addEventListener("click", () => host.ask());
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
