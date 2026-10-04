/**
 * The Settings page (docs/ux/design-explorations/sd-a-settings.html, WINDOW section 11): a page of
 * the main window beside the sidebar, not a dialog. It is left by the sidebar's Calls or a call;
 * every setting the Dictation page does not show has a home on it or on one of its Advanced pages,
 * with the file-only keys read only; a change saves that key alone; a refusal shows under the
 * row; typing then leaving saves; the search goes to a setting; and the page's words never quote a
 * key, a path of akou's own or a value in code quotes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { RECOGNIZER } from "../../src/main/asr/models.ts";
import { keychainStore } from "../../src/main/config/secrets.ts";
import { onDictationPage } from "../../src/ui/dictation-page.ts";
import { MODELS_KEYS } from "../../src/ui/models-rows.ts";
import { tempDir } from "../helpers.ts";
import { seedCall, standardCall, UI_TIMEOUT, type UiRig, uiRig, until, windowPage } from "./rig.ts";

async function withRig<T>(
  o: Parameters<typeof uiRig>[0] & { seed?: (home: string) => void },
  fn: (rig: UiRig) => Promise<T>,
): Promise<T> {
  const t = tempDir("akou-ui-");
  o.seed?.(t.dir);
  const rig = await uiRig({ ...o, home: t.dir });
  try {
    return await fn(rig);
  } finally {
    await rig.close();
    t.cleanup();
  }
}

/** Opens the Settings page from the sidebar and waits for its rows. */
async function openSettings(page: Page): Promise<void> {
  await page.click("#settings-open");
  await page.waitForSelector("#page-settings .pg-row[data-key='user.name']");
}

/** The keys the page on screen saves, and which of them it shows disabled. */
function keysOnScreen(page: Page): Promise<{ key: string; disabled: boolean }[]> {
  return page.$$eval("#page-settings [data-key]:not(.pg-row)", (els) =>
    els.map((e) => ({
      key: (e as HTMLElement).dataset.key as string,
      disabled:
        (e as HTMLInputElement).disabled ||
        !!e.closest(".pg-row")?.querySelector("input:disabled, select:disabled, textarea:disabled"),
    })),
  );
}

/** The PATCH /config bodies the page sends from now on. */
function patches(page: Page): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && new URL(r.url()).pathname.endsWith("/config"))
      out.push(JSON.parse(r.postData() ?? "{}"));
  });
  return out;
}

