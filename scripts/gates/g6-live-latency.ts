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
 * Latency is the committed `seg` event's time minus that wall time of the utterance's last speech.
 *
 *   AKOU_HOME=… bun scripts/gates/g6-live-latency.ts --cli <cli.ts> --clips <dir of *.f32, 48 kHz>
 *     --wav <out.wav> --words w1,… [--gap 1.5] [--out result.json] [--build-only]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
await sleep((total + 8) * 1000);
const stopped = await cli("stop");
if (stopped.code !== 0) throw new Error(`stop failed, the call may still be live: ${stopped.out}`);

const events = readFileSync(join(folder, "events.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.startsWith("{"))
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const part = events.find((e) => e.type === "part.started");
const wallStart = part?.wallStart as number;
// Part 1 only: when the WAV ends the helper exits and the app restarts it on the same file.
const segs = events.filter(
  (e) => e.type === "seg" && (e.layer ?? "live") === "live" && e.part === part?.part,
);
const rows = utterances.map((u) => {
  // The last live line on that channel that overlaps the utterance commits its end.
  const hits = segs.filter(
    (s) => s.ch === u.ch && (s.a0 as number) < u.end && (s.a1 as number) > u.start,
  );
  const last = hits.sort((a, b) => (a.a1 as number) - (b.a1 as number)).at(-1);
  return {
    ch: u.ch,
    clip: u.clip,
    end: Math.round(u.end * 1000) / 1000,
    lines: hits.length,
    latencyMs: last ? (last.t as number) - (wallStart + u.end * 1000) : null,
    text: hits.map((h) => h.text).join(" / "),
  };
});
const lat = rows
  .map((r) => r.latencyMs)
  .filter((v): v is number => v !== null)
  .sort((a, b) => a - b);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1)))];
const result = {
  folder,
  decoding,
  seconds: Math.round(total * 10) / 10,
  utterances: utterances.length,
  committed: lat.length,
  latencyMs: { min: lat[0], p50: q(0.5), p90: q(0.9), max: lat[lat.length - 1] },
  vocabUsed: events.filter((e) => e.type === "vocab.used"),
  asrEvents: events.filter((e) => String(e.type).startsWith("asr.")),
  rows,
};
const text = JSON.stringify(result, null, 2);
const out = opt("--out");
if (out) writeFileSync(out, `${text}\n`);
console.log(text);
