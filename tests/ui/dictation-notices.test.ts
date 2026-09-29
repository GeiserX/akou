/**
 * Why the dictation key does nothing, on the pages (docs/ux/DICTATION.md DC-N1, DC-A2, DC-N2): the
 * pill's notice sheet under the island, the Dictation page's line when the Accessibility grant was
 * taken back, and the key recorder's Fn test for a keyboard that sends no Fn. The pill runs its
 * real ElectroBun entry over the shim with a fake main side; the Dictation page runs in the window
 * over the real app with the dictation answers from fixtures (`rig.ts`). Nothing records, presses
 * a real key, prompts or opens System Settings.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { hotkeyLabel } from "../../src/main/window/hotkey.ts";
import { pillRpc } from "../../src/main/window/pill.ts";
import { PILL_SIZE } from "../../src/main/window/shell.ts";
import { FN_TEST_MS, NO_FN, NO_HELPER } from "../../src/ui/dictation-recorder.ts";
import type { PillState } from "../../src/ui/pill-protocol.ts";
import { tempDir } from "../helpers.ts";
import {
  UI_TIMEOUT,
  type UiRig,
  uiRig,
  until,
  type ViewPage,
  viewPage,
  windowPage,
} from "./rig.ts";

/** The notice the main side sends for `reason`, its words exactly as the app has them. */
function realNotice(reason: "grant-lost" | "secure-input", hotkey: string): PillState {
  let fn: ((m: { kind: string; name?: string; on?: boolean }) => void) | null = null;
  const p = pillRpc(
    {
      status: () => ({ state: "idle", loading: false, swallow_keys: true }),
      follow: (f) => {
        fn = f as typeof fn;
        return () => {};
      },
      control: async () => true,
    },
    () => ({ state: () => {}, level: () => {}, preview: () => {}, chip: () => {} }),
    {
      platform: "darwin",
      hotkey: () => hotkey,
      label: hotkeyLabel,
      now: () => 0,
      onVisible: () => {},
      preview: { setting: () => false },
      later: () => () => {},
      grant: async () => true,
    },
  );
  const tell = fn as unknown as (m: { kind: string; name?: string; on?: boolean }) => void;
  tell(
    reason === "grant-lost"
      ? { kind: "grant-lost", name: "accessibility" }
      : { kind: "secure-input", on: true },
  );
  const shown = p.shown();
  p.close();
  return shown;
}

const text = (page: Page, sel: string) => page.textContent(sel).then((t) => t?.trim() ?? "");
const visible = (page: Page, sel: string) => page.isVisible(sel);

