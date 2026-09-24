/**
 * Post-call hooks (docs/DESIGN.md section 8.2, item 2): commands the user configured, run at a
 * hand-off stage with the call as one JSON document on stdin.
 *
 *   {version: 1, stage, call: {…frontmatter, dir},
 *    paths: {events, audio[], exportMd, exportAttachments},
 *    transcript: [{id, w0, w1, clock, speaker, name, ch, text, heard?}], notes: [], remember: [],
 *    enhancedMd}
 *
 * plus `AKOU_CALL_ID`, `AKOU_CALL_DIR` and `AKOU_STAGE` in the environment. The stages are the
 * event type names: `call.ended`, `final.done`, `enhanced`. The webhook sends the same document.
 *
 * A hook never blocks the app: it runs as a child process in its own process group, its output
 * (stdout and stderr, capped) goes to `logs/hooks.log` in the call folder, and past its timeout the
 * whole group is killed. The exit code and the duration become `hook.done`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";
import { formatWall } from "../../core/log/clock.ts";
import type { EventDraft } from "../../core/log/events.ts";
import type { CallView } from "../../core/log/fold.ts";
import { EVENTS_FILE } from "../../core/log/writer.ts";
import { HOOK_TIMEOUT_DEFAULT, type HookConfig, type HookStage } from "../config/schema.ts";
import { type CallMeta, callMeta, exportBaseName } from "./export.ts";

export const HOOK_LOG = "logs/hooks.log";
/** Output kept per run; the rest is dropped with a marker. */
export const HOOK_OUTPUT_CAP = 256 * 1024;
/** A hook that ignores SIGTERM gets this long before SIGKILL. */
export const KILL_GRACE_MS = 2000;
/** The exit code recorded for a hook killed at its timeout, as `timeout(1)` reports it. */
export const EXIT_TIMEOUT = 124;
/** The exit code recorded when the command could not be started at all. */
export const EXIT_NOT_STARTED = 127;

export interface HandoffPayload {
  version: 1;
  stage: HookStage;
  call: CallMeta & { dir: string };
  paths: {
    events: string;
    audio: string[];
    exportMd: string | null;
    /** The export's own `attachments/<name>/` folder, whatever name the Markdown file took. */
    exportAttachments: string | null;
  };
  transcript: {
    id: string;
    w0: number;
    w1: number;
    clock: string;
    speaker: string;
    name: string;
    ch: "mic" | "call";
    text: string;
    heard?: string;
  }[];
  notes: { id: string; text: string; w: number; clock: string; by: string }[];
  remember: { id: string; text: string; by: string }[];
  enhancedMd: string | null;
}

/** The call as hooks and the webhook receive it. */
export function buildPayload(o: {
  stage: HookStage;
  view: CallView;
  dir: string;
  version: string;
  exportMd: string | null;
}): HandoffPayload {
  const v = o.view;
  const meta = callMeta(v, o.version);
  const tz = meta.tz;
  const latest = v.latestEnhanced();
  let enhancedMd: string | null = null;
  if (latest) {
    try {
      enhancedMd = readFileSync(join(o.dir, latest.file), "utf8");
    } catch {}
  }
  return {
    version: 1,
    stage: o.stage,
    call: { ...meta, dir: o.dir },
    paths: {
      events: join(o.dir, EVENTS_FILE),
      audio: v
        .parts()
        .map((p) => join(o.dir, p.file))
        .filter((p) => existsSync(p)),
      exportMd: o.exportMd,
      exportAttachments:
        o.exportMd === null ? null : join(dirname(o.exportMd), "attachments", exportBaseName(v)),
    },
    transcript: v.lines("best").map((l) => ({
      id: l.id,
      w0: l.w0,
      w1: l.w1,
      clock: formatWall(l.w0, tz),
      speaker: l.spk,
      name: l.speaker,
      ch: l.ch,
      text: l.text,
      ...(l.heard !== undefined ? { heard: l.heard } : {}),
    })),
    notes: v.notes().map((n) => ({
      id: n.id,
      text: n.text,
      w: n.w,
      clock: formatWall(n.w, tz),
      by: n.by,
    })),
    remember: v.remembered().map((r) => ({ id: r.id, text: r.text, by: r.by })),
    enhancedMd,
  };
}

/** The hooks that run for a call's workspace at a stage, in the order configured. */
export function hooksFor(
  all: readonly HookConfig[],
  stage: HookStage,
  workspace: string,
): HookConfig[] {
  return all.filter((h) => h.stage === stage && (h.workspace ?? workspace) === workspace);
}

