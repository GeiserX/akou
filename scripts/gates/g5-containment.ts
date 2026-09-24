/**
 * ROADMAP G5, containment: a helper that hangs in teardown and a helper that crashes, against the
 * real app. Pass: the app stays responsive, the log gets `part.ended`, the next start answers 201
 * within 3 s, and the seconds of audio lost are measured and under 2.
 *
 * The app must be configured (`capture.helper` in its config.json) to run a wrapper that starts
 * the `simulate` build of akou-capture in file mode and appends the fault named in `--fault-file`,
 * read at every spawn, so one app run can go through every scenario:
 *
 *   #!/bin/sh
 *   exec akou-capture-sim "$@" --from-wav fixture.wav --realtime --loop $(cat fault-file)
 *
 * `--kill-real` instead runs a device capture (the configured helper must then be the real one)
 * and SIGKILLs the helper mid-call: a crash the helper did not choose.
 *
 *   AKOU_HOME=… bun scripts/gates/g5-containment.ts --cli <path to cli.ts> --fault-file F
 *     [--kill-real] [--out result.json]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cliPath = opt("--cli");
const faultFile = opt("--fault-file");
const killReal = argv.includes("--kill-real");
const home = process.env.AKOU_HOME;
if (!cliPath || !home || (!faultFile && !killReal)) {
  throw new Error("AKOU_HOME, --cli and --fault-file (or --kill-real) are required");
}
const configDir = join(home, ".config", "akou");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cli(...args: string[]): Promise<{ code: number; ms: number; out: string }> {
  const t = performance.now();
  const p = Bun.spawn(["bun", cliPath as string, ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { code, ms: Math.round(performance.now() - t), out: out.trim() };
}

function runtime(): { port: number; pid: number } {
  return JSON.parse(readFileSync(join(configDir, "runtime.json"), "utf8"));
}

/** Polls GET /v1/status every 100 ms and keeps each answer's latency. */
class Poller {
  samples: Array<{ at: number; ms: number; ok: boolean }> = [];
  private on = true;
  private done: Promise<void>;
  constructor() {
    const rt = runtime();
    const token = readFileSync(join(configDir, "token"), "utf8").trim();
    const url = `http://127.0.0.1:${rt.port}/v1/status`;
    this.done = (async () => {
      while (this.on) {
        const t = performance.now();
        let ok = false;
        try {
          const r = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          });
          ok = r.status === 200;
          await r.text();
        } catch {}
        this.samples.push({ at: Date.now(), ms: performance.now() - t, ok });
        await sleep(100);
      }
    })();
  }
  async stop() {
    this.on = false;
    await this.done;
  }
  between(a: number, b: number) {
    const s = this.samples.filter((x) => x.at >= a && x.at <= b);
    const ms = s.map((x) => x.ms).sort((p, q) => p - q);
    return {
      requests: s.length,
      failed: s.filter((x) => !x.ok).length,
      p50Ms: Math.round((ms[Math.floor(ms.length * 0.5)] ?? 0) * 10) / 10,
      p99Ms: Math.round((ms[Math.floor(ms.length * 0.99)] ?? 0) * 10) / 10,
      maxMs: Math.round((ms[ms.length - 1] ?? 0) * 10) / 10,
    };
  }
}

