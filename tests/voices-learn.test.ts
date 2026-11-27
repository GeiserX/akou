/**
 * What a call teaches the voices file (`src/main/voices/learn.ts`) and how the Host learns and
 * matches from a call's events (`src/main/voices/host.ts`), on a real fold and a real voices file
 * in a temporary folder. The thresholds are passed in, so no test depends on the measured values.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Ranked, simulate } from "../scripts/eval/voices.ts";
import type { EventDraft, LogEvent } from "../src/core/log/events.ts";
import { CallView } from "../src/core/log/fold.ts";
import { encodeVec } from "../src/main/asr/speakers.ts";
import { CallManager, TRASH_DIR } from "../src/main/call/manager.ts";
import type { CaptureEngine } from "../src/main/capture/engine.ts";
import { LIVE_EMBEDDER, VoiceHost, VoicePurge } from "../src/main/voices/host.ts";
import { lessonFor } from "../src/main/voices/learn.ts";
import { rankPeople } from "../src/main/voices/match.ts";
import { type Exemplar, type Person, VoiceStore } from "../src/main/voices/store.ts";
import type { VoiceThresholds } from "../src/main/voices/thresholds.ts";
import { TombstonesError, VoiceTombstones } from "../src/main/voices/tombstones.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const MODEL = LIVE_EMBEDDER;
const CALL = "01J8Z6Q4M2VX0K7B3D4E5F6G7H";

const T: VoiceThresholds = {
  accept: 0.8,
  offer: 0.6,
  margin: 0.1,
  minMatchSec: 10,
  minLearnSec: 10,
  score: "best",
};

/** A unit vector `deg` degrees from the first axis toward the second. */
function at(deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  return Float32Array.from([Math.cos(r), Math.sin(r), 0, 0]);
}

/** A unit vector `deg` degrees from the first axis toward the third. */
function off(deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  return Float32Array.from([Math.cos(r), 0, Math.sin(r), 0]);
}

function centroid(spk: string, vec: Float32Array, secs: number, cons = 0.8): EventDraft {
  return { type: "speaker.centroid", spk, vec: encodeVec(vec), secs, cons };
}

/** A call in memory: a fold the Host reads, a log it writes, and `app.watch` as a direct call. */
class Rig {
  readonly b = new LogBuilder();
  readonly view = new CallView();
  readonly written: LogEvent[] = [];
  readonly store: VoiceStore;
  host: VoiceHost;
  private readonly thresholds: VoiceThresholds;
  enabled = true;
  closed = false;
  /** The Host's wall clock; null is the real one. */
  clock: number | null = null;

  constructor(
    readonly dir: string,
    thresholds: VoiceThresholds = T,
    makeStore: (path: string) => VoiceStore = (path) =>
      new VoiceStore(path, { now: () => T0, log: () => {} }),
  ) {
    this.store = makeStore(join(dir, "voices.yaml"));
    this.thresholds = thresholds;
    this.host = this.newHost();
    this.add(this.b.created() as unknown as EventDraft, true);
    this.add(this.b.partStarted(1, T0) as unknown as EventDraft, true);
  }

  /** A Host as the app makes one at start: it reads the tombstones from beside the file. */
  newHost(): VoiceHost {
    return new VoiceHost({
      store: this.store,
      enabled: () => this.enabled,
      thresholds: () => this.thresholds,
      call: (id) =>
        id === CALL
          ? { view: this.view, append: (d) => (this.closed ? null : this.add(d)) }
          : undefined,
      log: () => {},
      now: () => this.clock ?? Date.now(),
      loaded: () => [CALL],
    });
  }

  /** The app quits and starts again: a new Host over the same file and the same call. */
  async restart(): Promise<void> {
    await this.host.idle();
    this.host = this.newHost();
  }

  /** Appends one event and hands it to the Host, as the app's watchers are. */
  add(draft: EventDraft, built = false, at?: number): LogEvent {
    const e = built ? (draft as unknown as LogEvent) : this.b.add(draft, at);
    this.view.apply(e);
    if (!built) this.written.push(e);
    this.host.onEvent(CALL, e);
    return e;
  }

  /** A line for each label, so the roster lists it. */
  speakers(...spks: string[]): void {
    for (const spk of spks)
      this.add({
        type: "seg",
        id: `l${String(this.b.events.length + 1).padStart(6, "0")}`,
        rev: 1,
        layer: "live",
        part: 1,
        ch: spk === "you" ? "mic" : "call",
        spk,
        a0: 0,
        a1: 1,
        w0: T0,
        w1: T0 + 1000,
        text: "hello",
      });
  }

  async settle(): Promise<void> {
    await this.host.idle();
  }

  voices(): Extract<LogEvent, { type: "speaker.voice" }>[] {
    return this.written.filter(
      (e): e is Extract<LogEvent, { type: "speaker.voice" }> => e.type === "speaker.voice",
    );
  }

  async names(): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const p of (await this.store.load(MODEL, 4)).people)
      out[p.name] = p.exemplars.map((e) => `${e.call}/${e.spk}`);
    return out;
  }
}

