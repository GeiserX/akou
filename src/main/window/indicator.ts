/**
 * The main process's half of the floating indicator's RPC (docs/ux/DESKTOP.md DK-F1): the API,
 * following a call and the status come from the window's own handlers (`rpc.ts`), and the two
 * requests back to the main window go to the shell. Like `rpc.ts`, no ElectroBun import.
 */

import type { IndicatorRpc } from "../../ui/indicator-protocol.ts";
import type { Bridge } from "./bridge.ts";
import { type WindowRpc, windowRpc } from "./rpc.ts";

type Messages = IndicatorRpc["webview"]["messages"];

/** What the handlers push to the indicator page; ElectroBun's `rpc.send`. */
export interface IndicatorSend {
  followed(m: Messages["followed"]): void;
  status(s: Messages["status"]): void;
}

export interface IndicatorRpcHandlers {
  handlers: Pick<WindowRpc["handlers"], "api" | "follow" | "unfollow" | "status"> & {
    focusAsk(p: Record<string, never>): Promise<boolean>;
    openMain(p: Record<string, never>): Promise<boolean>;
  };
  close(): void;
}

export function indicatorRpc(
  bridge: Bridge,
  send: () => IndicatorSend,
  host: { focusAsk(): Promise<void>; openMain(): Promise<void> },
): IndicatorRpcHandlers {
  const drop = () => {};
  const inner = windowRpc(
    bridge,
    () => ({
      followed: (m) => send().followed(m),
      status: (s) => send().status(s),
      asked: drop,
      showCall: drop,
      showSettings: drop,
      focusAsk: drop,
      askQuit: drop,
    }),
    async () => false,
  );
  const h = inner.handlers;
  return {
    handlers: {
      api: h.api,
      follow: h.follow,
      unfollow: h.unfollow,
      status: h.status,
      focusAsk: async () => {
        await host.focusAsk();
        return true;
      },
      openMain: async () => {
        await host.openMain();
        return true;
      },
    },
    close: () => inner.close(),
  };
}
