/**
 * The part of the nightly evaluation (scripts/eval/nightly.ts) that needs no model and no network:
 * reading a WAV into the recognizer's rate, and the pinned silent clips. The downloads and the
 * models run in the nightly job itself; the scoring is tested in score.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineLatency } from "../../scripts/eval/dictation-latency.ts";
import {
  exitCode,
  failureVerdicts,
  memoryMb,
  nightVerdicts,
  pinned,
  readWav,
  SILENCE,
  timeEngines,
} from "../../scripts/eval/nightly.ts";
import type { Measure } from "../../scripts/eval/score.ts";
import { ASR_RATE } from "../../src/main/asr/engine.ts";

describe("a WAV at the recognizer's rate", () => {
  /** A 16-bit PCM WAV. */
  function wav(
    rate: number,
    channels: number,
    frames: (i: number, c: number) => number,
    n: number,
  ) {
    const b = new Uint8Array(44 + n * channels * 2);
    const v = new DataView(b.buffer);
    b.set(new TextEncoder().encode("RIFF"), 0);
    v.setUint32(4, 36 + n * channels * 2, true);
    b.set(new TextEncoder().encode("WAVEfmt "), 8);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, channels, true);
    v.setUint32(24, rate, true);
    v.setUint16(34, 16, true);
    b.set(new TextEncoder().encode("data"), 36);
    v.setUint32(40, n * channels * 2, true);
    for (let i = 0; i < n; i++)
      for (let c = 0; c < channels; c++)
        v.setInt16(44 + (i * channels + c) * 2, Math.round(frames(i, c) * 32767), true);
    return b;
  }

  test("16 kHz mono passes through; 48 kHz stereo is mixed down and resampled", () => {
    const mono = readWav(wav(ASR_RATE, 1, (i) => (i % 2 ? 0.5 : -0.5), 1600));
    expect(mono.length).toBe(1600);
    expect(mono[1]).toBeCloseTo(0.5, 3);
    // Left 0.5 and right -0.5 mix to silence; one second stays one second.
    const st = readWav(wav(48_000, 2, (_i, c) => (c === 0 ? 0.5 : -0.5), 48_000));
    expect(st.length).toBe(ASR_RATE);
    expect(Math.max(...st.map(Math.abs))).toBeLessThan(1e-3);
    expect(() => readWav(new Uint8Array(44))).toThrow("not a PCM WAV");
  });

  /** `wav`'s header with its format tag and sample width rewritten, samples left as they are. */
  const retag = (b: Uint8Array, format: number, bits: number) => {
    const v = new DataView(b.buffer);
    v.setUint16(20, format, true);
    v.setUint16(34, bits, true);
    return b;
  };

  test("a sample format it cannot decode is refused, never read as 16-bit", () => {
    const ok = () => wav(ASR_RATE, 1, () => 0.25, 1200);
    // 24-bit PCM and the extensible tag (0xFFFE) would otherwise decode as 16-bit noise.
    expect(() => readWav(retag(ok(), 1, 24))).toThrow("format 1 with 24 bits");
    expect(() => readWav(retag(ok(), 0xfffe, 16))).toThrow("format 65534 with 16 bits");
    expect(() => readWav(retag(ok(), 3, 16))).toThrow("format 3 with 16 bits");
    // Positive control: 32-bit float, the other format it reads, still decodes.
    const f = new Uint8Array(44 + 4 * 400);
    f.set(ok().subarray(0, 44));
    const fv = new DataView(f.buffer);
    retag(f, 3, 32);
    fv.setUint32(40, 4 * 400, true);
    for (let i = 0; i < 400; i++) fv.setFloat32(44 + 4 * i, 0.25, true);
    const x = readWav(f);
    expect(x.length).toBe(400);
    expect(x[399]).toBeCloseTo(0.25, 6);
  });
});

