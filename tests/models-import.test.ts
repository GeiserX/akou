/**
 * `akou models import DIR` and `POST /models/import` (W3.19's "From a folder…"): every file is
 * copied in one pass that hashes what it reads, from `<dir>/<model>/<file>` or, when that one is
 * absent or wrong, `<dir>/<file>`, and moved into place only when its SHA-256 matches. The copy is
 * asynchronous: a model of several gigabytes never holds the thread that answers the API, and
 * while it runs `GET /models` shows the model downloading with its bytes so far, which Cancel
 * stops. The large files are generated; nothing is downloaded.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  type DownloadProgress,
  importModels,
  type ModelSpecEntry,
  modelFile,
  NEMOTRON,
  RECOGNIZER,
} from "../src/main/asr/models.ts";
import { ModelStore, STALE_COPY_MS } from "../src/main/server/model-store.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const MB = 1 << 20;
const BIG = "test-recognizer-big";

/** Writes `mb` MiB of a repeating pattern to `path`; answers its catalog file. */
function bigFile(path: string, name: string, mb: number, seed = 1): ModelSpecEntry["files"][0] {
  const chunk = Buffer.alloc(MB);
  for (let i = 0; i < MB; i++) chunk[i] = (i * 31 + seed) & 0xff;
  const h = createHash("sha256");
  const fd = openSync(path, "w");
  try {
    for (let i = 0; i < mb; i++) {
      writeSync(fd, chunk);
      h.update(chunk);
    }
  } finally {
    closeSync(fd);
  }
  return { name, url: "http://127.0.0.1:9/unused", sha256: h.digest("hex"), size: mb * MB };
}

function entryOf(id: string, files: ModelSpecEntry["files"]): ModelSpecEntry {
  return {
    id,
    job: "test",
    licence: "MIT",
    source: "test",
    files,
    onDemand: true,
  } as ModelSpecEntry;
}

/** Nothing half-copied stays behind: no `.import` file anywhere under `dir`. */
function leftovers(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".import"));
}

