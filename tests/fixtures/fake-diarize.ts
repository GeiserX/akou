/**
 * A fake `akou-diarize` for tests: it speaks `akou-diarize/1` (src/main/asr/nemotron.ts, the Rust
 * helper's lib.rs) with no model. A "speaker" is a loudness band: 10 ms frames with an RMS over
 * 0.2 are speaker 1, over 0.02 speaker 0. Live mode decides in steps of `--step` seconds once the
 * look-ahead has arrived, as the real helper does; final mode decides everything at a flush.
 *
 *   bun tests/fixtures/fake-diarize.ts run --model FILE --mode live|final [--threads N]
 *     [--step S] [--look S] [--die-after S] [--garbage] [--no-ready] [--protocol P] [--hang]
 *
 * `--die-after S` exits 70 once S seconds of audio have arrived; `--garbage` writes a line that is
 * not the protocol after the first audio; `--no-ready` never says ready; `--protocol P` says ready
 * in protocol P; `--hang` never answers a flush. A model path that does not exist exits 66 with an
 * error line, as the real helper does.
 */

import { existsSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const RATE = 16000;
const mode = opt("--mode");
const model = opt("--model") ?? "";
const step = Math.round(Number(opt("--step") ?? 1.68) * RATE);
const look = Math.round(Number(opt("--look") ?? 0.32) * RATE);
const dieAfter = opt("--die-after") ? Number(opt("--die-after")) * RATE : Number.POSITIVE_INFINITY;

const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (!argv.includes("run") || (mode !== "live" && mode !== "final")) {
  process.stderr.write("usage: fake-diarize run --model FILE --mode live|final\n");
  process.exit(64);
}
if (!existsSync(model)) {
  out({ type: "error", message: `cannot load ${model}: no such file` });
  process.stderr.write(`akou-diarize: cannot load ${model}: no such file\n`);
  process.exit(66);
}
if (!argv.includes("--no-ready"))
  out({
    type: "ready",
    protocol: opt("--protocol") ?? "akou-diarize/1",
    version: "0.0.0-fake",
    mode,
    latency: 2,
  });

let held = new Float32Array(0);
let heldStart = 0;
let pos = 0;
let decided = 0;
let garbled = false;

function append(x: Float32Array): void {
  const next = new Float32Array(held.length + x.length);
  next.set(held);
  next.set(x, held.length);
  held = next;
  pos += x.length;
}

/** Turns over `[decided, to)` by loudness band, then drops the audio before `to`. */
function decide(to: number): void {
  const frame = RATE / 100;
  let cur: { spk: number; start: number } | null = null;
  const end = (at: number) => {
    if (cur) out({ type: "turn", spk: cur.spk, start: cur.start, end: at });
    cur = null;
  };
  for (let at = decided; at < to; at += frame) {
    const a = at - heldStart;
    const b = Math.min(to, at + frame) - heldStart;
    let s = 0;
    for (let i = a; i < b; i++) s += (held[i] as number) ** 2;
    const rms = Math.sqrt(s / Math.max(1, b - a));
    const spk = rms > 0.2 ? 1 : rms > 0.02 ? 0 : -1;
    if (cur && cur.spk !== spk) end(at);
    if (spk >= 0 && !cur) cur = { spk, start: at };
  }
  end(to);
  held = held.slice(to - heldStart);
  heldStart = to;
  decided = to;
}

let buf = new Uint8Array(0);
for await (const chunk of Bun.stdin.stream()) {
  const next = new Uint8Array(buf.length + chunk.length);
  next.set(buf);
  next.set(chunk, buf.length);
  buf = next;
  for (;;) {
    if (buf.length < 5) break;
    const len = new DataView(buf.buffer, buf.byteOffset + 1, 4).getUint32(0, true);
    if (buf.length < 5 + len) break;
    const kind = String.fromCharCode(buf[0] as number);
    const payload = buf.slice(5, 5 + len);
    buf = buf.slice(5 + len);
    if (kind === "a") {
      const v = new DataView(payload.buffer);
      const x = new Float32Array(len / 4);
      for (let i = 0; i < x.length; i++) x[i] = v.getFloat32(i * 4, true);
      append(x);
      if (pos > dieAfter) {
        process.stderr.write("fake-diarize: simulated crash\n");
        process.exit(70);
      }
      if (argv.includes("--garbage") && !garbled) {
        garbled = true;
        process.stdout.write("this is not akou-diarize/1\n");
      }
      if (mode === "live") {
        let ran = false;
        while (pos - decided >= step + look) {
          decide(decided + step);
          ran = true;
        }
        if (ran) out({ type: "decided", at: decided });
      }
    } else if (kind === "f") {
      if (argv.includes("--hang")) continue;
      decide(pos);
      out({ type: "flushed", at: decided });
      if (mode === "final") {
        held = new Float32Array(0);
        heldStart = pos = decided = 0;
      }
    } else if (kind === "r") {
      held = new Float32Array(0);
      heldStart = pos = decided = 0;
      out({ type: "reset" });
    } else {
      out({ type: "error", message: `unknown frame kind ${kind}` });
      process.exit(74);
    }
  }
}
process.exit(0);
