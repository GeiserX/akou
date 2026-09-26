/**
 * The main process's half of the floating indicator's RPC (docs/ux/DESKTOP.md DK-F1). Like
 * `rpc.ts`, no ElectroBun import.
 *
 * The indicator stays on top during a screen share, so what it may show is decided here, on the
 * main side, not by what its page happens to render: the status is cut to the live call's id,
 * state and mute; of a followed call only the part, pause, resume and health events cross, each
 * rebuilt from a list of fields, plus the levels. No title, workspace, line, partial, name or mic
 * device ever reaches the page. Its only controls are stop, mute and unmute of the live call, and
 * a click that opens the main window: no route of the API.
 */

import type { LogEvent } from "../../core/log/events.ts";
import type { IndicatorEvent, IndicatorRpc, IndicatorStatus } from "../../ui/indicator-protocol.ts";
import type { Levels } from "../../ui/protocol.ts";
import type { Bridge } from "./bridge.ts";

type Messages = IndicatorRpc["webview"]["messages"];
type Requests = IndicatorRpc["bun"]["requests"];
type Handler<K extends keyof Requests> = (
  p: Requests[K]["params"],
) => Promise<Requests[K]["response"]>;

/** What the handlers push to the indicator page; ElectroBun's `rpc.send`. */
export interface IndicatorSend {
  followed(m: Messages["followed"]): void;
  status(s: Messages["status"]): void;
}

export interface IndicatorRpcHandlers {
  handlers: { [K in keyof Requests]: Handler<K> };
  close(): void;
}

/** The status the indicator gets: the live call's id, state and mute, nothing else. */
export function indicatorStatus(s: unknown): IndicatorStatus {
  const live = (s as { live?: { call?: unknown; state?: unknown; muted?: unknown } | null })?.live;
  if (!live || typeof live.call !== "string") return { live: null };
  return { live: { call: live.call, state: String(live.state ?? ""), muted: live.muted === true } };
}

/** The event the indicator gets, rebuilt from the fields it needs; null for every other event. */
export function indicatorEvent(e: LogEvent): IndicatorEvent | null {
  switch (e.type) {
    case "part.started":
      return { type: "part.started", part: e.part, wallStart: e.wallStart };
    case "part.ended":
      return { type: "part.ended", part: e.part, at: e.t };
    case "pause":
      return { type: "pause", wall: e.wall };
    case "resume":
      return { type: "resume", wall: e.wall };
    case "health":
      return { type: "health", ch: e.ch, state: e.state };
    default:
      return null;
  }
}

export function indicatorRpc(
  bridge: Bridge,
  send: () => IndicatorSend,
  host: { openMain(): Promise<void> },
): IndicatorRpcHandlers {
  const follows = new Map<string, () => void>();
  const status = async () => indicatorStatus(await bridge.app.status());
  const unwatch = bridge.watchLifecycle(() => {
    void status().then((s) => send().status(s));
  });
  const stopFollow = (stream: string) => {
    follows.get(stream)?.();
    follows.delete(stream);
  };

  return {
    handlers: {
      follow: async ({ stream, call, after }) => {
        stopFollow(stream);
        const followed = (
          kind: Messages["followed"]["kind"],
          data?: Messages["followed"]["data"],
        ) => send().followed({ stream, kind, data });
        let stop: () => void;
        try {
          followed("open");
          stop = await bridge.follow(call, Math.max(0, Math.floor(after)), {
            event: (e) => {
              const slim = indicatorEvent(e);
              if (slim) followed("event", slim);
            },
            partial: () => {},
            level: (l: Levels) => followed("level", { mic: Number(l.mic), call: Number(l.call) }),
            read: () => {},
            keepalive: () => followed("alive"),
          });
        } catch (err) {
          followed("closed", (err as Error).message);
          return { ok: false };
        }
        follows.set(stream, stop);
        return { ok: true };
      },

      unfollow: async ({ stream }) => {
        stopFollow(stream);
        return { ok: true };
      },

      status: () => status(),

      control: async ({ action }) => {
        if (action !== "stop" && action !== "mute" && action !== "unmute") return false;
        const live = (await status()).live;
        if (!live) return false;
        const r = await bridge.json(
          "POST",
          `/calls/${encodeURIComponent(live.call)}/${action}`,
          {},
        );
        return r.status < 300;
      },

      openMain: async () => {
        await host.openMain();
        return true;
      },
    },
    close: () => {
      unwatch();
      for (const s of [...follows.keys()]) stopFollow(s);
    },
  };
}