export function hookName(h: HookConfig): string {
  if (h.name) return h.name;
  const cmd = typeof h.command === "string" ? h.command : h.command.join(" ");
  const first = typeof h.command === "string" ? h.command.trim().split(/\s+/)[0] : h.command[0];
  const name = basename(first ?? cmd) || cmd;
  return name.length > 80 ? `${name.slice(0, 77)}...` : name;
}

export interface HookRun {
  name: string;
  exit: number;
  ms: number;
  timedOut: boolean;
}

/** One run as the API reports it. */
export interface HookReport extends HookRun {
  stage: HookStage;
}

export interface RunHookOptions {
  hook: HookConfig;
  stage: HookStage;
  payload: string;
  callId: string;
  callDir: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  now?: () => number;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals, platform: string): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (platform === "win32") {
      // taskkill takes the whole tree; there is no process group to signal.
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on(
        "error",
        () => {},
      );
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/**
 * Runs one hook to completion or its timeout. Never throws and never rejects: a hook that cannot
 * start is a run with exit 127, and its reason is in the log.
 */
export function runHook(o: RunHookOptions): Promise<HookRun> {
  const platform = o.platform ?? process.platform;
  const now = o.now ?? Date.now;
  const name = hookName(o.hook);
  const timeoutMs = (o.hook.timeoutSec ?? HOOK_TIMEOUT_DEFAULT) * 1000;
  const logPath = join(o.callDir, HOOK_LOG);
  const t0 = now();
  let kept = 0;
  let dropped = false;
  const chunks: Buffer[] = [];
  const keep = (b: Buffer) => {
    if (kept >= HOOK_OUTPUT_CAP) {
      dropped = true;
      return;
    }
    const part = b.subarray(0, HOOK_OUTPUT_CAP - kept);
    kept += part.length;
    if (part.length < b.length) dropped = true;
    chunks.push(part);
  };
  const env = {
    ...(o.env ?? process.env),
    AKOU_CALL_ID: o.callId,
    AKOU_CALL_DIR: o.callDir,
    AKOU_STAGE: o.stage,
  };
  const finish = (exit: number, timedOut: boolean, note?: string): HookRun => {
    const ms = Math.max(0, Math.round(now() - t0));
    try {
      mkdirSync(join(o.callDir, "logs"), { recursive: true });
      const out = Buffer.concat(chunks).toString("utf8");
      appendFileSync(
        logPath,
        [
          `=== ${new Date(t0).toISOString()} stage=${o.stage} hook=${name}`,
          ...(note ? [note] : []),
          ...(out ? [out.replace(/\n$/, "")] : []),
          ...(dropped ? [`[output past ${HOOK_OUTPUT_CAP} bytes dropped]`] : []),
          `=== exit=${exit} ms=${ms}${timedOut ? " (timed out)" : ""}`,
          "",
        ].join("\n"),
      );
    } catch {}
    return { name, exit, ms, timedOut };
  };
  return new Promise<HookRun>((resolve) => {
    let child: ChildProcess;
    try {
      const cmd = o.hook.command;
      child =
        typeof cmd === "string"
          ? spawn(cmd, {
              shell: true,
              cwd: o.callDir,
              env,
              detached: platform !== "win32",
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            })
          : spawn(cmd[0] as string, cmd.slice(1), {
              cwd: o.callDir,
              env,
              detached: platform !== "win32",
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });
    } catch (err) {
      resolve(finish(EXIT_NOT_STARTED, false, `cannot start: ${(err as Error).message}`));
      return;
    }
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM", platform);
      killTimer = setTimeout(() => killGroup(child, "SIGKILL", platform), KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    const done = (exit: number, note?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A timed-out hook's SIGKILL still goes to the group: the shell may be gone while a
      // grandchild that ignored SIGTERM holds on.
      if (killTimer && !timedOut) clearTimeout(killTimer);
      resolve(finish(timedOut ? EXIT_TIMEOUT : exit, timedOut, note));
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (err) => done(EXIT_NOT_STARTED, `cannot start: ${err.message}`));
    // `close` waits for the pipes; a grandchild that escaped the group could hold them for ever.
    child.on("exit", (code, signal) => {
      const t = setTimeout(
        () => done(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1)),
        1000,
      );
      t.unref?.();
    });
    child.on("close", (code, signal) => {
      done(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1));
    });
    // A hook that does not read its input must not fail the write, nor the app.
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.payload);
  });
}

/** The `hook.done` event for a run. */
export function hookDoneDraft(run: HookRun): EventDraft {
  return { type: "hook.done", name: run.name, exit: run.exit, ms: run.ms };
}
