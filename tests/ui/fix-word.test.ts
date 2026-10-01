/**
 * Fixing a word on the transcript by double-clicking it (docs/ux/WINDOW.md W4.9,
 * docs/ux/design-explorations/fix-a-word-on-the-line.md), on the real page in a headless browser.
 * A double-click on a word of a committed line, live or final, opens the fix next to that word with
 * it selected; a single click and a drag open nothing; the grey line still being spoken opens
 * nothing. A word a fix learned says so above the field, a new spelling renames it, and Forget takes
 * it out of the call and the file.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { tempDir } from "../helpers.ts";
import { seedCall, seg, silentWav, T0, UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

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

/** A saved call: the same mishearing on two lines, and a line saying one word twice. */
const saved = (b: import("../helpers.ts").LogBuilder) => {
  b.created();
  b.partStarted(1, T0);
  b.seg({ id: "l000001", ch: "call", spk: "c1", w0: T0 + 1000, text: "the build and the build" });
  b.seg({ id: "l000002", ch: "call", spk: "c2", w0: T0 + 3000, text: "deploy to versal today" });
  b.seg({ id: "l000003", ch: "call", spk: "c1", w0: T0 + 6000, text: "is versal up" });
  b.seg({ id: "l000004", ch: "call", spk: "c2", w0: T0 + 8000, text: "yes, it is" });
  b.seg({ id: "l000005", ch: "call", spk: "c1", w0: T0 + 10000, text: "Vercel was heard right" });
  b.partEnded(1, "stop", 12);
  b.add({ type: "call.ended", reason: "stop" });
};

/** A saved call whose final pass is done: the lines shown are the final layer's. */
const finalPass = (b: import("../helpers.ts").LogBuilder) => {
  b.created();
  b.partStarted(1, T0);
  b.seg({ id: "l000001", ch: "call", spk: "c1", w0: T0 + 1000, text: "deploy to versal today" });
  b.partEnded(1, "stop", 12);
  b.add({ type: "call.ended", reason: "stop" });
  b.seg({ id: "f000001", ch: "call", spk: "c1", w0: T0 + 1000, text: "deploy to versal today" });
  b.add({ type: "final.part.done", part: 1 });
  b.add({ type: "final.done", parts: [1], skipped: [] });
};

const row = (id: string) => `#lines .row[data-id="${id}"]`;
const popoverOpen = (page: Page) => page.isVisible("#popover");

/** Where the `nth` copy of `word` sits in a line's text, as page coordinates of its middle. */
async function wordAt(page: Page, line: string, word: string, nth = 0) {
  return page.evaluate(
    ([sel, w, n]) => {
      const el = document.querySelector(`${sel} .text`) as HTMLElement;
      const node = el.firstChild as Text;
      let at = -1;
      for (let i = 0; i <= (n as number); i++) at = node.data.indexOf(w as string, at + 1);
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + (w as string).length);
      const b = r.getBoundingClientRect();
      return {
        x: b.left + b.width / 2,
        y: b.top + b.height / 2,
        left: b.left,
        top: b.top,
        bottom: b.bottom,
        at,
      };
    },
    [row(line), word, nth] as const,
  );
}

async function doubleClick(page: Page, line: string, word: string, nth = 0) {
  const w = await wordAt(page, line, word, nth);
  await page.mouse.dblclick(w.x, w.y);
  return w;
}

const selection = (page: Page) =>
  page.$eval("#popover input", (el) => {
    const i = el as HTMLInputElement;
    return i.value.slice(i.selectionStart ?? 0, i.selectionEnd ?? 0);
  });