describe("the Settings page", () => {
  test(
    "a page in the window, not a dialog: it hides the call, the sidebar marks it, Calls and a call lead back",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await openSettings(page);
          expect(await page.$("dialog#settings")).toBeNull();
          expect(await page.isVisible("#page-settings")).toBe(true);
          for (const sel of ["#composer", "#scroller", "#side"])
            expect(`${sel}: ${await page.isVisible(sel)}`).toBe(`${sel}: false`);
          expect(await page.getAttribute("#settings-open", "aria-current")).toBe("page");
          expect(await page.getAttribute("#calls-open", "aria-current")).toBeNull();
          // The call it left is not marked too: one row says where the window is.
          await page.waitForSelector('#calls [aria-current="true"]', { state: "detached" });

          await page.click("#calls-open");
          await page.waitForSelector("#page-settings", { state: "hidden" });
          expect(await page.isVisible("#scroller")).toBe(true);
          expect(await page.getAttribute("#calls-open", "aria-current")).toBe("page");

          // A call in the sidebar leads back too.
          await openSettings(page);
          await page.click(`#calls button[data-id="${id}"]`);
          await page.waitForSelector("#page-settings", { state: "hidden" });
          expect(await page.isVisible("#lines")).toBe(true);
          await page.waitForSelector(`#calls button[data-id="${id}"][aria-current="true"]`);

          // The application menu's Settings… opens the page, as the sidebar does.
          await page.evaluate(() => document.getElementById("settings-open")?.click());
          await page.waitForSelector("#page-settings:not([hidden])");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "every key but Dictation's has a home, file-only keys read only; the words quote no key or path",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await openSettings(page);
        const cfg = (await rig.api("GET", "/config")).body;
        const schema = cfg.schema as Record<string, { apiWritable: boolean }>;
        const seen = new Map<string, boolean>();
        const words: string[] = [];
        const collect = async () => {
          for (const k of await keysOnScreen(page)) seen.set(k.key, k.disabled);
          words.push(await page.innerText("#page-settings"));
        };
        await collect();
        const subs = await page.$$eval("#page-settings button.pg-link[id^='settings-go-']", (b) =>
          b.map((x) => x.id),
        );
        expect(subs.length).toBeGreaterThanOrEqual(5);
        for (const sub of subs) {
          await page.click(`#${sub}`);
          await page.waitForSelector("#page-settings .pg-back");
          await collect();
          await page.click("#page-settings .pg-back");
          await page.waitForSelector(`#${sub}`);
        }
        // The after-call row says what the file sends where; the models' settings are on Models.
        const byHand = new Set<string>(["hooks", "webhook.url", ...MODELS_KEYS]);
        const home = Object.keys(schema).filter((k) => !onDictationPage(k) && !byHand.has(k));
        expect(home.filter((k) => !seen.has(k))).toEqual([]);
        // And the Models page holds each of those.
        await page.click("#models-open");
        await page.waitForSelector("#page-models #models-go-all");
        const onModels = await page.$$eval("#page-models [data-key]:not(.pg-row)", (els) =>
          els.map((e) => (e as HTMLElement).dataset.key as string),
        );
        if (await page.$("#page-models input[name='models-live']")) onModels.push("asr.live");
        if (await page.$("#page-models input[name='models-review']"))
          onModels.push("asr.review.model");
        if (await page.$("#page-models input[name='models-speakers']"))
          onModels.push("asr.diarizer");
        expect(MODELS_KEYS.filter((k) => !onModels.includes(k))).toEqual([]);
        await page.click("#settings-open");
        await page.waitForSelector("#page-settings .pg-row[data-key='user.name']");
        for (const k of home) {
          expect({ k, disabled: seen.get(k) }).toEqual({
            k,
            disabled: schema[k]?.apiWritable === false,
          });
        }
        // The equality above holds on an empty list too: a key the file alone sets is on screen,
        // read only, so the check sees at least one.
        expect(seen.get("provider.baseUrl")).toBe(true);
        expect(seen.get("provider.harnessPath")).toBe(true);
        // The Dictation page's keys are not here.
        expect([...seen.keys()].filter((k) => onDictationPage(k))).toEqual([]);
        // No key, no backtick, no path of akou's own.
        const all = words.join("\n");
        for (const k of Object.keys(schema)) expect(`${k}: ${all.includes(k)}`).toBe(`${k}: false`);
        expect(all).not.toContain("`");
        expect(all).not.toContain(cfg.file as string);
        expect(all).not.toContain(rig.home);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "each change saves that key alone; a refusal shows under its row; typing then leaving saves",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        const sent = patches(page);
        await openSettings(page);
        // A switch.
        await page.click("#set-app-openAtLogin");
        await until(() => sent.length === 1, 5000, "the switch's save");
        expect(sent[0]).toEqual({ "app.openAtLogin": true });
        // A segmented choice.
        await page.click("#page-settings .pg-row[data-key='memo.provider'] label:has-text('Off')");
        await until(() => sent.length === 2, 5000, "the choice's save");
        expect(sent[1]).toEqual({ "memo.provider": "off" });
        // Call audio: None, then back to the whole computer, each one key.
        await page.click("#page-settings .pg-row[data-key='capture.call'] label:has-text('None')");
        await until(() => sent.length === 3, 5000, "call audio");
        expect(sent[2]).toEqual({ "capture.call": "none" });
        // A number out of range is refused, under its row, and nothing is saved.
        await page.click("#settings-go-speech");
        await page.fill("#set-asr-threads", "999");
        await page.press("#set-asr-threads", "Tab");
        await page.waitForSelector(".pg-row.refused[data-key='asr.threads'] .issue");
        expect(await page.textContent(".pg-row[data-key='asr.threads'] .issue")).not.toContain(
          "asr.threads",
        );
        expect((await rig.api("GET", "/config")).body.settings["asr.threads"]).not.toBe(999);
        await page.fill("#set-asr-threads", "3");
        await page.press("#set-asr-threads", "Tab");
        await until(
          async () => (await rig.api("GET", "/config")).body.settings["asr.threads"] === 3,
          5000,
          "the good value",
        );
        // The page hears the answer after the file has it: wait for the refusal to go.
        await page.waitForSelector(".pg-row.refused[data-key='asr.threads']", {
          state: "detached",
        });
        // Typed into a field and left by the sidebar, with the field still focused: it saves.
        await page.click("#page-settings .pg-back");
        // The words are in the field and no change has fired, as when WebKit leaves the focus in
        // it on a click: only the page's leaving can save them.
        await page.$eval("#set-user-name", (el) => {
          (el as HTMLInputElement).value = "Ana Maria";
        });
        await page.click("#calls-open");
        await until(
          async () => (await rig.api("GET", "/config")).body.settings["user.name"] === "Ana Maria",
          5000,
          "the name saved on leaving",
        );
        expect(sent.every((p) => Object.keys(p).length === 1)).toBe(true);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "call audio's One app picks from the apps playing now, keeps one that is not, and takes a typed id",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        const sent = patches(page);
        await openSettings(page);
        const row = "#page-settings .pg-row[data-key='capture.call']";
        const pick = "#set-capture-call-pick";
        const typed = "#set-capture-call-app";
        const options = () =>
          page.$$eval(`${pick} option`, (os) =>
            os.map((o) => [(o as HTMLOptionElement).value, o.textContent]),
          );
        // The whole computer by default: no list until One app is chosen.
        expect(await page.isVisible(pick)).toBe(false);
        await page.click(`${row} label:has-text('One app')`);
        await page.waitForSelector(`${pick}:visible`);
        // The fake helper's apps by name, a first row asking for one and the typed way last.
        expect(await options()).toEqual([
          ["", "Choose an app"],
          ["com.example.call", "Example Call"],
          ["com.example.music", "com.example.music"],
          ["~", "An app by its id…"],
        ]);
        // Choosing the mode saves nothing until an app is picked.
        expect(sent).toEqual([]);
        await page.selectOption(pick, "com.example.call");
        await until(() => sent.length === 1, 5000, "the app's save");
        expect(sent[0]).toEqual({ "capture.call": "app:com.example.call" });
        // An app not running now, by its id.
        expect(await page.isVisible(typed)).toBe(false);
        await page.selectOption(pick, "~");
        await page.waitForSelector(`${typed}:visible`);
        await page.fill(typed, "us.zoom.xos");
        await page.press(typed, "Tab");
        await until(() => sent.length === 2, 5000, "the typed app's save");
        expect(sent[1]).toEqual({ "capture.call": "app:us.zoom.xos" });
        // Shown again, the saved app stays chosen, marked as not playing, never swapped.
        await page.click("#calls-open");
        await openSettings(page);
        await page.waitForSelector(`${pick}:visible`);
        expect(await page.inputValue(pick)).toBe("us.zoom.xos");
        expect((await options()).at(-2)).toEqual(["us.zoom.xos", "us.zoom.xos (not playing now)"]);
        expect(await page.textContent(row)).toContain("Whole computer is the default");
        await page.click(`${row} label:has-text('Whole computer')`);
        await until(() => sent.length === 3, 5000, "back to the whole computer");
        expect(sent[2]).toEqual({ "capture.call": "system" });
        expect(await page.isVisible(pick)).toBe(false);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "where one app cannot be recorded, One app is not offered and the row says why",
    async () => {
      await withRig({ helperArgs: ["--no-apps"] }, async (rig) => {
        const page = await rig.open();
        await openSettings(page);
        const row = "#page-settings .pg-row[data-key='capture.call']";
        expect(await page.$(`${row} input[data-value='app']`)).toBeNull();
        expect(await page.$(`${row} input[data-value='system']`)).not.toBeNull();
        expect(await page.$("#set-capture-call-pick")).toBeNull();
        expect(await page.textContent(row)).toContain(
          "Capturing one app is not available on this fake.",
        );
        // An app saved before shows as one app that cannot work here, not as the whole computer.
        const r = await rig.api("PATCH", "/config", { "capture.call": "app:com.example.call" });
        expect(r.status).toBeLessThan(400);
        await page.click("#calls-open");
        await openSettings(page);
        const app = `${row} input[data-value='app']`;
        await page.waitForSelector(app, { state: "attached" });
        expect(await page.isChecked(app)).toBe(true);
        expect(await page.textContent(`${row} label:has(input[data-value='app'])`)).toBe(
          "One app (not available here)",
        );
        expect(await page.isVisible("#set-capture-call-app")).toBe(false);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Server mode's engine for other computers' dictation is a choice in words, as on the server's page",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await openSettings(page);
        const sent = patches(page);
        await page.click("#settings-go-server");
        const engine = "#page-settings select#set-server-dictation-engine";
        await page.waitForSelector(engine);
        const choices = await page.$$eval(`${engine} option`, (o) => o.map((x) => x.textContent));
        expect(choices[0]).toBe("Automatic");
        expect(choices).toContain("Fast");
        expect(choices).toContain("Best");
        expect(choices.at(-1)).toBe("A model, by its id…");
        await page.selectOption(engine, "best");
        await until(() => sent.length === 1, 5000, "the save");
        expect(sent).toEqual([{ "server.dictation_engine": "best" }]);
        // Sent is not saved yet: the request is seen as it leaves the page.
        await until(
          async () =>
            (await rig.api("GET", "/config")).body.settings["server.dictation_engine"] === "best",
          5000,
          "the engine saved",
        );
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Settings clicked again from an Advanced page saves what is typed there first",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        const sent = patches(page);
        await openSettings(page);
        await page.click("#settings-go-speech");
        // Typed, with no change fired, as when WebKit keeps the focus in the field on a click.
        await page.$eval("#set-asr-threads", (el) => {
          (el as HTMLInputElement).value = "5";
        });
        await page.click("#settings-open");
        await page.waitForSelector("#settings-go-speech");
        await until(
          async () => (await rig.api("GET", "/config")).body.settings["asr.threads"] === 5,
          5000,
          "the threads saved on showing Settings again",
        );
        expect(sent).toEqual([{ "asr.threads": 5 }]);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "defaults read as values: any language, the share choice, the shortcut named for a screen reader",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        const sent = patches(page);
        await openSettings(page);
        // No language chosen means any: it says so, beside the add list.
        expect(await page.textContent("#settings-call-languages .language-none")).toBe(
          "Any language",
        );
        // The rig's share links listen on this computer: a choice in words, not the address.
        const bind = "#set-share-bind";
        expect(
          await page.$eval(bind, (s) => (s as HTMLSelectElement).selectedOptions[0]?.text),
        ).toBe("Only this computer");
        expect(await page.isVisible(`${bind}-address`)).toBe(false);
        // An address is typed into a field and saved alone.
        await page.selectOption(bind, "~");
        await page.fill(`${bind}-address`, "192.0.2.5");
        await page.press(`${bind}-address`, "Tab");
        await until(() => sent.length === 1, 5000, "the address saved");
        expect(sent[0]).toEqual({ "share.bind": "192.0.2.5" });
        await page.selectOption(bind, "lan");
        await until(() => sent.length === 2, 5000, "the local network saved");
        expect(sent[1]).toEqual({ "share.bind": "lan" });
        // The keycaps are hidden from a screen reader: the button says the shortcut.
        const change = ".pg-row[data-key='app.hotkey'] button.record-key";
        expect(await page.getAttribute(change, "aria-label")).toMatch(
          /^Change record shortcut, now \S/,
        );
        // Recorded, then back to the default with Use default.
        expect(await page.isVisible("#settings-hotkey-default")).toBe(false);
        await page.click(change);
        await page.keyboard.press("Control+Shift+KeyK");
        await until(() => sent.length === 3, 5000, "the shortcut saved");
        expect(await page.getAttribute(change, "aria-label")).toBe(
          "Change record shortcut, now Control Shift K",
        );
        await page.click("#settings-hotkey-default");
        await until(() => sent.length === 4, 5000, "the default saved");
        expect(sent[3]).toEqual({ "app.hotkey": "" });
        expect(await page.isVisible("#settings-hotkey-default")).toBe(false);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "with the speech models missing, the foot says so in words and leads to Models",
    async () => {
      // One model file that is not on disk: the engine waits for the models.
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
        expect((await rig.api("GET", "/status")).body.asr.reason).toContain("models");
        const page = await rig.open();
        await openSettings(page);
        const foot = await page.innerText("#page-settings .pg-foot");
        expect(await page.textContent("#settings-engine-state")).toBe(
          "The speech models are not downloaded yet.",
        );
        expect(foot).not.toContain("`");
        expect(foot).not.toContain(rig.home);
        expect(foot).not.toContain("akou models");
        await page.click("#settings-get-models");
        await page.waitForSelector("#page-models:not([hidden])");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Server mode's job defaults are selects in words: the model and the dictation engine by name, the language as Detect it or its name",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        const sent = patches(page);
        await openSettings(page);
        await page.click("#settings-go-server");
        const model = "#page-settings select[data-key='server.default_model']";
        const language = "#page-settings select[data-key='server.default_language']";
        // The engine's select is the one of selectOrTyped: its key is on the hidden input it sets.
        const engine = "#page-settings select#set-server-dictation-engine";
        await page.waitForSelector(model);
        const picked = (sel: string) =>
          page.$eval(sel, (s) => (s as HTMLSelectElement).selectedOptions[0]?.text);
        const labels = (sel: string) =>
          page.$$eval(`${sel} option`, (o) => o.map((x) => x.textContent ?? ""));
        expect(await picked(model)).toBe("Automatic");
        expect(await picked(engine)).toBe("Automatic");
        expect(await picked(language)).toBe("Detect it");
        for (const sel of [model, engine]) {
          const words = await labels(sel);
          expect(words).toContain("Fast");
          expect(words).toContain("Parakeet v3");
          expect(words).not.toContain(RECOGNIZER);
        }
        expect(await labels(language)).toContain("Spanish");
        await page.selectOption(language, "es");
        await until(() => sent.length === 1, 5000, "the language saved");
        expect(sent[0]).toEqual({ "server.default_language": "es" });
        await page.selectOption(model, "best");
        await until(() => sent.length === 2, 5000, "the model saved");
        expect(sent[1]).toEqual({ "server.default_model": "best" });
        await page.selectOption(engine, RECOGNIZER);
        await until(() => sent.length === 3, 5000, "the engine saved");
        expect(sent[2]).toEqual({ "server.dictation_engine": RECOGNIZER });
        // Sent is not saved yet: wait for the file to hold all three.
        const saved = async () => (await rig.api("GET", "/config")).body.settings;
        const three = async () => {
          const v = await saved();
          return [
            v["server.default_language"],
            v["server.default_model"],
            v["server.dictation_engine"],
          ];
        };
        await until(
          async () => (await three()).join() === ["es", "best", RECOGNIZER].join(),
          5000,
          "all three in the file",
        );
      });
    },
    UI_TIMEOUT,
  );

  test(
    "the search finds a setting on an Advanced page and goes to it, focused",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await openSettings(page);
        await page.fill("#settings-search", "threads");
        await page.waitForSelector("#settings-results:not([hidden]) [role=option]");
        expect(await page.textContent("#settings-results [role=option]")).toContain(
          "Speech engines",
        );
        await page.keyboard.press("Enter");
        await page.waitForSelector("#page-settings .pg-back");
        await until(
          async () =>
            (await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)) ===
            "set-asr-threads",
          5000,
          "the threads field focused",
        );
        // Words that match nothing say so.
        await page.click("#page-settings .pg-back");
        await page.fill("#settings-search", "zzzz");
        expect(await page.textContent("#settings-results")).toBe("No setting has those words.");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "the record shortcut shows its default as keycaps and records a new one with Change",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        const sent = patches(page);
        await openSettings(page);
        const caps = () =>
          page.$$eval(".pg-row[data-key='app.hotkey'] .keycaps kbd", (k) =>
            k.map((x) => x.textContent),
          );
        // Empty in the file: the default binding is what shows, never an empty field.
        expect((await caps()).length).toBeGreaterThan(1);
        await page.click(".pg-row[data-key='app.hotkey'] button.record-key");
        await page.keyboard.press("Control+Shift+KeyK");
        await until(() => sent.length === 1, 5000, "the shortcut saved");
        expect(sent[0]).toEqual({ "app.hotkey": "Control+Shift+K" });
        expect((await caps()).at(-1)).toBe("K");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "the file-only settings open the config file",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await openSettings(page);
        await page.click(".pg-row:has(#settings-after-call) button");
        await until(() => rig.opened.length === 1, 3000, "the config file opened");
        const file = (await rig.api("GET", "/config")).body.file as string;
        expect(rig.opened[0]).toBe(file);
      });
    },
    UI_TIMEOUT,
  );
});

