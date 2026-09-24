/**
 * One recording through the real path for the capture gates (G3-lite, G4): quit the app, run
 * `akou start` cold and time it, sample the app's and the helper's memory every 30 s, stop after
 * `--seconds`, and wait for `part.ended`. Prints the start's timing and answer and the call folder,
 * for `scripts/drift-test.ts`. `--without-models` passes the same flag to `akou start`, so the app
 * records audio only, with no recognizer loaded, and starts on a machine without the models.
 *
 *   AKOU_HOME=… bun scripts/gates/record-call.ts --cli <cli.ts> --seconds N [--tag T]
 *     [--without-models] [--memory memory.csv] [--out result.json]
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cliPath = opt("--cli");
const seconds = Number(opt("--seconds"));
const home = process.env.AKOU_HOME;
if (!cliPath || !home || !Number.isFinite(seconds)) {
  throw new Error("AKOU_HOME, --cli and --seconds are required");
}
const configDir = join(home, ".config", "akou");
const memory = opt("--memory");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cli(...args: string[]) {
  const t = performance.now();
  const p = Bun.spawn(["bun", cliPath as string, ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { code, ms: Math.round(performance.now() - t), out: out.trim() };
}

function appPid(): number | null {
  try {
    return JSON.parse(readFileSync(join(configDir, "runtime.json"), "utf8")).pid ?? null;
  } catch {
    return null;
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** RSS in kB and CPU % of a pid, from ps. */
function ps(pid: number | null): [number, number] {
  if (!pid) return [0, 0];
  const r = Bun.spawnSync(["ps", "-o", "rss=,%cpu=", "-p", String(pid)]);
  const [rss, cpu] = r.stdout.toString().trim().split(/\s+/).map(Number);
  return [rss ?? 0, cpu ?? 0];
}
function helperPid(app: number | null): number | null {
  if (!app) return null;
  const r = Bun.spawnSync(["pgrep", "-P", String(app), "-f", "akou-capture"]);
  const p = Number(r.stdout.toString().trim().split("\n")[0]);
  return Number.isFinite(p) && p > 0 ? p : null;
}

const old = appPid();
if (old && alive(old)) {
  await cli("quit");
  for (let i = 0; alive(old) && i < 200; i++) await sleep(50);
  if (alive(old)) throw new Error(`the app (pid ${old}) did not quit`);
}

const start = await cli(
  "start",
  "-t",
  opt("--tag") ?? "gate-recording",
  ...(argv.includes("--without-models") ? ["--without-models"] : []),
);
if (start.code !== 0) throw new Error(`start failed: ${start.out}`);
const body = JSON.parse(start.out);
const app = appPid();
if (memory) writeFileSync(memory, "epoch,app_rss_kb,helper_rss_kb,app_cpu,helper_cpu\n");
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  if (memory) {
    const [ar, ac] = ps(app);
    const [hr, hc] = ps(helperPid(app));
    appendFileSync(memory, `${Math.round(Date.now() / 1000)},${ar},${hr},${ac},${hc}\n`);
  }
  await sleep(Math.max(0, Math.min(30_000, seconds * 1000 - (Date.now() - t0))));
}
const stop = await cli("stop");
const log = join(body.folder, "events.jsonl");
let ended = false;
for (let i = 0; i < 100 && !ended; i++) {
  ended = existsSync(log) && readFileSync(log, "utf8").includes('"part.ended"');
  if (!ended) await sleep(100);
}
await cli("quit");

const result = {
  start: { code: start.code, ms: start.ms, firstAudioMs: body.firstAudioMs, appWasRunning: false },
  stop: { code: stop.code, ms: stop.ms },
  partEnded: ended,
  recordedSeconds: seconds,
  folder: body.folder,
};
const text = JSON.stringify(result, null, 2);
const out = opt("--out");
if (out) writeFileSync(out, `${text}\n`);
console.log(text);
