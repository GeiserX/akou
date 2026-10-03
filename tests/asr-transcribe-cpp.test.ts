/**
 * The transcribe-cpp engines (transcribe-cpp.ts, ASR-8): Whisper large-v3 and Canary-1b-v2 as
 * `FinalEngine`s. CI runs them against a fake binding that behaves as the real one was measured to:
 * Canary translates into English when it is told no language, and its `pnc: "off"` can cut a
 * unit's words. With the real models on disk (`AKOU_MODELS_DIR` or the app's models folder), each
 * loads beside sherpa-onnx-node in this process and decodes the two-voices fixture.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { TranscribeOptions, TranscriptionResult } from "transcribe-cpp";
import type { FinalUnit } from "../src/main/asr/engine.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import {
  CANARY_1B_V2,
  type CatalogEntry,
  catalogProblems,
  defaultModelsDir,
  MODELS,
  modelFile,
  modelsFor,
  PARAKEET_LANGUAGES,
  RECOGNIZER,
  WHISPER_LANGUAGES,
  WHISPER_LARGE_V3,
} from "../src/main/asr/models.ts";
import {
  createTranscribeCppEngine,
  type NativeModel,
  TRANSCRIBE_CPP_ENGINES,
  type TranscribeBinding,
  TranscribeCppEngine,
  type TranscribeCppError,
  type TranscribeFamily,
  WHISPER_PROMPT_TOKENS,
} from "../src/main/asr/transcribe-cpp.ts";
import { type ModelRefused, resolveModel, runsJobs } from "../src/main/server/model-store.ts";

const SPOKEN = "buenos días a todos gracias por venir a la reunión de planificación";
const ENGLISH = "good morning everyone thanks for joining the planning meeting";

function result(text: string, o: Partial<TranscriptionResult> = {}): TranscriptionResult {
  return {
    text,
    rawText: text,
    language: "",
    timestampKind: "none",
    segments: [],
    speakerSegments: [],
    words: [],
    tokens: [],
    timings: { loadMs: 0, melMs: 0, encodeMs: 0, decodeMs: 0 },
    aborted: false,
    truncated: false,
    ...o,
  };
}

interface FakeOptions {
  /** Whisper's detected language when it is told none. */
  detects?: string;
  /** What the model answers per forced language; default the Spanish sentence. */
  says?: Record<string, string>;
  /** Throw on the next transcribe. */
  fail?: Error;
  truncate?: boolean;
  loadFails?: Error;
  disposeFails?: boolean;
}

/**
 * A binding that behaves as transcribe-cpp 0.2.4 was measured to: Canary with no language answers
 * an English translation; Canary with `pnc: "off"` lost most of a unit's words on one slice; a
 * forced Whisper answers `language: ""`, a free one the language it detected.
 */
function fakeBinding(family: TranscribeFamily, o: FakeOptions = {}) {
  const calls: TranscribeOptions[] = [];
  let loads = 0;
  let disposed = 0;
  let inFlight = 0;
  let overlapped = false;
  /** Freed while a decode still read it: native code would read freed memory. */
  let usedFreed = false;
  let alive = false;
  const model: NativeModel = {
    async transcribe(pcm, opts = {}) {
      calls.push(opts);
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await Bun.sleep(1);
      inFlight--;
      if (!alive) usedFreed = true;
      if (o.fail) {
        const e = o.fail;
        o.fail = undefined;
        throw e;
      }
      if (pcm.length === 0) throw new Error("PCM is empty");
      if (o.truncate) return result("buenos", { truncated: true });
      if (family === "canary") {
        if (!opts.language) return result(ENGLISH);
        const said = o.says?.[opts.language] ?? SPOKEN;
        return result(opts.pnc === "off" ? said.split(" ").slice(0, 2).join(" ") : said);
      }
      if (!opts.language)
        return result(o.says?.[o.detects ?? "es"] ?? SPOKEN, { language: o.detects ?? "es" });
      return result(o.says?.[opts.language] ?? SPOKEN);
    },
    // One token per four characters, as rough as a BPE needs to be here.
    tokenize: (text) => new Int32Array(Math.ceil(text.length / 4)),
    dispose() {
      disposed++;
      alive = false;
      if (o.disposeFails) throw new Error("finalizer crash");
    },
  };
  const binding: TranscribeBinding = {
    async load() {
      loads++;
      if (o.loadFails) throw o.loadFails;
      alive = true;
      return model;
    },
  };
  return {
    binding: async () => binding,
    calls,
    loads: () => loads,
    disposed: () => disposed,
    overlapped: () => overlapped,
    usedFreed: () => usedFreed,
    model,
  };
}