describe("a pinned download", () => {
  test("a fetch that fails its hash leaves nothing at the path, and a good one lands there", async () => {
    const good = new TextEncoder().encode("the pinned bytes");
    let body = good.subarray(0, 5); // a truncated fetch
    const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    const dir = mkdtempSync(join(tmpdir(), "akou-pinned-"));
    try {
      const url = `http://127.0.0.1:${server.port}/f`;
      const path = join(dir, "f");
      const sha = createHash("sha256").update(good).digest("hex");
      await expect(pinned(url, path, sha)).rejects.toThrow("pinned");
      // Nothing half-written stays behind for the next run to trip on.
      expect(readdirSync(dir)).toEqual([]);
      body = good;
      expect(await pinned(url, path, sha)).toEqual(good);
      expect(readdirSync(dir)).toEqual(["f"]);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a process's memory (the Qwen stage's flat-memory bound)", () => {
  // Windows reads private bytes through PowerShell (the Windows gate, ASR-12); before that it read
  // Linux's /proc there and threw, so the stage could not run on Windows at all.
  // A cold Windows PowerShell start on a shared CI runner takes longer than bun test's 5 s default,
  // which killed the child and left nothing to read; 30 s covers it.
  test("this test's own process reads a plausible size on the OS it runs on", () => {
    const mb = memoryMb(process.pid);
    expect(mb).toBeGreaterThan(10);
    expect(mb).toBeLessThan(64 * 1024);
  }, 30_000);
});

describe("the committed baselines", () => {
  test("every platform with numbers names the decoder they were measured with", () => {
    const b = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "..", "docs", "gates", "nightly-baselines.json"),
        "utf8",
      ),
    ) as { _measured: Record<string, string>; platforms: Record<string, Record<string, number>> };
    const named = Object.keys(b.platforms).filter((p) =>
      /\b(greedy|beam)\b/.test(b._measured[p] ?? ""),
    );
    expect(named).toEqual(Object.keys(b.platforms));
  });

  test("each OS the night runs on has a baseline for every gated number", () => {
    const b = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "..", "docs", "gates", "nightly-baselines.json"),
        "utf8",
      ),
    ) as { platforms: Record<string, Record<string, number>> };
    const gated = [
      "wer.fleurs_en.parakeet-tdt-0.6b-v3-fp32",
      "wer.fleurs_es.parakeet-tdt-0.6b-v3-fp32",
      "der.ami_test2.nemotron-3-diarization",
    ];
    // nightly.yml's matrix: macos-latest, ubuntu-latest and windows-latest.
    for (const p of ["darwin-arm64", "linux-x64", "win32-x64"])
      expect(Object.keys(b.platforms[p] ?? {}).sort()).toEqual([...gated].sort());
  });
});

describe("Qwen's silent clips (ASR-5)", () => {
  test("the benchmark's 25 stretches, each 3 to 8 s, in order and inside its meeting", () => {
    const all = SILENCE.meetings.flatMap((m) => m.stretches);
    expect(all).toHaveLength(25);
    for (const m of SILENCE.meetings) {
      expect(m.wavSha256).toMatch(/^[0-9a-f]{64}$/);
      m.stretches.forEach(([start, end], i) => {
        expect(end - start).toBeGreaterThanOrEqual(3);
        expect(end - start).toBeLessThanOrEqual(8);
        if (i > 0)
          expect(start).toBeGreaterThan((m.stretches[i - 1] as readonly number[])[1] as number);
      });
    }
  });
});

describe("the dictation stage when an engine fails", () => {
  const closed: string[] = [];
  const engine = (model: string) => async () => ({
    model,
    close: async () => {
      closed.push(model);
    },
  });
  const row = (model: string): EngineLatency => ({
    model,
    seconds: { "3": { p50: 100, p95: 120, n: 10 } },
  });

  test("one that will not start is left out with why, and the others are still timed", async () => {
    closed.length = 0;
    const r = await timeEngines(
      [
        ["live", engine("live-model")],
        [
          "qwen",
          async () => {
            throw new Error("llama-server did not start");
          },
        ],
        ["remote", engine("remote-model")],
      ],
      async (_, e) => row(e.model),
    );
    // The engines after the failure ran: their numbers reach the measures and the latency table.
    expect(Object.keys(r.out)).toEqual(["live", "remote"]);
    expect(r.out.remote?.model).toBe("remote-model");
    expect(r.failed).toEqual([{ engine: "qwen", why: "llama-server did not start" }]);
    expect(closed).toEqual(["live-model", "remote-model"]);
    // The night is red for it: a row that is never ok.
    expect(failureVerdicts("dictation", r.failed)).toEqual([
      {
        key: "dictation.qwen",
        value: 0,
        unit: "",
        baseline: null,
        ok: false,
        why: "failed: llama-server did not start",
      },
    ]);
  });

  test("one that fails while it is timed is closed, and the next one runs", async () => {
    closed.length = 0;
    const r = await timeEngines(
      [
        ["live", engine("live-model")],
        ["remote", engine("remote-model")],
      ],
      async (name, e) => {
        if (name === "live") throw new Error("the stream stopped answering");
        return row(e.model);
      },
    );
    expect(Object.keys(r.out)).toEqual(["remote"]);
    expect(r.failed).toEqual([{ engine: "live", why: "the stream stopped answering" }]);
    expect(closed).toEqual(["live-model", "remote-model"]);
  });

  test("a failed stage makes the night red: the verdicts carry it and the exit code is 1", () => {
    const measures: Measure[] = [
      {
        key: "dictation.release_to_text.3s.live.p50",
        value: 120,
        unit: "ms",
        better: "lower",
        gate: "record",
      },
    ];
    const failed = failureVerdicts("dictation", [{ engine: "qwen", why: "llama-server is down" }]);
    const v = nightVerdicts(measures, {}, failed);
    expect(v.map((x) => [x.key, x.ok])).toEqual([
      ["dictation.release_to_text.3s.live.p50", true],
      ["dictation.qwen", false],
    ]);
    expect(exitCode(v)).toBe(1);
    // Positive control: the same night with no failed stage passes.
    expect(exitCode(nightVerdicts(measures, {}, []))).toBe(0);
  });

  test("positive control: with every engine timed, nothing fails and no row is red", async () => {
    const r = await timeEngines([["live", engine("live-model")]], async (_, e) => row(e.model));
    expect(r.failed).toEqual([]);
    expect(failureVerdicts("dictation", r.failed)).toEqual([]);
  });
});
