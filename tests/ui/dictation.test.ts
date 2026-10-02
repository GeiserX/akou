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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "playwright-core";
import { QWEN_ASR } from "../../src/main/asr/llama-catalog.ts";
import { MODELS, modelFile } from "../../src/main/asr/models.ts";
import { SETTINGS } from "../../src/main/config/schema.ts";
import { parseVocab } from "../../src/main/vocab/files.ts";
import { DRAFT_SIZE, PILL_SIZE } from "../../src/main/window/shell.ts";
import { APP_RULE_GLOBAL, NEXT_APP_LABEL, NEXT_APP_WAITING } from "../../src/ui/dictation-apps.ts";
import { CHIP_ASK_MS, CHIP_UNDO_MS } from "../../src/ui/dictation-chip.ts";
import {
  type DictionaryEntry,
  isReplacement,
  readVocab,
  WORDS_SHOWN,
} from "../../src/ui/dictation-dictionary.ts";
import { type DictationRow, HISTORY_PAGE } from "../../src/ui/dictation-history.ts";
import { type CaptureInput, readMics } from "../../src/ui/dictation-mic.ts";
import {
  ADVANCED_PAGE,
  DICTATION_GROUPS,
  type DictationGrants,
  dictationKeys,
  ENABLE_KEY,
  HISTORY_KEYS,
  onDictationPage,
} from "../../src/ui/dictation-page.ts";
import type { DraftOpen } from "../../src/ui/dictation-protocol.ts";
import { HOLD_ALONE_MS } from "../../src/ui/dictation-recorder.ts";
import { lowMarks, shiftMarks } from "../../src/ui/draft.ts";
import { dayLabel, localZone } from "../../src/ui/model.ts";
import {
  PREVIEW_CHARS,
  PREVIEW_LINE_PX,
  PREVIEW_LINES,
  previewMaxHeight,
  previewParts,
} from "../../src/ui/pill.ts";
import { type PillState, pillPreview } from "../../src/ui/pill-protocol.ts";
import type { Transport } from "../../src/ui/protocol.ts";
import { WORDS } from "../../src/ui/settings-labels.ts";
import { concat, silence, speak } from "../fixtures/asr-fake.ts";
import { monoWav } from "../fixtures/audio.ts";
import { tempDir } from "../helpers.ts";
import {
  CLIPBOARD_PERMISSIONS,
  type DevicesFixture,
  DICTATION_SCHEMA,
  type DictationFixture,
  dictationFixture,
  dictationRow,
  seedCall,
  standardCall,
  UI_TIMEOUT,
  type UiRig,
  uiRig,
  until,
  type ViewPage,
  VOCAB_FILE,
  type VocabFixture,
  viewPage,
  vocabFixture,
  windowPage,
} from "./rig.ts";

const text = (page: Page, sel: string) => page.textContent(sel).then((t) => t?.trim() ?? "");
const visible = (page: Page, sel: string) => page.isVisible(sel);
const ids = (page: Page, sel: string) =>
  page.$$eval(sel, (els) => els.map((e) => (e as HTMLElement).id));

