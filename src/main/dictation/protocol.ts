/**
 * The dictation helper protocol, `akou-dictate/1` (docs/ux/DICTATION.md section 9): what the Bun
 * main process and `akou-capture dictate` say to each other. The helper's side is
 * `native/akou-capture/src/dictate/protocol.rs`; both are held to the lines in
 * `tests/fixtures/akou-dictate-lines.jsonl`, which a Rust test and a Bun test each check.
 *
 * - **stderr** (helper to app): one JSON object per line, tagged by `type`. A line that is not
 *   JSON, or a message that fails the checks below, is text for the log and never trusted.
 * - **stdin** (app to helper): one JSON object per line. Closing stdin means `stop`.
 * - **stdout** (helper to app): the `AKP1` audio packets of `akou-capture/1`
 *   (`src/main/capture/protocol.ts`), channel `mic`, only while a session runs. A session's audio
 *   starts at the key-down less the pre-roll ring and ends at the post-roll after the release.
 *
 * The helper never talks to the network, and never decides what a session's text is: it reports
 * keys and audio, and inserts what it is told to.
 */

import type { Activation } from "../../core/dictation/activation.ts";
import type { Target } from "../../core/dictation/events.ts";

export const DICTATE_PROTOCOL = "akou-dictate/1";

export type { FieldKind, Target } from "../../core/dictation/events.ts";

/**
 * Why a session's audio stopped.
 * - `release`: a push-to-talk hold ended; `tap`: a latched session was tapped off (or
 *   `session.stop`); `key`: Enter or Shift+Enter ended it, its `key` line came first (DC-A4).
 * - `cancel`: Escape, `session.cancel`, or another key during a confirmed modifier hold (DC-A1's
 *   interrupt); kept in history as `cancelled`. A press interrupted before it became a session
 *   sends nothing at all.
 * - `silence`, `max`: a latched session ended by itself (DC-A3).
 * - `stop`: the app stopped the helper.
 */
export const END_REASONS = ["release", "tap", "key", "cancel", "silence", "max", "stop"] as const;
export type EndReason = (typeof END_REASONS)[number];

/** How a text is inserted (DC-N6, DC-N7): paste with a receipt, typed keys, or clipboard only. */
export const INSERT_METHODS = ["paste", "type", "clipboard"] as const;
export type InsertMethod = (typeof INSERT_METHODS)[number];

/** The key pressed after an insert (DC-S2). */
export const SEND_KEYS = ["Enter", "Ctrl+Enter", "Cmd+Enter", "Shift+Enter", "none"] as const;
export type SendKey = (typeof SEND_KEYS)[number];

export { ACTIVATIONS, type Activation } from "../../core/dictation/activation.ts";

/**
 * A grant as `ready` reports it; `not-needed` where the OS asks for none (Windows), `not-asked`
 * where macOS has never asked for the microphone, which it does when the device first opens.
 */
export const GRANTS = ["granted", "denied", "not-asked", "not-needed"] as const;
export type Grant = (typeof GRANTS)[number];

/** One hunk of an edit read back from the field (DC-L2): only the text around the insert. */
export interface EditHunk {
  /** What akou inserted in this stretch. */
  inserted: string;
  /** What the field holds there now. */
  now: string;
  /** The index of the hunk's first inserted word, counted over the inserted text's words. */
  at?: number;
}

// ---------------------------------------------------------------------------
// Helper to app (stderr)

export type HelperToApp =
  | {
      type: "ready";
      protocol: string;
      version: string;
      grants: { mic: Grant; accessibility: Grant };
      /** The key source: `tap` (macOS), `hook` (Windows), `evdev`, `portal`, `cli`, `fake`. */
      backend: string;
      /** False on the portal and CLI backends: no key but the hotkey does anything (DC-A4). */
      swallow_keys: boolean;
    }
  /** The answer to `rebind`; on a refusal the old binding stays (DC-A7). */
  | { type: "rebound"; hotkey: string }
  | { type: "rebind.failed"; hotkey: string; reason: string }
  | { type: "session.started"; id: string; target: Target; capture_ns: string | number }
  /**
   * The session `id` is latched now (tapped on, or a chord released before `HOLD_MS`), so the app
   * may end it after silence (DC-A3). A held session never gets one.
   */
  | { type: "latched"; id: string }
  | { type: "level"; rms: number }
  | { type: "key"; name: string }
  | { type: "grant.lost"; name: string }
  | { type: "session.ended"; id: string; reason: EndReason }
  | { type: "inserted"; id: string; method: InsertMethod; receipt_ms: number }
  | { type: "insert.failed"; id: string; reason: string }
  | { type: "edit"; id: string; hunks: EditHunk[] }
  | { type: "edit.unreadable"; id: string; reason: string }
  | { type: "secure_input"; on: boolean }
  /** The warm stream opened or closed (DC-N4). */
  | { type: "mic"; open: boolean }
  | { type: "warn"; code: string; msg: string }
  | { type: "stopped"; reason: string };

// ---------------------------------------------------------------------------
// App to helper (stdin)

export interface Bindings {
  hotkey: string;
  /** Empty: no binding. */
  draft: string;
  fixLast: string;
  pasteLast: string;
  activation: Activation;
}