/** Yields to the event loop after its pending I/O, so a copy in flight moves one step. */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("[W3.19] a model imported from a folder is copied in one checked, asynchronous pass", () => {
  test("a wrong <dir>/<model>/<file> of the right size does not hide a good <dir>/<file>", async () => {
    const t = tempDir("akou-import-");
    try {
      const from = join(t.dir, "stick");
      mkdirSync(join(from, BIG), { recursive: true });
      const good = bigFile(join(from, "w.bin"), "w.bin", 1);
      // Same size, other bytes: its checksum fails, and the importer must try the next layout.
      bigFile(join(from, BIG, "w.bin"), "w.bin", 1, 7);
      const dir = join(t.dir, "models");
      const r = await importModels(from, dir, [entryOf(BIG, [good])]);
      expect(r).toEqual({ copied: [`${BIG}/w.bin`], missing: [] });
      const copied = await Bun.file(modelFile(dir, BIG, "w.bin")).arrayBuffer();
      expect(createHash("sha256").update(Buffer.from(copied)).digest("hex")).toBe(good.sha256);
      expect(leftovers(dir)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("a file whose SHA-256 does not match is never kept, and nothing half-copied stays", async () => {
    const t = tempDir("akou-import-");
    try {
      const from = join(t.dir, "stick");
      mkdirSync(from, { recursive: true });
      const spec = bigFile(join(from, "w.bin"), "w.bin", 1);
      const dir = join(t.dir, "models");
      const wrong = entryOf(BIG, [{ ...spec, sha256: "0".repeat(64) }]);
      expect(await importModels(from, dir, [wrong])).toEqual({
        copied: [],
        missing: [`${BIG}/w.bin`],
      });
      expect(existsSync(modelFile(dir, BIG, "w.bin"))).toBe(false);
      expect(leftovers(dir)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("the copy reports its bytes as a download does, and the event loop runs between them", async () => {
    const t = tempDir("akou-import-");
    try {
      const from = join(t.dir, "stick");
      mkdirSync(from, { recursive: true });
      const spec = bigFile(join(from, "w.bin"), "w.bin", 16);
      const seen: DownloadProgress[] = [];
      let turns = 0;
      let copying = true;
      // A loop that only runs when the copy gives the thread back: a synchronous copy starves it.
      const loop = (async () => {
        while (copying) {
          await tick();
          if (seen.length > 0 && (seen.at(-1) as DownloadProgress).bytes < spec.size) turns++;
        }
      })();
      const r = await importModels(from, join(t.dir, "models"), [entryOf(BIG, [spec])], {
        onProgress: (p) => seen.push(p),
      });
      copying = false;
      await loop;
      expect(r.copied).toEqual([`${BIG}/w.bin`]);
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.at(-1)).toEqual({
        model: BIG,
        name: "w.bin",
        bytes: spec.size,
        total: spec.size,
      });
      expect(turns).toBeGreaterThan(0);
    } finally {
      t.cleanup();
    }
  });

  test("a cancel during the last write installs nothing, and the files copied before it still count", async () => {
    const t = tempDir("akou-import-");
    try {
      const from = join(t.dir, "stick");
      mkdirSync(from, { recursive: true });
      const one = bigFile(join(from, "one.bin"), "one.bin", 2);
      const two = bigFile(join(from, "two.bin"), "two.bin", 2, 5);
      const dir = join(t.dir, "models");
      const stop = new AbortController();
      // Cancelled as the second file's last bytes land: no chunk is read after that.
      const r = await importModels(from, dir, [entryOf(BIG, [one, two])], {
        signal: stop.signal,
        onProgress: (p) => {
          if (p.name === "two.bin" && p.bytes === p.total) stop.abort();
        },
      });
      expect(r).toEqual({ copied: [`${BIG}/one.bin`], missing: [`${BIG}/two.bin`] });
      expect(existsSync(modelFile(dir, BIG, "one.bin"))).toBe(true);
      expect(existsSync(modelFile(dir, BIG, "two.bin"))).toBe(false);
      expect(leftovers(dir)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("the store shows a model being copied as downloading with its bytes, and Cancel stops it", async () => {
    const t = tempDir("akou-import-");
    try {
      const from = join(t.dir, "stick");
      mkdirSync(from, { recursive: true });
      const spec = bigFile(join(from, "w.bin"), "w.bin", 32);
      const big = entryOf(BIG, [spec]);
      const dir = join(t.dir, "models");
      mkdirSync(dir, { recursive: true });
      const logs: string[] = [];
      const store = new ModelStore({
        dir: () => dir,
        machine: () => [big],
        catalog: () => [big],
        autoDownload: () => false,
        maxGb: () => 40,
        unusedDays: () => 30,
        log: (_l, msg) => logs.push(msg),
      });
      try {
        expect(store.state(BIG)).toBe("missing");
        let settled = false;
        const run = store.import(from).finally(() => {
          settled = true;
        });
        let mid = 0;
        while (!settled) {
          const s = store.size(BIG);
          if (s.bytes > 0 && s.bytes < s.size) {
            mid = s.bytes;
            break;
          }
          await tick();
        }
        expect(mid).toBeGreaterThan(0);
        expect(store.size(BIG).size).toBe(spec.size);
        expect(store.cancel(BIG, "test")).toBe(true);
        expect(await run).toEqual({ copied: [], missing: [`${BIG}/w.bin`] });
        expect(store.state(BIG)).toBe("missing");
        expect(leftovers(dir)).toEqual([]);
        expect(logs).toContain(`model.import ${BIG} cancelled key test`);
        // Two imports at once run one after the other: each owns the model while it copies, so
        // Cancel stops the first and the second still lands the model.
        const first = store.import(from);
        const second = store.import(from);
        while (store.size(BIG).bytes === 0) await tick();
        // A delete while it copies is refused: removing the folder would fail the copy.
        expect(() => store.delete(BIG, { defaults: new Set(), inUse: new Set() }, "test")).toThrow(
          /downloading/,
        );
        expect(store.cancel(BIG, "test")).toBe(true);
        expect(await first).toEqual({ copied: [], missing: [`${BIG}/w.bin`] });
        expect(await second).toEqual({ copied: [`${BIG}/w.bin`], missing: [] });
        expect(store.state(BIG)).toBe("ready");
        expect(store.cancel(BIG, "test")).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("[W3.19] a copy cut short by quitting leaves nothing behind", () => {
  function store(dir: string, big: ModelSpecEntry): ModelStore {
    return new ModelStore({
      dir: () => dir,
      machine: () => [big],
      catalog: () => [big],
      autoDownload: () => false,
      maxGb: () => 40,
      unusedDays: () => 30,
      log: () => {},
    });
  }

  test("closing the store stops a copy in flight, and its temporary file goes", async () => {
    const t = tempDir("akou-import-");
    try {
      const from = join(t.dir, "stick");
      mkdirSync(from, { recursive: true });
      const big = entryOf(BIG, [bigFile(join(from, "w.bin"), "w.bin", 32)]);
      const dir = join(t.dir, "models");
      mkdirSync(dir, { recursive: true });
      const s = store(dir, big);
      const run = s.import(from);
      while (s.size(BIG).bytes === 0) await tick();
      expect(leftovers(dir).length).toBe(1);
      s.close();
      expect(await run).toEqual({ copied: [], missing: [`${BIG}/w.bin`] });
      expect(existsSync(modelFile(dir, BIG, "w.bin"))).toBe(false);
      expect(leftovers(dir)).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("a store that starts deletes the temporary files of copies that never ended, but not a fresh one", () => {
    const t = tempDir("akou-import-");
    try {
      const dir = join(t.dir, "models");
      mkdirSync(join(dir, BIG), { recursive: true });
      // A copy killed with akou: the process died before its own cleanup ran.
      const stale = join(dir, BIG, "w.bin.0a1b2c3d.import");
      const old = join(dir, BIG, "w.bin.import");
      // Another process's copy, still being written.
      const fresh = join(dir, BIG, "w.bin.9f8e7d6c.import");
      const model = join(dir, BIG, "w.bin");
      for (const f of [stale, old, fresh, model]) writeFileSync(f, "x");
      const past = (Date.now() - STALE_COPY_MS - 5_000) / 1000;
      for (const f of [stale, old, model]) utimesSync(f, past, past);
      store(dir, entryOf(BIG, [])).close();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      // Control: the model file itself, as old as the stale ones, is never touched.
      expect(existsSync(model)).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});

describe("[W3.19] POST /models/import of a large model never holds the app", () => {
  let reg: ModelRegistry;
  let rig: AppRig;
  let spec: ModelSpecEntry["files"][0];
  const home = tempDir("akou-import-app-");
  const stick = join(home.dir, "stick");

  beforeAll(async () => {
    reg = modelRegistry();
    mkdirSync(stick, { recursive: true });
    spec = bigFile(join(stick, "big.bin"), "big.bin", 128);
    const catalog: ModelSpecEntry[] = [
      reg.entry(RECOGNIZER, ["a.onnx"]),
      reg.entry("silero-vad", ["vad.onnx"]),
      reg.entry(NEMOTRON, ["diar.onnx"]),
      entryOf(BIG, [spec]),
    ];
    const models = join(home.dir, "models");
    mkdirSync(models, { recursive: true });
    for (const m of catalog.slice(0, 3)) reg.install(models, m);
    rig = await appRig({
      modelRegistry: catalog,
      models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
      settings: { "asr.modelsDir": models, "asr.diarizer": "nemotron" },
    });
  });

  afterAll(async () => {
    await rig?.close();
    reg?.stop();
    home.cleanup();
  });

  test("GET /status answers while a 128 MB file is being copied, and GET /models shows its bytes", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
    const row = async (): Promise<any> =>
      // biome-ignore lint/suspicious/noExplicitAny: as above.
      (await rig.api("GET", "/models")).body.models.find((m: any) => m.id === BIG);
    const copying = (r: { state: string; bytes: number; size: number }) =>
      r.state === "downloading" && r.bytes > 0 && r.bytes < r.size;
    expect((await row()).state).toBe("missing");
    let done = false;
    const imp = rig.api("POST", "/models/import", { dir: stick }).finally(() => {
      done = true;
    });
    // A status answered between two reads that both show the copy unfinished was answered while
    // the file was being copied. A synchronous copy shows no read in between.
    let during = 0;
    let before = await row();
    while (!done) {
      const status = await rig.api("GET", "/status");
      const after = await row();
      if (status.status === 200 && copying(before) && copying(after)) during++;
      before = after;
    }
    const r = await imp;
    expect(r.status).toBe(200);
    expect(r.body.copied).toEqual([`${BIG}/big.bin`]);
    expect(during).toBeGreaterThan(0);
    expect((await row()).state).toBe("ready");
  });
});
