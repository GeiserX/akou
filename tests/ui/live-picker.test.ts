/**
 * The live model picker in the Record row (docs/ux/WINDOW.md W3.19), on the real page over the
 * headless app: the menu lists the live models by name, a model that is not downloaded dim with
 * Get, no Automatic line and the check on what `auto` resolves to; "Live: no model" with Get
 * models opening the Models page when none is here; the choice saved as `asr.live` and sent as
 * the next call's `live`; the second pass's group saving `asr.review.model` and
 * `asr.review.everySeconds` and sent as the call's `review` and `reviewEvery`; and the button
 * showing the running call's model, disabled, while a call records. The catalog is a loopback
 * registry of tiny files named after the real models, so nothing comes from the network, and the
 * recognizer is the fake one.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { Probe } from "../../src/main/asr/accelerator.ts";
import { QWEN_ASR } from "../../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../../src/main/asr/models.ts";
import { NO_GPU, speechWav } from "../api-helpers.ts";
import { modelRegistry } from "../fixtures/model-registry.ts";
import { tempDir } from "../helpers.ts";
import { seedCall, standardCall, UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

/** The streaming model the `nemotron` setup runs for English. */
const STREAM = "nemotron-en-560";
const FAKE_LLAMA = join(import.meta.dir, "..", "fixtures", "fake-llama-server.ts");

/**
 * A rig whose models folder holds the first `installed` entries of the catalog: the recognizer,
 * the VAD, the speaker model, the English streaming model, then Qwen. With `roomy`, the machine
 * is a Mac with a GPU and 32 GB, and Qwen runs on an own llama-server (the fake one): the menus
 * offer Qwen's second pass.
 */
async function withModels<T>(
  installed: number,
  fn: (rig: UiRig, home: string) => Promise<T>,
  seed?: (home: string) => void,
  roomy = false,
): Promise<T> {
  const home = tempDir("akou-ui-live-");
  const reg = modelRegistry();
  const catalog: ModelSpecEntry[] = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
    { ...reg.entry(STREAM, ["s.onnx"]), onDemand: true } as ModelSpecEntry,
    { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
  ];
  const models = join(home.dir, "models");
  mkdirSync(models, { recursive: true });
  for (const m of catalog.slice(0, installed)) reg.install(models, m);
  seed?.(home.dir);
  const rig = await uiRig({
    home: home.dir,
    modelRegistry: catalog,
    helperArgs: ["--wav", speechWav(home.dir)],
    settings: {
      "asr.modelsDir": models,
      "asr.diarizer": "nemotron",
      "asr.languages": ["en"],
      ...(roomy ? { "asr.llamaServer": [process.execPath, FAKE_LLAMA] } : {}),
    },
    ...(roomy
      ? {
          accelerator: { probe: { ...(NO_GPU.probe as Probe), platform: "darwin-arm64" } },
          memoryGb: 32,
        }
      : {}),
  });
  try {
    return await fn(rig, home.dir);
  } finally {
    await rig.close();
    reg.stop();
    home.cleanup();
  }
}

const label = (page: Page) => page.textContent("#live-name");
const listed = (page: Page) =>
  page.$$eval("#live-menu .live-item[data-live]", (els) =>
    els.map((e) => {
      const item = e.querySelector('[role="menuitemradio"]') ?? e;
      return [
        (e as HTMLElement).dataset.live as string,
        e.querySelector(".live-title")?.textContent ?? "",
        item.getAttribute("aria-checked"),
        item.getAttribute("aria-disabled") === "true" ? "dim" : "ready",
      ];
    }),
  );
const reviews = (page: Page) =>
  page.$$eval("#live-review-group .live-item[data-review]", (els) =>
    els.map((e) => {
      const item = e.querySelector('[role="menuitemradio"]') ?? e;
      return [
        (e as HTMLElement).dataset.review as string,
        item.getAttribute("aria-checked"),
        item.getAttribute("aria-disabled") === "true" ? "dim" : "ready",
      ];
    }),
  );
