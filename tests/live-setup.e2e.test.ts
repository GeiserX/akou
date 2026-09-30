/**
 * The live setup through the whole app (akou-chp.23): `asr.live` set over `PATCH /config` starts
 * the next call on that model, a call's own `live` (`POST /calls`, `akou start --live`) overrides
 * it for that call only, and so do its own `review` and `reviewEvery` (`--review`,
 * `--review-every`) for the second pass; a running call keeps its setup, the old `upgrade` is read
 * as Nemotron with Qwen's review, and `GET /status`, `akou status` and `GET /models` name it. Every setup runs on the fake recognizer and the fake streaming engine
 * (tests/fixtures/asr-fake.ts), so each line's `model` says which path wrote it; the catalog is a
 * loopback registry of tiny files named after the real models, and nothing is downloaded.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent, Seg } from "../src/core/log/events.ts";
import { type Provisional, ProvisionalBoard } from "../src/core/log/fold.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { CallController } from "../src/main/call/call.ts";
import { type AppRig, appRig, FAKE_MODELS, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const STREAM = "nemotron-en-560";

let reg: ModelRegistry;
let rig: AppRig;
const home = tempDir("akou-live-setup-");

beforeAll(async () => {
  reg = modelRegistry();
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    { ...reg.entry(STREAM, ["s.onnx"]), onDemand: true } as ModelSpecEntry,
    // Qwen is fetched on demand only and is not here: its second pass cannot run.
    { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
  ];
  const models = join(home.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const m of catalog.slice(0, 4)) reg.install(models, m);
  rig = await appRig({
    modelRegistry: catalog,
    models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
    helperArgs: ["--wav", speechWav(home.dir)],
    settings: {
      "asr.modelsDir": models,
      "asr.diarizer": "nemotron",
      "asr.languages": ["en"],
    },
  });
  await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
});

afterAll(async () => {
  await rig?.close();
  reg?.stop();
  home.cleanup();
});

// biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
type Body = any;

async function liveStatus(): Promise<Body> {
  return (await rig.api("GET", "/status")).body.live;
}

/**
 * Words shown and then taken back: a provisional line that does not extend the one before it on
 * its open line, or whose words are not the start of the line finally written there. Empty when
 * nothing shown is ever withdrawn.
 */
function withdrawn(shown: readonly Provisional[], segs: readonly Seg[]): string[] {
  const out: string[] = [];
  const open = (p: Provisional) => `${p.ch}/${p.part}/${p.w0}`;
  for (let i = 1; i < shown.length; i++) {
    const [a, b] = [shown[i - 1], shown[i]] as [Provisional, Provisional];
    if (open(a) === open(b) && !b.text.startsWith(a.text)) out.push(`"${a.text}" -> "${b.text}"`);
  }
  for (const v of shown) {
    const written = segs.some(
      (s) => s.layer === "live" && s.ch === v.ch && s.w0 === v.w0 && s.text?.startsWith(v.text),
    );
    if (!written) out.push(`"${v.text}" never written`);
  }
  return out;
}

/** The provisional lines published while `run` runs, in order. */
async function watchShown<T>(run: () => Promise<T>): Promise<{ r: T; shown: Provisional[] }> {
  const shown: Provisional[] = [];
  const update = ProvisionalBoard.prototype.update;
  ProvisionalBoard.prototype.update = function (p: Provisional) {
    const took = update.call(this, p);
    if (took) shown.push({ ...p });
    return took;
  };
  try {
    return { r: await run(), shown };
  } finally {
    ProvisionalBoard.prototype.update = update;
  }
}

/**
 * Runs one call until its first lines are written, and returns the setup the status named and the
 * models that wrote its lines. `during` runs once the call has chosen its setup.
 */
async function oneCall(
  body: Record<string, unknown> = {},
  during: () => Promise<void> = async () => {},
): Promise<{
  setup: string;
  engine: string | null;
  models: (string | undefined)[];
}> {
  return (await runCall(body, during)).seen;
}

