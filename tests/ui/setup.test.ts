/**
 * The first-run setup in the welcome (src/ui/setup-wizard.ts, docs/ux/WINDOW.md section 10): what
 * akou is for, then only the steps that use needs, each writing through the APIs the pages use;
 * Finish turns dictation on when it was chosen and lands on Calls or the Dictation page; "Run the
 * setup again" on Settings and on the Dictation page reopens it with what is set now.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Request } from "playwright-core";
import { QWEN_ASR } from "../../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../../src/main/asr/models.ts";
import { modelRegistry } from "../fixtures/model-registry.ts";
import { tempDir } from "../helpers.ts";
import {
  type DictationFixture,
  dictationFixture,
  UI_TIMEOUT,
  type UiRig,
  uiRig,
  until,
} from "./rig.ts";

const text = async (page: Page, sel: string) =>
  (await page.locator(sel).first().textContent()) ?? "";
const title = (page: Page) => text(page, "#welcome h1");
const count = (page: Page) => text(page, "#setup-count");
/** Waits for the step whose title is `t`. */
const onStep = (page: Page, t: string) =>
  until(async () => (await title(page)) === t, 5000, `the step ${t}`);
const saved = (page: Page) => page.evaluate(() => localStorage.getItem("akou.setup"));

/** Every request the page sends to the API, with its body. */
function sent(page: Page): { method: string; path: string; body: unknown }[] {
  const out: { method: string; path: string; body: unknown }[] = [];
  page.on("request", (r: Request) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/v1/")) return;
    const data = r.postData();
    out.push({
      method: r.method(),
      path: u.pathname.slice(7),
      body: data ? JSON.parse(data) : undefined,
    });
  });
  return out;
}

async function withRig(
  o: Parameters<typeof uiRig>[0],
  fn: (rig: UiRig, home: string) => Promise<void>,
): Promise<void> {
  const t = tempDir("akou-ui-setup-");
  const rig = await uiRig({ ...o, home: t.dir });
  try {
    await fn(rig, t.dir);
  } finally {
    await rig.close();
    t.cleanup();
  }
}

