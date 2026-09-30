/**
 * The dictation setup on the real app over the fake helper (docs/ux/DICTATION.md DC-N3): the page
 * reads the grants the helper's probe reports (`--grants-file`, the OS's grants as they change),
 * never asks for one, and walks the five steps in turn as each grant arrives; with Accessibility
 * refused, the clipboard-only fallback ends with a dictation on the clipboard and nothing pasted or
 * sent. The page is told it runs on macOS, where both grants are asked for. Nothing records, types,
 * pastes, prompts or opens System Settings: the fake helper exits on any `prompt: true`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { concat, silence, speak } from "../fixtures/asr-fake.ts";
import { monoWav } from "../fixtures/audio.ts";
import { tempDir } from "../helpers.ts";
import { UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

const TOGGLE = "#page-dictation input[data-key='dictation.enabled']";
const text = (page: Page, sel: string) => page.textContent(sel).then((t) => t?.trim() ?? "");
const step = (page: Page, s: string) =>
  page.waitForSelector(`#page-dictation .dictation-setup[data-step='${s}']`, { timeout: 10_000 });
const lines = (file: string): Record<string, unknown>[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

/** The window page over the real app, told it runs on macOS. */
async function macPage(rig: UiRig): Promise<Page> {
  const page = await rig.open(undefined, {
    before: (p) =>
      p.route(
        (u) => u.pathname.endsWith("/status"),
        async (route) => {
          const res = await route.fetch();
          const real = (await res.json()) as { app: Record<string, unknown> };
          return route.fulfill({
            response: res,
            json: { ...real, app: { ...real.app, platform: "darwin" } },
          });
        },
      ),
  });
  await page.click("#dictation-open");
  await page.waitForSelector(TOGGLE);
  return page;
}

describe("DC-N3 on the real app: the setup follows the grants the helper reports", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  let grants: string;
  let commands: string;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-setup-walk-");
    grants = join(t.dir, "grants");
    commands = join(t.dir, "commands.jsonl");
    // Neither grant yet: the probe reports both refused.
    writeFileSync(grants, "");
    rig = await uiRig({
      home: t.dir,
      helperArgs: ["--grants-file", grants, "--commands-log", commands],
      settings: { "dictation.hotkey": "RightCommand" },
    });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  test(
    "each step waits for its grant and goes on by itself; the switch turns on at the end",
    async () => {
      const page = await macPage(rig);
      await page.click(TOGGLE);
      await step(page, "mic");
      expect(await page.isChecked(TOGGLE)).toBe(false);
      expect(await text(page, "#dictation-setup-note")).toContain(
        "akou has no access to the microphone, so dictation stays off",
      );
      // Only the probe ran: no dictate process, so no command reached a helper.
      expect(existsSync(commands)).toBe(false);

      // The microphone is granted in System Settings: the step shows its meter by itself.
      writeFileSync(grants, "mic");
      await page.waitForSelector("#dictation-setup-level", { timeout: 10_000 });
      await page.click("#dictation-setup-next");
      await step(page, "accessibility");
      expect(rig.app.config().settings["dictation.enabled"]).toBe(false);

      // Accessibility is granted: the step moves on to the languages by itself.
      writeFileSync(grants, "mic,accessibility");
      await step(page, "languages");
      await page.click("#dictation-setup-next");
      await step(page, "key");
      expect(
        await page.$$eval("#page-dictation .dictation-setup .keycaps kbd", (k) =>
          k.map((x) => x.textContent),
        ),
      ).toEqual(["Right ⌘"]);
      await page.click("#dictation-setup-next");
      await step(page, "try");
      expect(rig.app.config().settings["dictation.enabled"]).toBe(true);
      await until(() => rig.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
      expect(rig.app.dictation()?.status()).toMatchObject({
        grants: { mic: "granted", accessibility: "granted" },
      });

      await page.click("#dictation-setup-done");
      await page.waitForSelector("#page-dictation section[data-section='Keys']");
      expect(await page.isChecked(TOGGLE)).toBe(true);
      expect(await text(page, "#dictation-grant-mic .pg-state")).toBe("Allowed");
      expect(await text(page, "#dictation-grant-accessibility .pg-state")).toBe("Allowed");
      // The helper ran and was bound, and was never asked to prompt (it would have exited 70).
      const sent = lines(commands);
      expect(sent.some((c) => c.type === "rebind")).toBe(true);
      expect(JSON.stringify(sent)).not.toContain('"prompt"');
    },
    UI_TIMEOUT,
  );
});