function engine(
  family: TranscribeFamily,
  fake: ReturnType<typeof fakeBinding>,
  allowed?: string[],
) {
  return new TranscribeCppEngine({
    id: family === "whisper" ? WHISPER_LARGE_V3 : CANARY_1B_V2,
    family,
    model: "/nowhere/model.gguf",
    languages: family === "whisper" ? WHISPER_LANGUAGES : PARAKEET_LANGUAGES,
    binding: fake.binding,
    ...(allowed ? { allowed } : {}),
  });
}

const unit = (lang = "auto", glossary: string[] = []): FinalUnit => ({
  samples: new Float32Array(16000),
  lang,
  glossary,
});

async function refusal(p: Promise<unknown>): Promise<TranscribeCppError> {
  try {
    await p;
  } catch (err) {
    return err as TranscribeCppError;
  }
  throw new Error("expected a refusal");
}

describe("Canary: told the language, and never sent pnc", () => {
  test("a unit's language is forced, a tag cut to its code; the options carry no pnc", async () => {
    const fake = fakeBinding("canary");
    const h = await engine("canary", fake).decode(unit("es-ES"));
    expect(fake.calls).toEqual([{ language: "es", timestamps: "none" }]);
    expect(h.text).toBe(SPOKEN);
    expect(h.lang).toBe("es");
  });

  test("positive control: the fake's pnc off cuts the unit's words, as measured, so a pnc sent would fail the test above", async () => {
    const fake = fakeBinding("canary");
    const m = await (await fake.binding()).load("x");
    const off = await m.transcribe(new Float32Array(16000), { language: "es", pnc: "off" });
    expect(off.text.split(" ").length).toBeLessThan(SPOKEN.split(" ").length);
  });

  test("with no language on the unit, the first of the user's languages Canary hears is forced", async () => {
    const fake = fakeBinding("canary");
    const h = await engine("canary", fake, ["ja", "de-DE", "fr"]).decode(unit());
    expect(fake.calls[0]?.language).toBe("de");
    expect(h.lang).toBe("de");
  });

  test("with no language at all, the unit fails before the model loads: Canary would translate it", async () => {
    const fake = fakeBinding("canary");
    const err = await refusal(engine("canary", fake).decode(unit()));
    expect([err.code, err.fatal]).toEqual(["unit_failed", false]);
    expect(err.message).toContain("translates into English");
    expect([fake.calls.length, fake.loads()]).toEqual([0, 0]);
    // Positive control: what the rule prevents. Told no language, the model answers in English.
    const m = await (await fake.binding()).load("x");
    expect((await m.transcribe(new Float32Array(16000), {})).text).toBe(ENGLISH);
  });

  test("a language Canary does not hear fails the unit, never forced into another one", async () => {
    const fake = fakeBinding("canary");
    const err = await refusal(engine("canary", fake, ["es"]).decode(unit("ja")));
    expect([err.code, err.fatal, fake.calls.length]).toEqual(["unit_failed", false, 0]);
  });

  test("Canary takes no glossary and gives no confidences or times", async () => {
    const fake = fakeBinding("canary");
    const e = engine("canary", fake);
    expect(e.features).toEqual({
      confidence: false,
      timestamps: false,
      glossary: false,
      languageId: false,
    });
    const h = await e.decode(unit("es", ["Grafana"]));
    expect(fake.calls[0]?.family).toBeUndefined();
    expect(h.words).toEqual(SPOKEN.split(" ").map((w) => ({ w })));
  });
});

