/**
 * The real capture helper against real audio devices (ROADMAP M3 and M4): it records the default
 * input and the call side while a player sends tone bursts, left channel of the stimulus into
 * the microphone and right channel into the output, and the recording must come back with the
 * mic tone on the left, the call tone on the right, and both bursts starting together.
 *
 * It opens devices, so it runs only where CI has set up virtual ones, and never on a laptop:
 *
 *   AKOU_CAPTURE_LIVE=1                 run it (otherwise skipped, and says so)
 *   AKOU_CAPTURE_BIN=<helper>           the helper to run
 *   AKOU_CAPTURE_LIVE_PLAY=<command>    plays the stimulus; gets STIM (the stereo WAV), STIM_MIC
 *                                       and STIM_CALL (each tone alone, on both channels) in its
 *                                       environment. Run by `sh -c`, or PowerShell on Windows
 *   AKOU_CAPTURE_LIVE_MIC=none          record the call side only (a runner with no input)
 *   AKOU_CAPTURE_LIVE_MAX_SKEW_MS=20    assert the skew bound (only a player that starts both
 *                                       channels on one clock can promise it)
 *   AKOU_CAPTURE_LIVE_EXCLUDE=1         also check that audio played by a process in the tree the
 *                                       helper is told to exclude never reaches the call side
 *
 * The measurements themselves are tested below on every run, against signals with a known answer.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_RATE, type Packet, PacketDecoder } from "../src/main/capture/protocol.ts";
import {
  BURST,
  bursts,
  CALL_HZ,
  channel,
  LEAD,
  MIC_HZ,
  measure,
  onsets,
  PERIOD,
} from "./capture-live.ts";
import { stereoWav } from "./fixtures/audio.ts";

const LIVE = process.env.AKOU_CAPTURE_LIVE === "1";
const BIN = process.env.AKOU_CAPTURE_BIN;
const PLAY = process.env.AKOU_CAPTURE_LIVE_PLAY;
const MIC = process.env.AKOU_CAPTURE_LIVE_MIC ?? "default";
const MAX_SKEW = process.env.AKOU_CAPTURE_LIVE_MAX_SKEW_MS;
const EXCLUDE = process.env.AKOU_CAPTURE_LIVE_EXCLUDE === "1";
/** A tone this many dB above the other one on its own channel is "that tone". */
const SEPARATION_DB = 20;

describe("the live-capture measurements", () => {
  const shifted = (x: Float32Array, by: number) => {
    const out = new Float32Array(x.length);
    out.set(x.subarray(0, x.length - by), by);
    return out;
  };

  test("finds every burst where the stimulus put it", () => {
    const got = onsets(bursts(MIC_HZ, CAPTURE_RATE));
    expect(got.length).toBe(5);
    got.forEach((t, i) => {
      expect(Math.abs(t - (LEAD + i * PERIOD))).toBeLessThan(0.003);
    });
  });

  test("a clean recording passes: each tone on its own channel, no skew", () => {
    const v = measure(bursts(MIC_HZ, CAPTURE_RATE), bursts(CALL_HZ, CAPTURE_RATE));
    expect(v.leftDb).toBeGreaterThan(SEPARATION_DB);
    expect(v.rightDb).toBeGreaterThan(SEPARATION_DB);
    expect(v.skewsMs.length).toBe(5);
    expect(v.maxSkewMs).toBeLessThan(3);
  });

  test("positive controls: swapped channels, crosstalk and a 30 ms skew all fail", () => {
    const mic = bursts(MIC_HZ, CAPTURE_RATE);
    const call = bursts(CALL_HZ, CAPTURE_RATE);
    const swapped = measure(call, mic);
    expect(swapped.leftDb).toBeLessThan(0);
    // The call bleeding into the mic at the same level.
    const mixed = mic.map((v, i) => v + (call[i] as number));
    expect(measure(mixed, call).leftDb).toBeLessThan(SEPARATION_DB);
    const late = measure(shifted(mic, Math.round(0.03 * CAPTURE_RATE)), call);
    expect(late.maxSkewMs).toBeGreaterThan(20);
    expect(late.maxSkewMs).toBeLessThan(40);
    // Nothing recorded on one side: no pairs, an infinite skew, never a pass.
    expect(measure(mic, new Float32Array(mic.length)).maxSkewMs).toBe(Number.POSITIVE_INFINITY);
  });

  test("lays packets out by their file position, gaps as zeros", () => {
    const p = (ch: "mic" | "call", at: number, n: number): Packet => ({
      ch,
      zeroFilled: false,
      captureNs: 0n,
      fileSeconds: at,
      samples: new Float32Array(n).fill(1),
    });
    const x = channel([p("mic", 0, 320), p("call", 0, 320), p("mic", 0.04, 320)], "mic");
    expect(x.length).toBe(960);
    expect(x[0]).toBe(1);
    expect(x[400]).toBe(0);
    expect(x[700]).toBe(1);
  });
});

interface Take {
  code: number | null;
  stderr: string[];
  packets: Packet[];
  opus: Uint8Array;
}

