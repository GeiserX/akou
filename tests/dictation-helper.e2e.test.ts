/**
 * The app's dictation service against the real Rust helper (DC-T1): `akou-capture dictate` in its
 * simulate build, with a WAV as the mic (`--from-wav`), scripted keys (`--keys`), a scripted
 * accessibility tree (`--ax fake`), the fake clipboard and the fake inserter. The same paths as
 * tests/dictation-session.test.ts runs over scripts/fake-helper.ts, so the fake and the helper it
 * stands in for are held to one behaviour. Nothing here opens a device, reads a key, types,
 * pastes or touches the clipboard, and the engine is the fake recognizer.
 *
 * Needs `AKOU_CAPTURE_BIN`, a `--features simulate` build of the helper:
 *
 *   cargo build --release --features simulate --manifest-path native/akou-capture/Cargo.toml
 *   AKOU_CAPTURE_BIN=native/akou-capture/target/release/akou-capture bun test tests/dictation-helper.e2e.test.ts
 *
 * The `helper` job of ci.yml runs it on the three OSes; without the variable it is one skip.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LiveAsr } from "../src/main/asr/live-worker.ts";
import { DictationService } from "../src/main/dictation/service.ts";
import { DEFAULT_INSERT, type DictationEngine } from "../src/main/dictation/session.ts";
import { FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const BIN = process.env.AKOU_CAPTURE_BIN;

const RC = "RightCommand";
const NOTES = { app: "com.example.notes", pid: 7, window: "n1", field: "editable" };

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const jsonLines = (path: string): Record<string, unknown>[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function fastEngine(): DictationEngine {
  const asr = new LiveAsr(
    {
      models: { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
      inThread: true,
    },
    () => undefined,
  );
  cleanups.push(() => asr.close());
  return { name: "fast", decode: (s, o) => asr.decode(s, o) };
}

interface Rig {
  svc: DictationService;
  /** What the helper's fake inserter recorded: clipboard writes, key events, focus. */
  inserter: string;
  /** What the service logged: the helper's lines that are not messages, its warnings. */
  said: string[];
}

/** `until`, and on a timeout everything the rig saw, so a CI-only failure says what happened. */
async function waitFor(r: Rig, cond: () => boolean, what: string): Promise<void> {
  try {
    await until(cond, 15_000, what);
  } catch (err) {
    const seen = {
      status: r.svc.status(),
      events: r.svc.log.events(),
      said: r.said,
      inserter: jsonLines(r.inserter),
    };
    throw new Error(`${(err as Error).message}\n${JSON.stringify(seen, null, 1)}`);
  }
}

/** Past `waitFor`'s 15 s, so its report is what a slow run shows, not bun's bare timeout. */
const SLOW = 30_000;

/**
 * The service over the helper. `keys` are `[ms, key, down]`; `tree` is the accessibility tree,
 * `[ms, target]`, written in the helper's `<ms> {json}` form.
 */
function rig(
  bin: string,
  keys: [number, string, boolean][],
  tree: [number, Record<string, unknown>][] = [[0, NOTES]],
): Rig {
  return rigWith(bin, keys, tree);
}

/** `rig` with Enter as `dictation.sendKey`, as the settings' default (DC-S2). */
function rigWith(
  bin: string,
  keys: [number, string, boolean][],
  tree: [number, Record<string, unknown>][] = [[0, NOTES]],
  sendKey: "Enter" | "none" = "none",
): Rig {
  const t = tempDir("akou-dict-helper-");
  cleanups.push(t.cleanup);
  const wav = join(t.dir, "mic.wav");
  // "hello" from 1.0 s, "world" from 2.2 s.
  writeFileSync(
    wav,
    monoWav(concat(silence(1), speak(["hello"]), silence(0.95), speak(["world"]), silence(4))),
  );
  const keyFile = join(t.dir, "keys.txt");
  writeFileSync(
    keyFile,
    keys.map(([ms, k, down]) => `${ms} ${down ? "down" : "up"} ${k}`).join("\n"),
  );
  const ax = join(t.dir, "ax.txt");
  writeFileSync(ax, tree.map(([ms, o]) => `${ms} ${JSON.stringify(o)}`).join("\n"));
  const inserter = join(t.dir, "inserter.jsonl");
  const said: string[] = [];
  const svc = new DictationService({
    configDir: t.dir,
    engine: fastEngine,
    now: () => Date.now(),
    onLog: (level, msg) => said.push(`${level}: ${msg}`),
    insert: () => ({ ...DEFAULT_INSERT, sendKey }),
  });
  cleanups.push(() => svc.close());
  svc.start(
    [
      bin,
      "dictate",
      "--hotkey",
      RC,
      "--from-wav",
      wav,
      "--keys",
      keyFile,
      "--ax",
      "fake",
      ax,
      "--clipboard",
      "fake",
      "--inserter",
      `fake:${inserter}`,
    ],
    () => ({ hotkey: RC, draft: "", fixLast: "", pasteLast: "", activation: "hold-or-toggle" }),
  );
  return { svc, inserter, said };
}

const hold: [number, string, boolean][] = [
  [800, RC, true],
  [1600, RC, false],
];

