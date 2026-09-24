/**
 * Sharing a live call (docs/DESIGN.md section 8.3): one interface, so the v2 hub can replace the
 * v1 local link without touching the API or the window.
 *
 * Every transport shows the same thing: the call as the fold renders it (names and vocabulary
 * applied, echo removed), with the notepad only when asked for, never the audio, the raw text,
 * questions, answers, remembered lines or health.
 */

export type ShareExpiry = "call-end" | "call-end+2h" | { minutes: number };

export interface ShareOptions {
  include: { transcript: true; names: boolean; notes: boolean; enhanced: boolean; audio: false };
  expires: ShareExpiry;
  bind?: "tailnet" | "lan" | string;
}

export interface ShareHandle {
  id: string;
  call: string;
  url: string;
  /** Epoch ms; null while it waits for the call to end. */
  expiresAt: number | null;
}

export interface ShareStatus extends ShareHandle {
  kind: "local-link" | "hub";
  bind: string;
  since: number;
  viewers: number;
  bytes: number;
  include: ShareOptions["include"];
  expires: ShareExpiry;
  warning?: string;
}

export interface ShareTransport {
  readonly kind: "local-link" | "hub";
  start(call: string, opts: ShareOptions): Promise<ShareHandle>;
  stop(handle: ShareHandle): Promise<void>;
  status(): ShareStatus[];
}

/** `call-end`, `call-end+2h`, `90m`, `3h`: the expiry the CLI and the API accept. */
export function parseExpiry(raw: string | undefined): ShareExpiry | null {
  if (raw === undefined || raw === "") return "call-end+2h";
  if (raw === "call-end" || raw === "call-end+2h") return raw;
  const m = /^(\d{1,4})\s*(m|min|h)$/.exec(raw.trim());
  if (!m) return null;
  const minutes = Number(m[1]) * (m[2] === "h" ? 60 : 1);
  return minutes >= 1 && minutes <= 24 * 60 ? { minutes } : null;
}

/** When a share ends: at a fixed time, or at the call's end plus the grace. */
export function expiryAt(
  expires: ShareExpiry,
  start: number,
  callEndedAt: number | null,
): number | null {
  if (typeof expires === "object") return start + expires.minutes * 60_000;
  if (callEndedAt === null) return null;
  return callEndedAt + (expires === "call-end+2h" ? 2 * 3_600_000 : 0);
}
