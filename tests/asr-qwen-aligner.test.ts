/**
 * Word times for Qwen's words (bead akou-chp.15, aligner.ts): Qwen3-ForcedAligner through
 * CrispASR's `--align-only`, one child process per unit, every answer checked before it is used.
 * CrispASR is the fake of `fixtures/fake-crispasr.ts`, which times the tone-coded words of
 * `asr-fake.ts` from the audio; Qwen is the fake llama-server.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobCues } from "../src/main/api/routes/openai.ts";
import { Aligner, joinAligned } from "../src/main/asr/aligner.ts";
import {
  ALIGNER,
  ALIGNER_FILE,
  alignerIds,
  alignerPlan,
  CRISPASR_RELEASE,
  crispasrBuildId,
} from "../src/main/asr/aligner-catalog.ts";
import type { LlamaEngineSpec } from "../src/main/asr/engine.ts";
import { runJobPass } from "../src/main/asr/finalize-worker.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { createLlamaEngine } from "../src/main/asr/llama-server.ts";
import { catalogProblems, MODELS } from "../src/main/asr/models.ts";
import { presetModels } from "../src/main/asr/presets.ts";
import { concat, FakeModels, RATE, silence, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const FAKE_CRISPASR = join(import.meta.dir, "fixtures", "fake-crispasr.ts");
const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A scratch folder and the fake's log in it. */
function scratch(): {
  dir: string;
  log: string;
  runs(): { pid: number; argv: string[]; stdin: string }[];
} {
  const t = tempDir("akou-align-");
  cleanups.push(t.cleanup);
  const log = join(t.dir, "crispasr.log");
  return {
    dir: t.dir,
    log,
    runs: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [],
  };
}

function aligner(
  log: string,
  mode = "ok",
  o: { baseTimeoutS?: number; firstRunExtraS?: number; model?: string } = {},
) {
  const pids: number[] = [];
  const a = new Aligner({
    id: ALIGNER,
    model: "/models/qwen3-forced-aligner-0.6b/qwen3-forced-aligner-0.6b-q4_k.gguf",
    command: [process.execPath, FAKE_CRISPASR, "--fake-log", log, "--fake-mode", mode],
    onChild: (pid, alive) => {
      if (alive) pids.push(pid);
    },
    firstRunExtraS: 0,
    ...o,
  });
  return { a, pids };
}

/** The process has ended: no such pid, or a zombie. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  if (process.platform === "win32") return false;
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  return r.stdout.toString().trim().startsWith("Z");
}

/** Three words, the first starting 0.5 s in: each 0.25 s, 0.12 s apart. */
const THREE = concat(silence(0.5), speak(["hello", "world", "ok"]), silence(0.4));
const STARTS = [0.5, 0.87, 1.24];

describe("joinAligned: the aligner's words back onto Qwen's", () => {
  test("a hyphenated word CrispASR splits takes its first part's start and its last part's end", () => {
    const raw = [
      { word: "The", start: 0, end: 0.08 },
      { word: "good-", start: 1.44, end: 1.6 },
      { word: "looking,", start: 1.6, end: 2.0 },
      { word: "dog.", start: 3.92, end: 4.32 },
    ];
    expect(joinAligned(["The", "good-looking,", "dog."], raw, 4.33)).toEqual({
      times: [
        [0, 0.08],
        [1.44, 2.0],
        [3.92, 4.32],
      ],
    });
  });

  test("an opening quote CrispASR moves onto the word before: each word keeps its own letters' times", () => {
    // CrispASR v0.8.44 answers `says, "In him,` as `says,"`, `In`, `him,`.
    const raw = [
      { word: 'says,"', start: 0.16, end: 0.32 },
      { word: "In", start: 0.32, end: 0.4 },
      { word: "him,", start: 0.4, end: 0.9 },
    ];
    expect(joinAligned(["says,", '"In', "him,"], raw, 1)).toEqual({
      times: [
        [0.16, 0.32],
        [0.32, 0.4],
        [0.4, 0.9],
      ],
    });
  });

  test("an end not after its start becomes the start (the aligner's 80 ms frames)", () => {
    expect(joinAligned(["a"], [{ word: "a", start: 1.2, end: 1.12 }], 2)).toEqual({
      times: [[1.2, 1.2]],
    });
  });

  test("positive controls: a time outside the audio, a word before the last, a different text", () => {
    const ok = [
      { word: "a", start: 0.1, end: 0.3 },
      { word: "b", start: 0.4, end: 0.6 },
    ];
    expect("times" in joinAligned(["a", "b"], ok, 1)).toBe(true);
    const far = [ok[0], { word: "b", start: 400, end: 400.2 }];
    expect(joinAligned(["a", "b"], far, 1)).toEqual({
      error: "the aligner put a word outside the 1.00 s of audio",
    });
    const back = [ok[0], { word: "b", start: 0.05, end: 0.6 }];
    expect(joinAligned(["a", "b"], back, 1)).toEqual({
      error: "the aligner put a word before the one before it",
    });
    for (const words of [["a"], ["a", "b", "c"], ["a", "x"], ["ba"]]) {
      expect(joinAligned(words, ok, 1)).toEqual({
        error: "the aligner's words do not spell the text",
      });
    }
    expect(joinAligned(["a"], { word: "a" }, 1)).toEqual({
      error: "the aligner's answer is not a list of words",
    });
  });
});