let dirs: { cleanup: () => void }[] = [];
afterEach(() => {
  for (const d of dirs) d.cleanup();
  dirs = [];
});

function rig(thresholds: VoiceThresholds = T, makeStore?: (path: string) => VoiceStore): Rig {
  const d = tempDir("akou-voices-learn-");
  dirs.push(d);
  return new Rig(d.dir, thresholds, makeStore);
}

async function seed(r: Rig, people: Person[]): Promise<void> {
  for (const p of people) for (const e of p.exemplars) await r.store.upsert(p.name, e);
}

function person(name: string, vecs: Float32Array[]): Person {
  return {
    name,
    exemplars: vecs.map((vec, i) => ({
      model: MODEL,
      dim: vec.length,
      vec,
      secs: 60,
      cons: 0.8,
      call: `earlier-${name}-${i}`,
      spk: "c1",
      at: "2026-09-01T10:00:00.000Z",
    })),
  };
}

describe("the learn rule", () => {
  function view(...drafts: EventDraft[]): CallView {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.seg({ id: "l000001", spk: "c2", text: "hello" });
    b.seg({ id: "l000002", spk: "c3", text: "hello" });
    b.seg({ id: "l000003", ch: "mic", spk: "you", text: "hello" });
    for (const d of drafts) b.add(d);
    const v = new CallView();
    for (const e of b.events) v.apply(e);
    return v;
  }
  const c = { vec: at(0), secs: 30, cons: 0.7 };
  const lesson = (v: CallView, spk = "c2", over: Partial<Parameters<typeof lessonFor>[0]> = {}) =>
    lessonFor({
      view: v,
      call: CALL,
      spk,
      model: MODEL,
      centroid: c,
      minLearnSec: 10,
      at: "2026-11-27T10:00:00.000Z",
      ...over,
    });
  const name = (spk: string, n: string, by: string): EventDraft => ({
    type: "speaker.name",
    spk,
    name: n,
    by,
  });

  test("[VO-5] only names by user and agent:cli teach", () => {
    // Positive control: a name the user typed teaches, and so does one from the CLI.
    expect(lesson(view(name("c2", "Ben", "user")))).toMatchObject({
      name: "Ben",
      exemplar: { model: MODEL, dim: 4, secs: 30, cons: 0.7, call: CALL, spk: "c2" },
    });
    expect(lesson(view(name("c2", "Ben", "agent:cli")))?.name).toBe("Ben");
    // akou's own names (an import), an MCP agent's, a voice match and an offer never teach.
    expect(lesson(view(name("c2", "Ben", "app")))).toBeNull();
    expect(lesson(view(name("c2", "Ben", "agent:claude-code")))).toBeNull();
    expect(lesson(view(name("c2", "Ben", "agent:mcp")))).toBeNull();
    const voice = (status: "named" | "offered"): EventDraft => ({
      type: "speaker.voice",
      spk: "c2",
      name: "Ben",
      status,
      score: 0.9,
      by: "app",
    });
    expect(lesson(view(voice("named")))).toBeNull();
    expect(lesson(view(voice("offered")))).toBeNull();
  });

  test("only a c<N> merge root with a full centroid of MIN_LEARN_SEC teaches", () => {
    const named = view(name("c2", "Ben", "user"), name("you", "Ana", "user"));
    expect(lesson(named)).not.toBeNull();
    expect(lesson(named, "you")).toBeNull();
    expect(lesson(view(name("s1", "Ben", "user")), "s1")).toBeNull();
    expect(lesson(view(name("c?", "Ben", "user")), "c?")).toBeNull();
    // Merged into another label: its centroid is no longer the group's voice.
    expect(
      lesson(view(name("c2", "Ben", "user"), { type: "speaker.merge", from: "c2", into: "c3" })),
    ).toBeNull();
    expect(lesson(named, "c2", { centroid: undefined })).toBeNull();
    expect(lesson(named, "c2", { centroid: { vec: at(0), cons: 0.7 } })).toBeNull();
    expect(lesson(named, "c2", { centroid: { vec: at(0), secs: 30 } })).toBeNull();
    expect(lesson(named, "c2", { centroid: { ...c, secs: 9.9 } })).toBeNull();
    expect(lesson(named, "c2", { minLearnSec: null })).toBeNull();
    // A low consistency gates nothing.
    expect(lesson(named, "c2", { centroid: { ...c, cons: 0.1 } })).not.toBeNull();
  });
});