/** `oneCall`, also returning the call's live lines and the provisional lines shown. */
async function runCall(
  body: Record<string, unknown> = {},
  during: () => Promise<void> = async () => {},
): Promise<{
  seen: { setup: string; engine: string | null; models: (string | undefined)[] };
  segs: Seg[];
  shown: Provisional[];
}> {
  const { r, shown } = await watchShown(async () => {
    const id = await rig.startCall(body);
    await until(async () => (await liveStatus())?.setup != null, 10_000, "the live setup");
    const live = await liveStatus();
    await during();
    const segs = async () =>
      (await rig.app.events(id, 0)).filter((e: LogEvent): e is Seg => e.type === "seg");
    await until(async () => (await segs()).length >= 2, 15_000, "the call's lines");
    const stop = await rig.api("POST", "/calls/live/stop");
    expect(stop.status).toBe(200);
    await until(async () => (await liveStatus()) === null, 10_000, "the call's end");
    return { live, segs: await segs() };
  });
  return {
    seen: {
      setup: r.live.setup,
      engine: r.live.engine,
      models: [...new Set(r.segs.map((s) => s.model))],
    },
    segs: r.segs,
    shown,
  };
}

async function setLive(value: string): Promise<void> {
  const r = await rig.api("PATCH", "/config", { "asr.live": value });
  expect(r.status).toBe(200);
}