describe("DC-N1, DC-A2: the pill's notice sheet", () => {
  let v: ViewPage;
  beforeAll(async () => {
    v = await viewPage("pill");
  }, UI_TIMEOUT);
  afterAll(async () => {
    await v?.close();
  });
  const state = (s: PillState) => v.send("state", s);
  const icons = (p: Page) =>
    p.$$eval("#island .icon", (els) =>
      els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.id),
    );
  const buttons = (p: Page) =>
    p.$$eval("#buttons button", (b) => b.map((x) => [x.id, x.textContent]));

  test(
    "each notice as the app words it fits the pill's window, its button included",
    async () => {
      const p = v.page;
      await p.setViewportSize(PILL_SIZE);
      for (const [reason, hotkey] of [
        ["grant-lost", "RightCommand"],
        ["secure-input", "Command+Shift+D"],
      ] as const) {
        const s = realNotice(reason, hotkey);
        expect(s.state).toBe("notice");
        await state(s);
        const box = await p.evaluate(() => {
          const r = (document.getElementById("sheet") as HTMLElement).getBoundingClientRect();
          return { bottom: r.bottom, right: r.right, left: r.left };
        });
        expect(box.bottom).toBeLessThanOrEqual(PILL_SIZE.height);
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(PILL_SIZE.width);
      }
    },
    UI_TIMEOUT,
  );

  test(
    "the grant lost: its word on the island, the message in bold over a dimmer line, and the pane's button",
    async () => {
      const p = v.page;
      await state({
        state: "notice",
        reason: "grant-lost",
        message: "Right ⌘ does nothing without Accessibility",
        detail: "Turn akou on under Accessibility.",
        actions: ["grant"],
      });
      expect(await p.getAttribute("#pill", "data-state")).toBe("grant-lost");
      expect(await icons(p)).toEqual(["alert"]);
      expect(await text(p, "#word")).toBe("Accessibility lost");
      expect(await visible(p, "#sheet")).toBe(true);
      expect(await text(p, "#message")).toBe("Right ⌘ does nothing without Accessibility");
      expect(await text(p, "#detail")).toBe("Turn akou on under Accessibility.");
      // The detail is dimmer than the bold message, as the storyboard's error sheet draws it.
      const look = await p.evaluate(() => {
        const m = getComputedStyle(document.getElementById("message") as HTMLElement);
        const d = getComputedStyle(document.getElementById("detail") as HTMLElement);
        return {
          bold: Number(m.fontWeight),
          detail: Number(d.fontWeight),
          same: m.color === d.color,
        };
      });
      expect(look.bold).toBeGreaterThan(look.detail);
      expect(look.same).toBe(false);
      expect(await buttons(p)).toEqual([["grant", "Open Accessibility settings"]]);
      v.requests.length = 0;
      await p.click("#grant");
      expect(v.requests).toEqual([{ name: "control", params: { action: "grant" } }]);
      // Neither the listening controls nor the level belong to a notice.
      expect(await visible(p, "#controls")).toBe(false);
      expect(await visible(p, "#level")).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "Secure Input: its own word and no button; an error after it has no dim line",
    async () => {
      const p = v.page;
      await state({
        state: "notice",
        reason: "secure-input",
        message: "⌘⇧D cannot reach akou while Secure Input is on",
        detail: "A key alone, such as Right ⌘, still works.",
        actions: [],
      });
      expect(await p.getAttribute("#pill", "data-state")).toBe("secure-input");
      expect(await text(p, "#word")).toBe("Secure Input on");
      expect(await text(p, "#detail")).toBe("A key alone, such as Right ⌘, still works.");
      expect(await visible(p, "#buttons")).toBe(false);
      // Positive control: an error draws the same sheet with its message alone.
      await state({ state: "error", message: "nothing heard", actions: [] });
      expect(await text(p, "#word")).toBe("Didn’t finish");
      expect(await visible(p, "#detail")).toBe(false);
      expect(await text(p, "#detail")).toBe("");
      await state({ state: "hidden" });
      expect(await visible(p, "#pill")).toBe(false);
    },
    UI_TIMEOUT,
  );
});