describe("DC-O1: the pill, the island at the top", () => {
  let v: ViewPage;
  beforeAll(async () => {
    v = await viewPage("pill", { clock: new Date("2026-09-26T10:00:00Z") });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await v?.close();
  });
  const state = (s: PillState) => v.send("state", s);
  const now = () => v.page.evaluate(() => Date.now());
  /** The island's icons that show, by id. */
  const icons = (p: Page) =>
    p.$$eval("#island .icon", (els) =>
      els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.id),
    );
  const caps = (p: Page) => p.$$eval("#hints .key", (k) => k.map((x) => x.textContent));
  const segments = (p: Page) =>
    p.$$eval("#level i", (bars) => bars.map((b) => b.className || "off"));

  test(
    "hidden until a state arrives, then listening with the dot, the level, the time, Stop and Cancel",
    async () => {
      const p = v.page;
      expect(await visible(p, "#pill")).toBe(false);
      await state({ state: "listening", since: (await now()) - 4200, keys: [], hotkey: "Right ⌘" });
      expect(await p.getAttribute("#pill", "data-state")).toBe("listening");
      expect(await icons(p)).toEqual(["rec"]);
      expect(await visible(p, "#word")).toBe(false);
      expect(await text(p, "#elapsed")).toBe("0:04");
      expect(await visible(p, "#level")).toBe(true);
      expect(await ids(p, "#controls button")).toEqual(["stop", "cancel"]);
      // A backend that cannot hold keys: the dictation key's hint only.
      expect(await caps(p)).toEqual(["Right ⌘"]);
      expect(await text(p, "#hints")).toBe("Right ⌘stops");
      // One that can: every key it honours, in the island's order, and no others.
      await state({
        state: "listening",
        since: (await now()) - 4200,
        keys: ["escape", "enter"],
        hotkey: "Right ⌘",
      });
      expect(await caps(p)).toEqual(["↵", "esc"]);
      expect(await text(p, "#hints")).toBe("↵sends·esccancels");

      // The five segments follow the level, clamped to their range.
      await v.send("level", { db: -60 });
      expect(await segments(p)).toEqual(["off", "off", "off", "off", "off"]);
      await v.send("level", { db: -30 });
      expect(await segments(p)).toEqual(["on", "on", "half", "off", "off"]);
      await v.send("level", { db: -20 });
      expect(await segments(p)).toEqual(["on", "on", "on", "off", "off"]);
      // A clipping mic reads full scale, never silence.
      await v.send("level", { db: 0 });
      expect(await segments(p)).toEqual(["on", "on", "on", "on", "on"]);
      await v.send("level", { db: 12 });
      expect(await segments(p)).toEqual(["on", "on", "on", "on", "on"]);
      expect(await p.getAttribute("#level", "data-db")).toBe("0");

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
    "the key hints fade in under the island only after 1.5 s of listening",
    async () => {
      const p = v.page;
      await state({ state: "listening", since: await now(), keys: ["enter"], hotkey: "Right ⌘" });
      expect(await visible(p, "#hints")).toBe(false);
      await p.clock.runFor(1000);
      expect(await visible(p, "#hints")).toBe(false);
      await p.clock.runFor(750);
      expect(await visible(p, "#hints")).toBe(true);
      // `1 minute left` joins the hint line.
      await state({
        state: "listening",
        since: (await now()) - 1750,
        keys: ["enter"],
        hotkey: "Right ⌘",
        note: "1 minute left",
      });
      expect(await text(p, "#warn")).toBe("1 minute left");
      await state({ state: "hidden" });
      expect(await visible(p, "#hints")).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "transcribing rings the dot and shows its time only past 2 s; inserted and copied; error drops a sheet",
    async () => {
      const p = v.page;
      await state({ state: "transcribing", since: await now() });
      expect(await p.getAttribute("#pill", "data-state")).toBe("transcribing");
      expect(await icons(p)).toEqual(["ring"]);
      expect(await text(p, "#word")).toBe("Transcribing");
      expect(await text(p, "#elapsed")).toBe("");
      expect(await visible(p, "#level")).toBe(false);
      expect(await visible(p, "#controls")).toBe(false);
      expect(await visible(p, "#hints")).toBe(false);
      await p.clock.runFor(1700);
      expect(await text(p, "#elapsed")).toBe("");
      // Past 2 s, in tenths of a second as the island shows it (the page ticks every 250 ms).
      await p.clock.runFor(800);
      expect(await text(p, "#elapsed")).toMatch(/^2\.[2-5] s$/);
      await state({ state: "transcribing", since: await now(), note: "loading model" });
      expect(await text(p, "#word")).toBe("Transcribing · loading model");

      await state({ state: "done", how: "inserted" });
      expect(await p.getAttribute("#pill", "data-state")).toBe("inserted");
      expect(await icons(p)).toEqual(["check"]);
      expect(await text(p, "#word")).toBe("Inserted");
      expect(await text(p, "#elapsed")).toBe("");
      await state({ state: "done", how: "copied", note: "⌘V" });
      expect(await icons(p)).toEqual(["copied"]);
      expect(await text(p, "#word")).toBe("Copied · ⌘V");

      await state({
        state: "error",
        message: "remote akou not reachable",
        actions: ["retry", "copy", "open-draft"],
        retryLabel: "Retry locally",
      });
      expect(await p.getAttribute("#pill", "data-state")).toBe("error");
      expect(await icons(p)).toEqual(["alert"]);
      expect(await text(p, "#word")).toBe("Didn’t finish");
      expect(await visible(p, "#sheet")).toBe(true);
      expect(await text(p, "#message")).toBe("remote akou not reachable");
      // A screen reader hears the message, not only the island's word.
      expect(await p.getAttribute("#message", "role")).toBe("alert");
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
      expect(await visible(p, "#sheet")).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "at rest from the key-down: a dimmed dot on the smallest island, nothing else, then listening",
    async () => {
      const p = v.page;
      await state({ state: "pressed" });
      expect(await visible(p, "#pill")).toBe(true);
      expect(await p.getAttribute("#pill", "data-state")).toBe("pressed");
      expect(await icons(p)).toEqual(["dot"]);
      for (const sel of ["#level", "#controls", "#lang", "#hints", "#sheet", "#preview"])
        expect({ sel, shown: await visible(p, sel) }).toEqual({ sel, shown: false });
      expect(await text(p, "#word")).toBe("");
      expect(await text(p, "#elapsed")).toBe("");
      const look = await p.evaluate(() => {
        const island = document.getElementById("island") as HTMLElement;
        const dot = document.getElementById("dot") as HTMLElement;
        const r = island.getBoundingClientRect();
        return {
          width: r.width,
          height: r.height,
          island: getComputedStyle(island).backgroundColor,
          dot: getComputedStyle(dot).backgroundColor,
          dotSize: dot.getBoundingClientRect().width,
        };
      });
      // The collapsed island of the storyboard: 36 px tall at its narrowest, black, a grey dot.
      expect(look).toEqual({
        width: 126,
        height: 36,
        island: "rgb(0, 0, 0)",
        dot: "rgba(255, 255, 255, 0.35)",
        dotSize: 6,
      });
      await state({ state: "listening", since: await now(), keys: [], hotkey: "Right ⌘" });
      expect(await icons(p)).toEqual(["rec"]);
      await state({ state: "hidden" });
      expect(await visible(p, "#pill")).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "the island is black in both appearances; red is the dot only and green the check only",
    async () => {
      const p = v.page;
      /** Every painted colour on the page that is clearly red or clearly green, by element id. */
      const hues = () =>
        p.evaluate(() => {
          const out: { red: string[]; green: string[] } = { red: [], green: [] };
          const rgb = (c: string) => c.match(/[\d.]+/g)?.map(Number) ?? [];
          const who = (e: Element) => e.id || e.closest("[id]")?.id || e.tagName;
          for (const e of document.querySelectorAll("#pill *")) {
            if (!e.checkVisibility()) continue;
            const cs = getComputedStyle(e);
            for (const c of [cs.backgroundColor, cs.color, cs.fill, cs.stroke]) {
              const [r = 0, g = 0, b = 0, a = 1] = rgb(c);
              if (a === 0) continue;
              if (r > 180 && g < 120 && b < 120) out.red.push(who(e));
              if (g > 150 && r < 120 && b < 140) out.green.push(who(e));
            }
          }
          return { red: [...new Set(out.red)], green: [...new Set(out.green)] };
        });
      const island = () => p.$eval("#island", (e) => getComputedStyle(e).backgroundColor);
      const sheet = () => p.$eval("#sheet", (e) => getComputedStyle(e).backgroundColor);
      const sheets: string[] = [];
      for (const scheme of ["light", "dark"] as const) {
        await p.emulateMedia({ colorScheme: scheme });
        await state({ state: "listening", since: await now(), keys: [], hotkey: "Right ⌘" });
        await v.send("level", { db: -10 });
        expect(await island()).toBe("rgb(0, 0, 0)");
        expect(await hues()).toEqual({ red: ["rec"], green: [] });
        await state({ state: "done", how: "inserted" });
        expect(await island()).toBe("rgb(0, 0, 0)");
        expect((await hues()).red).toEqual([]);
        expect((await hues()).green.length).toBeGreaterThan(0);
        expect((await hues()).green.every((id) => id === "check")).toBe(true);
        await state({ state: "error", message: "nothing heard", actions: ["retry"] });
        sheets.push(await sheet());
      }
      // Positive control for the appearance: what hangs under the island does switch material.
      expect(sheets[0]).not.toBe(sheets[1]);
      await p.emulateMedia({ colorScheme: null });
      await state({ state: "hidden" });
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

  test(
    "[DC-O2] the preview shows the whole dictation while listening, wrapping, and never after",
    async () => {
      const p = v.page;
      const shown = () => text(p, "#preview");
      const onPage = (m: string) =>
        p.evaluate((x) => document.documentElement.outerHTML.includes(x), m);
      const since = await now();
      // A partial before any session has nowhere to go.
      await v.send("preview", { text: "too early" });
      await state({ state: "listening", since, keys: [], hotkey: "Right ⌘" });
      expect(await visible(p, "#preview")).toBe(false);
      expect(await onPage("too early")).toBe(false);

      await v.send("preview", { text: "ping the team" });
      expect(await visible(p, "#preview")).toBe(true);
      expect(await shown()).toBe("ping the team");
      // The same session sent again, with other hints, keeps its words.
      await state({ state: "listening", since, keys: ["escape"], hotkey: "Right ⌘" });
      expect(await shown()).toBe("ping the team");

      // A long one reaches the page whole, from its first word, wrapping under the row.
      const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
      await v.send("preview", { text: long });
      expect(await shown()).toBe(long);
      const lines = await p.$eval(
        "#preview",
        (e) => e.scrollHeight / Number.parseFloat(getComputedStyle(e).lineHeight),
      );
      expect(Math.floor(lines)).toBeGreaterThan(1);
      const under = await p.evaluate(() => {
        const row = (document.getElementById("row") as HTMLElement).getBoundingClientRect();
        const words = (document.getElementById("preview") as HTMLElement).getBoundingClientRect();
        return words.top >= row.bottom - 1;
      });
      expect(under).toBe(true);

      // Listening ends: the words go, and a partial arriving late is dropped.
      await state({ state: "transcribing", since });
      expect(await visible(p, "#preview")).toBe(false);
      expect(await onPage("word39")).toBe(false);
      expect(await p.getAttribute("#pill", "data-words")).toBeNull();
      await v.send("preview", { text: "late partial" });
      expect(await onPage("late partial")).toBe(false);
      // A new session starts with none.
      await state({ state: "listening", since: since + 5000, keys: [], hotkey: "Right ⌘" });
      expect(await shown()).toBe("");
      await state({ state: "hidden" });
    },
    UI_TIMEOUT,
  );

  test(
    "a press on Stop or Cancel is a press, not a drag of the island",
    async () => {
      const p = v.page;
      expect((await p.$$(".electrobun-webkit-app-region-drag")).length).toBeGreaterThan(0);
      const moves = await p.$$eval("button", (els) =>
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
});

describe("DC-O2: settled words and the phrase still changing", () => {
  test("previewParts splits at the settled count, and shifts it when the tail drops the start", () => {
    expect(previewParts("ping the team", 8)).toEqual({ settled: "ping the", changing: " team" });
    expect(previewParts("ping the team", 0)).toEqual({ settled: "", changing: "ping the team" });
    // A count that is not one settles nothing; one past the end settles all.
    expect(previewParts("ping the team", "8")).toEqual({ settled: "", changing: "ping the team" });
    expect(previewParts("ping", 99)).toEqual({ settled: "ping", changing: "" });
    // Only past PREVIEW_CHARS, an hour of speech, does the start give way to an ellipsis.
    const words = Math.ceil(PREVIEW_CHARS / 6) + 100;
    const long = Array.from({ length: words }, (_, i) => `w${i}`).join(" ");
    const last = `w${words - 1}`;
    const parts = previewParts(long, long.lastIndexOf(` ${last}`));
    expect(parts.settled.startsWith("…w")).toBe(true);
    expect(parts.changing).toBe(` ${last}`);
    expect(parts.settled.length + parts.changing.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
    // Settled words that all fell off the front leave only the changing part, ellipsis included.
    expect(previewParts(long, 5).settled).toBe("");
  });

  test(
    "the page draws the settled words white and the rest dimmer",
    async () => {
      const v = await viewPage("pill");
      try {
        await v.send("state", { state: "listening", since: Date.now(), keys: [], hotkey: "Ctrl" });
        await v.send("preview", { text: "ping the team", settled: 8 });
        const look = await v.page.evaluate(() => {
          const color = (id: string) => {
            const e = document.getElementById(id) as HTMLElement;
            return { text: e.textContent, color: getComputedStyle(e).color };
          };
          return { settled: color("preview-settled"), changing: color("preview-changing") };
        });
        expect(look.settled.text).toBe("ping the");
        expect(look.changing.text).toBe(" team");
        expect(look.settled.color).toBe("rgb(255, 255, 255)");
        expect(look.changing.color).not.toBe(look.settled.color);
      } finally {
        await v.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "a read-only language chip says its language at full contrast (akou-5v8)",
    async () => {
      const v = await viewPage("pill");
      try {
        const listening = { state: "listening", since: Date.now(), keys: [], hotkey: "Ctrl" };
        await v.send("state", {
          ...listening,
          language: { tag: "es", switchable: false, forced: false },
        });
        const look = await v.page.evaluate(() => {
          const e = document.getElementById("lang") as HTMLButtonElement;
          return {
            text: e.textContent,
            disabled: e.disabled,
            opacity: getComputedStyle(e).opacity,
          };
        });
        expect(look).toEqual({ text: "ES", disabled: true, opacity: "1" });
      } finally {
        await v.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "the inserted island keeps the language the text went in as, read-only, with the green check",
    async () => {
      const v = await viewPage("pill");
      try {
        const read = () =>
          v.page.evaluate(() => {
            const e = document.getElementById("lang") as HTMLButtonElement;
            return {
              hidden: e.hidden,
              text: e.textContent,
              disabled: e.disabled,
              word: document.getElementById("word")?.textContent,
              check: !document.getElementById("check")?.hasAttribute("hidden"),
            };
          });
        await v.send("state", { state: "done", how: "inserted", language: "es-ES" });
        expect(await read()).toEqual({
          hidden: false,
          text: "ES",
          disabled: true,
          word: "Inserted",
          check: true,
        });
        // Positive control: a done state with no language has no chip.
        await v.send("state", { state: "done", how: "inserted" });
        expect((await read()).hidden).toBe(true);
      } finally {
        await v.close();
      }
    },
    UI_TIMEOUT,
  );
});

describe("H-11: the island holds the whole dictation", () => {
  const listening = { state: "listening", since: 1, keys: ["escape"], hotkey: "Right ⌘" };
  const words = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `word${from + i}`).join(" ");
  /** The words' box: its height, how far it scrolled, and whether it shows the newest line. */
  const box = (p: Page) =>
    p.$eval("#preview", (e) => ({
      height: e.clientHeight,
      max: Number.parseFloat(getComputedStyle(e).maxHeight),
      scroll: e.scrollTop,
      atEnd: e.scrollHeight - e.scrollTop - e.clientHeight <= 4,
      overflows: e.scrollHeight > e.clientHeight,
      over: e.hasAttribute("data-over"),
      overflowY: getComputedStyle(e).overflowY,
    }));
  const sizes = (v: ViewPage) => v.sized;
  const pillHeight = (p: Page) =>
    p.$eval("#pill", (e) => Math.ceil(e.getBoundingClientRect().height));

  test("the cap is eight lines, or 40 % of the display when that is less", () => {
    expect(previewMaxHeight(1080)).toBe(PREVIEW_LINES * PREVIEW_LINE_PX + 12);
    expect(previewMaxHeight(300)).toBe(120);
    expect(previewMaxHeight(Number.NaN)).toBe(PREVIEW_LINES * PREVIEW_LINE_PX + 12);
  });

  test(
    "it grows line by line, stops at the cap and scrolls pinned to the newest words; the window follows",
    async () => {
      const v = await viewPage("pill", { screen: { width: 480, height: 900, scale: 1 } });
      try {
        const p = v.page;
        await v.send("state", listening);
        await v.send("preview", { text: "ping" });
        const one = await box(p);
        const oneLine = await pillHeight(p);
        await until(() => sizes(v).at(-1) === oneLine, 5000, "the one-line height");
        await v.send("preview", { text: words(40) });
        const four = await box(p);
        expect(four.height).toBeGreaterThan(one.height + 2 * PREVIEW_LINE_PX);
        expect(four.overflows).toBe(false);
        const grown = await pillHeight(p);
        await until(() => sizes(v).at(-1) === grown, 5000, "the grown height");
        expect(grown).toBeGreaterThan(oneLine);

        await v.send("preview", { text: words(400) });
        const full = await box(p);
        expect(full.height).toBeLessThanOrEqual(full.max);
        expect(full.overflows).toBe(true);
        expect(full.overflowY).toBe("auto");
        expect(full.atEnd).toBe(true);
        expect(full.over).toBe(true);
        const capped = await pillHeight(p);
        await until(() => sizes(v).at(-1) === capped, 5000, "the capped height");
        // More words past the cap: the window stays, the words follow.
        await v.send("preview", { text: words(500) });
        expect((await box(p)).atEnd).toBe(true);
        expect(await pillHeight(p)).toBe(capped);
      } finally {
        await v.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "scrolled back, the words stay put; back at the bottom, or a new session, they follow again",
    async () => {
      const v = await viewPage("pill", { screen: { width: 480, height: 900, scale: 1 } });
      try {
        const p = v.page;
        await v.send("state", listening);
        await v.send("preview", { text: words(400) });
        await p.$eval("#preview", (e) => {
          e.scrollTop = 0;
          e.dispatchEvent(new Event("scroll"));
        });
        await v.send("preview", { text: words(450) });
        const back = await box(p);
        expect(back.scroll).toBe(0);
        expect(back.atEnd).toBe(false);
        await p.$eval("#preview", (e) => {
          e.scrollTop = e.scrollHeight;
          e.dispatchEvent(new Event("scroll"));
        });
        await v.send("preview", { text: words(500) });
        expect((await box(p)).atEnd).toBe(true);
        // Scrolled back again, then the session ends: the next one follows from its first word.
        await p.$eval("#preview", (e) => {
          e.scrollTop = 0;
          e.dispatchEvent(new Event("scroll"));
        });
        // Chromium fires a scroll when the box empties, which pins again by itself; a WebView that
        // does not would leave it unpinned. The page's own handler is kept from those events here,
        // so only the new session's reset can pin.
        await p.$eval("#preview", (e) => {
          e.addEventListener("scroll", (ev) => ev.stopImmediatePropagation(), { capture: true });
        });
        await v.send("state", { state: "transcribing", since: 2 });
        await v.send("state", { ...listening, since: 3 });
        await v.send("preview", { text: words(400, 1000) });
        expect((await box(p)).atEnd).toBe(true);
      } finally {
        await v.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "at the bottom edge it mirrors: the words above the row, the hints above the island",
    async () => {
      const v = await viewPage("pill", {
        answer: (name) => (name === "layout" ? { edge: "bottom" } : true),
      });
      try {
        const p = v.page;
        await until(
          () => p.getAttribute("#pill", "data-edge").then((e) => e === "bottom"),
          5000,
          "the edge",
        );
        await v.send("state", listening);
        await v.send("preview", { text: words(40) });
        const at = await p.evaluate(() => {
          const r = (id: string) =>
            (document.getElementById(id) as HTMLElement).getBoundingClientRect();
          return {
            row: r("row").top,
            words: r("preview").top,
            island: r("island").top,
            hints: r("hints").top,
          };
        });
        expect(at.words).toBeLessThan(at.row);
        expect(at.hints).toBeLessThan(at.island);
      } finally {
        await v.close();
      }
    },
    UI_TIMEOUT,
  );
});

describe("DC-O2, DC-D2: the preview's gate on the main side", () => {
  test("a partial becomes a preview only with the preview on", () => {
    const on = { pillPreview: true };
    expect(pillPreview("ping the team", on)).toEqual({ text: "ping the team" });
    expect(pillPreview("ping the team", { pillPreview: false })).toBeNull();
    // Only a real true turns it on, not a string a hand-edited file might hold.
    expect(pillPreview("ping the team", { pillPreview: "true" })).toBeNull();
    expect(pillPreview("  ", on)).toBeNull();
    expect(pillPreview({ text: "x" }, on)).toBeNull();
  });
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
      expect(await text(p, "#chip .chip-q")).toBe('Learn "Kubernetes"?');
      expect(await text(p, "#chip .chip-w")).toBe("You changed cooper netties");
      expect(await text(p, "#chip .chip-w s")).toBe("cooper netties");
      // With no state showing, the chip hangs under a neutral island.
      expect(await visible(p, "#pill")).toBe(true);
      expect(await p.getAttribute("#pill", "data-state")).toBe("chip");
      expect(await text(p, "#word")).toBe("Vocabulary");
      // It asks with Learn and Not a word, nothing else.
      expect(await ids(p, "#chip button")).toEqual(["chip-learn", "chip-reject"]);
      v.requests.length = 0;
      await p.click("#chip-learn");
      expect(v.requests).toEqual([
        { name: "chip", params: { id: "d1", action: "learn", terms: ["Kubernetes"] } },
      ]);
      expect(await text(p, "#chip .chip-q")).toBe('Learned "Kubernetes"');
      await p.click("#chip-undo");
      expect(v.requests[1]).toEqual({
        name: "chip",
        params: { id: "d1", action: "undo", terms: ["Kubernetes"] },
      });
      expect(await visible(p, "#chip")).toBe(false);
      // The island goes with the chip when nothing else shows.
      expect(await visible(p, "#pill")).toBe(false);

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
    "Not a word rejects; ignored for 8 s answers ignore; a chip under a listening island keeps it",
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
      expect(v.requests.map((r) => r.params)).toEqual([
        { id: "d3", action: "reject", terms: ["Kubernetes"] },
        { id: "d4", action: "ignore" },
      ]);
      // A chip while listening hangs under the listening island, not a neutral one.
      await v.send("state", {
        state: "listening",
        since: await p.evaluate(() => Date.now()),
        keys: [],
        hotkey: "Right ⌘",
      });
      await v.send("chip", one("d5"));
      expect(await p.getAttribute("#pill", "data-state")).toBe("listening");
      await p.click("#chip-reject");
      await v.send("state", { state: "hidden" });
      expect(await visible(p, "#pill")).toBe(false);
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
      expect(await text(p, "#chip .chip-q")).toBe("Learn these words?");
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
      expect(await text(p, "#chip .chip-q")).toBe('Learned "Kubernetes"');
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

  test(
    "a chip of long words stays inside the pill's window, its buttons whole",
    async () => {
      const p = v.page;
      await p.setViewportSize(PILL_SIZE);
      try {
        await v.send("chip", {
          id: "d9",
          mode: "ask",
          candidates: [
            { term: "Kubernetes Engine Autopilot", heard: "cooper netties engine auto pilot" },
            { term: "Vercel", heard: "versal" },
            { term: "Grafana Loki", heard: "grafanna low key" },
            { term: "Tailscale", heard: "tail scale" },
          ],
        });
        const boxes = await p.$$eval("#chip, #chip button", (els) =>
          els.map((e) => {
            const r = e.getBoundingClientRect();
            return { id: e.id, left: r.left, right: r.right, bottom: r.bottom };
          }),
        );
        const size = await p.evaluate(() => ({ w: innerWidth, h: innerHeight }));
        expect(boxes.map((b) => b.id)).toEqual(["chip", "chip-learn", "chip-reject"]);
        for (const b of boxes) {
          expect(b.left).toBeGreaterThanOrEqual(0);
          expect(b.right).toBeLessThanOrEqual(size.w);
          expect(b.bottom).toBeLessThanOrEqual(size.h);
        }
        // The cut word keeps its whole in the title.
        expect(await p.getAttribute("#chip .chip-label", "title")).toBe(
          "Kubernetes Engine Autopilot (heard cooper netties engine auto pilot)",
        );
        await p.click("#chip-reject");
      } finally {
        await p.setViewportSize({ width: 1280, height: 720 });
      }
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
    local: true,
    seconds: 14,
    language: "es",
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
      // The island says Draft and the audio's length; the sheet where it goes and how it was heard.
      expect(await text(p, "#draft-island")).toBe("Draft· 0:14");
      expect(await text(p, "#draft-to")).toBe("Goes toSSlack");
      expect(await text(p, "#draft-meta")).toBe(
        "fast (Parakeet) on this computertook 0.3 s0:14 of audioES",
      );
      expect(await text(p, "#draft-lang")).toBe("ES");
      expect(await text(p, "#draft-send-key")).toBe("Ctrl ↵");
      expect(await text(p, "#draft-retry")).toBe("↻ Retry with best");
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
      expect(await text(p, "#draft-send-key")).toBe("⌘↵");
      expect(await text(p, "#draft-meta")).toContain("on this Mac");
      await p.keyboard.press("Control+Enter");
      expect(v.requests.length).toBe(2);
      await p.keyboard.press("Meta+Enter");
      expect(v.requests[2]?.params).toEqual({ id: "d3", text: draft().text, send: true });

      await v.send("open", draft({ id: "d4" }));
      await p.keyboard.press("Escape");
      expect(v.requests[3]).toEqual({ name: "discard", params: { id: "d4" } });

      await v.send("open", draft({ id: "d5", engines: ["best", "remote"] }));
      await p.click("#draft-copy");
      await p.selectOption("#draft-retry-engine", "remote");
      expect(await text(p, "#draft-retry")).toBe("↻ Retry with remote");
      await p.click("#draft-retry");
      await p.click("#draft-close");
      // The buttons do what the keys do.
      await v.send("open", draft({ id: "d5b" }));
      await p.click("#draft-insert");
      await v.send("open", draft({ id: "d5c" }));
      await p.click("#draft-send");
      expect(v.requests.slice(4)).toEqual([
        { name: "copy", params: { id: "d5", text: draft().text } },
        { name: "retry", params: { id: "d5", engine: "remote" } },
        { name: "discard", params: { id: "d5" } },
        { name: "insert", params: { id: "d5b", text: draft().text, send: false } },
        { name: "insert", params: { id: "d5c", text: draft().text, send: true } },
      ]);
      // A remote reading says nothing about this machine; nothing known is left out.
      await v.send(
        "open",
        draft({
          id: "d5d",
          engine: "remote",
          local: false,
          seconds: undefined,
          language: undefined,
          to: undefined,
        }),
      );
      expect(await text(p, "#draft-meta")).toBe("remotetook 0.3 s");
      expect(await text(p, "#draft-length")).toBe("");
      expect(await visible(p, "#draft-to")).toBe(false);
      // With one engine to retry with there is nothing to pick.
      await v.send("open", draft({ id: "d5e" }));
      expect(await visible(p, "#draft-retry-pick")).toBe(false);
      await v.send("open", draft({ id: "d5f", engines: [] }));
      expect(await visible(p, "#draft-retry-group")).toBe(false);
    },
    UI_TIMEOUT,
  );

  test(
    "akou-5v8: the language chip decodes the reading again in the next language, and is a plain label otherwise",
    async () => {
      const p = v.page;
      v.requests.length = 0;
      await v.send("open", draft({ id: "l1", languageSwitch: true }));
      expect(await p.$eval("#draft-lang", (e) => e.tagName)).toBe("BUTTON");
      expect(await p.getAttribute("#draft-lang", "aria-label")).toBe("Switch language, now ES");
      expect(await p.getAttribute("#draft-lang", "data-forced")).toBeNull();
      await p.click("#draft-lang");
      expect(v.requests).toEqual([{ name: "language", params: { id: "l1" } }]);
      // One decode at a time: the chip waits for the new reading.
      expect(await p.isDisabled("#draft-lang")).toBe(true);
      await v.send(
        "open",
        draft({
          id: "l1",
          text: "Tell the team",
          words: [],
          language: "en",
          languageSwitch: true,
          languageForced: true,
          focus: false,
        }),
      );
      expect(await value(p)).toBe("Tell the team");
      expect(await text(p, "#draft-lang")).toBe("EN");
      expect(await p.getAttribute("#draft-lang", "data-forced")).toBe("");
      expect(await p.isDisabled("#draft-lang")).toBe(false);
      // Positive control: without the switch the chip is a label, and a click asks for nothing.
      await v.send("open", draft({ id: "l2" }));
      expect(await p.$eval("#draft-lang", (e) => e.tagName)).toBe("SPAN");
      await p.click("#draft-lang");
      expect(v.requests).toHaveLength(1);

      // A switch that brings no new reading (no audio kept, nothing heard) frees the chip again.
      const refused = await viewPage("draft", {
        answer: (name) => (name === "language" ? false : undefined),
      });
      try {
        await refused.send("open", draft({ id: "l3", languageSwitch: true }));
        await refused.page.click("#draft-lang");
        await refused.page.waitForFunction(
          () => !(document.getElementById("draft-lang") as HTMLButtonElement).disabled,
        );
        expect(refused.requests).toEqual([{ name: "language", params: { id: "l3" } }]);
      } finally {
        await refused.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "akou-5v8: the switchable chip looks clickable, and its hover is a fill, never the chosen ring",
    async () => {
      const p = v.page;
      const look = () =>
        p.$eval("#draft-lang", (e) => {
          const c = getComputedStyle(e);
          return { cursor: c.cursor, fill: c.backgroundColor, ring: c.boxShadow };
        });
      // The last test clicked the chip: the pointer leaves it first.
      await p.mouse.move(0, 0);
      await v.send("open", draft({ id: "l4", languageSwitch: true }));
      const rest = await look();
      expect(rest.cursor).toBe("pointer");
      await p.hover("#draft-lang");
      const hover = await look();
      expect(hover.fill).not.toBe(rest.fill);
      expect(hover.ring).toBe("none");
      // Positive control: the label is not clickable, and a chosen language wears the ring.
      await p.mouse.move(0, 0);
      await v.send("open", draft({ id: "l5" }));
      expect((await look()).cursor).not.toBe("pointer");
      await v.send("open", draft({ id: "l6", languageSwitch: true, languageForced: true }));
      expect((await look()).ring).not.toBe("none");
    },
    UI_TIMEOUT,
  );

  test(
    "DC-U9: a box a draft-send rule opened sends on Enter, and Insert still inserts alone",
    async () => {
      const p = v.page;
      v.requests.length = 0;
      await v.send("open", draft({ id: "r1", enterSends: true }));
      expect(await text(p, "#draft-send-key")).toBe("↵");
      await p.keyboard.press("Enter");
      await v.send("open", draft({ id: "r2", enterSends: true }));
      await p.click("#draft-insert");
      // Positive control: without the rule, Enter inserts and sends nothing.
      await v.send("open", draft({ id: "r3" }));
      expect(await text(p, "#draft-send-key")).toBe("Ctrl ↵");
      await p.keyboard.press("Enter");
      expect(v.requests).toEqual([
        { name: "insert", params: { id: "r1", text: draft().text, send: true } },
        { name: "insert", params: { id: "r2", text: draft().text, send: false } },
        { name: "insert", params: { id: "r3", text: draft().text, send: false } },
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
    "with the other readings and a chip of three, the buttons stay inside the window",
    async () => {
      const p = v.page;
      await p.setViewportSize(DRAFT_SIZE);
      try {
        await v.send("open", draft({ id: "d13", engines: ["best", "remote"] }));
        const at = draft().text.indexOf("cooper") + 2;
        await p.$eval(
          "#draft-text",
          (t, i) => (t as HTMLTextAreaElement).setSelectionRange(i, i),
          at,
        );
        await p.dispatchEvent("#draft-text", "click");
        await v.send("chip", {
          id: "d13",
          mode: "ask",
          candidates: [
            { term: "Kubernetes", heard: "cooper netties" },
            { term: "Vercel", heard: "versal" },
            { term: "Grafana", heard: "grafanna" },
          ],
        });
        expect(await visible(p, "#draft-alts")).toBe(true);
        expect(await visible(p, "#chip")).toBe(true);
        const h = await p.evaluate(() => innerHeight);
        for (const sel of ["#draft-foot", "#draft-send", "#draft-close"]) {
          const box = await p.$eval(sel, (e) => e.getBoundingClientRect().bottom);
          expect(box).toBeLessThanOrEqual(h);
        }
        // At the window's own size all of it shows, with nothing scrolled away.
        expect(await p.$eval("#draft-body", (e) => e.scrollHeight <= e.clientHeight)).toBe(true);
        // Past what the window holds, the middle scrolls and the buttons still stay.
        await p.setViewportSize({ width: DRAFT_SIZE.width, height: 360 });
        const foot = await p.$eval("#draft-foot", (e) => e.getBoundingClientRect().bottom);
        expect(foot).toBeLessThanOrEqual(360);
        await p.keyboard.press("Escape");
      } finally {
        await p.setViewportSize({ width: 1280, height: 720 });
      }
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

  test("words the other engine heard as one stretch are one mark, when any of them is unsure (akou-w51.81)", () => {
    const t = "tell the cooper netties team";
    const k = ["Kubernetes"];
    // `cooper` is sure and `netties` not: the stretch is one mark with one alternative.
    const m = lowMarks(t, [
      { w: "tell", c: 0.9 },
      { w: "the", c: 0.9 },
      { w: "cooper", c: 0.8, alt: k },
      { w: "netties", c: 0.3, alt: k },
      { w: "team", c: 0.9 },
    ]);
    expect(m).toEqual([{ start: 9, end: 23, alt: k }]);
    // Positive control: a stretch whose words are all sure has no mark.
    expect(
      lowMarks(t, [
        { w: "cooper", c: 0.8, alt: k },
        { w: "netties", c: 0.9, alt: k },
      ]),
    ).toEqual([]);
    // Two unsure words with no alternative stay two marks, as before.
    expect(
      lowMarks(t, [
        { w: "cooper", c: 0.2 },
        { w: "netties", c: 0.3 },
      ]).map((x) => [x.start, x.end]),
    ).toEqual([
      [9, 15],
      [16, 23],
    ]);
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

  const on = (key: string) => `#page-dictation [data-key='${key}']:not(div)`;
  /** A segment of a row's segmented choice, by its value. */
  const seg = (key: string, value: string) =>
    `#page-dictation div.pg-row[data-key='${key}'] label:has(input[data-value='${value}'])`;
  const advancedKeys = ADVANCED_PAGE.groups
    .flatMap((g) => g.keys)
    .filter((k) => !k.startsWith("#"));
  /** The keys drawn on a page under this one: Advanced, and History's two. */
  const elsewhere = [...advancedKeys, ...HISTORY_KEYS];

  test(
    "akou-5v8: the languages are chips with a list to add one, and each change saves the whole list",
    async () => {
      let fx: DictationFixture | null = null;
      const page = await rig.open(undefined, {
        before: async (p) => {
          fx = await dictationFixture(p);
          fx.settings["dictation.languages"] = ["en"];
        },
      });
      const f = fx as unknown as DictationFixture;
      await page.click("#dictation-open");
      await page.waitForSelector(
        "#page-dictation section[data-section='Voice'] #dictation-languages",
      );
      const chips = () =>
        page.$$eval("#dictation-languages .language-chip", (l) =>
          l.map((x) => (x as HTMLElement).dataset.code),
        );
      expect(await chips()).toEqual(["en"]);
      // The text box stays the saved value, out of sight.
      expect(await page.isHidden("#page-dictation textarea[data-key='dictation.languages']")).toBe(
        true,
      );
      await page.selectOption("#dictation-languages-add", "es");
      await until(() => f.patches.length === 1, 5000, "the added language saved");
      expect(f.patches).toEqual([{ "dictation.languages": ["en", "es"] }]);
      await page.click("#dictation-languages button[aria-label='Remove English']");
      await until(() => f.patches.length === 2, 5000, "the removed language saved");
      expect(f.patches[1]).toEqual({ "dictation.languages": ["es"] });
      expect(await chips()).toEqual(["es"]);
    },
    UI_TIMEOUT,
  );

  test(
    "shows every section and its Advanced page, saves one key per change, and shows a refusal in words",
    async () => {
      let fx: Awaited<ReturnType<typeof dictationFixture>> | null = null;
      const page = await rig.open(undefined, {
        before: async (p) => {
          fx = await dictationFixture(p);
        },
      });
      const f = fx as unknown as Awaited<ReturnType<typeof dictationFixture>>;
      await page.click("#dictation-open");
      await page.waitForSelector("#page-dictation section[data-section='Keys']", {
        state: "visible",
      });
      const sections = () =>
        page.$$eval("#page-dictation section.pg-section", (g) =>
          g.map((x) => x.getAttribute("data-section")),
        );
      expect(await sections()).toEqual(DICTATION_GROUPS.map((g) => g.title));
      // Every fixture key is on the page or its Advanced page, and no key is named anywhere.
      const keys = () =>
        page.$$eval("#page-dictation [data-key]:not(div)", (e) =>
          e.map((x) => (x as HTMLElement).dataset.key as string),
        );
      const main = await keys();
      expect(main.sort()).toEqual(
        Object.keys(DICTATION_SCHEMA)
          .filter((k) => !elsewhere.includes(k))
          .sort(),
      );
      const words = (await page.textContent("#page-dictation")) ?? "";
      expect(Object.keys(DICTATION_SCHEMA).filter((k) => words.includes(k))).toEqual([]);

      await page.check(on("dictation.enabled"));
      await until(() => f.patches.length === 1, 5000, "the switch saved");
      await page.click(seg("dictation.activation", "toggle"));
      await until(() => f.patches.length === 2, 5000, "the activation saved");
      expect(f.patches).toEqual([
        { "dictation.enabled": true },
        { "dictation.activation": "toggle" },
      ]);

      // The other computer's rows show once "Use another computer" is on; with no address yet
      // the switch waits for one rather than save a value the registry refuses.
      expect(await page.isHidden(on("dictation.remote.key"))).toBe(true);
      await page.click("#dictation-remote-on");
      expect(await page.isVisible(on("dictation.remote.key"))).toBe(true);
      expect(f.patches).toHaveLength(2);
      // Once saved, the page keeps no copy of a secret.
      const remoteKey = on("dictation.remote.key");
      await page.fill(remoteKey, "k-123");
      await page.press(remoteKey, "Tab");
      await until(() => f.patches.length === 3, 5000, "the key saved");
      expect(f.patches.at(-1)).toEqual({ "dictation.remote.key": "k-123" });
      await page.waitForFunction(
        (sel) => (document.querySelector(sel) as HTMLInputElement).value === "",
        remoteKey,
      );
      expect(await page.getAttribute(remoteKey, "placeholder")).toBe("Set, type to replace");
      // The remote's address is shown in a browser and cannot be changed from it.
      expect(await page.isDisabled(on("dictation.remote.url"))).toBe(true);

      await page.click("#dictation-advanced");
      await page.waitForSelector("#page-dictation .pg-back");
      expect(await sections()).toEqual(ADVANCED_PAGE.groups.map((g) => g.title));
      expect((await keys()).sort()).toEqual(
        advancedKeys.filter((k) => k in DICTATION_SCHEMA).sort(),
      );
      f.refuse.set("dictation.maxMinutes", "must be at most 60");
      await page.fill(on("dictation.maxMinutes"), "90");
      await page.press(on("dictation.maxMinutes"), "Tab");
      await page.waitForSelector(
        "#page-dictation div.pg-row.refused[data-key='dictation.maxMinutes']",
      );
      expect(await text(page, "#page-dictation div.pg-row.refused .issue")).toBe(
        "Must be at most 60",
      );
      expect(f.patches.at(-1)).toEqual({ "dictation.maxMinutes": 90 });
      // Off or On is a switch, saved in the setting's own words.
      expect(await page.getAttribute("#set-dictation-glossary", "role")).toBe("switch");
      const before = f.patches.length;
      await page.click("#set-dictation-glossary");
      await until(() => f.patches.length === before + 1, 5000, "the switch saved");
      expect(f.patches.at(-1)).toEqual({ "dictation.glossary": "on" });

      // The back link leads to the page, with the keyboard on the row it came through.
      await page.click("#page-dictation .pg-back");
      await page.waitForSelector("#page-dictation section[data-section='Keys']");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("dictation-advanced");

      // History holds how long dictations and their audio are kept, and Delete all.
      await page.click("#dictation-history-open");
      await page.waitForSelector("#page-dictation #dictation-history-q");
      expect(await text(page, "#page-dictation h1")).toBe("History");
      expect((await keys()).sort()).toEqual([...HISTORY_KEYS].sort());
      expect(await page.getAttribute("#set-dictation-keepAudio", "role")).toBe("switch");
      // Delete all asks once more before it acts.
      expect(await text(page, "#dictations-delete")).toBe("Delete all dictations…");
      await page.click("#dictations-delete");
      expect(f.deletes).toBe(0);
      // The first press arms it, and it looks like the press that deletes.
      expect(await page.getAttribute("#dictations-delete", "class")).toContain("armed");
      await page.click("#dictations-delete");
      await until(() => f.deletes === 1, 5000, "the delete");
      expect(await page.getAttribute("#dictations-delete", "class")).not.toContain("armed");
      // A value typed and left by the back link is saved once, and the row that led here says it.
      const kept = f.patches.length;
      await page.fill(on("dictation.retainDays"), "7");
      await page.click("#page-dictation .pg-back");
      await page.waitForSelector("#page-dictation section[data-section='Keys']");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("dictation-history-open");
      expect(await text(page, "#dictation-history-open .pg-value")).toBe("Kept 7 days");
      await new Promise((r) => setTimeout(r, 300));
      expect(f.patches.slice(kept)).toEqual([{ "dictation.retainDays": 7 }]);
    },
    UI_TIMEOUT,
  );

  test(
    "on the real registry: every section, every dictation key, and a change saved as that key alone",
    async () => {
      // No fixture: the keys, the values and the save are the app's own.
      const page = await rig.open();
      const patches: unknown[] = [];
      page.on("request", (r) => {
        if (r.method() === "PATCH" && r.url().endsWith("/config")) patches.push(r.postDataJSON());
      });
      await page.click("#dictation-open");
      await page.waitForSelector("#page-dictation section[data-section='Keys']", {
        state: "visible",
      });
      const keys = async () =>
        page.$$eval("#page-dictation [data-key]:not(div)", (e) =>
          e.map((x) => (x as HTMLElement).dataset.key as string),
        );
      const main = await keys();
      await page.click("#dictation-advanced");
      await page.waitForSelector("#page-dictation .pg-back");
      // The tidy's wait shows its default by name, never a bare 0.
      expect(await text(page, `${on("dictation.formatTimeoutSeconds")} option:checked`)).toBe(
        "Automatic",
      );
      const advanced = await keys();
      await page.click("#page-dictation .pg-back");
      await page.click("#dictation-history-open");
      await page.waitForSelector("#page-dictation #dictation-history-q");
      const all = [...main, ...advanced, ...(await keys())];
      // Settings hides every dictation key, so each must be here, and the page names none the
      // registry lacks.
      const registry = Object.keys(SETTINGS).filter((k) => k.startsWith("dictation."));
      expect(registry.filter((k) => !all.includes(k))).toEqual([]);
      expect(all.sort()).toEqual(
        dictationKeys()
          .filter((k) => k in SETTINGS)
          .sort(),
      );
      expect(dictationKeys().filter((k) => !(k in SETTINGS))).toEqual([]);
      // Every key it shows has its words: no label is a key's last part spelled out.
      expect(dictationKeys().filter((k) => !WORDS[k])).toEqual([]);

      const days = on("dictation.retainDays");
      await page.fill(days, "45");
      await page.press(days, "Tab");
      await page.waitForFunction(() => document.getElementById("toast")?.textContent === "Saved.");
      expect(patches).toEqual([{ "dictation.retainDays": 45 }]);
      const cfg = await rig.api("GET", "/config");
      expect(cfg.body.settings["dictation.retainDays"]).toBe(45);
    },
    UI_TIMEOUT,
  );

  test(
    "the Settings page leaves the dictation keys out; the sidebar and #dictation open the page, Calls leaves it",
    async () => {
      const page = await rig.open(undefined, { before: (p) => dictationFixture(p) });
      await page.click("#settings-open");
      await page.waitForSelector("#page-settings .pg-row[data-key]");
      const flat = await page.$$eval("#page-settings [data-key]:not(.pg-row)", (e) =>
        e.map((x) => (x as HTMLElement).dataset.key as string),
      );
      expect(flat.length).toBeGreaterThan(5);
      expect(flat.filter((k) => k.startsWith("dictation.") || k === "asr.qwenIdleMinutes")).toEqual(
        [],
      );
      await page.click("#dictation-open");
      await page.waitForSelector("#page-dictation:not([hidden]) .pg-row[data-key]");
      // A page, not a dialog: the sidebar marks it and the call workspace makes way.
      expect(await page.$("dialog#dictation")).toBeNull();
      expect(await page.getAttribute("#dictation-open", "aria-current")).toBe("page");
      expect(await page.isHidden("#page-settings")).toBe(true);
      await page.click("#calls-open");
      expect(await page.isHidden("#page-dictation")).toBe(true);
      expect(await page.getAttribute("#dictation-open", "aria-current")).toBeNull();

      // The address opens the page, as a link to it would.
      await page.evaluate(() => {
        location.hash = "#dictation";
      });
      await page.waitForSelector("#page-dictation:not([hidden]) section[data-section='Keys']");
    },
    UI_TIMEOUT,
  );

  test(
    "with no dictation keys in the registry the page says so and Settings has no link",
    async () => {
      // An app whose registry has no dictation keys: the real one's, with them taken out.
      const page = await rig.open(undefined, {
        before: (p) =>
          p.route(
            (u) => u.pathname === "/api/v1/config",
            async (route) => {
              if (route.request().method() !== "GET") return route.continue();
              const res = await route.fetch();
              const real = (await res.json()) as Record<string, Record<string, unknown>>;
              const keep = (o: Record<string, unknown> = {}) =>
                Object.fromEntries(Object.entries(o).filter(([k]) => !onDictationPage(k)));
              return route.fulfill({
                response: res,
                json: { ...real, schema: keep(real.schema), settings: keep(real.settings) },
              });
            },
          ),
      });
      await page.click("#dictation-open");
      await page.waitForSelector("#page-dictation [data-empty]");
      expect(await page.$$("#page-dictation [data-key]")).toEqual([]);
      await page.click("#settings-open");
      await page.waitForSelector("#page-settings .pg-row[data-key]");
      expect(await page.$("#page-settings [data-key^='dictation.']")).toBeNull();
    },
    UI_TIMEOUT,
  );

  test(
    "a settings read that fails says why where the settings go, not that there are none",
    async () => {
      const page = await rig.open(undefined, {
        before: (p) =>
          p.route(
            (u) => u.pathname === "/api/v1/config",
            (route) =>
              route.request().method() === "GET"
                ? route.fulfill({ status: 500, json: { error: "internal", message: "disk gone" } })
                : route.continue(),
          ),
      });
      await page.click("#dictation-open");
      await page.waitForSelector("#page-dictation [data-empty]");
      expect(await text(page, "#page-dictation [data-empty]")).toBe(
        "The dictation settings could not be read: disk gone",
      );
    },
    UI_TIMEOUT,
  );

  test(
    "a settings read that throws (akou out of reach) says so where the settings go, never stays on Reading",
    async () => {
      const page = await rig.open();
      // The window is up; only the dictation page's read fails, as when akou goes away.
      await page.route(
        (u) => u.pathname === "/api/v1/config",
        (route) => (route.request().method() === "GET" ? route.abort() : route.continue()),
      );
      await page.click("#dictation-open");
      await page.waitForSelector("#page-dictation [data-empty]", { timeout: 5000 });
      expect(await text(page, "#page-dictation [data-empty]")).toStartWith(
        "The dictation settings could not be read: akou is out of reach",
      );
      expect(await page.$("#page-dictation .pg-reading")).toBeNull();
    },
    UI_TIMEOUT,
  );

  test(
    "a save that throws on the way back says why, and the back link still leads to the page",
    async () => {
      let fx: DictationFixture | null = null;
      const page = await rig.open(undefined, {
        before: async (p) => {
          fx = await dictationFixture(p);
        },
      });
      const f = fx as unknown as DictationFixture;
      await page.click("#dictation-open");
      await page.click("#dictation-history-open");
      await page.waitForSelector("#page-dictation #dictation-history-q");
      await page.route(
        (u) => u.pathname === "/api/v1/config",
        (r) => (r.request().method() === "PATCH" ? r.abort() : r.fallback()),
      );
      const kept = f.patches.length;
      await page.fill("#page-dictation [data-key='dictation.retainDays']:not(div)", "7");
      await page.click("#page-dictation .pg-back");
      await page.waitForSelector("#page-dictation section[data-section='Keys']", { timeout: 5000 });
      await page.waitForSelector("#toast:not([hidden])");
      expect(await text(page, "#toast")).toContain("was not saved: akou is out of reach");
      expect(f.patches.slice(kept)).toEqual([]);
    },
    UI_TIMEOUT,
  );

  test(
    "[DC-E7] the engine section: the words while you speak, and the text inserted, in plain words",
    async () => {
      // No streaming model: the default, live, inserts through Parakeet, and the page says so.
      const w = await windowPage(rig, { platform: "darwin", final: "parakeet" });
      try {
        const p = w.page;
        await p.click("#dictation-open");
        await p.waitForSelector("#dictation-live-words");
        // No streaming model: Parakeet names the words, and Get leads to Models.
        expect(await text(p, "#dictation-live-model")).toBe("Parakeet, refreshed twice a second");
        const choices = () =>
          p.$$eval("#page-dictation label.pg-choice[data-final]", (l) =>
            l.map((x) => ({
              value: (x as HTMLElement).dataset.final,
              name: x.querySelector(".pg-name")?.textContent,
              checked: (x.querySelector("input") as HTMLInputElement).checked,
              help: x.querySelector(".pg-help")?.textContent ?? "",
            })),
          );
        const got = await choices();
        expect(got.map((c) => [c.value, c.name, c.checked])).toEqual([
          ["live", "Same as the live words (default)", false],
          ["parakeet", "Parakeet", true],
          ["qwen", "Qwen3-ASR", false],
        ]);
        for (const c of got) expect(c.help.length).toBeGreaterThan(10);
        // No config key, model id or setting value is visible text.
        const words = (await p.textContent("#page-dictation section[data-section='Engine']")) ?? "";
        expect(words).not.toMatch(/dictation\.|nemotron-|parakeet-tdt|\bfinal\b|\bauto\b/);
        // A pick saves the text inserted with the engine that runs it, so the two never disagree.
        await p.click("#page-dictation label.pg-choice[data-final='live']");
        await until(() => w.patches.length === 1, 5000, "the pick saved");
        expect(w.patches).toEqual([{ "dictation.final": "live", "dictation.engine": "auto" }]);
        await p.click("#page-dictation label.pg-choice[data-final='qwen']");
        await until(() => w.patches.length === 2, 5000, "the second pick saved");
        expect(w.patches.at(-1)).toEqual({ "dictation.final": "qwen", "dictation.engine": "best" });
        await p.click("#dictation-live-get");
        await p.waitForSelector("#page-models", { state: "visible" });
      } finally {
        await w.close();
      }
      // A streaming model on disk names the words, and the choice checked is what runs now.
      const m = await windowPage(rig, {
        platform: "darwin",
        live: "nemotron-3.5-560",
        final: "live",
      });
      try {
        const p = m.page;
        await p.click("#dictation-open");
        await p.waitForSelector("#dictation-live-words");
        expect(await text(p, "#dictation-live-model")).toBe("Nemotron streaming, many languages");
        expect(await p.$("#dictation-live-get")).toBeNull();
        expect(await p.isChecked("#page-dictation label.pg-choice[data-final='live'] input")).toBe(
          true,
        );
      } finally {
        await m.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "in the window: another computer waits for its address, then turns on; off, the engine is local again; the AI tidy shows its instructions",
    async () => {
      const w = await windowPage(rig, {
        platform: "darwin",
        settings: { "dictation.formatPrompt": "default" },
      });
      try {
        const p = w.page;
        await p.click("#dictation-open");
        await p.waitForSelector("#dictation-remote-on");
        const url = on("dictation.remote.url");
        expect(await p.isHidden(url)).toBe(true);
        // No address yet: the rows show, the address has the keyboard, and nothing is saved,
        // since the registry refuses the remote engine without one.
        await p.click("#dictation-remote-on");
        expect(await p.isVisible(url)).toBe(true);
        expect(await p.evaluate(() => document.activeElement?.getAttribute("data-key"))).toBe(
          "dictation.remote.url",
        );
        expect(w.patches).toEqual([]);
        // The window may write the address; saved, it turns the remote on.
        await p.fill(url, "https://studio.example");
        await p.press(url, "Tab");
        await until(() => w.patches.length === 2, 5000, "the address, then the engine");
        expect(w.patches).toEqual([
          { "dictation.remote.url": "https://studio.example" },
          { "dictation.engine": "remote" },
        ]);
        // While it is on, the choice of the text inserted rests, and says why.
        await p.waitForFunction(() => {
          const radios = [
            ...document.querySelectorAll<HTMLInputElement>(
              "#page-dictation label.pg-choice[data-final] input.pg-radio",
            ),
          ];
          return radios.length === 3 && radios.every((r) => r.disabled);
        });
        expect(
          await text(p, "#page-dictation div.pg-row[data-key='dictation.final'] .pg-help"),
        ).toBe("The other computer turns your voice into text while it is on.");
        expect(await p.isChecked("#dictation-remote-on")).toBe(true);
        // Off: the engine is the local choice again, and the rows go.
        await p.click("#dictation-remote-on");
        await until(() => w.patches.length === 3, 5000, "the engine back");
        expect(w.patches.at(-1)).toEqual({ "dictation.engine": "auto" });
        await p.waitForSelector(url, { state: "hidden" });

        // Tidy the text with AI: its instructions show once it is on, Standard by default.
        const prompt = "#page-dictation div.pg-row[data-key='dictation.formatPrompt']";
        expect(await p.isHidden(prompt)).toBe(true);
        await p.selectOption(on("dictation.format"), "provider");
        await until(() => w.patches.length === 4, 5000, "the tidy saved");
        expect(w.patches.at(-1)).toEqual({ "dictation.format": "provider" });
        expect(await p.isVisible(prompt)).toBe(true);
        expect(await text(p, `${prompt} option:checked`)).toBe("Standard");
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "on the macOS window: the keys as keycaps, Set for a key with none, and the header under the title bar",
    async () => {
      const w = await windowPage(rig, {
        platform: "darwin",
        // Saved as its default, as a setup leaves it.
        settings: { "dictation.hotkey": "RightCommand" },
      });
      try {
        const p = w.page;
        await p.click("#dictation-open");
        await p.waitForSelector("#page-dictation div.pg-row[data-key='dictation.hotkey']");
        const caps = (key: string) =>
          p.$$eval(`#page-dictation div.pg-row[data-key='${key}'] .keycaps > *`, (l) =>
            l.map((x) => x.textContent),
          );
        // The key shows as keycaps; fix last's default is Shift before it, with its side.
        expect(await caps("dictation.hotkey")).toEqual(["Right ⌘"]);
        expect(await caps("dictation.hotkeyFixLast")).toEqual(["⇧", "Right ⌘"]);
        expect(await caps("dictation.hotkeyDraft")).toEqual(["Not set"]);
        expect(
          await text(p, "#page-dictation div.pg-row[data-key='dictation.hotkeyDraft'] .record-key"),
        ).toBe("Set");
        expect(
          await text(p, "#page-dictation div.pg-row[data-key='dictation.hotkey'] .record-key"),
        ).toBe("Change");
        // The default needs no way back to itself.
        expect(await p.isHidden("#page-dictation .key-reset[data-for='dictation.hotkey']")).toBe(
          true,
        );

        // DK-M7: under the macOS window's title bar the header starts below the strip and drags.
        await p.evaluate(() => document.body.classList.add("inset"));
        await p.evaluate(() => document.body.style.setProperty("--titlebar", "28px"));
        const top = await p.$eval("#page-dictation .pg-head", (e) => e.getBoundingClientRect().top);
        expect(top).toBeGreaterThanOrEqual(28);
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );
});

describe("DC-U5: words and replacements, as the page lists them", () => {
  test("a replacement writes more than letters for a way of saying it; anything else is a word", () => {
    const listed = (term: string, heard: string[] = []) =>
      isReplacement({ term, heard }) ? "replacement" : "word";
    expect(listed(".com", ["dot com"])).toBe("replacement");
    expect(listed("@", ["at sign"])).toBe("replacement");
    expect(listed("jordan@example.com", ["my email"])).toBe("replacement");
    expect(listed("Kubernetes", ["cooper netties"])).toBe("word");
    expect(listed("Wi-Fi", ["why fi"])).toBe("word");
    expect(listed("O’Brien", ["o brian"])).toBe("word");
    // Nothing to say it as: a word, whatever it holds.
    expect(listed("C++")).toBe("word");
  });
});

describe("DC-U5: the dictionary and replacements", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-vocab-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  /** Opens the Words page from the Dictation page; with `entries`, over the vocabulary fixture. */
  const openDictionary = async (entries?: DictionaryEntry[]) => {
    let fx: VocabFixture | null = null;
    const page = await rig.open(undefined, {
      before: async (p) => {
        if (entries) fx = await vocabFixture(p, entries);
      },
    });
    await page.click("#dictation-open");
    await page.click("#dictation-dictionary-open");
    await page.waitForSelector("#page-dictation #dictionary-list :is(li[data-term], [data-empty])");
    return { page, fx: fx as unknown as VocabFixture };
  };
  const row = (term: string) => `#dictionary-list li[data-term='${term}']`;
  /** Opens a row to its switch and Remove. */
  const openRow = async (page: Page, term: string) => {
    await page.click(`${row(term)} .pg-link`);
    await page.waitForSelector(`${row(term)} .calls-too`);
  };
  /** "Replace something I say": the form takes what you say too. */
  const replacing = async (page: Page) => {
    if (await page.isHidden("#dictionary-heard")) await page.click("#dictionary-replace");
  };
  const global = (e: Partial<DictionaryEntry> & { term: string }): DictionaryEntry => ({
    heard: [],
    confirmed: true,
    scope: "global",
    file: VOCAB_FILE,
    ...e,
  });

  test(
    "a replacement is written for dictation only, shown as what you say to what akou writes, and removed in one click",
    async () => {
      const { page, fx } = await openDictionary([]);
      expect(await text(page, "#dictionary-list [data-empty]")).toBe(
        "No words yet. Add one above, or import a list.",
      );
      // The form adds a word; "Replace something I say" shows what you say beside it.
      expect(await page.isHidden("#dictionary-heard")).toBe(true);
      expect(await page.getAttribute("#dictionary-term", "placeholder")).toBe("Add a word");
      await page.click("#dictionary-replace");
      expect(await page.getAttribute("#dictionary-heard", "placeholder")).toBe(
        "You say (commas for several)",
      );
      expect(await page.getAttribute("#dictionary-term", "placeholder")).toBe("akou writes");
      await page.fill("#dictionary-heard", "dot com");
      await page.fill("#dictionary-term", ".com");
      await page.press("#dictionary-term", "Enter");
      await page.waitForSelector(row(".com"));
      expect(fx.calls).toEqual([
        {
          method: "POST",
          path: "/vocab",
          body: { term: ".com", heard: ["dot com"], scope: "dictation" },
        },
      ]);
      expect(await text(page, `${row(".com")} .heard`)).toBe("dot com");
      expect(await text(page, `${row(".com")} .term`)).toBe(".com");
      // Dictation only: nothing on its right says Calls too, and it is listed as a replacement.
      expect(await page.$(`${row(".com")} .where`)).toBeNull();
      expect(
        await page.locator("section[data-section='Replacements'] li[data-term='.com']").count(),
      ).toBe(1);
      expect(await page.inputValue("#dictionary-term")).toBe("");

      // A word alone, with no way of saying it.
      await page.click("#dictionary-replace");
      expect(await page.isHidden("#dictionary-heard")).toBe(true);
      await page.fill("#dictionary-term", "Kubernetes");
      await page.click("#dictionary-add");
      await page.waitForSelector(row("Kubernetes"));
      expect(fx.calls.at(-1)?.body).toEqual({ term: "Kubernetes", heard: [], scope: "dictation" });
      expect(await page.$(`${row("Kubernetes")} .heard`)).toBeNull();
      expect(
        await page.locator("section[data-section='Words'] li[data-term='Kubernetes']").count(),
      ).toBe(1);

      fx.calls.length = 0;
      await openRow(page, ".com");
      await page.click(`${row(".com")} button.remove`);
      await page.waitForSelector(row(".com"), { state: "detached" });
      expect(fx.calls).toEqual([{ method: "DELETE", path: "/vocab/.com" }]);
    },
    UI_TIMEOUT,
  );

  test(
    "more forms keep a term's spelling, forms and scope; Use in calls too switches the scope both ways; another file's word is read only; a refusal shows",
    async () => {
      const { page, fx } = await openDictionary([
        global({ term: "Vercel", heard: ["versal"] }),
        global({ term: "Kubernetes", heard: ["cooper netties"], entryScope: "dictation" }),
        { term: "Acme", heard: [], confirmed: false, scope: "extra", file: "/team/words.yaml" },
      ]);
      expect(await text(page, `${row("Vercel")} .where`)).toBe(
        "also heard as “versal” · Calls too",
      );
      expect(await text(page, `${row("Kubernetes")} .where`)).toBe(
        "also heard as “cooper netties”",
      );
      // Another list's word: read only, under its own heading, and no file path anywhere.
      expect(await text(page, `${row("Acme")} .where`)).toBe("Not confirmed yet");
      expect(
        await page
          .locator("section[data-section='From your other word lists'] li[data-term='Acme']")
          .count(),
      ).toBe(1);
      expect(await page.$$(`${row("Acme")} button`)).toHaveLength(0);
      expect(await text(page, "#page-dictation")).not.toContain("/team/words.yaml");
      await openRow(page, "Vercel");
      expect(await page.isChecked(`${row("Vercel")} .calls-too`)).toBe(true);
      expect(await text(page, `${row("Vercel")} .pg-help`)).toBe("Also heard as “versal”.");

      // A calls entry stays one: no scope is added to it, and its first form is kept.
      await replacing(page);
      await page.fill("#dictionary-heard", "for sell, Versal");
      await page.fill("#dictionary-term", "vercel");
      await page.click("#dictionary-add");
      await until(() => fx.calls.length === 1, 5000, "the save");
      expect(fx.calls[0]?.body).toEqual({
        term: "Vercel",
        heard: ["versal", "for sell"],
        confirmed: true,
      });

      await openRow(page, "Kubernetes");
      expect(await page.isChecked(`${row("Kubernetes")} .calls-too`)).toBe(false);
      await page.click(`${row("Kubernetes")} .calls-too`);
      await until(() => fx.calls.length === 2, 5000, "calls too");
      expect(fx.calls[1]?.body).toEqual({
        term: "Kubernetes",
        heard: ["cooper netties"],
        confirmed: true,
      });
      await page.waitForFunction(
        (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked === true,
        `${row("Kubernetes")} .calls-too`,
      );
      // And back: off, dictation alone reads it again.
      await page.click(`${row("Kubernetes")} .calls-too`);
      await until(() => fx.calls.length === 3, 5000, "dictation only again");
      expect(fx.calls[2]?.body).toEqual({
        term: "Kubernetes",
        heard: ["cooper netties"],
        confirmed: true,
        scope: "dictation",
      });
      await page.waitForFunction(
        (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked === false,
        `${row("Kubernetes")} .calls-too`,
      );

      fx.refuse = "a term needs at least one letter or digit";
      await page.fill("#dictionary-heard", "at sign");
      await page.fill("#dictionary-term", "@");
      await page.click("#dictionary-add");
      await page.waitForSelector("#dictionary-issue", { state: "visible" });
      expect(await text(page, "#dictionary-issue")).toBe(
        "a term needs at least one letter or digit",
      );
      // The typed words stay, to fix.
      expect(await page.inputValue("#dictionary-term")).toBe("@");
      await page.fill("#dictionary-term", "at");
      await page.click("#dictionary-add");
      await page.waitForSelector("#dictionary-issue", { state: "hidden" });
    },
    UI_TIMEOUT,
  );

  test(
    "a word heard many ways stays inside its panel; a refused switch says why and shows the file; the keyboard keeps its place",
    async () => {
      const forms = [
        "cooper netties",
        "kube er netes",
        "kubernetees",
        "coober netties",
        "cube our nettles",
      ];
      const { page, fx } = await openDictionary([
        global({ term: "Kubernetes", heard: forms, entryScope: "dictation" }),
        global({ term: "Vercel", heard: ["versal"] }),
        global({ term: "Postgres" }),
        global({
          term: "Grafana",
          heard: [
            "graph on a dashboard for the whole platform team",
            "graffiti on the wall of the old office building",
          ],
        }),
      ]);
      await page.setViewportSize({ width: 1024, height: 700 });
      // Two forms and how many more; the open row lists them all.
      expect(await text(page, `${row("Kubernetes")} .where`)).toBe(
        "also heard as “cooper netties”, “kube er netes” and 3 more",
      );
      // The forms beside a word end inside its row, with the chevron on screen, however long.
      const fits = (term: string) =>
        page.$eval(row(term), (li) => {
          const r = li.getBoundingClientRect();
          const v = li.querySelector(".where")?.getBoundingClientRect();
          const c = li.querySelector(".pg-more")?.getBoundingClientRect();
          return !!v && !!c && v.right <= r.right && c.right <= r.right && v.left >= r.left;
        });
      expect(await fits("Kubernetes")).toBe(true);
      expect(await fits("Grafana")).toBe(true);
      await openRow(page, "Kubernetes");
      expect(await text(page, `${row("Kubernetes")} .pg-help`)).toBe(
        `Also heard as ${forms.map((f) => `“${f}”`).join(", ")}.`,
      );

      // A refused switch: said at once, and the switch shows what the file still holds.
      fx.refuse = "the vocabulary file could not be written";
      await page.click(`${row("Kubernetes")} .calls-too`);
      await page.waitForFunction(
        () =>
          document.getElementById("toast")?.textContent ===
          "the vocabulary file could not be written",
      );
      expect(await page.getAttribute("#toast", "class")).toBe("error");
      expect(await page.isChecked(`${row("Kubernetes")} .calls-too`)).toBe(false);
      expect(await page.isHidden("#dictionary-issue")).toBe(true);

      // The keyboard on Remove: the entry goes, and the keyboard is on the row now in its place.
      await page.focus(`${row("Kubernetes")} .remove`);
      await page.keyboard.press("Enter");
      await page.waitForSelector(row("Kubernetes"), { state: "detached" });
      await page.waitForFunction(
        () => document.activeElement?.closest("li")?.getAttribute("data-term") === "Vercel",
      );
      // The switch of a row kept is focused again after its save.
      await openRow(page, "Vercel");
      await page.focus(`${row("Vercel")} .calls-too`);
      await page.keyboard.press("Space");
      await until(() => fx.calls.length === 3, 5000, "calls too off");
      await page.waitForFunction(
        (sel) =>
          (document.querySelector(sel) as HTMLInputElement | null)?.checked === false &&
          document.activeElement === document.querySelector(sel),
        `${row("Vercel")} .calls-too`,
      );
    },
    UI_TIMEOUT,
  );

  test(
    "more forms and Use in calls too keep the entry's note, decode: false and unconfirmed state",
    async () => {
      const { page, fx } = await openDictionary([
        global({
          term: "Vercel",
          heard: ["versal"],
          confirmed: false,
          note: "the hosting company",
          decode: false,
          entryScope: "dictation",
        }),
      ]);
      await replacing(page);
      await page.fill("#dictionary-heard", "for sell");
      await page.fill("#dictionary-term", "vercel");
      await page.click("#dictionary-add");
      await until(() => fx.calls.length === 1, 5000, "the save");
      expect(fx.calls[0]?.body).toEqual({
        term: "Vercel",
        heard: ["versal", "for sell"],
        confirmed: false,
        note: "the hosting company",
        decode: false,
        scope: "dictation",
      });
      await openRow(page, "Vercel");
      await page.click(`${row("Vercel")} .calls-too`);
      await until(() => fx.calls.length === 2, 5000, "calls too");
      // The row opened stays open over the list read again, with the switch on.
      await page.waitForFunction(
        (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked === true,
        `${row("Vercel")} .calls-too`,
      );
      await page.click(`${row("Vercel")} .pg-link`);
      await page.waitForFunction(
        (sel) =>
          document.querySelector(sel)?.textContent ===
          "also heard as “versal”, “for sell” · Calls too · Not confirmed yet",
        `${row("Vercel")} .where`,
      );
      const kept: DictionaryEntry = {
        term: "Vercel",
        heard: ["versal", "for sell"],
        confirmed: false,
        scope: "global",
        file: VOCAB_FILE,
        decode: false,
        note: "the hosting company",
      };
      expect(fx.entries).toEqual([kept]);

      // Positive control: the fixture, like the route, wipes what a post leaves out.
      await page.evaluate(() =>
        fetch("/api/v1/vocab", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ term: "Vercel", heard: ["versal"] }),
        }),
      );
      expect(fx.entries).toEqual([
        { term: "Vercel", heard: ["versal"], confirmed: true, scope: "global", file: VOCAB_FILE },
      ]);
    },
    UI_TIMEOUT,
  );

  test(
    "the same term is the server's: Wi Fi is Wi-Fi and cafe is café, forms and all",
    async () => {
      const { page, fx } = await openDictionary([
        global({ term: "Wi-Fi", heard: ["why fi"], entryScope: "dictation" }),
        global({ term: "café", entryScope: "dictation" }),
      ]);
      await replacing(page);
      await page.fill("#dictionary-heard", "Why-Fi, wee fee");
      await page.fill("#dictionary-term", "Wi Fi");
      await page.click("#dictionary-add");
      await until(() => fx.calls.length === 1, 5000, "the save");
      expect(fx.calls[0]?.body).toEqual({
        term: "Wi-Fi",
        heard: ["why fi", "wee fee"],
        confirmed: true,
        scope: "dictation",
      });
      await page.waitForFunction(
        () => (document.getElementById("dictionary-term") as HTMLInputElement).value === "",
      );
      await page.fill("#dictionary-heard", "caff ay");
      await page.fill("#dictionary-term", "cafe");
      await page.click("#dictionary-add");
      await until(() => fx.calls.length === 2, 5000, "the second save");
      expect(fx.calls[1]?.body).toEqual({
        term: "café",
        heard: ["caff ay"],
        confirmed: true,
        scope: "dictation",
      });
      expect(fx.entries.map((e) => e.term)).toEqual(["Wi-Fi", "café"]);
    },
    UI_TIMEOUT,
  );

  test(
    "Settings opens the same Words page rather than a second list of words, and #dictation-dictionary does too",
    async () => {
      const page = await rig.open();
      await page.click("#settings-open");
      await page.waitForSelector("#page-settings .pg-row[data-key]");
      // Your words are under Word lists, one row that opens the Words page under Dictation.
      await page.click("#settings-go-words");
      await page.waitForSelector("#settings-dictionary");
      expect(await page.$$("#page-settings li, #page-settings table")).toHaveLength(0);
      await page.click("#settings-dictionary");
      await page.waitForSelector("#page-dictation:not([hidden]) #dictionary-form");
      expect(await page.$$("#dictionary-form")).toHaveLength(1);
      expect(await page.$$("dialog#dictation-dictionary")).toHaveLength(0);
      expect(await text(page, "#page-dictation h1")).toBe("Words and replacements");
      // The sidebar marks Dictation, the page it is under.
      expect(await page.getAttribute("#dictation-open", "aria-current")).toBe("page");
      // The old links to the dialogs open the pages.
      await page.click("#calls-open");
      await page.evaluate(() => {
        location.hash = "#dictation-dictionary";
      });
      await page.waitForSelector("#page-dictation:not([hidden]) #dictionary-form");
      await page.click("#calls-open");
      await page.evaluate(() => {
        location.hash = "#dictation-history";
      });
      await page.waitForSelector("#page-dictation:not([hidden]) #dictation-history-q");
      expect(await text(page, "#page-dictation h1")).toBe("History");
    },
    UI_TIMEOUT,
  );

  test(
    "a file of 200 lines imports 200 dictation words through the app's own route; a calls word stays one",
    async () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Term${String(i).padStart(3, "0")}`);
      // A word the file already holds for calls: importing it again must not take it from calls.
      expect((await rig.api("POST", "/vocab", { term: "Term000" })).status).toBe(201);
      const { page } = await openDictionary();
      await page.setInputFiles("#dictionary-import", {
        name: "words.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(lines.join("\n")),
      });
      await page.waitForFunction(
        () => document.getElementById("toast")?.textContent === "Imported 200 words.",
      );
      // The first few words, then one row that shows the rest.
      await page.waitForFunction(
        (n) => document.querySelectorAll("#dictionary-list li[data-term]").length === n,
        WORDS_SHOWN,
      );
      expect(await text(page, "section[data-section='Words'] .pg-count")).toBe("200");
      expect(await text(page, "section[data-section='Words'] .pg-rest")).toBe(
        `${200 - WORDS_SHOWN} more`,
      );
      await page.click("section[data-section='Words'] .pg-rest button");
      await page.waitForFunction(
        () => document.querySelectorAll("#dictionary-list li[data-term]").length === 200,
      );
      const r = await rig.api("GET", "/vocab");
      const got = r.body.entries as DictionaryEntry[];
      expect(got.map((e) => e.term)).toEqual(lines);
      expect(got.filter((e) => e.entryScope !== "dictation").map((e) => e.term)).toEqual([
        "Term000",
      ]);
      expect(await page.$(`${row("Term001")} .where`)).toBeNull();
      expect(await text(page, `${row("Term000")} .where`)).toBe("Calls too");
    },
    UI_TIMEOUT,
  );
});

describe("DC-U9: per-app rules on the Dictation page", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-apps-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  const rows = "#page-dictation section[data-section='Rules per app'] .apps-rules .apps-rule";
  const cell = (n: number, field: string) => `${rows}:nth-child(${n}) [data-field='${field}']`;
  const head = (n: number) => `${rows}:nth-child(${n}) .apps-head`;

  test(
    "a rule is saved once it names its app, every edit writes the whole list, a refusal shows beside it",
    async () => {
      let fx: DictationFixture | null = null;
      const page = await rig.open(undefined, {
        before: async (p) => {
          fx = await dictationFixture(p);
          // Keys in another order than the editor writes them, as a hand-edited file has them.
          fx.settings["dictation.apps"] = [
            { sendKey: "none", insert: "type", app: "com.example.term" },
          ];
        },
      });
      const f = fx as unknown as DictationFixture;
      await page.click("#dictation-open");
      await page.waitForSelector(rows);
      expect(await page.$$(rows)).toHaveLength(1);
      // The rule's row says it in words, and opens to its fields.
      expect(await text(page, `${rows}:nth-child(1) .apps-summary`)).toBe(
        "Types the keys, never sends",
      );
      expect(await page.isHidden(cell(1, "mode"))).toBe(true);
      await page.click(head(1));
      expect(await page.getAttribute(head(1), "aria-expanded")).toBe("true");
      expect(await page.inputValue(cell(1, "app"))).toBe("com.example.term");
      expect(await page.inputValue(cell(1, "insert"))).toBe("type");
      expect(await page.inputValue(cell(1, "sendKey"))).toBe("none");
      // A field the rule leaves out follows the global setting.
      expect(await page.inputValue(cell(1, "mode"))).toBe("");
      expect(await text(page, `${cell(1, "mode")} option:checked`)).toBe(APP_RULE_GLOBAL);

      // The open rule fits its panel: no field clipped, Remove reachable without scrolling sideways.
      const fit = await page.$eval("#pages", (d) => {
        const panel = d.querySelector(".pg-apps") as HTMLElement;
        const remove = d.querySelector(".apps-remove") as HTMLElement;
        const right = panel.getBoundingClientRect().right + 0.5;
        const spill = [...panel.querySelectorAll<HTMLElement>("[data-field]")].filter(
          (el) => el.getBoundingClientRect().right > right,
        );
        return {
          overflow: d.scrollWidth - d.clientWidth,
          removeInside: remove.getBoundingClientRect().right <= right,
          spill: spill.map((el) => el.dataset.field ?? el.className),
        };
      });
      expect(fit).toEqual({ overflow: 0, removeInside: true, spill: [] });

      // Picking the value a field already holds is no edit, whatever order the file has the keys in.
      await page.selectOption(cell(1, "insert"), "type");

      // A new row saves nothing until it names its app.
      await page.click("#page-dictation .apps-add");
      await page.selectOption(cell(2, "mode"), "draft-send");
      await page.fill(cell(2, "app"), "com.example.chat");
      await page.press(cell(2, "app"), "Tab");
      await until(() => f.patches.length === 1, 5000, "the new rule saved");
      expect(f.patches[0]).toEqual({
        "dictation.apps": [
          { app: "com.example.term", insert: "type", sendKey: "none" },
          { app: "com.example.chat", mode: "draft-send" },
        ],
      });

      // Removing a rule writes the list without it; back to global drops the field.
      await page.click(`${rows}:nth-child(1) .apps-remove`);
      await until(() => f.patches.length === 2, 5000, "the removal saved");
      expect(f.patches[1]).toEqual({
        "dictation.apps": [{ app: "com.example.chat", mode: "draft-send" }],
      });
      await page.selectOption(cell(1, "mode"), "");
      await until(() => f.patches.length === 3, 5000, "the field dropped");
      expect(f.patches[2]).toEqual({ "dictation.apps": [{ app: "com.example.chat" }] });

      // The registry's validator has the last word, shown beside the setting.
      f.refuse.set("dictation.apps", "rule 1: language must be auto or an ISO 639 code");
      await page.selectOption(cell(1, "language"), "en");
      await page.waitForSelector("#page-dictation div.pg-apps.refused[data-key='dictation.apps']");
      expect(
        await text(page, "#page-dictation div.pg-apps.refused[data-key='dictation.apps'] .issue"),
      ).toBe("Rule 1: language must be auto or an ISO 639 code");
      // The reason ends the panel, never inside a rule's header button.
      expect(
        await page.$eval(
          "#page-dictation div.pg-apps.refused[data-key='dictation.apps'] .issue",
          (el) => el.parentElement?.matches("div.pg-apps") && el.closest("button") === null,
        ),
      ).toBe(true);
      expect(f.patches).toHaveLength(4);
      expect(f.patches[3]).toEqual({
        "dictation.apps": [{ app: "com.example.chat", language: "en" }],
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Use the app I dictate into next adds a rule for the next dictation's app, never an earlier one or a clip",
    async () => {
      let fx: DictationFixture | null = null;
      const page = await rig.open(undefined, {
        before: async (p) => {
          fx = await dictationFixture(p);
          fx.settings[ENABLE_KEY] = true;
          fx.settings["dictation.apps"] = [{ app: "com.example.term" }];
          // A dictation before the button is pressed: not the one it waits for.
          fx.history = [dictationRow(1, { app: "com.example.old" })];
        },
      });
      const f = fx as unknown as DictationFixture;
      const base = dictationRow(0).at;
      const polls = () => f.calls.filter((c) => c.path.includes("since=")).length;
      const next = "#page-dictation .apps-next";
      const note = "#page-dictation .apps-next-note";
      await page.click("#dictation-open");
      await page.waitForSelector(rows);

      await page.click(next);
      expect(await text(page, note)).toBe(NEXT_APP_WAITING);
      expect(await text(page, next)).toBe("Cancel");
      // It asks after the newest dictation there was.
      await until(() => polls() >= 1, 5000, "the page asked for newer dictations");
      expect(f.calls.find((c) => c.path.includes("since="))?.path).toBe(
        `/dictations?since=${dictationRow(1).at + 1}&limit=500`,
      );
      expect(await page.$$(rows)).toHaveLength(1);

      // A clip sent to the API goes to no app, and an app the helper could not tell is empty.
      f.history.unshift(
        dictationRow(0, { id: "clip", at: base + 1000, app: null }),
        dictationRow(0, { id: "unknown", at: base + 2000, app: "" }),
      );
      const seen = polls();
      await until(() => polls() >= seen + 2, 5000, "two more reads");
      expect(await page.$$(rows)).toHaveLength(1);
      expect(f.patches).toHaveLength(0);

      f.history.unshift(dictationRow(0, { id: "chat", at: base + 3000, app: "com.example.chat" }));
      await until(() => f.patches.length === 1, 5000, "the rule saved");
      expect(f.patches[0]).toEqual({
        "dictation.apps": [{ app: "com.example.term" }, { app: "com.example.chat" }],
      });
      expect(await page.inputValue(cell(2, "app"))).toBe("com.example.chat");
      expect(await text(page, next)).toBe(NEXT_APP_LABEL);
      expect(await text(page, note)).toBe("Added com.example.chat.");
      // Its fields are next: the first one has the keyboard.
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-field"))).toBe(
        "mode",
      );
      // It stops asking once it has the app.
      const done = f.calls.length;
      await page.waitForTimeout(2500);
      expect(f.calls).toHaveLength(done);

      // An app with a rule already gets no second one.
      await page.click(next);
      f.history.unshift(dictationRow(0, { id: "term", at: base + 4000, app: "com.example.term" }));
      await page.waitForFunction(
        (sel) =>
          document.querySelector(sel)?.textContent === "com.example.term has a rule already.",
        note,
      );
      expect(await page.$$(rows)).toHaveLength(2);
      expect(f.patches).toHaveLength(1);

      // Cancel stops the wait: a dictation after it adds nothing.
      await page.click(next);
      await until(() => polls() >= 1, 5000, "waiting again");
      await page.click(next);
      expect(await text(page, next)).toBe(NEXT_APP_LABEL);
      expect(await text(page, note)).toBe("");
      const cancelled = f.calls.length;
      f.history.unshift(dictationRow(0, { id: "late", at: base + 5000, app: "com.example.late" }));
      await page.waitForTimeout(2500);
      expect(f.calls).toHaveLength(cancelled);
      expect(await page.$$(rows)).toHaveLength(2);

      // With dictation off no dictation comes: the page says so and asks for nothing.
      await page.click(`#page-dictation input[data-key='${ENABLE_KEY}']`);
      await until(() => f.patches.length === 2, 5000, "dictation turned off");
      const off = f.calls.length;
      await page.click(next);
      expect(await text(page, note)).toBe(
        "Turn dictation on first: the app comes from your next dictation.",
      );
      expect(await text(page, next)).toBe(NEXT_APP_LABEL);
      expect(f.calls).toHaveLength(off);
    },
    UI_TIMEOUT,
  );

  test(
    "a dictation log the page cannot read says why and stops waiting",
    async () => {
      let fx: DictationFixture | null = null;
      const page = await rig.open(undefined, {
        before: async (p) => {
          fx = await dictationFixture(p);
          fx.settings[ENABLE_KEY] = true;
          // An app older than the dictation routes answers 404 under /dictations.
          await p.route(
            (u) => u.pathname.endsWith("/dictations"),
            (route) =>
              route.fulfill({
                status: 404,
                json: { error: "not_found", message: "dictation runs in the desktop app only" },
              }),
          );
        },
      });
      const f = fx as unknown as DictationFixture;
      await page.click("#dictation-open");
      await page.click("#page-dictation .apps-next");
      await page.waitForFunction(
        (sel) =>
          document.querySelector(sel)?.textContent === "dictation runs in the desktop app only",
        "#page-dictation .apps-next-note",
      );
      expect(await text(page, "#page-dictation .apps-next")).toBe(NEXT_APP_LABEL);
      expect(f.patches).toHaveLength(0);
    },
    UI_TIMEOUT,
  );
});

describe("DC-U9 on the real app: the app of the next dictation", () => {
  // The fake helper dictates into com.example.chat once, at the second rebind, which the test
  // sends after pressing the button.
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-next-app-");
    const keys = join(t.dir, "keys.jsonl");
    writeFileSync(
      keys,
      [
        { at: 0, key: "RightCommand", down: true },
        { at: 2500, key: "RightCommand", down: false },
      ]
        .map((k) => JSON.stringify(k))
        .join("\n"),
    );
    const wav = join(t.dir, "mic.wav");
    writeFileSync(wav, monoWav(concat(silence(0.5), speak(["example", "dot", "com"]), silence(3))));
    rig = await uiRig({
      home: t.dir,
      helperArgs: [
        "--wav",
        wav,
        "--keys",
        keys,
        "--play-after-rebinds",
        "2",
        "--target-app",
        "com.example.chat",
        "--inserter-log",
        join(t.dir, "inserted.jsonl"),
      ],
      settings: {
        "dictation.enabled": true,
        "dictation.hotkey": "RightCommand",
        "dictation.pill": "off",
      },
    });
    await until(() => rig.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  test(
    "pressing the button, then dictating, writes a rule for that app to the config file",
    async () => {
      const page = await rig.open();
      await page.click("#dictation-open");
      await page.click("#page-dictation .apps-next");
      expect(await text(page, "#page-dictation .apps-next-note")).toBe(NEXT_APP_WAITING);
      const d = rig.app.dictation();
      if (!d) throw new Error("no dictation");
      await d.rebind();
      await page.waitForFunction(
        () =>
          [
            ...document.querySelectorAll<HTMLInputElement>("#page-dictation [data-field='app']"),
          ].some((el) => el.value === "com.example.chat"),
        undefined,
        { timeout: 15_000 },
      );
      await until(
        () =>
          JSON.stringify(rig.app.config().settings["dictation.apps"]).includes("com.example.chat"),
        5000,
        "the rule in the config",
      );
      expect(rig.app.config().settings["dictation.apps"]).toEqual([{ app: "com.example.chat" }]);
    },
    UI_TIMEOUT,
  );
});

describe("DC-U2, DC-N3: the master switch and the setup", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-setup-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  const toggle = "#page-dictation input[data-key='dictation.enabled']";
  const step = (page: Page, s: string) =>
    page.waitForSelector(`#page-dictation .dictation-setup[data-step='${s}']`);
  const browserPage = async (
    grants: DictationGrants,
    platform = "darwin",
    settings: Record<string, unknown> = {},
  ) => {
    let fx: DictationFixture | null = null;
    const page = await rig.open(undefined, {
      before: async (p) => {
        fx = await dictationFixture(p, { platform, grants });
        fx.settings["dictation.hotkey"] = "RightCommand";
        Object.assign(fx.settings, settings);
      },
    });
    await page.click("#dictation-open");
    await page.waitForSelector(toggle);
    return { page, fx: fx as unknown as DictationFixture };
  };

  test(
    "in the window: each grant step waits for its grant, the meter proves audio, then the switch turns on",
    async () => {
      const grants: DictationGrants = { mic: "denied", accessibility: "denied" };
      const w = await windowPage(rig, {
        platform: "darwin",
        grants,
        settings: { "dictation.hotkey": "RightCommand" },
      });
      try {
        const p = w.page;
        const asked = (name: string) =>
          w.requests.filter((r) => r.name === name).map((r) => r.params);
        await p.click("#dictation-open");
        await p.waitForSelector(toggle);
        expect(await text(p, "#dictation-off-reason")).toBe(
          "Stays off until akou may use the microphone.",
        );

        // Turned on with the microphone refused: the setup opens and the switch stays off.
        await p.click(toggle);
        await step(p, "mic");
        expect(await p.isChecked(toggle)).toBe(false);
        expect(await text(p, "#dictation-setup-note")).toContain(
          "akou has no access to the microphone, so dictation stays off",
        );
        // The step says it, and a line above it would go stale once the grant arrives.
        expect(await p.$("#dictation-off-reason")).toBeNull();
        await p.click("#dictation-setup-open-microphone");
        await until(() => asked("openSettingsPane").length === 1, 5000, "the microphone pane");
        expect(asked("openSettingsPane")).toEqual([{ pane: "microphone" }]);

        // The grant arrives: the step goes on by itself to its meter.
        grants.mic = "granted";
        await p.waitForSelector("#dictation-setup-level", { timeout: 5000 });
        await until(() => asked("watchDictationMic").length === 1, 5000, "the meter asked");
        expect(asked("watchDictationMic")).toEqual([{ on: true }]);
        const meter = () => p.$eval("#dictation-setup-level", (m) => (m as HTMLMeterElement).value);
        await w.send("dictationLevel", { db: -70 });
        expect(await meter()).toBe(-60);
        expect(await text(p, "#dictation-setup-heard")).toBe(
          "Say something: the bar moves when akou hears you.",
        );
        await w.send("dictationLevel", { db: -20 });
        expect(await meter()).toBe(-20);
        expect(await text(p, "#dictation-setup-heard")).toBe("akou hears you.");

        // Accessibility waits the same way, and the meter lets go of the mic.
        await p.click("#dictation-setup-next");
        await step(p, "accessibility");
        expect(asked("watchDictationMic")).toEqual([{ on: true }, { on: false }]);
        await p.click("#dictation-setup-open-accessibility");
        await until(() => asked("openSettingsPane").length === 2, 5000, "the Accessibility pane");
        expect(asked("openSettingsPane")[1]).toEqual({ pane: "accessibility" });
        grants.accessibility = "granted";
        // The languages (akou-5v8): the interface's to start with, one more added, then saved.
        await step(p, "languages");
        const chips = () =>
          p.$$eval("#dictation-languages .language-chip", (l) =>
            l.map((x) => (x as HTMLElement).dataset.code),
          );
        expect(await chips()).toEqual(["en"]);
        await p.selectOption("#dictation-languages-add", "es");
        expect(await chips()).toEqual(["en", "es"]);
        expect(await text(p, "#dictation-languages .language-chip[data-code='es'] span")).toBe(
          "Spanish",
        );
        // With none left there is nothing to listen for, so Continue waits.
        await p.click("#dictation-languages button[aria-label='Remove English']");
        await p.click("#dictation-languages button[aria-label='Remove Spanish']");
        expect(await p.isDisabled("#dictation-setup-next")).toBe(true);
        await p.selectOption("#dictation-languages-add", "en");
        await p.selectOption("#dictation-languages-add", "es");
        expect(w.patches).toEqual([]);
        await p.click("#dictation-setup-next");
        await step(p, "key");
        expect(w.patches).toEqual([{ "dictation.languages": ["en", "es"] }]);
        expect(
          await p.$$eval("#page-dictation .dictation-setup .keycaps kbd", (k) =>
            k.map((x) => x.textContent),
          ),
        ).toEqual(["Right ⌘"]);

        await p.click("#dictation-setup-next");
        await step(p, "try");
        expect(w.patches).toEqual([
          { "dictation.languages": ["en", "es"] },
          { "dictation.enabled": true },
        ]);
        expect(await text(p, "#dictation-setup-note")).toContain("hold Right ⌘, say a few words");
        await p.click("#dictation-try");
        await p.keyboard.type("ok");
        expect(await p.inputValue("#dictation-try")).toBe("ok");

        await p.click("#dictation-setup-done");
        await p.waitForSelector("#page-dictation section[data-section='Keys']");
        expect(await p.isChecked(toggle)).toBe(true);
        expect(await text(p, "#dictation-grant-mic .pg-state")).toBe("Allowed");
        expect(await text(p, "#dictation-grant-accessibility .pg-state")).toBe("Allowed");
        expect(await p.isVisible("#dictation-setup-open")).toBe(true);
        // The page read the grants and opened panes; it never asked the OS for one.
        expect(JSON.stringify(w.requests)).not.toContain("prompt");
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "Accessibility refused: clipboard only, the key becomes a chord, and a key alone is refused",
    async () => {
      const { page, fx } = await browserPage(
        { mic: "granted", accessibility: "denied" },
        "darwin",
        { "dictation.languages": ["es", "en"] },
      );
      expect(await text(page, "#dictation-grant-mic .pg-state")).toBe("Allowed");
      expect(await text(page, "#dictation-grant-accessibility .pg-help")).toBe(
        "Not allowed, so dictations are copied and you paste them.",
      );
      expect(await page.isVisible("#dictation-grant-open-accessibility")).toBe(true);
      await page.click(toggle);
      await step(page, "mic");
      // A browser cannot hear the helper, so the meter is the window's.
      expect(await text(page, "#dictation-setup-heard")).toBe(
        "The level shows in the akou window.",
      );
      await page.click("#dictation-setup-next");
      await step(page, "accessibility");
      await page.click("#dictation-setup-open-accessibility");
      if (process.platform === "darwin") {
        await until(() => rig.opened.length === 1, 3000, "the Accessibility pane");
        expect(rig.opened[0]).toContain("Privacy_Accessibility");
      } else {
        await page.waitForSelector("#toast:not([hidden])");
      }

      await page.click("#dictation-setup-clipboard");
      // Languages saved already are kept in the user's order, and Continue writes nothing.
      await step(page, "languages");
      expect(
        await page.$$eval("#dictation-languages .language-chip", (l) =>
          l.map((x) => (x as HTMLElement).dataset.code),
        ),
      ).toEqual(["es", "en"]);
      await page.click("#dictation-setup-next");
      await step(page, "key");
      const key = "#page-dictation .dictation-setup input[data-key='dictation.hotkey']";
      expect(await page.inputValue(key)).toBe("Control+Shift+Space");
      expect(await text(page, "#dictation-setup-note")).toContain("must be a combination");
      await page.click("#page-dictation .dictation-setup button.record-key");
      await page.keyboard.down("MetaRight");
      await page.waitForTimeout(HOLD_ALONE_MS + 100);
      await page.keyboard.up("MetaRight");
      expect(await text(page, "#page-dictation .dictation-setup .recorder-note")).toContain(
        "Right ⌘ alone cannot be bound",
      );
      expect(fx.patches).toEqual([]);

      // A refusal keeps the step, with the reason; the next try turns dictation on.
      fx.refuse.set("dictation.enabled", "the helper did not start");
      await page.click("#dictation-setup-next");
      await page.waitForSelector("#dictation-setup-issue:not([hidden])");
      expect(await text(page, "#dictation-setup-issue")).toBe(
        "Dictation: the helper did not start",
      );
      await page.click("#dictation-setup-next");
      await step(page, "try");
      expect(fx.patches).toEqual([
        { "dictation.hotkey": "Control+Shift+Space" },
        { "dictation.enabled": true },
        { "dictation.enabled": true },
      ]);
      expect(await text(page, "#dictation-setup-note")).toContain(
        "hold ⌃ ⇧ Space, say a few words and let go. akou copies what you said: press ⌘V to paste it here",
      );
    },
    UI_TIMEOUT,
  );

  test(
    "the microphone refused: the switch stays off with the reason, and Cancel leaves nothing saved",
    async () => {
      const { page, fx } = await browserPage({ mic: "denied", accessibility: "granted" });
      expect(await text(page, "#dictation-off-reason")).toBe(
        "Stays off until akou may use the microphone.",
      );
      await page.click(toggle);
      await step(page, "mic");
      expect(await page.isChecked(toggle)).toBe(false);
      expect(await page.isVisible("#dictation-setup-open-microphone")).toBe(true);
      expect(await page.$("#dictation-setup-next")).toBeNull();
      await page.click("#dictation-setup-cancel");
      await page.waitForSelector("#page-dictation section[data-section='Keys']");
      expect(await page.isChecked(toggle)).toBe(false);
      expect(fx.patches).toEqual([]);

      // With every grant there, the switch saves at once (positive control for the intercept).
      // The page reads the grants again when it is shown again.
      fx.grants = { mic: "granted", accessibility: "granted" };
      await page.click("#calls-open");
      await page.click("#dictation-open");
      await page.waitForSelector("#dictation-grant-mic .pg-state");
      await page.click(toggle);
      await until(() => fx.patches.length === 1, 5000, "the switch saved");
      expect(fx.patches).toEqual([{ "dictation.enabled": true }]);
      expect(await page.$("#page-dictation .dictation-setup")).toBeNull();
    },
    UI_TIMEOUT,
  );

  test(
    "the languages step: a refused or failed save says why and keeps the step, then saves once",
    async () => {
      // "Run the setup again" opens the window's first-run setup now; the switch still runs this
      // one for a missing grant, which arrives while its step waits.
      const { page, fx } = await browserPage({ mic: "granted", accessibility: "denied" });
      await page.click(toggle);
      await step(page, "mic");
      await page.click("#dictation-setup-next");
      await step(page, "accessibility");
      fx.grants = { mic: "granted", accessibility: "granted" };
      await step(page, "languages");
      fx.refuse.set("dictation.languages", "is a list of ISO 639 codes");
      await page.click("#dictation-setup-next");
      await page.waitForSelector("#dictation-setup-issue:not([hidden])");
      expect(await text(page, "#dictation-setup-issue")).toBe(
        "Languages: is a list of ISO 639 codes",
      );
      expect(await page.isDisabled("#dictation-setup-next")).toBe(false);
      // The request itself fails: the step names it rather than leaving the button dead.
      const fail = (u: URL) => u.pathname.endsWith("/config");
      await page.route(fail, (r) => (r.request().method() === "PATCH" ? r.abort() : r.fallback()));
      await page.click("#dictation-setup-next");
      await page.waitForFunction(() =>
        document.getElementById("dictation-setup-issue")?.textContent?.startsWith("not saved:"),
      );
      expect(await page.isDisabled("#dictation-setup-next")).toBe(false);
      await page.unroute(fail);
      // A double click saves once and moves on.
      await page.dblclick("#dictation-setup-next");
      await step(page, "key");
      expect(fx.patches).toEqual([
        { "dictation.languages": ["en"] },
        { "dictation.languages": ["en"] },
      ]);
    },
    UI_TIMEOUT,
  );

  test(
    "leaving the page at the setup's last step keeps dictation on: the switch above it follows the setup",
    async () => {
      const { page, fx } = await browserPage({ mic: "granted", accessibility: "denied" });
      await page.click(toggle);
      await step(page, "mic");
      await page.click("#dictation-setup-next");
      await step(page, "accessibility");
      fx.grants = { mic: "granted", accessibility: "granted" };
      await step(page, "languages");
      await page.click("#dictation-setup-next");
      await step(page, "key");
      await page.click("#dictation-setup-next");
      await step(page, "try");
      expect(await page.isChecked(toggle)).toBe(true);
      const saved = fx.patches.length;
      expect(fx.patches.at(-1)).toEqual({ "dictation.enabled": true });
      // Leaving saves what is typed: nothing, since the switch holds what the setup saved.
      await page.click("#calls-open");
      await page.waitForTimeout(500);
      expect(fx.patches).toHaveLength(saved);
      expect(fx.settings["dictation.enabled"]).toBe(true);
    },
    UI_TIMEOUT,
  );

  test(
    "on Linux the microphone step names the sound server, not a privacy pane",
    async () => {
      const { page } = await browserPage({ mic: "denied", accessibility: "not-needed" }, "linux");
      await page.click(toggle);
      await step(page, "mic");
      expect(await text(page, "#dictation-setup-note")).toContain(
        "Check that PipeWire or PulseAudio is running",
      );
      expect(await page.$("#dictation-setup-open-microphone")).toBeNull();
    },
    UI_TIMEOUT,
  );
});

describe("DC-U2 on the real app: a missing grant opens the setup, never the helper", () => {
  // The helper's probe reports the microphone refused; dictation is off, so no helper runs.
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  let commands: string;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-probe-");
    commands = join(t.dir, "commands.jsonl");
    rig = await uiRig({
      home: t.dir,
      helperArgs: ["--grants", "accessibility", "--commands-log", commands],
    });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  test(
    "the switch runs the setup at the microphone and stays off; no dictate process starts",
    async () => {
      const toggle = "#page-dictation input[data-key='dictation.enabled']";
      const page = await rig.open();
      await page.click("#dictation-open");
      await page.waitForSelector(toggle);
      expect(await text(page, "#dictation-off-reason")).toBe(
        "Stays off until akou may use the microphone.",
      );
      await page.click(toggle);
      await page.waitForSelector("#page-dictation .dictation-setup[data-step='mic']");
      expect(await page.isChecked(toggle)).toBe(false);
      expect(rig.app.config().settings["dictation.enabled"]).toBe(false);
      expect(rig.app.dictation()?.status()).toMatchObject({ enabled: false, state: "off" });
      // The probe printed its line and exited; a dictate process would have logged a rebind.
      expect(existsSync(commands)).toBe(false);
    },
    UI_TIMEOUT,
  );
});

describe("DC-U2 on the real app: a microphone never asked for starts the helper", () => {
  // macOS asks for the microphone when the device first opens, and lists akou in the Microphone
  // pane only after that: the switch must start the helper, not send the user to that pane.
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  let commands: string;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-notasked-");
    commands = join(t.dir, "commands.jsonl");
    rig = await uiRig({
      home: t.dir,
      helperArgs: ["--grants", "accessibility", "--not-asked", "mic", "--commands-log", commands],
    });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  test(
    "the switch saves and a dictate process starts, with no setup and no off reason",
    async () => {
      const toggle = "#page-dictation input[data-key='dictation.enabled']";
      const page = await rig.open();
      await page.click("#dictation-open");
      await page.waitForSelector(toggle);
      expect(await page.locator("#dictation-off-reason").count()).toBe(0);
      await page.click(toggle);
      await until(
        () => rig.app.config().settings["dictation.enabled"] === true,
        5000,
        "the switch saved",
      );
      await until(() => existsSync(commands), 10_000, "a dictate process started");
      expect(await page.locator("#page-dictation .dictation-setup").count()).toBe(0);
    },
    UI_TIMEOUT,
  );
});

describe("DC-H1: the History page's days", () => {
  test("Today, Yesterday, the weekday, then the date, as the sidebar lists calls; another year says its year", () => {
    const tz = localZone();
    const now = new Date(2026, 8, 30, 9, 0).getTime();
    expect(dayLabel(new Date(2026, 8, 30, 0, 5).getTime(), now, tz)).toBe("Today");
    expect(dayLabel(new Date(2026, 8, 29, 23, 59).getTime(), now, tz)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 8, 29, 0, 0).getTime(), now, tz)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 8, 28, 12, 0).getTime(), now, tz)).toBe("Mon");
    expect(dayLabel(new Date(2026, 7, 21, 12, 0).getTime(), now, tz)).toBe("21 Aug");
    expect(dayLabel(new Date(2025, 8, 28, 12, 0).getTime(), now, tz)).toBe("28 Sep 2025");
  });
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

  const openHistory = async (history: DictationRow[], settings: Record<string, unknown> = {}) => {
    let fx: DictationFixture | null = null;
    const page = await rig.open(undefined, {
      before: async (p) => {
        await p.context().grantPermissions([...CLIPBOARD_PERMISSIONS]);
        fx = await dictationFixture(p, { history });
        Object.assign(fx.settings, settings);
      },
    });
    await page.click("#dictation-open");
    await page.click("#dictation-history-open");
    await page.waitForSelector(
      "#page-dictation #dictation-history-list :is(li[data-id], [data-empty])",
    );
    return { page, fx: fx as unknown as DictationFixture };
  };
  const row = (id: string) => `#dictation-history-list li[data-id='${id}']`;
  /** Picks an item of a row's menu, opening it first. */
  const fromMenu = async (page: Page, id: string, item: string) => {
    if (await page.isHidden(`${row(id)} .hist-menu`)) await page.click(`${row(id)} .hist-more`);
    await page.click(`${row(id)} .hist-menu ${item}`);
  };

  test(
    "lists every dictation with its app, engine, time and state; each action calls its route",
    async () => {
      const { page, fx } = await openHistory([
        dictationRow(1),
        dictationRow(2, {
          state: "cancelled",
          app: null,
          engine: "best",
          ms: 640,
          language: "es",
        }),
        dictationRow(3, { state: "failed", text: null, error: "remote akou not reachable" }),
        dictationRow(4, { state: "drafted", engine: "fast", fallback_from: "best" }),
      ]);
      expect(
        await page.$$eval("#dictation-history-list li", (l) => l.map((x) => x.dataset.id)),
      ).toEqual(["d001", "d002", "d003", "d004"]);
      // The time is the sidebar's 24-hour clock, whatever the machine's locale.
      expect(await text(page, `${row("d001")} time`)).toMatch(/^\d{2}:\d{2}$/);
      // A dictation the engine chosen could not hear says which one did, and one left in the
      // draft box says so.
      expect(await text(page, `${row("d004")} .meta`)).toMatch(
        /^[^·]+ · [^·]+ · Fast instead of Best · Left in the draft box$/,
      );
      expect(await text(page, `${row("d001")} .text`)).toBe("dictation number 1");
      const meta = await text(page, `${row("d002")} .meta`);
      expect(meta).toMatch(/^[^·]+ · No app · Spanish · Cancelled$/);
      // A plain insert says nothing of its state, and a dictation with no language names none
      // (positive control).
      expect(await text(page, `${row("d001")} .meta`)).toMatch(/^[^·]+ · [^·]+$/);
      expect(await page.$(`${row("d001")} .language`)).toBeNull();
      expect(await page.$(`${row("d001")} .state`)).toBeNull();
      expect(await text(page, `${row("d002")} .state`)).toBe("Cancelled");
      expect(await text(page, `${row("d003")} .issue`)).toBe("remote akou not reachable");
      // The rows are under the day they were made, in words.
      expect(
        await page.$$eval("#dictation-history-list section", (l) =>
          l.map((x) => x.getAttribute("data-section")),
        ),
      ).toHaveLength(1);
      // Nothing to insert, copy or fix in a dictation with no text; Retry still decodes its audio.
      expect(await page.isDisabled(`${row("d003")} button.insert`)).toBe(true);
      expect(await page.isDisabled(`${row("d003")} button.fix`)).toBe(true);
      expect(await page.isDisabled(`${row("d003")} button.copy`)).toBe(true);
      await page.click(`${row("d003")} .hist-more`);
      expect(await page.isEnabled(`${row("d003")} .hist-menu button.retry`)).toBe(true);
      await page.keyboard.press("Escape");
      await page.waitForSelector(`${row("d003")} .hist-menu`, { state: "hidden" });
      // Escape closed the menu, not the page.
      expect(await page.isVisible("#page-dictation")).toBe(true);

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
      await fromMenu(page, "d002", "button.delete");
      expect(fx.calls).toEqual([]);
      expect(await text(page, `${row("d002")} button.delete`)).toBe("Delete it and its audio?");
      await fromMenu(page, "d002", "button.delete");
      await page.waitForSelector(row("d002"), { state: "detached" });
      expect(fx.calls).toEqual([{ method: "DELETE", path: "/dictations/d002" }]);
      expect(fx.history.map((d) => d.id)).toEqual(["d001", "d003", "d004"]);
    },
    UI_TIMEOUT,
  );

  test(
    "Retry with Best shows the second result under the first, and either can be inserted",
    async () => {
      const { page, fx } = await openHistory([dictationRow(1)], {
        "dictation.remote.url": "https://studio.example",
      });
      // The menu offers every engine but the one that ran.
      await page.click(`${row("d001")} .hist-more`);
      expect(
        await page.$$eval(`${row("d001")} .hist-menu button`, (l) => l.map((x) => x.textContent)),
      ).toEqual(["Retry with Best", "Retry with Live", "Retry on the other computer", "Delete"]);
      fx.calls.length = 0;
      await fromMenu(page, "d001", "button.retry[data-engine='best']");
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
      expect(await text(page, `${row("d001")} .result.retry small`)).toBe("Best · 0.6 s");

      fx.calls.length = 0;
      await page.click(`${row("d001")} .result.retry button.insert`);
      await page.click(`${row("d001")} .hist-actions button.insert`);
      await until(() => fx.calls.length === 2, 5000, "both inserts");
      expect(fx.calls.map((c) => c.body)).toEqual([
        { text: "dictation number 1 (best)" },
        { text: "dictation number 1" },
      ]);

      // A refused retry says why and leaves the readings as they were.
      fx.refuse.set("retry:remote", "no remote akou is set");
      await fromMenu(page, "d001", "button.retry[data-engine='remote']");
      await page.waitForFunction(() => document.getElementById("toast")?.textContent !== "");
      expect(await text(page, "#toast")).toBe("no remote akou is set");
      expect(await page.$$(`${row("d001")} .result`)).toHaveLength(2);

      // A best that could not run is decoded by fast, and the reading says so.
      fx.retry = (d, engine) => ({ ...d, engine: "fast", fallback_from: engine, ms: 120 });
      await fromMenu(page, "d001", "button.retry[data-engine='best']");
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.textContent === "Fast · 0.1 s, instead of Best",
        `${row("d001")} .result.retry small`,
      );
    },
    UI_TIMEOUT,
  );

  test(
    "a request that fails outright still opens History and Words, and says why in the list",
    async () => {
      const page = await rig.open(undefined, {
        before: async (p) => {
          await dictationFixture(p);
          await vocabFixture(p);
          // Registered after the fixtures, so these run first: the app is gone.
          await p.route(
            (u) => u.pathname.startsWith("/api/v1/dictations") || u.pathname === "/api/v1/vocab",
            (route) => route.abort(),
          );
        },
      });
      await page.click("#dictation-open");
      await page.click("#dictation-history-open");
      await page.waitForSelector("#page-dictation #dictation-history-list .pg-sechelp");
      expect(await text(page, "#page-dictation h1")).toBe("History");
      expect(await text(page, "#dictation-history-list .pg-sechelp")).not.toBe("");
      await page.click("#page-dictation .pg-back");
      await page.click("#dictation-dictionary-open");
      await page.waitForSelector("#page-dictation #dictionary-list .pg-sechelp");
      expect(await text(page, "#page-dictation h1")).toBe("Words and replacements");
    },
    UI_TIMEOUT,
  );

  test(
    "with no other computer set up, the menu offers no retry on one",
    async () => {
      const { page } = await openHistory([dictationRow(1)]);
      await page.click(`${row("d001")} .hist-more`);
      expect(
        await page.$$eval(`${row("d001")} .hist-menu button`, (l) => l.map((x) => x.textContent)),
      ).toEqual(["Retry with Best", "Retry with Live", "Delete"]);
    },
    UI_TIMEOUT,
  );

  test(
    "a row under the pointer keeps its height, and a menu at the window's bottom opens upwards",
    async () => {
      const long =
        "Can we move the review to Thursday? The numbers are not ready and the deck needs another pass.";
      const { page } = await openHistory(
        Array.from({ length: 12 }, (_, i) => dictationRow(i + 1, i === 0 ? { text: long } : {})),
      );
      await page.setViewportSize({ width: 1024, height: 600 });
      await page.mouse.move(0, 0);
      const heights = () =>
        page.$$eval("#dictation-history-list li", (l) =>
          l.map((x) => Math.round(x.getBoundingClientRect().height)),
        );
      const still = await heights();
      await page.hover(row("d001"), { position: { x: 30, y: 12 } });
      await page.waitForFunction(
        (sel) => getComputedStyle(document.querySelector(sel) as Element).opacity === "1",
        `${row("d001")} .hist-actions`,
      );
      expect(await heights()).toEqual(still);

      // The last row at the bottom of the window: Delete stays on screen.
      await page.$eval(row("d012"), (el) => el.scrollIntoView({ block: "end" }));
      await page.click(`${row("d012")} .hist-more`);
      const box = await page.$eval(`${row("d012")} .hist-menu`, (m) => {
        const r = m.getBoundingClientRect();
        return { bottom: r.bottom, view: window.innerHeight, up: m.classList.contains("up") };
      });
      expect(box.up).toBe(true);
      expect(box.bottom).toBeLessThanOrEqual(box.view);
      // A row near the top still opens its menu below the button.
      await page.$eval(row("d001"), (el) => el.scrollIntoView({ block: "start" }));
      await page.click(`${row("d001")} .hist-more`);
      expect(await page.$eval(`${row("d001")} .hist-menu`, (m) => m.classList.contains("up"))).toBe(
        false,
      );
    },
    UI_TIMEOUT,
  );

  test(
    "deleting the last dictation shown says there are none",
    async () => {
      const { page } = await openHistory([dictationRow(1)]);
      await fromMenu(page, "d001", "button.delete");
      await fromMenu(page, "d001", "button.delete");
      await page.waitForSelector("#dictation-history-list [data-empty]");
      expect(await text(page, "#dictation-history-list [data-empty]")).toBe("No dictations yet.");
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
      await page.waitForSelector("#dictation-history-list [data-empty]");
      expect(await text(page, "#dictation-history-list [data-empty]")).toBe(
        "No dictation holds that.",
      );
    },
    UI_TIMEOUT,
  );
});

describe("DC-U5, DC-H1 on the real app: the dictionary and the history over akou's own routes", () => {
  // One app for the whole block: its fake helper says "example dot com" once, at the second
  // rebind, and the fake engines (Parakeet, and Qwen over the fake llama-server) hear it. The
  // tests run in order: the first teaches `.com` and dictates, the second reads that dictation.
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  const draftOpens: DraftOpen[] = [];
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-real-");
    const keys = join(t.dir, "keys.jsonl");
    writeFileSync(
      keys,
      [
        { at: 0, key: "RightCommand", down: true },
        { at: 2500, key: "RightCommand", down: false },
      ]
        .map((k) => JSON.stringify(k))
        .join("\n"),
    );
    const wav = join(t.dir, "mic.wav");
    writeFileSync(wav, monoWav(concat(silence(0.5), speak(["example", "dot", "com"]), silence(3))));
    const models = join(t.dir, "models");
    for (const f of MODELS.find((m) => m.id === QWEN_ASR)?.files ?? []) {
      const path = modelFile(models, QWEN_ASR, f.name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }
    // A call in the workspace "work", whose own vocabulary file the Dictionary lists read only.
    seedCall(t.dir, (b) => standardCall(b));
    rig = await uiRig({
      home: t.dir,
      helperArgs: [
        "--wav",
        wav,
        "--keys",
        keys,
        "--play-after-rebinds",
        "2",
        "--inserter-log",
        join(t.dir, "inserted.jsonl"),
      ],
      settings: {
        "dictation.enabled": true,
        "dictation.hotkey": "RightCommand",
        "dictation.pill": "off",
        "asr.modelsDir": models,
        "asr.llamaServer": [
          process.execPath,
          join(import.meta.dir, "..", "fixtures", "fake-llama-server.ts"),
        ],
      },
    });
    await until(() => rig.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
    rig.app.dictation()?.draft.attach({
      open: (d) => draftOpens.push(d),
      chip: () => {},
      showInactive: () => {},
      hide: () => {},
    });
    writeFileSync(
      join(rig.app.configDir, "vocabulary.yaml"),
      [
        "version: 1",
        "entries:",
        '  - term: "Vercel"',
        '    heard: ["versal"]',
        '    source: "import:api"',
        "    confirmed: true",
        '    added_at: "2026-01-02"',
        '    scope: "dictation"',
        "",
      ].join("\n"),
    );
    mkdirSync(join(rig.app.configDir, "vocabulary"), { recursive: true });
    writeFileSync(
      join(rig.app.configDir, "vocabulary", "work.yaml"),
      [
        "version: 1",
        "entries:",
        '  - term: "Hetzner"',
        '    heard: ["hetzna"]',
        '    source: "user"',
        "    confirmed: true",
        '    added_at: "2026-01-02"',
        "",
      ].join("\n"),
    );
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  const vocabFile = () =>
    parseVocab(readFileSync(join(rig.app.configDir, "vocabulary.yaml"), "utf8")).file.entries;
  const inserted = (): { text: string }[] => {
    const path = join(t.dir, "inserted.jsonl");
    return existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  };
  const openDictionary = async (call?: string) => {
    const page = await rig.open(call);
    // The Dictionary reads the workspace of the call the window shows: wait until it shows one.
    if (call) await page.waitForFunction(() => document.getElementById("title")?.textContent);
    await page.click("#dictation-open");
    await page.click("#dictation-dictionary-open");
    await page.waitForSelector("#page-dictation #dictionary-list li[data-term]");
    return page;
  };
  const term = (x: string) => `#dictionary-list li[data-term='${x}']`;

  test(
    "dot com to .com is written for dictation only, and the next dictation of example dot com inserts example.com",
    async () => {
      const page = await openDictionary();
      await page.click("#dictionary-replace");
      await page.fill("#dictionary-heard", "dot com");
      await page.fill("#dictionary-term", ".com");
      await page.click("#dictionary-add");
      await page.waitForSelector(term(".com"));
      // Dictation only: its row does not say Calls too.
      expect(await page.$(`${term(".com")} .where`)).toBeNull();
      expect(vocabFile().find((e) => e.term === ".com")).toMatchObject({
        heard: ["dot com"],
        source: "user",
        confirmed: true,
        entryScope: "dictation",
      });

      // Another form on a known word keeps who added it and when (the route replaces the rest).
      await page.fill("#dictionary-heard", "ver sell");
      await page.fill("#dictionary-term", "Vercel");
      await page.click("#dictionary-add");
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.textContent === "also heard as “versal”, “ver sell”",
        `${term("Vercel")} .where`,
      );
      expect(vocabFile().find((e) => e.term === "Vercel")).toMatchObject({
        heard: ["versal", "ver sell"],
        source: "import:api",
        added_at: "2026-01-02",
        entryScope: "dictation",
      });

      // The route takes only the one scope there is.
      const bad = await rig.api("POST", "/vocab", { term: "Kubernetes", scope: "calls" });
      expect([bad.status, bad.body.error, bad.body.field]).toEqual([400, "bad_field", "scope"]);

      // The next dictation: the press plays at the second rebind.
      const d = rig.app.dictation();
      if (!d) throw new Error("no dictation");
      await d.rebind();
      // The fake inserter writes its line before the app has the receipt: wait for the log's state.
      await until(() => d.log.items()[0]?.state === "inserted", 15_000, "the dictation inserted");
      expect(inserted().map((x) => x.text)).toEqual(["example.com"]);
      expect(d.log.items()[0]).toMatchObject({
        state: "inserted",
        raw: "example dot com",
        text: "example.com",
      });
    },
    UI_TIMEOUT,
  );

  test(
    "History on the real routes: Retry with best beside the first, Insert either opens the draft box, Delete removes it and its audio",
    async () => {
      const d = rig.app.dictation();
      const id = d?.log.items()[0]?.id;
      if (!d || !id) throw new Error("the first test left no dictation");
      const page = await rig.open();
      await page.click("#dictation-open");
      await page.click("#dictation-history-open");
      const row = `#dictation-history-list li[data-id='${id}']`;
      await page.waitForSelector(row);
      expect(await text(page, `${row} .result.first .text`)).toBe("example.com");
      // Inserted is the usual end: its row names no state.
      expect(await page.$(`${row} .state`)).toBeNull();
      expect(await page.getAttribute(row, "data-state")).toBe("inserted");

      await page.click(`${row} .hist-more`);
      await page.click(`${row} .hist-menu button.retry[data-engine='best']`);
      await page.waitForSelector(`${row} .result.retry`);
      const readings = await page.$$eval(`${row} .result`, (r) =>
        r.map((x) => [x.getAttribute("data-engine"), x.querySelector(".text")?.textContent]),
      );
      expect(readings).toEqual([
        ["fast", "example.com"],
        ["best", "example.com"],
      ]);

      await page.click(`${row} .result.retry button.insert`);
      await page.click(`${row} .hist-actions button.insert`);
      await until(() => draftOpens.length === 2, 5000, "both inserts open the draft box");
      expect(draftOpens.map((o) => [o.id, o.text, o.focus])).toEqual([
        [id, "example.com", true],
        [id, "example.com", true],
      ]);

      const audio = d.audio.path(id);
      expect(existsSync(audio)).toBe(true);
      await page.click(`${row} .hist-more`);
      await page.click(`${row} button.delete`);
      await page.click(`${row} button.delete`);
      await page.waitForSelector(row, { state: "detached" });
      expect(existsSync(audio)).toBe(false);
      expect((await rig.api("GET", `/dictations/${id}`)).status).toBe(404);
    },
    UI_TIMEOUT,
  );

  test(
    "on a call, the Words page lists that workspace's words read only, under its name, as words for its calls",
    async () => {
      const page = await openDictionary("01J8Z6Q4M2VX0K7B3D4E5F6G7H");
      await page.waitForSelector(term("Hetzner"));
      const ws = "section[data-section='From the work workspace']";
      expect(await page.locator(`${ws} li[data-term='Hetzner']`).count()).toBe(1);
      expect(await text(page, `${ws} .pg-sechelp`)).toBe(
        "Used on work's calls only, not in dictation. Change them from that workspace.",
      );
      // No file path on the page.
      expect(await text(page, "#page-dictation")).not.toContain("work.yaml");
      expect(await page.locator(`${term("Hetzner")} button`).count()).toBe(0);
      // Its section says where it applies; the row says only how else it is heard.
      expect(await text(page, `${term("Hetzner")} .where`)).toBe("also heard as “hetzna”");
      // The global file's words open to their switch and Remove (positive control).
      await page.click(`${term("Vercel")} .pg-link`);
      expect(await page.isVisible(`${term("Vercel")} button.remove`)).toBe(true);
    },
    UI_TIMEOUT,
  );

  test(
    "DC-L5: a fix left unanswered waits under To review; Learn it writes it, and Remove in the editor gives the heard form back",
    async () => {
      // The fake engine hears "kubernetes" as "kubernetis" unless the vocabulary fixes it.
      const clip = monoWav(concat(silence(0.6), speak(["deploy", "to", "kubernetes"]), silence(1)));
      const dictate = async () => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(clip)]), "clip.wav");
        form.append("engine", "fast");
        const res = await fetch(`http://127.0.0.1:${rig.port}/v1/dictations`, {
          method: "POST",
          headers: { authorization: `Bearer ${rig.token}`, "x-akou-client": "test" },
          body: form,
        });
        return ((await res.json()) as { text: string }).text;
      };
      expect(await dictate()).toBe("deploy to kubernetis");
      const d = rig.app.dictation();
      if (!d) throw new Error("the app runs no dictation");
      const id = [...d.log.events()].reverse().find((e) => e.type === "dictation.started")
        ?.id as string;
      // As the draft box's chip writes a fix the user let go.
      const pair = {
        type: "dictation.learn",
        id,
        term: "Kubernetes",
        heard: "kubernetis",
      } as const;
      d.log.append({ ...pair, status: "proposed", evidence: "none" });
      d.log.append({ ...pair, status: "ignored", evidence: "none" });

      const page = await rig.open();
      await page.click("#dictation-open");
      await page.click("#dictation-review-open");
      const review = (x: string) => `#dictionary-list .review-dictation [data-term='${x}']`;
      await page.waitForSelector(review("Kubernetes"));
      expect(await text(page, "#dictionary-list .review-dictation .pg-sec")).toBe("To review");
      expect(await page.getAttribute(review("Kubernetes"), "data-state")).toBe("waiting");
      await page.click(`${review("Kubernetes")} button[data-action='approve']`);
      await page.waitForSelector(`${review("Kubernetes")}[data-state='accepted']`);
      expect(vocabFile().find((e) => e.term === "Kubernetes")).toMatchObject({
        heard: ["kubernetis"],
        entryScope: "dictation",
      });
      expect(await dictate()).toBe("deploy to Kubernetes");

      // The editor's one click: the entry leaves the file, and the next dictation writes what
      // it heard again, read through the fold.
      const word = "section[data-section='Words'] li[data-term='Kubernetes']";
      await page.waitForSelector(word);
      await page.click(`${word} .pg-link`);
      await page.click(`${word} button.remove`);
      await page.waitForSelector(word, { state: "detached" });
      expect(vocabFile().some((e) => e.term === "Kubernetes")).toBe(false);
      expect(await dictate()).toBe("deploy to kubernetis");
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

  const input = (key: string) => `#page-dictation input[data-key='${key}']`;
  const record = (key: string) => `#page-dictation button.record-key[data-for='${key}']`;
  const caps = (page: Page, key: string) =>
    page.$$eval(`#page-dictation div.pg-row[data-key='${key}'] .keycaps kbd`, (k) =>
      k.map((x) => x.textContent),
    );
  const note = (page: Page, key: string) =>
    text(page, `#page-dictation div.pg-row[data-key='${key}'] .recorder-note`);
  const openPage = async (o: { grants?: DictationGrants } = {}) => {
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
      expect(await page.isVisible("#page-dictation")).toBe(true);
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
      expect(await note(page, "dictation.hotkey")).toBe("⌥ ⌘ R is already the record shortcut.");
      expect(fx.patches).toEqual([]);
      expect(await page.getAttribute(record("dictation.hotkey"), "aria-pressed")).toBe("true");
      // Another dictation key's binding, however it was written.
      await page.keyboard.press("Control+Shift+KeyD");
      await until(() => fx.patches.length === 1, 5000, "the free chord saved");
      await page.click(record("dictation.hotkeyDraft"));
      await page.keyboard.press("Shift+Control+KeyD");
      expect(await note(page, "dictation.hotkeyDraft")).toBe("⌃ ⇧ D is already the dictation key.");
      expect(fx.patches).toEqual([{ "dictation.hotkey": "Control+Shift+D" }]);
    },
    UI_TIMEOUT,
  );

  test(
    "without the Accessibility grant a modifier alone is refused with the reason; a chord is taken",
    async () => {
      const { page, fx } = await openPage({ grants: { mic: "granted", accessibility: "denied" } });
      await page.click(record("dictation.hotkey"));
      expect(await note(page, "dictation.hotkey")).toBe(
        "Without Accessibility access the key must be a combination, such as Control+Shift+Space.",
      );
      await page.keyboard.down("MetaRight");
      await page.waitForTimeout(HOLD_ALONE_MS + 100);
      await page.keyboard.up("MetaRight");
      expect(await note(page, "dictation.hotkey")).toBe(
        "Right ⌘ alone cannot be bound. Without Accessibility access the key must be a combination, such as Control+Shift+Space.",
      );
      expect(fx.patches).toEqual([]);
      await page.keyboard.press("Control+Shift+Space");
      await until(() => fx.patches.length === 1, 5000, "the chord saved");
      expect(fx.patches).toEqual([{ "dictation.hotkey": "Control+Shift+Space" }]);
    },
    UI_TIMEOUT,
  );

  test(
    "a modifier held while another is down is not a key alone, and Shift with a letter is refused",
    async () => {
      const { page, fx } = await openPage();
      await page.click(record("dictation.hotkey"));
      await page.keyboard.down("MetaLeft");
      await page.keyboard.down("ShiftLeft");
      await page.keyboard.up("ShiftLeft");
      await page.keyboard.down("ShiftLeft");
      await page.waitForTimeout(HOLD_ALONE_MS + 100);
      await page.keyboard.up("ShiftLeft");
      expect(await note(page, "dictation.hotkey")).toBe(
        "Release the other keys to bind one alone.",
      );
      await page.keyboard.up("MetaLeft");
      await page.keyboard.press("Shift+KeyD");
      expect(await note(page, "dictation.hotkey")).toBe(
        "Shift with a letter or digit types a character; add Control, Alt or ⌘.",
      );
      expect(fx.patches).toEqual([]);
      await page.keyboard.press("Control+Shift+KeyD");
      await until(() => fx.patches.length === 1, 5000, "the chord saved");
      expect(fx.patches).toEqual([{ "dictation.hotkey": "Control+Shift+D" }]);
    },
    UI_TIMEOUT,
  );

  test(
    "opening History stops a live recorder, so the search box gets the keys",
    async () => {
      const { page, fx } = await openPage();
      await page.click(record("dictation.hotkey"));
      expect(await page.getAttribute(record("dictation.hotkey"), "aria-pressed")).toBe("true");
      await page.click("#dictation-history-open");
      await page.waitForSelector("#page-dictation #dictation-history-q");
      expect(await page.locator(record("dictation.hotkey")).count()).toBe(0);
      await page.click("#dictation-history-q");
      await page.keyboard.type("ab");
      expect(await page.inputValue("#dictation-history-q")).toBe("ab");
      expect(fx.patches).toEqual([]);
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
        // The helper streams every key; one the page sees itself is the page's to take.
        await w.send("dictationKey", { name: "RightCommand" });
        await w.send("dictationKey", { name: "Fn" });
        await until(() => w.patches.length === 1, 5000, "Fn saved");
        expect(w.patches).toEqual([{ "dictation.hotkey": "Fn" }]);
        expect(await caps(p, "dictation.hotkey")).toEqual(["fn"]);
        expect(
          w.requests.filter((r) => r.name === "recordDictationKeys").map((r) => r.params),
        ).toEqual([{ on: true }, { on: false }]);

        // A recorder left open when the page is left lets go of the helper's keys too.
        await p.click(record("dictation.hotkeyDraft"));
        await p.click("#calls-open");
        await until(
          () => w.requests.filter((r) => r.name === "recordDictationKeys").length === 4,
          5000,
          "the close stopped the recorder",
        );
        // Leaving a page also reads the live model menu again, so the last helper request counts.
        expect(w.requests.filter((r) => r.name === "recordDictationKeys").at(-1)?.params).toEqual({
          on: false,
        });
        await w.send("dictationKey", { name: "Fn" });
        expect(w.patches).toHaveLength(1);
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );
});

describe("DC-L2: the read-back waits for the Accessibility grant on macOS", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-read-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  const openPage = async (
    platform: string,
    grants: DictationGrants,
    settings: Record<string, unknown> = {},
  ) => {
    const page = await rig.open(undefined, {
      before: async (p) => {
        const fx = await dictationFixture(p, { platform, grants });
        // The app's defaults: the read-back is on and learning asks (the rig's first value is off).
        fx.settings["dictation.readField"] = true;
        fx.settings["dictation.learn"] = "ask";
        Object.assign(fx.settings, settings);
      },
    });
    await page.click("#dictation-open");
    await page.waitForSelector("#page-dictation div.pg-row[data-key='dictation.readField']");
    return page;
  };

  test(
    "on macOS without the grant the setting says it waits; with the grant, or on Linux, it does not",
    async () => {
      const denied = await openPage("darwin", { mic: "granted", accessibility: "denied" });
      expect(
        await text(
          denied,
          "#page-dictation div.pg-row[data-key='dictation.readField'] #dictation-read-waiting",
        ),
      ).toContain("Waits for Accessibility access");
      // The controls: the same page with the grant, and Linux, which needs none.
      const granted = await openPage("darwin", { mic: "granted", accessibility: "granted" });
      expect(await granted.locator("#dictation-read-waiting").count()).toBe(0);
      // On Linux `accessibility` says whether a keyboard is readable, which the read-back never needs.
      const linux = await openPage("linux", { mic: "granted", accessibility: "denied" });
      expect(await linux.locator("#dictation-read-waiting").count()).toBe(0);
      // With the read-back off, or learning off (main then reads no field), nothing waits.
      const noRead = await openPage(
        "darwin",
        { mic: "granted", accessibility: "denied" },
        { "dictation.readField": false },
      );
      expect(await noRead.locator("#dictation-read-waiting").count()).toBe(0);
      const noLearn = await openPage(
        "darwin",
        { mic: "granted", accessibility: "denied" },
        { "dictation.learn": "off" },
      );
      expect(await noLearn.locator("#dictation-read-waiting").count()).toBe(0);
    },
    UI_TIMEOUT,
  );

  test(
    "the note follows the read-back and learning settings as they change on the page",
    async () => {
      const page = await openPage("darwin", { mic: "granted", accessibility: "denied" });
      const note = page.locator("#dictation-read-waiting");
      const box = "#page-dictation input[data-key='dictation.readField']";
      const learn = (v: string) =>
        `#page-dictation div.pg-row[data-key='dictation.learn'] label:has(input[data-value='${v}'])`;
      const help =
        "#page-dictation div.pg-row[data-key='dictation.readField'] .pg-lbl > div.pg-help";
      expect(await note.count()).toBe(1);
      // One line of help at most: the note replaces the help.
      expect(await page.isVisible(help)).toBe(false);
      await page.click(box);
      expect(await note.count()).toBe(0);
      expect(await page.isVisible(help)).toBe(true);
      await page.click(box);
      expect(await note.count()).toBe(1);
      await page.click(learn("off"));
      expect(await note.count()).toBe(0);
      await page.click(learn("ask"));
      expect(await note.count()).toBe(1);
    },
    UI_TIMEOUT,
  );
});

describe("DC-U4: reading the microphones", () => {
  // `readMics` makes one request; nothing else of a transport is reached.
  const answering = (status: number, body: unknown) =>
    ({ kind: "browser", request: async () => ({ status, body }) }) as unknown as Transport;
  test("a body without a list of inputs is a reason beside the text box, never a throw", async () => {
    for (const body of [{ inputs: {} }, { inputs: "mic" }, {}, null]) {
      expect(await readMics(answering(200, body))).toEqual({
        error: "akou's answer lists no microphones",
      });
    }
    // Positive control: a list is read, less the entries with no id or name.
    const inputs = [{ id: "m1", name: "Desk Mic" }, { id: "", name: "x" }, { name: "y" }];
    expect(await readMics(answering(200, { inputs }))).toEqual({
      inputs: [{ id: "m1", name: "Desk Mic" }],
    });
  });
});

describe("DC-U5: the Words page reads the vocabulary of the call on screen", () => {
  /** A transport that answers each path as `answers` says, recording the paths asked. */
  const answering = (answers: Record<string, { status: number; body: unknown }>) => {
    const asked: string[] = [];
    const t = {
      kind: "browser",
      request: async (_m: string, path: string) => {
        asked.push(path);
        return answers[path] ?? { status: 404, body: {} };
      },
    } as unknown as Transport;
    return { t, asked };
  };
  const words = {
    status: 200,
    body: {
      entries: [
        { term: "Vercel", heard: [], confirmed: true, scope: "global", file: "/c/vocabulary.yaml" },
      ] as DictionaryEntry[],
    },
  };

  test("a call folder named so the vocabulary refuses it as a workspace still shows the global words", async () => {
    const a = answering({
      "/vocab?workspace=con": { status: 400, body: { message: 'invalid workspace "con"' } },
      "/vocab": words,
    });
    expect(await readVocab(a.t, "con")).toEqual(words);
    expect(a.asked).toEqual(["/vocab?workspace=con", "/vocab"]);
    // The control: a workspace the vocabulary takes is read once, as it is.
    const b = answering({ "/vocab?workspace=work": words });
    expect(await readVocab(b.t, "work")).toEqual(words);
    expect(b.asked).toEqual(["/vocab?workspace=work"]);
  });
});

describe("DC-U4, DC-U7: the microphone picker and the sounds on the Dictation page", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-mic-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  const MICS: CaptureInput[] = [
    { id: "mic-builtin", name: "Built-in Microphone", default: true, transport: "built-in" },
    { id: "mic-usb", name: "Desk Mic", transport: "usb" },
    { id: "mic-bt", name: "Headset", transport: "bluetooth" },
  ];
  const mic = "#page-dictation [data-key='dictation.mic']:not(div)";
  const options = (page: Page) =>
    page.$$eval(`${mic} option`, (o) =>
      o.map((x) => [(x as HTMLOptionElement).value, x.textContent]),
    );
  const openPage = async (o: { devices?: DevicesFixture; settings?: Record<string, unknown> }) => {
    let fx: DictationFixture | null = null;
    const page = await rig.open(undefined, {
      before: async (p) => {
        fx = await dictationFixture(p, { devices: o.devices });
        Object.assign(fx.settings, o.settings);
      },
    });
    await page.click("#dictation-open");
    await page.waitForSelector(mic);
    return { page, fx: fx as unknown as DictationFixture };
  };

  test(
    "lists the inputs with System default first and the transport beside each; a choice saves dictation.mic alone",
    async () => {
      const { page, fx } = await openPage({ devices: MICS });
      expect(await page.$eval(mic, (e) => e.tagName)).toBe("SELECT");
      expect(await options(page)).toEqual([
        ["", "System default, Built-in Microphone"],
        ["mic-builtin", "Built-in Microphone (built-in)"],
        ["mic-usb", "Desk Mic (USB)"],
        ["mic-bt", "Headset (Bluetooth)"],
      ]);
      expect(await page.inputValue(mic)).toBe("");
      expect(fx.patches).toEqual([]);

      await page.selectOption(mic, "mic-usb");
      await until(() => fx.patches.length === 1, 5000, "the mic saved");
      await page.selectOption(mic, "");
      await until(() => fx.patches.length === 2, 5000, "the default saved");
      expect(fx.patches).toEqual([{ "dictation.mic": "mic-usb" }, { "dictation.mic": "" }]);
    },
    UI_TIMEOUT,
  );

  test(
    "a saved mic that is not plugged in stays chosen, marked, and is never replaced by opening the page",
    async () => {
      const { page, fx } = await openPage({
        devices: MICS,
        settings: { "dictation.mic": "mic-gone" },
      });
      expect(await page.inputValue(mic)).toBe("mic-gone");
      expect((await options(page)).at(-1)).toEqual(["mic-gone", "mic-gone (not connected)"]);
      await page.click("#calls-open");
      await page.click("#dictation-open");
      await page.waitForSelector(mic);
      expect(await page.inputValue(mic)).toBe("mic-gone");
      expect(fx.patches).toEqual([]);
    },
    UI_TIMEOUT,
  );

  test(
    "with no list the field stays a text box with the reason: an app without the route, a refusal",
    async () => {
      // Positive control for the picker: this app has no `GET /devices` yet, and answers 404.
      const bare = await openPage({ settings: { "dictation.mic": "mic-usb" } });
      expect(await bare.page.$eval(mic, (e) => e.tagName)).toBe("INPUT");
      expect(await bare.page.inputValue(mic)).toBe("mic-usb");
      expect(await text(bare.page, "#dictation-mic-note")).toBe(
        "Type a device id: this akou does not list its microphones yet.",
      );
      await bare.page.fill(mic, "mic-bt");
      await bare.page.press(mic, "Tab");
      await until(() => bare.fx.patches.length === 1, 5000, "the typed id saved");
      expect(bare.fx.patches).toEqual([{ "dictation.mic": "mic-bt" }]);

      const refused = await openPage({
        devices: { status: 503, message: "the capture helper is in file-only mode" },
      });
      expect(await refused.page.$eval(mic, (e) => e.tagName)).toBe("INPUT");
      expect(await text(refused.page, "#dictation-mic-note")).toBe(
        "Type a device id: the capture helper is in file-only mode.",
      );
      // A browser cannot hear the helper, so it shows no meter.
      expect(await refused.page.$("#dictation-mic-level")).toBeNull();
    },
    UI_TIMEOUT,
  );

  test(
    "in the window the meter beside the picker moves on the helper's level while the page is open",
    async () => {
      const w = await windowPage(rig, { devices: MICS });
      try {
        const p = w.page;
        const asked = () =>
          w.requests.filter((r) => r.name === "watchDictationMic").map((r) => r.params);
        await p.click("#dictation-open");
        await p.waitForSelector("#dictation-mic-level");
        expect(
          await p.$eval(
            "#dictation-mic-level",
            (m) => (m.nextElementSibling as HTMLElement).dataset.key,
          ),
        ).toBe("dictation.mic");
        await until(() => asked().length === 1, 5000, "the meter asked");
        expect(asked()).toEqual([{ on: true }]);
        const meter = () => p.$eval("#dictation-mic-level", (m) => (m as HTMLMeterElement).value);
        expect(await meter()).toBe(-60);
        await w.send("dictationLevel", { db: -24 });
        expect(await meter()).toBe(-24);
        await w.send("dictationLevel", { db: -38 });
        expect(await meter()).toBe(-38);

        // Leaving the page lets go of the mic.
        await p.click("#calls-open");
        await until(() => asked().length === 2, 5000, "the meter stopped");
        expect(asked()).toEqual([{ on: true }, { on: false }]);
      } finally {
        await w.close();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "the sounds row says what auto does now, following the pill, and warns when nothing shows",
    async () => {
      const { page, fx } = await openPage({});
      const now = () => text(page, "#dictation-sounds-now");
      const pick = (key: string, v: string) =>
        page.click(
          `#page-dictation div.pg-row[data-key='${key}'] label:has(input[data-value='${v}'])`,
        );
      expect(fx.settings["dictation.sounds"]).toBe("auto");
      expect(fx.settings["dictation.pill"]).toBe("bottom");
      // Silent while the pill shows is what the help says: no second line.
      const help = "#page-dictation div.pg-row[data-key='dictation.sounds'] .pg-lbl > div.pg-help";
      expect(await now()).toBe("");
      expect(await page.isVisible(help)).toBe(true);
      await pick("dictation.pill", "off");
      expect(await now()).toBe("Now soft sounds, since the pill is off.");
      // One line of help at most: the news replaces the help.
      expect(await page.isVisible(help)).toBe(false);
      await pick("dictation.sounds", "off");
      expect(await now()).toBe("Now a dictation neither shows nor sounds.");
      await pick("dictation.sounds", "click");
      expect(await now()).toBe("");
      await until(() => fx.patches.length === 3, 5000, "each change saved");
      expect(fx.patches).toEqual([
        { "dictation.pill": "off" },
        { "dictation.sounds": "off" },
        { "dictation.sounds": "click" },
      ]);
    },
    UI_TIMEOUT,
  );
});
