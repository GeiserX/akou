/**
 * ROADMAP G6, recognizer speed, live half: how long after an utterance ends its line is committed
 * to the log, through the real app's live path (VAD, provisional re-decodes, then the decoding the
 * app runs: greedy by default, or `modified_beam_search` with the call's decode list when
 * `asr.parakeet.decoding` is `beam`). The result records the mode as `decoding`.
 *
 * It lays speech clips out on a stereo timeline (left = mic, right = call, overlapping so both
 * channels load the recognizer at once), writes it as a 48 kHz WAV plus a manifest of where each
 * utterance ends, starts a call with `--vocab` and waits for the timeline to play. The app must be
 * configured to run akou-capture in file mode on that WAV at real-time speed
 * (`… --from-wav <wav> --realtime`), so file second x is captured at wall time `wallStart + x`.
 * Latency is the committed `seg` event's time (revision 1) minus that wall time of the utterance's
 * last speech. With a stream diarizer a call line commits as `c?` and its speaker is a later
 * revision; `speakerMs` is that revision's time on the same scale.
 *
 * With `AKOU_LINE_TIMING=1` in the app's environment the Worker logs each line's decode timing, and
 * every row gains `decodeMs` (the line's own decode), `provisionals` and `provisionalMs` (the
 * re-decodes of its open segment before it) and `behindMs` (how far behind the captured audio the
 * Worker was when the decode started). Latency is read off the wall clock, so a clock that is
 * stepped mid-run (a time sync) moves every later line: `clockSteps` lists each step this script
 * saw against the monotonic clock, and a run with one is not a measurement.
 *
 *   AKOU_HOME=… bun scripts/gates/g6-live-latency.ts --cli <cli.ts> --clips <dir of *.f32, 48 kHz>
 *     --wav <out.wav> --words w1,… [--gap 1.5] [--out result.json] [--build-only]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cliPath = opt("--cli");
const clipsDir = opt("--clips");
const wavPath = opt("--wav");
const words = opt("--words") ?? "";
const gap = Number(opt("--gap") ?? 1.5);
const home = process.env.AKOU_HOME;
if (!cliPath || !clipsDir || !wavPath || !home) {
  throw new Error("AKOU_HOME, --cli, --clips and --wav are required");
}
const RATE = 48_000;

/** The last sample above -40 dBFS, as the utterance's end. */
function speechEnd(x: Float32Array): number {
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i] ?? 0) > 0.01) return i + 1;
  return x.length;
}

// Clips alternate between the channels; each channel's next clip starts `gap` s after its last
// one ended, and the call side starts half a clip later, so the two overlap.
const clips = readdirSync(clipsDir)
  .filter((f) => f.endsWith(".f32"))
  .sort()
  .map((f) => {
    const b = readFileSync(join(clipsDir, f));
    return {
      name: f,
      x: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)),
    };
  });
