/**
 * The call state machine (docs/DESIGN.md sections 1.5, 2.4, 2.5 and 4.5).
 *
 * ```
 * idle ──start──▶ starting ──capturing──▶ recording ◀──resume── paused
 *                    │  │                    │  │ ▲──pause──────┘
 *                    │  └─stop─▶ stopping ◀──┘  │ restart (new part, same state)
 *                    ▼              │            ▼
 *                 failed          ended     interrupted (5 automatic restarts in 10 min)
 *
 * ended, interrupted, failed ──restart──▶ starting (a new part in the same folder)
 * ```
 *
 * Every transition is also an event in the log; the log is the record, this is the controller's
 * working state. `starting` for a restart of a finished call goes back to where it came from if
 * the new part never captures, because `call.failed` is only for a start that never captured.
 */

export type CallStatus =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "ended"
  | "failed"
  | "interrupted";

export const TRANSITIONS: { readonly [S in CallStatus]: readonly CallStatus[] } = {
  idle: ["starting"],
  starting: ["recording", "stopping", "failed", "ended", "interrupted"],
  recording: ["paused", "stopping", "interrupted"],
  paused: ["recording", "stopping", "interrupted"],
  stopping: ["ended"],
  ended: ["starting"],
  failed: ["starting"],
  interrupted: ["starting", "ended"],
};

/** A call in one of these states is the live call; there is at most one. */
export const LIVE_STATUSES: ReadonlySet<CallStatus> = new Set(["starting", "recording", "paused"]);

export class TransitionError extends Error {
  override name = "TransitionError";
}

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CallStatus, to: CallStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(`call cannot go from ${from} to ${to}`);
}

/** How long each step may take, ms. Every one is injectable so tests can use a fake clock. */
export interface CallBudgets {
  /** Wait for `capturing` when a helper has captured before in this app run. */
  warmStartMs: number;
  /** Wait for `capturing` on the first start (cold Core Audio open). */
  coldStartMs: number;
  /** Stop, then kill. */
  stopMs: number;
  /** A `dead` call side that lasts this long triggers an automatic restart. */
  deadRestartMs: number;
  /** No packet at all from the helper for this long means the helper is wedged. */
  stallMs: number;
  autoRestartLimit: number;
  autoRestartWindowMs: number;
  /** Restarting a finished call whose last audio is older than this needs `force`. */
  staleRestartMs: number;
  /** An interrupted call with no resume for this long is closed as abandoned. */
  abandonAfterMs: number;
  /** Before `call.ended`, the live recognizer may take this long to write its open segments. */
  flushMs: number;
}

export const DEFAULT_BUDGETS: CallBudgets = {
  warmStartMs: 3_000,
  coldStartMs: 10_000,
  stopMs: 5_000,
  deadRestartMs: 60_000,
  stallMs: 10_000,
  autoRestartLimit: 5,
  autoRestartWindowMs: 10 * 60_000,
  staleRestartMs: 60 * 60_000,
  abandonAfterMs: 24 * 60 * 60_000,
  flushMs: 5_000,
};

/** An answer the API layer maps one to one onto HTTP (DESIGN 6.2). */
export type Outcome<T extends object = object> =
  | ({ ok: true } & T)
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
      stage?: string;
      call?: string;
      last?: { id: string; title: string; endedAt: number | null } | null;
    };

export function fail(
  status: number,
  code: string,
  error: string,
  extra: { stage?: string; call?: string } = {},
): Extract<Outcome, { ok: false }> {
  return { ok: false, status, code, error, ...extra };
}
