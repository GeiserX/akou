/**
 * The live panel in the Record row (docs/ux/WINDOW.md W3.19, design-explorations/
 * lm-live-menu-slots.html), on the real page over the headless app: the Live slot's radio rows by
 * name with no Automatic row and the radio on what `auto` runs, a pick saved as `asr.live` (a model
 * id) and sent as the next call's `live`; the Second pass slot with its 1 | 2 | 5 min switch, saved
 * as `asr.review.model` and `asr.review.everySeconds` and sent as `review` and `reviewEvery`;
 * "+ Add a model" downloading in place with its bar and Cancel, the model landing in its slot
 * unpicked; "From a folder…"; the no-model state; the button naming what runs, disabled while a
 * call records; and nothing clipped at 1024 by 700. The catalog is a loopback registry of tiny
 * files named after the real models, so nothing comes from the network, and the recognizer is the
 * fake one.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { Probe } from "../../src/main/asr/accelerator.ts";
import { QWEN_ASR } from "../../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../../src/main/asr/models.ts";
import { NO_GPU, speechWav } from "../api-helpers.ts";
import { type ModelRegistry, modelRegistry } from "../fixtures/model-registry.ts";
import { tempDir } from "../helpers.ts";
import { seedCall, standardCall, UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

/** The streaming model `auto` runs for English, and one more that is never downloaded first. */
const STREAM = "nemotron-en-560";
const OTHER = "nemotron-3.5-560";
const FAKE_LLAMA = join(import.meta.dir, "..", "fixtures", "fake-llama-server.ts");

/**
 * A rig whose models folder holds the first `installed` entries of the catalog: the recognizer,
 * the VAD, the speaker model, the English streaming model, then Qwen; Nemotron 3.5 is in the
 * catalog and never installed. With `roomy`, the machine is a Mac with a GPU and 32 GB, and Qwen
 * runs on an own llama-server (the fake one): the panel offers Qwen's second pass.
 */
async function withModels<T>(
  installed: number,
  fn: (rig: UiRig, home: string, reg: ModelRegistry) => Promise<T>,
  o: { seed?: (home: string) => void; roomy?: boolean } = {},
): Promise<T> {
  const home = tempDir("akou-ui-live-");
  const reg = modelRegistry();
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    { ...reg.entry(STREAM, ["s.onnx"]), onDemand: true } as ModelSpecEntry,
    { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
    { ...reg.entry(OTHER, ["s35.onnx"]), onDemand: true } as ModelSpecEntry,
  ];
  const models = join(home.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const m of catalog.slice(0, installed)) reg.install(models, m);
  o.seed?.(home.dir);
  const rig = await uiRig({
    home: home.dir,
    modelRegistry: catalog,
    helperArgs: ["--wav", speechWav(home.dir)],
    settings: {
      "asr.modelsDir": models,
      "asr.diarizer": "nemotron",
      "asr.languages": ["en"],
      ...(o.roomy ? { "asr.llamaServer": [process.execPath, FAKE_LLAMA] } : {}),
    },
    ...(o.roomy
      ? {
          accelerator: { probe: { ...(NO_GPU.probe as Probe), platform: "darwin-arm64" } },
          memoryGb: 32,
        }
      : {}),
  });
  try {
    return await fn(rig, home.dir, reg);
  } finally {
    await rig.close();
    reg.stop();
    home.cleanup();
  }
}

const label = (page: Page) => page.textContent("#live-name");
const extra = (page: Page) =>
  page.$eval("#live-extra", (e) => ((e as HTMLElement).hidden ? "" : (e.textContent ?? "").trim()));
/** A slot's radio rows: id, name, checked, and dim when it cannot be picked. */
const radios = (page: Page, slot: "live" | "review") =>
  page.$$eval(`#live-menu [data-slot="${slot}"] .live-item`, (els) =>
    els.map((e) => [
      (e as HTMLElement).dataset.live ?? (e as HTMLElement).dataset.review ?? "",
      e.querySelector(".live-title")?.textContent ?? "",
      e.getAttribute("aria-checked"),
      (e as HTMLButtonElement).disabled ? "dim" : "ready",
    ]),
  );