describe("the Host learns", () => {
  test("[VO-5] a typed name teaches the label's centroid; an MCP name and an app name do not", async () => {
    const r = rig();
    r.speakers("c1", "c2", "c3");
    r.add(centroid("c1", at(0), 30));
    r.add(centroid("c2", at(90), 30));
    r.add(centroid("c3", off(90), 30));
    r.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
    r.add({ type: "speaker.name", spk: "c2", name: "Cy", by: "agent:claude-code" });
    r.add({ type: "speaker.name", spk: "c3", name: "Di", by: "app" });
    await r.settle();
    expect(await r.names()).toEqual({ Ben: [`${CALL}/c1`] });
    // A later centroid of the named label is kept in place of the first.
    r.add(centroid("c1", at(3), 60));
    await r.settle();
    const ben = (await r.store.load(MODEL, 4)).people.find((p) => p.name === "Ben");
    expect(ben?.exemplars).toHaveLength(1);
    expect(ben?.exemplars[0]?.secs).toBe(60);
  });

  test("a label under MIN_LEARN_SEC teaches once it has the speech", async () => {
    const r = rig();
    r.speakers("c1");
    r.add(centroid("c1", at(0), 5));
    r.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
    await r.settle();
    expect(existsSync(r.store.path)).toBe(false);
    r.add(centroid("c1", at(0), 12));
    await r.settle();
    expect(await r.names()).toEqual({ Ben: [`${CALL}/c1`] });
  });

  test("a rename in the call moves the exemplar to the new name", async () => {
    const r = rig();
    r.speakers("c1");
    r.add(centroid("c1", at(0), 30));
    r.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
    await r.settle();
    expect(await r.names()).toEqual({ Ben: [`${CALL}/c1`] });
    r.add({ type: "speaker.name", spk: "c1", name: "Ben Ortiz", by: "user" });
    await r.settle();
    expect(await r.names()).toEqual({ "Ben Ortiz": [`${CALL}/c1`] });
  });

  test("a typed name after a voice name wins and teaches", async () => {
    const r = rig();
    await seed(r, [person("Ben", [at(0)])]);
    r.speakers("c1");
    r.add(centroid("c1", at(2), 30));
    await r.settle();
    expect(r.voices()).toMatchObject([{ spk: "c1", name: "Ben", status: "named", by: "app" }]);
    // Named by voice: nothing taught from this call yet.
    expect(await r.names()).toEqual({ Ben: ["earlier-Ben-0/c1"] });
    r.add({ type: "speaker.name", spk: "c1", name: "Benjamin", by: "user" });
    await r.settle();
    expect(r.view.speakerLabel("c1")).toBe("Benjamin");
    expect(await r.names()).toEqual({ Ben: ["earlier-Ben-0/c1"], Benjamin: [`${CALL}/c1`] });
    // Typed: the label is left alone at its next centroid, even though Ben still matches.
    const before = r.voices().length;
    r.add(centroid("c1", at(1), 60));
    await r.settle();
    expect(r.voices()).toHaveLength(before);
  });

  test("voices.enabled off stops learning and matching and keeps the file", async () => {
    for (const on of [true, false]) {
      const r = rig();
      await seed(r, [person("Ben", [at(0)])]);
      const file = readFileSync(r.store.path, "utf8");
      r.enabled = on;
      r.speakers("c1", "c2");
      r.add(centroid("c1", at(2), 30));
      r.add(centroid("c2", at(90), 30));
      r.add({ type: "speaker.name", spk: "c2", name: "Cy", by: "user" });
      await r.settle();
      if (on) {
        // The positive control: on, c1 is named and Cy is learnt.
        expect(r.voices()).toMatchObject([{ spk: "c1", name: "Ben", status: "named" }]);
        expect(Object.keys(await r.names()).sort()).toEqual(["Ben", "Cy"]);
      } else {
        expect(r.voices()).toEqual([]);
        expect(readFileSync(r.store.path, "utf8")).toBe(file);
      }
    }
  });
});

describe("the Host matches", () => {
  test("a voice is named with the score to 2 places, offered, or left alone", async () => {
    const r = rig();
    await seed(r, [person("Ben", [at(0)]), person("Cy", [off(90)])]);
    r.speakers("c1", "c2", "c3");
    r.add(centroid("c1", at(2), 30)); // cos 0.9994: named
    r.add(centroid("c2", at(140), 30)); // Ben -0.77, Cy 0: nobody
    r.add(centroid("c3", off(40), 30)); // Ben taken; Cy cos 50 = 0.64: offered
    await r.settle();
    expect(r.voices()).toEqual([
      expect.objectContaining({ spk: "c1", name: "Ben", status: "named", score: 1, by: "app" }),
      expect.objectContaining({ spk: "c3", name: "Cy", status: "offered", score: 0.64, by: "app" }),
    ]);
  });

  test("a label under MIN_MATCH_SEC, or with thresholds that decide nothing, is left alone", async () => {
    const none: VoiceThresholds = { ...T, accept: null, offer: null };
    for (const [th, secs, want] of [
      [T, 9, 0],
      [T, 10, 1],
      [none, 30, 0],
      [{ ...T, minMatchSec: null }, 30, 0],
    ] as const) {
      const r = rig(th);
      await seed(r, [person("Ben", [at(0)])]);
      r.speakers("c1");
      r.add(centroid("c1", at(2), secs));
      await r.settle();
      expect(r.voices()).toHaveLength(want);
    }
  });

  test("a call's own exemplars never name its other labels", async () => {
    const r = rig();
    r.speakers("c1", "c2");
    r.add(centroid("c1", at(0), 30));
    r.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
    await r.settle();
    // c1 is renamed: Ben is no longer taken in this call, and only this call taught Ben.
    r.add({ type: "speaker.name", spk: "c1", name: "Bo", by: "agent:claude-code" });
    r.add(centroid("c2", at(1), 30));
    await r.settle();
    expect(r.voices()).toEqual([]);
    // The positive control: Ben taught by an earlier call names c2.
    await seed(r, [person("Ben", [at(0)])]);
    r.add(centroid("c2", at(1), 40));
    await r.settle();
    expect(r.voices()).toMatchObject([{ spk: "c2", name: "Ben", status: "named" }]);
  });
});

