/**
 * The two-clock drift test's analysis (ROADMAP G4, TRAPS "Drift between two clocks" and T0.15,
 * T0.16). It reads one recorded call and the schedule the signal source wrote
 * (`native/akou-capture/examples/drift-signal.rs`), and reports:
 *
 * - **Offsets.** Every chirp is found in the recording by cross-correlation with its template (or,
 *   when the codec has kept only its band energy, by that energy's envelope; the result says which)
 *   and compared with where its host time says it should be. Per channel that gives the channel's
 *   latency against the host clock over the hour; the mic chirp and the call chirp of the same
 *   period give the left-right offset. Drift is the change over the run, as a fitted slope in
 *   ms per hour and as the max-min spread.
 * - **Gaps.** Both sides carry a continuous pilot tone, so any run of near-zero samples longer
 *   than a few milliseconds while the source played is audio the recording lost.
 * - **First words after silence.** The clip the source plays from the first sample each time the
 *   call side starts is found in the recording (within 50 ms of where the chirps place it), then
 *   compared in 20 ms slices from the onset of its speech: the first slice that matches says how
 *   much of the first word was lost.
 * - **Memory.** The sampler's RSS readings (`epoch,app_rss_kb,helper_rss_kb,…`), over the run
 *   and inside the muted window.
 * - **Length.** The file's seconds against the wall time the part lasted.
 * - **Quiet windows.** When the source ran without a mic side (`--mic-device none`), nothing played
 *   before the call started or while it was paused, so the tap itself was quiet. The call
 *   channel's level in those windows shows it was, which is what makes the first-words and
 *   muted-memory checks mean something.
 *
 *   bun scripts/drift-test.ts --folder <call folder> --signal <signal.jsonl> [--memory memory.csv]
 *     [--clip first-words.f32] [--file other-audio] [--out result.json]
 *
 * `--file` analyses another audio file against the same schedule and log: the positive controls
 * (`scripts/gates/g4-controls.ts`) feed it a copy of the recording with a known offset or drift.
 *
 * Needs `ffmpeg` on PATH to decode the Opus file. Channels are decoded one at a time as 16-bit
 * 48 kHz mono, so an hour costs about 350 MB of memory per channel.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RATE = 48_000;
/** The coarse search runs at 12 kHz: both chirp bands (up to 4.5 kHz) survive. */
const DECIM = 4;
const CHIRP_S = 0.05;
const SEARCH_S = 1.0;
/** A match needs this normalized correlation. */
const MIN_SCORE = 0.5;
/**
 * Below MIN_SCORE the chirp is looked for by its band energy instead (`envelopeChirp`): the call
 * file is 48 kbps stereo Opus, and with both channels active the codec keeps a 50 ms sweep's energy
 * in its band but not its waveform, so the waveform correlation can fall to 0.3 on a chirp that is
 * plainly there. The envelope match needs this Pearson correlation with the template's energy
 * envelope, and the burst this far above the window's median band energy.
 */
const MIN_ENVELOPE_SCORE = 0.8;
const MIN_ENVELOPE_SNR_DB = 10;
/** The envelope runs at RATE / ENV_HOP with a 2.5 ms energy window. */
const ENV_HOP = DECIM;
const ENV_WIN = Math.round(0.0025 * RATE);
/** Zeros around the template before filtering, so its filter tail is part of the reference. */
const ENV_PAD = Math.round(0.02 * RATE);
/** A sample this close to zero (16-bit units, about -60 dBFS) counts toward a gap. */
const ZERO = 30;

interface SignalStart {
  t0_ns: number;
  period_s: number;
  call_offset_s: number;
  chirp_s: number;
  call_start_s: number;
  mute_at_s: number;
  mute_for_s: number;
  seconds: number;
  /** False when the source played nothing on the mic side. Absent in older schedules: true. */
  mic?: boolean;
}

interface Chirp {
  ch: "mic" | "call";
  k: number;
  host_ns: number;
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i];
    const v = a[i + 1];
    if (!k?.startsWith("--") || v === undefined) throw new Error(`bad argument ${k}`);
    out[k.slice(2)] = v;
  }
  return out;
}

function jsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l) as T);
}