/** A slot's Add a model box: each model's id and its button. */
const catalogRows = (page: Page, slot: "live" | "review") =>
  page.$$eval(`#live-menu [data-cat="${slot}"] .live-cat-row`, (els) =>
    els.map((e) => [
      (e as HTMLElement).dataset.model as string,
      e.querySelector(".live-get")?.textContent ?? "",
    ]),
  );

/** Every write the page sends, in order, from the moment the page opens. */
function writes(): {
  bodies: { method: string; path: string; body: unknown }[];
  before: (p: Page) => void;
} {
  const bodies: { method: string; path: string; body: unknown }[] = [];
  return {
    bodies,
    before: (p) =>
      p.on("request", (r) => {
        const path = new URL(r.url()).pathname;
        if (r.method() === "GET") return;
        bodies.push({ method: r.method(), path, body: r.postDataJSON() });
      }),
  };
}

const patches = (bodies: { method: string; path: string; body: unknown }[]) =>
  bodies.filter((b) => b.method === "PATCH" && b.path.endsWith("/config")).map((b) => b.body);

async function openPanel(page: Page): Promise<void> {
  if (await page.isHidden("#live-menu")) await page.click("#live");
  await page.waitForSelector('#live-menu:not([hidden]) [data-slot="live"]');
}

describe("W3.19: the live panel in the Record row", () => {
  test(
    "the Live slot names the models with no Automatic row, the radio on what auto runs; a pick saves its id and reaches POST /calls; the running call's model shows, disabled",
    async () => {
      await withModels(4, async (rig) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        const w = writes();
        const page = await rig.open(undefined, { before: w.before });
        await page.waitForSelector("#live-pick:not([hidden])");
        await until(async () => (await label(page)) === "Nemotron English", 5000, "the model");
        expect(await extra(page)).toBe("");
        await openPanel(page);
        expect(await radios(page, "live")).toEqual([
          [STREAM, "Nemotron English", "true", "ready"],
          [RECOGNIZER, "Parakeet", "false", "ready"],
        ]);
        expect(await page.textContent("#live-menu")).not.toContain("Automatic");
        expect(await page.textContent(`#live-menu [data-live="${STREAM}"] .live-line`)).toBe(
          "Words appear as they are said. English only.",
        );

        // Picking saves asr.live as the model's id, that key only; the panel stays open.
        await page.click(`#live-menu [data-live="${RECOGNIZER}"]`);
        await until(
          async () => (await rig.api("GET", "/config")).body.settings["asr.live"] === RECOGNIZER,
          5000,
          "asr.live saved",
        );
        expect(patches(w.bodies)).toEqual([{ "asr.live": RECOGNIZER }]);
        await until(async () => (await label(page)) === "Parakeet", 5000, "the label");
        await page.keyboard.press("Escape");
        await until(async () => await page.isHidden("#live-menu"), 3000, "closed");
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("live");

        await page.click("#record");
        await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
        const start = w.bodies.find((b) => b.method === "POST" && b.path.endsWith("/calls"));
        expect(start?.body).toMatchObject({ live: RECOGNIZER, review: "none", reviewEvery: 60 });
        await until(
          async () => (await rig.api("GET", "/status")).body.live?.setup === "parakeet",
          10_000,
          "the call runs parakeet",
        );
        // The page learns it from the status push, a moment after the API.
        await until(async () => await page.isDisabled("#live"), 5000, "disabled while recording");
        expect(await label(page)).toBe("Parakeet");
        await until(
          async () => (await page.textContent("#pill-live")) === "Live: Parakeet",
          5000,
          "the call header's chip",
        );
        await page.click("#stop");
        await until(async () => (await page.textContent("#state")) === "saved", 8000, "stopped");
        await until(async () => !(await page.isDisabled("#live")), 5000, "enabled again");

        // A call another door starts on another model: the button shows that call's.
        const other = await rig.startCall({ live: "nemotron" });
        await until(
          async () => (await label(page)) === "Nemotron English",
          10_000,
          "the running model shown",
        );
        expect(await page.isDisabled("#live")).toBe(true);
        await rig.api("POST", `/calls/${other}/stop`);
        await until(async () => (await label(page)) === "Parakeet", 8000, "the choice back");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "+ Add a model downloads in place: its bar and Cancel while it runs, then it joins the slot, not picked",
    async () => {
      await withModels(4, async (rig, _home, reg) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        const w = writes();
        const page = await rig.open(undefined, { before: w.before });
        await until(async () => (await label(page)) === "Nemotron English", 5000, "the model");
        await openPanel(page);
        expect(await page.isHidden('#live-menu [data-cat="live"]')).toBe(true);
        await page.click('#live-menu [data-add="live"]');
        await page.waitForSelector('#live-menu [data-cat="live"]');
        expect(await page.textContent('#live-menu [data-add="live"] .live-plus')).toBe("−");
        expect(await catalogRows(page, "live")).toEqual([[OTHER, "Download"]]);
        const line = await page.textContent(`#live-menu [data-model="${OTHER}"] .live-line`);
        expect(line).toMatch(
          /^Words appear as they are said\. 35 languages, mixed in one call\. .+\.$/,
        );
        expect(await page.isVisible('#live-menu [data-cat="live"] .live-from')).toBe(true);

        const release = reg.hold("s35.onnx", 1024);
        await page.click(`#live-menu [data-model="${OTHER}"] .live-get`);
        await page.waitForSelector(`#live-menu [data-model="${OTHER}"] .live-bar`);
        expect(await catalogRows(page, "live")).toEqual([[OTHER, "Cancel"]]);
        await page.click(`#live-menu [data-model="${OTHER}"] .live-get`);
        await until(
          async () =>
            JSON.stringify(await catalogRows(page, "live")) ===
            JSON.stringify([[OTHER, "Download"]]),
          5000,
          "cancelled",
        );
        release();
        await page.click(`#live-menu [data-model="${OTHER}"] .live-get`);
        await until(
          async () => (await radios(page, "live")).some((r) => r[0] === OTHER),
          10_000,
          "the model in its slot",
        );
        // It landed unpicked: the radio stays where it was, and nothing was saved.
        expect(await radios(page, "live")).toEqual([
          [OTHER, "Nemotron 3.5", "false", "ready"],
          [STREAM, "Nemotron English", "true", "ready"],
          [RECOGNIZER, "Parakeet", "false", "ready"],
        ]);
        expect(patches(w.bodies)).toEqual([]);
        expect(w.bodies.filter((b) => b.path.endsWith("/models/pull")).map((b) => b.body)).toEqual([
          { model: OTHER },
          { model: OTHER },
        ]);
        expect(await page.textContent('#live-menu [data-cat="live"]')).toContain(
          "Every model that fits is already here.",
        );
      });
    },
    UI_TIMEOUT,
  );

  test(
    "with no live model the button reads Live: no model, and the Live slot says so with its Add a model list open",
    async () => {
      let id = "";
      await withModels(
        0,
        async (rig) => {
          // A call picked in the sidebar lifts the welcome, so the Record row shows with no models.
          const page = await rig.open(id);
          await page.waitForSelector("#live-pick:not([hidden])");
          await until(async () => (await label(page)) === "no model", 5000, "no model");
          await openPanel(page);
          expect(await radios(page, "live")).toEqual([]);
          expect(await page.textContent('#live-menu [data-slot="live"] .live-none')).toBe(
            "No model yet.",
          );
          expect(await page.getAttribute('#live-menu [data-add="live"]', "aria-expanded")).toBe(
            "true",
          );
          expect((await catalogRows(page, "live")).map((r) => r[0])).toEqual([
            OTHER,
            STREAM,
            RECOGNIZER,
          ]);
          expect(await page.$("#live-get")).toBeNull();
        },
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "the Second pass slot: Off by default with the switch dim; a model and 2 min saved, shown dim on the button, and sent with the call; a Parakeet live call dims its models with the reason",
    async () => {
      await withModels(
        5,
        async (rig) => {
          await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
          const w = writes();
          const page = await rig.open(undefined, { before: w.before });
          await until(async () => (await label(page)) === "Nemotron English", 5000, "the model");
          await openPanel(page);
          expect(await radios(page, "review")).toEqual([
            ["none", "Off", "true", "ready"],
            [QWEN_ASR, "Qwen3-ASR", "false", "ready"],
            [RECOGNIZER, "Parakeet", "false", "ready"],
          ]);
          expect(await page.isDisabled('[data-every="120"]')).toBe(true);

          await page.click(`#live-menu [data-review="${QWEN_ASR}"]`);
          await until(
            async () => !(await page.isDisabled('[data-every="120"]')),
            5000,
            "switch on",
          );
          await page.click('[data-every="120"]');
          await until(
            async () => (await extra(page)) === "+ Qwen 2 min",
            5000,
            "the button's second part",
          );
          expect(patches(w.bodies)).toEqual([
            { "asr.review.model": QWEN_ASR },
            { "asr.review.everySeconds": 120 },
          ]);
          expect(await page.getAttribute('[data-every="120"]', "aria-checked")).toBe("true");
          expect(
            (await page.$eval("#live-extra", (e) => getComputedStyle(e).color)) !==
              (await page.$eval("#live-name", (e) => getComputedStyle(e).color)),
          ).toBe(true);

          // Arrow keys move between the radio rows.
          await page.focus(`#live-menu [data-live="${STREAM}"]`);
          await page.keyboard.press("ArrowDown");
          expect(
            await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.live),
          ).toBe(RECOGNIZER);
          await page.keyboard.press("Escape");

          await page.click("#record");
          await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
          const start = w.bodies.find((b) => b.method === "POST" && b.path.endsWith("/calls"));
          expect(start?.body).toMatchObject({ live: "auto", review: QWEN_ASR, reviewEvery: 120 });
          await until(
            async () =>
              (await page.textContent("#pill-live")) === "Live: Nemotron English + Qwen 2 min",
            10_000,
            "the call header's chip",
          );
          expect(await page.isDisabled("#live")).toBe(true);
          await page.click("#stop");
          await until(async () => (await page.textContent("#state")) === "saved", 8000, "stopped");

          // Parakeet live: the second pass models are dim, each with why.
          await rig.api("PATCH", "/config", { "asr.live": RECOGNIZER });
          await openPanel(page);
          await until(async () => (await label(page)) === "Parakeet", 5000, "Parakeet live");
          await until(
            async () =>
              (await radios(page, "review")).every((r) => r[0] === "none" || r[3] === "dim"),
            5000,
            "dimmed",
          );
          expect(
            await page.textContent(`#live-menu [data-review="${RECOGNIZER}"] .live-line`),
          ).toBe("Parakeet already writes the live lines.");
          expect(await extra(page)).toBe("");
        },
        { roomy: true },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "From a folder… copies the models found there, and they join their slot",
    async () => {
      await withModels(4, async (rig, home, reg) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        const stick = join(home, "stick");
        mkdirSync(stick, { recursive: true });
        reg.install(stick, reg.entry(OTHER, ["s35.onnx"]));
        const page = await rig.open();
        await until(async () => (await label(page)) === "Nemotron English", 5000, "the model");
        await openPanel(page);
        await page.click('#live-menu [data-add="live"]');
        await page.click('#live-menu [data-cat="live"] .live-from');
        await page.fill("#live-menu .live-folder-path", stick);
        await page.click('#live-menu .live-folder [type="submit"]');
        await until(
          async () => ((await page.textContent("#toast")) ?? "").includes("Copied 1 model files"),
          5000,
          "the copy",
        );
        await until(
          async () => (await radios(page, "live")).some((r) => r[0] === OTHER),
          5000,
          "in its slot",
        );
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Record sends the settings as they are now; at 1024 by 700 the panel with both boxes open fits and scrolls, the button never covers the state word, and Tab out closes it",
    async () => {
      await withModels(4, async (rig) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        const starts: unknown[] = [];
        const page = await rig.open(undefined, {
          before: (p) =>
            p.on("request", (r) => {
              if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/calls"))
                starts.push(r.postDataJSON());
            }),
        });
        await page.setViewportSize({ width: 1024, height: 700 });
        await until(async () => (await label(page)) === "Nemotron English", 5000, "the model");
        const box = async (sel: string) => {
          const b = await page.locator(sel).boundingBox();
          if (!b) throw new Error(`${sel} has no box`);
          return b;
        };
        await openPanel(page);
        await page.click('#live-menu [data-add="live"]');
        await page.click('#live-menu [data-cat="live"] .live-from');
        await page.click('#live-menu [data-add="review"]');
        await page.waitForSelector('#live-menu [data-cat="review"]');
        const panel = await box("#live-menu");
        // Taller than the window's room: it scrolls inside.
        expect(await page.$eval("#live-menu", (e) => e.scrollHeight > e.clientHeight)).toBe(true);
        expect(panel.x).toBeGreaterThanOrEqual(0);
        expect(panel.x + panel.width).toBeLessThanOrEqual(1024);
        expect(panel.y + panel.height).toBeLessThanOrEqual(700);
        // Tab out of the panel closes it.
        await page.focus('#live-menu [data-add="review"]');
        for (let i = 0; i < 12 && !(await page.isHidden("#live-menu")); i++)
          await page.keyboard.press("Tab");
        expect(await page.isHidden("#live-menu")).toBe(true);

        // `akou config set`, with the window idle and its panel closed.
        await rig.api("PATCH", "/config", {
          "asr.live": RECOGNIZER,
          "asr.review.model": "none",
          "asr.review.everySeconds": 300,
        });
        await page.click("#record");
        await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
        expect(starts).toEqual([
          expect.objectContaining({ live: RECOGNIZER, review: "none", reviewEvery: 300 }),
        ]);
        await page.click("#stop");
        await until(async () => (await page.textContent("#state")) === "saved", 8000, "stopped");

        // The longest name, while recording, in a 1024 px window: the button ends before REC.
        await rig.api("PATCH", "/config", { "asr.live": STREAM });
        await page.click("#record");
        await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
        await until(async () => (await label(page)) === "Nemotron English", 5000, "the name");
        const state = await box("#state");
        const live = await box("#live");
        expect(live.x).toBeGreaterThanOrEqual(state.x + state.width);
        const clipped = await page.$eval("#live-name", (e) => e.scrollWidth > e.clientWidth);
        const ellipsis = await page.$eval(
          "#live-name",
          (e) => getComputedStyle(e).textOverflow === "ellipsis",
        );
        expect(!clipped || ellipsis).toBe(true);
        await page.click("#stop");
        await until(async () => (await page.textContent("#state")) === "saved", 8000, "stopped");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a saved model that is not here checks what runs instead and says why",
    async () => {
      // Three models: no streaming model, so asr.live = the English Nemotron falls back to Parakeet.
      await withModels(3, async (rig) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        await rig.api("PATCH", "/config", { "asr.live": STREAM });
        const page = await rig.open();
        await until(async () => (await label(page)) === "Parakeet", 5000, "the fallback named");
        await openPanel(page);
        expect(await radios(page, "live")).toEqual([[RECOGNIZER, "Parakeet", "true", "ready"]]);
        expect(await page.textContent('#live-menu [data-slot="live"] .live-note')).toBe(
          "Nemotron English is not downloaded, so calls run Parakeet until it is.",
        );
      });
    },
    UI_TIMEOUT,
  );
});
