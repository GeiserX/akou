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

            // 1. What akou is for, Both preselected; Cancel leaves even a first run, and no Skip.
            await page.waitForSelector("#welcome:not([hidden]) [data-use='both'] input:checked");
            expect(await title(page)).toBe("Welcome to akou");
            expect(await count(page)).toBe("Step 1 of 6");
            expect(await text(page, "#setup-back")).toBe("Cancel");
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

            // 3. Permissions, before the key that needs one: each with its state, a button only
            // where a pane can give it, read again as they change.
            await onStep(page, "Permissions");
            expect(rig.app.config().settings["recordings.root"]).toBe(calls);
            expect(
              requests.find((r) => r.method === "POST" && r.path === "/workspaces")?.body,
            ).toEqual({ name: "Personal" });
            expect(await page.evaluate(() => localStorage.getItem("akou.workspace"))).toBe(
              "Personal",
            );
            expect(await count(page)).toBe("Step 3 of 6");
            expect(await text(page, "#setup-lede")).toBe(
              "macOS asks for the microphone and system audio the first time akou needs them. The dictation key needs Accessibility, which you allow in System Settings.",
            );
            expect(await text(page, "#setup-grant-mic .setup-state")).toBe(
              "Asked the first time you record",
            );
            expect(await text(page, "#setup-grant-system-audio .setup-state")).toBe(
              "Asked the first time you record a call",
            );
            // macOS lists akou in those panes only after it asked: no button leads nowhere.
            expect(await page.isVisible("#setup-grant-mic button")).toBe(false);
            expect(await page.isVisible("#setup-grant-system-audio button")).toBe(false);
            expect(await text(page, "#setup-grant-accessibility .setup-state")).toBe("Not allowed");
            // Continue saves nothing here, so it is the only button.
            expect(await page.isVisible("#setup-skip")).toBe(false);
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

            // 4. Dictation: with Accessibility, the key as keycaps (Right Command), the engine,
            // the languages.
            await onStep(page, "Dictation");
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

            // 5. The speech models, Qwen with them for Best and in the total the one download
            // names; Continue waits for the download.
            await onStep(page, "Speech models");
            expect(f.patches).toEqual([{ "dictation.languages": ["en", "es"] }]);
            expect(await count(page)).toBe("Step 5 of 6");
            await page.waitForSelector(`#setup-best li[data-id="${QWEN_ASR}"]`);
            expect(await text(page, "#setup-best .sz")).toBe("66 KB");
            await until(
              async () => (await text(page, "#models-text")) === "One download, 197 KB",
              5000,
              "Qwen in the total",
            );
            expect(await text(page, "#models-size")).toBe("197 KB");
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

            // 6. The assistant, as Settings offers it; Finish, and no Skip beside it.
            await onStep(page, "Your assistant");
            expect(await text(page, "#setup-next")).toBe("Finish");
            expect(await page.isVisible("#setup-skip")).toBe(false);
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
        // Permissions first: no system audio without calls, and Accessibility given already.
        await onStep(page, "Permissions");
        expect(await count(page)).toBe("Step 2 of 5");
        expect(await text(page, "#setup-lede")).toBe(
          "macOS asks for the microphone the first time akou needs it. The dictation key needs Accessibility, which you allow in System Settings.",
        );
        expect(await page.$("#setup-grant-system-audio")).toBeNull();
        expect(await text(page, "#setup-grant-accessibility .setup-state")).toBe("Allowed");
        await page.click("#setup-next");
        await onStep(page, "Dictation");
        expect(await count(page)).toBe("Step 3 of 5");
        // Continue with nothing changed saves nothing: the languages drawn from the calls' are
        // not written as the user's own.
        await page.click("#setup-next");
        await onStep(page, "Speech models");
        expect(f.patches).toEqual([]);
        // A change left with Skip is not saved either.
        await page.click("#setup-back");
        await onStep(page, "Dictation");
        await page.selectOption("#setup-languages-add", "es");
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
        await onStep(page, "Your assistant");
        await page.waitForSelector("#setup-assistant select");
        await page.click("#setup-next");
        await page.waitForSelector("body[data-page='dictation'] #page-dictation:not([hidden])");
        expect(await page.isVisible("#welcome")).toBe(false);
        // The hidden welcome keeps no step: the assistant's rows carry the Settings page's ids.
        expect(await page.$("#setup-assistant")).toBeNull();
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

  test(
    "without Accessibility the key is a combination, said on its row and bound at Finish even when the step is skipped; another dictation key's binding is refused",
    async () => {
      await withRig({}, async (rig) => {
        let fx: DictationFixture | null = null;
        const page = await rig.open(undefined, {
          before: async (p) => {
            fx = await dictationFixture(p, {
              platform: "darwin",
              grants: { mic: "granted", accessibility: "denied" },
            });
            fx.settings["dictation.hotkeyDraft"] = "Control+Shift+D";
          },
        });
        const f = fx as unknown as DictationFixture;
        await page.waitForSelector("#record:not([hidden])");
        await page.click("#dictation-open");
        await page.click("#dictation-setup-open");
        await page.waitForSelector("#welcome:not([hidden]) [data-use='both'] input:checked");
        await page.check("[data-use='dictation'] input");
        await page.click("#setup-next");
        await onStep(page, "Permissions");
        expect(await text(page, "#setup-grant-accessibility .setup-state")).toBe("Not allowed");
        expect(await page.isVisible("#setup-grant-accessibility button")).toBe(true);
        await page.click("#setup-next");
        // Right Command alone cannot be bound without the grant: the row shows the combination.
        await onStep(page, "Dictation");
        expect(
          await page.$$eval("#setup-step .recorder kbd", (k) => k.map((x) => x.textContent)),
        ).toEqual(["⌃", "⇧", "Space"]);
        expect(await text(page, "#setup-step .pg-row .pg-help")).toBe(
          "Without Accessibility access the key must be a combination, so yours is Control+Shift+Space.",
        );
        // The draft key's binding is refused, as on the Dictation page (DC-U3).
        await page.click("#setup-step .record-key");
        await page.keyboard.press("Control+Shift+KeyD");
        expect(await text(page, "#setup-step .recorder-note")).toBe(
          "⌃ ⇧ D is already the draft key.",
        );
        await page.keyboard.press("Escape");
        // Skip saves nothing here; Finish still binds the combination, and says so.
        await page.click("#setup-skip");
        await onStep(page, "Speech models");
        expect(f.patches).toEqual([]);
        await page.click("#setup-next");
        await onStep(page, "Your assistant");
        await page.click("#setup-next");
        await page.waitForSelector("body[data-page='dictation'] #page-dictation:not([hidden])");
        expect(f.patches).toEqual([
          { "dictation.enabled": true, "dictation.hotkey": "Control+Shift+Space" },
        ]);
        expect(await text(page, "#toast")).toBe(
          "Without Accessibility access the dictation key must be a combination, so yours is Control+Shift+Space.",
        );
      });
    },
    UI_TIMEOUT,
  );

  test(
    "with the microphone refused, Finish leaves dictation off and says why; the refused grant has its button",
    async () => {
      await withRig({}, async (rig) => {
        let fx: DictationFixture | null = null;
        const page = await rig.open(undefined, {
          before: async (p) => {
            fx = await dictationFixture(p, {
              platform: "darwin",
              grants: { mic: "denied", accessibility: "granted" },
            });
          },
        });
        const f = fx as unknown as DictationFixture;
        await page.waitForSelector("#record:not([hidden])");
        await page.click("#dictation-open");
        await page.click("#dictation-setup-open");
        await page.waitForSelector("#welcome:not([hidden]) [data-use='both'] input:checked");
        await page.check("[data-use='dictation'] input");
        await page.click("#setup-next");
        await onStep(page, "Permissions");
        expect(await text(page, "#setup-grant-mic .setup-state")).toBe("Not allowed");
        expect(await page.isVisible("#setup-grant-mic button")).toBe(true);
        for (const next of ["Dictation", "Speech models", "Your assistant"]) {
          await page.click("#setup-next");
          await onStep(page, next);
        }
        await page.click("#setup-next");
        await page.waitForSelector("body[data-page='dictation'] #page-dictation:not([hidden])");
        expect(await text(page, "#toast")).toBe(
          "Dictation stays off: akou may not use the microphone. Allow it, then turn dictation on.",
        );
        expect(f.patches).toEqual([]);
        expect(JSON.parse((await saved(page)) ?? "{}")).toEqual({ done: true, use: "dictation" });
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a call recording without models keeps its controls on a first run; the setup waits for it to stop",
    async () => {
      // One model file that is not on disk: a first run; nothing is downloaded.
      const modelRegistry = [
        {
          id: "tiny",
          job: "test",
          licence: "MIT",
          source: "test",
          files: [
            { name: "a.onnx", url: "http://127.0.0.1:9/a.onnx", sha256: "0".repeat(64), size: 1e6 },
          ],
        },
      ];
      await withRig({ modelRegistry }, async (rig) => {
        const cli = { "x-akou-client": "cli" };
        const started = await rig.api("POST", "/calls", { withoutModels: true }, cli);
        expect(started.status).toBe(201);
        const page = await rig.open();
        await page.waitForSelector("#stop:not([hidden])");
        await Bun.sleep(500);
        expect(await page.isVisible("#welcome")).toBe(false);
        expect(await page.isVisible("#stop")).toBe(true);
        // Run the setup again while it records: a toast, and the call keeps the window.
        await page.click("#settings-open");
        await page.click("#settings-setup-open");
        await until(
          async () => (await text(page, "#toast")) === "The setup can run once this call stops.",
          5000,
          "the toast",
        );
        await page.click("#calls-open");
        expect(await page.isVisible("#welcome")).toBe(false);
        expect(await page.isVisible("#stop")).toBe(true);
        // Stopped: the first run's setup opens.
        const stop = await rig.api("POST", `/calls/${started.body.call}/stop`, {}, cli);
        expect(stop.status).toBeLessThan(300);
        await page.waitForSelector("#welcome:not([hidden]) [data-use='both'] input:checked", {
          timeout: 10_000,
        });
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a setup cancelled on its way back from Best's models step leaves Qwen out of the welcome's download",
    async () => {
      const reg = modelRegistry(64 * 1024);
      const catalog: ModelSpecEntry[] = [
        reg.entry(RECOGNIZER, ["a.onnx"]),
        reg.entry(NEMOTRON, ["d.onnx"]),
        { ...reg.entry(QWEN_ASR, ["q.gguf"]), onDemand: true } as ModelSpecEntry,
      ];
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
          async (rig) => {
            let requests: ReturnType<typeof sent> = [];
            const page = await rig.open(undefined, {
              before: async (p) => {
                requests = sent(p);
                await dictationFixture(p, { platform: "darwin" });
                await p.route("**/api/v1/server", async (route) => {
                  const res = await route.fetch();
                  return route.fulfill({
                    response: res,
                    json: { ...(await res.json()), gpu: "metal" },
                  });
                });
              },
            });
            await page.waitForSelector("#welcome:not([hidden]) [data-use='both'] input:checked");
            await page.click("#setup-next");
            for (const [step, how] of [
              ["Where calls go", "#setup-skip"],
              ["Permissions", "#setup-next"],
              ["Dictation", "#setup-skip"],
            ] as const) {
              await onStep(page, step);
              await page.click(how);
            }
            await onStep(page, "Speech models");
            await page.waitForSelector(`#setup-best li[data-id="${QWEN_ASR}"]`);
            await until(
              async () => (await text(page, "#models-text")) === "One download, 197 KB",
              5000,
              "Qwen in the total",
            );
            // Back to the first step, and Cancel: the welcome is the speech models alone.
            for (const step of ["Dictation", "Permissions", "Where calls go", "Welcome to akou"]) {
              await page.click("#setup-back");
              await onStep(page, step);
            }
            await page.click("#setup-back");
            await page.waitForSelector("#setup-bar", { state: "hidden" });
            expect(await title(page)).toBe("Speech models");
            await until(
              async () => (await text(page, "#models-text")) === "One download, 131 KB",
              5000,
              "the total without Qwen",
            );
            await page.click("#models-pull");
            await until(
              () => requests.some((r) => r.path === "/models/pull"),
              5000,
              "the speech models' download",
            );
            await Bun.sleep(500);
            expect(
              requests.filter((r) => r.path === "/models/pull").map((r) => r.body),
            ).not.toContainEqual({ model: QWEN_ASR });
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
});
