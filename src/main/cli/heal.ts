/**
 * An app that takes the connection and never answers (docs/TRAPS.md, DK-M8).
 *
 * The desktop app runs its API on a thread that also makes synchronous calls into the window
 * toolkit. When the toolkit's main thread is stuck, the first such call never returns: the port
 * still accepts connections (the kernel does that) and no request is ever answered, and SIGTERM
 * does nothing, because the toolkit's main thread is the one that handles it. Only SIGKILL ends it.
 *
 * So before its first request the CLI asks `GET /healthz` for an answer within `ANSWER_MS`. Any
 * answer, 200 or 503, is an app that works. A refused connection is an app that is gone, which the
 * client already handles by launching one. No answer at all is a hung app, and this module decides
 * what to do with it, without the API:
 *
 * - A recording in progress is a capture helper below the app (`akou-capture run --out FILE`, or
 *   any helper started with `run` and `--out`) that is still alive. Then nothing is stopped: the
 *   helper keeps writing the audio whatever the app does, and the user is told how to restart it.
 * - Otherwise, on macOS, a few seconds of `sample` of the hung process go into `hangs/` in the
 *   config folder, so the next hang leaves evidence. The app gets the rest of `HUNG_MS` to answer;
 *   then SIGTERM to the app, its children and the ElectroBun launcher above it, and SIGKILL after
 *   `TERM_GRACE_MS` to any of them still there. Never the process asking, nor any process above
 *   it: an agent the app started may be the one running the command (`stopList`).
 *
 * Process trees come from `ps`, so this works on macOS and Linux only; on Windows the CLI says the
 * app is not answering and stops nothing.
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../../core/log/writer.ts";
import { HANGS_DIR } from "../app-log.ts";

/** How long the app has to answer `/healthz` before the CLI looks closer. */
export const ANSWER_MS = 3000;
/**
 * How long the app must stay silent before the CLI stops it: the watchdog's own silence inside
 * the app, so the CLI and the app agree on what "hung" means. A busy app that answers within it
 * is left alone.
 */
export const HUNG_MS = 10_000;
/** The whole recovery, from the first unanswered probe to the command sent again. */
export const HEAL_BUDGET_MS = 15_000;
/** Between SIGTERM and SIGKILL. */
export const TERM_GRACE_MS = 3000;
/** The `sample` of a hung app on macOS, and the most the CLI waits for it. */
export const SAMPLE_SECONDS = 3;
export const SAMPLE_CAP_MS = 5000;
/** Samples kept in `hangs/`; older ones are removed. */
export const SAMPLES_KEPT = 5;
export { HANGS_DIR };

export type Probe = "answers" | "refused" | "silent";

/** Does the app on `port` answer `GET /healthz` within `ms`? */
export async function probe(port: number, ms: number = ANSWER_MS): Promise<Probe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(ms),
    });
    await res.body?.cancel();
    return "answers";
  } catch (err) {
    const e = err as { name?: string };
    return e?.name === "TimeoutError" || e?.name === "AbortError" ? "silent" : "refused";
  }
}

export interface ProcRow {
  pid: number;
  ppid: number;
  args: string;
}

/**
 * Every process of this machine, from `ps`; null on Windows or when `ps` cannot list them. A list
 * that could not be read is never an empty one: a recording helper may be in it.
 */
export function processTable(platform: string = process.platform): Promise<ProcRow[] | null> {
  if (platform === "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    const p = spawn("ps", ["-A", "-o", "pid=,ppid=,args="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => {
      out += d;
    });
    p.on("error", () => resolve(null));
    p.on("close", (code) => resolve(code === 0 ? parsePs(out) : null));
  });
}

export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] as string });
  }
  return rows;
}

/** The pids below `root`, nearest first. */
export function descendants(rows: readonly ProcRow[], root: number): number[] {
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const p = queue.shift() as number;
    for (const r of rows) {
      if (r.ppid === p && !out.includes(r.pid)) {
        out.push(r.pid);
        queue.push(r.pid);
      }
    }
  }
  return out;
}

/** The ElectroBun launcher that started the app (`…/Contents/MacOS/launcher`), or null. */
export function launcherOf(rows: readonly ProcRow[], pid: number): number | null {
  const me = rows.find((r) => r.pid === pid);
  const parent = me && rows.find((r) => r.pid === me.ppid);
  return parent && /\/Contents\/MacOS\/launcher$/.test(parent.args.trim()) ? parent.pid : null;
}

/** `pid` and every process above it, nearest first. */
export function ancestry(rows: readonly ProcRow[], pid: number): number[] {
  const out: number[] = [];
  let p: number | undefined = pid;
  while (p !== undefined && p > 1 && !out.includes(p)) {
    out.push(p);
    p = rows.find((r) => r.pid === p)?.ppid;
  }
  return out;
}

