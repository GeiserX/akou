/**
 * The ElectroBun window's entry (docs/DESIGN.md sections 6.3 rule 7 and 7): the same page as the
 * browser's, over typed RPC to the main process instead of HTTP. The main side is
 * `src/main/window/rpc.ts`. Streams (a followed call, a streamed answer) arrive as pushed messages
 * tagged with the stream id the page chose, so a stream the page closed can never feed it again.
 */

import { Electroview } from "electrobun/view";
import type { LogEvent } from "../core/log/events.ts";
import { boot, showCall } from "./app.ts";
import type {
  AkouRpc,
  AppStatus,
  AskSink,
  FollowSink,
  Levels,
  Method,
  PartialLine,
  Reply,
  Transport,
} from "./protocol.ts";

type Followed = AkouRpc["webview"]["messages"]["followed"];
type Asked = AkouRpc["webview"]["messages"]["asked"];

const followers = new Map<string, FollowSink>();
const askers = new Map<string, AskSink>();
const statusWatchers = new Set<(s: AppStatus) => void>();

const rpc = Electroview.defineRPC<AkouRpc>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      followed: (m: Followed) => {
        const sink = followers.get(m.stream);
        if (!sink) return;
        if (m.kind === "open") sink.open();
        else if (m.kind === "event") sink.event(m.data as LogEvent);
        else if (m.kind === "partial") sink.partial(m.data as PartialLine[]);
        else if (m.kind === "level") sink.level(m.data as Levels);
        else if (m.kind === "alive") sink.alive();
        else {
          followers.delete(m.stream);
          sink.closed(String(m.data ?? "closed"));
        }
      },
      asked: (m: Asked) => {
        const sink = askers.get(m.stream);
        if (!sink) return;
        if (m.kind === "excerpts") sink.excerpts(m.data as never);
        else if (m.kind === "token") sink.token(m.data as string);
        else if (m.kind === "answer") {
          askers.delete(m.stream);
          sink.answer(m.data as never);
        } else {
          askers.delete(m.stream);
          sink.error(m.data as never);
        }
      },
      status: (s: AppStatus) => {
        for (const fn of statusWatchers) fn(s);
      },
      showCall: (m: { call?: string }) => showCall(m.call),
    },
  },
});
new Electroview({ rpc });

let streams = 0;
const nextStream = () => `s${++streams}`;

class RpcTransport implements Transport {
  readonly kind = "window" as const;

  async request<T = unknown>(method: Method, path: string, body?: unknown): Promise<Reply<T>> {
    return (await rpc.request.api({ method, path, body }, { maxRequestTime: 600_000 })) as Reply<T>;
  }

  follow(call: string, after: number, sink: FollowSink): { close(): void } {
    const stream = nextStream();
    followers.set(stream, sink);
    rpc.request.follow({ stream, call, after }).catch((err: Error) => {
      if (followers.delete(stream)) sink.closed(err.message);
    });
    return {
      close: () => {
        if (followers.delete(stream)) void rpc.request.unfollow({ stream }).catch(() => {});
      },
    };
  }

  ask(call: string, question: string, sink: AskSink): { cancel(): void } {
    const stream = nextStream();
    askers.set(stream, sink);
    rpc.request.ask({ stream, call, question }).catch((err: Error) => {
      if (askers.delete(stream)) sink.error({ error: "failed", message: err.message });
    });
    return {
      cancel: () => {
        if (askers.delete(stream)) void rpc.request.cancelAsk({ stream }).catch(() => {});
      },
    };
  }

  async audio(call: string, part: number): Promise<Blob> {
    const r = (await rpc.request.audio({ call, part }, { maxRequestTime: 120_000 })) as {
      type: string;
      base64: string;
    };
    const bin = atob(r.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: r.type });
  }

  watchStatus(fn: (s: AppStatus) => void): { close(): void } {
    statusWatchers.add(fn);
    void rpc.request.status({}).then(fn, () => {});
    return { close: () => statusWatchers.delete(fn) };
  }

  async openSettingsPane(pane: "microphone" | "system-audio"): Promise<boolean> {
    return (await rpc.request.openSettingsPane({ pane })) as boolean;
  }
}

boot(new RpcTransport());