describe("the Host and the voices evaluation make the same decisions", () => {
  // Ana and Bo are two voices in one plane, Cy is out of it.
  const people = [person("Ana", [at(0), at(4)]), person("Bo", [at(90)]), person("Cy", [off(70)])];
  /** One recorded call: every centroid write, with its call time in seconds. */
  const writes: { spk: string; t: number; secs: number; vec: Float32Array }[] = [
    { spk: "c3", t: 5, secs: 5, vec: at(3) }, // under MIN_MATCH_SEC
    { spk: "c1", t: 10, secs: 12, vec: at(5) }, // Ana named
    { spk: "c2", t: 20, secs: 15, vec: at(40) }, // Ana taken: Bo offered
    { spk: "c1", t: 30, secs: 40, vec: off(68) }, // drifts to Cy: Ana withdrawn, Cy named
    { spk: "c2", t: 40, secs: 30, vec: at(85) }, // Bo raised to a name
    { spk: "c3", t: 50, secs: 20, vec: at(3) }, // Ana free on c3: named
  ];
  const labels = ["c1", "c2", "c3"];

  /** What the evaluation's simulation says, per label. */
  function evaluation() {
    const ranked: Ranked[][] = labels.map((spk) =>
      writes
        .filter((w) => w.spk === spk)
        .map((w) => ({ t: w.t, secs: w.secs, ranked: rankPeople(people, MODEL, 4, w.vec) })),
    );
    return simulate(ranked, T).map((o) => ({
      named: [...o.named].sort(),
      offered: [...o.offered].sort(),
      final: o.final,
      withdrawn: o.withdrawn,
    }));
  }

  /** What the Host writes when the same writes land in `order`. */
  async function host(order: typeof writes) {
    const r = rig();
    await seed(r, people);
    r.speakers(...labels);
    for (const w of order) {
      r.add(centroid(w.spk, w.vec, w.secs));
      await r.settle();
    }
    const v = r.voices();
    return labels.map((spk) => {
      const mine = v.filter((e) => e.spk === spk);
      const final = r.view.voiceFor(spk);
      return {
        named: [...new Set(mine.filter((e) => e.status === "named").map((e) => e.name))].sort(),
        offered: [...new Set(mine.filter((e) => e.status === "offered").map((e) => e.name))].sort(),
        final: final ? { name: final.name, status: final.status } : null,
        withdrawn: mine.filter((e) => e.status === "refused" && e.by === "app").length,
      };
    });
  }

  test("one recorded call replayed through both gives the same speaker.voice decisions", async () => {
    const want = evaluation();
    // The sequence exercises a name, an offer, a withdrawal followed by a new name, and a raise.
    expect(want).toEqual([
      { named: ["Ana", "Cy"], offered: [], final: { name: "Cy", status: "named" }, withdrawn: 1 },
      { named: ["Bo"], offered: ["Bo"], final: { name: "Bo", status: "named" }, withdrawn: 0 },
      { named: ["Ana"], offered: [], final: { name: "Ana", status: "named" }, withdrawn: 0 },
    ]);
    expect(await host(writes)).toEqual(want);
    // The positive control: the same writes in another order decide otherwise, so the comparison
    // tells the order apart.
    const swapped = [...writes];
    [swapped[3], swapped[5]] = [
      swapped[5] as (typeof writes)[number],
      swapped[3] as (typeof writes)[number],
    ];
    expect(await host(swapped)).not.toEqual(want);
  });
});

