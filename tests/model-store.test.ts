/**
 * Server mode's models on demand (docs/ux/SERVER.md section 12), below the API: which model a job
 * runs (SV-S1), the download a missing model starts and its limits (SV-M1, SV-M2), its retries
 * (SV-M3), the last-used ledger (SV-M4) and the sweep that deletes unused models (SV-M5). The
 * files come from a loopback registry; the clock is injected.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import {
  DAY_MS,
  ModelRefused,
  ModelStore,
  type ModelStoreOptions,
  resolveModel,
  USAGE_FILE,
} from "../src/main/server/model-store.ts";
import { until } from "./capture-helpers.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

const B = "test-recognizer-b";
const T = Date.UTC(2026, 8, 1, 12, 0, 0);

let reg: ModelRegistry;
let catalog: ModelSpecEntry[];

beforeAll(() => {
  reg = modelRegistry();
  catalog = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry(B, ["b.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
  ];
});

afterAll(() => reg.stop());

function entry(id: string): ModelSpecEntry {
  return catalog.find((m) => m.id === id) as ModelSpecEntry;
}

interface Rig {
  store: ModelStore;
  dir: string;
  logs: string[];
  clock: { t: number };
  settings: { autoDownload: boolean; maxGb: number; unusedDays: number; free: number };
  cleanup(): void;
}

function rig(o: Partial<ModelStoreOptions> & { installed?: string[] } = {}): Rig {
  const t = tempDir("akou-models-");
  const dir = join(t.dir, "models");
  mkdirSync(dir, { recursive: true });
  for (const id of o.installed ?? [RECOGNIZER, "silero-vad", NEMOTRON]) reg.install(dir, entry(id));
  const logs: string[] = [];
  const clock = { t: T };
  const settings = { autoDownload: true, maxGb: 40, unusedDays: 30, free: 1e12 };
  const store = new ModelStore({
    dir: () => dir,
    machine: () => catalog,
    catalog: () => catalog,
    autoDownload: () => settings.autoDownload,
    maxGb: () => settings.maxGb,
    unusedDays: () => settings.unusedDays,
    freeBytes: () => settings.free,
    now: () => clock.t,
    retryMs: [5, 5, 5],
    log: (_level, msg) => logs.push(msg),
    ...o,
  });
  return {
    store,
    dir,
    logs,
    clock,
    settings,
    cleanup: () => {
      store.close();
      t.cleanup();
    },
  };
}

function refusal(fn: () => unknown): ModelRefused {
  try {
    fn();
  } catch (err) {
    if (err instanceof ModelRefused) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("[SV-S1] which model a job runs: request, then server default, then hardware", () => {
  const o = (defaultModel: string) => ({ catalog, defaultModel });

  test("the request's model wins, then its preset, then server.default_model, then auto's fast", () => {
    expect(resolveModel({ model: B, preset: "auto" }, o(RECOGNIZER))).toEqual({
      model: B,
      preset: "custom",
      source: "request",
    });
    expect(resolveModel({ preset: "fast" }, o(B))).toEqual({
      model: RECOGNIZER,
      preset: "fast",
      source: "request",
    });
    expect(resolveModel({ preset: "auto" }, o(B))).toEqual({
      model: B,
      preset: "custom",
      source: "server_default",
    });
    expect(resolveModel({ preset: "auto" }, o("fast"))).toEqual({
      model: RECOGNIZER,
      preset: "fast",
      source: "server_default",
    });
    expect(resolveModel({}, o("auto"))).toEqual({
      model: RECOGNIZER,
      preset: "fast",
      source: "hardware",
    });
    // `auto` in the model field is no opinion too.
    expect(resolveModel({ model: "auto" }, o(B)).source).toBe("server_default");
  });

  test("an unknown model is 422 unknown_model naming the field; an unbuilt preset keeps 409", () => {
    const unknown = refusal(() => resolveModel({ model: "nope" }, o("auto")));
    expect([unknown.status, unknown.code, unknown.details.field]).toEqual([
      422,
      "unknown_model",
      "model",
    ]);
    const unbuilt = refusal(() => resolveModel({ model: "best" }, o("auto")));
    expect([unbuilt.status, unbuilt.code]).toEqual([409, "preset_unavailable"]);
    const engine = refusal(() => resolveModel({ model: "qwen3-asr-1.7b" }, o("auto")));
    expect([engine.status, engine.code, engine.details.preset]).toEqual([
      409,
      "preset_unavailable",
      "best",
    ]);
    // A helper model is in the catalog but is no recognizer.
    expect(refusal(() => resolveModel({ model: "silero-vad" }, o("auto"))).code).toBe(
      "unknown_model",
    );
  });

  test("a server default this version does not know is the server's problem: 409, never 422", () => {
    const r = refusal(() => resolveModel({ preset: "auto" }, o("gone-model")));
    expect([r.status, r.code, r.details.setting]).toEqual([
      409,
      "preset_unavailable",
      "server.default_model",
    ]);
  });

  test("the OpenAI door: a name akou does not know (whisper-1) is no opinion", () => {
    const lenient = { catalog, defaultModel: B, unknownIsAuto: true };
    expect(resolveModel({ model: "whisper-1" }, lenient)).toMatchObject({
      model: B,
      source: "server_default",
    });
    expect(resolveModel({ model: RECOGNIZER }, lenient)).toMatchObject({
      model: RECOGNIZER,
      preset: "fast",
      source: "request",
    });
    // Positive control: the jobs route refuses the same name.
    expect(refusal(() => resolveModel({ model: "whisper-1" }, o(B))).code).toBe("unknown_model");
  });
});

describe("[SV-M1] a missing model is fetched once, whoever waits on it", () => {
  test("needs() is the recognizer with the helpers, never the other recognizer", () => {
    const r = rig();
    try {
      expect(r.store.needs(B).sort()).toEqual([B, NEMOTRON, "silero-vad"].sort());
      expect(r.store.missing(r.store.needs(B))).toEqual([B]);
      expect(r.store.missing(r.store.needs(RECOGNIZER))).toEqual([]);
    } finally {
      r.cleanup();
    }
  });

  test("two fetches of one model make one download; progress grows; the end is announced once", async () => {
    const r = rig();
    const release = reg.hold("b.onnx", 1024);
    const before = reg.hits.get("b.onnx") ?? 0;
    const ends: unknown[] = [];
    r.store.onEnd((e) => ends.push(e));
    try {
      r.store.fetch([B]);
      r.store.fetch([B, RECOGNIZER]);
      await until(async () => (r.store.waiting([B])?.bytes ?? 0) >= 1024, 5000, "first bytes");
      expect(r.store.waiting([B])).toEqual({ model: B, bytes: 1024, total: 4096 });
      expect(r.store.downloading()).toEqual([B]);
      release();
      await until(async () => ends.length === 1, 5000, "download end");
      expect(ends).toEqual([{ model: B, ok: true }]);
      expect(r.store.waiting([B])).toBeNull();
      expect(r.store.missing([B])).toEqual([]);
      expect((reg.hits.get("b.onnx") ?? 0) - before).toBe(1);
      // A finished download counts as a use (SV-M4).
      expect(r.store.ledger()[B]).toBe(T);
    } finally {
      release();
      r.cleanup();
    }
  });

  test("with server.auto_download off a missing model is refused with the pull line", () => {
    const r = rig();
    try {
      r.settings.autoDownload = false;
      const e = refusal(() => r.store.admit([B]));
      expect([e.status, e.code, e.details.model, e.details.run]).toEqual([
        409,
        "preset_unavailable",
        B,
        `akou models pull ${B}`,
      ]);
      // Present models need no download, so nothing refuses them.
      r.store.admit(r.store.needs(RECOGNIZER));
    } finally {
      r.cleanup();
    }
  });
});

describe("[SV-M2] on-demand downloads stop at the size cap and at low free space", () => {
  test("over server.models_max_gb: 409 reason models_max_gb, nothing fetched; raising the cap admits it", () => {
    const r = rig();
    const before = reg.hits.get("b.onnx") ?? 0;
    try {
      // Three 4096-byte models are on disk; B needs 4096 more.
      r.settings.maxGb = (3 * 4096 + 4096 - 1) / 1e9;
      const e = refusal(() => r.store.admit([B]));
      expect([e.status, e.code, e.details.reason, e.details.model, e.details.bytes]).toEqual([
        409,
        "preset_unavailable",
        "models_max_gb",
        B,
        4096,
      ]);
      expect(reg.hits.get("b.onnx") ?? 0).toBe(before);
      r.settings.maxGb = (3 * 4096 + 4096) / 1e9;
      r.store.admit([B]);
      r.settings.maxGb = 0;
      r.store.admit([B]);
    } finally {
      r.cleanup();
    }
  });

  test("too little free space for the download plus 1 GB: 409 reason disk_full", () => {
    const r = rig();
    try {
      r.settings.maxGb = 0;
      r.settings.free = 1e9 + 4095;
      const e = refusal(() => r.store.admit([B]));
      expect([e.code, e.details.reason, e.details.bytes]).toEqual([
        "preset_unavailable",
        "disk_full",
        4096,
      ]);
      r.settings.free = 1e9 + 4096;
      r.store.admit([B]);
    } finally {
      r.cleanup();
    }
  });
});

describe("[SV-M3] a failed download is retried, then fails for good", () => {
  test("a registry answering 500 every time: four tries, then one failed end naming the model and cause", async () => {
    const r = rig();
    const before = reg.hits.get("b.onnx") ?? 0;
    reg.failNext("b.onnx", Number.POSITIVE_INFINITY);
    const ends: { model: string; ok: boolean; error?: string }[] = [];
    r.store.onEnd((e) => ends.push(e));
    try {
      r.store.fetch([B]);
      await until(async () => ends.length === 1, 5000, "download failed");
      expect(ends[0]).toMatchObject({ model: B, ok: false });
      expect(ends[0]?.error).toContain("HTTP 500");
      expect((reg.hits.get("b.onnx") ?? 0) - before).toBe(4);
      expect(r.store.downloading()).toEqual([]);
      // A later fetch starts afresh.
      reg.failNext("b.onnx", 0);
      r.store.fetch([B]);
      await until(async () => ends.length === 2, 5000, "second download");
      expect(ends[1]).toEqual({ model: B, ok: true });
    } finally {
      reg.failNext("b.onnx", 0);
      r.cleanup();
    }
  });

  test("a registry failing twice then serving: the download succeeds on the third try", async () => {
    const r = rig();
    const before = reg.hits.get("b.onnx") ?? 0;
    reg.failNext("b.onnx", 2);
    const ends: unknown[] = [];
    r.store.onEnd((e) => ends.push(e));
    try {
      r.store.fetch([B]);
      await until(async () => ends.length === 1, 5000, "download end");
      expect(ends).toEqual([{ model: B, ok: true }]);
      expect((reg.hits.get("b.onnx") ?? 0) - before).toBe(3);
    } finally {
      r.cleanup();
    }
  });

  test("a file whose SHA-256 does not match is never kept", async () => {
    const r = rig();
    const bad = reg.entry("test-recognizer-c", ["c.onnx"]);
    reg.corrupt("c.onnx");
    const withC = [...catalog, bad];
    const store = new ModelStore({
      dir: () => r.dir,
      machine: () => withC,
      catalog: () => withC,
      autoDownload: () => true,
      maxGb: () => 0,
      unusedDays: () => 30,
      freeBytes: () => 1e12,
      retryMs: [1, 1, 1],
      log: () => {},
    });
    const ends: { ok: boolean; error?: string }[] = [];
    store.onEnd((e) => ends.push(e));
    try {
      store.fetch(["test-recognizer-c"]);
      await until(async () => ends.length === 1, 5000, "download end");
      expect(ends[0]?.ok).toBe(false);
      expect(ends[0]?.error).toContain("does not match the pinned");
      expect(existsSync(join(r.dir, "test-recognizer-c", "c.onnx"))).toBe(false);
      expect(existsSync(join(r.dir, "test-recognizer-c", "c.onnx.part"))).toBe(false);
    } finally {
      store.close();
      r.cleanup();
    }
  });
});

describe("[SV-M4] the last-used ledger", () => {
  test("touch writes usage.json atomically; a folder with no entry is dated at the first sweep and kept", () => {
    const r = rig({ installed: [RECOGNIZER, B] });
    try {
      expect(existsSync(join(r.dir, USAGE_FILE))).toBe(false);
      expect(r.store.sweep(new Set())).toEqual([]);
      expect(r.store.ledger()).toEqual({ [RECOGNIZER]: T, [B]: T });
      expect(existsSync(join(r.dir, RECOGNIZER))).toBe(true);
      expect(existsSync(join(r.dir, B))).toBe(true);
      r.clock.t = T + 5_000;
      r.store.touch([B]);
      const file = JSON.parse(readFileSync(join(r.dir, USAGE_FILE), "utf8"));
      expect(file[B]).toBe(new Date(T + 5_000).toISOString());
      expect(file[RECOGNIZER]).toBe(new Date(T).toISOString());
    } finally {
      r.cleanup();
    }
  });

  test("a ledger that is not JSON is started again, never a crash", () => {
    const r = rig({ installed: [B] });
    try {
      writeFileSync(join(r.dir, USAGE_FILE), "{not json");
      expect(r.store.sweep(new Set())).toEqual([]);
      expect(r.store.ledger()[B]).toBe(T);
    } finally {
      r.cleanup();
    }
  });
});

describe("[SV-M5] models unused for server.models_unused_days are deleted", () => {
  test("31 days on: the unused model goes with one model.evicted line; a protected one stays; 0 is never", () => {
    const r = rig({ installed: [RECOGNIZER, B, "silero-vad", NEMOTRON] });
    try {
      r.store.sweep(new Set());
      r.clock.t = T + 31 * DAY_MS;
      r.settings.unusedDays = 0;
      expect(r.store.sweep(new Set())).toEqual([]);
      expect(existsSync(join(r.dir, B))).toBe(true);

      r.settings.unusedDays = 30;
      const protect = new Set(r.store.needs(RECOGNIZER));
      const gone = r.store.sweep(protect);
      expect(gone).toEqual([{ id: B, last_used_at: T, bytes: 4096 }]);
      expect(existsSync(join(r.dir, B))).toBe(false);
      expect(existsSync(join(r.dir, RECOGNIZER, "a.onnx"))).toBe(true);
      expect(r.logs.filter((l) => l.startsWith("model.evicted"))).toEqual([
        `model.evicted ${B} last_used_at ${new Date(T).toISOString()} bytes_freed 4096`,
      ]);
      expect(r.store.ledger()[B]).toBeUndefined();

      // Positive control: without the protected set the default's models go too.
      const unprotected = r.store.sweep(new Set()).map((g) => g.id);
      expect(unprotected.sort()).toEqual([RECOGNIZER, NEMOTRON, "silero-vad"].sort());
      expect(existsSync(join(r.dir, RECOGNIZER))).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  test("a model used 29 days ago stays, and a model still downloading is never deleted", async () => {
    const r = rig({ installed: [RECOGNIZER, "silero-vad", NEMOTRON] });
    const release = reg.hold("b.onnx", 1024);
    try {
      r.store.sweep(new Set());
      r.clock.t = T + 29 * DAY_MS;
      expect(r.store.sweep(new Set(r.store.needs(B)))).toEqual([]);
      // B's folder exists only as a partial download; it is not the sweep's to take.
      r.store.fetch([B]);
      await until(async () => (r.store.waiting([B])?.bytes ?? 0) >= 1024, 5000, "first bytes");
      r.clock.t = T + 400 * DAY_MS;
      const gone = r.store.sweep(new Set()).map((g) => g.id);
      expect(gone).not.toContain(B);
      expect(existsSync(join(r.dir, B))).toBe(true);
    } finally {
      release();
      r.cleanup();
    }
  });
});
