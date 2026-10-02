/**
 * The app's watchdog (DK-M8, docs/TRAPS.md "An app that takes the connection and never answers").
 *
 * The app's thread beats every `BEAT_MS` into a shared counter, with a flag saying whether a call
 * is recording. A Worker, which runs on its own thread and needs nothing from the app's, reads the
 * counter every `TICK_MS`. When it has not moved for `SILENCE_MS`, the app's thread is stuck:
 *
 * 1. It writes a line to `app.log` with the time and whether a call is recording, and on macOS
 *    a few seconds of `sample` of the process into `hangs/` beside it.
 * 2. With no call recording, it ends the process and every process below it (the helpers, a
 *    llama-server) with SIGKILL, since SIGTERM is handled on the stuck thread or on the window
 *    toolkit's, which is what stuck it. The ElectroBun launcher exits when its child does. The next
 *    `akou` command starts a fresh app.
 *    When the window was open, it opens the app again a second later (`open -a` on the bundle), at
 *    most once per `REOPEN_MS`, so a person using only the window does not see akou vanish.
 * 3. With a call recording, it ends nothing: the capture helper writes the audio to its file
 *    whatever the app does, and the CLI tells the user how to restart by hand. It writes a second
 *    line if the app's thread comes back.
 *
 * Silence is counted in the Worker's own ticks, never by the wall clock: a Mac that sleeps stops
 * both threads, and a wall-clock gap on wake would read as a hang.
 *
 * The Worker is made from source text, not a file, because the desktop bundle ships only the Worker
 * files `build-app.ts` builds (TRAPS "Native libraries missing from the bundle"). So the source
 * below is plain JavaScript and imports only Node's modules.
 */

export const BEAT_MS = 1000;
export const TICK_MS = 500;
export const SILENCE_MS = 10_000;
export const WATCHDOG_SAMPLE_SECONDS = 3;

export interface WatchdogOptions {
  /** The log the Worker appends its lines to (`app.log`). */
  logFile: string;
  /** Where the `sample` of a hung process goes (`hangs/`). */
  hangsDir: string;
  /** Is a call recording? Read on the app's thread at every beat. */
  recording: () => boolean;
  /** End the process on a hang with no call recording. Default true. */
  end?: boolean;
  /** Take a `sample` on macOS. Default true. */
  sample?: boolean;
  silenceMs?: number;
  beatMs?: number;
  tickMs?: number;
  /** The process to sample and end; this one by default (tests point it at a child). */
  pid?: number;
  /** Is the window open? Read at every beat; when it was, the app is opened again after it ends. */
  windowOpen?: () => boolean;
  /** What opens the app again (`relaunchCommand`); null opens nothing. */
  relaunch?: readonly string[] | null;
  reopenMs?: number;
}

/** Opening the app again after the watchdog ends it, at most this often. */
export const REOPEN_MS = 10 * 60_000;

/**
 * How to open the desktop app again once it has ended: `open -a` on its bundle, a second later so
 * the ended process is gone and LaunchServices starts a new one. Null outside a macOS bundle.
 */
export function relaunchCommand(
  execPath: string = process.execPath,
  platform: string = process.platform,
): string[] | null {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  if (platform !== "darwin" || !m) return null;
  return ["/bin/sh", "-c", 'sleep 1; exec /usr/bin/open -a "$1"', "sh", m[1] as string];
}

export interface Watchdog {
  stop(): void;
  /** Publishes the live state now, not at the next beat: a call went live or ended. */
  touch(): void;
}