/**
 * What stopping the app stops: the launcher above it, the app, and every process below it, except
 * `self` and the processes between `self` and the app. A harness the app
 * started that runs `akou` is below the app, and must never be stopped by the command it ran.
 */
export function stopList(
  rows: readonly ProcRow[],
  appPid: number,
  self: number = process.pid,
): number[] {
  // The chain from `self` up to the app; the app itself is still stopped. An app `self` launched
  // (`akou mcp` starts one and stays its parent) is below `self`, and is stopped like any other.
  const chain = ancestry(rows, self);
  const at = chain.indexOf(appPid);
  const keep = new Set([self, ...(at >= 0 ? chain.slice(0, at) : [])]);
  const launcher = launcherOf(rows, appPid);
  return [...(launcher ? [launcher] : []), appPid, ...descendants(rows, appPid)].filter(
    (p) => !keep.has(p),
  );
}

export interface Recording {
  /** The capture helper's pid. */
  pid: number;
  /** Did its audio file grow while we watched? null when the file could not be read. */
  growing: boolean | null;
}

/** The `--out FILE` of a capture helper's arguments, when it records (`run`). */
export function recordingOut(args: string): string | null {
  const words = args.trim().split(/\s+/);
  if (!words.includes("run")) return null;
  const i = words.indexOf("--out");
  return i >= 0 && words[i + 1] ? (words[i + 1] as string) : null;
}

function sizeOf(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * A capture helper recording below `appPid`, or null. A path with spaces is cut at the first one
 * by `ps`; then the growth is unknown, and the helper alone says a recording is in progress.
 */
export async function recordingBelow(
  rows: readonly ProcRow[],
  appPid: number,
  watchMs = 1000,
): Promise<Recording | null> {
  for (const pid of descendants(rows, appPid)) {
    const args = rows.find((r) => r.pid === pid)?.args ?? "";
    const out = recordingOut(args);
    if (out === null) continue;
    const before = sizeOf(out);
    // clock: watching a real recording grow for `watchMs`.
    await new Promise((r) => setTimeout(r, watchMs));
    const after = sizeOf(out);
    return { pid, growing: before === null || after === null ? null : after > before };
  }
  return null;
}

/**
 * Writes `sample <pid>` into `dir` on macOS, waiting at most `capMs`, and keeps the newest
 * `SAMPLES_KEPT`. Returns the file, or null when nothing was written.
 */
export async function sampleHung(
  pid: number,
  dir: string,
  o: { platform?: string; seconds?: number; capMs?: number; now?: Date } = {},
): Promise<string | null> {
  if ((o.platform ?? process.platform) !== "darwin") return null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  // clock: the default of an injected time: the file is named when it is written.
  const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `hang-${stamp}.txt`);
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(
      "/usr/bin/sample",
      [String(pid), String(o.seconds ?? SAMPLE_SECONDS), "-file", file],
      {
        stdio: "ignore",
      },
    );
    // clock: a deadline on a real process that may hang.
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve(false);
    }, o.capMs ?? SAMPLE_CAP_MS);
    p.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
  try {
    const old = readdirSync(dir)
      .filter((f) => /^hang-.*\.txt$/.test(f))
      .sort()
      .reverse()
      .slice(SAMPLES_KEPT);
    for (const f of old) rmSync(join(dir, f), { force: true });
  } catch {}
  if (!ok || sizeOf(file) === null) return null;
  try {
    // A sample names the process's threads and libraries: the owner's alone.
    chmodSync(file, 0o600);
  } catch {}
  return file;
}

/**
 * SIGTERM to every pid, then SIGKILL after `graceMs` to any still alive. Returns the pids still
 * alive at the end (none, unless they belong to someone else).
 */
export async function stopAll(pids: readonly number[], graceMs = TERM_GRACE_MS): Promise<number[]> {
  const signal = (pid: number, s: NodeJS.Signals) => {
    try {
      process.kill(pid, s);
    } catch {}
  };
  for (const p of pids) signal(p, "SIGTERM");
  const deadline = performance.now() + graceMs;
  while (performance.now() < deadline && pids.some(processAlive)) {
    // clock: polling real processes we signalled, bounded by the grace.
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const p of pids.filter(processAlive)) signal(p, "SIGKILL");
  const end = performance.now() + 1000;
  while (performance.now() < end && pids.some(processAlive)) {
    // clock: polling real processes we signalled, bounded by the second.
    await new Promise((r) => setTimeout(r, 20));
  }
  return pids.filter(processAlive);
}

/** Whole seconds since `t0`, for the one line the CLI prints. */
export function seconds(t0: number): number {
  return Math.max(1, Math.round((performance.now() - t0) / 1000));
}
