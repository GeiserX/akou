/**
 * The floating indicator's entry in ElectroBun (docs/ux/DESKTOP.md DK-F1): the page in
 * `indicator.ts` over typed RPC to the main process (`src/main/window/indicator.ts`). Like the
 * window's (`window.ts`), a followed call arrives as pushed messages tagged with the stream id the
 * page chose.
 */

import { Electroview } from "electrobun/view";
import type { LogEvent } from "../core/log/events.ts";
import { mountIndicator } from "./indicator.ts";
import type { IndicatorRpc } from "./indicator-protocol.ts";
import type { AppStatus, FollowSink, Levels, Method, Reply } from "./protocol.ts";

type Followed = IndicatorRpc["webview"]["messages"]["followed"];

const followers = new Map<string, FollowSink>();
const statusWatchers = new Set<(s: AppStatus) => void>();

const rpc = Electroview.defineRPC<IndicatorRpc>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      followed: (m: Followed) => {
        const sink = followers.get(m.stream);
        if (!sink) return;
        if (m.kind === "open") sink.open();
        else if (m.kind === "event") sink.event(m.data as LogEvent);
        else if (m.kind === "level") sink.level(m.data as Levels);
        else if (m.kind === "alive") sink.alive();
        else if (m.kind === "closed") {
          followers.delete(m.stream);
          sink.closed(String(m.data ?? "closed"));
        }
      },
      status: (s: AppStatus) => {
        for (const fn of statusWatchers) fn(s);
      },
    },
  },
});
new Electroview({ rpc });

let streams = 0;

mountIndicator(
  {
    request: async <T = unknown>(method: Method, path: string, body?: unknown) =>
      (await rpc.request.api({ method, path, body })) as Reply<T>,
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
  },
  {
    ask: () => void rpc.request.focusAsk({}).catch(() => {}),
    open: () => void rpc.request.openMain({}).catch(() => {}),
  },
);