if (!BIN) {
  // Says why nothing below ran; the helper job sets AKOU_CAPTURE_BIN.
  test.skipIf(!BIN)(
    "the dictation service against the Rust helper (skipped: needs AKOU_CAPTURE_BIN, a `--features simulate` build)",
    () => {},
  );
} else {
  const bin = BIN;

  describe("DC-T1: the dictation service over akou-capture dictate (simulate)", () => {
    test(
      "a push-to-talk hold is decoded, pasted by the fake inserter and logged as inserted",
      async () => {
        const r = rig(bin, hold);
        await waitFor(r, () => r.svc.log.items()[0]?.state === "inserted", "the dictation");
        expect(r.svc.log.items()[0]).toMatchObject({ by: "user", text: "hello", target: NOTES });
        // The text went through the fake clipboard, never a real one.
        expect(jsonLines(r.inserter).some((e) => e.text === "hello")).toBe(true);
        expect(r.svc.status()).toMatchObject({ state: "idle", backend: "simulate" });
      },
      SLOW,
    );

    test(
      "a tap latches and a tap at 3 s ends one session with both words",
      async () => {
        const r = rig(bin, [
          [0, RC, true],
          [120, RC, false],
          [3000, RC, true],
          [3100, RC, false],
        ]);
        await waitFor(r, () => r.svc.log.items()[0]?.state === "inserted", "the dictation");
        expect(r.svc.log.items().map((i) => i.text)).toEqual(["hello world"]);
      },
      SLOW,
    );

    test(
      "Right Command+C is a copy: no dictation, nothing inserted",
      async () => {
        const r = rig(bin, [
          [800, RC, true],
          [840, "C", true],
          [880, "C", false],
          [920, RC, false],
        ]);
        await waitFor(r, () => r.svc.status().state === "idle", "the helper's ready");
        // The timeline is over before the helper reads its first command, so the rebind's answer
        // means every key has been played.
        expect(await r.svc.session()?.rebind()).toEqual({ ok: true });
        await r.svc.session()?.settled();
        expect(r.svc.log.events()).toEqual([]);
        expect(jsonLines(r.inserter).filter((e) => e.type !== "focus")).toEqual([]);
        expect(r.svc.status().state).toBe("idle");
      },
      SLOW,
    );

    test(
      "positive control: the same presses without C latch listening on",
      async () => {
        const r = rig(bin, [
          [800, RC, true],
          [920, RC, false],
        ]);
        await waitFor(r, () => r.svc.status().state === "listening", "the latched session");
      },
      SLOW,
    );

    test(
      "the tree says another window has the keyboard at the insert: focus-changed",
      async () => {
        const r = rig(bin, hold, [
          [0, NOTES],
          [1200, { ...NOTES, window: "n2" }],
        ]);
        await waitFor(r, () => r.svc.log.items()[0]?.state === "failed", "the failure");
        expect(r.svc.log.items()[0]).toMatchObject({
          target: NOTES,
          text: "hello",
          error: "insert: focus-changed",
        });
        expect(jsonLines(r.inserter).some((e) => e.text === "hello")).toBe(false);
      },
      SLOW,
    );

    /** A tap latches at 0 and Enter at 3 s ends the session, over "hello world". */
    const latchThenEnter: [number, string, boolean][] = [
      [0, RC, true],
      [120, RC, false],
      [3000, "Enter", true],
      [3050, "Enter", false],
    ];
    const RETURN = 'Named("Return")';

    test(
      "Enter ends a latched session: the paste, then Return once the target read it (DC-A4, DC-S2)",
      async () => {
        const r = rigWith(bin, latchThenEnter, [[0, NOTES]], "Enter");
        await waitFor(r, () => r.svc.log.items()[0]?.state === "inserted", "the dictation");
        expect(r.svc.log.items()[0]).toMatchObject({ text: "hello world" });
        const log = jsonLines(r.inserter);
        const published = log.findIndex((e) => e.type === "publish" && e.text === "hello world");
        const sent = log.findIndex((e) => e.type === "key" && e.event === RETURN);
        expect(published).toBeGreaterThanOrEqual(0);
        expect(sent).toBeGreaterThan(published);
        expect(log.filter((e) => e.type === "key" && e.event === RETURN)).toHaveLength(1);
      },
      SLOW,
    );

    test(
      "positive control: the same session with sendKey none presses no Return",
      async () => {
        const r = rigWith(bin, latchThenEnter, [[0, NOTES]], "none");
        await waitFor(r, () => r.svc.log.items()[0]?.state === "inserted", "the dictation");
        const log = jsonLines(r.inserter);
        expect(log.some((e) => e.type === "publish" && e.text === "hello world")).toBe(true);
        expect(log.some((e) => e.type === "key" && e.event === RETURN)).toBe(false);
      },
      SLOW,
    );

    test(
      "Shift+Enter ends a latched session in the draft box: nothing is pasted (DC-A4)",
      async () => {
        const r = rigWith(
          bin,
          [
            [0, RC, true],
            [120, RC, false],
            [3000, "LeftShift", true],
            [3010, "Enter", true],
            [3020, "Enter", false],
            [3030, "LeftShift", false],
          ],
          [[0, NOTES]],
          "Enter",
        );
        const opened: { focus: boolean }[] = [];
        r.svc.draft.attach({
          open: (d) => opened.push(d),
          chip: () => {},
          showInactive: () => {},
          hide: () => {},
        });
        await waitFor(r, () => r.svc.log.items()[0]?.state === "drafted", "the draft");
        expect(opened).toMatchObject([{ focus: true }]);
        expect(jsonLines(r.inserter).some((e) => e.type === "publish")).toBe(false);
      },
      SLOW,
    );

    test(
      "a password field in the tree gets the clipboard only, and the log keeps no text",
      async () => {
        const r = rig(bin, hold, [[0, { ...NOTES, field: "secure" }]]);
        await waitFor(r, () => r.svc.log.items()[0]?.state === "inserted", "the receipt");
        expect(r.svc.log.items()[0]).toMatchObject({ text: null, target: { field: "secure" } });
        // Written to the fake clipboard, and no paste chord pressed.
        const inserted = jsonLines(r.inserter);
        expect(inserted.some((e) => e.text === "hello")).toBe(true);
        expect(inserted.some((e) => e.type === "key")).toBe(false);
      },
      SLOW,
    );
  });
}