describe("Whisper: forced when the language is known, detected when it is not", () => {
  test("the unit's language, else the user's one language, is forced; the hypothesis carries it", async () => {
    const fake = fakeBinding("whisper");
    const a = await engine("whisper", fake).decode(unit("es"));
    const b = await engine("whisper", fake, ["es"]).decode(unit());
    expect(fake.calls.map((c) => c.language)).toEqual(["es", "es"]);
    expect([a.lang, b.lang]).toEqual(["es", "es"]);
  });

  test("with no language known it detects, and reports what it heard", async () => {
    const fake = fakeBinding("whisper", { detects: "en", says: { en: ENGLISH } });
    const h = await engine("whisper", fake).decode(unit());
    expect(fake.calls).toEqual([{ timestamps: "none" }]);
    expect([h.lang, h.text]).toEqual(["en", ENGLISH]);
  });

  test("with several languages it detects; one outside them is decoded again, forced into the first", async () => {
    const inside = fakeBinding("whisper", { detects: "en", says: { en: ENGLISH } });
    const h = await engine("whisper", inside, ["es", "en"]).decode(unit());
    expect([inside.calls.length, h.lang]).toEqual([1, "en"]);
    const outside = fakeBinding("whisper", { detects: "pt", says: { pt: "bom dia" } });
    const g = await engine("whisper", outside, ["es", "en"]).decode(unit());
    expect(outside.calls.map((c) => c.language)).toEqual([undefined, "es"]);
    expect([g.lang, g.text]).toEqual(["es", SPOKEN]);
  });

  test("Javanese is jv to akou and jw to Whisper", async () => {
    const fake = fakeBinding("whisper");
    const h = await engine("whisper", fake).decode(unit("jv"));
    expect([fake.calls[0]?.language, h.lang]).toEqual(["jw", "jv"]);
  });

  test("the glossary is the initial prompt: its head within the token budget, no special-token literal", async () => {
    const fake = fakeBinding("whisper");
    const e = engine("whisper", fake);
    expect(e.features).toEqual({
      confidence: false,
      timestamps: false,
      glossary: true,
      languageId: true,
    });
    await e.decode(unit("en", ["Grafana", "<|en|>", " Kubernetes "]));
    expect(fake.calls[0]?.family).toEqual({
      kind: "whisper",
      initialPrompt: "Grafana, Kubernetes",
    });
    const long = Array.from({ length: 400 }, (_, i) => `term${i}`);
    await e.decode(unit("en", long));
    const prompt = String((fake.calls[1]?.family as { initialPrompt?: string })?.initialPrompt);
    expect(prompt.startsWith("term0, term1, ")).toBe(true);
    expect(Math.ceil(` ${prompt}`.length / 4)).toBeLessThanOrEqual(WHISPER_PROMPT_TOKENS);
    expect(prompt.split(", ").length).toBeLessThan(long.length);
    // No glossary, no prompt.
    await e.decode(unit("en"));
    expect(fake.calls[2]?.family).toBeUndefined();
  });
});

describe("a native error is one failed unit, never the Worker", () => {
  test("a refused decode is unit_failed and not fatal; the next unit decodes", async () => {
    const fake = fakeBinding("whisper", { fail: new Error("unsupported language (status 10)") });
    const e = engine("whisper", fake);
    const err = await refusal(e.decode(unit("en")));
    expect([err.name, err.code, err.fatal]).toEqual(["TranscribeCppError", "unit_failed", false]);
    expect(err.message).toContain("status 10");
    expect((await e.decode(unit("en"))).text).toBe(SPOKEN);
  });

  test("a truncated output fails the unit, so the pass halves it", async () => {
    const err = await refusal(
      engine("canary", fakeBinding("canary", { truncate: true })).decode(unit("es")),
    );
    expect([err.code, err.fatal]).toEqual(["unit_failed", false]);
  });

  test("a model that cannot load is engine_unavailable and fatal, as a llama-server that is down", async () => {
    const fake = fakeBinding("whisper", {
      loadFails: new Error("no native library for this platform"),
    });
    const err = await refusal(engine("whisper", fake).decode(unit("en")));
    expect([err.code, err.fatal]).toEqual(["engine_unavailable", true]);
    expect(err.message).toContain("no native library");
  });

  test("empty audio decodes to nothing without a native call", async () => {
    const fake = fakeBinding("whisper");
    const h = await engine("whisper", fake).decode({
      samples: new Float32Array(0),
      lang: "en",
      glossary: [],
    });
    expect([h.text, h.words, fake.calls.length]).toEqual(["", [], 0]);
  });
});

