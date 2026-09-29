/**
 * The live model picker in the Record row (docs/ux/WINDOW.md W3.19), on the real page over the
 * headless app: the menu lists only the live setups whose models are on disk, "Live: no model"
 * with Get models opening the Models page when none is, the choice saved as `asr.live` and sent
 * as the next call's `live`, and the button showing the running call's setup, disabled, while a
 * call records. The catalog is a loopback registry of tiny files named after the real models, so
 * nothing comes from the network, and the recognizer is the fake one.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { QWEN_ASR } from "../../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../../src/main/asr/models.ts";
import { speechWav } from "../api-helpers.ts";
import { modelRegistry } from "../fixtures/model-registry.ts";
import { tempDir } from "../helpers.ts";
import { seedCall, standardCall, UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

/** The streaming model the `nemotron` setup runs for English. */
const STREAM = "nemotron-en-560";

/**
 * A rig whose models folder holds the first `installed` entries of the catalog: the recognizer,
 * the VAD, the speaker model and the English streaming model; Qwen is never there.
 */
async function withModels<T>(
  installed: number,
  fn: (rig: UiRig, home: string) => Promise<T>,
  seed?: (home: string) => void,
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
    settings: { "asr.modelsDir": models, "asr.diarizer": "nemotron", "asr.languages": ["en"] },
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
  page.$$eval("#live-menu .live-item", (els) =>
    els.map((e) => (e as HTMLElement).dataset.live as string),
  );

describe("W3.19: the live model picker in the Record row", () => {
  test(
    "only the setups downloaded here are listed, the choice is saved as asr.live and reaches POST /calls, and the button shows the running call's setup, disabled",
    async () => {
      await withModels(4, async (rig) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        const bodies: { method: string; path: string; body: unknown }[] = [];
        const page = await rig.open(undefined, {
          before: (p) =>
            p.on("request", (r) => {
              const path = new URL(r.url()).pathname;
              if (r.method() === "GET") return;
              bodies.push({ method: r.method(), path, body: r.postDataJSON() });
            }),
        });
        await page.waitForSelector("#live-pick:not([hidden])");
        await until(async () => (await label(page)) === "Automatic", 5000, "the setting");

        // The app knows the upgrade setup and says its Qwen is missing; the menu leaves it out.
        const setups = (await rig.api("GET", "/models")).body.live.setups as {
          id: string;
          models: { state: string }[];
        }[];
        const upgrade = setups.find((s) => s.id === "upgrade");
        expect(upgrade?.models.some((m) => m.state === "missing")).toBe(true);
        await page.click("#live");
        await page.waitForSelector("#live-menu:not([hidden]) .live-item");
        expect(await listed(page)).toEqual(["auto", "nemotron", "parakeet"]);
        expect(await page.getAttribute('#live-menu [data-live="auto"]', "aria-checked")).toBe(
          "true",
        );
        // Each line says what it does in plain words; Automatic names what it runs here.
        expect(await page.textContent('#live-menu [data-live="auto"] .live-line')).toContain(
          "Streaming (Nemotron)",
        );

        // Picking saves asr.live, that key only, and the next call asks for it.
        await page.click('#live-menu [data-live="parakeet"]');
        await until(
          async () => (await rig.api("GET", "/config")).body.settings["asr.live"] === "parakeet",
          5000,
          "asr.live saved",
        );
        const patch = bodies.filter((b) => b.method === "PATCH" && b.path.endsWith("/config"));
        expect(patch.map((b) => b.body)).toEqual([{ "asr.live": "parakeet" }]);
        expect(await label(page)).toBe("Parakeet between pauses");

        await page.click("#record");
        await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
        const start = bodies.find((b) => b.method === "POST" && b.path.endsWith("/calls"));
        expect(start?.body).toMatchObject({ live: "parakeet" });
        await until(
          async () => (await rig.api("GET", "/status")).body.live?.setup === "parakeet",
          10_000,
          "the call runs parakeet",
        );
        expect(await page.isDisabled("#live")).toBe(true);
        expect(await label(page)).toBe("Parakeet between pauses");
        await page.click("#stop");
        await until(async () => (await page.textContent("#state")) === "saved", 8000, "stopped");
        await until(async () => !(await page.isDisabled("#live")), 5000, "enabled again");

        // A call another door starts on another setup: the button shows that call's, not the
        // choice, and goes back to the choice when it stops.
        const other = await rig.startCall({ live: "nemotron" });
        await until(
          async () => (await rig.api("GET", "/status")).body.live?.setup === "nemotron",
          10_000,
          "the other call runs nemotron",
        );
        await until(
          async () => (await label(page)) === "Streaming (Nemotron)",
          5000,
          "the running setup shown",
        );
        expect(await page.isDisabled("#live")).toBe(true);
        await rig.api("POST", `/calls/${other}/stop`);
        await until(
          async () => (await label(page)) === "Parakeet between pauses",
          8000,
          "the choice back",
        );
        expect(await page.isDisabled("#live")).toBe(false);
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
          await page.waitForSelector("#models[open]");
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
    "Record sends asr.live as it is now, even when the CLI or API changed it after the window read it; at 1024 px the button never covers the state word",
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
        await until(async () => (await label(page)) === "Automatic", 5000, "the setting");

        // `akou config set asr.live parakeet`, with the window idle and its menu never opened.
        await rig.api("PATCH", "/config", { "asr.live": "parakeet" });
        await page.click("#record");
        await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
        expect(starts).toEqual([expect.objectContaining({ live: "parakeet" })]);
        await until(
          async () => (await rig.api("GET", "/status")).body.live?.setup === "parakeet",
          10_000,
          "the call runs parakeet",
        );
        await until(
          async () => (await label(page)) === "Parakeet between pauses",
          5000,
          "the running setup shown",
        );

        // The longest name, while recording, in a 1024 px window: the button ends before REC.
        const box = async (sel: string) => {
          const b = await page.locator(sel).boundingBox();
          if (!b) throw new Error(`${sel} has no box`);
          return b;
        };
        const state = await box("#state");
        const live = await box("#live");
        expect(live.x).toBeGreaterThanOrEqual(state.x + state.width);
        await page.click("#stop");
        await until(async () => (await page.textContent("#state")) === "saved", 8000, "stopped");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a saved setup whose model is not here checks no line, names what runs, and picking Automatic saves it",
    async () => {
      // Three models: no streaming model, so asr.live=nemotron falls back to Parakeet.
      await withModels(3, async (rig) => {
        await until(() => rig.app.recognizer() === "ready", 10_000, "the recognizer");
        await rig.api("PATCH", "/config", { "asr.live": "nemotron" });
        const page = await rig.open();
        await until(
          async () => (await label(page)) === "Parakeet between pauses",
          5000,
          "the fallback named",
        );
        await page.click("#live");
        await page.waitForSelector("#live-menu:not([hidden]) .live-item");
        expect(await listed(page)).toEqual(["auto", "parakeet"]);
        expect(await page.$$('#live-menu [aria-checked="true"]')).toHaveLength(0);
        expect(await page.textContent("#live-menu .live-note")).toBe(
          "Streaming (Nemotron) is not downloaded, so calls run Parakeet between pauses until it is.",
        );

        await page.click('#live-menu [data-live="auto"]');
        await until(
          async () => (await rig.api("GET", "/config")).body.settings["asr.live"] === "auto",
          5000,
          "Automatic saved",
        );
        await until(async () => (await label(page)) === "Automatic", 5000, "Automatic checked");
      });
    },
    UI_TIMEOUT,
  );
});
