/**
 * ROADMAP G5, containment: a helper that hangs in teardown and a helper that crashes, against the
 * real app. Pass: the app stays responsive, the log gets `part.ended`, the next start answers 201
 * within 3 s, and the seconds of audio lost are measured and under 2.
 *
 * Audio lost is measured on content, not on file length: the call side carries a known tone
 * (900 Hz on the right channel of `--fixture`, which this script writes), and a 20 ms slice of a
 * part counts as captured only when the tone is in it. A part that holds encoded silence where the
 * call should be counts as lost. Before any call, a positive control runs the same measure on an
 * Opus file with a known 1.5 s hole and on one that is silent throughout, and stops the gate if the
 * measure does not see them.
 *
 * The app must be configured (`capture.helper` in its config.json) to run a wrapper that starts
 * the `simulate` build of akou-capture in file mode on the fixture and appends the fault named in
 * `--fault-file`, read at every spawn, so one app run can go through every scenario:
 *
 *   #!/bin/sh
 *   exec akou-capture-sim "$@" --from-wav fixture.wav --realtime --loop $(cat fault-file)
 *
 * `--kill-real` instead runs a device capture (the configured helper must then be the real one,
 * `--call system`), plays the fixture with `afplay` so the tap hears the tone, and SIGKILLs this
 * call's helper mid-call: a crash the helper did not choose.
 *
 *   AKOU_HOME=… bun scripts/gates/g5-containment.ts --cli <path to cli.ts> --fixture <out.wav>
 *     (--fault-file F | --kill-real) [--out result.json]
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cliPath = opt("--cli");
const faultFile = opt("--fault-file");
const fixture = opt("--fixture");
const killReal = argv.includes("--kill-real");
const home = process.env.AKOU_HOME;
if (!cliPath || !home || !fixture || (!faultFile && !killReal)) {
  throw new Error("AKOU_HOME, --cli, --fixture and --fault-file (or --kill-real) are required");
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

async function status(): Promise<{ live: { call: string } | null }> {
  const token = readFileSync(join(configDir, "token"), "utf8").trim();
  const r = await fetch(`http://127.0.0.1:${runtime().port}/v1/status`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  return (await r.json()) as { live: { call: string } | null };
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

// ---------------------------------------------------------------------------------------------
// The known signal and the content measure

const RATE = 48_000;
const TONE_HZ = 900;
const SLICE = 960; // 20 ms: exactly 18 periods of 900 Hz
const AMP = 10 ** (-30 / 20);
const FLOOR = 10 ** (-60 / 20);

/** A stereo 16-bit WAV: 500 Hz on the left (mic), 900 Hz on the right (call), `-30 dBFS` each. */
function writeFixture(path: string, seconds: number, holeOnCall?: [number, number]) {
  const n = seconds * RATE;
  const pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const inHole = holeOnCall && t >= holeOnCall[0] && t < holeOnCall[1];
    pcm[i * 2] = Math.round(Math.sin(2 * Math.PI * 500 * t) * AMP * 32767);
    pcm[i * 2 + 1] = inHole ? 0 : Math.round(Math.sin(2 * Math.PI * TONE_HZ * t) * AMP * 32767);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.byteLength, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.byteLength, 40);
  writeFileSync(path, Buffer.concat([h, Buffer.from(pcm.buffer)]));
}