const reviewName = (page: Page) => page.textContent("#live-review-name");

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

describe("W3.19: the live model picker in the Record row", () => {
  test(
    "the models by name with no Automatic line, the check on what auto runs, a pick saved as asr.live and sent with the call, and the running call's model shown, disabled",
    async () => {
      await withModels(4, async (rig) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        const w = writes();
        const page = await rig.open(undefined, { before: w.before });
        await page.waitForSelector("#live-pick:not([hidden])");
        // auto runs the English streaming model here: the button names it.
        await until(async () => (await label(page)) === "Nemotron English", 5000, "the model");
        await page.click("#live");
        await page.waitForSelector("#live-menu:not([hidden]) .live-item");
        expect(await listed(page)).toEqual([
          ["nemotron", "Nemotron English", "true", "ready"],
          ["parakeet", "Parakeet", "false", "ready"],
        ]);
        expect(await page.textContent("#live-menu")).not.toContain("Automatic");
        // Each model says what it does in plain words.
        expect(await page.textContent('#live-menu [data-live="nemotron"] .live-line')).toBe(
          "Words appear as they are said.",
        );

        // Picking saves asr.live, that key only, and the next call asks for it.
        await page.click('#live-menu [data-live="parakeet"]');
        await until(
          async () => (await rig.api("GET", "/config")).body.settings["asr.live"] === "parakeet",
          5000,
          "asr.live saved",
        );
        expect(patches(w.bodies)).toEqual([{ "asr.live": "parakeet" }]);
        expect(await label(page)).toBe("Parakeet");

        await page.click("#record");
        await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
        const start = w.bodies.find((b) => b.method === "POST" && b.path.endsWith("/calls"));
        expect(start?.body).toMatchObject({ live: "parakeet", review: "none", reviewEvery: 60 });
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

        // A call another door starts on another model: the button shows that call's, not the
        // choice, and goes back to the choice when it stops.
        const other = await rig.startCall({ live: "nemotron" });
        await until(
          async () => (await label(page)) === "Nemotron English",
          10_000,
          "the running model shown",
        );
        expect(await page.isDisabled("#live")).toBe(true);
        await rig.api("POST", `/calls/${other}/stop`);
        await until(async () => (await label(page)) === "Parakeet", 8000, "the choice back");
        expect(await page.isDisabled("#live")).toBe(false);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a model that is not downloaded is shown dim with Get: it cannot be picked, and Get opens the Models page",
    async () => {
      // Three models: no streaming model, so auto runs Parakeet.
      await withModels(3, async (rig) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        const w = writes();
        const page = await rig.open(undefined, { before: w.before });
        await until(async () => (await label(page)) === "Parakeet", 5000, "the model");
        await page.click("#live");
        await page.waitForSelector("#live-menu:not([hidden]) .live-item");
        expect(await listed(page)).toEqual([
          ["nemotron", "Nemotron English", "false", "dim"],
          ["parakeet", "Parakeet", "true", "ready"],
        ]);
        await page.click('#live-menu [data-live="nemotron"] .live-title');
        await Bun.sleep(300);
        expect(patches(w.bodies)).toEqual([]);
        expect(await page.isVisible("#live-menu")).toBe(true);
        await page.click('#live-menu [data-live="nemotron"] .live-get-one');
        await page.waitForSelector('body[data-page="models"] #page-models:not([hidden])');
        expect(await page.isHidden("#live-menu")).toBe(true);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "with no live model downloaded the button reads Live: no model, and Get models opens the Models page",
    async () => {
      let id = "";
      await withModels(
        0,
        async (rig) => {
          // A call picked in the sidebar lifts the welcome, so the Record row shows with no models.
          const page = await rig.open(id);
          await page.waitForSelector("#live-pick:not([hidden])");
          await until(async () => (await label(page)) === "no model", 5000, "no model");
          await page.click("#live");
          await page.waitForSelector("#live-menu:not([hidden]) #live-get");
          expect(await listed(page)).toEqual([]);
          expect(await page.textContent("#live-menu .live-none")).toContain(
            "No live model is downloaded",
          );
          await page.click("#live-get");
          await page.waitForSelector('body[data-page="models"] #page-models:not([hidden])');
          expect(await page.isHidden("#live-menu")).toBe(true);
        },
        (home) => {
          id = seedCall(home, (b) => standardCall(b)).id;
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "the second pass: Off by default; its group saves the model and the interval, stays open, and the next call asks for both; Escape closes the group first",
    async () => {
      await withModels(
        5,
        async (rig) => {
          await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
          const w = writes();
          const page = await rig.open(undefined, { before: w.before });
          await until(async () => (await label(page)) === "Nemotron English", 5000, "the model");
          await page.click("#live");
          await page.waitForSelector("#live-menu:not([hidden]) #live-review");
          expect(await reviewName(page)).toBe("Off");
          expect(await page.isHidden("#live-review-group")).toBe(true);
          await page.click("#live-review");
          await page.waitForSelector("#live-review-group");
          expect(await reviews(page)).toEqual([
            ["none", "true", "ready"],
            ["qwen", "false", "ready"],
            ["parakeet", "false", "ready"],
          ]);
          // With the second pass Off there is nothing to time.
          expect(await page.isDisabled('[data-every="120"]')).toBe(true);

          await page.click('#live-review-group [data-review="qwen"]');
          await until(
            async () => (await reviewName(page)) === "Qwen, every 1 min",
            5000,
            "Qwen chosen",
          );
          expect(await page.isVisible("#live-review-group")).toBe(true);
          await page.click('[data-every="120"]');
          await until(
            async () => (await reviewName(page)) === "Qwen, every 2 min",
            5000,
            "every 2 minutes",
          );
          expect(patches(w.bodies)).toEqual([
            { "asr.review.model": "qwen" },
            { "asr.review.everySeconds": 120 },
          ]);
          expect(await page.getAttribute('[data-every="120"]', "aria-checked")).toBe("true");

          // Escape in the group closes the group and leaves the menu open; again, the menu.
          await page.focus('#live-review-group [data-review="qwen"]');
          await page.keyboard.press("Escape");
          await until(async () => await page.isHidden("#live-review-group"), 3000, "group closed");
          expect(await page.isVisible("#live-menu")).toBe(true);
          expect(await page.evaluate(() => document.activeElement?.id)).toBe("live-review");
          await page.keyboard.press("ArrowRight");
          await page.waitForSelector("#live-review-group");
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          await until(async () => await page.isHidden("#live-menu"), 3000, "menu closed");
          expect(await page.evaluate(() => document.activeElement?.id)).toBe("live");

          await page.click("#record");
          await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
          const start = w.bodies.find((b) => b.method === "POST" && b.path.endsWith("/calls"));
          expect(start?.body).toMatchObject({ live: "auto", review: "qwen", reviewEvery: 120 });
          await until(
            async () =>
              (await page.textContent("#pill-live")) === "Live: Nemotron English, Qwen every 2 min",
            10_000,
            "the call header's chip",
          );
          // Recording: the whole menu, the second pass with it, waits for the next call.
          expect(await page.isDisabled("#live")).toBe(true);
          await page.click("#stop");
          await until(async () => (await page.textContent("#state")) === "saved", 8000, "stopped");

          // Parakeet live: Qwen's second pass is dim, says why, and calls run none.
          await rig.api("PATCH", "/config", { "asr.live": "parakeet" });
          // Opening the menu reads the models again, as it does after any change made elsewhere.
          await page.click("#live");
          await until(async () => (await label(page)) === "Parakeet", 5000, "Parakeet live");
          await page.click("#live-review");
          await page.waitForSelector("#live-review-group");
          expect(await page.textContent('#live-review-group [data-review="qwen"] .live-line')).toBe(
            "It reviews Nemotron's lines; the live model is Parakeet.",
          );
          expect(
            await page.textContent('#live-review-group [data-review="parakeet"] .live-line'),
          ).toBe("Parakeet already writes the live lines.");
          expect(await reviewName(page)).toBe("Off");
          // Off picked from there saves it.
          await page.click('#live-review-group [data-review="none"]');
          await until(
            async () =>
              (await rig.api("GET", "/config")).body.settings["asr.review.model"] === "none",
            5000,
            "Off saved",
          );
        },
        undefined,
        true,
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Qwen not downloaded is dim with Get in the second pass",
    async () => {
      await withModels(4, async (rig) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        const page = await rig.open();
        await until(async () => (await label(page)) === "Nemotron English", 5000, "the model");
        await page.click("#live");
        await page.click("#live-review");
        await page.waitForSelector("#live-review-group");
        expect(await reviews(page)).toEqual([
          ["none", "true", "ready"],
          ["qwen", "false", "dim"],
          ["parakeet", "false", "ready"],
        ]);
        await page.click('#live-review-group [data-review="qwen"] .live-get-one');
        await page.waitForSelector('body[data-page="models"] #page-models:not([hidden])');
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Record sends the settings as they are now, even when the CLI or API changed them after the window read them; at 1024 by 700 nothing is clipped and the button never covers the state word",
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
        // The menu with the second pass open fits the window.
        await page.click("#live");
        await page.click("#live-review");
        await page.waitForSelector("#live-review-group");
        const menu = await box("#live-menu");
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(1024);
        expect(menu.y + menu.height).toBeLessThanOrEqual(700);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");

        // `akou config set`, with the window idle and its menu closed.
        await rig.api("PATCH", "/config", {
          "asr.live": "parakeet",
          "asr.review.model": "none",
          "asr.review.everySeconds": 300,
        });
        await page.click("#record");
        await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
        expect(starts).toEqual([
          expect.objectContaining({ live: "parakeet", review: "none", reviewEvery: 300 }),
        ]);
        await until(
          async () => (await rig.api("GET", "/status")).body.live?.setup === "parakeet",
          10_000,
          "the call runs parakeet",
        );
        await page.click("#stop");
        await until(async () => (await page.textContent("#state")) === "saved", 8000, "stopped");

        // The longest name, while recording, in a 1024 px window: the button ends before REC and
        // cuts its name rather than grow past its box.
        await rig.api("PATCH", "/config", { "asr.live": "nemotron" });
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
    "a saved model that is not here checks nothing and names what runs; picking the one that is saves it",
    async () => {
      // Three models: no streaming model, so asr.live=nemotron falls back to Parakeet.
      await withModels(3, async (rig) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        await rig.api("PATCH", "/config", { "asr.live": "nemotron" });
        const page = await rig.open();
        await until(async () => (await label(page)) === "Parakeet", 5000, "the fallback named");
        await page.click("#live");
        await page.waitForSelector("#live-menu:not([hidden]) .live-item");
        expect(await page.$$('#live-menu [data-live][aria-checked="true"]')).toHaveLength(0);
        expect(await page.textContent("#live-menu .live-note")).toBe(
          "Nemotron English is not downloaded, so calls run Parakeet until it is.",
        );
        await page.click('#live-menu [data-live="parakeet"]');
        await until(
          async () => (await rig.api("GET", "/config")).body.settings["asr.live"] === "parakeet",
          5000,
          "Parakeet saved",
        );
        await page.click("#live");
        await until(
          async () =>
            (await page.getAttribute('#live-menu [data-live="parakeet"]', "aria-checked")) ===
            "true",
          5000,
          "Parakeet checked",
        );
      });
    },
    UI_TIMEOUT,
  );
});