describe("DC-N1, DC-N2: the Dictation page in the window", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-notice-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });
  const record = (key: string) => `#page-dictation button.record-key[data-for='${key}']`;
  const useFn = (key: string) => `#page-dictation button.record-fn[data-for='${key}']`;
  const note = (page: Page, key: string) =>
    text(page, `#page-dictation div.pg-row[data-key='${key}'] .recorder-note`);

  test(
    "the Accessibility grant taken back: the page says it is lost, not clipboard only, with the pane's button",
    async () => {
      const w = await windowPage(rig, {
        platform: "darwin",
        grants: { mic: "granted", accessibility: "denied" },
        lost: ["accessibility"],
      });
      try {
        const p = w.page;
        await p.click("#dictation-open");
        await p.waitForSelector("#dictation-grant-lost");
        expect(await text(p, "#dictation-grant-lost")).toBe(
          "macOS took it back, so the dictation key does nothing. It works again once you allow it.",
        );
        // At the top, on the Accessibility row of the first panel, before the Keys.
        expect(
          await p.$eval(
            "#dictation-grant-lost",
            (e) =>
              e.closest("#dictation-grant-accessibility") !== null &&
              e.closest("section.pg-section")?.getAttribute("data-section") === "",
          ),
        ).toBe(true);
        expect(await text(p, "#dictation-grant-accessibility")).not.toContain("copied");
        w.requests.length = 0;
        await p.click("#dictation-grant-lost-open");
        await until(
          () => w.requests.some((r) => r.name === "openSettingsPane"),
          5000,
          "the pane asked for",
        );
        expect(w.requests.find((r) => r.name === "openSettingsPane")?.params).toEqual({
          pane: "accessibility",
        });
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "control: a grant never given is the clipboard-only fallback, with no lost line",
    async () => {
      const w = await windowPage(rig, {
        platform: "darwin",
        grants: { mic: "granted", accessibility: "denied" },
      });
      try {
        const p = w.page;
        await p.click("#dictation-open");
        await p.waitForSelector("#dictation-grant-accessibility");
        expect(await p.locator("#dictation-grant-lost").count()).toBe(0);
        expect(await text(p, "#dictation-grant-accessibility .pg-help")).toBe(
          "Not allowed, so dictations are copied and you paste them.",
        );
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "Use Fn waits for the helper to hear Fn, and says to pick another key when it never does",
    async () => {
      const w = await windowPage(rig, {
        platform: "darwin",
        settings: { "dictation.hotkeyDraft": "Fn" },
      });
      try {
        const p = w.page;
        await p.click("#dictation-open");
        await p.click(useFn("dictation.hotkey"));
        await until(
          () => w.requests.some((r) => r.name === "recordDictationKeys"),
          5000,
          "the recorder asked for the helper's keys",
        );
        expect(await note(p, "dictation.hotkey")).toBe("Press Fn now.");
        expect(await p.getAttribute(record("dictation.hotkey"), "aria-pressed")).toBe("true");
        // A keyboard that keeps Fn to itself: nothing comes in the window.
        await p.waitForTimeout(FN_TEST_MS + 300);
        expect(await note(p, "dictation.hotkey")).toBe(NO_FN);
        expect(
          await p.$eval(
            `#page-dictation div.pg-row[data-key='dictation.hotkey'] .recorder-note`,
            (e) => e.classList.contains("issue"),
          ),
        ).toBe(true);
        // The recorder stays open for another key.
        expect(await p.getAttribute(record("dictation.hotkey"), "aria-pressed")).toBe("true");
        expect(w.patches).toEqual([]);

        // Fn heard in time is answered, even when it is refused: here the draft key has it.
        await p.click(useFn("dictation.hotkey"));
        await w.send("dictationKey", { name: "Fn" });
        const clash = "fn is already the draft key.";
        await until(async () => (await note(p, "dictation.hotkey")) === clash, 5000, "the clash");
        await p.waitForTimeout(FN_TEST_MS + 300);
        expect(await note(p, "dictation.hotkey")).toBe(clash);
        expect(w.patches).toEqual([]);
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "with no helper hearing keys, Use Fn says so at once and never blames the keyboard",
    async () => {
      // Dictation off (its default), or its key tap dead: the main side answers false.
      const w = await windowPage(rig, { platform: "darwin", hearing: false });
      try {
        const p = w.page;
        await p.click("#dictation-open");
        await p.click(useFn("dictation.hotkey"));
        await until(
          async () => (await note(p, "dictation.hotkey")) === NO_HELPER,
          FN_TEST_MS - 500,
          "the no-helper note before the Fn wait ends",
        );
        await p.waitForTimeout(FN_TEST_MS + 300);
        expect(await note(p, "dictation.hotkey")).toBe(NO_HELPER);
        expect(w.patches).toEqual([]);
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "an Fn the helper hears is saved; off macOS there is no Use Fn",
    async () => {
      const w = await windowPage(rig, { platform: "darwin" });
      try {
        const p = w.page;
        await p.click("#dictation-open");
        await p.click(useFn("dictation.hotkey"));
        await until(
          () => w.requests.some((r) => r.name === "recordDictationKeys"),
          5000,
          "the recorder asked for the helper's keys",
        );
        await w.send("dictationKey", { name: "Fn" });
        await until(() => w.patches.length === 1, 5000, "Fn saved");
        expect(w.patches).toEqual([{ "dictation.hotkey": "Fn" }]);
        await p.waitForTimeout(FN_TEST_MS + 300);
        expect(await note(p, "dictation.hotkey")).not.toBe(NO_FN);
      } finally {
        await w.close();
      }
      const win = await windowPage(rig, { platform: "win32" });
      try {
        await win.page.click("#dictation-open");
        await win.page.waitForSelector(record("dictation.hotkey"));
        expect(await win.page.locator(useFn("dictation.hotkey")).count()).toBe(0);
      } finally {
        await win.close();
      }
    },
    UI_TIMEOUT,
  );
});