/** The Worker. `workerData`: `{ beats, cfg }`; `beats` is an Int32Array over shared memory. */
const SOURCE = String.raw`
const { workerData } = require("node:worker_threads");
const { appendFileSync, chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { beats, cfg } = workerData;
const pad = (n, w = 2) => String(n).padStart(w, "0");
function stamp(d) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
    pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." +
    pad(d.getMilliseconds(), 3) + " " + (off >= 0 ? "+" : "-") + pad(Math.floor(a / 60)) + ":" + pad(a % 60);
}
function line(level, msg) {
  try { appendFileSync(cfg.logFile, stamp(new Date()) + " " + level + " watchdog: " + msg + "\n", { mode: 0o600 }); } catch {}
}
function sample() {
  if (!cfg.sample || process.platform !== "darwin") return;
  try {
    mkdirSync(cfg.hangsDir, { recursive: true, mode: 0o700 });
    const file = join(cfg.hangsDir, "hang-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt");
    const r = spawnSync("/usr/bin/sample", [String(cfg.pid), String(cfg.sampleSeconds), "-file", file],
      { stdio: "ignore", timeout: (cfg.sampleSeconds + 2) * 1000 });
    if (r.status === 0) {
      chmodSync(file, 0o600);
      line("info", "a sample of the stuck process is in " + file);
    }
    const old = readdirSync(cfg.hangsDir).filter((f) => /^hang-.*\.txt$/.test(f)).sort().reverse().slice(5);
    for (const f of old) rmSync(join(cfg.hangsDir, f), { force: true });
  } catch {}
}
// Every process below root, with its arguments.
function below(root) {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
  const rows = [];
  for (const l of (r.stdout || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
  }
  const out = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    for (const row of rows) if (row.ppid === p && !out.some((o) => o.pid === row.pid)) { out.push(row); queue.push(row.pid); }
  }
  return out;
}
// A capture helper that records: started with "run" and "--out FILE" (src/main/cli/heal.ts).
function records(args) {
  const words = args.trim().split(/\s+/);
  return words.includes("run") && words.includes("--out");
}
// Opens akou again after it ends, when its window was open, at most once per REOPEN_MS: a person
// who uses only the window would otherwise see it vanish. The stamp file is what bounds it, so a
// reopened app that hangs again is not reopened again.
function reopen() {
  if (!cfg.relaunch || Atomics.load(beats, 2) !== 1) return;
  const stamp = join(cfg.hangsDir, "reopened");
  try {
    const ago = Date.now() - statSync(stamp).mtimeMs;
    if (ago < cfg.reopenMs) {
      line("warn", "not opening akou again: it was reopened " + Math.round(ago / 60000) + " min ago");
      return;
    }
  } catch {}
  try {
    mkdirSync(cfg.hangsDir, { recursive: true, mode: 0o700 });
    writeFileSync(stamp, "", { mode: 0o600 });
    spawn(cfg.relaunch[0], cfg.relaunch.slice(1), { detached: true, stdio: "ignore" }).unref();
    line("info", "opening akou again, because its window was open");
  } catch (e) {
    line("warn", "could not open akou again: " + e.message);
  }
}
let last = Atomics.load(beats, 0);
let still = 0;
let fired = false;
setInterval(() => {
  const now = Atomics.load(beats, 0);
  if (now !== last) {
    if (fired) line("info", "the app's thread answered again after about " + Math.round(still / 1000) + " s");
    last = now;
    still = 0;
    fired = false;
    return;
  }
  still += cfg.tickMs;
  if (fired || still < cfg.silenceMs) return;
  fired = true;
  const recording = Atomics.load(beats, 1) === 1;
  line("error", "the app's thread has not answered for " + Math.round(still / 1000) + " s; " +
    (recording ? "a call is recording" : "no call is recording"));
  sample();
  if (recording) {
    line("warn", "akou keeps running, so the capture helper keeps writing the audio; kill -KILL " + cfg.pid + " restarts it by hand, the audio so far stays");
    return;
  }
  if (!cfg.end) return;
  const rows = process.platform === "win32" ? [] : below(cfg.pid);
  // The last guard: the flag can lag a start whose helper was spawned after the last beat, but a
  // recording helper below the app is always there to see. It is never ended.
  const helper = rows.find((r) => records(r.args));
  if (helper) {
    line("warn", "a capture helper is recording (pid " + helper.pid + "), so akou keeps running; kill -KILL " + cfg.pid + " restarts it by hand, the audio so far stays");
    return;
  }
  line("warn", "ending akou (pid " + cfg.pid + "), so the next command starts a fresh one");
  for (const r of rows) { try { process.kill(r.pid, "SIGKILL"); } catch {} }
  // After the helpers go and before akou does: the opener must not be among what is ended.
  reopen();
  try { process.kill(cfg.pid, "SIGKILL"); } catch {}
}, workerData.cfg.tickMs);
`;

/** Starts the watchdog: the beat on this thread, and the Worker that watches it. */
export function startWatchdog(o: WatchdogOptions): Watchdog {
  const beats = new Int32Array(new SharedArrayBuffer(12));
  // The live state, published at every beat and by `touch`.
  const publish = () => {
    let rec = false;
    try {
      rec = o.recording();
    } catch {}
    Atomics.store(beats, 1, rec ? 1 : 0);
    let open = false;
    try {
      open = o.windowOpen?.() ?? false;
    } catch {}
    Atomics.store(beats, 2, open ? 1 : 0);
  };
  const beat = () => {
    Atomics.add(beats, 0, 1);
    publish();
  };
  beat();
  const cfg = {
    logFile: o.logFile,
    hangsDir: o.hangsDir,
    end: o.end ?? true,
    sample: o.sample ?? true,
    silenceMs: o.silenceMs ?? SILENCE_MS,
    tickMs: o.tickMs ?? TICK_MS,
    sampleSeconds: WATCHDOG_SAMPLE_SECONDS,
    pid: o.pid ?? process.pid,
    relaunch: o.relaunch ?? null,
    reopenMs: o.reopenMs ?? REOPEN_MS,
  };
  const url = URL.createObjectURL(new Blob([SOURCE], { type: "application/javascript" }));
  const worker = new Worker(url, { workerData: { beats, cfg } } as WorkerOptions);
  // Neither keeps a process alive that would otherwise exit (a test, a quit).
  (worker as { unref?: () => void }).unref?.();
  const timer = setInterval(beat, o.beatMs ?? BEAT_MS);
  (timer as { unref?: () => void }).unref?.();
  return {
    stop() {
      clearInterval(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
    },
    touch() {
      // The live state only: the beat counter moves on the timer, so a touch never hides a stall.
      publish();
    },
  };
}