describe("DC-N3 on the real app: Accessibility refused, the dictation lands on the clipboard", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  let inserted: string;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-setup-clip-");
    const grants = join(t.dir, "grants");
    inserted = join(t.dir, "inserted.jsonl");
    writeFileSync(grants, "mic");
    // The fallback's chord, held for a spoken sentence and released, once the helper is bound.
    const keys = join(t.dir, "keys.jsonl");
    writeFileSync(
      keys,
      [
        { at: 0, key: "LeftControl", down: true },
        { at: 10, key: "LeftShift", down: true },
        { at: 20, key: "Space", down: true },
        { at: 2500, key: "Space", down: false },
        { at: 2510, key: "LeftShift", down: false },
        { at: 2520, key: "LeftControl", down: false },
      ]
        .map((k) => JSON.stringify(k))
        .join("\n"),
    );
    const wav = join(t.dir, "mic.wav");
    writeFileSync(wav, monoWav(concat(silence(0.5), speak(["hello", "world"]), silence(3))));
    rig = await uiRig({
      home: t.dir,
      helperArgs: [
        "--grants-file",
        grants,
        "--wav",
        wav,
        "--keys",
        keys,
        "--inserter-log",
        inserted,
      ],
      settings: { "dictation.hotkey": "RightCommand", "dictation.sendAlways": true },
    });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  test(
    "clipboard only: the key becomes a chord, and a dictation is copied with no paste and no send",
    async () => {
      const page = await macPage(rig);
      expect(await text(page, "#dictation-grant-mic .pg-state")).toBe("Allowed");
      expect(await text(page, "#dictation-grant-accessibility .pg-help")).toBe(
        "Not allowed, so dictations are copied and you paste them.",
      );
      await page.click(TOGGLE);
      await step(page, "mic");
      await page.click("#dictation-setup-next");
      await step(page, "accessibility");
      await page.click("#dictation-setup-clipboard");
      await step(page, "languages");
      await page.click("#dictation-setup-next");
      await step(page, "key");
      const key = "#page-dictation .dictation-setup input[data-key='dictation.hotkey']";
      expect(await page.inputValue(key)).toBe("Control+Shift+Space");
      await page.click("#dictation-setup-next");
      await step(page, "try");
      expect(rig.app.config().settings["dictation.hotkey"]).toBe("Control+Shift+Space");
      expect(await text(page, "#dictation-setup-note")).toContain("press ⌘V to paste it here");

      // The helper starts, binds the chord and plays the scripted press: the text is copied.
      await until(() => lines(inserted).length > 0, 20_000, "the dictation's insert");
      const [ins, ...rest] = lines(inserted);
      expect(ins).toMatchObject({ method: "clipboard" });
      expect(String(ins?.text)).toMatch(/hello world/i);
      // Nothing was pasted, so nothing is sent, even with dictation.sendAlways on.
      expect(rest.filter((l) => l.type === "send")).toEqual([]);
      await until(
        () => rig.app.dictation()?.status().state === "idle",
        10_000,
        "the dictation settled",
      );
      const r = await rig.api("GET", "/dictations");
      const items = r.body.items as { state: string; method?: string }[];
      expect(items[0]).toMatchObject({ state: "inserted" });
    },
    UI_TIMEOUT,
  );
});