describe("Aligner: one CrispASR run per unit", () => {
  test("each word gets its own burst's time, the text goes on stdin and never in argv, with -t 1", async () => {
    const s = scratch();
    const { a } = aligner(s.log);
    const r = await a.align(THREE, ["hello,", "world", "ok."]);
    if (!("times" in r)) throw new Error(r.error);
    expect(r.times).toHaveLength(3);
    for (const [i, [t0, t1]] of r.times.entries()) {
      expect(Math.abs(t0 - (STARTS[i] as number))).toBeLessThan(0.03);
      expect(t1 - t0).toBeGreaterThan(0.2);
    }
    const [run] = s.runs();
    expect(run?.stdin).toBe("hello, world ok.");
    expect(run?.argv.join(" ")).not.toContain("hello");
    const at = (run?.argv ?? []).indexOf("-t");
    expect(run?.argv.slice(at, at + 2)).toEqual(["-t", "1"]);
    expect(run?.argv).toContain("--align-only");
    expect(
      run?.argv.slice(run.argv.indexOf("--text-file"), run.argv.indexOf("--text-file") + 2),
    ).toEqual(["--text-file", "-"]);
  });

  test("the unit's WAV is private and gone once the run ends", async () => {
    const s = scratch();
    const { a } = aligner(s.log);
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("akou-align-")));
    await a.align(THREE, ["hello", "world", "ok"]);
    const left = readdirSync(tmpdir()).filter((n) => n.startsWith("akou-align-") && !before.has(n));
    expect(left).toEqual([]);
    const wav = s.runs()[0]?.argv[(s.runs()[0]?.argv.indexOf("-f") ?? 0) + 1] as string;
    expect(existsSync(wav)).toBe(false);
  });

  for (const [mode, error] of [
    ["outside", "the aligner put a word outside the 2.01 s of audio"],
    ["backwards", "the aligner put a word before the one before it"],
    ["count", "the aligner's words do not spell the text"],
    [
      "exit",
      "the aligner exited with 3: crispasr[align-only]: alignment failed or produced no words.",
    ],
  ] as const) {
    test(`a broken answer (${mode}) leaves the unit with no times, and says why`, async () => {
      const s = scratch();
      const { a } = aligner(s.log, mode);
      expect(await a.align(THREE, ["hello", "world", "ok"])).toEqual({ error });
    });
  }

  test("a run that hangs is killed at its deadline, and its process is gone", async () => {
    const s = scratch();
    const { a, pids } = aligner(s.log, "hang", { baseTimeoutS: 1 });
    const short = THREE.subarray(0, RATE / 4);
    const t = performance.now();
    expect(await a.align(short, ["hello"])).toEqual({
      error: "the aligner took longer than 2 s",
      timedOut: true,
    });
    expect(performance.now() - t).toBeLessThan(10_000);
    expect(pids).toHaveLength(1);
    expect(gone(pids[0] as number)).toBe(true);
  });

  test("after a unit times out, the job's later units start no CrispASR and wait for no deadline", async () => {
    const s = scratch();
    const { a, pids } = aligner(s.log, "hang", { baseTimeoutS: 1 });
    const short = THREE.subarray(0, RATE / 4);
    await a.align(short, ["hello"]);
    const t = performance.now();
    expect(await a.align(short, ["hello"])).toEqual({
      error: "the aligner took longer than 2 s on an earlier piece",
      timedOut: true,
    });
    expect(performance.now() - t).toBeLessThan(500);
    expect(pids).toHaveLength(1);
    expect(s.runs()).toHaveLength(1);
  });

  test("the first run's extra time is given once per model in a process, not once per job", async () => {
    const s = scratch();
    const short = THREE.subarray(0, RATE / 4);
    const model = join(s.dir, "warm.gguf");
    // Each job builds its own Aligner; only the first one ever run on the model gets the extra.
    const first = aligner(s.log, "hang", { baseTimeoutS: 1, firstRunExtraS: 1, model }).a;
    expect(await first.align(short, ["hello"])).toMatchObject({
      error: "the aligner took longer than 3 s",
    });
    const next = aligner(s.log, "hang", { baseTimeoutS: 1, firstRunExtraS: 1, model }).a;
    expect(await next.align(short, ["hello"])).toMatchObject({
      error: "the aligner took longer than 2 s",
    });
  });

  test("a CrispASR that cannot start fails the unit, not the job", async () => {
    const a = new Aligner({
      id: ALIGNER,
      model: "m.gguf",
      command: () => {
        throw new Error("no crispasr in the archive");
      },
    });
    expect(await a.align(THREE, ["hello"])).toEqual({
      error: "the aligner cannot start: no crispasr in the archive",
    });
  });
});

