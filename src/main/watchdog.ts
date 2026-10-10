/**
 * The app's watchdog (DK-M8, docs/TRAPS.md "An app that takes the connection and never answers").
 *
 * The app's thread beats every `BEAT_MS` into a shared counter, with a flag saying whether a call
 * is recording. A Worker, which runs on its own thread and needs nothing from the app's, reads the
 * counter every `TICK_MS`. When it has not moved for `SILENCE_MS`, the app's thread is stuck:
 *
 * 1. It writes a line to `app.log` with the time and whether a call is recording, and a second one
 *    with the machine's load and how late its own ticks ran, which tells a starved machine from a
 *    stuck thread. On macOS it takes a few seconds of `sample` of the process into `hangs/` beside
 *    the log, and says in the log where the file is and where the main thread was, or why there is
 *    no sample: a hang always leaves a line of evidence. The sample runs beside the Worker, which
 *    keeps watching: when the app's thread answers before the sample is done, nothing is ended.
 * 2. With no call recording, it ends the process and every process below it (the helpers, a
 *    llama-server) with SIGKILL, since SIGTERM is handled on the stuck thread or on the window
 *    toolkit's, which is what stuck it. The ElectroBun launcher exits when its child does. The next
 *    `akou` command starts a fresh app.
 *    When the window was open, it opens the app again, at most once per `REOPEN_MS`, so a person
 *    using only the window does not see akou vanish. A process of its own does that (`REOPENER`),
 *    since the Worker ends with the app: it stops the bundle's launchers left with nothing below
 *    them, which `open` would take for the running app and start nothing, opens the bundle, waits
 *    for the new app to answer, tries once more when it does not, and writes what happened.
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
/**
 * The most the watchdog waits for the `sample` before it goes on without one. On a Mac whose load
 * average was 60 to 100, a cap of 5 s cut every sample short, four hangs out of four, and nothing
 * said so.
 */
export const WATCHDOG_SAMPLE_CAP_MS = 20_000;

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
  /**
   * The program that samples, run as `… PID SECONDS -file FILE`: `/usr/bin/sample` on macOS and
   * none elsewhere by default (tests pass one that fails, or never ends).
   */
  sampler?: readonly string[] | null;
  sampleCapMs?: number;
  silenceMs?: number;
  beatMs?: number;
  tickMs?: number;
  /** The process to sample and end; this one by default (tests point it at a child). */
  pid?: number;
  /** Is the window open? Read at every beat; when it was, the app is opened again after it ends. */
  windowOpen?: () => boolean;
  /** The command that opens the app again (`relaunchCommand`); null opens nothing. */
  relaunch?: readonly string[] | null;
  reopenMs?: number;
  /** `runtime.json`, where the opened app says it is up; without it the reopen cannot tell. */
  runtimeFile?: string;
  /** How long each of the two opens is given to bring up an app that answers (`REOPEN_WAIT_MS`). */
  reopenWaitMs?: number;
  /** The `ps` the Worker lists processes with (tests point it at one that fails). */
  ps?: string;
}

/** Opening the app again after the watchdog ends it, at most this often. */
export const REOPEN_MS = 10 * 60_000;

/** How long an app opened again has to answer before the reopen tries once more, then gives up. */
export const REOPEN_WAIT_MS = 30_000;

/** The macOS bundle this process runs from (`…/akou.app`), or null outside one. */
export function appBundle(
  execPath: string = process.execPath,
  platform: string = process.platform,
): string | null {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return platform === "darwin" && m ? (m[1] as string) : null;
}

/**
 * The command that opens the desktop app again once it has ended: `open -n -a` on its bundle.
 * `-n` starts a new app even when LaunchServices believes one is running, which it does while a
 * launcher with no app below it is alive (docs/TRAPS.md "Minutes to start"); a second app beside
 * a live one finds its lock and exits. Null outside a macOS bundle.
 */
export function relaunchCommand(
  execPath: string = process.execPath,
  platform: string = process.platform,
): string[] | null {
  const bundle = appBundle(execPath, platform);
  return bundle ? ["/usr/bin/open", "-n", "-a", bundle] : null;
}

/** The bundle a command opens (`open -a BUNDLE`), or null. */
function openedBundle(cmd: readonly string[] | null): string | null {
  const i = cmd ? cmd.indexOf("-a") : -1;
  return cmd && i >= 0 && cmd[i + 1] ? (cmd[i + 1] as string) : null;
}