describe("double-click a word to fix it (W4.9)", () => {
  test(
    "a double-click opens the fix next to the word, with that copy of it selected",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, saved).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector(`${row("l000003")}`);
        const w = await doubleClick(page, "l000001", "build", 1);
        await page.waitForSelector("#popover:not([hidden])");
        expect(await page.inputValue("#popover input")).toBe("the build and the build");
        expect(await selection(page)).toBe("build");
        // The second copy, not the first.
        expect(
          await page.$eval("#popover input", (el) => (el as HTMLInputElement).selectionStart),
        ).toBe(w.at);
        // Next to the word: just under it, from its left edge, not under the line's Fix button.
        const box = (await page.locator("#popover").boundingBox()) as { x: number; y: number };
        expect(box.y).toBeGreaterThanOrEqual(w.bottom);
        expect(box.y).toBeLessThan(w.bottom + 12);
        expect(Math.abs(box.x - w.left)).toBeLessThan(10);
        // Typing replaces the word; Enter fixes the line as today.
        await page.keyboard.type("Build");
        expect(await page.inputValue("#popover input")).toBe("the build and the Build");
        await page.keyboard.press("Escape");
        expect(await popoverOpen(page)).toBe(false);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a single click and a drag open nothing",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, saved).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector(`${row("l000002")}`);
        const w = await wordAt(page, "l000002", "versal");
        await page.mouse.click(w.x, w.y);
        await page.waitForTimeout(400);
        expect(await popoverOpen(page)).toBe(false);
        // A drag selects text for copying.
        const from = await wordAt(page, "l000002", "deploy");
        await page.mouse.move(from.left + 1, from.y);
        await page.mouse.down();
        await page.mouse.move(w.x, w.y, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        expect(await page.evaluate(() => getSelection()?.toString() ?? "")).toContain("deploy");
        expect(await popoverOpen(page)).toBe(false);
        // Positive control: the same page does open on a double-click.
        await doubleClick(page, "l000002", "versal");
        await page.waitForSelector("#popover:not([hidden])");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a live line opens it while the call records; the grey line still being spoken does not",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall();
        const page = await rig.open(id);
        await until(
          async () => (await page.locator("#state").textContent()) === "rec",
          5000,
          "rec",
        );
        await rig.write(id, seg("l000001", "deploy to versal today", { w0: Date.now() - 4000 }));
        await page.waitForSelector(row("l000001"));
        rig.app.manager.controller(id)?.view.provisional.update({
          ch: "call",
          part: 1,
          pseq: 1,
          text: "still being said",
          w0: Date.now(),
          at: Date.now(),
          spk: "c1",
        });
        const draft = page.locator("#partial .row.draft .text");
        await draft.waitFor();
        await draft.dblclick();
        await page.waitForTimeout(400);
        expect(await popoverOpen(page)).toBe(false);
        await doubleClick(page, "l000001", "versal");
        await page.waitForSelector("#popover:not([hidden])");
        expect(await selection(page)).toBe("versal");
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "punctuation opens nothing, in either engine",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, saved).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector(row("l000004"));
        // What WebKit does on a double-click on a mark: the mark alone selected, then dblclick.
        const dblOn = (mark: string) =>
          page.evaluate(
            ([sel, m]) => {
              const el = document.querySelector(`${sel} .text`) as HTMLElement;
              const node = el.firstChild as Text;
              const at = node.data.indexOf(m as string);
              const r = document.createRange();
              r.setStart(node, at);
              r.setEnd(node, at + (m as string).length);
              const s = getSelection() as Selection;
              s.removeAllRanges();
              s.addRange(r);
              el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
            },
            [row("l000004"), mark] as const,
          );
        await dblOn(",");
        await page.waitForTimeout(300);
        expect(await popoverOpen(page)).toBe(false);
        // Positive control: the same way on a word opens it.
        await dblOn("yes");
        await page.waitForSelector("#popover:not([hidden])");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "on the newest line at the window's bottom edge, the popover opens above the word, inside the window",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall();
        const page = await rig.open(id);
        await page.setViewportSize({ width: 1024, height: 700 });
        await until(
          async () => (await page.locator("#state").textContent()) === "rec",
          5000,
          "rec",
        );
        const now = Date.now();
        for (let i = 1; i <= 30; i++) {
          const lid = `l${String(i).padStart(6, "0")}`;
          await rig.write(
            id,
            seg(lid, `line number ${i} of the call`, { w0: now - (40 - i) * 1000 }),
          );
        }
        await page.waitForSelector(row("l000030"));
        await page.waitForTimeout(300);
        const w = await doubleClick(page, "l000030", "number");
        await page.waitForSelector("#popover:not([hidden])");
        const box = (await page.locator("#popover").boundingBox()) as {
          y: number;
          height: number;
        };
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(700);
        // The clicked word stays visible: the popover ends above it.
        expect(box.y + box.height).toBeLessThanOrEqual(w.top);
        expect(await selection(page)).toBe("number");
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "a final line opens it too",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, finalPass).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector(row("f000001"));
        await doubleClick(page, "f000001", "versal");
        await page.waitForSelector("#popover:not([hidden])");
        expect(await selection(page)).toBe("versal");
      });
    },
    UI_TIMEOUT,
  );
});