/** The 900 Hz amplitude of every 20 ms slice of a file's right (call) channel. */
async function callTone(file: string): Promise<number[]> {
  if (!existsSync(file)) return [];
  const p = Bun.spawn(
    ["ffmpeg", "-v", "error", "-i", file, "-af", "pan=mono|c0=c1", "-f", "s16le", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const b = Buffer.from(await new Response(p.stdout).arrayBuffer());
  if ((await p.exited) !== 0) throw new Error(`ffmpeg could not decode ${basename(file)}`);
  const x = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
  const w = (2 * Math.PI * TONE_HZ) / RATE;
  const out: number[] = [];
  for (let s = 0; s + SLICE <= x.length; s += SLICE) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < SLICE; i++) {
      const v = (x[s + i] ?? 0) / 32768;
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    out.push((2 * Math.hypot(re, im)) / SLICE);
  }
  return out;
}

/**
 * Wall time from the first part's start to `until` that no slice with the tone covers. A slice
 * counts when its tone is above -60 dBFS and at least half the median level of the toned slices,
 * so a slice the tone fills less than half of, or a leak through the codec, does not count.
 */
function lost(parts: Array<{ wallStart: number; tone: number[] }>, until: number) {
  const toned = parts
    .flatMap((p) => p.tone)
    .filter((a) => a > FLOOR)
    .sort((a, b) => a - b);
  const median = toned[Math.floor(toned.length / 2)] ?? Number.POSITIVE_INFINITY;
  const min = Math.max(FLOOR, median / 2);
  const ms = (SLICE / RATE) * 1000;
  const spans: Array<[number, number]> = [];
  for (const p of parts) {
    p.tone.forEach((a, i) => {
      if (a >= min) spans.push([p.wallStart + i * ms, p.wallStart + (i + 1) * ms]);
    });
  }
  spans.sort((a, b) => a[0] - b[0]);
  const first = parts[0]?.wallStart ?? 0;
  let covered = 0;
  let cursor = first;
  for (const [s, e] of spans) {
    const a = Math.max(cursor, s);
    const b = Math.min(until, e);
    if (b > a) covered += b - a;
    cursor = Math.max(cursor, b);
  }
  return {
    wallSeconds: (until - first) / 1000,
    capturedSeconds: Math.round(covered) / 1000,
    lostSeconds: Math.round(until - first - covered) / 1000,
  };
}

/** Encodes a WAV to stereo Opus the way the helper stores a part. */
async function toOpus(wav: string, opus: string) {
  const p = Bun.spawn(
    ["ffmpeg", "-v", "error", "-y", "-i", wav, "-c:a", "libopus", "-b:a", "64k", opus],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await p.exited) !== 0) throw new Error("ffmpeg could not encode the control to Opus");
}

/**
 * Positive control: the measure must see a 1.5 s hole in the call tone, a call channel that is
 * encoded silence throughout, and no loss on an intact file.
 */