describe("the Host keeps each rule", () => {
  test("[VO-10] a person refused on a label is never offered to it again in the call", async () => {
    const r = rig();
    await seed(r, [person("Ben", [at(0)])]);
    r.speakers("c1", "c2");
    r.add({ type: "speaker.voice", spk: "c1", name: "Ben", status: "refused", by: "user" });
    r.add(centroid("c1", at(2), 30));
    await r.settle();
    expect(r.voices().filter((e) => e.status !== "refused")).toEqual([]);
    // The positive control: a label that refused nobody is named.
    r.add(centroid("c2", at(2), 30));
    await r.settle();
    expect(r.voices().at(-1)).toMatchObject({ spk: "c2", name: "Ben", status: "named" });
  });

  test("a typed name on another label takes its person", async () => {
    for (const typed of ["Ben", "Bo"]) {
      const r = rig();
      await seed(r, [person("Ben", [at(0)])]);
      r.speakers("c1", "c2");
      // Typed by an agent, so it teaches nothing and the store holds only the earlier Ben.
      r.add({ type: "speaker.name", spk: "c1", name: typed, by: "agent:claude-code" });
      r.add(centroid("c2", at(2), 30));
      await r.settle();
      // The positive control is "Bo": Ben is free and c2 is named.
      expect(r.voices()).toHaveLength(typed === "Ben" ? 0 : 1);
    }
  });

  test("a label merged into another is not matched; unmerged, it is", async () => {
    const r = rig();
    await seed(r, [person("Ben", [at(0)])]);
    r.speakers("c1", "c2");
    r.add({ type: "speaker.merge", from: "c2", into: "c1" });
    r.add(centroid("c2", at(2), 30));
    await r.settle();
    expect(r.voices()).toEqual([]);
    r.add({ type: "speaker.unmerge", from: "c2", into: "c1" });
    r.add(centroid("c2", at(2), 40));
    await r.settle();
    expect(r.voices()).toMatchObject([{ spk: "c2", name: "Ben", status: "named" }]);
  });

  test("a centroid without cons (an older log) is neither matched nor learnt", async () => {
    const r = rig();
    await seed(r, [person("Ben", [at(0)])]);
    r.speakers("c1", "c2");
    r.add({ type: "speaker.centroid", spk: "c1", vec: encodeVec(at(2)), secs: 30 });
    r.add({ type: "speaker.centroid", spk: "c2", vec: encodeVec(at(90)), secs: 30 });
    r.add({ type: "speaker.name", spk: "c2", name: "Cy", by: "user" });
    await r.settle();
    expect(r.voices()).toEqual([]);
    expect(Object.keys(await r.names())).toEqual(["Ben"]);
    // The positive control: the same centroid with cons is named.
    r.add(centroid("c1", at(2), 30));
    await r.settle();
    expect(r.voices()).toMatchObject([{ spk: "c1", name: "Ben", status: "named" }]);
  });

  test("the switch turned off while the file is read: nothing is written", async () => {
    for (const flip of [true, false]) {
      let r: Rig | null = null;
      class Flipping extends VoiceStore {
        override async load(model: string, dim: number) {
          // The switch goes off while the file is read, after the step began.
          if (flip && r) r.enabled = false;
          return super.load(model, dim);
        }
      }
      r = rig(T, (path) => new Flipping(path, { now: () => T0, log: () => {} }));
      await seed(r, [person("Ben", [at(0)])]);
      r.speakers("c1");
      r.add(centroid("c1", at(2), 30));
      await r.settle();
      // The positive control: left on, the label is named.
      expect(r.voices()).toHaveLength(flip ? 0 : 1);
    }
  });

  test("[VO-5] a label merged into another loses its exemplar; unmerged, it teaches again", async () => {
    const r = rig();
    r.speakers("c1", "c2");
    r.add(centroid("c1", at(0), 30));
    r.add(centroid("c2", at(90), 30));
    r.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
    r.add({ type: "speaker.name", spk: "c2", name: "Cy", by: "user" });
    await r.settle();
    // The positive control: before the merge, each name holds its own label's voice.
    expect(await r.names()).toEqual({ Ben: [`${CALL}/c1`], Cy: [`${CALL}/c2`] });
    r.add({ type: "speaker.merge", from: "c2", into: "c1" });
    await r.settle();
    expect(await r.names()).toEqual({ Ben: [`${CALL}/c1`] });
    // A merge drops the exemplar even with the switch off: it only ever removes a wrong voice.
    r.add({ type: "speaker.unmerge", from: "c2", into: "c1" });
    r.add(centroid("c2", at(90), 40));
    await r.settle();
    expect(await r.names()).toEqual({ Ben: [`${CALL}/c1`], Cy: [`${CALL}/c2`] });
  });

  test("[VO-5] a merge into an unnamed label keeps the group's voice under its name; an unmerge moves it back", async () => {
    for (const on of [true, false]) {
      const r = rig();
      r.speakers("c1", "c2");
      r.add(centroid("c1", at(0), 30));
      r.add(centroid("c2", at(5), 30));
      r.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
      await r.settle();
      // The positive control: before the merge, Ben holds c1's voice.
      expect(await r.names()).toEqual({ Ben: [`${CALL}/c1`] });
      r.enabled = on;
      // The call has ended: no centroid comes after the merge.
      r.add({ type: "speaker.merge", from: "c1", into: "c2" });
      await r.settle();
      expect(r.view.speakerLabel("c2")).toBe("Ben");
      // Off, the merge only removes: nothing learns.
      expect(await r.names()).toEqual(on ? { Ben: [`${CALL}/c2`] } : {});
      r.add({ type: "speaker.unmerge", from: "c1", into: "c2" });
      await r.settle();
      // c2 has no name of its own again, so it keeps nothing; c1 teaches Ben once more.
      expect(await r.names()).toEqual(on ? { Ben: [`${CALL}/c1`] } : {});
    }
  });

  test("a typed name takes its person off another label that shows it by voice, at once", async () => {
    for (const typed of ["Ben", "Bo"]) {
      const r = rig();
      await seed(r, [person("Ben", [at(0)])]);
      r.speakers("c1", "c2");
      r.add(centroid("c1", at(2), 30));
      await r.settle();
      expect(r.view.speakerLabel("c1")).toBe("Ben");
      r.add({ type: "speaker.name", spk: "c2", name: typed, by: "user" });
      await r.settle();
      if (typed === "Ben") {
        expect(r.voices().at(-1)).toMatchObject({
          spk: "c1",
          name: "Ben",
          status: "refused",
          by: "app",
        });
        expect(r.view.speakerLabel("c1")).toBe("Speaker 1");
      } else {
        // The positive control: another name leaves c1 as it was.
        expect(r.voices()).toHaveLength(1);
        expect(r.view.speakerLabel("c1")).toBe("Ben");
      }
    }
  });
});