/** Seconds of audio that decode from an Opus file. */
async function decodable(file: string): Promise<number> {
  if (!existsSync(file)) return 0;
  const p = Bun.spawn(
    ["ffmpeg", "-v", "error", "-i", file, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const n = (await new Response(p.stdout).arrayBuffer()).byteLength;
  await p.exited;
  return n / 2 / 48000;
}

function events(folder: string): Array<Record<string, unknown>> {
  return readFileSync(join(folder, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
}

async function helperPid(): Promise<number | null> {
  const p = Bun.spawn(["pgrep", "-f", "akou-capture.* run "], { stdout: "pipe" });
  const out = (await new Response(p.stdout).text()).trim().split("\n")[0];
  return out ? Number(out) : null;
}

const setFault = (f: string) => {
  if (faultFile) writeFileSync(faultFile, f);
};

const result: Record<string, unknown> = { at: new Date().toISOString() };

// Launch the app with a harmless call, so the poller has a port before the first fault.
setFault("");
const warm = await cli("start", "-t", "g5-warmup");
if (warm.code !== 0) throw new Error(`warm-up start failed: ${warm.out}`);
await sleep(2000);
await cli("stop");
const poller = new Poller();

async function lostSeconds(folder: string, stopAt: number | null) {
  const ev = events(folder);
  const started = ev.filter((e) => e.type === "part.started");
  const parts = [];
  for (const s of started) {
    const end = ev.find((e) => e.type === "part.ended" && e.part === s.part);
    const file = join(folder, s.file as string);
    parts.push({
      part: s.part,
      wallStart: s.wallStart as number,
      endReason: end?.reason ?? null,
      loggedFileSeconds: end?.fileSeconds ?? null,
      decodableSeconds: Math.round((await decodable(file)) * 1000) / 1000,
    });
  }
  // Audio covered: each part's decodable seconds from its wall start. Lost: wall time from the
  // first start to the stop request that no part covers.
  const first = parts[0]?.wallStart ?? 0;
  const until = stopAt ?? Date.now();
  let covered = 0;
  let cursor = first;
  for (const p of parts) {
    const a = Math.max(cursor, p.wallStart);
    const b = Math.min(until, p.wallStart + p.decodableSeconds * 1000);
    if (b > a) covered += b - a;
    cursor = Math.max(cursor, b);
  }
  return {
    parts,
    wallSeconds: (until - first) / 1000,
    lostSeconds: Math.round(((until - first - covered) / 1000) * 1000) / 1000,
  };
}

function lastFolder(startOut: string): string {
  return JSON.parse(startOut).folder as string;
}

if (!killReal) {
  // 1. Teardown hang: the helper ignores stop; the app must kill it within its budget.
  setFault("--simulate hang-on-stop");
  const t0 = Date.now();
  const s1 = await cli("start", "-t", "g5-hang");
  const folder1 = lastFolder(s1.out);
  await sleep(15_000);
  const stopReq = Date.now();
  const stop1 = await cli("stop");
  setFault("");
  const next1 = await cli("start", "-t", "g5-after-hang");
  const t1 = Date.now();
  await sleep(3000);
  await cli("stop");
  result.hang = {
    start: { code: s1.code, ms: s1.ms },
    stop: { code: stop1.code, ms: stop1.ms, body: JSON.parse(stop1.out || "{}") },
    nextStart: { code: next1.code, ms: next1.ms, body: JSON.parse(next1.out || "{}") },
    partEnded: events(folder1).filter((e) => e.type === "part.ended"),
    audio: await lostSeconds(folder1, stopReq),
    apiDuring: poller.between(t0, t1),
  };

  // 2. Crash: the helper exits 70 at 20 s of audio; the app restarts it in a new part.
  setFault("--simulate crash-at=20");
  const t2 = Date.now();
  const s2 = await cli("start", "-t", "g5-crash");
  const folder2 = lastFolder(s2.out);
  // The restarted helper reads the fault file again: make it a healthy one.
  await sleep(1000);
  setFault("");
  await sleep(34_000);
  const stopReq2 = Date.now();
  const stop2 = await cli("stop");
  const next2 = await cli("start", "-t", "g5-after-crash");
  const t3 = Date.now();
  await sleep(3000);
  await cli("stop");
  result.crash = {
    start: { code: s2.code, ms: s2.ms },
    stop: { code: stop2.code, ms: stop2.ms },
    nextStart: { code: next2.code, ms: next2.ms, body: JSON.parse(next2.out || "{}") },
    events: events(folder2).filter((e) =>
      ["part.started", "part.ended", "health", "call.ended"].includes(e.type as string),
    ),
    audio: await lostSeconds(folder2, stopReq2),
    apiDuring: poller.between(t2, t3),
  };
} else {
  // A real device capture whose helper is SIGKILLed after 20 s.
  const t0 = Date.now();
  const s = await cli("start", "-t", "g5-kill-real");
  const folder = lastFolder(s.out);
  await sleep(20_000);
  const pid = await helperPid();
  const killedAt = Date.now();
  if (pid) process.kill(pid, "SIGKILL");
  await sleep(15_000);
  const stopReq = Date.now();
  const stop = await cli("stop");
  const next = await cli("start", "-t", "g5-after-kill");
  const t1 = Date.now();
  await sleep(3000);
  await cli("stop");
  result.killReal = {
    helperPid: pid,
    killedAt,
    start: { code: s.code, ms: s.ms },
    stop: { code: stop.code, ms: stop.ms },
    nextStart: { code: next.code, ms: next.ms, body: JSON.parse(next.out || "{}") },
    events: events(folder).filter((e) =>
      ["part.started", "part.ended", "health", "call.ended"].includes(e.type as string),
    ),
    audio: await lostSeconds(folder, stopReq),
    apiDuring: poller.between(t0, t1),
  };
}

await poller.stop();
await cli("quit");
const text = JSON.stringify(result, null, 2);
const out = opt("--out");
if (out) writeFileSync(out, `${text}\n`);
console.log(text);
