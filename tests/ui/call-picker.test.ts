/**
 * The Call menu in the Record row (docs/ux/WINDOW.md W3.3, the call half), on the real page over
 * the headless app and the fake helper, whose `devices` line lists `Example Call` and an app named
 * by its id: Whole computer is the default row, then None and the apps playing now by name from
 * `GET /apps`; a pick is sent as the next call's `call`, held for that one call and never saved;
 * an untouched menu sends no `call`; a default from Settings is the checked row and is not sent;
 * like the workspace and the title, the menu leaves the row while a call records; where one app
 * cannot be recorded (`--no-apps`, as on Linux) or nothing plays, a line says why and the other
 * rows still work; and at 1024 px the button fits the row.
 */

import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import type { LogEvent } from "../../src/core/log/events.ts";
import { tempDir } from "../helpers.ts";
import { UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

async function withRig<T>(
  o: Parameters<typeof uiRig>[0],
  fn: (rig: UiRig) => Promise<T>,
): Promise<T> {
  const t = tempDir("akou-ui-call-");
  const rig = await uiRig({ ...o, home: t.dir });
  try {
    return await fn(rig);
  } finally {
    await rig.close();
    t.cleanup();
  }
}

/** Opens the window and records every `POST /calls` body the page sends. */
async function openWindow(rig: UiRig): Promise<{ page: Page; starts: Record<string, unknown>[] }> {
  const starts: Record<string, unknown>[] = [];
  const page = await rig.open(undefined, {
    before: (p) =>
      p.on("request", (r) => {
        if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/calls"))
          starts.push(r.postDataJSON());
      }),
  });
  await page.waitForFunction(() => document.getElementById("state")?.textContent === "ready");
  return { page, starts };
}

const label = (page: Page) => page.textContent("#call-name");

/** The rows of the open menu: value, name, checked, and whether it is the default. */
const rows = (page: Page) =>
  page.$$eval("#call-menu .call-item", (els) =>
    els.map((e) => [
      (e as HTMLElement).dataset.call ?? "",
      e.querySelector(".call-title")?.textContent ?? "",
      e.getAttribute("aria-checked") ?? "",
      (e as HTMLElement).dataset.default !== undefined ? "default" : "",
    ]),
  );

async function openMenu(page: Page): Promise<void> {
  await page.click("#call-pick");
  await page.waitForSelector("#call-menu:not([hidden])");
}

/** Records from the window, waits for the call's first part, stops, and answers its call mode. */
async function recordOnce(rig: UiRig, page: Page, during?: () => Promise<void>): Promise<string> {
  await page.click("#record");
  await until(async () => (await page.textContent("#state")) === "rec", 8000, "recording");
  const id = (await rig.api("GET", "/status")).body.live.call as string;
  let mode = "";
  await until(
    async () => {
      const events = (await rig.api("GET", `/calls/${id}/events`)).body.events as LogEvent[];
      const part = events.find((e) => e.type === "part.started");
      mode = part?.type === "part.started" ? part.call.mode : "";
      return mode !== "";
    },
    8000,
    "the first part",
  );
  await during?.();
  await page.click("#stop");
  await until(async () => (await page.textContent("#state")) === "saved", 8000, "stopped");
  return mode;
}

describe("[W3.3] the Call menu: what the next call records, picked for one call", () => {
  test(
    "Whole computer is the default; a picked app is sent for one call and never saved; an untouched menu sends no call",
    async () => {
      await withRig({}, async (rig) => {
        const { page, starts } = await openWindow(rig);
        expect(await label(page)).toBe("Whole computer");
        expect(await page.isEnabled("#call-pick")).toBe(true);
        await openMenu(page);
        await until(
          async () => (await rows(page)).length === 4,
          5000,
          "the apps playing now listed",
        );
        expect(await rows(page)).toEqual([
          ["system", "Whole computer", "true", "default"],
          ["none", "None (microphone only)", "false", ""],
          ["app:com.example.call", "Example Call", "false", ""],
          // macOS names an app by its bundle id.
          ["app:com.example.music", "com.example.music", "false", ""],
        ]);
        expect(
          await page.getAttribute('#call-menu [data-call="app:com.example.call"]', "title"),
        ).toBe("com.example.call");
        // Escape closes it and hands the focus back to the button.
        await page.keyboard.press("Escape");
        expect(await page.isHidden("#call-menu")).toBe(true);
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("call-pick");

        await openMenu(page);
        await page.click('#call-menu [data-call="app:com.example.call"]');
        expect(await page.isHidden("#call-menu")).toBe(true);
        expect(await label(page)).toBe("Example Call");
        // A pick is the page's alone: nothing was saved.
        expect((await rig.api("GET", "/config")).body.settings["capture.call"]).toBe("system");

        // At 1024 px the button sits between the state word and Record, and the row does not spill.
        await page.setViewportSize({ width: 1024, height: 700 });
        const box = async (sel: string) => {
          const b = await page.locator(sel).boundingBox();
          if (!b) throw new Error(`${sel} has no box`);
          return b;
        };
        const state = await box("#state");
        const pick = await box("#call-pick");
        const record = await box("#record");
        expect(pick.x).toBeGreaterThanOrEqual(state.x + state.width);
        expect(pick.x + pick.width).toBeLessThanOrEqual(record.x);
        expect(await page.$eval("#controls", (e) => e.scrollWidth <= e.clientWidth)).toBe(true);

        const mode = await recordOnce(rig, page, async () => {
          // While it records, the menu leaves the row, as the workspace and the title do.
          expect(await page.isHidden("#call-pick")).toBe(true);
        });
        expect(mode).toBe("app:com.example.call");
        expect(starts.at(-1)?.call).toBe("app:com.example.call");
        // The pick held for that one call: the next one is the default again.
        await until(async () => (await label(page)) === "Whole computer", 5000, "the default");
        expect(await page.isVisible("#call-pick")).toBe(true);
        expect(await page.isEnabled("#call-pick")).toBe(true);
        expect((await rig.api("GET", "/config")).body.settings["capture.call"]).toBe("system");

        // Record without touching the menu: the body carries no call, and the app records the
        // whole computer, as before the menu existed.
        expect(await recordOnce(rig, page)).toBe("system");
        expect(starts).toHaveLength(2);
        expect("call" in (starts[1] as object)).toBe(false);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a default from Settings is the checked row and is not sent; picking Whole computer then is",
    async () => {
      // Capture settings take effect at the next start of akou, so the default is in the file.
      await withRig({ settings: { "capture.call": "app:com.example.call" } }, async (rig) => {
        const { page, starts } = await openWindow(rig);
        await until(async () => (await label(page)) === "Example Call", 5000, "the default named");
        await openMenu(page);
        await until(async () => (await rows(page)).length === 4, 5000, "the apps listed");
        expect((await rows(page)).filter((r) => r[2] === "true")).toEqual([
          ["app:com.example.call", "Example Call", "true", "default"],
        ]);
        await page.keyboard.press("Escape");
        expect(await recordOnce(rig, page)).toBe("app:com.example.call");
        expect("call" in (starts[0] as object)).toBe(false);

        await openMenu(page);
        await page.click('#call-menu [data-call="system"]');
        expect(await label(page)).toBe("Whole computer");
        expect(await recordOnce(rig, page)).toBe("system");
        expect(starts[1]?.call).toBe("system");
        // The setting is untouched by either call.
        expect((await rig.api("GET", "/config")).body.settings["capture.call"]).toBe(
          "app:com.example.call",
        );
      });
    },
    UI_TIMEOUT,
  );

  test(
    "where one app cannot be recorded the app rows are absent and the reason shows; None still records the mic alone",
    async () => {
      await withRig({ helperArgs: ["--no-apps"] }, async (rig) => {
        const { page, starts } = await openWindow(rig);
        await openMenu(page);
        await page.waitForSelector("#call-menu .call-note");
        expect(await page.textContent("#call-menu .call-note")).toBe(
          "Recording one app is not available here: capturing one app is not available on this fake",
        );
        expect((await rows(page)).map((r) => r[0])).toEqual(["system", "none"]);
        await page.click('#call-menu [data-call="none"]');
        expect(await label(page)).toBe("None");
        expect(await recordOnce(rig, page)).toBe("none");
        expect(starts[0]?.call).toBe("none");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "with no app playing the menu says to join first; Refresh lists the app once it plays",
    async () => {
      await withRig({}, async (rig) => {
        const { page } = await openWindow(rig);
        let silent = true;
        await page.route("**/api/v1/apps", (r) =>
          silent ? r.fulfill({ status: 200, json: { backend: "fake", apps: [] } }) : r.continue(),
        );
        await openMenu(page);
        await until(
          async () =>
            (await page.textContent("#call-menu .call-note").catch(() => null)) ===
            "No app is playing sound right now. Join the meeting first, or record the whole computer.",
          5000,
          "the empty line",
        );
        expect((await rows(page)).map((r) => r[0])).toEqual(["system", "none"]);
        silent = false;
        await page.click("#call-menu .call-refresh");
        await until(async () => (await rows(page)).length === 4, 5000, "the apps after Refresh");
        expect(await page.locator("#call-menu .call-note").count()).toBe(0);
        // Refresh keeps the menu open.
        expect(await page.isVisible("#call-menu")).toBe(true);
      });
    },
    UI_TIMEOUT,
  );
});