if (clips.length === 0) throw new Error(`no .f32 clips in ${clipsDir}: nothing to measure`);
const cursor = { mic: 1.0, call: 2.5 };
const utterances: Array<{ ch: "mic" | "call"; clip: string; start: number; end: number }> = [];
clips.forEach((c, i) => {
  const ch = i % 2 === 0 ? "mic" : "call";
  const start = cursor[ch];
  const end = start + speechEnd(c.x) / RATE;
  utterances.push({ ch, clip: c.name, start, end });
  cursor[ch] = start + c.x.length / RATE + gap;
});
const total = Math.max(cursor.mic, cursor.call) + 3;
const n = Math.ceil(total * RATE);
const pcm = new Int16Array(n * 2);
for (const u of utterances) {
  const c = clips.find((k) => k.name === u.clip);
  if (!c) continue;
  const o = Math.round(u.start * RATE);
  const lane = u.ch === "mic" ? 0 : 1;
  for (let i = 0; i < c.x.length && o + i < n; i++) {
    pcm[(o + i) * 2 + lane] = Math.max(-32768, Math.min(32767, Math.round((c.x[i] ?? 0) * 32767)));
  }
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.byteLength, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.byteLength, 40);
writeFileSync(wavPath, Buffer.concat([header, Buffer.from(pcm.buffer)]));
if (argv.includes("--build-only")) {
  console.log(JSON.stringify({ wav: wavPath, seconds: total, utterances: utterances.length }));
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function cli(...args: string[]) {
  const p = Bun.spawn(["bun", cliPath as string, ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out: out.trim() };
}

const started = await cli("start", "-t", "g6-live", "--vocab", words);
if (started.code !== 0) throw new Error(`start failed: ${started.out}`);
const folder = JSON.parse(started.out).folder as string;
const status = await cli("status");
const decoding = status.code === 0 ? (JSON.parse(status.out).asr?.decoding ?? null) : null;
// The wall clock against the monotonic one, twice a second: a step of 50 ms or more is recorded.
const clockSteps: { at: number; stepMs: number }[] = [];
const offset = () => Date.now() - performance.now();
let lastOffset = offset();
const playUntil = performance.now() + (total + 8) * 1000;
while (performance.now() < playUntil) {
  await sleep(500);
  const now = offset();
  if (Math.abs(now - lastOffset) >= 50) {
    clockSteps.push({ at: Date.now(), stepMs: Math.round(now - lastOffset) });
    lastOffset = now;
  }
}
const stopped = await cli("stop");
if (stopped.code !== 0) throw new Error(`stop failed, the call may still be live: ${stopped.out}`);

const events = readFileSync(join(folder, "events.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.startsWith("{"))
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const part = events.find((e) => e.type === "part.started");
const wallStart = part?.wallStart as number;
// Part 1 only: when the WAV ends the helper exits and the app restarts it on the same file.
// Revision 1 is the committed line; later revisions (a speaker, the review) carry no part.
const segs = events.filter(
  (e) => e.type === "seg" && e.rev === 1 && e.layer === "live" && e.part === part?.part,
);
/** The Worker's timing of each decoded line, by channel and end (`AKOU_LINE_TIMING=1`). */
interface Timing {
  ch: string;
  a1: number;
  pos: number;
  startedAt: number;
  decodeMs: number;
  provisionals: number;
  provisionalMs: number;
}
const timings = new Map<string, Timing>();
const appLog = join(home, ".config", "akou", "app.log");
for (const line of existsSync(appLog) ? readFileSync(appLog, "utf8").split("\n") : []) {
  const at = line.indexOf("line timing {");
  if (at < 0) continue;
  const t = JSON.parse(line.slice(at + "line timing ".length)) as Timing & { part: number };
  if (t.part === part?.part) timings.set(`${t.ch} ${t.a1.toFixed(3)}`, t);
}
/** When each line got its speaker: revision 1's, else the first later one carrying `spk`. */
const spokenAt = new Map<string, number>();
for (const e of events) {
  if (e.type !== "seg" || typeof e.spk !== "string" || e.spk === "c?") continue;
  if (!spokenAt.has(e.id as string)) spokenAt.set(e.id as string, e.t as number);
}
const rows = utterances.map((u) => {
  // The last live line on that channel that overlaps the utterance commits its end.
  const hits = segs.filter(
    (s) => s.ch === u.ch && (s.a0 as number) < u.end && (s.a1 as number) > u.start,
  );
  const last = hits.sort((a, b) => (a.a1 as number) - (b.a1 as number)).at(-1);
  const spoken = last ? spokenAt.get(last.id as string) : undefined;
  const timing = last ? timings.get(`${u.ch} ${(last.a1 as number).toFixed(3)}`) : undefined;
  return {
    ch: u.ch,
    clip: u.clip,
    end: Math.round(u.end * 1000) / 1000,
    lines: hits.length,
    latencyMs: last ? (last.t as number) - (wallStart + u.end * 1000) : null,
    speakerMs: spoken === undefined ? null : spoken - (wallStart + u.end * 1000),
    ...(timing
      ? {
          decodeMs: timing.decodeMs,
          provisionals: timing.provisionals,
          provisionalMs: timing.provisionalMs,
          behindMs: Math.round(timing.startedAt - (wallStart + timing.pos * 1000)),
        }
      : {}),
    text: hits.map((h) => h.text).join(" / "),
  };
});
const sorted = (xs: (number | null)[]) =>
  xs.filter((v): v is number => v !== null).sort((a, b) => a - b);
const lat = sorted(rows.map((r) => r.latencyMs));
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1)))];
const summary = (xs: number[]) =>
  xs.length === 0
    ? null
    : { p50: xs[Math.floor(0.5 * (xs.length - 1))], max: xs[xs.length - 1], n: xs.length };
const result = {
  folder,
  decoding,
  seconds: Math.round(total * 10) / 10,
  utterances: utterances.length,
  committed: lat.length,
  lineTimings: timings.size,
  clockSteps,
  latencyMs: { min: lat[0], p50: q(0.5), p90: q(0.9), max: lat[lat.length - 1] },
  byChannel: Object.fromEntries(
    (["mic", "call"] as const).map((ch) => [
      ch,
      {
        latencyMs: summary(sorted(rows.filter((r) => r.ch === ch).map((r) => r.latencyMs))),
        speakerMs: summary(sorted(rows.filter((r) => r.ch === ch).map((r) => r.speakerMs))),
      },
    ]),
  ),
  vocabUsed: events.filter((e) => e.type === "vocab.used"),
  asrEvents: events.filter((e) => String(e.type).startsWith("asr.")),
  rows,
};
const text = JSON.stringify(result, null, 2);
const out = opt("--out");
if (out) writeFileSync(out, `${text}\n`);
console.log(text);
