/**
 * The voices file (`src/main/voices/store.ts`): one local file of voiceprints of the people the
 * user named. Written atomically at mode 0600 under a per-file lock, every string quoted, 8
 * exemplars per person, nothing kept past 3 years, and a vector of another embedder never
 * compared ([VO-3]).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { patchConfig, resolvePaths, SETTINGS } from "../src/main/config/schema.ts";
import {
  decodeVec,
  type Exemplar,
  encodeVec,
  MAX_DIM,
  MAX_EXEMPLARS,
  MAX_FILE_BYTES,
  MAX_PEOPLE,
  type Person,
  parseVoices,
  serializeVoices,
  VoiceStore,
  VoicesError,
  voicesPath,
} from "../src/main/voices/store.ts";
import { tempDir } from "./helpers.ts";

const MODEL = "titanet-small";
const DIM = 4;
/** A fixed now, passed to every store, so no fixture expires with the calendar. */
const NOW = Date.parse("2026-11-27T10:00:00.000Z");
const DAY = 86_400_000;

function ex(over: Partial<Exemplar> & { call: string; spk?: string }, days = 0): Exemplar {
  return {
    model: MODEL,
    dim: DIM,
    vec: new Float32Array([1, 2, 3, 4]),
    secs: 42.5,
    cons: 0.9,
    spk: "c1",
    at: new Date(NOW - days * DAY).toISOString(),
    ...over,
  };
}

function rig() {
  const t = tempDir("akou-voices-");
  const path = voicesPath(t.dir);
  const logs: string[] = [];
  const store = new VoiceStore(path, { now: () => NOW, log: (m) => logs.push(m) });
  return { ...t, path, store, logs };
}

const names = async (s: VoiceStore) => (await s.list()).map((p) => p.name);