describe("[VO-4] a purge the file cannot take now", () => {
  const ex = (call: string) => ({
    model: MODEL,
    dim: 4,
    vec: at(0),
    secs: 30,
    cons: 0.8,
    call,
    spk: "c1",
    at: "2026-09-01T10:00:00.000Z",
  });

  test("waits beside the file and leaves it once it reads again, after a restart too", async () => {
    const d = tempDir("akou-voices-purge-");
    dirs.push(d);
    const store = new VoiceStore(join(d.dir, "voices.yaml"), { now: () => T0, log: () => {} });
    await store.upsert("Ben", ex("deleted"));
    await store.upsert("Ben", ex("kept"));
    const good = readFileSync(store.path, "utf8");
    // The positive control: a purge the file can take leaves at once, and nothing waits.
    const p0 = new VoicePurge(store, () => {});
    p0.purged("nothing-taught");
    await p0.idle();
    expect(existsSync(p0.file)).toBe(false);
    // The file cannot be read when the call is deleted.
    writeFileSync(store.path, "version: 1\npeople: [");
    const p1 = new VoicePurge(store, () => {});
    p1.purged("deleted");
    await p1.idle();
    expect(readFileSync(p1.file, "utf8")).toBe("deleted\n");
    // Repaired by hand, then akou starts again: the call's voiceprints leave the file.
    writeFileSync(store.path, good);
    const p2 = new VoicePurge(store, () => {});
    await p2.idle();
    const ben = (await store.load(MODEL, 4)).people[0];
    expect(ben?.exemplars.map((e) => e.call)).toEqual(["kept"]);
    expect(existsSync(p2.file)).toBe(false);
    // Repaired while akou runs: the next step that reads the file applies the purge.
    const now = readFileSync(store.path, "utf8");
    writeFileSync(store.path, "version: 1\npeople: [");
    p2.purged("kept");
    await p2.idle();
    expect(readFileSync(p2.file, "utf8")).toBe("kept\n");
    writeFileSync(store.path, now);
    await p2.flush();
    expect((await store.load(MODEL, 4)).people).toEqual([]);
    expect(existsSync(p2.file)).toBe(false);
  });

  test("a call whose folder could not be deleted keeps its voiceprints (POSIX)", async () => {
    // A folder in a trash folder without write access cannot be removed.
    if (process.platform === "win32") return;
    const d = tempDir("akou-voices-trash-");
    dirs.push(d);
    const ws = join(d.dir, TRASH_DIR, "work");
    const dir = join(ws, "call-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "");
    writeFileSync(`${dir}.json`, JSON.stringify({ id: "A", workspace: "work", trashedAt: 1 }));
    const purged: string[] = [];
    const mgr = new CallManager({
      root: d.dir,
      engine: {} as CaptureEngine,
      onPurged: (id) => purged.push(id),
    });
    chmodSync(ws, 0o555);
    try {
      expect(await mgr.emptyTrash()).toBe(existsSync(dir) ? 0 : 1);
      // A box that ignores the mode (a root shell) deletes it: then the call is purged.
      expect(purged).toEqual(existsSync(dir) ? [] : ["A"]);
    } finally {
      chmodSync(ws, 0o755);
    }
    // The positive control: once the folder can go, the call is purged.
    const left = purged.length === 0 ? 1 : 0;
    expect(await mgr.emptyTrash()).toBe(left);
    expect(purged).toEqual(["A"]);
  });
});

describe("[VO-12] forgets and renames as tombstones", () => {
  /** A store whose writes wait for `gate`, so a step holds the Host's queue. */
  class Gated extends VoiceStore {
    gate: Promise<void> | null = null;
    override async upsert(name: string, exemplar: Exemplar): Promise<void> {
      await this.gate;
      return super.upsert(name, exemplar);
    }
  }

  /** A rig whose c2 the user named Ben, taught from 30 s of speech. */
  async function taught(): Promise<Rig> {
    const r = rig();
    r.speakers("c2");
    r.add(centroid("c2", at(0), 30));
    r.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    await r.settle();
    expect(Object.keys(await r.names())).toEqual(["Ben"]);
    return r;
  }

  test("a name typed while the forget waits in the queue is newer, and teaches", async () => {
    const r = rig(T, (path) => new Gated(path, { now: () => T0, log: () => {} }));
    const store = r.store as Gated;
    r.speakers("c2");
    r.add(centroid("c2", at(0), 30));
    r.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    await r.settle();
    expect(Object.keys(await r.names())).toEqual(["Ben"]);
    // A centroid whose write is held keeps the queue busy.
    let release = () => {};
    store.gate = new Promise((ok) => {
      release = ok;
    });
    r.add(centroid("c2", at(1), 31));
    r.clock = T0 + 10_000;
    const forgot = r.host.forget({ name: "Ben" });
    // The user names c2 again before the forget's turn comes; time moves on while it waits.
    r.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" }, false, T0 + 20_000);
    r.clock = T0 + 30_000;
    store.gate = null;
    release();
    expect(await forgot).toEqual({ gone: true, held: true });
    await r.settle();
    expect(Object.keys(await r.names())).toEqual(["Ben"]);
    // The positive control: with no name after it, the same forget leaves nothing.
    r.clock = T0 + 40_000;
    expect((await r.host.forget({ name: "Ben" })).gone).toBe(true);
    r.add(centroid("c2", at(2), 32));
    await r.settle();
    expect(await r.names()).toEqual({});
  });

  test("the clock set back an hour after a forget: a name typed then teaches, after a restart too", async () => {
    const r = await taught();
    r.clock = T0 + 3_600_000;
    expect((await r.host.forget({ name: "Ben" })).gone).toBe(true);
    // The control: the name given before the forget still teaches nothing.
    r.add(centroid("c2", at(1), 31), false, T0 + 3_600_100);
    await r.settle();
    expect(await r.names()).toEqual({});
    // The clock goes back an hour; the user names c2 again.
    r.clock = T0 + 200;
    r.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" }, false, T0 + 200);
    await r.settle();
    expect(Object.keys(await r.names())).toEqual(["Ben"]);
    // After a restart the name still counts as given after the forget.
    await r.restart();
    await r.store.forget("Ben");
    r.add(centroid("c2", at(2), 32), false, T0 + 300);
    await r.settle();
    expect(Object.keys(await r.names())).toEqual(["Ben"]);
  });

  test("forget all with the clock a day ahead, then corrected: a name typed now teaches, and a later forget still covers it", async () => {
    const r = await taught();
    r.clock = T0 + 86_400_000;
    expect((await r.host.forget({ all: true })).gone).toBe(true);
    r.clock = T0 + 1000;
    r.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" }, false, T0 + 1000);
    await r.settle();
    expect(Object.keys(await r.names())).toEqual(["Ben"]);
    // The control: a forget asked for now is stamped after that name, so it covers it.
    expect((await r.host.forget({ name: "Ben" })).gone).toBe(true);
    r.add(centroid("c2", at(1), 31), false, T0 + 2000);
    await r.settle();
    expect(await r.names()).toEqual({});
  });

  test("a forget that finds nothing in the file still holds for a name under MIN_LEARN_SEC", async () => {
    const r = rig();
    r.speakers("c2");
    r.add(centroid("c2", at(0), 5));
    r.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    await r.settle();
    expect(await r.names()).toEqual({});
    r.clock = Date.now() + 1000;
    expect(await r.host.forget({ name: "Ben" })).toEqual({ gone: false, held: true });
    r.add(centroid("c2", at(1), 30));
    await r.settle();
    expect(await r.names()).toEqual({});
    // The control: a name nobody gave is neither in the file nor on a speaker.
    expect(await r.host.forget({ name: "Zed" })).toEqual({ gone: false, held: false });
  });

  test("a tombstone that cannot be saved: forget and rename fail and change nothing", async () => {
    const r = await taught();
    const file = `${r.store.path}.tombstones`;
    // A folder with a file in it where the tombstones go: no rename can replace it.
    mkdirSync(join(file, "x"), { recursive: true });
    await expect(r.host.forget({ name: "Ben" })).rejects.toThrow(TombstonesError);
    await expect(r.host.rename("Ben", "Ben Ortiz")).rejects.toThrow(TombstonesError);
    expect(Object.keys(await r.names())).toEqual(["Ben"]);
    expect(r.host.tombstones.all()).toEqual([]);
    // The positive control: once the file can be written, the same forget works.
    rmSync(file, { recursive: true, force: true });
    expect((await r.host.forget({ name: "Ben" })).gone).toBe(true);
    expect(await r.names()).toEqual({});
  });

  test("the file: kept with mode 0600, read back, unreadable lines left out, pruned by the oldest kept call", async () => {
    const d = tempDir("akou-tombstones-");
    dirs.push(d);
    const file = join(d.dir, "voices.yaml");
    const warned: string[] = [];
    const a = new VoiceTombstones(file, (_l, m) => warned.push(m));
    await a.add({ kind: "forget", name: "Ben", at: 2000 });
    await a.add({ kind: "rename", from: "Cy", to: "Cy Ortiz", at: 1000 });
    await a.add({ kind: "forget", call: "X", at: 3000 });
    await a.add({ kind: "lift", call: "Y", seq: 7, at: 3500 });
    expect(statSync(a.file).mode & 0o777).toBe(0o600);
    writeFileSync(a.file, `${readFileSync(a.file, "utf8")}not json\n{"kind":"forget","at":5}\n`);
    // A temporary file a write of a process that is gone left behind.
    writeFileSync(`${a.file}.999999999.tmp`, "");
    const b = new VoiceTombstones(file, (_l, m) => warned.push(m));
    expect(b.all().map((x) => x.at)).toEqual([1000, 2000, 3000, 3500]);
    expect(warned).toEqual(["voices: 2 unreadable line(s) in the tombstones file"]);
    expect(existsSync(`${a.file}.999999999.tmp`)).toBe(false);
    expect(b.lifted("Y", 7)).toBe(3500);
    // Stamps only grow, across a restart too.
    expect(b.stamp(100)).toBe(3501);
    expect(b.behind(3501)).toBe(true);
    expect(b.behind(3502)).toBe(false);
    // Older names: Ben forgotten, Cy renamed, anything of X forgotten; a newer name is itself.
    expect(b.teaches("Ben", "Y", 1500)).toBeNull();
    expect(b.teaches("Cy", "Y", 500)).toBe("Cy Ortiz");
    expect(b.teaches("Dan", "X", 2500)).toBeNull();
    expect(b.teaches("Dan", "Y", 2500)).toBe("Dan");
    expect(b.teaches("Ben", "Y", 2001)).toBe("Ben");
    // The same millisecond counts as older: the forget wins.
    expect(b.teaches("Ben", "Y", 2000)).toBeNull();
    // A tombstone leaves only once every kept call was created after it.
    expect(await b.prune(2000)).toBe(1);
    expect(new VoiceTombstones(file, () => {}).all().map((x) => x.at)).toEqual([2000, 3000, 3500]);
    expect(await b.prune(Number.POSITIVE_INFINITY)).toBe(3);
    expect(existsSync(b.file)).toBe(false);
  });

  test("the Host prunes only what no kept call can need, and never while the oldest is unknown", async () => {
    const d = tempDir("akou-tombstones-host-");
    dirs.push(d);
    const store = new VoiceStore(join(d.dir, "voices.yaml"), { now: () => T0, log: () => {} });
    let oldest: number | null = null;
    let now = 5000;
    const host = new VoiceHost({
      store,
      enabled: () => true,
      thresholds: () => T,
      call: () => undefined,
      log: () => {},
      now: () => now,
      oldestCall: async () => oldest,
    });
    expect((await host.forget({ all: true })).gone).toBe(true);
    host.prune();
    await host.idle();
    expect(host.tombstones.all()).toHaveLength(1);
    // A kept call created before the forget still needs it.
    oldest = 4000;
    host.prune();
    await host.idle();
    expect(host.tombstones.all()).toHaveLength(1);
    oldest = 6000;
    now = 7000;
    host.prune();
    await host.idle();
    expect(host.tombstones.all()).toEqual([]);
  });

  test("the oldest kept call is unknown while the trash holds a call, and Infinity with none", async () => {
    const d = tempDir("akou-tombstones-oldest-");
    dirs.push(d);
    const mgr = () => new CallManager({ root: d.dir, engine: {} as CaptureEngine });
    expect(await mgr().oldestCall()).toBe(Number.POSITIVE_INFINITY);
    const dir = join(d.dir, TRASH_DIR, "work", "call-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "");
    // Trashed now, so the 30-day purge at start keeps it.
    const trashedAt = Date.now();
    writeFileSync(`${dir}.json`, JSON.stringify({ id: "A", workspace: "work", trashedAt }));
    expect(await mgr().oldestCall()).toBeNull();
  });

  test("the oldest kept call is unknown while a call is being restored from the trash", async () => {
    const d = tempDir("akou-tombstones-restore-");
    dirs.push(d);
    const b = new LogBuilder();
    const trashed = join(d.dir, TRASH_DIR, "work", "call-a");
    mkdirSync(trashed, { recursive: true });
    writeFileSync(join(trashed, "events.jsonl"), `${JSON.stringify(b.created())}\n`);
    const trashedAt = Date.now();
    writeFileSync(`${trashed}.json`, JSON.stringify({ id: CALL, workspace: "work", trashedAt }));
    const mgr = new CallManager({ root: d.dir, engine: {} as CaptureEngine });
    expect(await mgr.oldestCall()).toBeNull();
    // Hold the restore between the folder's move and its index entry.
    let release = () => {};
    const gate = new Promise<void>((ok) => {
      release = ok;
    });
    const m = mgr as unknown as { reindex: (dir: string, ws: string) => Promise<unknown> };
    const reindex = m.reindex.bind(mgr);
    m.reindex = async (dir, ws) => {
      await gate;
      return reindex(dir, ws);
    };
    const restoring = mgr.restore(CALL);
    while (existsSync(trashed)) await new Promise((ok) => setTimeout(ok, 5));
    expect(await mgr.oldestCall()).toBeNull();
    release();
    expect((await restoring).ok).toBe(true);
    // The positive control: once indexed, the oldest call is the restored one.
    expect(await mgr.oldestCall()).toBe(b.events[0]?.t ?? Number.NaN);
  });
});
