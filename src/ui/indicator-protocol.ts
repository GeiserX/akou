/**
 * The floating indicator's RPC with the main process (docs/ux/DESKTOP.md section 7, DK-F1). Types
 * only. The main side (`src/main/window/indicator.ts`) cuts everything to these shapes, so no
 * title, workspace, line, partial, name or device name can reach the page: the page gets the live
 * call's id, state and mute, the part, pause, resume and health events, and the levels. Its
 * requests are the live call's stop, mute and unmute, and a click that opens the main window.
 */

import type { Levels } from "./protocol.ts";

/** The status the indicator reads. */
export interface IndicatorStatus {
  live: { call: string; state: string; muted: boolean } | null;
}

/** The events the indicator reads, rebuilt field by field on the main side. */
export type IndicatorEvent =
  | { type: "part.started"; part: number; wallStart: number }
  /** `at`: when the end was written, epoch ms. */
  | { type: "part.ended"; part: number; at: number }
  | { type: "pause"; wall: number }
  | { type: "resume"; wall: number }
  | { type: "health"; ch: "mic" | "call"; state: string };

export interface IndicatorFollowed {
  stream: string;
  kind: "open" | "event" | "level" | "alive" | "closed";
  /** An `IndicatorEvent`, the `Levels`, or the reason a follow closed. */
  data?: IndicatorEvent | Levels | string;
}

export interface IndicatorRpc {
  bun: {
    requests: {
      follow: {
        params: { stream: string; call: string; after: number };
        response: { ok: boolean };
      };
      unfollow: { params: { stream: string }; response: { ok: boolean } };
      status: { params: Record<string, never>; response: IndicatorStatus };
      /** Stop, mute or unmute the live call; false when no call records. */
      control: { params: { action: "stop" | "mute" | "unmute" }; response: boolean };
      /** A click on the indicator: the main window on the live call. */
      openMain: { params: Record<string, never>; response: boolean };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: Record<string, never>;
    messages: { followed: IndicatorFollowed; status: IndicatorStatus };
  };
}
