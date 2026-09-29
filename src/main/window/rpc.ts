/**
 * The main process's half of the window's typed RPC (docs/DESIGN.md sections 6.3 rule 7 and 7):
 * the handlers for the requests the page makes (`src/ui/window.ts`), over the bridge, and the
 * messages pushed back. It needs no ElectroBun import, so it is tested with a plain function
 * standing in for `rpc.send`.
 *
 * A followed call and a streamed answer are streams the page names; closing one (or the window)
 * stops the follower at once. The page recovers from sleep or a frozen webview by following again
 * from its cursor, and a new follow on a stream id replaces the old one.
 */

import type { AkouRpc, AppStatus, Method } from "../../ui/protocol.ts";
import type { Bridge } from "./bridge.ts";
import type { SettingsPane } from "./page-server.ts";
import { levelDb } from "./pill.ts";

type Messages = AkouRpc["webview"]["messages"];

/** What the handlers push to the page; ElectroBun's `rpc.send`. */
export interface WindowSend {
  followed(m: Messages["followed"]): void;
  asked(m: Messages["asked"]): void;
  status(s: Messages["status"]): void;
  showCall(m: Messages["showCall"]): void;
  showSettings(m: Messages["showSettings"]): void;
  askQuit(m: Messages["askQuit"]): void;
  /** A key the dictation helper reported while the page's recorder is open (DC-U3). */
  dictationKey?(m: Messages["dictationKey"]): void;
  /** The dictation mic's level while the page's meter is on (DC-U4, DC-N3). */
  dictationLevel?(m: Messages["dictationLevel"]): void;
}

export interface WindowRpc {
  handlers: {
    api(p: {
      method: Method;
      path: string;
      body?: unknown;
    }): Promise<{ status: number; body: unknown }>;
    follow(p: { stream: string; call: string; after: number }): Promise<{ ok: boolean }>;
    unfollow(p: { stream: string }): Promise<{ ok: boolean }>;
    ask(p: { stream: string; call: string; question: string }): Promise<{ ok: boolean }>;
    cancelAsk(p: { stream: string }): Promise<{ ok: boolean }>;
    audio(p: { call: string; part: number }): Promise<{ type: string; base64: string }>;
    status(p: Record<string, never>): Promise<AppStatus>;
    openSettingsPane(p: { pane: SettingsPane }): Promise<boolean>;
    answerQuit(p: { id: number; go: boolean }): Promise<boolean>;
    recordDictationKeys(p: { on: boolean }): Promise<boolean>;
    watchDictationMic(p: { on: boolean }): Promise<boolean>;
    zoomWindow(p: Record<string, never>): Promise<boolean>;
  };
  /** Stops every stream (the window closed). */
  close(): void;
}