/** Runs the helper, plays the stimulus once it is capturing, stops it after the stimulus. */
async function take(dir: string, name: string, extra: string[]): Promise<Take> {
  const out = join(dir, `${name}.opus`);
  const proc = Bun.spawn(
    [BIN as string, "run", "--out", out, "--mic", MIC, "--call", "system", ...extra],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const decoder = new PacketDecoder();
  const packets: Packet[] = [];
  const reading = (async () => {
    for await (const chunk of proc.stdout) packets.push(...decoder.push(chunk));
  })();
  const stderr: string[] = [];
  let capturing!: () => void;
  const ready = new Promise<void>((r) => {
    capturing = r;
  });
  const lines = (async () => {
    let rest = "";
    for await (const chunk of proc.stderr) {
      rest += new TextDecoder().decode(chunk);
      const parts = rest.split("\n");
      rest = parts.pop() ?? "";
      for (const l of parts) {
        stderr.push(l);
        if (l.includes('"type":"capturing"')) capturing();
      }
    }
  })();
  const opened = await Promise.race([
    ready.then(() => true),
    Bun.sleep(15_000).then(() => false),
    proc.exited.then(() => false),
  ]);
  if (!opened) {
    proc.kill();
    await lines;
    throw new Error(`the helper never said capturing:\n${stderr.join("\n")}`);
  }
  // Let both streams settle, then play.
  await Bun.sleep(700);
  const env = {
    ...process.env,
    STIM: join(dir, "stim.wav"),
    STIM_MIC: join(dir, "stim-mic.wav"),
    STIM_CALL: join(dir, "stim-call.wav"),
  };
  const cmd =
    process.platform === "win32"
      ? ["powershell", "-NoProfile", "-NonInteractive", "-Command", PLAY as string]
      : ["sh", "-c", PLAY as string];
  const player = Bun.spawn(cmd, { env, stdout: "inherit", stderr: "inherit" });
  const played = await player.exited;
  if (played !== 0) throw new Error(`the player exited ${played}`);
  await Bun.sleep(700);
  proc.stdin.write("stop\n");
  await proc.stdin.end();
  const code = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => null)]);
  if (code === null) proc.kill();
  await reading;
  await lines;
  return { code, stderr, packets, opus: new Uint8Array(readFileSync(out)) };
}

function channels(ogg: Uint8Array): number {
  for (let o = 0; o + 12 < ogg.length; o++) {
    if (String.fromCharCode(...ogg.subarray(o, o + 8)) === "OpusHead") return ogg[o + 9] as number;
  }
  return 0;
}

if (!LIVE || !BIN || !PLAY) {
  // Says why nothing below ran; the live capture jobs set all three.
  test.skipIf(!LIVE || !BIN || !PLAY)(
    "akou-capture against real devices (skipped: needs AKOU_CAPTURE_LIVE=1, AKOU_CAPTURE_BIN and AKOU_CAPTURE_LIVE_PLAY, CI only)",
    () => {},
  );
} else {
  describe("akou-capture against real devices", () => {
    const dir = mkdtempSync(join(tmpdir(), "akou-live-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const rate = 48_000;
    const mic = bursts(MIC_HZ, rate);
    const call = bursts(CALL_HZ, rate);
    writeFileSync(join(dir, "stim.wav"), stereoWav(mic, call, rate));
    writeFileSync(join(dir, "stim-mic.wav"), stereoWav(mic, mic, rate));
    writeFileSync(join(dir, "stim-call.wav"), stereoWav(call, call, rate));

    test("left = mic tone, right = call tone, both bursts together (ROADMAP M4)", async () => {
      const t = await take(dir, "live", []);
      const report = t.stderr.filter((l) => !l.includes('"type":"level"'));
      console.log(report.join("\n"));
      expect(t.code).toBe(0);
      expect(t.stderr.some((l) => l.includes('"type":"stopped"'))).toBe(true);
      expect(channels(t.opus)).toBe(2);
      const right = channel(t.packets, "call");
      expect(right.length).toBeGreaterThan(CAPTURE_RATE * (LEAD + 4 * PERIOD + BURST));
      if (MIC === "none") {
        const r = onsets(right);
        console.log(`call-only: ${r.length} bursts heard`);
        expect(r.length).toBe(5);
        return;
      }
      const left = channel(t.packets, "mic");
      const v = measure(left, right);
      console.log(
        `left ${v.leftDb.toFixed(1)} dB, right ${v.rightDb.toFixed(1)} dB, skew ms ${v.skewsMs
          .map((s) => s.toFixed(1))
          .join(" ")}`,
      );
      expect(v.leftDb).toBeGreaterThan(SEPARATION_DB);
      expect(v.rightDb).toBeGreaterThan(SEPARATION_DB);
      expect(v.skewsMs.length).toBe(5);
      if (MAX_SKEW) expect(v.maxSkewMs).toBeLessThan(Number(MAX_SKEW));
    }, 60_000);

    test.skipIf(!EXCLUDE)(
      "[spike] Own audio in the call channel: a player inside the excluded tree is never heard (needs AKOU_CAPTURE_LIVE_EXCLUDE=1, Windows)",
      async () => {
        // This test process started the player, so it is the root of the tree to leave out.
        const t = await take(dir, "excluded", ["--exclude-responsible", String(process.pid)]);
        expect(t.code).toBe(0);
        const excluded = t.stderr.find((l) => l.includes('"type":"capturing"')) ?? "";
        console.log(excluded);
        const right = channel(t.packets, "call");
        const peak = right.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
        console.log(`excluded take: call peak ${peak}`);
        expect(peak).toBeLessThan(0.005);
        // Positive control: the first test heard the same player with nothing excluded.
      },
      60_000,
    );
  });
}