function qwenSpec(
  dir: string,
  aligner?: LlamaEngineSpec["aligner"],
  untimed?: string,
): LlamaEngineSpec {
  return {
    kind: "llama-server",
    engine: QWEN_ASR,
    model: join(dir, "q.gguf"),
    mmproj: join(dir, "p.gguf"),
    accelerator: "cpu",
    command: [process.execPath, FAKE_LLAMA],
    ...(aligner ? { aligner } : {}),
    ...(untimed ? { untimed } : {}),
  };
}

const NOTE = concat(
  silence(0.4),
  speak(["hello", "world"], { voice: 1 }),
  silence(1.2),
  speak(["ok", "great"], { voice: 4 }),
  silence(0.4),
);

describe("a job on Qwen with the aligner", () => {
  test("the words get times on the file's clock, inside their segment and in order", async () => {
    const s = scratch();
    const engine = createLlamaEngine(
      qwenSpec(s.dir, {
        engine: ALIGNER,
        model: join(s.dir, "a.gguf"),
        command: [process.execPath, FAKE_CRISPASR, "--fake-log", s.log],
      }),
    );
    cleanups.push(() => engine.unload());
    const r = await runJobPass(
      { samples: NOTE, diarize: false, decode: null, language: "en" },
      new FakeModels(),
      () => {},
      engine,
    );
    expect(r.text).toBe("hello world ok great");
    expect(r.aligner).toBe(ALIGNER);
    expect(r.untimed).toBeUndefined();
    // The words start where the fake spoke them: 0.4 s, then 0.37 s apart, then after 1.2 s.
    const starts = [0.4, 0.77, 2.34, 2.71];
    for (const [i, w] of r.words.entries()) {
      expect(w.s).not.toBeNull();
      expect(Math.abs((w.s as number) - (starts[i] as number))).toBeLessThan(0.05);
      expect(w.e as number).toBeGreaterThan(w.s as number);
      const seg = r.segments.find((x) => x.text.split(" ").includes(w.w));
      expect(w.s as number).toBeGreaterThanOrEqual((seg?.s ?? 0) - 1e-6);
      expect(w.e as number).toBeLessThanOrEqual((seg?.e ?? 0) + 1e-6);
    }
    expect(r.words.map((w) => w.s)).toEqual(
      [...r.words.map((w) => w.s)].sort((x, y) => (x as number) - (y as number)),
    );
    expect(r.words.map((w) => w.c)).toEqual(r.words.map(() => expect.any(Number)));
  });

  test("a language the aligner does not cover keeps null times and says so", async () => {
    const s = scratch();
    const engine = createLlamaEngine(
      qwenSpec(s.dir, {
        engine: ALIGNER,
        model: join(s.dir, "a.gguf"),
        command: [process.execPath, FAKE_CRISPASR, "--fake-log", s.log],
      }),
    );
    cleanups.push(() => engine.unload());
    const r = await runJobPass(
      { samples: NOTE, diarize: false, decode: null, language: "ar" },
      new FakeModels(),
      () => {},
      engine,
    );
    expect(r.words.every((w) => w.s === null && w.e === null)).toBe(true);
    expect(r.untimed).toEqual([
      { reason: "the aligner does not cover language ar", units: r.segments.length },
    ]);
    expect(r.aligner).toBeUndefined();
    expect(s.runs()).toEqual([]);
  });

  test("an aligner that fails costs the times, never the words", async () => {
    const s = scratch();
    const engine = createLlamaEngine(
      qwenSpec(s.dir, {
        engine: ALIGNER,
        model: join(s.dir, "a.gguf"),
        command: [process.execPath, FAKE_CRISPASR, "--fake-log", s.log, "--fake-mode", "outside"],
      }),
    );
    cleanups.push(() => engine.unload());
    const r = await runJobPass(
      { samples: NOTE, diarize: false, decode: null, language: "en" },
      new FakeModels(),
      () => {},
      engine,
    );
    expect(r.text).toBe("hello world ok great");
    expect(r.words.every((w) => w.s === null)).toBe(true);
    expect(r.untimed).toEqual([{ reason: "the aligner failed", units: r.segments.length }]);
  });

  test("one piece the aligner fails keeps its words untimed; the other pieces keep their times and their word cues", async () => {
    const s = scratch();
    const engine = createLlamaEngine(
      qwenSpec(s.dir, {
        engine: ALIGNER,
        model: join(s.dir, "a.gguf"),
        command: [process.execPath, FAKE_CRISPASR, "--fake-log", s.log, "--fake-mode", "miss:ok"],
      }),
    );
    cleanups.push(() => engine.unload());
    const r = await runJobPass(
      { samples: NOTE, diarize: false, decode: null, language: "en" },
      new FakeModels(),
      () => {},
      engine,
    );
    expect(r.segments.map((x) => x.text)).toEqual(["hello world", "ok great"]);
    expect(r.words.map((w) => w.s === null)).toEqual([false, false, true, true]);
    expect(r.aligner).toBe(ALIGNER);
    expect(r.untimed).toEqual([{ reason: "the aligner failed", units: 1 }]);
    const cues = jobCues(r.words, r.segments);
    // The timed piece's cue runs from its first word's start to its last word's end, not the
    // segment's padded edges; the untimed piece is its segment, as before.
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ text: "hello world", s: r.words[0]?.s, e: r.words[1]?.e });
    expect(cues[0]?.s).not.toBe(r.segments[0]?.s);
    expect(cues[1]).toEqual(r.segments[1] as (typeof r.segments)[number]);
  });

  test("a unit that times out stops the aligner for the rest of the job: one CrispASR run, every piece says so", async () => {
    const s = scratch();
    const engine = createLlamaEngine(qwenSpec(s.dir));
    engine.setAligner(
      new Aligner({
        id: ALIGNER,
        model: join(s.dir, "a.gguf"),
        command: [process.execPath, FAKE_CRISPASR, "--fake-log", s.log, "--fake-mode", "hang"],
        baseTimeoutS: 1,
        firstRunExtraS: 0,
      }),
    );
    cleanups.push(() => engine.unload());
    const r = await runJobPass(
      { samples: NOTE, diarize: false, decode: null, language: "en" },
      new FakeModels(),
      () => {},
      engine,
    );
    expect(r.segments).toHaveLength(2);
    expect(s.runs()).toHaveLength(1);
    expect(r.untimed).toEqual([{ reason: "the aligner timed out", units: 2 }]);
  });

  test("the aligner's time is not counted as Qwen's decode time (the Models page's speed)", async () => {
    const s = scratch();
    const engine = createLlamaEngine(
      qwenSpec(s.dir, {
        engine: ALIGNER,
        model: join(s.dir, "a.gguf"),
        command: [process.execPath, FAKE_CRISPASR, "--fake-log", s.log, "--fake-mode", "slow"],
      }),
    );
    cleanups.push(() => engine.unload());
    // Load first, so the decode time holds no llama-server start.
    await engine.load();
    const r = await runJobPass(
      { samples: NOTE, diarize: false, decode: null, language: "en" },
      new FakeModels(),
      () => {},
      engine,
    );
    expect(r.aligner).toBe(ALIGNER);
    expect(s.runs()).toHaveLength(2);
    // Two units at 1.5 s each in the aligner: 3 s that are not Qwen's.
    expect(r.decode_s as number).toBeLessThan(1.5);
  });

  test("with no aligner here, the spec's reason reaches every piece", async () => {
    const s = scratch();
    const why = "the aligner runs only on Metal or Vulkan, and Qwen runs on the CPU here";
    const engine = createLlamaEngine(qwenSpec(s.dir, undefined, why));
    cleanups.push(() => engine.unload());
    const r = await runJobPass(
      { samples: NOTE, diarize: false, decode: null, language: "en" },
      new FakeModels(),
      () => {},
      engine,
    );
    expect(r.words.every((w) => w.s === null)).toBe(true);
    expect(r.untimed).toEqual([{ reason: why, units: r.segments.length }]);
  });
});

