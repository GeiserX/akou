/**
 * The Models page in a real browser (docs/ux/design-explorations/sd-a-models.html, SERVER.md
 * SV-U6, DESKTOP.md DK-E2): a page of the window beside the sidebar, not a dialog. Its facts are
 * plain sentences, each accuracy figure naming its test set, and never a key, an id or a path. The
 * live transcript is a radio list whose mark follows the models and the setting; a model downloads
 * with its progress and can be cancelled; Remove asks once more and is refused on the default with
 * the reason; the speaker choice, the graphics chip and the sweep's numbers save one key each, and
 * leaving the page saves what is typed. The Settings page leads here. The catalog is a loopback
 * registry of tiny files named after the real models, so the real scores apply and nothing comes
 * from the network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
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
const models = join(home.dir, "models");
/** Every PATCH /config body the page sends. */
const patches: Record<string, unknown>[] = [];

const LIVE = "#models-live";
const QWEN = `#models-dictation [data-model="${QWEN_ASR}"]`;
const AFTER = `#models-after [data-model="${RECOGNIZER}"]`;
const PRINTS = '#models-speakers [data-diarizer="embeddings"]';

beforeAll(async () => {
  reg = modelRegistry();
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    reg.entry(PYANNOTE, ["seg.onnx"]),
    // Qwen fetched on demand only: missing here.
    { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
    { ...reg.entry(STREAM, ["s.onnx"]), onDemand: true } as ModelSpecEntry,
  ];
  mkdirSync(models, { recursive: true });
  for (const m of catalog.slice(0, 4)) reg.install(models, m);
  rig = await uiRig({
    modelRegistry: catalog,
    settings: { "asr.modelsDir": models, "asr.diarizer": "nemotron", "asr.languages": ["en"] },
    jobs: { modelStore: { retryMs: [5, 5, 5], freeBytes: () => 1e12 } },
  });
  await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
  page = await rig.open();
  page.on("request", (r) => {
    if (r.method() === "PATCH" && new URL(r.url()).pathname.endsWith("/config"))
      patches.push(JSON.parse(r.postData() ?? "{}"));
  });
  await page.click("#models-open");
  await page.waitForSelector(`${LIVE} [data-setup]`);
}, UI_TIMEOUT);

afterAll(async () => {
  release();
  await rig?.close();
  reg?.stop();
  home.cleanup();
});

const setting = async (key: string) => (await rig.api("GET", "/config")).body.settings[key];

/** The live rows marked for the next call. */
function marked(): Promise<string[]> {
  return page.$$eval(`${LIVE} [data-setup]:has([data-mark="next"])`, (els) =>
    els.map((e) => (e as HTMLElement).dataset.setup as string),
  );
}