describe("voices store", () => {
  test("lives in the config folder as voices.yaml", () => {
    expect(voicesPath("/cfg")).toBe(join("/cfg", "voices.yaml"));
  });

  test("an atomic write at mode 0600 leaves no temporary file", async () => {
    const r = rig();
    await r.store.upsert("Ben", ex({ call: "a" }));
    expect(existsSync(r.path)).toBe(true);
    if (process.platform !== "win32") expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(r.dir)).toEqual(["voices.yaml"]);
    await r.store.upsert("Ana", ex({ call: "b" }));
    expect(readdirSync(r.dir)).toEqual(["voices.yaml"]);
    if (process.platform !== "win32") expect(statSync(r.path).mode & 0o777).toBe(0o600);
    r.cleanup();
  });

  test("a missing file is no people, and reading never creates it", async () => {
    const r = rig();
    expect(await r.store.load(MODEL, DIM)).toEqual({ people: [], skipped: 0 });
    expect(await r.store.list()).toEqual([]);
    expect(existsSync(r.path)).toBe(false);
    r.cleanup();
  });

  test("round trip: names that look like YAML come back as the same strings", async () => {
    const r = rig();
    const odd = ["No", "true", "null", "1.5", 'Ann "A" O\'Neil: #1', "José Ñúñez", "- x"];
    for (const [i, n] of odd.entries()) await r.store.upsert(n, ex({ call: `call-${i}` }));
    expect(await names(r.store)).toEqual(odd);
    const text = readFileSync(r.path, "utf8");
    expect(text).toContain('name: "No"');
    expect(text).toContain('name: "true"');
    const { people } = parseVoices(text, NOW);
    expect(serializeVoices(people)).toBe(text);
    const loaded = await r.store.load(MODEL, DIM);
    const v = loaded.people[0]?.exemplars[0]?.vec as Float32Array;
    // Kept at unit length.
    expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    expect(v[3] as number).toBeCloseTo(4 / Math.hypot(1, 2, 3, 4), 6);
    r.cleanup();
  });

  test("a vector is base64 of little-endian float32 and nothing else", () => {
    const v = new Float32Array([0.5, -0.25, 1, 0]);
    const s = encodeVec(v);
    expect(decodeVec(s, 4)).toEqual(v);
    expect(decodeVec(s, 3)).toBeNull();
    expect(decodeVec(`${s}!`, 4)).toBeNull();
  });

  test("a person keeps the 8 newest exemplars", async () => {
    const r = rig();
    for (let i = 0; i < 12; i++) await r.store.upsert("Ben", ex({ call: `c${i}` }, 12 - i));
    const [ben] = await r.store.list();
    expect(ben?.calls).toHaveLength(MAX_EXEMPLARS);
    // Newest first: the four oldest calls are gone.
    expect(ben?.calls).toEqual(["c11", "c10", "c9", "c8", "c7", "c6", "c5", "c4"]);
    expect(ben?.lastSeen).toBe(new Date(NOW - DAY).toISOString());
    expect(ben?.secs).toBe(42.5 * 8);
    // Positive control: under the cap nothing is dropped.
    await r.store.upsert("Ana", ex({ call: "x1" }, 3));
    await r.store.upsert("Ana", ex({ call: "x2" }, 2));
    expect((await r.store.list())[1]?.calls).toEqual(["x2", "x1"]);
    r.cleanup();
  });

  test("an exemplar older than 3 years is dropped at load and leaves the file", async () => {
    const r = rig();
    await r.store.upsert("Ben", ex({ call: "recent" }, 30));
    await r.store.upsert("Ben", ex({ call: "edge" }, 3 * 365));
    // Written by an earlier akou, when it was not yet old.
    const old = parseVoices(readFileSync(r.path, "utf8"), NOW).people;
    old[0]?.exemplars.push(ex({ call: "old" }, 3 * 366 + 2));
    old.push({ name: "Gone", exemplars: [ex({ call: "older", spk: "c2" }, 4 * 365)] });
    writeFileSync(r.path, serializeVoices(old));
    const loaded = await r.store.load(MODEL, DIM);
    expect(loaded.people.map((p) => [p.name, p.exemplars.map((e) => e.call)])).toEqual([
      ["Ben", ["recent", "edge"]],
    ]);
    expect(r.logs.some((l) => l.includes("dropped 2"))).toBe(true);
    // The file was rewritten without them: no vector of theirs stays on disk.
    const text = readFileSync(r.path, "utf8");
    expect(text).not.toContain('"old"');
    expect(text).not.toContain('"older"');
    expect(text).not.toContain('name: "Gone"');
    expect(text).toContain('"edge"');
    r.cleanup();
  });

  test("an exemplar older than 3 years is refused at upsert with a plain error", async () => {
    const r = rig();
    await expect(r.store.upsert("Old", ex({ call: "a" }, 3 * 366 + 2))).rejects.toThrow(
      /older than 3 years is not kept/,
    );
    expect(existsSync(r.path)).toBe(false);
    // Positive control: a day inside the 3 years is kept.
    await r.store.upsert("Old", ex({ call: "a" }, 3 * 365 - 1));
    expect(await names(r.store)).toEqual(["Old"]);
    r.cleanup();
  });

  test("upsert is keyed by call and speaker and moves the exemplar from another person", async () => {
    const r = rig();
    await r.store.upsert("Ben", ex({ call: "a", spk: "c1" }));
    await r.store.upsert("Ben", ex({ call: "a", spk: "c2" }));
    await r.store.upsert("Ana", ex({ call: "a", spk: "c1", secs: 60 }));
    const list = await r.store.list();
    expect(list.map((p) => [p.name, p.calls, p.secs])).toEqual([
      ["Ben", ["a"], 42.5],
      ["Ana", ["a"], 60],
    ]);
    // The same key again replaces, never adds.
    await r.store.upsert("Ana", ex({ call: "a", spk: "c1", secs: 70 }));
    expect((await r.store.list())[1]?.secs).toBe(70);
    // A person whose last exemplar moved away is gone.
    await r.store.upsert("Ana", ex({ call: "a", spk: "c2" }));
    expect(await names(r.store)).toEqual(["Ana"]);
    r.cleanup();
  });

  test("removeExemplar drops one call's speaker", async () => {
    const r = rig();
    await r.store.upsert("Ben", ex({ call: "a", spk: "c1" }));
    await r.store.upsert("Ben", ex({ call: "b", spk: "c1" }));
    expect(await r.store.removeExemplar("a", "c1")).toBe(true);
    expect(await r.store.removeExemplar("a", "c1")).toBe(false);
    expect((await r.store.list())[0]?.calls).toEqual(["b"]);
    r.cleanup();
  });

  test("rename joins two people into one, keeping the newest 8", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) await r.store.upsert("Ben O", ex({ call: `o${i}` }, 20 - i));
    for (let i = 0; i < 5; i++) await r.store.upsert("Ben", ex({ call: `b${i}` }, 10 - i));
    await r.store.upsert("Ana", ex({ call: "z" }));
    // Ten exemplars meet a cap of 8: the two oldest are dropped and counted.
    expect(await r.store.rename("Ben O", "Ben")).toEqual({ dropped: 2 });
    const list = await r.store.list();
    expect(list.map((p) => p.name)).toEqual(["Ben", "Ana"]);
    expect(list[0]?.calls).toEqual(["b4", "b3", "b2", "b1", "b0", "o4", "o3", "o2"]);
    // A plain rename keeps the place; an unknown name changes nothing.
    expect(await r.store.rename("Ana", "Ana Ruiz")).toEqual({ dropped: 0 });
    expect(await names(r.store)).toEqual(["Ben", "Ana Ruiz"]);
    expect(await r.store.rename("Nobody", "X")).toBeNull();
    await expect(r.store.rename("Ben", "  ")).rejects.toThrow(VoicesError);
    r.cleanup();
  });

  test("forget removes a person and every vector of theirs", async () => {
    const r = rig();
    await r.store.upsert("Ben", ex({ call: "a" }));
    await r.store.upsert("Ana", ex({ call: "b", vec: new Float32Array([4, 3, 2, 1]) }));
    const anaVec = encodeVec(
      (await r.store.load(MODEL, DIM)).people[1]?.exemplars[0]?.vec as Float32Array,
    );
    expect(readFileSync(r.path, "utf8")).toContain(anaVec);
    expect(await r.store.forget("Ana")).toBe(true);
    expect(await r.store.forget("Ana")).toBe(false);
    expect(await names(r.store)).toEqual(["Ben"]);
    expect(readFileSync(r.path, "utf8")).not.toContain(anaVec);
    expect(readFileSync(r.path, "utf8")).not.toContain('name: "Ana"');
    r.cleanup();
  });

  test("[VO-4] forgetCall drops every exemplar one call taught, from every person, and keeps the rest", async () => {
    const r = rig();
    await r.store.upsert("Ben", ex({ call: "purged", spk: "c1" }));
    await r.store.upsert("Ben", ex({ call: "kept", spk: "c1" }));
    await r.store.upsert("Ana", ex({ call: "purged", spk: "c2" }));
    expect(await r.store.forgetCall("purged")).toBe(2);
    const list = await r.store.list();
    expect(list.map((p) => [p.name, p.calls])).toEqual([["Ben", ["kept"]]]);
    expect(readFileSync(r.path, "utf8")).not.toContain('"purged"');
    // Positive control: a call nobody taught changes nothing.
    expect(await r.store.forgetCall("other")).toBe(0);
    expect(await r.store.list()).toEqual(list);
    r.cleanup();
  });

  test("forgetAll deletes the file", async () => {
    const r = rig();
    await r.store.upsert("Ben", ex({ call: "a" }));
    expect(await r.store.forgetAll()).toBe(true);
    expect(existsSync(r.path)).toBe(false);
    expect(await r.store.forgetAll()).toBe(false);
    expect(await r.store.list()).toEqual([]);
    r.cleanup();
  });

  test("a temporary file left by a killed write is removed by the next edit and by forget all", async () => {
    const r = rig();
    // The pid of a process that has ended.
    const dead = Bun.spawnSync([process.execPath, "-e", ""]).pid;
    const stale = (pid: number) => join(r.dir, `.voices.yaml.${pid}.${crypto.randomUUID()}.tmp`);
    await r.store.upsert("Ben", ex({ call: "a" }));
    const held = readFileSync(r.path, "utf8");
    writeFileSync(stale(dead), held);
    expect(await r.store.forgetAll()).toBe(true);
    expect(readdirSync(r.dir)).toEqual([]);
    // Any edit sweeps them, a read included: ours and a dead process's go.
    writeFileSync(stale(dead), held);
    writeFileSync(stale(process.pid), held);
    // Positive control: a write in flight in another running process keeps its file.
    const live = stale(process.ppid);
    writeFileSync(live, held);
    await r.store.forget("Ben");
    expect(readdirSync(r.dir)).toEqual([live.slice(r.dir.length + 1)]);
    r.cleanup();
  });

  test("list never carries a vector", async () => {
    const r = rig();
    await r.store.upsert("Ben", ex({ call: "a" }));
    const list = await r.store.list();
    expect(Object.keys(list[0] as object).sort()).toEqual(["calls", "lastSeen", "name", "secs"]);
    expect(JSON.stringify(list)).not.toContain(encodeVec(new Float32Array([1, 2, 3, 4])));
    r.cleanup();
  });

  test("concurrent upserts under the lock lose nothing, across two stores on one file", async () => {
    const r = rig();
    const other = new VoiceStore(r.path, { now: () => NOW, log: () => {} });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 ? other : r.store).upsert(`P${i % 10}`, ex({ call: `k${i}`, spk: "c1" }, i)),
      ),
    );
    const list = await r.store.list();
    expect(list).toHaveLength(10);
    expect(list.reduce((n, p) => n + p.calls.length, 0)).toBe(40);
    expect(readdirSync(r.dir)).toEqual(["voices.yaml"]);
    r.cleanup();
  });

  test("[VO-3] an exemplar of another model or size is skipped at load and kept in the file", async () => {
    const r = rig();
    await r.store.upsert("Ben", ex({ call: "a", spk: "c1" }));
    await r.store.upsert("Ben", ex({ call: "b", spk: "c1", model: "campplus" }));
    await r.store.upsert(
      "Ana",
      ex({ call: "c", spk: "c1", dim: 3, vec: new Float32Array([1, 2, 3]) }),
    );
    const got = await r.store.load(MODEL, DIM);
    expect(got.skipped).toBe(2);
    expect(got.people.map((p) => [p.name, p.exemplars.map((e) => e.call)])).toEqual([
      ["Ben", ["a"]],
    ]);
    for (const p of got.people)
      for (const e of p.exemplars) {
        expect(e.model).toBe(MODEL);
        expect(e.vec.length).toBe(DIM);
      }
    expect(r.logs.filter((l) => l.includes("skipped 2"))).toHaveLength(1);
    // Nothing was deleted: the other embedder still finds its own.
    expect((await r.store.load("campplus", DIM)).people.map((p) => p.name)).toEqual(["Ben"]);
    expect((await r.store.load(MODEL, 3)).people.map((p) => p.name)).toEqual(["Ana"]);
    // Positive control: the same vector tagged with the running model and size loads.
    await r.store.upsert("Ben", ex({ call: "b", spk: "c1" }));
    const fixed = await r.store.load(MODEL, DIM);
    expect(fixed.people[0]?.exemplars.map((e) => e.call).sort()).toEqual(["a", "b"]);
    r.cleanup();
  });

  test("a file over 4 MB is refused and never written over", async () => {
    const r = rig();
    writeFileSync(r.path, `version: 1\n# ${"x".repeat(MAX_FILE_BYTES)}\n`);
    const before = readFileSync(r.path, "utf8");
    await expect(r.store.load(MODEL, DIM)).rejects.toThrow(/too large/);
    await expect(r.store.upsert("Ben", ex({ call: "a" }))).rejects.toThrow(/too large/);
    expect(readFileSync(r.path, "utf8")).toBe(before);
    // Positive control: under the limit the same comment is fine.
    writeFileSync(r.path, `version: 1\n# ${"x".repeat(1000)}\n`);
    await r.store.upsert("Ben", ex({ call: "a" }));
    expect(await names(r.store)).toEqual(["Ben"]);
    r.cleanup();
  });

  test("the people limit is met before the size limit, at the largest embedding", async () => {
    const r = rig();
    const vec = Float32Array.from({ length: MAX_DIM }, (_, i) => Math.sin(i + 1));
    const person = (i: number): Person => ({
      name: `${String(i).padStart(4, "0")} ${"x".repeat(95)}`,
      exemplars: Array.from({ length: MAX_EXEMPLARS }, (_, j) =>
        ex(
          {
            call: crypto.randomUUID(),
            spk: `c${j + 10}`,
            dim: MAX_DIM,
            vec,
            secs: 1234.567,
            cons: 0.123456,
          },
          i % 900,
        ),
      ),
    });
    const full = serializeVoices(Array.from({ length: MAX_PEOPLE }, (_, i) => person(i)));
    expect(Buffer.byteLength(full, "utf8")).toBeLessThan(MAX_FILE_BYTES);
    writeFileSync(r.path, full);
    // One more person is refused by the people limit, and the file is left as it was.
    await expect(r.store.upsert("New", ex({ call: "n", dim: MAX_DIM, vec }))).rejects.toThrow(
      `holds ${MAX_PEOPLE} people`,
    );
    expect(readFileSync(r.path, "utf8")).toBe(full);
    // A known person still learns.
    await r.store.upsert(person(0).name, ex({ call: "n", dim: MAX_DIM, vec }));
    expect((await r.store.list()).find((p) => p.name === person(0).name)?.calls[0]).toBe("n");
    // A larger embedding is refused.
    await expect(
      r.store.upsert(
        "New",
        ex({ call: "m", dim: MAX_DIM + 1, vec: new Float32Array(MAX_DIM + 1).fill(1) }),
      ),
    ).rejects.toThrow(/dim must be/);
    r.cleanup();
  });

  test("a malformed file is refused and never written over", async () => {
    const r = rig();
    for (const bad of [
      "version: 2\npeople: []\n",
      "version: 1\npeople: {}\n",
      'version: 1\npeople:\n  - name: "A"\n    exemplars:\n      - model: "m"\n        dim: 4\n        vec: "AAAA"\n',
      'version: 1\npeople:\n  - name: "A"\n  - name: "A"\n',
      "version: [\n",
    ]) {
      writeFileSync(r.path, bad);
      await expect(r.store.list()).rejects.toThrow(VoicesError);
      await expect(r.store.forgetCall("x")).rejects.toThrow(VoicesError);
      expect(readFileSync(r.path, "utf8")).toBe(bad);
    }
    r.cleanup();
  });

  test("an exemplar or a name akou would not keep is refused", async () => {
    const r = rig();
    await expect(r.store.upsert("", ex({ call: "a" }))).rejects.toThrow(VoicesError);
    await expect(r.store.upsert("x".repeat(101), ex({ call: "a" }))).rejects.toThrow(VoicesError);
    await expect(
      r.store.upsert("Ben", ex({ call: "a", vec: new Float32Array(DIM) })),
    ).rejects.toThrow(/not zero/);
    await expect(r.store.upsert("Ben", ex({ call: "a", dim: 5 }))).rejects.toThrow(/dim values/);
    await expect(r.store.upsert("Ben", ex({ call: "a", cons: 1.5 }))).rejects.toThrow(/cons/);
    expect(existsSync(r.path)).toBe(false);
    r.cleanup();
  });
});

describe("the voices.enabled setting", () => {
  const paths = resolvePaths({ AKOU_HOME: "/t" });

  test("is on by default and only the desktop window or the file sets it", () => {
    expect(SETTINGS["voices.enabled"]).toMatchObject({
      type: "boolean",
      default: true,
      apiWritable: false,
      keyWritable: false,
    });
    // The window, in process, turns it off.
    expect(patchConfig({}, { "voices.enabled": false }, paths, { inProcess: true }).ok).toBe(true);
    // The app's own token over HTTP, an ak_ key and server mode (never local) are refused.
    expect(patchConfig({}, { "voices.enabled": false }, paths, { local: true }).ok).toBe(false);
    expect(patchConfig({}, { "voices.enabled": true }, paths, {}).ok).toBe(false);
  });
});