/** The chirp the source plays on a side (the same formula as drift-signal.rs), at `rate`. */
function chirpTemplate(ch: "mic" | "call", rate: number): Float64Array {
  const [f0, f1] = ch === "mic" ? [3000, 4500] : [1500, 2500];
  const n = Math.round(CHIRP_S * rate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * CHIRP_S));
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = Math.sin(phase) * w;
  }
  return out;
}

/**
 * One channel of an Opus file as 16-bit 48 kHz mono. ffmpeg writes a temporary file: an hour does
 * not fit Bun's stream buffer.
 */
async function decode(file: string, channel: 0 | 1): Promise<Int16Array> {
  const dir = mkdtempSync(join(tmpdir(), "akou-drift-"));
  const raw = join(dir, `ch${channel}.raw`);
  try {
    const p = Bun.spawn(
      ["ffmpeg", "-v", "error", "-i", file, "-af", `pan=mono|c0=c${channel}`].concat([
        "-ar",
        String(RATE),
        "-f",
        "s16le",
        raw,
      ]),
      { stdout: "inherit", stderr: "inherit" },
    );
    if ((await p.exited) !== 0) throw new Error(`ffmpeg failed on ${file}`);
    const b = readFileSync(raw);
    return new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function decimate(x: Int16Array, from: number, to: number): Float64Array {
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  const out = new Float64Array(Math.max(0, Math.floor((b - a) / DECIM)));
  for (let i = 0; i < out.length; i++) out[i] = x[a + i * DECIM] ?? 0;
  return out;
}

/** Normalized correlation of `t` against `x` at offset `o`. */
function ncc(x: ArrayLike<number>, o: number, t: Float64Array, tNorm: number): number {
  let dot = 0;
  let e = 0;
  for (let j = 0; j < t.length; j++) {
    const v = x[o + j] ?? 0;
    dot += v * (t[j] ?? 0);
    e += v * v;
  }
  return e > 0 ? dot / (Math.sqrt(e) * tNorm) : 0;
}

function norm(t: Float64Array): number {
  let s = 0;
  for (const v of t) s += v * v;
  return Math.sqrt(s);
}

interface Found {
  /** Seconds in the file. */
  at: number;
  score: number;
  /** How it was found: the waveform correlation, or the band-energy envelope when that failed. */
  method: "waveform" | "envelope";
}

/** RBJ band-pass biquad over the side's chirp band (0 dB at the centre), run forward once. */
function bandpass(x: ArrayLike<number>, from: number, to: number, ch: "mic" | "call"): Float64Array {
  const [f0, f1] = ch === "mic" ? [3000, 4500] : [1500, 2500];
  const fc = Math.sqrt(f0 * f1);
  const q = fc / (f1 - f0);
  const w0 = (2 * Math.PI * fc) / RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;
  const out = new Float64Array(Math.max(0, to - from));
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < out.length; i++) {
    const v = x[from + i] ?? 0;
    const y = (alpha * v - alpha * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** Mean energy in a sliding ENV_WIN window, one value per ENV_HOP samples. */
function envelope(x: Float64Array): Float64Array {
  const n = Math.max(0, Math.floor((x.length - ENV_WIN) / ENV_HOP));
  const out = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < ENV_WIN && i < x.length; i++) s += (x[i] ?? 0) ** 2;
  for (let k = 0; k < n; k++) {
    out[k] = s / ENV_WIN;
    const left = k * ENV_HOP;
    for (let j = 0; j < ENV_HOP; j++) s += (x[left + ENV_WIN + j] ?? 0) ** 2 - (x[left + j] ?? 0) ** 2;
  }
  return out;
}

/** Pearson correlation of `t` (mean `tMean`, centred norm `tNorm`) against `x` at offset `o`. */
function pearson(x: Float64Array, o: number, t: Float64Array, tMean: number, tNorm: number): number {
  let m = 0;
  for (let j = 0; j < t.length; j++) m += x[o + j] ?? 0;
  m /= t.length;
  let dot = 0;
  let e = 0;
  for (let j = 0; j < t.length; j++) {
    const v = (x[o + j] ?? 0) - m;
    dot += v * ((t[j] ?? 0) - tMean);
    e += v * v;
  }
  return e > 0 && tNorm > 0 ? dot / (Math.sqrt(e) * tNorm) : 0;
}

function median(x: Float64Array): number {
  const s = Float64Array.from(x).sort();
  return s.length ? (s[s.length >> 1] ?? 0) : 0;
}

/**
 * Finds a chirp near `expect` seconds by its band energy, phase-blind: the signal and the template
 * go through the same band-pass filter (so its delay cancels), then the 2.5 ms energy envelopes
 * are compared by Pearson correlation. A flat floor correlates near 0 with the template's bell, so
 * silence or noise is not found; a burst in the band at the right time is.
 */
function envelopeChirp(x: Int16Array, ch: "mic" | "call", expect: number): Found | null {
  const t = chirpTemplate(ch, RATE);
  const padded = new Float64Array(t.length + 2 * ENV_PAD);
  padded.set(t, ENV_PAD);
  const ref = envelope(bandpass(padded, 0, padded.length, ch));
  let tMean = 0;
  for (const v of ref) tMean += v;
  tMean /= ref.length;
  let tNorm = 0;
  for (const v of ref) tNorm += (v - tMean) ** 2;
  tNorm = Math.sqrt(tNorm);
  const from = Math.max(0, Math.round((expect - SEARCH_S) * RATE) - ENV_PAD);
  const to = Math.min(x.length, Math.round((expect + SEARCH_S + CHIRP_S) * RATE) + ENV_PAD);
  const env = envelope(bandpass(x, from, to, ch));
  const scores = new Float64Array(Math.max(0, env.length - ref.length + 1));
  let best = -1;
  let bestAt = 0;
  for (let o = 0; o < scores.length; o++) {
    const s = pearson(env, o, ref, tMean, tNorm);
    scores[o] = s;
    if (s > best) {
      best = s;
      bestAt = o;
    }
  }
  if (best < MIN_ENVELOPE_SCORE) return null;
  // The burst itself against the window's floor, in the band.
  const burstFrom = bestAt + Math.floor(ENV_PAD / ENV_HOP);
  const burstLen = Math.floor(t.length / ENV_HOP);
  let burst = 0;
  for (let j = 0; j < burstLen; j++) burst += env[burstFrom + j] ?? 0;
  burst /= burstLen;
  const floor = median(env);
  const snrDb = 10 * Math.log10(burst / Math.max(floor, 1e-9));
  if (!(snrDb >= MIN_ENVELOPE_SNR_DB)) return null;
  const l = scores[bestAt - 1] ?? best;
  const r = scores[bestAt + 1] ?? best;
  const den = l - 2 * best + r;
  const frac = den !== 0 ? (0.5 * (l - r)) / den : 0;
  return { at: (from + (bestAt + frac) * ENV_HOP + ENV_PAD) / RATE, score: best, method: "envelope" };
}

/** Finds a chirp near `expect` seconds. */
function findChirp(x: Int16Array, ch: "mic" | "call", expect: number): Found | null {
  const tFine = chirpTemplate(ch, RATE);
  const tCoarse = chirpTemplate(ch, RATE / DECIM);
  const from = Math.round((expect - SEARCH_S) * RATE);
  const to = Math.round((expect + SEARCH_S + CHIRP_S) * RATE);
  const d = decimate(x, from, to);
  const cn = norm(tCoarse);
  let best = -1;
  let bestAt = 0;
  for (let o = 0; o + tCoarse.length <= d.length; o++) {
    const s = ncc(d, o, tCoarse, cn);
    if (s > best) {
      best = s;
      bestAt = o;
    }
  }
  if (best < MIN_SCORE * 0.8) return envelopeChirp(x, ch, expect);
  const coarse = Math.max(0, from) + bestAt * DECIM;
  const fn = norm(tFine);
  const scores = new Map<number, number>();
  let fBest = -1;
  let fAt = coarse;
  for (let o = coarse - 2 * DECIM; o <= coarse + 2 * DECIM; o++) {
    const s = ncc(x, o, tFine, fn);
    scores.set(o, s);
    if (s > fBest) {
      fBest = s;
      fAt = o;
    }
  }
  if (fBest < MIN_SCORE) return envelopeChirp(x, ch, expect);
  // Parabolic interpolation of the peak, for a sub-sample position.
  const l = scores.get(fAt - 1) ?? ncc(x, fAt - 1, tFine, fn);
  const r = scores.get(fAt + 1) ?? ncc(x, fAt + 1, tFine, fn);
  const den = l - 2 * fBest + r;
  const frac = den !== 0 ? (0.5 * (l - r)) / den : 0;
  return { at: (fAt + frac) / RATE, score: fBest, method: "waveform" };
}

interface Gap {
  at: number;
  ms: number;
}

/** Runs of near-zero samples inside `[from, to)` seconds, longest first. */
function gaps(x: Int16Array, spans: Array<[number, number]>, minMs: number): Gap[] {
  const out: Gap[] = [];
  for (const [a, b] of spans) {
    const end = Math.min(x.length, Math.round(b * RATE));
    let run = 0;
    for (let i = Math.max(0, Math.round(a * RATE)); i < end; i++) {
      if (Math.abs(x[i] ?? 0) <= ZERO) run++;
      else {
        if ((run / RATE) * 1000 >= minMs)
          out.push({ at: (i - run) / RATE, ms: (run / RATE) * 1000 });
        run = 0;
      }
    }
    if ((run / RATE) * 1000 >= minMs) out.push({ at: (end - run) / RATE, ms: (run / RATE) * 1000 });
  }
  return out.sort((p, q) => q.ms - p.ms);
}

function rmsDb(x: Int16Array, a: number, b: number): number {
  let s = 0;
  let n = 0;
  for (
    let i = Math.max(0, Math.round(a * RATE));
    i < Math.min(x.length, Math.round(b * RATE));
    i++
  ) {
    const v = (x[i] ?? 0) / 32768;
    s += v * v;
    n++;
  }
  return n > 0 && s > 0 ? 10 * Math.log10(s / n) : -Infinity;
}

function peakDb(x: Int16Array, a: number, b: number): number {
  let m = 0;
  for (
    let i = Math.max(0, Math.round(a * RATE));
    i < Math.min(x.length, Math.round(b * RATE));
    i++
  ) {
    const v = Math.abs(x[i] ?? 0);
    if (v > m) m = v;
  }
  return m > 0 ? 20 * Math.log10(m / 32768) : -Infinity;
}

/** Least-squares line through (x, y); slope per unit of x. */
function fit(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n < 2) return { slope: Number.NaN, intercept: Number.NaN };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
    sxx += ((xs[i] ?? 0) - mx) ** 2;
  }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

function stats(v: number[]) {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? Number.NaN;
  return {
    n: v.length,
    min: s[0],
    median: q(0.5),
    max: s[s.length - 1],
    spread: (s[s.length - 1] ?? 0) - (s[0] ?? 0),
  };
}

const round = (v: number, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

async function main(): Promise<void> {
  const a = args();
  const folder = a.folder;
  const signalPath = a.signal;
  if (!folder || !signalPath) throw new Error("--folder and --signal are required");

  const sig = jsonl<Record<string, unknown>>(signalPath);
  const start = sig.find((e) => e.ev === "start") as unknown as SignalStart;
  const chirps = sig.filter((e) => e.ev === "chirp") as unknown as Chirp[];
  const clips = sig.filter((e) => e.ev === "clip") as unknown as Array<{ host_ns: number }>;
  const sigEnd = sig.find((e) => e.ev === "call.end")?.host_ns as number | undefined;

  const events = jsonl<Record<string, unknown>>(join(folder, "events.jsonl"));
  const parts = events.filter((e) => e.type === "part.started");
  const ended = events.filter((e) => e.type === "part.ended");
  if (parts.length !== 1) {
    console.error(`note: ${parts.length} parts; analysing part 1 only`);
  }
  const part = parts[0];
  if (!part) throw new Error("no part.started in the log");
  const partEnd = ended.find((e) => e.part === part.part);
  const file = a.file ?? join(folder, part.file as string);
  // The host time of file position 0 (DESIGN 2.4 `capturing.capture_ns`), in ns.
  const captureNs = Math.round((part.monoStart as number) * 1e6);
  const expectAt = (hostNs: number) => (hostNs - captureNs) / 1e9;

  const capLog = readdirSync(join(folder, "logs"))
    .filter((f) => f.startsWith("capture-"))
    .flatMap((f) => readFileSync(join(folder, "logs", f), "utf8").split("\n"))
    .filter((l) => l.startsWith("{") && !l.includes('"type":"level"'));

  const result: Record<string, unknown> = {
    parts: parts.length,
    partEnded: partEnd ? { reason: partEnd.reason, fileSeconds: partEnd.fileSeconds } : null,
    wallSeconds: partEnd
      ? round(((partEnd.t as number) - (part.wallStart as number)) / 1000, 3)
      : null,
    helperMessages: capLog.map((l) => JSON.parse(l)),
  };
  if (partEnd) {
    result.fileMinusWallMs = round(
      ((partEnd.fileSeconds as number) -
        ((partEnd.t as number) - (part.wallStart as number)) / 1000) *
        1000,
      1,
    );
  }

  const micPlayed = start.mic !== false;
  // When the call side played, in file seconds: from each clip (its first sample) to the next
  // pause or the end of the source.
  const callSpans: Array<[number, number]> = [];
  {
    const marks = sig
      .filter((e) => e.ev === "clip" || e.ev === "call.pause" || e.ev === "call.end")
      .map((e) => ({ ev: e.ev as string, at: expectAt(e.host_ns as number) }))
      .sort((p, q) => p.at - q.at);
    let from: number | null = null;
    for (const m of marks) {
      // 20 ms after the clip's host time, past the output latency (about 8 ms here), so the scan
      // starts where the first sample can already be in the recording.
      if (m.ev === "clip") from = m.at + 0.02;
      else if (from !== null) {
        callSpans.push([from, m.at]);
        from = null;
      }
    }
  }
  // When nothing played at all (no mic side): before the first clip and inside each pause, with
  // half a second of margin at both ends.
  const quiet: Array<[number, number]> = [];
  if (!micPlayed) {
    let prev = 0;
    for (const [p, q] of callSpans) {
      if (p - prev > 1.5) quiet.push([prev + 0.5, p - 0.5]);
      prev = q;
    }
  }

  // Latency of each chirp against its host time, per side and per channel it was found in.
  const latency: Record<
    string,
    Array<{ k: number; t: number; ms: number; score: number; method: Found["method"] }>
  > = {};
  const levels: Record<string, number> = {};
  for (const [chan, name] of [
    [0, "left"],
    [1, "right"],
  ] as const) {
    const x = await decode(file, chan);
    levels[`${name}_rms_dbfs`] = round(rmsDb(x, 0, x.length / RATE), 1);
    levels[`${name}_peak_dbfs`] = round(peakDb(x, 0, x.length / RATE), 1);
    result[`${name}Seconds`] = round(x.length / RATE, 3);
    for (const side of ["mic", "call"] as const) {
      const key = `${side}@${name}`;
      latency[key] = [];
      for (const c of chirps.filter((c) => c.ch === side)) {
        const e = expectAt(c.host_ns);
        if (e < SEARCH_S || e > x.length / RATE - SEARCH_S) continue;
        const f = findChirp(x, side, e);
        if (f) {
          latency[key]?.push({ k: c.k, t: e, ms: (f.at - e) * 1000, score: f.score, method: f.method });
        }
      }
    }
    // Gaps. With a mic side, from the first second to the end of the source: the mic pilot plays
    // throughout and the global tap hears it too, so neither channel should be near zero in that
    // span. Without one, only the call channel while the call side played (from each clip start,
    // its first sample, to the pause or the end), and the mic channel is not scanned.
    const endS = sigEnd ? Math.min(expectAt(sigEnd), x.length / RATE) : x.length / RATE;
    // The mic side's first buffer, when the source started after the recording did.
    const micFirst = sig.find((e) => e.ev === "first_callback" && e.ch === "mic");
    const scanFrom = Math.max(1, micFirst ? expectAt(micFirst.host_ns as number) + 0.1 : 1);
    const spans: Array<[number, number]> = micPlayed
      ? [[scanFrom, endS - 0.5]]
      : name === "right"
        ? callSpans.map(([p, q]): [number, number] => [p, Math.min(q, endS) - 0.5])
        : [];
    const g = gaps(x, spans, 5);
    result[`${name}Gaps`] = {
      scannedSeconds: round(
        spans.reduce((t, [p, q]) => t + Math.max(0, q - p), 0),
        1,
      ),
      over5ms: g.length,
      over20ms: g.filter((q) => q.ms > 20).length,
      longestMs: round(g[0]?.ms ?? 0, 1),
      worst: g.slice(0, 10).map((q) => ({ at: round(q.at, 3), ms: round(q.ms, 1) })),
    };
    if (name === "right" && quiet.length > 0) {
      result.quietWindows = quiet.map(([p, q]) => ({
        from: round(p, 1),
        to: round(q, 1),
        callRmsDbfs: round(rmsDb(x, p, q), 1),
        callPeakDbfs: round(peakDb(x, p, q), 1),
      }));
    }
    // First words after each silence: the clip against the recording, 20 ms steps from its start.
    if (name === "right" && a.clip) {
      const raw = readFileSync(a.clip);
      const clip = new Float64Array(raw.length / 4);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < clip.length; i++) clip[i] = dv.getFloat32(i * 4, true);
      const callLat = stats((latency["call@right"] ?? []).map((q) => q.ms))?.median ?? 0;
      result.firstWords = clips.map((c) => {
        const expected = Math.round((expectAt(c.host_ns) + callLat / 1000) * RATE);
        const step = Math.round(0.02 * RATE);
        const slices = Math.floor(Math.min(clip.length, RATE) / step);
        // Speech starts at the first 20 ms slice within 20 dB of the loudest in the first second.
        const e = Array.from({ length: slices }, (_, s) =>
          norm(clip.subarray(s * step, (s + 1) * step)),
        );
        const loud = Math.max(...e);
        const onset = e.findIndex((v) => v >= loud / 10);
        // One lag for the whole clip start: the best match of its first 500 ms of speech, within
        // 50 ms of where the chirps say it should be.
        const head = clip.subarray(onset * step, onset * step + Math.round(0.5 * RATE));
        const hn = norm(head);
        let lag = 0;
        let lagScore = -1;
        for (let d = -Math.round(0.05 * RATE); d <= Math.round(0.05 * RATE); d++) {
          const s = ncc(x, expected + onset * step + d, head, hn);
          if (s > lagScore) {
            lagScore = s;
            lag = d;
          }
        }
        // Then each 20 ms slice from the speech onset, at that lag.
        const scores: number[] = [];
        let firstMatch = -1;
        for (let s = onset; s < Math.min(slices, onset + 15); s++) {
          const t = clip.subarray(s * step, (s + 1) * step);
          const v = ncc(x, expected + s * step + lag, t, norm(t));
          scores.push(round(v, 2));
          if (firstMatch < 0 && v >= 0.8) firstMatch = s;
        }
        return {
          at: round(expected / RATE, 3),
          speechOnsetMs: onset * 20,
          lagMs: round((lag / RATE) * 1000, 2),
          headScore: round(lagScore, 3),
          lostMs: firstMatch < 0 ? null : (firstMatch - onset) * 20,
          scoresPer20msFromOnset: scores,
        };
      });
    }
  }
  result.levels = levels;

  const summary: Record<string, unknown> = {};
  for (const [key, rows] of Object.entries(latency)) {
    if (rows.length === 0) {
      summary[key] = { found: 0 };
      continue;
    }
    // Timing comes from the waveform matches: an envelope match sits a few ms off the waveform's
    // position (the codec smears the burst's onset), so it counts as found but does not enter the
    // latency, the slope or the first and last rows unless no waveform match exists at all.
    const wave = rows.filter((r) => r.method === "waveform");
    const env = rows.filter((r) => r.method === "envelope");
    const timed = wave.length > 0 ? wave : env;
    const f = fit(
      timed.map((r) => r.t),
      timed.map((r) => r.ms),
    );
    const row = (r: (typeof rows)[number]) => ({ k: r.k, t: round(r.t, 2), ms: round(r.ms, 3) });
    summary[key] = {
      found: rows.length,
      expected: chirps.filter((c) => c.ch === key.split("@")[0]).length,
      missing: chirps
        .filter((c) => c.ch === key.split("@")[0] && !rows.some((r) => r.k === c.k))
        .map((c) => ({ k: c.k, at: round(expectAt(c.host_ns), 1) })),
      timingFrom: wave.length > 0 ? "waveform" : "envelope",
      timed: timed.length,
      latencyMs: stats(timed.map((r) => round(r.ms, 3))),
      slopeMsPerHour: round(f.slope * 3600, 2),
      minScore: wave.length > 0 ? round(Math.min(...wave.map((r) => r.score)), 3) : null,
      byEnvelope: env.length,
      minEnvelopeScore: env.length > 0 ? round(Math.min(...env.map((r) => r.score)), 3) : null,
      envelopeLatencyMs: env.length > 0 ? stats(env.map((r) => round(r.ms, 3))) : null,
      // The first and last few, so a step at a start or a rebuild is visible, not only the fit.
      firstRows: timed.slice(0, 4).map(row),
      lastRows: timed.slice(-2).map(row),
    };
  }
  result.chirps = summary;

  // Left-right offset: the call chirp against the mic chirp of the same period.
  // Pairs use waveform matches on both sides. With fewer than two of those, every match pairs
  // (`pairsFrom: "mixed"`), and an envelope match's few-ms bias is then inside the offset.
  const pairFrom = (keep: (r: { method: Found["method"] }) => boolean) => {
    const out: Array<{ t: number; ms: number }> = [];
    const mic = new Map((latency["mic@left"] ?? []).filter(keep).map((r) => [r.k, r]));
    for (const c of (latency["call@right"] ?? []).filter(keep)) {
      const m = mic.get(c.k);
      if (m) out.push({ t: c.t, ms: c.ms - m.ms });
    }
    return out;
  };
  const wavePairs = pairFrom((r) => r.method === "waveform");
  const pairsFrom = wavePairs.length > 1 ? "waveform" : "mixed";
  const lr = pairsFrom === "waveform" ? wavePairs : pairFrom(() => true);
  result.leftRight =
    lr.length > 1
      ? {
          pairs: lr.length,
          pairsFrom,
          offsetMs: stats(lr.map((r) => round(r.ms, 3))),
          slopeMsPerHour: round(
            fit(
              lr.map((r) => r.t),
              lr.map((r) => r.ms),
            ).slope * 3600,
            2,
          ),
        }
      : { pairs: lr.length, note: "no mic chirps on the left channel to pair with" };

  // Both trains as the tap heard them (the global tap also hears the source's mic-side output).
  const tapPairs: number[] = [];
  const tapT: number[] = [];
  const micTap = new Map((latency["mic@right"] ?? []).map((r) => [r.k, r]));
  for (const c of latency["call@right"] ?? []) {
    const m = micTap.get(c.k);
    if (m) {
      tapPairs.push(c.ms - m.ms);
      tapT.push(c.t);
    }
  }
  if (tapPairs.length > 1) {
    result.bothTrainsInTap = {
      pairs: tapPairs.length,
      offsetMs: stats(tapPairs.map((v) => round(v, 3))),
      slopeMsPerHour: round(fit(tapT, tapPairs).slope * 3600, 2),
    };
  }

  // Memory.
  if (a.memory) {
    const rows = readFileSync(a.memory, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(",").map(Number))
      .filter((r) => Number.isFinite(r[2]) && (r[2] ?? 0) > 0);
    const wall0 = (part.wallStart as number) / 1000;
    const tOf = (r: number[]) => (r[0] ?? 0) - wall0;
    const muteFrom = start.mute_at_s > 0 ? start.mute_at_s : -1;
    const muteTo = muteFrom + start.mute_for_s;
    // Seconds of the source's schedule, relative to t0, approximated as file seconds.
    const t0File = expectAt(start.t0_ns);
    const inMute = rows.filter(
      (r) => muteFrom > 0 && tOf(r) >= t0File + muteFrom && tOf(r) <= t0File + muteTo,
    );
    const mem = (rs: number[][], i: number) => {
      const v = rs.map((r) => r[i] ?? 0);
      const f = fit(rs.map(tOf), v);
      return {
        samples: v.length,
        firstKb: v[0],
        lastKb: v[v.length - 1],
        minKb: Math.min(...v),
        maxKb: Math.max(...v),
        slopeKbPerHour: round(f.slope * 3600, 0),
      };
    };
    result.memory = {
      helper: mem(rows, 2),
      helperMuted: inMute.length > 1 ? mem(inMute, 2) : null,
      app: mem(rows, 1),
      appMuted: inMute.length > 1 ? mem(inMute, 1) : null,
    };
  }

  const text = JSON.stringify(result, null, 2);
  if (a.out) writeFileSync(a.out, `${text}\n`);
  console.log(text);
}

await main();