const KEY = "sk-ant-ui-7d31b0";

describe("the assistant on the Settings page", () => {
  test(
    "four uses, each saving what it is; the key shows Saved in Keychain and Replace, never the key",
    async () => {
      const t = tempDir("akou-kc-");
      const store = join(t.dir, "keychain.json");
      const secrets = keychainStore({
        command: [process.execPath, join(import.meta.dir, "..", "fixtures", "fake-security.ts")],
        env: { ...process.env, FAKE_SECURITY_STORE: store },
      });
      try {
        await withRig({ secrets }, async (rig) => {
          // The desktop window, whose saves run in process: the address is its to change.
          const w = await windowPage(rig, { platform: "darwin" });
          const page = w.page;
          const sent = w.configPatches;
          await openSettings(page);
          const use = "#set-provider-kind";
          const options = await page.$$eval(`${use} option`, (o) => o.map((x) => x.textContent));
          expect(options.slice(1)).toEqual(["Use an API key", "Local model (Ollama)", "None"]);
          expect(options[0]).toBe("Claude Code or Codex on this Mac");
          expect(await page.inputValue(use)).toBe("none");
          expect(await page.$("#settings-provider-service")).toBeNull();

          // An API key: Anthropic first, and a field to paste the key into.
          await page.selectOption(use, "key");
          await until(() => sent.length === 1, 5000, "the use saved");
          expect(sent[0]).toEqual({ "provider.kind": "anthropic" });
          // The assistant applies at once: no word about the next start.
          await page.waitForFunction(
            () => document.getElementById("toast")?.textContent === "Saved.",
          );
          await page.waitForSelector("#settings-provider-service input[value='anthropic']:checked");
          expect(await page.$(".pg-row[data-key='provider.baseUrl']")).toBeNull();
          const field = "#set-provider-apiKey";
          expect(await page.getAttribute(field, "type")).toBe("password");
          expect(await page.getAttribute(field, "placeholder")).toBe("Paste your key");
          await page.fill(field, KEY);
          await page.press(field, "Enter");
          await until(() => sent.length === 2, 5000, "the key saved");
          expect(sent[1]).toEqual({ "provider.apiKey": KEY });
          await page.waitForSelector("#settings-key-saved");
          expect(await page.textContent("#settings-key-saved")).toBe("Saved in Keychain");
          expect(await page.isVisible("#settings-key-replace")).toBe(true);
          expect(await page.isVisible(field)).toBe(false);
          expect(await page.inputValue(field)).toBe("");
          expect(await page.innerText("#page-settings")).not.toContain(KEY);
          expect(JSON.parse(readFileSync(store, "utf8"))["akou/provider.apiKey"]).toBe(KEY);
          expect(readFileSync(rig.app.config().paths.configFile, "utf8")).not.toContain(KEY);
          expect(await page.textContent("#settings-provider-state")).toBe(
            "Uses the Anthropic API.",
          );

          // Replace opens the field; Escape puts Saved back and sends nothing.
          await page.click("#settings-key-replace");
          expect(await page.evaluate(() => document.activeElement?.id)).toBe("set-provider-apiKey");
          expect(await page.isVisible("#settings-key-saved")).toBe(false);
          await page.keyboard.type("sk-typo");
          await page.keyboard.press("Escape");
          expect(await page.isVisible("#settings-key-saved")).toBe(true);
          expect(await page.isVisible(field)).toBe(false);
          // What was typed went with the Escape: showing the page again, which saves what is still
          // typed, sends nothing.
          await openSettings(page);
          await page.waitForSelector("#settings-key-saved");
          expect(sent.length).toBe(2);

          // An OpenAI-compatible server: OpenAI's address as the value, and a model to name.
          await page.click("#settings-provider-service label:has-text('OpenAI-compatible')");
          await until(() => sent.length === 3, 5000, "the service saved");
          expect(sent[2]).toEqual({
            "provider.kind": "openai-compatible",
            "provider.baseUrl": "https://api.openai.com/v1",
          });
          await page.waitForSelector(".pg-row[data-key='provider.baseUrl']");
          const address = "#set-provider-baseUrl";
          expect(await page.isDisabled(address)).toBe(false);
          expect(await page.inputValue(address)).toBe("https://api.openai.com/v1");
          expect(await page.textContent("#settings-provider-state")).toBe(
            "The OpenAI-compatible server is not available: Model is not set.",
          );
          await page.fill(address, "https://llm.example/v1");
          await page.press(address, "Tab");
          await until(() => sent.length === 4, 5000, "the address saved");
          expect(sent[3]).toEqual({ "provider.baseUrl": "https://llm.example/v1" });
          const model = "#set-provider-model";
          await page.fill(model, "gpt-5-mini");
          await page.press(model, "Tab");
          await until(() => sent.length === 5, 5000, "the model saved");
          expect(sent[4]).toEqual({ "provider.model": "gpt-5-mini" });
          expect(await page.inputValue(use)).toBe("key");

          // A local model: Ollama's address, and a model of its own, not OpenAI's.
          await page.selectOption(use, "ollama");
          await until(() => sent.length === 6, 5000, "Ollama saved");
          expect(sent[5]).toEqual({
            "provider.kind": "openai-compatible",
            "provider.baseUrl": "http://127.0.0.1:11434/v1",
            "provider.model": null,
          });
          await page.waitForSelector("#page-settings:not(:has(#settings-provider-service))");
          expect(await page.getAttribute(model, "placeholder")).toBe(
            "The model's name, as Ollama lists it",
          );
          expect(await page.inputValue(model)).toBe("");
          expect(await page.$("#set-provider-apiKey")).toBeNull();
          expect(await page.inputValue(use)).toBe("ollama");
          await page.fill(model, "llama3.2");
          await page.press(model, "Tab");
          await until(() => sent.length === 7, 5000, "the Ollama model saved");

          // Back to a key: neither Ollama's address nor its model goes to the Anthropic API.
          await page.selectOption(use, "key");
          await until(() => sent.length === 8, 5000, "the key use saved");
          expect(sent[7]).toEqual({
            "provider.kind": "anthropic",
            "provider.baseUrl": null,
            "provider.model": null,
          });
          expect(rig.app.config().settings["provider.model"]).toBe("");
          await page.waitForSelector("#settings-provider-service");
          expect(await page.textContent("#settings-provider-state")).toBe(
            "Uses the Anthropic API.",
          );

          // Claude Code or Codex: the kind, and nothing else.
          await page.selectOption(use, "harness");
          await until(() => sent.length === 9, 5000, "the harness saved");
          expect(sent[8]).toEqual({ "provider.kind": "harness" });
          await page.waitForSelector("#page-settings:not(:has(#settings-provider-service))");
          expect(await page.inputValue(use)).toBe("harness");
          expect(rig.app.config().settings["provider.kind"]).toBe("harness");

          // None: no rows under it.
          await page.selectOption(use, "none");
          await until(() => sent.length === 10, 5000, "none saved");
          expect(sent[9]).toEqual({ "provider.kind": "none" });
          await page.waitForSelector("#page-settings:not(:has(#settings-provider-service))");
          expect(await page.$("#set-provider-apiKey")).toBeNull();
          expect(await page.textContent("#settings-provider-state")).toBe(
            "Ask shows the matching parts of the call instead.",
          );
          await w.close();
        });
      } finally {
        t.cleanup();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "Claude Code or Codex is named for what was found; a browser cannot change the address",
    async () => {
      const found = {
        claude: { kind: "claude" as const, path: "/opt/claude", version: "2.1.0" },
        codex: null,
      };
      await withRig(
        { settings: { "provider.kind": "harness" }, discover: async () => found },
        async (rig) => {
          const page = await rig.open();
          await openSettings(page);
          await until(
            async () =>
              /^Claude Code on this (Mac|computer)$/.test(
                (await page.textContent("#set-provider-kind option[value='harness']")) ?? "",
              ) ||
              (await page
                .reload()
                .then(() => openSettings(page))
                .then(() => false)),
            10_000,
            "Claude Code named",
          );
          // And the line under it says the same one, not both names.
          await until(
            async () =>
              /^Uses Claude Code on this (Mac|computer)\.$/.test(
                (await page.textContent("#settings-provider-state")) ?? "",
              ),
            5000,
            "the state names Claude Code",
          );
          // The address decides where the key and the transcripts go: a browser cannot set it, so
          // the local model, which sets it, cannot be picked there.
          expect(
            await page.$eval("#set-provider-kind option[value='ollama']", (o) => [
              (o as HTMLOptionElement).disabled,
              o.textContent,
            ]),
          ).toEqual([true, "Local model (Ollama), in the akou window"]);
          await page.selectOption("#set-provider-kind", "key");
          await page.waitForSelector("#settings-provider-service");
          await page.click("#settings-provider-service label:has-text('OpenAI-compatible')");
          // An address this page cannot set reads as a value, with where to set it.
          await page.waitForSelector("span#set-provider-baseUrl");
          expect(await page.textContent("#set-provider-baseUrl")).toBe("Not set");
          expect(await page.textContent(".pg-row[data-key='provider.baseUrl'] .pg-help")).toBe(
            "Set in the akou window, since your key and transcripts go there.",
          );
          // The line under the assistant names no address: that hint is for the command line.
          await until(
            async () =>
              (await page.textContent("#settings-provider-state")) ===
              "The OpenAI-compatible server is not available: Server address is not set.",
            5000,
            "the state without an address",
          );
        },
      );
      await withRig(
        {
          settings: { "provider.kind": "harness" },
          discover: async () => ({ claude: null, codex: null }),
        },
        async (rig) => {
          const page = await rig.open();
          await openSettings(page);
          await until(
            async () =>
              (await page.textContent("#set-provider-kind option[value='harness']")) ===
                "Claude Code or Codex (not found)" ||
              (await page
                .reload()
                .then(() => openSettings(page))
                .then(() => false)),
            10_000,
            "none found",
          );
          // Where akou looked and how to pin a path are for the command line.
          await until(
            async () =>
              /^Claude Code or Codex was not found on this (Mac|computer)\. Install one, or choose another assistant\.$/.test(
                (await page.textContent("#settings-provider-state")) ?? "",
              ),
            5000,
            "the plain line",
          );
        },
      );
      // A server set in the file: going back to Anthropic clears its address, so a browser
      // cannot pick it, and cannot pick a key over Ollama either.
      await withRig(
        {
          settings: {
            "provider.kind": "openai-compatible",
            "provider.baseUrl": "https://llm.example/v1",
          },
        },
        async (rig) => {
          const page = await rig.open();
          await openSettings(page);
          await page.waitForSelector("#settings-provider-service");
          expect(await page.isDisabled("#settings-provider-service input[value='anthropic']")).toBe(
            true,
          );
          expect(
            await page.isDisabled("#settings-provider-service input[value='openai-compatible']"),
          ).toBe(false);
        },
      );
    },
    UI_TIMEOUT,
  );
});
