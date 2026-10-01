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
}

export interface Watchdog {
  stop(): void;
}

/** The Worker. `workerData`: `{ beats, cfg }`; `beats` is an Int32Array over shared memory. */
const SOURCE = String.raw`
const { workerData } = require("node:worker_threads");
const { appendFileSync, mkdirSync, readdirSync, rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
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
    if (r.status === 0) line("info", "a sample of the stuck process is in " + file);
    const old = readdirSync(cfg.hangsDir).filter((f) => /^hang-.*\.txt$/.test(f)).sort().reverse().slice(5);
    for (const f of old) rmSync(join(cfg.hangsDir, f), { force: true });
  } catch {}
}
function below(root) {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const rows = (r.stdout || "").split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 2);
  const out = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    for (const [pid, ppid] of rows) if (ppid === p && !out.includes(pid)) { out.push(pid); queue.push(pid); }
  }
  return out;
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
  line("warn", "ending akou (pid " + cfg.pid + "), so the next command starts a fresh one");
  if (process.platform !== "win32") for (const pid of below(cfg.pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  try { process.kill(cfg.pid, "SIGKILL"); } catch {}
}, workerData.cfg.tickMs);
`;

/** Starts the watchdog: the beat on this thread, and the Worker that watches it. */
export function startWatchdog(o: WatchdogOptions): Watchdog {
  const beats = new Int32Array(new SharedArrayBuffer(8));
  const beat = () => {
    Atomics.add(beats, 0, 1);
    let rec = false;
    try {
      rec = o.recording();
    } catch {}
    Atomics.store(beats, 1, rec ? 1 : 0);
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
  };
}
