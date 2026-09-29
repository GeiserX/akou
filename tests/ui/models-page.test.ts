/**
 * The Models page in a real browser (docs/ux/SERVER.md SV-U6, DESKTOP.md DK-E2), in the desktop
 * window's Models dialog: two bars per model drawn from the scores, "not measured" where nobody
 * measured, the sort control reordering the rows, Delete disabled on the default with the reason,
 * Download with live progress, the settings saved over `PATCH /config`, and no sideways scroll in
 * a narrow window in either theme. Above them, the Live section (akou-chp.23): the four live setups
 * with their four bars, the next call's marked, Download for a setup's missing model, and Use for
 * calls, with the mark moving as the models and the setting change. The catalog is a loopback registry of tiny files named after
 * the real models, so the real scores apply and nothing comes from the network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { QWEN_ASR } from "../../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../../src/main/asr/models.ts";
import { type ModelRegistry, modelRegistry } from "../fixtures/model-registry.ts";
import { tempDir } from "../helpers.ts";
import { UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

const PYANNOTE = "pyannote-segmentation-3.0";
/** The streaming model `nemotron` runs for English: fetched on demand, missing at first. */
const STREAM = "nemotron-en-560";

let reg: ModelRegistry;
let rig: UiRig;
let page: Page;
let release = () => {};
const home = tempDir("akou-ui-models-");

beforeAll(async () => {
  reg = modelRegistry();
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    reg.entry(PYANNOTE, ["seg.onnx"]),
    // Qwen fetched on demand only: missing here, and more accurate but slower than Parakeet.
    { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
    { ...reg.entry(STREAM, ["s.onnx"]), onDemand: true } as ModelSpecEntry,
  ];
  const models = join(home.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const m of catalog.slice(0, 4)) reg.install(models, m);
  rig = await uiRig({
    modelRegistry: catalog,
    settings: { "asr.modelsDir": models, "asr.diarizer": "nemotron", "asr.languages": ["en"] },
    jobs: { modelStore: { retryMs: [5, 5, 5], freeBytes: () => 1e12 } },
  });
  await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
  page = await rig.open();
  await page.click("#models-open");
  await page.waitForSelector("#models[open] .model[data-id]");
}, UI_TIMEOUT);

afterAll(async () => {
  release();
  await rig?.close();
  reg?.stop();
  home.cleanup();
});

/** The ids of one section's rows, top to bottom. */
function order(kind: string): Promise<string[]> {
  return page.$$eval(`#models [data-kind="${kind}"] .model`, (els) =>
    els.map((e) => (e as HTMLElement).dataset.id as string),
  );
}

describe("SV-U6: the Models page in the desktop window", () => {
  test(
    "two bars per model from the scores, the raw number beside each",
    async () => {
      const row = `#models .model[data-id="${RECOGNIZER}"]`;
      expect(await page.getAttribute(`${row} .mbar.accuracy`, "data-value")).toBe("77");
      expect(await page.getAttribute(`${row} .mbar.speed`, "data-value")).toBe("83");
      expect(await page.textContent(`${row} .mbar.accuracy .mbar-value`)).toBe("77 · WER 4.55 %");
      // The bar is as long as its score.
      const width = await page.$eval(`${row} .mbar.accuracy`, (el) => {
        const track = el.querySelector(".track") as HTMLElement;
        const fill = el.querySelector(".fill") as HTMLElement;
        return fill.getBoundingClientRect().width / track.getBoundingClientRect().width;
      });
      expect(width).toBeCloseTo(0.77, 2);
      // The source is in the tooltip.
      expect(await page.getAttribute(`${row} .mbar.accuracy`, "title")).toContain(
        "docs/research/asr-benchmark.md",
      );
    },
    UI_TIMEOUT,
  );

  test(
    "a side nobody measured says so, with no bar and no made-up number",
    async () => {
      const bar = `#models .model[data-id="${PYANNOTE}"] .mbar.speed`;
      expect(await page.getAttribute(bar, "class")).toContain("none");
      expect(await page.getAttribute(bar, "data-value")).toBeNull();
      expect(await page.textContent(`${bar} .mbar-value`)).toBe("not measured");
      expect(await page.getAttribute(bar, "title")).toContain("no speed figure");
    },
    UI_TIMEOUT,
  );

  test(
    "speech, speaker labels, and the helpers folded",
    async () => {
      expect((await order("speech")).sort()).toEqual([QWEN_ASR, RECOGNIZER, STREAM].sort());
      expect((await order("speakers")).sort()).toEqual([NEMOTRON, PYANNOTE].sort());
      expect(
        await page.$eval(
          '#models details[data-kind="helper"]',
          (d) => (d as HTMLDetailsElement).open,
        ),
      ).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "the sort control reorders the rows: accuracy puts Qwen first, speed puts Parakeet first",
    async () => {
      await page.selectOption("#models-sort", "accuracy");
      expect(await order("speech")).toEqual([QWEN_ASR, RECOGNIZER, STREAM]);
      await page.selectOption("#models-sort", "speed");
      expect(await order("speech")).toEqual([RECOGNIZER, STREAM, QWEN_ASR]);
      await page.selectOption("#models-sort", "name");
      expect(await order("speakers")).toEqual([NEMOTRON, PYANNOTE]);
    },
    UI_TIMEOUT,
  );

  test(
    "Delete is disabled on the default with the reason; the other diarizer can be deleted",
    async () => {
      const del = `#models .model[data-id="${RECOGNIZER}"] [data-action="delete"]`;
      expect(await page.isDisabled(del)).toBe(true);
      expect(await page.getAttribute(del, "title")).toContain("default");
      expect(
        await page.textContent(`#models .model[data-id="${RECOGNIZER}"] .model-kept`),
      ).toContain("Kept: default");
      const other = `#models .model[data-id="${PYANNOTE}"]`;
      expect(await page.textContent(`${other} .model-kept`)).toContain("Deleted on");
      expect(await page.isDisabled(`${other} [data-action="delete"]`)).toBe(false);
      await page.click(`${other} [data-action="delete"]`);
      await page.click(`${other} [data-action="delete"]`);
      await page.waitForSelector(`#models .model[data-id="${PYANNOTE}"][data-state="missing"]`);
    },
    UI_TIMEOUT,
  );

  test(
    "Download shows live progress, then the model on disk",
    async () => {
      release = reg.hold("q.gguf", 1024);
      const row = `#models .model[data-id="${QWEN_ASR}"]`;
      await page.click(`${row} button.go`);
      await page.waitForSelector(`${row}[data-state="downloading"] progress`);
      expect(await page.textContent(`${row} .model-actions`)).toContain("% of");
      release();
      await page.waitForSelector(`${row}[data-state="ready"] [data-action="delete"]`);
    },
    UI_TIMEOUT,
  );

  test(
    "the settings: unused days and the size cap save; the client choice is server mode's only",
    async () => {
      expect(await page.$("#models-on-demand-download")).toBeNull();
      await page.fill("#models-unused-days", "7");
      await page.click("#models-settings-save");
      await until(
        async () =>
          (await rig.api("GET", "/config")).body.settings["server.models_unused_days"] === 7,
        3000,
        "the saved setting",
      );
    },
    UI_TIMEOUT,
  );

  test(
    "a narrow window in light and dark: nothing scrolls sideways, and the bars keep their tracks",
    async () => {
      await page.setViewportSize({ width: 420, height: 800 });
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const overflow = await page.$eval("#models", (d) => d.scrollWidth - d.clientWidth);
        expect([scheme, overflow <= 0]).toEqual([scheme, true]);
        const width = () =>
          page.$$eval(
            `#models .model[data-id="${RECOGNIZER}"] .mbar.accuracy .track`,
            (els) => els[0]?.getBoundingClientRect().width ?? 0,
          );
        // The settings save above re-renders the rows, and a read between two renders measures
        // 0 even after an earlier read saw the track: wait for the width itself.
        await until(
          async () => (await width()) > 40,
          3000,
          "the accuracy bar's track at its width",
        );
        const colors = await page.$eval(
          `#models .model[data-id="${RECOGNIZER}"] .mbar.accuracy .fill`,
          (el) => [getComputedStyle(el).backgroundColor, getComputedStyle(document.body).color],
        );
        expect(colors[0]).not.toBe(colors[1]);
      }
      await page.emulateMedia({ colorScheme: null });
    },
    UI_TIMEOUT,
  );
});

