/**
 * Every dialog of the window closes the way a window does (WINDOW W15.8): its × in the top corner,
 * always on screen, Escape, and a click on the backdrop; each gives the focus back to the control
 * that opened it. Settings is a page of the window, not a dialog: its tests are in
 * `settings-page.test.ts`, including an edit left typed when the page is left.
 */

import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { tempDir } from "../helpers.ts";
import { dictationFixture, seedCall, standardCall, UI_TIMEOUT, uiRig, windowPage } from "./rig.ts";

/** The element that has the focus, by id, or its tag when it has none. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return a?.id || a?.tagName.toLowerCase() || "";
  });

const isOpen = (page: Page, id: string) =>
  page.$eval(`#${id}`, (d) => (d as HTMLDialogElement).open).catch(() => false);

/** A point on the backdrop: the window's top-left corner, which no dialog reaches. */
const backdrop = (page: Page) => page.mouse.click(4, 4);

/**
 * Opens the dialog `id` with `opener` and closes it each way, checking the × stays in sight when
 * the dialog's content is scrolled to its end and the focus comes back to the opener.
 */
async function closesThreeWays(page: Page, id: string, opener: string): Promise<void> {
  const ways: [string, () => Promise<void>][] = [
    ["×", () => page.click(`#${id} .dialog-x`)],
    ["Escape", () => page.keyboard.press("Escape")],
    ["backdrop", () => backdrop(page)],
  ];
  for (const [way, close] of ways) {
    await page.click(opener);
    await page.waitForSelector(`#${id}[open]`);
    const x = page.locator(`#${id} .dialog-x`);
    expect(await x.getAttribute("aria-label")).toBe("Close");
    // Scrolled to the end, the × and the title are still in the dialog's top corner.
    await page.$eval(`#${id}`, (d) => {
      d.scrollTop = d.scrollHeight;
    });
    const inSight = await page.$eval(`#${id}`, (d) => {
      const x = d.querySelector(".dialog-x") as HTMLElement;
      const box = d.getBoundingClientRect();
      const r = x.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit !== null && x.contains(hit) && r.top >= box.top && r.top - box.top < 48;
    });
    expect(`${id} × in sight: ${inSight}`).toBe(`${id} × in sight: true`);
    await close();
    await page.waitForSelector(`#${id}`, { state: "hidden" });
    expect(`${id} by ${way}: ${await focused(page)}`).toBe(`${id} by ${way}: ${opener.slice(1)}`);
  }
}

describe("W15.8: every dialog closes like a window", () => {
  test(
    "the window's dialogs close by ×, Escape and the backdrop, and give the focus back",
    async () => {
      const t = tempDir("akou-ui-");
      const id = seedCall(t.dir, (b) => {
        standardCall(b);
        b.add({
          type: "vocab.propose",
          id: "p1",
          rev: 1,
          term: "Hetzner",
          heard: ["hetzner"],
          by: "app",
          evidence: {},
          status: "proposed",
        });
      }).id;
      const rig = await uiRig({ home: t.dir });
      try {
        const page = await rig.open(id, {
          before: async (p) => {
            await dictationFixture(p);
          },
        });
        await page.waitForSelector("#pill-review:not([hidden])");
        await closesThreeWays(page, "review", "#pill-review");
        await closesThreeWays(page, "dictation", "#dictation-open");

        // Over the Dictation page, History and Dictionary close on their own, back to their button.
        await page.click("#dictation-open");
        await page.waitForSelector("#dictation[open]");
        await closesThreeWays(page, "dictation-history", "#dictation-history-open");
        await closesThreeWays(page, "dictation-dictionary", "#dictation-dictionary-open");
        expect(await isOpen(page, "dictation")).toBe(true);
        // While a key is being recorded, Escape stops the recording and leaves the page open.
        const recorder = "#dictation button.record-key[data-for='dictation.hotkey']";
        await page.click(recorder);
        expect(await page.getAttribute(recorder, "aria-pressed")).toBe("true");
        await page.keyboard.press("Escape");
        expect(await page.getAttribute(recorder, "aria-pressed")).toBe("false");
        expect(await isOpen(page, "dictation")).toBe(true);
        await page.keyboard.press("Escape");
        await page.waitForSelector("#dictation", { state: "hidden" });
      } finally {
        await rig.close();
        t.cleanup();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "the quit question: ×, Escape and the backdrop all keep the call",
    async () => {
      const t = tempDir("akou-ui-");
      const rig = await uiRig({ home: t.dir });
      try {
        const w = await windowPage(rig);
        const { page } = w;
        try {
          await page.waitForSelector("#settings-open");
          const ways: [string, () => Promise<void>][] = [
            ["×", () => page.click("#quit-question .dialog-x")],
            ["Escape", () => page.keyboard.press("Escape")],
            ["backdrop", () => backdrop(page)],
          ];
          for (const [n, [way, close]] of ways.entries()) {
            await page.focus("#settings-open");
            await w.send("askQuit", {
              id: `q${n}`,
              message: "Quit while recording?",
              detail: "The call stops.",
              confirm: "Stop and quit",
            });
            await page.waitForSelector("#quit-question[open]");
            await close();
            await page.waitForSelector("#quit-question", { state: "detached" });
            const answer = w.requests.find(
              (r) => r.name === "answerQuit" && (r.params as { id: string }).id === `q${n}`,
            );
            expect(`${way}: ${JSON.stringify(answer?.params)}`).toBe(
              `${way}: ${JSON.stringify({ id: `q${n}`, go: false })}`,
            );
            expect(`${way}: ${await focused(page)}`).toBe(`${way}: settings-open`);
          }
        } finally {
          await w.close();
        }
      } finally {
        await rig.close();
        t.cleanup();
      }
    },
    UI_TIMEOUT,
  );
});
