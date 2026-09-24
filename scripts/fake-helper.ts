#!/usr/bin/env bun
/**
 * A fake capture helper for tests. It speaks `akou-capture/1` (docs/DESIGN.md section 2.4) and
 * replays a stereo WAV (left = mic, right = call) or a generated speech-like signal as packets,
 * paced in real time or faster. It opens no audio device and plays nothing.
 *
 *   bun scripts/fake-helper.ts run --out FILE --mic default --call system [switches]
 *
 * Switches that simulate the capture traps (docs/TRAPS.md):
 *
 *   --wav FILE                 source audio (16-bit stereo WAV at 16 kHz); default: generated
 *   --speed X                  1 = real time (default); 10 = ten times faster
 *   --packet-ms N              packet length, default 20
 *   --capturing-delay MS       a slow (cold) open before `capturing`
 *   --exit-before-capturing N  exit with code N before `capturing` (77 = permission)
 *   --call-silent              the call side is silent from the start: zero-filled call packets,
 *                              output device not running
 *   --call-omit                call packets are never sent at all (a helper without an aligner)
 *   --call-dead-at S           the call tap stops delivering at S seconds while output keeps
 *                              running (zero-filled packets); the dead-call monitor rebuilds it
 *                              after 1 s
 *   --call-zeros-at S          the call side delivers buffers of zeros from S seconds while output
 *                              keeps running; the dead-call monitor waits 10 s, then rebuilds
 *   --rebuild-heals            a `rebuild_call` brings a dead call side back
 *   --hang-on-stop             `stop` and closing stdin are ignored: a hung teardown
 *   --crash-at S               exit 70 at S seconds, without `stopped`
 *   --stall-at S               stop sending packets at S seconds, stay alive
 *   --sleep-at S --sleep-for S the host clock jumps by the given seconds (machine sleep)
 *   --dialect stereo-s16le     behave like hark instead: raw 16-bit stereo on stdout, no JSON,
 *                              stop on SIGINT; `--duration S` ends at S seconds of audio
 *
 * Times are seconds of audio (the file timeline), so a test at `--speed 20` is deterministic.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { DeadCallMonitor } from "../src/main/capture/health.ts";
import { CAPTURE_RATE, EXIT, encodePacket, type Packet } from "../src/main/capture/protocol.ts";
import { readStereoWav, speechLike } from "../tests/fixtures/audio.ts";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (name: string): number | undefined => {
  const v = opt(name);
  return v === undefined ? undefined : Number(v);
};

const dialect = opt("--dialect") ?? "akou-capture/1";
const speed = num("--speed") ?? 1;
const packetMs = num("--packet-ms") ?? 20;
const frames = Math.round((CAPTURE_RATE * packetMs) / 1000);
const out = opt("--out");
const micMode = opt("--mic") ?? "default";
const callMode = opt("--call") ?? "system";

const src = (() => {
  const wav = opt("--wav");
  if (wav) {
    const s = readStereoWav(new Uint8Array(readFileSync(wav)));
    if (s.rate !== CAPTURE_RATE) throw new Error(`fake helper needs a ${CAPTURE_RATE} Hz WAV`);
    return { mic: s.left, call: s.right };
  }
  return { mic: speechLike(30, { f0: 120, seed: 7 }), call: speechLike(30, { f0: 210, seed: 11 }) };
})();

function slice(x: Float32Array, start: number, n: number): Float32Array {
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) r[i] = x[(start + i) % x.length] as number;
  return r;
}

const stdout = Bun.stdout.writer();
const say = (o: Record<string, unknown>) => process.stderr.write(`${JSON.stringify(o)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const hostNs = () => process.hrtime.bigint();

let stopRequested = false;
let paused = false;
let callHealed = false;
let frame = 0; // file timeline, in frames

function finish(reason: string): never {
  if (dialect === "akou-capture/1")
    say({ type: "stopped", file_seconds: frame / CAPTURE_RATE, reason });
  stdout.flush();
  process.exit(EXIT.ok);
}

function onStop(): void {
  if (flag("--hang-on-stop")) {
    // A teardown that never returns: no more audio, no exit.
    stopRequested = true;
    setInterval(() => {}, 1 << 30);
    return;
  }
  stopRequested = true;
}

async function readStdin(): Promise<void> {
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of Bun.stdin.stream()) {
    rest += dec.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines.map((l) => l.trim())) {
      if (line === "stop") onStop();
      else if (line === "pause") paused = true;
      else if (line === "resume") paused = false;
      else if (line === "rebuild_call" && flag("--rebuild-heals")) callHealed = true;
    }
  }
  // Closing stdin means stop.
  onStop();
}

async function runHark(): Promise<void> {
  process.on("SIGINT", () => {
    stopRequested = true;
  });
  const duration = num("--duration");
  const t0 = performance.now();
  while (!stopRequested) {
    if (duration !== undefined && frame >= duration * CAPTURE_RATE) break;
    const n =
      duration !== undefined
        ? Math.min(frames, Math.round(duration * CAPTURE_RATE) - frame)
        : frames;
    const mic = slice(src.mic, frame, n);
    const call = slice(src.call, frame, n);
    const bytes = new Uint8Array(n * 4);
    const v = new DataView(bytes.buffer);
    const s16 = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    for (let i = 0; i < n; i++) {
      v.setInt16(i * 4, s16(mic[i] as number), true);
      v.setInt16(i * 4 + 2, s16(call[i] as number), true);
    }
    stdout.write(bytes);
    stdout.flush();
    frame += n;
    if (speed > 0) await sleep(t0 + ((frame / CAPTURE_RATE) * 1000) / speed - performance.now());
  }
  stdout.flush();
  process.exit(EXIT.ok);
}

async function runAkou(): Promise<void> {
  void readStdin();
  say({ type: "hello", protocol: "akou-capture/1", version: "0.0.0-fake", caps: ["fake"] });
  const delay = num("--capturing-delay");
  if (delay) {
    // A slow open that a stop cancels, as the real helper's open is abandoned on stop.
    const end = performance.now() + delay;
    while (performance.now() < end && !stopRequested) await sleep(10);
  }
  const exitCode = num("--exit-before-capturing");
  if (exitCode !== undefined) {
    say({
      type: "warn",
      code: exitCode === EXIT.permission ? "permission" : "open",
      msg: "fake open failure",
    });
    process.exit(exitCode);
  }
  if (stopRequested && !flag("--hang-on-stop")) finish("stop");
  if (out) writeFileSync(out, "");
  const anchor = hostNs();
  say({
    type: "capturing",
    mic: micMode === "none" ? null : { id: micMode, name: "Fake Microphone", rate: 48000 },
    call: callMode === "none" ? null : { mode: callMode, rate: 48000 },
    exclude: ["akou Graphics and Media"],
    capture_ns: anchor.toString(),
  });

  const callSilent = flag("--call-silent");
  const callOmit = flag("--call-omit");
  const deadAt = num("--call-dead-at");
  const zerosAt = num("--call-zeros-at");
  const crashAt = num("--crash-at");
  const stallAt = num("--stall-at");
  const sleepAt = num("--sleep-at");
  const sleepFor = num("--sleep-for") ?? 0;
  const monitor = new DeadCallMonitor(0);
  const first = { mic: false, call: false };
  let hostOffset = 0n; // paused and slept time on the host clock, beyond the file timeline
  let slept = false;
  let sinceLevel = 0;
  const t0 = performance.now();
  let wallAudio = 0; // seconds of timeline paced so far, pause included

  while (true) {
    if (stopRequested) {
      if (flag("--hang-on-stop")) {
        await sleep(1000);
        continue;
      }
      finish("stop");
    }
    const t = frame / CAPTURE_RATE;
    const step = frames / CAPTURE_RATE;
    wallAudio += step;
    if (speed > 0) await sleep(t0 + (wallAudio * 1000) / speed - performance.now());
    if (paused) {
      hostOffset += BigInt(Math.round(step * 1e9));
      continue;
    }
    if (crashAt !== undefined && t >= crashAt) process.exit(EXIT.software);
    if (stallAt !== undefined && t >= stallAt) {
      hostOffset += BigInt(Math.round(step * 1e9));
      continue;
    }
    if (sleepAt !== undefined && !slept && t >= sleepAt) {
      slept = true;
      hostOffset += BigInt(Math.round(sleepFor * 1e9));
    }
    const captureNs = anchor + BigInt(Math.round(t * 1e9)) + hostOffset;
    const packets: Packet[] = [];
    if (micMode !== "none") {
      packets.push({
        ch: "mic",
        zeroFilled: false,
        captureNs,
        fileSeconds: t,
        samples: slice(src.mic, frame, frames),
      });
    }
    const dead = deadAt !== undefined && t >= deadAt && !callHealed;
    const zeros = zerosAt !== undefined && t >= zerosAt && !callHealed;
    const callDelivered = callMode !== "none" && !callSilent && !dead;
    const callAudible = callDelivered && !zeros;
    if (callMode !== "none" && !callOmit) {
      packets.push({
        ch: "call",
        zeroFilled: !callDelivered,
        captureNs,
        fileSeconds: t,
        samples: callAudible ? slice(src.call, frame, frames) : new Float32Array(frames),
      });
    }
    for (const p of packets) {
      stdout.write(encodePacket(p));
      if (!p.zeroFilled && !first[p.ch]) {
        first[p.ch] = true;
        say({ type: "first_audio", ch: p.ch, capture_ns: captureNs.toString() });
      }
    }
    stdout.flush();
    if (deadAt !== undefined || zerosAt !== undefined) {
      const emit = (a: ReturnType<DeadCallMonitor["tick"]>[number]) => {
        if (a.kind !== "health") return;
        say({
          type: "health",
          ch: "call",
          state: a.state,
          silent_for: a.silentFor,
          rebuilds: a.rebuilds,
          detail: a.detail,
        });
      };
      const tick = {
        t,
        outputRunning: !callSilent,
        heard: callAudible,
        delivered: callDelivered,
      };
      for (const a of monitor.tick(tick)) {
        // The probe runs on the output, which is still playing, so it hears audio.
        if (a.kind === "probe") for (const r of monitor.probeResult(t, true)) emit(r);
        else emit(a);
      }
    }
    sinceLevel += step;
    if (sinceLevel >= 0.25) {
      sinceLevel = 0;
      say({ type: "level", mic_dbfs: -20, call_dbfs: callAudible ? -24 : -120 });
    }
    frame += frames;
  }
}

// Switches may come before `run` too, so a configured command prefix (`capture.helper`) can carry
// them: `bun fake-helper.ts --wav x.wav run --out ...`.
if (!argv.includes("run") && dialect === "akou-capture/1") {
  process.stderr.write("usage: fake-helper.ts run --out FILE --mic M --call C [switches]\n");
  process.exit(EXIT.usage);
}
await (dialect === "stereo-s16le" ? runHark() : runAkou());