describe("[akou-chp.23] asr.live starts the next call on that setup", () => {
  test("parakeet, nemotron, and auto (no upgrade models here: nemotron)", async () => {
    await setLive("parakeet");
    expect(await oneCall()).toEqual({
      setup: "parakeet",
      engine: null,
      models: ["fake-parakeet"],
    });
    await setLive("nemotron");
    const nemo = await runCall();
    expect(nemo.seen).toEqual({
      setup: "nemotron",
      engine: STREAM,
      models: [STREAM],
    });
    // Words showed while the lines were open, and none of them was ever taken back.
    expect(nemo.shown.length).toBeGreaterThan(2);
    expect(withdrawn(nemo.shown, nemo.segs)).toEqual([]);
    // Control: the same check on the same call catches a shown word that is later withdrawn.
    const last = nemo.shown.findLast((v) => v.text.includes(" ")) as Provisional;
    const taken = { ...last, pseq: last.pseq + 1, text: last.text.replace(/ \S+$/, " wrong") };
    expect(withdrawn([...nemo.shown, taken], nemo.segs).length).toBeGreaterThan(0);
    await setLive("auto");
    expect(await oneCall()).toEqual({
      setup: "nemotron",
      engine: STREAM,
      models: [STREAM],
    });
  });

  test("the old upgrade is saved as nemotron with Qwen's review; Qwen is not here, so the call runs nemotron alone and says why", async () => {
    await setLive("upgrade");
    const cfg = (await rig.api("GET", "/config")).body.settings;
    expect([cfg["asr.live"], cfg["asr.review.model"]]).toEqual(["nemotron", "qwen"]);
    expect(await oneCall()).toEqual({
      setup: "nemotron",
      engine: STREAM,
      models: [STREAM],
    });
    expect(
      rig.logs.some((l) =>
        /runs the nemotron live model .*no Qwen second pass: Needs qwen3-asr-1.7b/.test(l.msg),
      ),
    ).toBe(true);
    // A call's own `live: "upgrade"` is the same pair.
    const before = rig.logs.length;
    await rig.api("PATCH", "/config", { "asr.live": "parakeet", "asr.review.model": "none" });
    expect((await oneCall({ live: "upgrade" })).setup).toBe("nemotron");
    expect(
      rig.logs
        .slice(before)
        .some((l) => /runs the nemotron live model .*no Qwen second pass/.test(l.msg)),
    ).toBe(true);
  });

  test("a call's own review that cannot run here is off for that call, and says why; a bad one is refused", async () => {
    await rig.api("PATCH", "/config", { "asr.live": "nemotron", "asr.review.model": "none" });
    const before = rig.logs.length;
    expect((await oneCall({ review: "qwen", reviewEvery: 120 })).setup).toBe("nemotron");
    expect(
      rig.logs
        .slice(before)
        .some((l) =>
          /runs the nemotron live model .*no Qwen second pass: Needs qwen3-asr-1.7b/.test(l.msg),
        ),
    ).toBe(true);
    for (const [body, field] of [
      [{ review: "whisper" }, "review"],
      [{ reviewEvery: 10 }, "reviewEvery"],
      [{ reviewEvery: 90.5 }, "reviewEvery"],
    ] as const) {
      const r = await rig.api("POST", "/calls", { workspace: "work", ...body });
      expect([r.status, r.body.error, r.body.field]).toEqual([422, "bad_field", field]);
    }
    expect(await liveStatus()).toBeNull();
  });

  test("a call's own live overrides the setting for that call only, and keeps its setup when the setting changes", async () => {
    await setLive("nemotron");
    // Changed mid-call: this call keeps what it started with.
    const own = await oneCall({ live: "parakeet" }, () => setLive("nemotron"));
    expect(own).toEqual({
      setup: "parakeet",
      engine: null,
      models: ["fake-parakeet"],
    });
    const kept = await oneCall({}, () => setLive("parakeet"));
    expect(kept).toEqual({
      setup: "nemotron",
      engine: STREAM,
      models: [STREAM],
    });
    // The change applies from the next call.
    expect((await oneCall()).setup).toBe("parakeet");
  });

  test("akou start --live nemotron overrides for one call, and akou status names it", async () => {
    await setLive("parakeet");
    const cli = rigCli(rig);
    const bad = await cli(["start", "--live", "voxtral"]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("live is one of auto, parakeet, nemotron");
    const started = await cli(["start", "--live", "nemotron", "--json"]);
    expect(started.code).toBe(0);
    await until(async () => (await liveStatus())?.setup != null, 10_000, "the live setup");
    const st = await cli(["status"]);
    expect(st.out).toContain(`live model nemotron (${STREAM})`);
    expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    await until(async () => (await liveStatus()) === null, 10_000, "the call's end");
    const outOfRange = await cli(["start", "--review-every", "5"]);
    expect(outOfRange.code).not.toBe(0);
    expect(outOfRange.err).toContain("--review-every must be a whole number from 30 to 600");
  });

  test("a start refused while another call starts never changes that call's setup", async () => {
    await setLive("nemotron");
    // The call's own setup is on its controller before its helper spawns, so audio that reaches
    // the recognizer before the start answers already reads it. A second start sent while the
    // first is still starting is refused and leaves it alone.
    const atBegin: (string | undefined)[] = [];
    let other: Promise<{ status: number; body: Body }> | undefined;
    const begin = CallController.prototype.begin;
    CallController.prototype.begin = function (this: CallController) {
      atBegin.push(this.liveAsked);
      const started = begin.call(this);
      other ??= rig.api("POST", "/calls", { workspace: "work", live: "nemotron" });
      return started;
    };
    let seen: Awaited<ReturnType<typeof oneCall>>;
    try {
      seen = await oneCall({ live: "parakeet" });
    } finally {
      CallController.prototype.begin = begin;
    }
    const refused = await other;
    expect(atBegin).toEqual(["parakeet"]);
    expect([refused?.status, refused?.body.error]).toEqual([409, "already_recording"]);
    expect(seen).toEqual({ setup: "parakeet", engine: null, models: ["fake-parakeet"] });
  });

  test("POST /calls refuses a live that is not a setup, and starts nothing", async () => {
    const r = await rig.api("POST", "/calls", { workspace: "work", live: "voxtral" });
    expect([r.status, r.body.error, r.body.field]).toEqual([422, "bad_field", "live"]);
    expect(await liveStatus()).toBeNull();
  });
});

describe("[akou-chp.23] GET /models lists the live models and the second pass", () => {
  test("the three models, the next call's marked, the second pass with the missing model named", async () => {
    await setLive("auto");
    const r = await rig.api("GET", "/models");
    const live = r.body.live;
    expect([live.setting, live.next, live.running]).toEqual(["auto", "nemotron", null]);
    const by = Object.fromEntries(live.setups.map((s: Body) => [s.id, s]));
    expect(Object.keys(by)).toEqual(["nemotron", "parakeet", "voxtral"]);
    expect(by.nemotron.title).toBe("Nemotron English");
    expect(by.nemotron).toMatchObject({
      selected: true,
      models: [{ id: STREAM, state: "ready" }],
      accuracy: { score: 62, metric: "call-wer" },
    });
    const qwen = live.review.choices.find((c: Body) => c.id === "qwen");
    expect(qwen.models).toContainEqual({ id: QWEN_ASR, state: "missing" });
    expect(by.voxtral.unavailable).toBeTruthy();
    // The streaming model the next call runs is the app's: never swept, never deleted.
    const row = r.body.models.find((m: Body) => m.id === STREAM);
    expect(row).toMatchObject({ default: true, state: "ready" });
  });
});
