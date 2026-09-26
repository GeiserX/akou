/**
 * `akou models pull <preset|model>` with no app running (docs/ux/SERVER.md SV-P3): an image build or
 * an entrypoint pulls before the server starts. The files come from a loopback server that counts
 * every request, named after the real model ids so the preset table is the real one; the bytes are
 * tiny stand-ins with their own SHA-256.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { PRESET_NAMES, presetModels } from "../src/main/asr/presets.ts";
import { EXIT } from "../src/main/cli/client.ts";
import { cli } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const bodies: Record<string, Uint8Array> = {
  "encoder.onnx": new TextEncoder().encode("a stand-in encoder\n"),
  "tokens.txt": new TextEncoder().encode("a stand-in token list\n"),
  "silero_vad.onnx": new TextEncoder().encode("a stand-in VAD\n"),
  "nemotron3_diar_v3.onnx": new TextEncoder().encode("a stand-in diarizer\n"),
};
const hits = new Map<string, number>();
let server: ReturnType<typeof Bun.serve>;
let registry: ModelSpecEntry[];

function entry(id: string, names: string[]): ModelSpecEntry {
  return {
    id,
    job: "test",
    licence: "MIT",
    source: "test",
    files: names.map((name) => {
      const b = bodies[name] as Uint8Array;
      return {
        name,
        url: `http://127.0.0.1:${server.port}/${name}`,
        sha256: createHash("sha256").update(b).digest("hex"),
        size: b.length,
      };
    }),
  };
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const name = new URL(req.url).pathname.slice(1);
      hits.set(name, (hits.get(name) ?? 0) + 1);
      const b = bodies[name];
      return b ? new Response(b) : new Response("no", { status: 404 });
    },
  });
  registry = [
    entry(RECOGNIZER, ["encoder.onnx", "tokens.txt"]),
    entry("silero-vad", ["silero_vad.onnx"]),
    entry(NEMOTRON, ["nemotron3_diar_v3.onnx"]),
  ];
});

afterAll(() => {
  server.stop(true);
});

/** An empty home and models volume, with no app running and none launchable. */
function volume() {
  const t = tempDir();
  const models = join(t.dir, "models");
  const env = { ...process.env, AKOU_HOME: t.dir, AKOU_MODELS_DIR: models, AKOU_URL: undefined };
  return { t, models, env };
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function count(): Record<string, number> {
  return Object.fromEntries(Object.keys(bodies).map((n) => [n, hits.get(n) ?? 0]));
}

describe("[SV-P3] models pull by preset or model, with no app", () => {
  test("pull fast on an empty volume leaves every file the server loads before it transcribes, with matching SHA-256; a second run downloads nothing; a truncated file is re-fetched", async () => {
    const v = volume();
    const before = count();
    const first = await cli(v.env, ["models", "pull", "fast", "--json"], { models: registry });
    expect([first.code, first.err]).toEqual([0, ""]);
    // The recognizer starts only once every model this machine's settings need is there (the
    // speaker models included), so fast fetches all of them: fewer and the server never transcribes.
    expect(first.json).toMatchObject({
      ok: true,
      preset: "fast",
      models: [RECOGNIZER, "silero-vad", NEMOTRON],
    });
    for (const f of (registry[0] as ModelSpecEntry).files) {
      const path = join(v.models, RECOGNIZER, f.name);
      expect(sha(path)).toBe(f.sha256);
    }
    const afterFirst = count();
    expect(afterFirst["encoder.onnx"]).toBe((before["encoder.onnx"] ?? 0) + 1);
    expect(afterFirst["silero_vad.onnx"]).toBe((before["silero_vad.onnx"] ?? 0) + 1);
    expect(afterFirst["nemotron3_diar_v3.onnx"]).toBe((before["nemotron3_diar_v3.onnx"] ?? 0) + 1);
    expect(existsSync(join(v.models, NEMOTRON, "nemotron3_diar_v3.onnx"))).toBe(true);
    // No app was started to do it.
    expect(existsSync(join(v.t.dir, ".config", "akou", "runtime.json"))).toBe(false);

    const second = await cli(v.env, ["models", "pull", "fast", "--json"], { models: registry });
    expect(second.code).toBe(0);
    expect(count()).toEqual(afterFirst);

    const encoder = join(v.models, RECOGNIZER, "encoder.onnx");
    writeFileSync(encoder, readFileSync(encoder).subarray(0, 5));
    const third = await cli(v.env, ["models", "pull", "fast"], { models: registry });
    expect(third.code).toBe(0);
    expect(third.out).toContain("fast");
    expect(sha(encoder)).toBe((registry[0] as ModelSpecEntry).files[0]?.sha256 as string);
    expect(count()).toEqual({
      ...afterFirst,
      "encoder.onnx": (afterFirst["encoder.onnx"] ?? 0) + 1,
    });
    v.t.cleanup();
  });

  test("a model id pulls that model only", async () => {
    const v = volume();
    const before = count();
    const r = await cli(v.env, ["models", "pull", NEMOTRON, "--json"], { models: registry });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, models: [NEMOTRON] });
    expect(count()).toEqual({
      ...before,
      "nemotron3_diar_v3.onnx": (before["nemotron3_diar_v3.onnx"] ?? 0) + 1,
    });
    expect(existsSync(join(v.models, RECOGNIZER))).toBe(false);
    v.t.cleanup();
  });

  test("auto pulls what it resolves to on this machine, which is fast until hardware detection exists", async () => {
    const machine = [RECOGNIZER, "silero-vad", NEMOTRON];
    expect(presetModels("auto", machine)).toEqual({ preset: "auto", models: machine });
    expect(presetModels("fast", machine)).toEqual({ preset: "fast", models: machine });
    const v = volume();
    const r = await cli(v.env, ["models", "pull", "auto", "--json"], { models: registry });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ preset: "auto", models: machine });
    v.t.cleanup();
  });

  test("a preset with no engine yet exits 69, says so, and downloads nothing", async () => {
    for (const p of ["lite", "best", "fusion"]) {
      const v = volume();
      const before = count();
      const r = await cli(v.env, ["models", "pull", p], { models: registry });
      expect(r.code).toBe(EXIT.unavailable);
      expect(r.err).toContain(`the ${p} preset has no engine in this version`);
      expect(count()).toEqual(before);
      v.t.cleanup();
    }
  });

  test("an unknown name exits 64 and lists the presets; positive control: every preset name is known", async () => {
    const v = volume();
    const r = await cli(v.env, ["models", "pull", "fastest"], { models: registry });
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("lite, fast, best, fusion, auto");
    expect([...PRESET_NAMES]).toEqual(["lite", "fast", "best", "fusion", "auto"]);
    for (const p of PRESET_NAMES) expect(presetModels(p, [])).toBeDefined();
    v.t.cleanup();
  });

  test("fast pulls exactly what the server waits for before it starts the recognizer, for either diarizer", async () => {
    const { MODELS, modelsFor } = await import("../src/main/asr/models.ts");
    for (const d of ["nemotron", "embeddings"] as const) {
      const machine = modelsFor(d).map((m) => m.id);
      const m = presetModels("fast", machine);
      expect("models" in m && m.models).toEqual(machine);
      for (const id of machine) expect(MODELS.map((x) => x.id)).toContain(id);
    }
    // Positive control: the two diarizers need different files, so the list is not a constant.
    expect(modelsFor("nemotron").map((m) => m.id)).not.toEqual(
      modelsFor("embeddings").map((m) => m.id),
    );
  });
});
