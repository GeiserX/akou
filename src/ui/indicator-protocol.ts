/**
 * The floating indicator's RPC with the main process (docs/ux/DESKTOP.md section 7, DK-F1). Types
 * only. A subset of the window's (`protocol.ts`): the API, following the live call and the status,
 * plus the two ways back to the main window. It carries no transcript: the page never asks for one.
 */

import type { AkouRpc, AppStatus } from "./protocol.ts";

type Bun = AkouRpc["bun"]["requests"];
type Web = AkouRpc["webview"]["messages"];

export interface IndicatorRpc {
  bun: {
    requests: {
      api: Bun["api"];
      follow: Bun["follow"];
      unfollow: Bun["unfollow"];
      status: Bun["status"];
      /** Ask: the main window forward with its ask box focused. */
      focusAsk: { params: Record<string, never>; response: boolean };
      /** A click on the indicator: the main window on the live call. */
      openMain: { params: Record<string, never>; response: boolean };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: Record<string, never>;
    messages: { followed: Web["followed"]; status: AppStatus };
  };
}