export interface Watchdog {
  stop(): void;
  /** Publishes the live state now, not at the next beat: a call went live or ended. */
  touch(): void;
}

/** How both scripts below write a line to `app.log`; `cfg.logFile` names it. */
const LOG_SOURCE = String.raw`const pad = (n, w = 2) => String(n).padStart(w, "0");
function stamp(d) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
    pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." +
    pad(d.getMilliseconds(), 3) + " " + (off >= 0 ? "+" : "-") + pad(Math.floor(a / 60)) + ":" + pad(a % 60);
}
function line(level, msg) {
  // clock: the watchdog stamps its log line with the time it writes it.
  try { appendFileSync(cfg.logFile, stamp(new Date()) + " " + level + " watchdog: " + msg + "\n", { mode: 0o600 }); } catch {}
}
`;

/**
 * The process that opens the app again after the watchdog ends it. It runs on the app's own Bun
 * from this text, as the Worker does, and outlives the app. `AKOU_REOPEN` holds its settings:
 * `{ open, bundle, logFile, runtimeFile, oldPid, waitMs, ps }`.
 *
 * `strays` is the test `strayLaunchers` makes in `cli/heal.ts`, here because this text can import
 * nothing: a process whose command is exactly the bundle's launcher, with no child but ones that
 * exited unreaped (the wrapper's `open`), that is not above this process. One is stopped only when
 * two looks half a second apart both find it so.
 */
const REOPENER = String.raw`
const { appendFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const cfg = JSON.parse(process.env.AKOU_REOPEN);
// The app this opens must not inherit them.
delete process.env.AKOU_REOPEN;
delete process.env.AKOU_REOPEN_JS;
${LOG_SOURCE}
// clock: this process waits on real processes: the ended app, the launchers, the app it opens.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function strays() {
  if (!cfg.bundle || process.platform === "win32") return [];
  const r = spawnSync(cfg.ps, ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
  if (r.error || r.status !== 0) return [];
  const rows = [];
  for (const l of (r.stdout || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3].trim() });
  }
  const path = cfg.bundle.replace(/\/+$/, "") + "/Contents/MacOS/launcher";
  const above = [];
  for (let p = process.pid; p > 1 && !above.includes(p); p = (rows.find((x) => x.pid === p) || {}).ppid) above.push(p);
  return rows
    .filter((x) => x.args === path || x.args.startsWith(path + " "))
    .filter((x) => !above.includes(x.pid) && !rows.some((c) => c.ppid === x.pid && !/(^|\s)<defunct>$/.test(c.args)) && alive(x.pid))
    .map((x) => x.pid);
}
async function stopStrays() {
  const first = strays();
  if (first.length === 0) return;
  await sleep(500);
  const left = strays().filter((p) => first.includes(p));
  if (left.length === 0) return;
  for (const p of left) { try { process.kill(p, "SIGTERM"); } catch {} }
  for (let i = 0; i < 30 && left.some(alive); i++) await sleep(100);
  for (const p of left.filter(alive)) { try { process.kill(p, "SIGKILL"); } catch {} }
  line("warn", "stopped " + (left.length === 1 ? "a launcher" : left.length + " launchers") +
    " of akou left with nothing below (pid " + left.join(", ") + "), which open would have taken for the running app");
}
// The pid of an app other than the ended one that answers, or 0.
async function up() {
  let rt;
  try { rt = JSON.parse(readFileSync(cfg.runtimeFile, "utf8")); } catch { return 0; }
  if (!rt || typeof rt.pid !== "number" || typeof rt.port !== "number" || rt.pid === cfg.oldPid || !alive(rt.pid)) return 0;
  try {
    const res = await fetch("http://127.0.0.1:" + rt.port + "/healthz", { signal: AbortSignal.timeout(2000) });
    if (res.body) await res.body.cancel();
    return rt.pid;
  } catch { return 0; }
}
(async () => {
  // The ended process, and the launcher above it, which exits when it does.
  for (let i = 0; i < 50 && alive(cfg.oldPid); i++) await sleep(100);
  await sleep(1000);
  const secs = Math.round(cfg.waitMs / 100) / 10;
  for (const attempt of [1, 2]) {
    await stopStrays();
    const r = spawnSync(cfg.open[0], cfg.open.slice(1), { stdio: "ignore", timeout: 15000 });
    const how = r.error ? r.error.message : r.signal ? "signal " + r.signal : "exit code " + r.status;
    const until = performance.now() + cfg.waitMs;
    while (performance.now() < until) {
      const pid = await up();
      if (pid) {
        line("info", "akou is open again (pid " + pid + ")" + (attempt === 2 ? ", at the second try" : ""));
        return;
      }
      await sleep(250);
    }
    if (attempt === 1) line("warn", "akou did not answer within " + secs + " s of being opened again (" + how + "); opening it once more");
    else line("error", "akou did not come up after being opened twice (" + how + "); open it by hand, or run any akou command");
  }
})();
`;

