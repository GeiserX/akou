/**
 * ROADMAP G8 and TRAPS "Minutes to start": how long `akou start` takes to answer 201, measured as
 * the whole CLI process from spawn to exit, the way a person or an agent waits for it.
 *
 * - **Cold**: the app is not running, so the CLI launches it headless and waits for its API, then
 *   the app spawns the helper and answers once audio is being written. Between runs the call is
 *   stopped and the app quit, and the next run waits until its process is gone.
 * - **Warm**: the app is running; start, record 2 s, stop.
 *
 *   AKOU_HOME=… bun scripts/gates/g8-start.ts --cli <cli.ts> [--runs 20] [--out result.json]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cliPath = opt("--cli");
const runs = Number(opt("--runs") ?? 20);
const home = process.env.AKOU_HOME;
if (!cliPath || !home) throw new Error("AKOU_HOME and --cli are required");
const configDir = join(home, ".config", "akou");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function cli(...args: string[]) {
  const t = performance.now();
  const p = Bun.spawn(["bun", cliPath as string, ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { code, ms: performance.now() - t, out: out.trim() };
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

async function quitAndWait(): Promise<void> {
  const pid = appPid();
  await cli("quit");
  for (let i = 0; pid && alive(pid) && i < 200; i++) await sleep(50);
}

function summary(rows: Array<{ code: number; ms: number; firstAudioMs?: number }>) {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p: number) => ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)] ?? Number.NaN;
  const r1 = (v: number) => Math.round(v);
  return {
    runs: rows.length,
    ok201: rows.filter((r) => r.code === 0).length,
    minMs: r1(ms[0] ?? Number.NaN),
    p50Ms: r1(q(0.5)),
    p95Ms: r1(q(0.95)),
    maxMs: r1(ms[ms.length - 1] ?? Number.NaN),
    firstAudioMs: rows.map((r) => r.firstAudioMs ?? null),
    allMs: rows.map((r) => r1(r.ms)),
  };
}

const cold: Array<{ code: number; ms: number; firstAudioMs?: number }> = [];
await quitAndWait();
for (let i = 0; i < runs; i++) {
  const r = await cli("start", "-t", `g8-cold-${i + 1}`);
  const body = r.code === 0 ? JSON.parse(r.out) : null;
  cold.push({ code: r.code, ms: r.ms, firstAudioMs: body?.firstAudioMs });
  await sleep(2000);
  await cli("stop");
  await quitAndWait();
  await sleep(1000);
}

const warm: Array<{ code: number; ms: number; firstAudioMs?: number }> = [];
await cli("status");
const launch = await cli("start", "-t", "g8-warm-launch");
await sleep(2000);
await cli("stop");
if (launch.code !== 0) throw new Error(`warm launch failed: ${launch.out}`);
for (let i = 0; i < runs; i++) {
  await sleep(1000);
  const r = await cli("start", "-t", `g8-warm-${i + 1}`);
  const body = r.code === 0 ? JSON.parse(r.out) : null;
  warm.push({ code: r.code, ms: r.ms, firstAudioMs: body?.firstAudioMs });
  await sleep(2000);
  await cli("stop");
}
await quitAndWait();

const result = { cold: summary(cold), warm: summary(warm) };
const text = JSON.stringify(result, null, 2);
const out = opt("--out");
if (out) writeFileSync(out, `${text}\n`);
console.log(text);