describe("a word a fix learned", () => {
  /** Fixes `versal` to `Vercel` by double-clicking it, and waits for the other line to follow. */
  async function learnVercel(page: Page) {
    await doubleClick(page, "l000002", "versal");
    await page.waitForSelector("#popover:not([hidden])");
    // A word nobody taught has no line about it.
    expect(await page.locator("#popover .fix-learned").count()).toBe(0);
    await page.keyboard.type("Vercel");
    await page.keyboard.press("Enter");
    await until(
      async () => (await page.locator(`${row("l000003")} .text`).textContent()) === "is Vercel up",
      5000,
      "the other line corrected",
    );
    await page.waitForSelector("#toast.info:not([hidden])");
    expect(await page.locator("#toast").textContent()).toBe(
      "Learned Vercel: 2 lines fixed. Added to Notes. Undo",
    );
    await until(async () => !(await popoverOpen(page)), 5000, "popover closed");
  }

  test(
    "says what it was heard as, and a new spelling renames it instead of adding a second term",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, saved).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector(row("l000003"));
        await learnVercel(page);
        await doubleClick(page, "l000003", "Vercel");
        await page.waitForSelector("#popover .fix-learned");
        expect(await page.locator("#popover .fix-learned span").textContent()).toBe(
          'Vercel, heard "versal", learned from a fix',
        );
        expect(await page.locator("#popover .fix-learned button").textContent()).toBe("Forget");
        // A line where the word was heard right has no correction, so no row.
        await page.keyboard.press("Escape");
        await doubleClick(page, "l000005", "Vercel");
        await page.waitForSelector("#popover:not([hidden])");
        expect(await page.locator("#popover .fix-learned").count()).toBe(0);
        await page.keyboard.press("Escape");
        await doubleClick(page, "l000003", "Vercel");
        await page.waitForSelector("#popover .fix-learned");
        expect(await selection(page)).toBe("Vercel");
        // The field has the keys, not Forget: Enter must never forget the word.
        expect(await page.evaluate(() => document.activeElement?.className)).toBe("fix-line");
        await page.keyboard.type("Vercel.com");
        await page.keyboard.press("Enter");
        await until(
          async () =>
            (await page.locator(`${row("l000002")} .text`).textContent()) ===
            "deploy to Vercel.com today",
          5000,
          "renamed on the other line",
        );
        await until(
          async () =>
            (await page.locator("#toast").textContent())?.startsWith(
              "Renamed Vercel to Vercel.com: 2 lines",
            ) ?? false,
          5000,
          "the rename toast",
        );
        const words = (await rig.api("GET", "/vocab?workspace=work")).body.entries as {
          term: string;
          heard: string[];
        }[];
        expect(words.map((e) => e.term)).toEqual(["Vercel.com"]);
        expect(words[0]?.heard).toEqual(["versal"]);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Forget takes it out of the call and the file, with the toast long gone",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, saved).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector(row("l000003"));
        await learnVercel(page);
        // The Undo toast is gone: Forget does not depend on it.
        await page.evaluate(() => {
          (document.getElementById("toast") as HTMLElement).hidden = true;
        });
        await doubleClick(page, "l000002", "Vercel");
        await page.waitForSelector("#popover .fix-learned");
        // Two presses in a row send one request: the second would only find the term gone.
        const forgets: string[] = [];
        page.on("request", (q) => {
          if (q.method() === "POST" && q.url().includes("/fix/forget")) forgets.push(q.url());
        });
        await page.$eval("#popover .fix-learned button", (b) => {
          (b as HTMLButtonElement).click();
          (b as HTMLButtonElement).click();
        });
        await until(
          async () =>
            (await page.locator(`${row("l000003")} .text`).textContent()) === "is versal up",
          5000,
          "the term forgotten",
        );
        expect(await page.locator(`${row("l000002")} .text`).textContent()).toBe(
          "deploy to versal today",
        );
        await page.waitForSelector("#toast.info:not([hidden])");
        await page.waitForTimeout(300);
        expect(forgets).toHaveLength(1);
        expect(await page.locator("#toast").textContent()).toBe(
          "Forgot Vercel. Its lines read as heard again.",
        );
        const words = (await rig.api("GET", "/vocab?workspace=work")).body.entries ?? [];
        expect(words.map((e: { term: string }) => e.term)).not.toContain("Vercel");
        // The word reads as heard again, so its popover says nothing more about it.
        await doubleClick(page, "l000002", "versal");
        await page.waitForSelector("#popover:not([hidden])");
        expect(await page.locator("#popover .fix-learned").count()).toBe(0);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Forget says so when the vocabulary file could not be changed",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, saved).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector(row("l000003"));
        await learnVercel(page);
        // The workspace's file no longer parses: the call can forget, the file cannot.
        const files = (await rig.api("GET", "/vocab?workspace=work")).body.files as {
          scope: string;
          path: string;
        }[];
        writeFileSync(
          files.find((f) => f.scope === "workspace")?.path as string,
          "entries:\n  - term: [unclosed\n",
        );
        await page.evaluate(() => {
          (document.getElementById("toast") as HTMLElement).hidden = true;
        });
        await doubleClick(page, "l000002", "Vercel");
        await page.waitForSelector("#popover .fix-learned");
        await page.click("#popover .fix-learned button");
        await page.waitForSelector("#toast.error:not([hidden])");
        expect(await page.locator("#toast").textContent()).toBe(
          "Forgot Vercel in this call. The vocabulary file could not be changed, so later calls still know it.",
        );
      });
    },
    UI_TIMEOUT,
  );
});