/** The setups the Live section marks as the next call's. */
function marked(): Promise<string[]> {
  return page.$$eval('#models-live .live-setup:has([data-mark="next"])', (els) =>
    els.map((e) => (e as HTMLElement).dataset.setup as string),
  );
}

describe("akou-chp.23: the Live section of the Models page", () => {
  test(
    "four setups with four bars each, the next call's marked, the unavailable ones saying why",
    async () => {
      const ids = await page.$$eval("#models-live .live-setup", (els) =>
        els.map((e) => (e as HTMLElement).dataset.setup),
      );
      expect(ids).toEqual(["parakeet", "nemotron", "upgrade", "voxtral"]);
      for (const id of ids) {
        expect(await page.$$(`#models-live [data-setup="${id}"] .mbar`)).toHaveLength(4);
      }
      const parakeet = '#models-live [data-setup="parakeet"]';
      expect(await page.getAttribute(`${parakeet} .mbar.accuracy`, "data-value")).toBe("28");
      expect(await page.textContent(`${parakeet} .mbar.accuracy .mbar-value`)).toBe(
        "28 · WER 36.17 % on meetings",
      );
      // No streaming model here yet: auto runs Parakeet, and Nemotron is one Download away.
      expect(await marked()).toEqual(["parakeet"]);
      expect(await page.getAttribute('#models-live [data-setup="nemotron"]', "data-state")).toBe(
        "missing",
      );
      expect(await page.textContent('#models-live [data-setup="voxtral"]')).toContain(
        "Unavailable:",
      );
      expect(await page.$('#models-live [data-setup="voxtral"] [data-action="use"]')).toBeNull();
      expect(await page.textContent("#models-live-hint")).toContain(
        "A change applies from the next call",
      );
    },
    UI_TIMEOUT,
  );

  test(
    "the mark follows the models and the setting: Download moves it to Nemotron, Use moves it back",
    async () => {
      const nemotron = '#models-live [data-setup="nemotron"]';
      await page.click(`${nemotron} [data-action="download"]`);
      await page.waitForSelector(`${nemotron}[data-state="ready"] [data-mark="next"]`);
      expect(await marked()).toEqual(["nemotron"]);
      await page.click('#models-live [data-setup="parakeet"] [data-action="use"]');
      await page.waitForSelector('#models-live [data-setup="parakeet"] [data-mark="next"]');
      expect(await marked()).toEqual(["parakeet"]);
      expect((await rig.api("GET", "/config")).body.settings["asr.live"]).toBe("parakeet");
      await page.click("#models-live-auto");
      await page.waitForSelector(`${nemotron} [data-mark="next"]`);
      expect(await marked()).toEqual(["nemotron"]);
    },
    UI_TIMEOUT,
  );
});