describe("the Models page", () => {
  test(
    "a page in the window, not a dialog: the sidebar marks it and Calls leads back",
    async () => {
      expect(await page.$("dialog#models")).toBeNull();
      expect(await page.isVisible("#page-models")).toBe(true);
      expect(await page.isVisible("#composer")).toBe(false);
      expect(await page.getAttribute("#models-open", "aria-current")).toBe("page");
      await page.click("#calls-open");
      await page.waitForSelector("#page-models", { state: "hidden" });
      expect(await page.getAttribute("#models-open", "aria-current")).toBeNull();
      await page.click("#models-open");
      await page.waitForSelector(`${LIVE} [data-setup]`);
    },
    UI_TIMEOUT,
  );

  test(
    "facts in plain sentences, each figure naming its test set, and no key, id or path",
    async () => {
      const after = (await page.textContent(AFTER)) ?? "";
      expect(after).toContain("Parakeet v3");
      expect(after).toContain("About 5 words in 100 wrong on read speech.");
      expect(after).toContain("An hour of audio in 1.3 minutes.");
      expect(await page.textContent(PRINTS)).toContain(
        "about 6 seconds in 10 given to the wrong speaker on real calls",
      );
      expect(await page.textContent(`${LIVE} [data-setup="parakeet"]`)).toContain(
        "About 1 word in 3 wrong on meetings.",
      );
      const words = await page.innerText("#page-models");
      for (const bad of [RECOGNIZER, QWEN_ASR, "asr.", "server.", "docs/", "`", models])
        expect(`${bad}: ${words.includes(bad)}`).toBe(`${bad}: false`);
    },
    UI_TIMEOUT,
  );

  test(
    "the live transcript: five choices, Automatic chosen and marked, Voxtral listed and unavailable",
    async () => {
      const ids = await page.$$eval(`${LIVE} [data-setup]`, (els) =>
        els.map((e) => (e as HTMLElement).dataset.setup),
      );
      expect(ids).toEqual(["auto", "nemotron", "parakeet", "upgrade", "voxtral"]);
      expect(await page.isChecked(`${LIVE} input[value="auto"]`)).toBe(true);
      expect(await page.textContent(`${LIVE} [data-setup="auto"] .pg-name`)).toBe(
        "Automatic (default)",
      );
      expect(await page.isDisabled(`${LIVE} input[value="voxtral"]`)).toBe(true);
      // No streaming model yet: Automatic runs Parakeet, and Nemotron is one Download away.
      expect(await marked()).toEqual(["auto"]);
      expect(await page.textContent(`${LIVE} [data-setup="auto"]`)).toContain(
        "Uses Parakeet until Nemotron is on",
      );
      expect(await page.getAttribute(`${LIVE} [data-setup="nemotron"]`, "data-state")).toBe(
        "missing",
      );
      // The upgrade needs Qwen, and says so.
      const upgrade = (await page.textContent(`${LIVE} [data-setup="upgrade"]`)) ?? "";
      expect(upgrade).toMatch(/Needs .*Qwen3-ASR 1\.7B\./);
    },
    UI_TIMEOUT,
  );

  test(
    "Download moves Automatic to Nemotron; a pick saves the setting and the mark follows it",
    async () => {
      const nemotron = `${LIVE} [data-setup="nemotron"]`;
      await page.click(`${nemotron} [data-action="download"]`);
      await page.waitForSelector(`${nemotron}[data-state="ready"]`);
      await until(
        async () =>
          ((await page.textContent(`${LIVE} [data-setup="auto"]`)) ?? "").includes("Uses Nemotron"),
        5000,
        "Automatic on Nemotron",
      );
      patches.length = 0;
      await page.click(`${LIVE} [data-setup="parakeet"] .pg-name`);
      await until(async () => (await setting("asr.live")) === "parakeet", 5000, "asr.live");
      expect(patches).toEqual([{ "asr.live": "parakeet" }]);
      await until(async () => (await marked()).join() === "parakeet", 5000, "the mark");
      await page.click(`${LIVE} [data-setup="auto"] .pg-name`);
      await until(async () => (await setting("asr.live")) === "auto", 5000, "asr.live back");
      await until(async () => (await marked()).join() === "auto", 5000, "the mark back");
    },
    UI_TIMEOUT,
  );

  test(
    "Remove is refused on the default with the reason, and asks once more before it removes",
    async () => {
      await page.hover(AFTER);
      const kept = `${AFTER} [data-action="remove"]`;
      expect(await page.isDisabled(kept)).toBe(true);
      expect(await page.getAttribute(kept, "title")).toContain("by default");
      // The size says when an unused model goes, or why it stays.
      expect(await page.getAttribute(`${AFTER} .pg-value`, "title")).toContain("Kept: the default");

      await page.hover(PRINTS);
      const remove = `${PRINTS} [data-action="remove"]`;
      await page.click(remove);
      expect(await page.textContent(remove)).toBe("Remove: sure?");
      expect(existsSync(join(models, PYANNOTE))).toBe(true);
      await page.click(remove);
      await page.waitForSelector(`${PRINTS}[data-state="missing"] [data-action="download"]`);
      expect(existsSync(join(models, PYANNOTE))).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "Download shows the progress with Cancel; Cancel stops it; a second Download finishes",
    async () => {
      release = reg.hold("q.gguf", 1024);
      await page.click(`${QWEN} [data-action="download"]`);
      await page.waitForSelector(`${QWEN}[data-state="downloading"] [role="progressbar"]`);
      expect(await page.textContent(`${QWEN} .pg-progress`)).toMatch(/\d+ % of /);
      // Opened again while the download's poll ticks, with a slow read: a tick never leaves the
      // page on its "Reading" line.
      await page.route("**/api/v1/config", async (r) => {
        await new Promise((ok) => setTimeout(ok, 1500));
        await r.continue().catch(() => {});
      });
      await page.click("#models-open");
      await page.waitForSelector("#page-models .pg-reading");
      await page.waitForSelector("#page-models .pg-reading", { state: "detached", timeout: 5000 });
      await page.unroute("**/api/v1/config");
      await page.waitForSelector(`${QWEN} [data-action="cancel"]`);
      await page.click(`${QWEN} [data-action="cancel"]`);
      await page.waitForSelector(`${QWEN}[data-state="missing"] [data-action="download"]`);
      const listed = (await rig.api("GET", "/models")).body.models as {
        id: string;
        state: string;
      }[];
      expect(listed.find((m) => m.id === QWEN_ASR)?.state).toBe("missing");
      release();
      await page.click(`${QWEN} [data-action="download"]`);
      await page.waitForSelector(`${QWEN}[data-state="ready"]`);
      await page.hover(QWEN);
      expect(await page.isDisabled(`${QWEN} [data-action="remove"]`)).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "the speaker choice and the graphics chip save one key each",
    async () => {
      patches.length = 0;
      await page.click(`${PRINTS} .pg-name`);
      await until(async () => (await setting("asr.diarizer")) === "embeddings", 5000, "diarizer");
      await page.click('#models-speakers [data-diarizer="nemotron"] .pg-name');
      await until(async () => (await setting("asr.diarizer")) === "nemotron", 5000, "back");
      const select = await page.$("select#models-accelerator");
      if (select) await page.selectOption("select#models-accelerator", "cpu");
      else await page.click('#models-accelerator-row label:has(input[value="cpu"])');
      await until(async () => (await setting("asr.accelerator")) === "cpu", 5000, "accelerator");
      expect(patches).toEqual([
        { "asr.diarizer": "embeddings" },
        { "asr.diarizer": "nemotron" },
        { "asr.accelerator": "cpu" },
      ]);
    },
    UI_TIMEOUT,
  );

  test(
    "a number saves when its field is left, and leaving the page saves what is still typed",
    async () => {
      patches.length = 0;
      await page.fill("#models-unused-days", "7");
      await page.press("#models-unused-days", "Tab");
      await until(
        async () => (await setting("server.models_unused_days")) === 7,
        5000,
        "unused days",
      );
      expect(patches).toEqual([{ "server.models_unused_days": 7 }]);
      await page.fill("#models-max-gb", "55");
      await page.click("#calls-open");
      await until(async () => (await setting("server.models_max_gb")) === 55, 5000, "the cap");
      expect(patches).toEqual([{ "server.models_unused_days": 7 }, { "server.models_max_gb": 55 }]);
      await page.click("#models-open");
      await page.waitForSelector(`${LIVE} [data-setup]`);
    },
    UI_TIMEOUT,
  );

  test(
    "the helpers are one row away, with a way back",
    async () => {
      await page.click("#models-go-helpers");
      await page.waitForSelector("#page-models .pg-back");
      expect(await page.innerText("#page-models")).toContain("Voice detection");
      await page.click("#page-models .pg-back");
      await page.waitForSelector(`${LIVE} [data-setup]`);
      expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe(
        "models-go-helpers",
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Settings leads here: its Live transcript row, and its search for a setting that lives here",
    async () => {
      await page.click("#settings-open");
      await page.waitForSelector("#settings-live");
      await page.click("#settings-live");
      await page.waitForSelector(`${LIVE} [data-setup]`);
      expect(await page.getAttribute("#models-open", "aria-current")).toBe("page");
      await page.click("#settings-open");
      await page.waitForSelector("#settings-search");
      await page.fill("#settings-search", "graphics");
      await page.waitForSelector("#settings-results:not([hidden]) [role=option]");
      expect(await page.textContent("#settings-results [role=option]")).toContain("Models");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#models-accelerator-row");
      await until(
        async () =>
          page.evaluate(() => !!document.activeElement?.closest("#models-accelerator-row")),
        5000,
        "the graphics chip focused",
      );
    },
    UI_TIMEOUT,
  );

  test(
    "a narrow window: nothing scrolls sideways",
    async () => {
      await page.setViewportSize({ width: 560, height: 800 });
      const overflow = await page.$eval("#pages", (d) => d.scrollWidth - d.clientWidth);
      expect(overflow <= 0).toBe(true);
    },
    UI_TIMEOUT,
  );
});