describe("[T4.18] Models loaded twice: one load, explicit unload, one decode at a time", () => {
  test("decodes share one load; unload disposes it; a later decode loads again", async () => {
    const fake = fakeBinding("canary", { disposeFails: true });
    const e = engine("canary", fake);
    await e.load();
    await Promise.all([e.decode(unit("es")), e.decode(unit("es")), e.decode(unit("es"))]);
    expect([fake.loads(), fake.overlapped()]).toEqual([1, false]);
    // A dispose that throws (Bun's finalizer trouble) costs nothing but the model.
    await e.unload();
    expect(fake.disposed()).toBe(1);
    await e.unload();
    expect(fake.disposed()).toBe(1);
    await e.decode(unit("es"));
    expect(fake.loads()).toBe(2);
  });

  test("unload waits for the decode in flight before it frees the model", async () => {
    const fake = fakeBinding("whisper");
    const e = engine("whisper", fake);
    const decoding = e.decode(unit("en"));
    await e.unload();
    expect((await decoding).text).toBe(SPOKEN);
    expect([fake.disposed(), fake.usedFreed()]).toEqual([1, false]);
    // Positive control: freeing the model under a decode is what the fake catches.
    const raw = fakeBinding("whisper");
    const m = await (await raw.binding()).load("x");
    const reading = m.transcribe(new Float32Array(16000), { language: "en" });
    m.dispose();
    await reading;
    expect(raw.usedFreed()).toBe(true);
  });

  test("the factory maps each catalog id to its family, file and languages", () => {
    const w = createTranscribeCppEngine(WHISPER_LARGE_V3, "/models");
    expect([w.id, w.features.glossary]).toEqual([WHISPER_LARGE_V3, true]);
    expect(createTranscribeCppEngine(CANARY_1B_V2, "/models").features.languageId).toBe(false);
    expect(() => createTranscribeCppEngine("qwen3-asr-1.7b", "/models")).toThrow(
      /not a transcribe-cpp engine/,
    );
  });
});

