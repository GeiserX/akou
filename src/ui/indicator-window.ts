/**
 * The floating indicator's entry in ElectroBun (docs/ux/DESKTOP.md DK-F1): the page in
 * `indicator.ts` over typed RPC to the main process (`src/main/window/indicator.ts`), which sends
 * it only what `indicator-protocol.ts` allows. Like the window's (`window.ts`), a followed call
 * arrives as pushed messages tagged with the stream id the page chose.
 */

import { Electroview } from "electrobun/view";
import { type IndicatorSink, mountIndicator } from "./indicator.ts";
import type {
  IndicatorEvent,
  IndicatorFollowed,
  IndicatorRpc,
  IndicatorStatus,
} from "./indicator-protocol.ts";
import type { Levels } from "./protocol.ts";

const followers = new Map<string, IndicatorSink>();
const statusWatchers = new Set<(s: IndicatorStatus) => void>();

const rpc = Electroview.defineRPC<IndicatorRpc>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      followed: (m: IndicatorFollowed) => {
        const sink = followers.get(m.stream);
        if (!sink) return;
        if (m.kind === "event") sink.event(m.data as IndicatorEvent);
        else if (m.kind === "level") sink.level(m.data as Levels);
        else if (m.kind === "closed") {
          followers.delete(m.stream);
          sink.closed(String(m.data ?? "closed"));
        }
      },
      status: (s: IndicatorStatus) => {
        for (const fn of statusWatchers) fn(s);
      },
    },
  },
});
new Electroview({ rpc });

let streams = 0;

mountIndicator(
  {
    follow: (call, after, sink) => {
      const stream = `i${++streams}`;
      followers.set(stream, sink);
      rpc.request.follow({ stream, call, after }).catch((err: Error) => {
        if (followers.delete(stream)) sink.closed(err.message);
      });
      return {
        close: () => {
          if (followers.delete(stream)) void rpc.request.unfollow({ stream }).catch(() => {});
        },
      };
    },
    watchStatus: (fn) => {
      statusWatchers.add(fn);
      void rpc.request.status({}).then(fn, () => {});
      return { close: () => statusWatchers.delete(fn) };
    },
    control: (action) => rpc.request.control({ action }).catch(() => false),
  },
  { open: () => void rpc.request.openMain({}).catch(() => {}) },
);
