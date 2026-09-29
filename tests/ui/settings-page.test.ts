/**
 * The Settings page (docs/ux/design-explorations/sd-a-settings.html, WINDOW section 11): a page of
 * the main window beside the sidebar, not a dialog. It is left by the sidebar's Calls or a call;
 * every setting the Dictation page does not show has a home on it or on one of its Advanced pages,
 * with the file-only keys read only; a change saves that key alone; a refusal shows under the
 * row; typing then leaving saves; the search goes to a setting; and the page's words never quote a
 * key, a path of akou's own or a value in code quotes.
 */

import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { onDictationPage } from "../../src/ui/dictation-page.ts";
import { MODELS_KEYS } from "../../src/ui/models-rows.ts";
import { tempDir } from "../helpers.ts";
import { seedCall, standardCall, UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

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
        await page.waitForSelector("#page-models #models-go-helpers");
        const onModels = await page.$$eval("#page-models [data-key]:not(.pg-row)", (els) =>
          els.map((e) => (e as HTMLElement).dataset.key as string),
        );
        if (await page.$("#page-models input[name='models-live']")) onModels.push("asr.live");
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