async function selfCheck() {
  const dir = mkdtempSync(join(tmpdir(), "akou-g5-"));
  const cases: Array<{ name: string; hole?: [number, number]; expect: number }> = [
    { name: "intact", expect: 0 },
    { name: "hole", hole: [2, 3.5], expect: 1.5 },
    { name: "silent", hole: [0, 6], expect: 6 },
  ];
  const out: Record<string, number> = {};
  for (const c of cases) {
    const wav = join(dir, `${c.name}.wav`);
    const opus = join(dir, `${c.name}.opus`);
    writeFixture(wav, 6, c.hole);
    await toOpus(wav, opus);
    // The silent case alone has no toned slice to set the median: measure it beside an intact
    // part, as a real call would have one, and count only its own span.
    const tone = await callTone(opus);
    const parts =
      c.name === "silent"
        ? [
            { wallStart: 0, tone },
            { wallStart: 60_000, tone: await callTone(join(dir, "intact.opus")) },
          ]
        : [{ wallStart: 0, tone }];
    const got = lost(parts, 6000).lostSeconds;
    out[c.name] = got;
    if (Math.abs(got - c.expect) > 0.06) {
      throw new Error(`positive control ${c.name}: measured ${got} s lost, expected ${c.expect}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

function events(folder: string): Array<Record<string, unknown>> {
  return readFileSync(join(folder, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
}

async function audio(folder: string, stopAt: number) {
  const ev = events(folder);
  const parts = [];
  for (const s of ev.filter((e) => e.type === "part.started")) {
    const end = ev.find((e) => e.type === "part.ended" && e.part === s.part);
    const tone = await callTone(join(folder, s.file as string));
    parts.push({
      part: s.part as number,
      wallStart: s.wallStart as number,
      endReason: (end?.reason as string | undefined) ?? null,
      loggedFileSeconds: (end?.fileSeconds as number | undefined) ?? null,
      tone,
    });
  }
  const m = lost(parts, stopAt);
  return {
    parts: parts.map(({ tone, ...p }) => ({
      ...p,
      slices: tone.length,
      tonedSlices: tone.filter((a) => a > FLOOR).length,
    })),
    ...m,
  };
}

/** The live helper whose output is inside this call's folder, by its command line. */
async function helperFor(folder: string): Promise<number[]> {
  const p = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe" });
  const text = await new Response(p.stdout).text();
  return text
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .filter((m) => /akou-capture\S*\s+run\s/.test(m[2] ?? ""))
    .filter((m) => (m[2] ?? "").includes(` --out ${folder}/`))
    .map((m) => Number(m[1]));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A start answer without the machine's own paths. */
function body(out: string): Record<string, unknown> {
  const b = JSON.parse(out || "{}") as Record<string, unknown>;
  if (typeof b.folder === "string") b.folder = basename(b.folder);
  return b;
}

function started(r: { code: number; out: string }, what: string): string {
  if (r.code !== 0) throw new Error(`${what} start failed: ${r.out}`);
  return JSON.parse(r.out).folder as string;
}

const setFault = (f: string) => {
  if (faultFile) writeFileSync(faultFile, f);
};

const result: Record<string, unknown> = { at: new Date().toISOString() };
result.positiveControl = await selfCheck();
writeFixture(fixture, 60);

// Whatever fails below, the app is quit at the end, which also stops a call left live.
let poller: Poller | null = null;
try {
  // Launch the app with a harmless call, so the poller has a port before the first fault.
  setFault("");
  const warm = await cli("start", "-t", "g5-warmup");
  if (warm.code !== 0) throw new Error(`warm-up start failed: ${warm.out}`);
  await sleep(2000);
  await cli("stop");
  poller = new Poller();

  type Scenario = {
    partEnded: Array<Record<string, unknown>>;
    nextStart: { code: number; ms: number };
    audio: { lostSeconds: number };
    apiDuring: { failed: number };
  };
  /** The G5 criteria, per scenario. */
  function verdict(s: Scenario, parts: number) {
    const v = {
      everyPartEnded: s.partEnded.length === parts,
      nextStart201Within3s: s.nextStart.code === 0 && s.nextStart.ms < 3000,
      lostUnder2s: s.audio.lostSeconds < 2,
      apiNeverFailed: s.apiDuring.failed === 0,
    };
    return { ...v, pass: Object.values(v).every(Boolean) };
  }

  if (!killReal) {
    // 1. Teardown hang: the helper ignores stop; the app must kill it within its budget, and a new
    // call must start while that teardown is still hanging.
    setFault("--simulate hang-on-stop");
    const t0 = Date.now();
    const s1 = await cli("start", "-t", "g5-hang");
    const folder1 = started(s1, "hang");
    const call1 = JSON.parse(s1.out).call as string;
    await sleep(15_000);
    const stopReq = Date.now();
    let stopDone = false;
    const stopping = cli("stop").then((r) => {
      stopDone = true;
      return r;
    });
    // The next start must reach the app after the stop does, or it is refused as a second call.
    while ((await status()).live?.call === call1) {
      if (Date.now() - stopReq > 3000) throw new Error("the hang call never left the live state");
      await sleep(20);
    }
    setFault("");
    const startedBeforeStopEnded = !stopDone;
    const next1 = await cli("start", "-t", "g5-after-hang");
    const answeredBeforeStopEnded = !stopDone;
    const stop1 = await stopping;
    const t1 = Date.now();
    if (!startedBeforeStopEnded || !answeredBeforeStopEnded) {
      throw new Error("the next start did not overlap the hanging teardown; nothing was tested");
    }
    await sleep(3000);
    await cli("stop");
    const partEnded = events(folder1).filter((e) => e.type === "part.ended");
    if (partEnded[0]?.reason !== "killed") {
      throw new Error(`the hang fault did not hang: part.ended ${JSON.stringify(partEnded)}`);
    }
    const hang = {
      start: { code: s1.code, ms: s1.ms },
      stop: { code: stop1.code, ms: stop1.ms, body: body(stop1.out) },
      nextStart: {
        code: next1.code,
        ms: next1.ms,
        whileTeardownHung: startedBeforeStopEnded && answeredBeforeStopEnded,
        body: body(next1.out),
      },
      partEnded,
      audio: await audio(folder1, stopReq),
      apiDuring: poller.between(t0, t1),
    };
    result.hang = {
      ...hang,
      verdict: verdict(hang, events(folder1).filter((e) => e.type === "part.started").length),
    };

    // 2. Crash: the helper exits 70 at 20 s of audio; the app restarts it in a new part.
    setFault("--simulate crash-at=20");
    const t2 = Date.now();
    const s2 = await cli("start", "-t", "g5-crash");
    const folder2 = started(s2, "crash");
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
    const ev2 = events(folder2);
    if (ev2.find((e) => e.type === "part.ended")?.reason !== "helper-exit") {
      throw new Error("the crash fault did not crash the helper");
    }
    const crash = {
      start: { code: s2.code, ms: s2.ms },
      stop: { code: stop2.code, ms: stop2.ms },
      nextStart: { code: next2.code, ms: next2.ms, body: body(next2.out) },
      partEnded: ev2.filter((e) => e.type === "part.ended"),
      events: ev2.filter((e) =>
        ["part.started", "part.ended", "health", "call.ended"].includes(e.type as string),
      ),
      audio: await audio(folder2, stopReq2),
      apiDuring: poller.between(t2, t3),
    };
    result.crash = {
      ...crash,
      verdict: verdict(crash, ev2.filter((e) => e.type === "part.started").length),
    };
  } else {
    // A real device capture, with the tone playing so the tap hears it, whose helper is SIGKILLed
    // after 20 s.
    const player = Bun.spawn(["afplay", fixture], { stdout: "ignore", stderr: "ignore" });
    await sleep(1000);
    const t0 = Date.now();
    const s = await cli("start", "-t", "g5-kill-real");
    const folder = started(s, "kill-real");
    await sleep(20_000);
    const pids = await helperFor(folder);
    if (pids.length !== 1) {
      player.kill();
      throw new Error(`expected one helper writing into this call, found ${pids.length}`);
    }
    const pid = pids[0] as number;
    const killedAt = Date.now();
    process.kill(pid, "SIGKILL");
    await sleep(500);
    if (alive(pid)) {
      player.kill();
      throw new Error(`helper ${pid} survived SIGKILL`);
    }
    await sleep(14_500);
    const stopReq = Date.now();
    const stop = await cli("stop");
    const next = await cli("start", "-t", "g5-after-kill");
    const t1 = Date.now();
    await sleep(3000);
    await cli("stop");
    player.kill();
    const ev = events(folder);
    const ended1 = ev.find((e) => e.type === "part.ended" && e.part === 1);
    if (!ended1 || (ended1.t as number) < killedAt) {
      throw new Error("part 1 did not end after the kill: the killed process was not this call's");
    }
    const kill = {
      killedAt,
      helperOfThisCall: true,
      start: { code: s.code, ms: s.ms },
      stop: { code: stop.code, ms: stop.ms },
      nextStart: { code: next.code, ms: next.ms, body: body(next.out) },
      partEnded: ev.filter((e) => e.type === "part.ended"),
      events: ev.filter((e) =>
        ["part.started", "part.ended", "health", "call.ended"].includes(e.type as string),
      ),
      audio: await audio(folder, stopReq),
      apiDuring: poller.between(t0, t1),
    };
    result.killReal = {
      ...kill,
      verdict: verdict(kill, ev.filter((e) => e.type === "part.started").length),
    };
  }
} finally {
  await poller?.stop();
  await cli("quit");
}
const text = JSON.stringify(result, null, 2);
const out = opt("--out");
if (out) writeFileSync(out, `${text}\n`);
console.log(text);