/** The Worker. `workerData`: `{ beats, cfg }`; `beats` is an Int32Array over shared memory. */
const SOURCE = String.raw`
const { workerData } = require("node:worker_threads");
const { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { cpus, loadavg } = require("node:os");
const { join } = require("node:path");
const { beats, cfg } = workerData;
${LOG_SOURCE}// Where the main thread was for most of a sample: the last frames with a name on its heaviest
// path, innermost first. The call graph lists each thread's frames heaviest child first, so the
// path is every line that sits deeper than the one before it. Null when the text is not a sample.
function mainThreadWas(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\s*\d+ Thread_\S+\s+DispatchQueue_1: com\.apple\.main-thread/.test(l));
  if (at < 0) return null;
  const path = [];
  let depth = /^\s*/.exec(lines[at])[0].length;
  for (let i = at + 1; i < lines.length; i++) {
    const m = /^([\s+!:|]*)\d+ (.+?)\s+\(in ([^)]+)\)/.exec(lines[i]);
    if (!m || m[1].length <= depth) break;
    depth = m[1].length;
    if (m[2] !== "???") path.push(m[2] + " (" + m[3] + ")");
  }
  return path.length ? path.slice(-5).reverse().join(" < ") : null;
}
// The machine when the hang was seen. Ticks that ran seconds late mean this whole process was
// kept from running, as on a machine with a load far above its cores, not one thread stuck.
function machine(late) {
  const ticks = "the watchdog's own ticks ran at most " + Math.round(late) + " ms late";
  if (process.platform === "win32") return ticks;
  return "load average " + loadavg().map((n) => n.toFixed(1)).join(" ") + " on " + cpus().length + " cores; " + ticks;
}
// Samples the process, then calls done. It never blocks this thread and never fails silently:
// one line says where the sample is, or why there is none.
function sample(done) {
  if (!cfg.sampler) return done();
  let file;
  let child;
  let over = false;
  let timer;
  const finish = (why) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    try {
      if (why === null) {
        chmodSync(file, 0o600);
        line("info", "a sample of the stuck process is in " + file);
        const was = mainThreadWas(readFileSync(file, "utf8"));
        if (was) line("info", "in the sample the main thread was in " + was);
      } else {
        rmSync(file, { force: true });
        line("warn", "no sample of the stuck process: " + cfg.sampler[0] + " " + why);
      }
      const old = readdirSync(cfg.hangsDir).filter((f) => /^hang-.*\.txt$/.test(f)).sort().reverse().slice(5);
      for (const f of old) rmSync(join(cfg.hangsDir, f), { force: true });
    } catch (e) {
      line("warn", "no sample of the stuck process: " + e.message);
    }
    done();
  };
  try {
    mkdirSync(cfg.hangsDir, { recursive: true, mode: 0o700 });
    // clock: a sample's file is named when it is taken.
    file = join(cfg.hangsDir, "hang-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt");
    child = spawn(cfg.sampler[0], cfg.sampler.slice(1).concat([String(cfg.pid), String(cfg.sampleSeconds), "-file", file]),
      { stdio: "ignore" });
  } catch (e) {
    line("warn", "no sample of the stuck process: " + e.message);
    return done();
  }
  // clock: a deadline on a real process that may never end.
  timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
    finish("did not finish within " + Math.round(cfg.sampleCapMs / 100) / 10 + " s");
  }, cfg.sampleCapMs);
  child.on("error", (e) => finish("could not run: " + e.message));
  child.on("exit", (code, signal) => finish(code === 0 ? null : signal ? "was ended by " + signal : "exited with " + code));
}
// Every process below root, with its arguments; null when ps could not list them.
function below(root) {
  const r = spawnSync(cfg.ps, ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
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
// reopened app that hangs again is not reopened again. The opening is REOPENER's, a process that
// outlives this one.
function reopen() {
  if (!cfg.relaunch || Atomics.load(beats, 2) !== 1) return;
  const stamp = join(cfg.hangsDir, "reopened");
  try {
    // clock: a stamp file's real age.
    const ago = Date.now() - statSync(stamp).mtimeMs;
    if (ago < cfg.reopenMs) {
      line("warn", "not opening akou again: it was reopened " + Math.round(ago / 60000) + " min ago");
      return;
    }
  } catch {}
  try {
    mkdirSync(cfg.hangsDir, { recursive: true, mode: 0o700 });
    writeFileSync(stamp, "", { mode: 0o600 });
    const env = Object.assign({}, process.env, {
      AKOU_REOPEN_JS: cfg.reopener,
      AKOU_REOPEN: JSON.stringify({ open: cfg.relaunch, bundle: cfg.bundle, logFile: cfg.logFile,
        runtimeFile: cfg.runtimeFile, oldPid: cfg.pid, waitMs: cfg.reopenWaitMs, ps: cfg.ps }),
    });
    // The text travels in the environment, so the process list shows one short line for it.
    spawn(cfg.runtime, ["-e", 'new Function("require", process.env.AKOU_REOPEN_JS)(require)'],
      { detached: true, stdio: "ignore", env }).unref();
    line("info", "opening akou again, because its window was open");
  } catch (e) {
    line("warn", "could not open akou again: " + e.message);
  }
}
let last = Atomics.load(beats, 0);
let still = 0;
let fired = false;
// Moves each time the app's thread answers, so what was started for one silence ends with it.
let answers = 0;
let tickAt = performance.now();
let late = 0;
// With no call recording and the thread still silent, ends akou and everything below it.
function end() {
  if (!cfg.end) return;
  const rows = process.platform === "win32" ? [] : below(cfg.pid);
  // A tree that cannot be read is not an empty tree: a recording helper may be in it.
  if (rows === null) {
    line("error", "could not list the processes below akou (ps failed), so nothing was ended; kill -KILL " + cfg.pid + " restarts it by hand");
    return;
  }
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
}
// clock: the watchdog thread checks the app's heartbeat in real time.
setInterval(() => {
  // How late this tick is: reported, never what decides (a Mac asleep stops this thread too).
  const t = performance.now();
  late = Math.max(late, t - tickAt - cfg.tickMs);
  tickAt = t;
  const now = Atomics.load(beats, 0);
  if (now !== last) {
    if (fired) line("info", "the app's thread answered again after about " + Math.round(still / 1000) + " s");
    last = now;
    still = 0;
    fired = false;
    late = 0;
    answers++;
    return;
  }
  still += cfg.tickMs;
  if (fired || still < cfg.silenceMs) return;
  fired = true;
  const silence = answers;
  const recording = Atomics.load(beats, 1) === 1;
  line("error", "the app's thread has not answered for " + Math.round(still / 1000) + " s; " +
    (recording ? "a call is recording" : "no call is recording"));
  line("info", machine(late));
  sample(() => {
    // The thread answered while the sample was taken: the line above says so, and akou runs on.
    if (answers !== silence) return;
    if (recording) {
      line("warn", "akou keeps running, so the capture helper keeps writing the audio; kill -KILL " + cfg.pid + " restarts it by hand, the audio so far stays");
      return;
    }
    end();
  });
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
    sampler:
      (o.sample ?? true) === false
        ? null
        : o.sampler !== undefined
          ? o.sampler
          : process.platform === "darwin"
            ? ["/usr/bin/sample"]
            : null,
    sampleCapMs: o.sampleCapMs ?? WATCHDOG_SAMPLE_CAP_MS,
    silenceMs: o.silenceMs ?? SILENCE_MS,
    tickMs: o.tickMs ?? TICK_MS,
    sampleSeconds: WATCHDOG_SAMPLE_SECONDS,
    pid: o.pid ?? process.pid,
    relaunch: o.relaunch ?? null,
    bundle: openedBundle(o.relaunch ?? null),
    runtimeFile: o.runtimeFile ?? "",
    reopenWaitMs: o.reopenWaitMs ?? REOPEN_WAIT_MS,
    reopener: REOPENER,
    runtime: process.execPath,
    ps: o.ps ?? "ps",
    reopenMs: o.reopenMs ?? REOPEN_MS,
  };
  const url = URL.createObjectURL(new Blob([SOURCE], { type: "application/javascript" }));
  const worker = new Worker(url, { workerData: { beats, cfg } } as WorkerOptions);
  // Neither keeps a process alive that would otherwise exit (a test, a quit).
  (worker as { unref?: () => void }).unref?.();
  // clock: the app's heartbeat to its watchdog, real time between threads.
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
