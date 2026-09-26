/**
 * The dictation helper protocol, `akou-dictate/1` (docs/ux/DICTATION.md section 9): what the Bun
 * main process and `akou-capture dictate` say to each other. This file is the contract both sides
 * build against; the Rust side mirrors it.
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
 * - `release`: a push-to-talk hold ended; `tap`: a latched session was tapped off.
 * - `cancel`: Escape or the pill's Cancel; the audio is kept in history as `cancelled` (DC-A4).
 * - `interrupt`: another key went down during a modifier-only hold, so the press was a shortcut
 *   (Right Command+C); nothing is transcribed and nothing is kept (DC-A1).
 * - `silence`, `max`: a latched session ended by itself (DC-A3).
 */
export const END_REASONS = ["release", "tap", "cancel", "interrupt", "silence", "max"] as const;
export type EndReason = (typeof END_REASONS)[number];

/** How a text is inserted (DC-N6, DC-N7): paste with a receipt, typed keys, or clipboard only. */
export const INSERT_METHODS = ["paste", "type", "clipboard"] as const;
export type InsertMethod = (typeof INSERT_METHODS)[number];

/** The key pressed after an insert (DC-S2). */
export const SEND_KEYS = ["Enter", "Ctrl+Enter", "Cmd+Enter", "Shift+Enter", "none"] as const;
export type SendKey = (typeof SEND_KEYS)[number];

export { ACTIVATIONS, type Activation } from "../../core/dictation/activation.ts";

/** One hunk of an edit read back from the field (DC-L2): only the text around the insert. */
export interface EditHunk {
  /** What akou inserted in this stretch. */
  inserted: string;
  /** What the field holds there now. */
  now: string;
}

// ---------------------------------------------------------------------------
// Helper to app (stderr)

export type HelperToApp =
  | {
      type: "ready";
      protocol: string;
      version: string;
      grants: { mic: boolean; accessibility: boolean };
      /** The key source: `tap` (macOS), `hook` (Windows), `evdev`, `portal`, `cli`, `fake`. */
      backend: string;
      /** False on the portal and CLI backends: no key but the hotkey does anything (DC-A4). */
      swallow_keys: boolean;
    }
  | { type: "bound"; hotkey: string }
  | { type: "bind.failed"; hotkey: string; reason: string }
  | { type: "session.started"; id: string; target: Target; capture_ns: string | number }
  | { type: "level"; rms: number }
  | { type: "key"; name: string }
  | { type: "grant.lost"; name: string }
  /**
   * `samples`: how many samples this session sent on stdout. stderr and stdout are two pipes with
   * no order between them, so the app keeps reading audio until it holds them all.
   */
  | { type: "session.ended"; id: string; reason: EndReason; samples: number }
  | { type: "inserted"; id: string; method: InsertMethod; receipt_ms: number }
  | { type: "insert.failed"; id: string; reason: string }
  | { type: "edit"; id: string; hunks: EditHunk[] }
  | { type: "edit.unreadable"; id: string; reason: string }
  | { type: "secure_input"; on: boolean };

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
    }
  | { type: "focus"; target: Target }
  | { type: "rebuild_mic"; device: string }
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
  return isStr(h.inserted) && isStr(h.now);
}

/** Null when the message is well formed, else what is wrong with it. */
export function checkHelperMessage(o: Record<string, unknown>): string | null {
  switch (o.type) {
    case "ready": {
      const g = o.grants as Record<string, unknown> | null;
      if (typeof g !== "object" || g === null || !isBool(g.mic) || !isBool(g.accessibility))
        return "ready.grants";
      return isStr(o.protocol) && isStr(o.version) && isStr(o.backend) && isBool(o.swallow_keys)
        ? null
        : "ready";
    }
    case "bound":
      return isStr(o.hotkey) ? null : "bound";
    case "bind.failed":
      return isStr(o.hotkey) && isStr(o.reason) ? null : "bind.failed";
    case "session.started":
      return isId(o.id) && isTarget(o.target) && isNs(o.capture_ns) ? null : "session.started";
    case "level":
      return isNum(o.rms) && o.rms >= 0 ? null : "level";
    case "key":
      return isStr(o.name) ? null : "key";
    case "grant.lost":
      return isStr(o.name) ? null : "grant.lost";
    case "session.ended":
      return isId(o.id) &&
        (END_REASONS as readonly unknown[]).includes(o.reason) &&
        isNum(o.samples) &&
        Number.isInteger(o.samples) &&
        o.samples >= 0
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