describe("the transcribe-cpp catalog entries", () => {
  const entries = MODELS.filter((m) => m.runtime === "transcribe-cpp");

  /** What is wrong with one entry; empty when whole. */
  function problems(m: CatalogEntry): string[] {
    const out: string[] = [];
    if (m.files.length !== 1) out.push("not one GGUF");
    for (const f of m.files) {
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) out.push(`${f.name}: no SHA-256`);
      if (!(f.size > 0)) out.push(`${f.name}: no size`);
      if (!/\/resolve\/[0-9a-f]{40}\//.test(f.url)) out.push(`${f.name}: url not pinned`);
      if (f.name !== TRANSCRIBE_CPP_ENGINES[m.id]?.file)
        out.push(`${f.name}: not the engine's file`);
    }
    if (!m.onDemand) out.push("in every machine's download");
    if (m.serves.join() !== "final") out.push("not a final engine");
    if (m.languages !== TRANSCRIBE_CPP_ENGINES[m.id]?.languages) out.push("languages differ");
    return out;
  }

  test("Whisper and Canary: one pinned GGUF each with a digest and a size, fetched only when named", () => {
    expect(entries.map((m) => m.id)).toEqual([WHISPER_LARGE_V3, CANARY_1B_V2]);
    for (const m of entries) expect(`${m.id}: ${problems(m).join("; ")}`).toBe(`${m.id}: `);
    expect(catalogProblems(MODELS)).toEqual([]);
    expect(Object.keys(TRANSCRIBE_CPP_ENGINES)).toEqual(entries.map((m) => m.id));
    // Measured sizes of the Q8_0 files.
    expect(entries.map((m) => m.files[0]?.size)).toEqual([1668741440, 1144290016]);
    expect(WHISPER_LANGUAGES.length).toBe(100);
    // Never in a machine's default download.
    const ids = modelsFor({ "asr.diarizer": "nemotron" }, "darwin-arm64").map((m) => m.id);
    expect(ids).not.toContain(WHISPER_LARGE_V3);
    expect(ids).not.toContain(CANARY_1B_V2);
    // Positive control: an entry with no digest, or none at all, is caught.
    const bare = { ...(entries[0] as CatalogEntry) };
    bare.files = [{ ...(bare.files[0] as CatalogEntry["files"][0]), sha256: "", size: 0 }];
    expect(problems(bare)).toEqual([
      `${bare.files[0]?.name}: no SHA-256`,
      `${bare.files[0]?.name}: no size`,
    ]);
    expect(catalogProblems([{ ...bare, runtime: "transcribe.cpp" as never }])).toEqual([
      `${bare.id}: unknown runtime transcribe.cpp`,
    ]);
  });

  test("a job that names one alone is refused before any download: they run only in the fusion preset", () => {
    const o = { catalog: MODELS, defaultModel: "auto" };
    const refused = (model: string) => {
      try {
        resolveModel({ model }, o);
      } catch (err) {
        return err as ModelRefused;
      }
      throw new Error(`${model} was accepted`);
    };
    const w = refused(WHISPER_LARGE_V3);
    expect([w.status, w.code, w.details.model]).toEqual([
      409,
      "preset_unavailable",
      WHISPER_LARGE_V3,
    ]);
    expect(w.message).toContain("runs only as one engine of the fusion preset");
    // The refusal names the preset that runs them.
    expect(refused(CANARY_1B_V2).details.preset).toBe("fusion");
    // In a fused list they are accepted.
    const fused = `rover-conf(${QWEN_ASR},${WHISPER_LARGE_V3},${CANARY_1B_V2})`;
    expect(resolveModel({ model: fused }, o).model).toBe(fused);
    // Positive control: the recognizers jobs run are still accepted.
    for (const id of [RECOGNIZER, QWEN_ASR]) {
      const m = MODELS.find((x) => x.id === id) as CatalogEntry;
      expect([id, runsJobs(m), resolveModel({ model: id }, o).model]).toEqual([id, true, id]);
    }
  });
});

/** The real model of a catalog id, when it is on disk at its pinned size. */
function realModel(id: string): string | null {
  const e = TRANSCRIBE_CPP_ENGINES[id];
  const pin = MODELS.find((m) => m.id === id)?.files[0];
  if (!e || !pin) return null;
  const path = modelFile(defaultModelsDir(), id, e.file);
  return existsSync(path) && statSync(path).size === pin.size ? path : null;
}

/** tests/fixtures/two-voices.wav: 16 kHz mono 16-bit. */
function twoVoices(): Float32Array {
  const bytes = readFileSync(join(import.meta.dir, "fixtures", "two-voices.wav"));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  while (o + 8 <= bytes.length) {
    const size = v.getUint32(o + 4, true);
    if (bytes.subarray(o, o + 4).toString() === "data") {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(o + 8 + i * 2, true) / 32768;
      return out;
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("two-voices.wav has no data chunk");
}

describe("the real engines, beside sherpa-onnx-node in one process", () => {
  for (const id of [WHISPER_LARGE_V3, CANARY_1B_V2]) {
    const path = realModel(id);
    test.skipIf(!path)(
      `${id} decodes the two-voices fixture (skipped: the ${id} model is not in the models folder)`,
      async () => {
        const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as {
          OfflineRecognizer?: unknown;
        };
        expect(typeof sherpa.OfflineRecognizer).toBe("function");
        // Whisper is told nothing, so the language it reports is its own detection; Canary is
        // told the user's one language, as it must be.
        const whisper = id === WHISPER_LARGE_V3;
        const e = createTranscribeCppEngine(
          id,
          defaultModelsDir(),
          whisper ? {} : { allowed: ["en"] },
        );
        try {
          await e.load();
          const h = await e.decode({
            samples: twoVoices(),
            lang: "auto",
            glossary: whisper ? ["Kubernetes"] : [],
          });
          expect(h.text.length).toBeGreaterThan(40);
          expect(h.text.toLowerCase()).toContain("migration");
          expect(h.lang).toBe("en");
          expect(h.words.length).toBeGreaterThan(20);
        } finally {
          await e.unload();
        }
      },
      120_000,
    );
  }
});