export type AppToHelper =
  | ({ type: "rebind" } & Bindings)
  | {
      type: "insert";
      id: string;
      text: string;
      method: InsertMethod;
      send_key: SendKey;
      target: Target;
      /** `dictation.restoreClipboard`: absent, the helper puts the old clipboard back. */
      restore?: boolean;
      /**
       * `dictation.readField` (DC-L2): read the field back after the insert and answer with one
       * `edit` or `edit.unreadable`. Absent, nothing is read.
       */
      read_field?: boolean;
    }
  /** This session will not be inserted: the helper stops holding Escape and Enter now. */
  | { type: "settled"; id: string }
  | { type: "focus"; target: Target }
  /** The tray's and the CLI's door (DC-G1, DC-G3): a latched session, as if the key were tapped. */
  | { type: "session.start" }
  | { type: "session.stop" }
  | { type: "session.cancel" }
  /**
   * The microphone (DC-U4, DC-N5): `device` is `dictation.mic`, `default` when empty;
   * `prefer_built_in` is `dictation.preferBuiltInOverBluetooth`, true when absent.
   */
  | { type: "rebuild_mic"; device: string; prefer_built_in?: boolean }
  | { type: "warm"; mode: "off" | "auto" | "always" }
  | { type: "record_keys"; on: boolean }
  | { type: "stop" };

export function encodeCommand(c: AppToHelper): string {
  return `${JSON.stringify(c)}\n`;
}

// ---------------------------------------------------------------------------
// Checks: a message is trusted only when every field it carries has its type

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isId = (v: unknown): v is string => isStr(v) && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const isGrant = (v: unknown): v is Grant => (GRANTS as readonly unknown[]).includes(v);
const isNs = (v: unknown): boolean =>
  (isNum(v) && Number.isInteger(v) && v >= 0) || (isStr(v) && /^\d+$/.test(v));
const FIELDS: readonly string[] = ["editable", "not-editable", "unknown", "secure"];

function isTarget(v: unknown): v is Target {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    isStr(t.app) && isNum(t.pid) && isStr(t.window) && isStr(t.field) && FIELDS.includes(t.field)
  );
}

function isHunk(v: unknown): v is EditHunk {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    isStr(h.inserted) &&
    isStr(h.now) &&
    (h.at === undefined || (isNum(h.at) && Number.isInteger(h.at) && h.at >= 0))
  );
}

/** Null when the message is well formed, else what is wrong with it. */
export function checkHelperMessage(o: Record<string, unknown>): string | null {
  switch (o.type) {
    case "ready": {
      const g = o.grants as Record<string, unknown> | null;
      if (typeof g !== "object" || g === null || !isGrant(g.mic) || !isGrant(g.accessibility))
        return "ready.grants";
      return isStr(o.protocol) && isStr(o.version) && isStr(o.backend) && isBool(o.swallow_keys)
        ? null
        : "ready";
    }
    case "rebound":
      return isStr(o.hotkey) ? null : "rebound";
    case "rebind.failed":
      return isStr(o.hotkey) && isStr(o.reason) ? null : "rebind.failed";
    case "session.started":
      return isId(o.id) && isTarget(o.target) && isNs(o.capture_ns) ? null : "session.started";
    case "latched":
      return isId(o.id) ? null : "latched";
    case "level":
      return isNum(o.rms) && o.rms >= 0 ? null : "level";
    case "key":
      return isStr(o.name) ? null : "key";
    case "grant.lost":
      return isStr(o.name) ? null : "grant.lost";
    case "session.ended":
      return isId(o.id) && (END_REASONS as readonly unknown[]).includes(o.reason)
        ? null
        : "session.ended";
    case "inserted":
      return isId(o.id) &&
        (INSERT_METHODS as readonly unknown[]).includes(o.method) &&
        isNum(o.receipt_ms)
        ? null
        : "inserted";
    case "insert.failed":
      return isId(o.id) && isStr(o.reason) ? null : "insert.failed";
    case "edit":
      return isId(o.id) && Array.isArray(o.hunks) && o.hunks.every(isHunk) ? null : "edit";
    case "edit.unreadable":
      return isId(o.id) && isStr(o.reason) ? null : "edit.unreadable";
    case "secure_input":
      return isBool(o.on) ? null : "secure_input";
    case "mic":
      return isBool(o.open) ? null : "mic";
    case "warn":
      return isStr(o.code) && isStr(o.msg) ? null : "warn";
    case "stopped":
      return isStr(o.reason) ? null : "stopped";
    default:
      return `unknown type ${String(o.type)}`;
  }
}

/** A stderr line: a protocol message, or text that only goes to the log. */
export type DictateLine = { kind: "msg"; msg: HelperToApp } | { kind: "text"; line: string };

export function parseHelperLine(line: string): DictateLine {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return { kind: "text", line };
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return { kind: "text", line };
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { kind: "text", line };
  if (checkHelperMessage(o as Record<string, unknown>) !== null) return { kind: "text", line };
  return { kind: "msg", msg: o as HelperToApp };
}

/** Parses one stdin line on the helper's side (the fake helper and the Rust tests' fixtures). */
export function parseCommand(line: string): AppToHelper | null {
  const t = line.trim();
  if (t === "stop") return { type: "stop" };
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t) as { type?: unknown };
    return typeof o === "object" && o !== null && isStr(o.type) ? (o as AppToHelper) : null;
  } catch {
    return null;
  }
}
