/**
 * Dictation's pages in a headless browser (docs/ux/DICTATION.md sections 5 and 6): the pill's
 * states and buttons (DC-O1) and its no-text rule on the page side (DC-D2), the learn chip (DC-L4),
 * the draft box's keys, underlines and focus (DC-S1), and the Dictation settings page in the window
 * (DC-U1). The pill and the draft box run their real ElectroBun entries over the shim with a fake
 * main side that records every request; the settings page runs in the real app with the dictation
 * keys answered from fixtures (`rig.ts`) until the registry has them. Nothing records, types,
 * pastes, prompts or plays.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { CHIP_ASK_MS, CHIP_UNDO_MS } from "../../src/ui/dictation-chip.ts";
import { type DictationRow, HISTORY_PAGE } from "../../src/ui/dictation-history.ts";
import type { DraftOpen } from "../../src/ui/dictation-protocol.ts";
import { HOLD_ALONE_MS } from "../../src/ui/dictation-recorder.ts";
import { lowMarks, shiftMarks } from "../../src/ui/draft.ts";
import type { PillState } from "../../src/ui/pill-protocol.ts";
import { tempDir } from "../helpers.ts";
import {
  CLIPBOARD_PERMISSIONS,
  DICTATION_SCHEMA,
  type DictationFixture,
  dictationFixture,
  dictationRow,
  UI_TIMEOUT,
  type UiRig,
  uiRig,
  until,
  type ViewPage,
  viewPage,
  windowPage,
} from "./rig.ts";

const text = (page: Page, sel: string) => page.textContent(sel).then((t) => t?.trim() ?? "");
const visible = (page: Page, sel: string) => page.isVisible(sel);
const ids = (page: Page, sel: string) =>
  page.$$eval(sel, (els) => els.map((e) => (e as HTMLElement).id));

describe("DC-O1: the pill", () => {
  let v: ViewPage;
  beforeAll(async () => {
    v = await viewPage("pill", { clock: new Date("2026-09-26T10:00:00Z") });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await v?.close();
  });
  const state = (s: PillState) => v.send("state", s);
  const now = () => v.page.evaluate(() => Date.now());

  test(
    "hidden until a state arrives, then listening with the meter, the time, the hints and the buttons",
    async () => {
      const p = v.page;
      expect(await visible(p, "#pill")).toBe(false);
      await state({ state: "listening", since: (await now()) - 4200, keys: [], hotkey: "Right ⌘" });
      expect(await p.getAttribute("#pill", "data-state")).toBe("listening");
      expect(await text(p, "#word")).toBe("listening");
      expect(await text(p, "#elapsed")).toBe("0:04");
      expect(await visible(p, "#level")).toBe(true);
      // A backend that cannot hold keys: the dictation key's hint only.
      expect(await p.$$eval("#hints .hint", (h) => h.map((x) => x.textContent))).toEqual([
        "Right ⌘ stop",
      ]);
      // One that can: every key it honours, and no others.
      await state({
        state: "listening",
        since: await now(),
        keys: ["escape", "enter"],
        hotkey: "Right ⌘",
      });
      expect(await p.$$eval("#hints .hint", (h) => h.map((x) => x.textContent))).toEqual([
        "Right ⌘ stop",
        "Esc cancel",
        "Enter send",
      ]);
      expect(await ids(p, "#buttons button")).toEqual(["stop", "cancel"]);

      // The meter follows the level, clamped to its range.
      const meter = () => p.$eval("#level", (m) => (m as HTMLMeterElement).value);
      await v.send("level", { db: -20 });
      expect(await meter()).toBe(-20);
      await v.send("level", { db: -45 });
      expect(await meter()).toBe(-45);
      // A clipping mic reads full scale, never silence.
      await v.send("level", { db: 0 });
      expect(await meter()).toBe(0);
      await v.send("level", { db: 12 });
      expect(await meter()).toBe(0);

      v.requests.length = 0;
      await p.click("#stop");
      await p.click("#cancel");
      expect(v.requests).toEqual([
        { name: "control", params: { action: "stop" } },
        { name: "control", params: { action: "cancel" } },
      ]);
    },
    UI_TIMEOUT,
  );

  test(
    "transcribing shows its time only past 2 s; inserted and copied; error with its buttons",
    async () => {
      const p = v.page;
      await state({ state: "transcribing", since: await now() });
      expect(await p.getAttribute("#pill", "data-state")).toBe("transcribing");
      expect(await text(p, "#word")).toBe("transcribing");
      expect(await text(p, "#elapsed")).toBe("");
      expect(await visible(p, "#level")).toBe(false);
      expect(await visible(p, "#buttons")).toBe(false);
      await p.clock.runFor(2500);
      expect(await text(p, "#elapsed")).toBe("0:02");

      await state({ state: "done", how: "inserted" });
      expect(await p.getAttribute("#pill", "data-state")).toBe("inserted");
      expect(await text(p, "#word")).toBe("inserted");
      expect(await text(p, "#elapsed")).toBe("");
      await state({ state: "done", how: "copied", note: "press ⌘V" });
      expect(await text(p, "#word")).toBe("copied");
      expect(await text(p, "#note")).toBe("press ⌘V");

      await state({
        state: "error",
        message: "remote akou not reachable",
        actions: ["retry", "copy", "open-draft"],
        retryLabel: "Retry locally",
      });
      expect(await p.getAttribute("#pill", "data-state")).toBe("error");
      expect(await text(p, "#word")).toBe("remote akou not reachable");
      expect(await p.$$eval("#buttons button", (b) => b.map((x) => x.textContent))).toEqual([
        "Retry locally",
        "Copy",
        "Open draft",
      ]);
      v.requests.length = 0;
      for (const id of ["retry", "copy", "open-draft"]) await p.click(`#${id}`);
      expect(v.requests.map((r) => r.params)).toEqual([
        { action: "retry" },
        { action: "copy" },
        { action: "open-draft" },
      ]);
      // Only the buttons the state offers.
      await state({ state: "error", message: "nothing heard", actions: [] });
      expect(await visible(p, "#buttons")).toBe(false);

      await state({ state: "hidden" });
      expect(await visible(p, "#pill")).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "[DC-D2] dictated text sent by mistake never reaches the page's DOM",
    async () => {
      const p = v.page;
      const MARK = "DICTATEDMARK-k2p";
      const leaked = () => p.evaluate((m) => document.documentElement.outerHTML.includes(m), MARK);
      for (const s of [
        { state: "listening", since: await now(), keys: ["enter"], hotkey: "Right ⌘", text: MARK },
        { state: "transcribing", since: await now(), text: MARK, partial: MARK },
        { state: "done", how: "inserted", text: MARK },
      ]) {
        await v.send("state", s);
        expect(await leaked()).toBe(false);
      }
      // Positive control: the same check finds the mark once it is on the page.
      await state({ state: "error", message: MARK, actions: [] });
      expect(await leaked()).toBe(true);
      await state({ state: "hidden" });
    },
    UI_TIMEOUT,
  );
});

describe("DC-L4: the learn chip", () => {
  let v: ViewPage;
  beforeAll(async () => {
    v = await viewPage("pill", { clock: new Date("2026-09-26T10:00:00Z") });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await v?.close();
  });
  const one = (id: string) => ({
    id,
    mode: "ask",
    candidates: [{ term: "Kubernetes", heard: "cooper netties" }],
  });

  test(
    "Learn answers with the term and leaves Undo for 6 s; Undo retracts",
    async () => {
      const p = v.page;
      await v.send("chip", one("d1"));
      expect(await text(p, "#chip .chip-text")).toBe(
        'Learn "Kubernetes" (heard "cooper netties")?',
      );
      v.requests.length = 0;
      await p.click("#chip-learn");
      expect(v.requests).toEqual([
        { name: "chip", params: { id: "d1", action: "learn", terms: ["Kubernetes"] } },
      ]);
      expect(await text(p, "#chip .chip-text")).toBe('Learned "Kubernetes"');
      await p.click("#chip-undo");
      expect(v.requests[1]).toEqual({
        name: "chip",
        params: { id: "d1", action: "undo", terms: ["Kubernetes"] },
      });
      expect(await visible(p, "#chip")).toBe(false);

      // Left alone, the Undo line goes after 6 s and answers nothing more.
      await v.send("chip", one("d2"));
      await p.click("#chip-learn");
      await p.clock.runFor(CHIP_UNDO_MS + 100);
      expect(await visible(p, "#chip")).toBe(false);
      expect(v.requests.filter((r) => (r.params as { id: string }).id === "d2").length).toBe(1);
    },
    UI_TIMEOUT,
  );

  test(
    "Not a word rejects; ignored for 8 s answers ignore; close answers ignore",
    async () => {
      const p = v.page;
      v.requests.length = 0;
      await v.send("chip", one("d3"));
      await p.click("#chip-reject");
      expect(await visible(p, "#chip")).toBe(false);
      await v.send("chip", one("d4"));
      await p.clock.runFor(CHIP_ASK_MS - 500);
      expect(await visible(p, "#chip")).toBe(true);
      await p.clock.runFor(600);
      expect(await visible(p, "#chip")).toBe(false);
      await v.send("chip", one("d5"));
      await p.click("#chip-close");
      expect(v.requests.map((r) => r.params)).toEqual([
        { id: "d3", action: "reject", terms: ["Kubernetes"] },
        { id: "d4", action: "ignore" },
        { id: "d5", action: "ignore" },
      ]);
    },
    UI_TIMEOUT,
  );

  test(
    "several candidates get a checkbox each; a second chip while one is up is not shown; auto shows Undo only",
    async () => {
      const p = v.page;
      v.requests.length = 0;
      await v.send("chip", {
        id: "d6",
        mode: "ask",
        candidates: [
          { term: "Kubernetes", heard: "cooper netties" },
          { term: "Vercel", heard: "versal" },
        ],
      });
      expect(await p.$$eval("#chip input[type=checkbox]", (b) => b.length)).toBe(2);
      await v.send("chip", one("d7"));
      expect(await text(p, "#chip .chip-text")).toContain("Learn these words?");
      // With nothing ticked there is nothing to learn or reject.
      await p.uncheck('#chip input[data-term="Kubernetes"]');
      await p.uncheck('#chip input[data-term="Vercel"]');
      expect(await p.isDisabled("#chip-learn")).toBe(true);
      expect(await p.isDisabled("#chip-reject")).toBe(true);
      await p.check('#chip input[data-term="Kubernetes"]');
      expect(await p.isDisabled("#chip-learn")).toBe(false);
      expect(await p.isDisabled("#chip-reject")).toBe(false);
      await p.click("#chip-learn");
      expect(v.requests[0]?.params).toEqual({ id: "d6", action: "learn", terms: ["Kubernetes"] });
      await p.click("#chip-undo");

      await v.send("chip", { ...one("d8"), mode: "learned" });
      expect(await text(p, "#chip .chip-text")).toBe('Learned "Kubernetes"');
      expect(await p.$("#chip-learn")).toBeNull();
      await p.click("#chip-undo");
      expect(v.requests.at(-1)?.params).toEqual({
        id: "d8",
        action: "undo",
        terms: ["Kubernetes"],
      });
      // The second chip (d7) never showed and was never answered.
      expect(v.requests.some((r) => (r.params as { id: string }).id === "d7")).toBe(false);
    },
    UI_TIMEOUT,
  );
});

describe("DC-S1: the draft box", () => {
  let v: ViewPage;
  beforeAll(async () => {
    v = await viewPage("draft");
  }, UI_TIMEOUT);
  afterAll(async () => {
    await v?.close();
  });
  const draft = (o: Partial<DraftOpen> = {}): DraftOpen => ({
    id: "d1",
    text: "Tell the cooper netties team the rollout is on Thursday",
    words: [
      { w: "Tell", c: 0.98 },
      { w: "the", c: 0.97 },
      { w: "cooper", c: 0.31, alt: ["Kubernetes"] },
      { w: "netties", c: 0.28 },
      { w: "team", c: 0.95 },
    ],
    to: "Slack",
    engine: "fast (Parakeet)",
    ms: 300,
    engines: ["best"],
    focus: true,
    platform: "linux",
    ...o,
  });
  const active = (p: Page) => p.evaluate(() => document.activeElement?.id ?? "");
  const value = (p: Page) => p.$eval("#draft-text", (t) => (t as HTMLTextAreaElement).value);
  const marks = (p: Page) => p.$$eval("#draft-marks mark", (m) => m.map((x) => x.textContent));

  test(
    "Enter inserts, Ctrl+Enter inserts and sends, Shift+Enter is a newline, Escape discards",
    async () => {
      const p = v.page;
      await v.send("open", draft());
      expect(await visible(p, "#draft")).toBe(true);
      expect(await value(p)).toBe(draft().text);
      expect(await text(p, "#draft-to")).toBe("to: Slack");
      expect(await text(p, "#draft-engine")).toBe("fast (Parakeet) 0.3 s");
      expect(await text(p, "#draft-keys")).toContain("Ctrl+Enter: insert and send");
      expect(await active(p)).toBe("draft-text");

      v.requests.length = 0;
      await p.keyboard.press("Shift+Enter");
      await p.keyboard.type("ping me.");
      expect(v.requests).toEqual([]);
      await p.keyboard.press("Enter");
      expect(v.requests).toEqual([
        { name: "insert", params: { id: "d1", text: `${draft().text}\nping me.`, send: false } },
      ]);
      // Answered once: a second Enter before the next draft does nothing.
      await p.keyboard.press("Enter");
      expect(v.requests.length).toBe(1);

      await v.send("open", draft({ id: "d2" }));
      await p.keyboard.press("Control+Enter");
      expect(v.requests[1]).toEqual({
        name: "insert",
        params: { id: "d2", text: draft().text, send: true },
      });
      // On macOS the send chord is Cmd+Enter, and Ctrl+Enter is not it.
      await v.send("open", draft({ id: "d3", platform: "darwin" }));
      expect(await text(p, "#draft-keys")).toContain("Cmd+Enter: insert and send");
      await p.keyboard.press("Control+Enter");
      expect(v.requests.length).toBe(2);
      await p.keyboard.press("Meta+Enter");
      expect(v.requests[2]?.params).toEqual({ id: "d3", text: draft().text, send: true });

      await v.send("open", draft({ id: "d4" }));
      await p.keyboard.press("Escape");
      expect(v.requests[3]).toEqual({ name: "discard", params: { id: "d4" } });

      await v.send("open", draft({ id: "d5" }));
      await p.click("#draft-copy");
      await p.selectOption("#draft-retry-engine", "best");
      await p.click("#draft-retry");
      await p.click("#draft-close");
      expect(v.requests.slice(4)).toEqual([
        { name: "copy", params: { id: "d5", text: draft().text } },
        { name: "retry", params: { id: "d5", engine: "best" } },
        { name: "discard", params: { id: "d5" } },
      ]);
    },
    UI_TIMEOUT,
  );

  test(
    "low-confidence words are underlined, the other engine's reading replaces one, an edit drops its mark",
    async () => {
      const p = v.page;
      await v.send("open", draft({ id: "d6" }));
      expect(await marks(p)).toEqual(["cooper", "netties"]);
      expect(await visible(p, "#draft-noconf")).toBe(false);
      // A click on the word the other engine heard differently offers that reading.
      const at = draft().text.indexOf("cooper") + 2;
      await p.$eval(
        "#draft-text",
        (t, i) => (t as HTMLTextAreaElement).setSelectionRange(i, i),
        at,
      );
      await p.dispatchEvent("#draft-text", "click");
      expect(await visible(p, "#draft-alts")).toBe(true);
      await p.click("#draft-alts button.alt");
      expect(await value(p)).toBe("Tell the Kubernetes netties team the rollout is on Thursday");
      expect(await marks(p)).toEqual(["netties"]);
      // A click on a word with no other reading offers nothing.
      await p.$eval("#draft-text", (t) => (t as HTMLTextAreaElement).setSelectionRange(2, 2));
      await p.dispatchEvent("#draft-text", "click");
      expect(await visible(p, "#draft-alts")).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "an engine that gives no confidences: the note and no underline",
    async () => {
      const p = v.page;
      await v.send("open", draft({ id: "d7", words: [] }));
      expect(await visible(p, "#draft-noconf")).toBe(true);
      expect(await text(p, "#draft-noconf")).toBe("no confidence from this engine");
      expect(await marks(p)).toEqual([]);
      // Words with no score are no confidences either.
      await v.send("open", draft({ id: "d8", words: [{ w: "Tell" }, { w: "cooper" }] }));
      expect(await visible(p, "#draft-noconf")).toBe(true);
      expect(await marks(p)).toEqual([]);
    },
    UI_TIMEOUT,
  );

  test(
    "an automatic open leaves the keyboard where it was; a click moves it into the box",
    async () => {
      const p = v.page;
      // Something else on the page has the keyboard, as another app would.
      await p.evaluate(() => {
        const b = document.createElement("input");
        b.id = "elsewhere";
        document.body.append(b);
        b.focus();
      });
      await v.send("open", draft({ id: "d9", focus: false }));
      expect(await visible(p, "#draft")).toBe(true);
      expect(await active(p)).toBe("elsewhere");
      // Keys typed elsewhere never land in the draft.
      await p.keyboard.type("secret");
      expect(await value(p)).toBe(draft().text);
      await p.click("#draft-text");
      expect(await active(p)).toBe("draft-text");
      // Positive control: a deliberate open takes it.
      await p.focus("#elsewhere");
      await v.send("open", draft({ id: "d10", focus: true }));
      expect(await active(p)).toBe("draft-text");
      await p.evaluate(() => document.getElementById("elsewhere")?.remove());
    },
    UI_TIMEOUT,
  );

  test(
    "a new draft takes the last one's chip down and answers it ignore",
    async () => {
      const p = v.page;
      await v.send("open", draft({ id: "d11" }));
      await v.send("chip", {
        id: "d11",
        mode: "ask",
        candidates: [{ term: "Kubernetes", heard: "cooper netties" }],
      });
      expect(await visible(p, "#chip")).toBe(true);
      v.requests.length = 0;
      await v.send("open", draft({ id: "d12" }));
      expect(await visible(p, "#chip")).toBe(false);
      expect(v.requests).toEqual([{ name: "chip", params: { id: "d11", action: "ignore" } }]);
    },
    UI_TIMEOUT,
  );

  test(
    "a press on a control in the drag strip is a press, not a window move",
    async () => {
      // ElectroBun's preload starts a window move on a mousedown under the drag class unless an
      // element on the way up carries the no-drag class.
      const p = v.page;
      expect((await p.$$(".electrobun-webkit-app-region-drag")).length).toBeGreaterThan(0);
      const moves = await p.$$eval("button, input, select, textarea", (els) =>
        els
          .filter(
            (e) =>
              e.closest(".electrobun-webkit-app-region-drag") &&
              !e.closest(".electrobun-webkit-app-region-no-drag"),
          )
          .map((e) => e.id),
      );
      expect(moves).toEqual([]);
    },
    UI_TIMEOUT,
  );

  test("the marks follow an edit before them and vanish when their word is edited", () => {
    const t = "aa bb cc";
    const m = lowMarks(t, [
      { w: "aa", c: 0.9 },
      { w: "bb", c: 0.2 },
      { w: "cc", c: 0.1 },
    ]);
    expect(m.map((x) => [x.start, x.end])).toEqual([
      [3, 5],
      [6, 8],
    ]);
    expect(shiftMarks(m, t, "xaa bb cc").map((x) => x.start)).toEqual([4, 7]);
    expect(shiftMarks(m, t, "aa bX cc").map((x) => x.start)).toEqual([6]);
    expect(shiftMarks(m, t, "aa bb cc!").map((x) => x.start)).toEqual([3, 6]);
  });
});

describe("DC-U1: the Dictation page in the window", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  test(
    "shows every group, saves one key per change, and shows a refusal beside its key",
    async () => {
      let fx: Awaited<ReturnType<typeof dictationFixture>> | null = null;
      const page = await rig.open(undefined, {
        before: async (p) => {
          fx = await dictationFixture(p);
        },
      });
      const f = fx as unknown as Awaited<ReturnType<typeof dictationFixture>>;
      await page.click("#dictation-open");
      await page.waitForSelector("#dictation fieldset[data-group='Keys']", { state: "visible" });
      const groups = await page.$$eval("#dictation fieldset", (g) =>
        g.map((x) => x.getAttribute("data-group")),
      );
      expect(groups).toEqual([
        "Keys",
        "Microphone",
        "Engine",
        "Insert",
        "Learning",
        "Pill and sounds",
        "Privacy",
      ]);
      // Every fixture key is on the page, the master switch above the groups.
      const keys = await page.$$eval("#dictation [data-key]:not(div)", (e) =>
        e.map((x) => (x as HTMLElement).dataset.key),
      );
      expect(keys.sort()).toEqual(Object.keys(DICTATION_SCHEMA).sort());
      expect(await page.$(".dictation-enable [data-key='dictation.enabled']")).not.toBeNull();

      await page.check("#dictation [data-key='dictation.enabled']:not(div)");
      await until(() => f.patches.length === 1, 5000, "the switch saved");
      await page.selectOption("#dictation [data-key='dictation.activation']:not(div)", "toggle");
      await until(() => f.patches.length === 2, 5000, "the activation saved");
      expect(f.patches).toEqual([
        { "dictation.enabled": true },
        { "dictation.activation": "toggle" },
      ]);

      f.refuse.set("dictation.maxMinutes", "must be at most 60");
      await page.fill("#dictation [data-key='dictation.maxMinutes']:not(div)", "90");
      await page.press("#dictation [data-key='dictation.maxMinutes']:not(div)", "Tab");
      await page.waitForSelector("#dictation div.setting.refused[data-key='dictation.maxMinutes']");
      expect(await text(page, "#dictation div.setting.refused .issue")).toBe(
        "dictation.maxMinutes: must be at most 60",
      );
      expect(f.patches.at(-1)).toEqual({ "dictation.maxMinutes": 90 });

      // Once saved, the page keeps no copy of a secret.
      const remoteKey = "#dictation [data-key='dictation.remote.key']:not(div)";
      await page.fill(remoteKey, "k-123");
      await page.press(remoteKey, "Tab");
      await until(() => f.patches.length === 4, 5000, "the key saved");
      expect(f.patches.at(-1)).toEqual({ "dictation.remote.key": "k-123" });
      await page.waitForFunction(
        (sel) => (document.querySelector(sel) as HTMLInputElement).value === "",
        remoteKey,
      );
      expect(await page.getAttribute(remoteKey, "placeholder")).toBe(
        "set (hidden); type to replace",
      );

      // The remote's address is shown in a browser and cannot be changed from it.
      expect(await page.isDisabled("#dictation [data-key='dictation.remote.url']:not(div)")).toBe(
        true,
      );

      // Delete all asks once more before it acts.
      await page.click("#dictation button.stop");
      expect(f.deletes).toBe(0);
      await page.click("#dictation button.stop");
      await until(() => f.deletes === 1, 5000, "the delete");
    },
    UI_TIMEOUT,
  );

  test(
    "the Settings list leaves the dictation keys out and links to the page; #dictation opens it",
    async () => {
      const page = await rig.open(undefined, { before: (p) => dictationFixture(p) });
      await page.click("#settings-open");
      await page.waitForSelector("#settings-fields .setting");
      const flat = await page.$$eval("#settings-fields [data-key]:not(div)", (e) =>
        e.map((x) => (x as HTMLElement).dataset.key as string),
      );
      expect(flat.length).toBeGreaterThan(5);
      expect(flat.filter((k) => k.startsWith("dictation.") || k === "asr.qwenIdleMinutes")).toEqual(
        [],
      );
      await page.click("#settings-dictation button");
      await page.waitForSelector("#dictation[open]");
      expect(await page.isVisible("#settings")).toBe(false);
      await page.click("#dictation-close");

      // The address opens the page, as a link to it would.
      await page.evaluate(() => {
        location.hash = "#dictation";
      });
      await page.waitForSelector("#dictation[open] fieldset[data-group='Keys']");
    },
    UI_TIMEOUT,
  );

  test(
    "with no dictation keys in the registry the page says so and Settings has no link",
    async () => {
      const page = await rig.open();
      await page.click("#dictation-open");
      await page.waitForSelector("#dictation [data-empty]");
      expect(await page.$$("#dictation fieldset")).toEqual([]);
      await page.click("#dictation-close");
      await page.click("#settings-open");
      await page.waitForSelector("#settings-fields .setting");
      expect(await page.$("#settings-dictation")).toBeNull();
    },
    UI_TIMEOUT,
  );
});

describe("DC-H1: the History page", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-hist-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  const openHistory = async (history: DictationRow[]) => {
    let fx: DictationFixture | null = null;
    const page = await rig.open(undefined, {
      before: async (p) => {
        await p.context().grantPermissions([...CLIPBOARD_PERMISSIONS]);
        fx = await dictationFixture(p, { history });
      },
    });
    await page.click("#dictation-open");
    await page.click("#dictation-history-open");
    await page.waitForSelector("#dictation-history[open] #dictation-history-list li");
    return { page, fx: fx as unknown as DictationFixture };
  };
  const row = (id: string) => `#dictation-history-list li[data-id='${id}']`;

  test(
    "lists every dictation with its app, engine, time and state; each action calls its route",
    async () => {
      const { page, fx } = await openHistory([
        dictationRow(1),
        dictationRow(2, { state: "cancelled", app: null, engine: "best", ms: 640 }),
        dictationRow(3, { state: "failed", text: null, error: "remote akou not reachable" }),
      ]);
      expect(
        await page.$$eval("#dictation-history-list li", (l) => l.map((x) => x.dataset.id)),
      ).toEqual(["d001", "d002", "d003"]);
      expect(await text(page, `${row("d001")} .text`)).toBe("dictation number 1");
      const meta = await text(page, `${row("d002")} .meta`);
      expect(meta).toContain("no app · best 0.6 s");
      expect(await text(page, `${row("d002")} .state`)).toBe("cancelled");
      expect(await text(page, `${row("d003")} .issue`)).toBe("remote akou not reachable");
      // Nothing to insert, copy or fix in a dictation with no text; Retry still decodes its audio.
      expect(await page.isDisabled(`${row("d003")} button.insert`)).toBe(true);
      expect(await page.isDisabled(`${row("d003")} button.fix`)).toBe(true);
      expect(await page.isDisabled(`${row("d003")} button.retry`)).toBe(false);

      fx.calls.length = 0;
      await page.click(`${row("d001")} button.insert`);
      await page.click(`${row("d001")} button.fix`);
      await until(() => fx.calls.length === 2, 5000, "insert and fix");
      expect(fx.calls).toEqual([
        { method: "POST", path: "/dictations/d001/insert", body: { text: "dictation number 1" } },
        {
          method: "POST",
          path: "/dictations/d001/insert",
          body: { text: "dictation number 1", fix: true },
        },
      ]);

      await page.click(`${row("d001")} button.copy`);
      await page.waitForFunction(async () => (await navigator.clipboard.readText()) !== "");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("dictation number 1");

      // Delete asks once more, then removes the dictation from the page and the store.
      fx.calls.length = 0;
      await page.click(`${row("d002")} button.delete`);
      expect(fx.calls).toEqual([]);
      await page.click(`${row("d002")} button.delete`);
      await page.waitForSelector(row("d002"), { state: "detached" });
      expect(fx.calls).toEqual([{ method: "DELETE", path: "/dictations/d002" }]);
      expect(fx.history.map((d) => d.id)).toEqual(["d001", "d003"]);
    },
    UI_TIMEOUT,
  );

  test(
    "Retry with best shows the second result beside the first, and either can be inserted",
    async () => {
      const { page, fx } = await openHistory([dictationRow(1)]);
      // The picker starts on another engine than the one that ran.
      expect(await page.inputValue(`${row("d001")} select.retry-engine`)).toBe("best");
      fx.calls.length = 0;
      await page.click(`${row("d001")} button.retry`);
      await page.waitForSelector(`${row("d001")} .result.retry`);
      expect(fx.calls).toEqual([
        { method: "POST", path: "/dictations/d001/retry", body: { engine: "best" } },
      ]);
      const readings = await page.$$eval(`${row("d001")} .result`, (r) =>
        r.map((x) => [x.getAttribute("data-engine"), x.querySelector(".text")?.textContent]),
      );
      expect(readings).toEqual([
        ["fast", "dictation number 1"],
        ["best", "dictation number 1 (best)"],
      ]);
      expect(await text(page, `${row("d001")} .result.retry small`)).toBe("best 0.6 s");

      fx.calls.length = 0;
      await page.click(`${row("d001")} .result.retry button.insert`);
      await page.click(`${row("d001")} .result.first button.insert`);
      await until(() => fx.calls.length === 2, 5000, "both inserts");
      expect(fx.calls.map((c) => c.body)).toEqual([
        { text: "dictation number 1 (best)" },
        { text: "dictation number 1" },
      ]);

      // A refused retry says why and leaves the readings as they were.
      fx.refuse.set("retry:remote", "no remote akou is set");
      await page.selectOption(`${row("d001")} select.retry-engine`, "remote");
      await page.click(`${row("d001")} button.retry`);
      await page.waitForFunction(() => document.getElementById("toast")?.textContent !== "");
      expect(await text(page, "#toast")).toBe("no remote akou is set");
      expect(await page.$$(`${row("d001")} .result`)).toHaveLength(2);
    },
    UI_TIMEOUT,
  );

  test(
    "search asks the route for the typed text, and Older pages on from the last shown",
    async () => {
      const many = Array.from({ length: HISTORY_PAGE + 5 }, (_, i) => dictationRow(i + 1));
      many[3] = dictationRow(4, { text: "ping the Kubernetes team" });
      const { page, fx } = await openHistory(many);
      expect(await page.$$(`#dictation-history-list li`)).toHaveLength(HISTORY_PAGE);
      await page.click("#dictation-history-more");
      await page.waitForFunction(
        (n) => document.querySelectorAll("#dictation-history-list li").length === n,
        HISTORY_PAGE + 5,
      );
      expect(await page.isHidden("#dictation-history-more")).toBe(true);

      fx.calls.length = 0;
      await page.fill("#dictation-history-q", "kubernetes");
      await page.waitForFunction(
        () => document.querySelectorAll("#dictation-history-list li").length === 1,
      );
      expect(fx.calls.map((c) => c.path)).toEqual(["/dictations?limit=50&q=kubernetes"]);
      expect(await text(page, "#dictation-history-list li .text")).toBe("ping the Kubernetes team");
      await page.fill("#dictation-history-q", "nothing like this");
      await page.waitForSelector("#dictation-history-list li[data-empty]");
      expect(await text(page, "#dictation-history-list li")).toBe("No dictation holds that.");
    },
    UI_TIMEOUT,
  );
});

describe("DC-U3: the dictation key recorder", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-keys-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  const input = (key: string) => `#dictation input[data-key='${key}']`;
  const record = (key: string) => `#dictation button.record-key[data-for='${key}']`;
  const caps = (page: Page, key: string) =>
    page.$$eval(`#dictation div.setting[data-key='${key}'] .keycaps kbd`, (k) =>
      k.map((x) => x.textContent),
    );
  const note = (page: Page, key: string) =>
    text(page, `#dictation div.setting[data-key='${key}'] .recorder-note`);
  const openPage = async (o: { grants?: { mic: boolean; accessibility: boolean } } = {}) => {
    let fx: DictationFixture | null = null;
    const page = await rig.open(undefined, {
      before: async (p) => {
        fx = await dictationFixture(p, { platform: "darwin", ...o });
      },
    });
    await page.click("#dictation-open");
    await page.waitForSelector(record("dictation.hotkey"));
    return { page, fx: fx as unknown as DictationFixture };
  };

  test(
    "a chord is saved at its first key, and a modifier held alone saves its side",
    async () => {
      const { page, fx } = await openPage();
      await page.click(record("dictation.hotkeyDraft"));
      expect(await page.getAttribute(record("dictation.hotkeyDraft"), "aria-pressed")).toBe("true");
      await page.keyboard.press("Control+Shift+KeyD");
      await until(() => fx.patches.length === 1, 5000, "the chord saved");
      expect(fx.patches).toEqual([{ "dictation.hotkeyDraft": "Control+Shift+D" }]);
      expect(await page.inputValue(input("dictation.hotkeyDraft"))).toBe("Control+Shift+D");
      expect(await caps(page, "dictation.hotkeyDraft")).toEqual(["⌃", "⇧", "D"]);
      expect(await page.getAttribute(record("dictation.hotkeyDraft"), "aria-pressed")).toBe(
        "false",
      );

      // Right Command tapped is not yet a key alone; held 400 ms and released alone, it is.
      await page.click(record("dictation.hotkey"));
      await page.keyboard.down("MetaRight");
      await page.keyboard.up("MetaRight");
      expect(await note(page, "dictation.hotkey")).toBe(
        "Hold a key alone a moment longer to use it by itself.",
      );
      await page.keyboard.down("MetaRight");
      await page.waitForTimeout(HOLD_ALONE_MS + 100);
      await page.keyboard.up("MetaRight");
      await until(() => fx.patches.length === 2, 5000, "the key alone saved");
      expect(fx.patches.at(-1)).toEqual({ "dictation.hotkey": "RightCommand" });
      expect(await caps(page, "dictation.hotkey")).toEqual(["Right ⌘"]);

      // The left one is another key.
      await page.click(record("dictation.hotkeyPasteLast"));
      await page.keyboard.down("ShiftLeft");
      await page.waitForTimeout(HOLD_ALONE_MS + 100);
      await page.keyboard.up("ShiftLeft");
      await until(() => fx.patches.length === 3, 5000, "the left shift saved");
      expect(fx.patches.at(-1)).toEqual({ "dictation.hotkeyPasteLast": "LeftShift" });

      // Escape stops the recorder and saves nothing.
      await page.click(record("dictation.hotkeyFixLast"));
      await page.keyboard.press("Escape");
      expect(await page.getAttribute(record("dictation.hotkeyFixLast"), "aria-pressed")).toBe(
        "false",
      );
      expect(await page.isVisible("#dictation")).toBe(true);
      expect(fx.patches).toHaveLength(3);
    },
    UI_TIMEOUT,
  );

  test(
    "a binding another key has is refused with the conflict, and nothing is saved",
    async () => {
      const { page, fx } = await openPage();
      // The recording hotkey's macOS default.
      await page.click(record("dictation.hotkey"));
      await page.keyboard.press("Alt+Meta+KeyR");
      expect(await note(page, "dictation.hotkey")).toBe(
        "⌥ ⌘ R is already the recording hotkey (app.hotkey).",
      );
      expect(fx.patches).toEqual([]);
      expect(await page.getAttribute(record("dictation.hotkey"), "aria-pressed")).toBe("true");
      // Another dictation key's binding, however it was written.
      await page.keyboard.press("Control+Shift+KeyD");
      await until(() => fx.patches.length === 1, 5000, "the free chord saved");
      await page.click(record("dictation.hotkeyDraft"));
      await page.keyboard.press("Shift+Control+KeyD");
      expect(await note(page, "dictation.hotkeyDraft")).toBe(
        "⌃ ⇧ D is already the dictation key (dictation.hotkey).",
      );
      expect(fx.patches).toEqual([{ "dictation.hotkey": "Control+Shift+D" }]);
    },
    UI_TIMEOUT,
  );

  test(
    "without the Accessibility grant a modifier alone is refused with the reason; a chord is taken",
    async () => {
      const { page, fx } = await openPage({ grants: { mic: true, accessibility: false } });
      await page.click(record("dictation.hotkey"));
      expect(await note(page, "dictation.hotkey")).toContain("takes chords only");
      await page.keyboard.down("MetaRight");
      await page.waitForTimeout(HOLD_ALONE_MS + 100);
      await page.keyboard.up("MetaRight");
      expect(await note(page, "dictation.hotkey")).toBe(
        "Right ⌘ alone cannot be bound: without the Accessibility grant akou binds its key as a Carbon hotkey, which takes chords only, such as Control+Shift+Space.",
      );
      expect(fx.patches).toEqual([]);
      await page.keyboard.press("Control+Shift+Space");
      await until(() => fx.patches.length === 1, 5000, "the chord saved");
      expect(fx.patches).toEqual([{ "dictation.hotkey": "Control+Shift+Space" }]);
    },
    UI_TIMEOUT,
  );

  test(
    "in the window, a key the helper reports while recording (Fn) is saved; closing stops it",
    async () => {
      const w = await windowPage(rig, { platform: "darwin" });
      try {
        const p = w.page;
        await p.click("#dictation-open");
        await p.click(record("dictation.hotkey"));
        await until(
          () => w.requests.some((r) => r.name === "recordDictationKeys"),
          5000,
          "the recorder asked for the helper's keys",
        );
        expect(
          w.requests.filter((r) => r.name === "recordDictationKeys").map((r) => r.params),
        ).toEqual([{ on: true }]);
        await w.send("dictationKey", { name: "Fn" });
        await until(() => w.patches.length === 1, 5000, "Fn saved");
        expect(w.patches).toEqual([{ "dictation.hotkey": "Fn" }]);
        expect(await caps(p, "dictation.hotkey")).toEqual(["fn"]);
        expect(
          w.requests.filter((r) => r.name === "recordDictationKeys").map((r) => r.params),
        ).toEqual([{ on: true }, { on: false }]);

        // A recorder left open when the page closes lets go of the helper's keys too.
        await p.click(record("dictation.hotkeyDraft"));
        await p.click("#dictation-close");
        await until(
          () => w.requests.filter((r) => r.name === "recordDictationKeys").length === 4,
          5000,
          "the close stopped the recorder",
        );
        expect(w.requests.at(-1)?.params).toEqual({ on: false });
        await w.send("dictationKey", { name: "Fn" });
        expect(w.patches).toHaveLength(1);
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );
});