describe("the first-run setup (WINDOW section 10)", () => {
  test(
    "a first run for both: each step in order writes through the APIs, Best adds Qwen to the one download, and Finish lands on Calls",
    async () => {
      const reg = modelRegistry(64 * 1024);
      const catalog: ModelSpecEntry[] = [
        reg.entry(RECOGNIZER, ["a.onnx"]),
        reg.entry(NEMOTRON, ["d.onnx"]),
        { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
      ];
      // The recognizer's file sends its first bytes, then waits: the download runs throughout.
      const release = reg.hold("a.onnx", 4096);
      try {
        const t = tempDir("akou-ui-setup-models-");
        const modelsDir = join(t.dir, "models");
        mkdirSync(modelsDir, { recursive: true });
        await withRig(
          {
            modelRegistry: catalog,
            settings: { "asr.modelsDir": modelsDir, "asr.diarizer": "nemotron" },
            jobs: { modelStore: { retryMs: [5, 5, 5], freeBytes: () => 1e12 } },
          },
          async (rig, home) => {
            let fx: DictationFixture | null = null;
            let requests: ReturnType<typeof sent> = [];
            const page = await rig.open(undefined, {
              before: async (p) => {
                requests = sent(p);
                fx = await dictationFixture(p, {
                  platform: "darwin",
                  grants: { mic: "not-asked", accessibility: "denied" },
                });
                // A GPU here: Automatic dictation runs on Best once Qwen is downloaded.
                await p.route("**/api/v1/server", async (route) => {
                  const res = await route.fetch();
                  return route.fulfill({
                    response: res,
                    json: { ...(await res.json()), gpu: "metal" },
                  });
                });
              },
            });
            const f = fx as unknown as DictationFixture;

            // 1. What akou is for, Both preselected; a first run has no way back and no Skip.
            await page.waitForSelector("#welcome:not([hidden]) [data-use='both'] input:checked");
            expect(await title(page)).toBe("Welcome to akou");
            expect(await count(page)).toBe("Step 1 of 6");
            expect(await page.isVisible("#setup-back")).toBe(false);
            expect(await page.isVisible("#setup-skip")).toBe(false);
            expect(await page.isVisible("#welcome-models")).toBe(false);
            await page.click("#setup-next");

            // 2. Where calls go: the folder as a name, and the first workspace, Personal.
            await onStep(page, "Where calls go");
            expect(await count(page)).toBe("Step 2 of 6");
            expect(await text(page, "#setup-folder")).toBe("akou in Recordings");
            expect(await page.inputValue("#setup-workspace")).toBe("Personal");
            await page.click("#setup-folder-change");
            const calls = join(home, "Calls");
            await page.fill("#setup-folder-path", calls);
            await page.click("#setup-next");

            // 3. Dictation: the key as keycaps (Right Command), the engine, the languages.
            await onStep(page, "Dictation");
            expect(rig.app.config().settings["recordings.root"]).toBe(calls);
            expect(
              requests.find((r) => r.method === "POST" && r.path === "/workspaces")?.body,
            ).toEqual({ name: "Personal" });
            expect(await page.evaluate(() => localStorage.getItem("akou.workspace"))).toBe(
              "Personal",
            );
            expect(
              await page.$$eval("#setup-step .recorder kbd", (k) => k.map((x) => x.textContent)),
            ).toEqual(["Right ⌘"]);
            expect(await page.isChecked("#setup-step input[data-value='auto']")).toBe(true);
            expect(await text(page, "#setup-step .pg-row:has(.pg-seg) .pg-help")).toBe(
              "Fast is instant. Best makes fewer mistakes. Automatic picks Best on this Mac.",
            );
            expect(
              await page.$$eval("#setup-languages .language-chip", (l) =>
                l.map((x) => (x as HTMLElement).dataset.code),
              ),
            ).toEqual(["en"]);
            await page.selectOption("#setup-languages-add", "es");
            await page.click("#setup-next");

            // 4. The speech models, Qwen with them for Best; Continue waits for the download.
            await onStep(page, "Speech models");
            expect(f.patches).toEqual([{ "dictation.languages": ["en", "es"] }]);
            expect(await count(page)).toBe("Step 4 of 6");
            await page.waitForSelector(`#setup-best li[data-id="${QWEN_ASR}"]`);
            expect(await text(page, "#setup-best .sz")).toBe("66 KB");
            expect(await page.isDisabled("#setup-next")).toBe(true);
            expect(await page.isVisible("#setup-skip")).toBe(false);
            await page.click("#models-pull");
            await until(
              () =>
                requests.some(
                  (r) =>
                    r.path === "/models/pull" &&
                    JSON.stringify(r.body) === JSON.stringify({ model: QWEN_ASR }),
                ),
              5000,
              "Qwen in the one download",
            );
            await until(async () => !(await page.isDisabled("#setup-next")), 5000, "Continue");
            await page.click("#setup-next");

            // 5. Permissions: each with its state and one button, read again as they change.
            await onStep(page, "Permissions");
            expect(await text(page, "#setup-lede")).toContain("macOS asks");
            expect(await text(page, "#setup-grant-mic .setup-state")).toBe(
              "Asked the first time you record",
            );
            expect(await text(page, "#setup-grant-system-audio .setup-state")).toBe(
              "Asked the first time you record a call",
            );
            expect(await text(page, "#setup-grant-accessibility .setup-state")).toBe("Not allowed");
            await page.click("#setup-grant-accessibility button");
            if (process.platform === "darwin") {
              await until(() => rig.opened.length === 1, 3000, "the Accessibility pane");
              expect(rig.opened[0]).toContain("Privacy_Accessibility");
            } else {
              await page.waitForSelector("#toast:not([hidden])");
            }
            f.grants = { mic: "granted", accessibility: "granted" };
            await until(
              async () =>
                (await text(page, "#setup-grant-accessibility .setup-state")) === "Allowed",
              5000,
              "the grant read again",
            );
            expect(await page.isVisible("#setup-grant-accessibility button")).toBe(false);
            expect(await text(page, "#setup-grant-mic .setup-state")).toBe("Allowed");
            await page.click("#setup-next");

            // 6. The assistant, as Settings offers it; Finish.
            await onStep(page, "Your assistant");
            expect(await text(page, "#setup-next")).toBe("Finish");
            await page.waitForSelector("#setup-assistant select");
            await page.selectOption("#setup-assistant select", "none");
            await until(
              () => rig.app.config().settings["provider.kind"] === "none",
              5000,
              "the assistant saved",
            );
            await page.click("#setup-next");

            // Dictation was chosen, so Finish turned it on; the models still download, so Calls is
            // their step alone until they are there.
            await until(
              async () => (await title(page)) === "Speech models",
              5000,
              "the models alone",
            );
            expect(f.patches.at(-1)).toEqual({ "dictation.enabled": true });
            expect(await page.isVisible("#setup-bar")).toBe(false);
            expect(JSON.parse((await saved(page)) ?? "{}")).toEqual({ done: true, use: "both" });
            expect(await text(page, "#workspace-name")).toBe("Personal");
            release();
            await page.waitForSelector("#welcome", { state: "hidden", timeout: 10_000 });
            expect(await page.isVisible("#record")).toBe(true);
          },
        );
        t.cleanup();
      } finally {
        release();
        reg.stop();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "Run the setup again on the Dictation page: dictation alone has five steps and no calls step, Skip writes nothing, and Finish lands on Dictation",
    async () => {
      await withRig({}, async (rig) => {
        let fx: DictationFixture | null = null;
        const page = await rig.open(undefined, {
          before: async (p) => {
            fx = await dictationFixture(p, { platform: "darwin" });
          },
        });
        const f = fx as unknown as DictationFixture;
        // The models are there: no setup on its own.
        await page.waitForSelector("#record:not([hidden])");
        expect(await page.isVisible("#welcome")).toBe(false);
        await page.click("#dictation-open");
        await page.click("#dictation-setup-open");
        await page.waitForSelector("#welcome:not([hidden]) [data-use='both'] input:checked");
        expect(await page.isVisible("#page-dictation")).toBe(false);
        // Asked for again: the first step's way back is Cancel.
        expect(await text(page, "#setup-back")).toBe("Cancel");
        await page.check("[data-use='dictation'] input");
        expect(await count(page)).toBe("Step 1 of 5");
        await page.click("#setup-next");
        await onStep(page, "Dictation");
        expect(await count(page)).toBe("Step 2 of 5");
        await page.click("#setup-skip");
        // The models are there: their rows, and no download.
        await onStep(page, "Speech models");
        await until(
          async () => (await text(page, "#models-text")) === "Downloaded, ready to use.",
          5000,
          "the models ready",
        );
        expect(await page.isVisible("#models-pull")).toBe(false);
        expect(await page.isVisible("#welcome-models")).toBe(true);
        expect(await page.isVisible("#setup-best")).toBe(false);
        await page.click("#setup-next");
        await onStep(page, "Permissions");
        expect(await page.$("#setup-grant-system-audio")).toBeNull();
        expect(await text(page, "#setup-grant-accessibility .setup-state")).toBe("Allowed");
        await page.click("#setup-skip");
        await onStep(page, "Your assistant");
        await page.click("#setup-skip");
        await page.waitForSelector("body[data-page='dictation'] #page-dictation:not([hidden])");
        expect(await page.isVisible("#welcome")).toBe(false);
        // Skipped steps saved nothing; Finish turned dictation on.
        expect(f.patches).toEqual([{ "dictation.enabled": true }]);
        expect(JSON.parse((await saved(page)) ?? "{}")).toEqual({ done: true, use: "dictation" });
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Run the setup again in Settings: it opens with what is set now, Change and Escape keep the folder, and Cancel goes back to Calls",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open(undefined, {
          before: (p) =>
            p.addInitScript(() => {
              localStorage.setItem("akou.setup", JSON.stringify({ done: true, use: "calls" }));
              localStorage.setItem("akou.workspace", "hiring");
            }),
        });
        await page.waitForSelector("#record:not([hidden])");
        await page.click("#settings-open");
        await page.click("#settings-setup-open");
        await page.waitForSelector("#welcome:not([hidden]) [data-use='calls'] input:checked");
        expect(await page.isVisible("#page-settings")).toBe(false);
        expect(await count(page)).toBe("Step 1 of 5");
        await page.click("#setup-next");
        await onStep(page, "Where calls go");
        expect(await page.inputValue("#setup-workspace")).toBe("hiring");
        await page.click("#setup-folder-change");
        expect(await page.isVisible("#setup-folder")).toBe(false);
        await page.fill("#setup-folder-path", "/elsewhere");
        await page.press("#setup-folder-path", "Escape");
        expect(await text(page, "#setup-folder")).toBe("akou in Recordings");
        expect(await page.isVisible("#setup-folder-path")).toBe(false);
        await page.click("#setup-back");
        await onStep(page, "Welcome to akou");
        await page.click("#setup-back");
        await page.waitForSelector("#welcome", { state: "hidden" });
        expect(await page.isVisible("#record")).toBe(true);
        // Nothing was saved: the folder is as it was.
        expect(String(rig.app.config().settings["recordings.root"])).toMatch(
          /Recordings[\\/]akou$/,
        );
      });
    },
    UI_TIMEOUT,
  );
});