describe("where the aligner runs: Metal and Vulkan only", () => {
  test("the plan by Qwen's backend and platform, and what the best preset pulls for it", () => {
    const mac = alignerPlan({ accelerator: "metal", platform: "darwin-arm64" });
    expect(alignerIds(mac)).toEqual([ALIGNER, crispasrBuildId("darwin-arm64", "metal")]);
    const linux = alignerPlan({ accelerator: "vulkan", platform: "linux-x64" });
    expect(alignerIds(linux)).toEqual([ALIGNER, crispasrBuildId("linux-x64", "vulkan")]);
    // An image carries its build: only the model is pulled.
    const image = alignerPlan({ accelerator: "vulkan", platform: "linux-x64", image: "/opt/c" });
    expect(image).toEqual({ command: ["/opt/c"] });
    expect(alignerIds(image)).toEqual([ALIGNER]);
    expect(alignerPlan({ accelerator: "cpu", platform: "linux-x64", image: "/opt/c" })).toEqual({
      why: "the aligner runs only on Metal or Vulkan, and Qwen runs on the CPU here",
    });
    expect(alignerPlan({ accelerator: "cuda", platform: "linux-x64" })).toEqual({
      why: "the aligner runs only on Metal or Vulkan, and Qwen runs on cuda here",
    });
    expect(alignerPlan({ accelerator: "vulkan", platform: "linux-arm64" })).toEqual({
      why: "there is no aligner build for linux-arm64 on vulkan",
    });
    expect(alignerIds({ why: "x" })).toEqual([]);
    const best = presetModels("best", ["silero-vad"], "llama-x", undefined, alignerIds(mac));
    expect("models" in best && best.models).toEqual([
      "qwen3-asr-1.7b",
      "llama-x",
      "silero-vad",
      ...alignerIds(mac),
    ]);
  });

  test("the entries are pinned and whole, and the GGUF keeps the name CrispASR reads its family from", () => {
    const entries = MODELS.filter((m) => m.runtime === "crispasr");
    expect(entries.map((m) => m.id)).toEqual([
      ALIGNER,
      crispasrBuildId("darwin-arm64", "metal"),
      crispasrBuildId("linux-x64", "vulkan"),
    ]);
    expect(entries[0]?.files.map((f) => f.name)).toEqual([ALIGNER_FILE]);
    expect(ALIGNER_FILE).toStartWith("qwen3-forced-aligner");
    for (const m of entries.slice(1)) {
      for (const f of m.files)
        expect(f.url).toStartWith(
          `https://github.com/CrispStrobe/CrispASR/releases/download/${CRISPASR_RELEASE}/`,
        );
    }
    expect(catalogProblems(MODELS)).toEqual([]);
  });
});