export function windowRpc(
  bridge: Bridge,
  send: () => WindowSend,
  openSettings: (pane: SettingsPane) => Promise<boolean>,
  /** The page pulled the status, which it does once its message handlers are registered. */
  booted: () => void = () => {},
  /** The page answered the quit question `id` (DK-M3). */
  answerQuit: (id: number, go: boolean) => void = () => {},
  /** The page's title bar strip was double-clicked (DK-M7). */
  zoom: () => void = () => {},
): WindowRpc {
  const follows = new Map<string, () => void>();
  const asks = new Map<string, AbortController>();
  /** The page's dictation key recorder holds the helper's keys (DC-U3). */
  let recording = false;
  /** The page's mic meter: the service it turned on, and the follow of its levels. */
  let meter: { svc: { watchMic(on: boolean): boolean }; stop: () => void } | null = null;
  const stopMeter = () => {
    meter?.stop();
    meter?.svc.watchMic(false);
    meter = null;
  };
  const unwatch = bridge.watchLifecycle(() => {
    void (bridge.app.status() as Promise<unknown>).then((s) => send().status(s as AppStatus));
  });

  const stopFollow = (stream: string) => {
    follows.get(stream)?.();
    follows.delete(stream);
  };

  return {
    handlers: {
      api: async ({ method, path, body }) => bridge.json(method, path, body),

      follow: async ({ stream, call, after }) => {
        stopFollow(stream);
        const followed = (kind: Messages["followed"]["kind"], data?: unknown) =>
          send().followed({ stream, kind, data });
        let stop: () => void;
        try {
          followed("open");
          stop = await bridge.follow(call, Math.max(0, Math.floor(after)), {
            event: (e) => followed("event", e),
            partial: (p) => followed("partial", p),
            level: (l) => followed("level", l),
            read: (r) => followed("read", r),
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

      ask: async ({ stream, call, question }) => {
        const ctl = new AbortController();
        asks.set(stream, ctl);
        const asked = (kind: Messages["asked"]["kind"], data: unknown) =>
          send().asked({ stream, kind, data });
        void bridge
          .ask(
            call,
            question,
            {
              excerpts: (d) => asked("excerpts", d),
              token: (t) => asked("token", t),
              answer: (d) => asked("answer", d),
              error: (d) => asked("error", d),
            },
            ctl.signal,
          )
          .catch((err) => asked("error", { error: "failed", message: (err as Error).message }))
          .finally(() => asks.delete(stream));
        return { ok: true };
      },

      cancelAsk: async ({ stream }) => {
        asks.get(stream)?.abort();
        asks.delete(stream);
        return { ok: true };
      },

      audio: async ({ call, part }) => {
        const res = await bridge.request(
          "GET",
          `/calls/${encodeURIComponent(call)}/audio/${Math.floor(part)}`,
        );
        if (!res.ok) throw new Error(`the audio of part ${part} is not available (${res.status})`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        return {
          type: res.headers.get("content-type") ?? "audio/ogg",
          base64: Buffer.from(bytes).toString("base64"),
        };
      },

      status: async () => {
        booted();
        return (await bridge.app.status()) as unknown as AppStatus;
      },

      openSettingsPane: async ({ pane }) => openSettings(pane),

      answerQuit: async ({ id, go }) => {
        answerQuit(id, go === true);
        return true;
      },

      zoomWindow: async () => {
        zoom();
        return true;
      },

      // The helper reports every key while the recorder is open, Fn and Globe included, which the
      // webview never sees (DC-U3). False with dictation off: the recorder takes what the page sees.
      // False too while its key tap is dead (Accessibility denied or taken back): it hears no key,
      // so `Use Fn` must not blame the keyboard (DC-N2).
      recordDictationKeys: async ({ on }) => {
        const d = bridge.app.dictation?.();
        if (!d) return false;
        const ok = d.recordKeys(on ? (name) => send().dictationKey?.({ name }) : null);
        recording = on && ok;
        const st = d.status();
        return ok && st.grants?.accessibility !== "denied" && !st.lost.includes("accessibility");
      },
      // The helper's mic level while the page shows a meter (DC-U4, DC-N3), in dBFS. False while
      // no helper is up: the meter stays still and the setup goes on. The meter is kept on all
      // the same, so a helper that starts while the page shows it (the setup turning dictation
      // on) moves it, and the page closing still turns it off.
      watchDictationMic: async ({ on }) => {
        stopMeter();
        if (!on) return true;
        const d = bridge.app.dictation?.();
        if (!d) return false;
        const ok = d.watchMic(true);
        const stop = d.follow((m) => {
          if (m.kind === "level") send().dictationLevel?.({ db: levelDb(m.rms) });
        });
        meter = { svc: d, stop };
        return ok;
      },
    },
    close: () => {
      unwatch();
      if (recording) bridge.app.dictation?.()?.recordKeys(null);
      recording = false;
      stopMeter();
      for (const s of [...follows.keys()]) stopFollow(s);
      for (const a of asks.values()) a.abort();
      asks.clear();
    },
  };
}
