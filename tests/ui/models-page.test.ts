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
/** In the default set whichever speaker choice runs: the Voice fingerprints choice never holds it. */
const TITANET = "titanet-small";
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
    reg.entry(TITANET, ["t.onnx"]),
    // Qwen fetched on demand only: missing here.
    { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
    { ...reg.entry(STREAM, ["s.onnx"]), onDemand: true } as ModelSpecEntry,
  ];
  mkdirSync(models, { recursive: true });
  for (const m of catalog.slice(0, 5)) reg.install(models, m);
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
      expect(await page.textContent(`${LIVE} [data-setup="${RECOGNIZER}"]`)).toContain(
        "About 1 word in 3 wrong on meetings.",
      );
      const words = await page.innerText("#page-models");
      for (const bad of [RECOGNIZER, QWEN_ASR, "asr.", "server.", "docs/", "`", models])
        expect(`${bad}: ${words.includes(bad)}`).toBe(`${bad}: false`);
    },
    UI_TIMEOUT,
  );

  test(
    "the live transcript: four choices by model name, Automatic chosen and marked, Voxtral listed and unavailable; the second pass Off, with Qwen one download away",
    async () => {
      const ids = await page.$$eval(`${LIVE} [data-setup]`, (els) =>
        els.map((e) => (e as HTMLElement).dataset.setup),
      );
      expect(ids).toEqual(["auto", STREAM, RECOGNIZER, "voxtral"]);
      expect(await page.textContent(`${LIVE} [data-setup="${STREAM}"] .pg-name`)).toBe(
        "Nemotron English",
      );
      expect(await page.isChecked(`${LIVE} input[value="auto"]`)).toBe(true);
      expect(await page.textContent(`${LIVE} [data-setup="auto"] .pg-name`)).toBe(
        "Automatic (default)",
      );
      expect(await page.isDisabled(`${LIVE} input[value="voxtral"]`)).toBe(true);
      // No streaming model yet: Automatic runs Parakeet, and Nemotron is one Download away.
      expect(await marked()).toEqual(["auto"]);
      expect(await page.textContent(`${LIVE} [data-setup="auto"]`)).toContain(
        "Uses Parakeet until Nemotron English is on",
      );
      expect(await page.getAttribute(`${LIVE} [data-setup="${STREAM}"]`, "data-state")).toBe(
        "missing",
      );
      // The second pass: Off by default; Qwen needs its model, and says only that until it is here.
      const REVIEW = "#models-review";
      const choices = await page.$$eval(`${REVIEW} [data-review]`, (els) =>
        els.map((e) => (e as HTMLElement).dataset.review),
      );
      expect(choices).toEqual(["none", QWEN_ASR, RECOGNIZER]);
      expect(await page.isChecked(`${REVIEW} input[value="none"]`)).toBe(true);
      const qwen = (await page.textContent(`${REVIEW} [data-review="${QWEN_ASR}"] .pg-help`)) ?? "";
      expect(qwen).toMatch(/^Needs .*Qwen3-ASR 1\.7B\.$/);
      expect(await page.inputValue("#models-review-every")).toBe("60");
    },
    UI_TIMEOUT,
  );

  test(
    "a refused download says why in plain words, with the model's name and no id",
    async () => {
      const cap = await setting("server.models_max_gb");
      await rig.api("PATCH", "/config", { "server.models_max_gb": 1e-9 });
      try {
        await page.click(`${LIVE} [data-setup="${STREAM}"] [data-action="download"]`);
        await until(
          async () => ((await page.textContent("#toast")) ?? "").includes("size you keep"),
          5000,
          "the refusal",
        );
        const said = (await page.textContent("#toast")) ?? "";
        expect(said).toMatch(/^Nemotron streaming, English could not start downloading: /);
        for (const bad of [STREAM, "server.", "HTTP", "bytes"])
          expect(`${bad}: ${said.includes(bad)}`).toBe(`${bad}: false`);
      } finally {
        await rig.api("PATCH", "/config", { "server.models_max_gb": cap });
      }
    },
    UI_TIMEOUT,
  );

  test(
    "Download moves Automatic to Nemotron; a pick saves the setting and the mark follows it; the second pass and its interval save their keys",
    async () => {
      const nemotron = `${LIVE} [data-setup="${STREAM}"]`;
      await page.click(`${nemotron} [data-action="download"]`);
      await page.waitForSelector(`${nemotron}[data-state="ready"]`);
      await until(
        async () =>
          ((await page.textContent(`${LIVE} [data-setup="auto"]`)) ?? "").includes("Uses Nemotron"),
        5000,
        "Automatic on Nemotron",
      );
      patches.length = 0;
      await page.click(`${LIVE} [data-setup="${RECOGNIZER}"] .pg-name`);
      await until(async () => (await setting("asr.live")) === RECOGNIZER, 5000, "asr.live");
      expect(patches).toEqual([{ "asr.live": RECOGNIZER }]);
      await until(async () => (await marked()).join() === RECOGNIZER, 5000, "the mark");
      await page.click(`${LIVE} [data-setup="auto"] .pg-name`);
      await until(async () => (await setting("asr.live")) === "auto", 5000, "asr.live back");
      await until(async () => (await marked()).join() === "auto", 5000, "the mark back");
      patches.length = 0;
      await page.click(`#models-review [data-review="${QWEN_ASR}"] .pg-name`);
      await until(
        async () => (await setting("asr.review.model")) === QWEN_ASR,
        5000,
        "asr.review.model",
      );
      await page.selectOption("#models-review-every", "300");
      await until(
        async () => (await setting("asr.review.everySeconds")) === 300,
        5000,
        "asr.review.everySeconds",
      );
      expect(patches).toEqual([
        { "asr.review.model": QWEN_ASR },
        { "asr.review.everySeconds": 300 },
      ]);
      // An interval set elsewhere (10 min from the CLI) shows as itself in the list.
      await rig.api("PATCH", "/config", { "asr.review.everySeconds": 600 });
      await page.click("#calls-open");
      await page.click("#models-open");
      await page.waitForSelector("#models-review-every");
      expect(await page.inputValue("#models-review-every")).toBe("600");
      expect(await page.textContent('#models-review-every option[value="600"]')).toBe(
        "Every 10 min",
      );
      await rig.api("PATCH", "/config", {
        "asr.review.model": "none",
        "asr.review.everySeconds": 60,
      });
    },
    UI_TIMEOUT,
  );

  test(
    "the keyboard stays on the list: each arrow picks, saves, and the next arrow goes on",
    async () => {
      const focused = () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLInputElement | null;
          return el?.name === "models-live" ? el.value : `${el?.tagName}`;
        });
      await page.focus(`${LIVE} input[value="auto"]`);
      await page.keyboard.press("ArrowDown");
      await until(async () => (await setting("asr.live")) === STREAM, 5000, "the first arrow");
      // The pick redrew the list: the new radio has the keyboard.
      await until(async () => (await marked()).join() === STREAM, 5000, "the redraw");
      expect(await focused()).toBe(STREAM);
      await page.keyboard.press("ArrowDown");
      await until(async () => (await setting("asr.live")) === RECOGNIZER, 5000, "the second arrow");
      await until(async () => (await marked()).join() === RECOGNIZER, 5000, "the redraw");
      expect(await focused()).toBe(RECOGNIZER);
      await page.click(`${LIVE} [data-setup="auto"] .pg-name`);
      await until(async () => (await setting("asr.live")) === "auto", 5000, "asr.live back");
      await until(async () => (await marked()).join() === "auto", 5000, "the mark back");
    },
    UI_TIMEOUT,
  );

  test(
    "Fast shares After the call's model: while it is missing it offers no download of its own",
    async () => {
      await page.route("**/api/v1/models", async (r) => {
        const res = await r.fetch();
        const body = (await res.json()) as { models: { id: string; state: string }[] };
        for (const m of body.models) if (m.id === RECOGNIZER) m.state = "missing";
        await r.fulfill({ response: res, json: body });
      });
      try {
        await page.click("#models-open");
        await page.waitForSelector(`${AFTER}[data-state="missing"] [data-action="download"]`);
        const fast = `#models-dictation [data-model="${RECOGNIZER}"]`;
        expect(await page.textContent(fast)).toContain("Downloads with After the call.");
        expect(await page.textContent(fast)).not.toContain("nothing more to download");
        expect(await page.$(`${fast} button`)).toBeNull();
      } finally {
        await page.unroute("**/api/v1/models");
      }
      await page.click("#models-open");
      await page.waitForSelector(`${AFTER}[data-state="ready"]`);
    },
    UI_TIMEOUT,
  );

  test(
    "the default draws no Remove and its size says why; Remove asks once more, on that choice's model only",
    async () => {
      await page.hover(AFTER);
      expect(await page.$(`${AFTER} [data-action="remove"]`)).toBeNull();
      // The size says when an unused model goes, or why it stays.
      expect(await page.getAttribute(`${AFTER} .pg-value`, "title")).toContain(
        "Kept: akou needs it",
      );

      await page.hover(PRINTS);
      const remove = `${PRINTS} [data-action="remove"]`;
      await page.click(remove);
      expect(await page.textContent(remove)).toBe("Remove: sure?");
      expect(existsSync(join(models, PYANNOTE))).toBe(true);
      await page.click(remove);
      await page.waitForSelector(`${PRINTS}[data-state="missing"] [data-action="download"]`);
      expect(existsSync(join(models, PYANNOTE))).toBe(false);
      // TitaNet runs under the chosen Nemotron too: it stays, and is a helper of its own.
      expect(existsSync(join(models, TITANET))).toBe(true);
      await page.click(`${PRINTS} [data-action="download"]`);
      await page.waitForSelector(`${PRINTS}[data-state="ready"]`);
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
      // Each radio is named by its name, not by the size and buttons its row holds.
      const named = await page.$eval('#models-speakers input[value="embeddings"]', (el) => {
        const id = el.getAttribute("aria-labelledby");
        return id ? document.getElementById(id)?.textContent : null;
      });
      expect(named).toBe("Voice fingerprints");
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
      const text = await page.innerText("#page-models");
      expect(text).toContain("Voice detection");
      // TitaNet is here, not under a speaker choice.
      expect(text).toContain("Speaker voices");
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
    "a live model that does not hear the call's languages says why, and cannot be picked",
    async () => {
      const row = `${LIVE} [data-setup="${STREAM}"]`;
      await rig.api("PATCH", "/config", { "asr.languages": ["es"] });
      try {
        await page.click("#calls-open");
        await page.click("#models-open");
        await until(
          async () =>
            ((await page.textContent(row)) ?? "").includes("Nemotron English does not hear es."),
          5000,
          "the reason",
        );
        expect(await page.getAttribute(row, "data-state")).toBe("blocked");
        expect(await page.isDisabled(`${row} input.pg-radio`)).toBe(true);
      } finally {
        await rig.api("PATCH", "/config", { "asr.languages": ["en"] });
        await page.click("#calls-open");
        await page.click("#models-open");
        await page.waitForSelector(`${LIVE} [data-setup]`);
      }
    },
    UI_TIMEOUT,
  );

  test(
    "the narrowest window (480 px, the shell's minimum): nothing scrolls sideways",
    async () => {
      await page.setViewportSize({ width: 480, height: 800 });
      const overflow = await page.$eval("#pages", (d) => d.scrollWidth - d.clientWidth);
      expect(overflow <= 0).toBe(true);
    },
    UI_TIMEOUT,
  );
});
