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
import { NEXT_APP_LABEL, NEXT_APP_WAITING } from "../../src/ui/dictation-apps.ts";
import { CHIP_ASK_MS, CHIP_UNDO_MS } from "../../src/ui/dictation-chip.ts";
import type { DictionaryEntry } from "../../src/ui/dictation-dictionary.ts";
import { type DictationRow, HISTORY_PAGE } from "../../src/ui/dictation-history.ts";
import { type CaptureInput, readMics } from "../../src/ui/dictation-mic.ts";
import {
  DICTATION_GROUPS,
  type DictationGrants,
  ENABLE_KEY,
  onDictationPage,
} from "../../src/ui/dictation-page.ts";
import type { DraftOpen } from "../../src/ui/dictation-protocol.ts";
import { HOLD_ALONE_MS } from "../../src/ui/dictation-recorder.ts";
import { lowMarks, shiftMarks } from "../../src/ui/draft.ts";
import { PREVIEW_CHARS, previewParts } from "../../src/ui/pill.ts";
import { type PillState, pillPreview } from "../../src/ui/pill-protocol.ts";
import type { Transport } from "../../src/ui/protocol.ts";
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
    "[DC-O2] the preview ticks the words in one line while listening, only the tail when long, and never after",
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

      const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
      await v.send("preview", { text: long });
      const tail = await shown();
      expect(tail.startsWith("…word")).toBe(true);
      expect(tail.endsWith("word39")).toBe(true);
      expect(tail.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
      // One line, the newest word at the right edge of the ticker.
      const box = await p.$eval("#preview", (e) => {
        const r = e.getBoundingClientRect();
        const w = (e.firstElementChild as HTMLElement).getBoundingClientRect();
        return {
          lines: r.height / Number.parseFloat(getComputedStyle(e).lineHeight),
          right: r.right,
          wordsRight: w.right,
        };
      });
      expect(Math.round(box.lines)).toBe(1);
      expect(Math.abs(box.right - box.wordsRight)).toBeLessThan(1);

      // Listening ends: the words go, and a partial arriving late is dropped.
      await state({ state: "transcribing", since });
      expect(await visible(p, "#preview")).toBe(false);
      expect(await onPage("word39")).toBe(false);
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
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const upTo38 = long.lastIndexOf(" word39");
    const parts = previewParts(long, upTo38);
    expect(parts.settled.startsWith("…word")).toBe(true);
    expect(parts.changing).toBe(" word39");
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
      await page.waitForSelector("#dictation fieldset[data-group='Engine'] #dictation-languages");
      const chips = () =>
        page.$$eval("#dictation-languages .language-chip", (l) =>
          l.map((x) => (x as HTMLElement).dataset.code),
        );
      expect(await chips()).toEqual(["en"]);
      // The text box stays the saved value, out of sight.
      expect(await page.isHidden("#dictation textarea[data-key='dictation.languages']")).toBe(true);
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
        "Per app",
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
    "on the real registry: every group, every dictation key, and a change saved as that key alone",
    async () => {
      // No fixture: the keys, the values and the save are the app's own.
      const page = await rig.open();
      const patches: unknown[] = [];
      page.on("request", (r) => {
        if (r.method() === "PATCH" && r.url().endsWith("/config")) patches.push(r.postDataJSON());
      });
      await page.click("#dictation-open");
      await page.waitForSelector("#dictation fieldset[data-group='Keys']", { state: "visible" });
      const groups = await page.$$eval("#dictation fieldset", (g) =>
        g.map((x) => x.getAttribute("data-group")),
      );
      expect(groups).toEqual(DICTATION_GROUPS.map((g) => g.title));
      // Settings hides every dictation key, so each must be here, and the page names none the
      // registry lacks.
      const keys = await page.$$eval("#dictation [data-key]:not(div)", (e) =>
        e.map((x) => (x as HTMLElement).dataset.key),
      );
      const registry = Object.keys(SETTINGS).filter((k) => k.startsWith("dictation."));
      expect(registry.filter((k) => !keys.includes(k))).toEqual([]);
      expect(keys.sort()).toEqual(
        [ENABLE_KEY, ...DICTATION_GROUPS.flatMap((g) => g.keys)]
          .filter((k) => k in SETTINGS)
          .sort(),
      );
      expect(DICTATION_GROUPS.flatMap((g) => g.keys).filter((k) => !(k in SETTINGS))).toEqual([]);

      const days = "#dictation [data-key='dictation.retainDays']:not(div)";
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
    "the Settings page leaves the dictation keys out; the sidebar and #dictation open the page",
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
      await page.waitForSelector("#dictation[open]");
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
      await page.waitForSelector("#dictation [data-empty]");
      expect(await page.$$("#dictation fieldset")).toEqual([]);
      await page.click("#dictation-close");
      await page.click("#settings-open");
      await page.waitForSelector("#page-settings .pg-row[data-key]");
      expect(await page.$("#page-settings [data-key^='dictation.']")).toBeNull();
    },
    UI_TIMEOUT,
  );
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

  /** Opens the Dictionary from the Dictation page; with `entries`, over the vocabulary fixture. */
  const openDictionary = async (entries?: DictionaryEntry[]) => {
    let fx: VocabFixture | null = null;
    const page = await rig.open(undefined, {
      before: async (p) => {
        if (entries) fx = await vocabFixture(p, entries);
      },
    });
    await page.click("#dictation-open");
    await page.click("#dictation-dictionary-open");
    await page.waitForSelector("#dictation-dictionary[open] #dictionary-list li");
    return { page, fx: fx as unknown as VocabFixture };
  };
  const row = (term: string) => `#dictionary-list li[data-term='${term}']`;
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
      expect(await text(page, "#dictionary-list li")).toBe(
        "No words yet. Add one above, or import a list.",
      );
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
      expect(await text(page, `${row(".com")} .where`)).toBe("dictation only");
      expect(await page.inputValue("#dictionary-term")).toBe("");

      // A word alone, with no way of saying it.
      await page.fill("#dictionary-term", "Kubernetes");
      await page.click("#dictionary-add");
      await page.waitForSelector(row("Kubernetes"));
      expect(fx.calls.at(-1)?.body).toEqual({ term: "Kubernetes", heard: [], scope: "dictation" });
      expect(await page.$(`${row("Kubernetes")} .heard`)).toBeNull();

      fx.calls.length = 0;
      await page.click(`${row(".com")} button.remove`);
      await page.waitForSelector(row(".com"), { state: "detached" });
      expect(fx.calls).toEqual([{ method: "DELETE", path: "/vocab/.com" }]);
    },
    UI_TIMEOUT,
  );

  test(
    "more forms keep a term's spelling, forms and scope; Use in calls too drops the scope; another file's word is read only; a refusal shows",
    async () => {
      const { page, fx } = await openDictionary([
        global({ term: "Vercel", heard: ["versal"] }),
        global({ term: "Kubernetes", heard: ["cooper netties"], entryScope: "dictation" }),
        { term: "Acme", heard: [], confirmed: false, scope: "extra", file: "/team/words.yaml" },
      ]);
      expect(await text(page, `${row("Vercel")} .where`)).toBe("calls and dictation");
      expect(await text(page, `${row("Kubernetes")} .where`)).toBe("dictation only");
      expect(await text(page, `${row("Acme")} .where`)).toBe(
        "calls and dictation, waiting for your yes, from /team/words.yaml",
      );
      expect(await page.$$(`${row("Acme")} button`)).toHaveLength(0);
      expect(await page.$(`${row("Vercel")} button.calls-too`)).toBeNull();

      // A calls entry stays one: no scope is added to it, and its first form is kept.
      await page.fill("#dictionary-heard", "for sell, Versal");
      await page.fill("#dictionary-term", "vercel");
      await page.click("#dictionary-add");
      await until(() => fx.calls.length === 1, 5000, "the save");
      expect(fx.calls[0]?.body).toEqual({
        term: "Vercel",
        heard: ["versal", "for sell"],
        confirmed: true,
      });

      await page.click(`${row("Kubernetes")} button.calls-too`);
      await until(() => fx.calls.length === 2, 5000, "calls too");
      expect(fx.calls[1]?.body).toEqual({
        term: "Kubernetes",
        heard: ["cooper netties"],
        confirmed: true,
      });
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.textContent === "calls and dictation",
        `${row("Kubernetes")} .where`,
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
      await page.waitForSelector(`${row("Vercel")} button.calls-too`);
      await page.click(`${row("Vercel")} button.calls-too`);
      await until(() => fx.calls.length === 2, 5000, "calls too");
      await page.waitForFunction(
        (sel) =>
          document.querySelector(sel)?.textContent === "calls and dictation, waiting for your yes",
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
    "Settings opens the same dictionary rather than a second list of words",
    async () => {
      const page = await rig.open();
      await page.click("#settings-open");
      await page.waitForSelector("#page-settings .pg-row[data-key]");
      // Your words are under Word lists, one row that opens the dictionary.
      await page.click("#settings-go-words");
      await page.waitForSelector("#settings-dictionary");
      expect(await page.$$("#page-settings li, #page-settings table")).toHaveLength(0);
      await page.click("#settings-dictionary");
      await page.waitForSelector("#dictation-dictionary[open] #dictionary-list li");
      expect(await page.$$("#dictionary-form")).toHaveLength(1);
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
      await page.waitForFunction(
        () => document.querySelectorAll("#dictionary-list li[data-term]").length === 200,
      );
      const r = await rig.api("GET", "/vocab");
      const got = r.body.entries as DictionaryEntry[];
      expect(got.map((e) => e.term)).toEqual(lines);
      expect(got.filter((e) => e.entryScope !== "dictation").map((e) => e.term)).toEqual([
        "Term000",
      ]);
      expect(await text(page, `${row("Term001")} .where`)).toBe("dictation only");
      expect(await text(page, `${row("Term000")} .where`)).toBe("calls and dictation");
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

  const rows = "#dictation fieldset[data-group='Per app'] .apps-rules tbody tr";
  const cell = (n: number, field: string) => `${rows}:nth-child(${n}) [data-field='${field}']`;

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
      expect(await page.inputValue(cell(1, "app"))).toBe("com.example.term");
      expect(await page.inputValue(cell(1, "insert"))).toBe("type");
      expect(await page.inputValue(cell(1, "sendKey"))).toBe("none");
      // A field the rule leaves out follows the global setting.
      expect(await page.inputValue(cell(1, "mode"))).toBe("");
      expect(await text(page, `${cell(1, "mode")} option:checked`)).toBe("global");

      // The table fits the dialog: no column clipped, Remove reachable without scrolling sideways.
      const fit = await page.$eval("#dictation", (d) => {
        const remove = d.querySelector(".apps-remove") as HTMLElement;
        const spill = [...d.querySelectorAll<HTMLElement>(".apps-rules tbody td > *")].filter(
          (el) =>
            el.getBoundingClientRect().right >
            (el.parentElement as HTMLElement).getBoundingClientRect().right + 0.5,
        );
        return {
          overflow: d.scrollWidth - d.clientWidth,
          removeInside: remove.getBoundingClientRect().right <= d.getBoundingClientRect().right,
          spill: spill.map((el) => el.dataset.field ?? el.className),
        };
      });
      expect(fit).toEqual({ overflow: 0, removeInside: true, spill: [] });

      // Picking the value a field already holds is no edit, whatever order the file has the keys in.
      await page.selectOption(cell(1, "insert"), "type");

      // A new row saves nothing until it names its app.
      await page.click("#dictation .apps-add");
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
      await page.fill(cell(1, "language"), "english");
      await page.press(cell(1, "language"), "Tab");
      await page.waitForSelector("#dictation div.setting.refused[data-key='dictation.apps']");
      expect(
        await text(page, "#dictation div.setting.refused[data-key='dictation.apps'] .issue"),
      ).toBe("dictation.apps: rule 1: language must be auto or an ISO 639 code");
      expect(f.patches).toHaveLength(4);
      expect(f.patches[3]).toEqual({
        "dictation.apps": [{ app: "com.example.chat", language: "english" }],
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
      const next = "#dictation .apps-next";
      const note = "#dictation .apps-next-note";
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
      await page.click(`#dictation input[data-key='${ENABLE_KEY}']`);
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
      await page.click("#dictation .apps-next");
      await page.waitForFunction(
        (sel) =>
          document.querySelector(sel)?.textContent === "dictation runs in the desktop app only",
        "#dictation .apps-next-note",
      );
      expect(await text(page, "#dictation .apps-next")).toBe(NEXT_APP_LABEL);
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
      await page.click("#dictation .apps-next");
      expect(await text(page, "#dictation .apps-next-note")).toBe(NEXT_APP_WAITING);
      const d = rig.app.dictation();
      if (!d) throw new Error("no dictation");
      await d.rebind();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll<HTMLInputElement>("#dictation [data-field='app']")].some(
            (el) => el.value === "com.example.chat",
          ),
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

  const toggle = "#dictation .dictation-enable input[data-key='dictation.enabled']";
  const step = (page: Page, s: string) =>
    page.waitForSelector(`#dictation .dictation-setup[data-step='${s}']`);
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
          "Dictation stays off: akou has no access to the microphone.",
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
          await p.$$eval("#dictation .dictation-setup .keycaps kbd", (k) =>
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
        await p.waitForSelector("#dictation fieldset[data-group='Keys']");
        expect(await p.isChecked(toggle)).toBe(true);
        expect(await text(p, "#dictation-permissions")).toBe(
          "Permissions: Microphone ok, Accessibility ok. Run the setup again",
        );
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
      expect(await text(page, "#dictation-permissions")).toBe(
        "Permissions: Microphone ok, Accessibility not granted (clipboard only). Run the setup again",
      );
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
      const key = "#dictation .dictation-setup input[data-key='dictation.hotkey']";
      expect(await page.inputValue(key)).toBe("Control+Shift+Space");
      expect(await text(page, "#dictation-setup-note")).toContain("takes chords only");
      await page.click("#dictation .dictation-setup button.record-key");
      await page.keyboard.down("MetaRight");
      await page.waitForTimeout(HOLD_ALONE_MS + 100);
      await page.keyboard.up("MetaRight");
      expect(await text(page, "#dictation .dictation-setup .recorder-note")).toContain(
        "Right ⌘ alone cannot be bound",
      );
      expect(fx.patches).toEqual([]);

      // A refusal keeps the step, with the reason; the next try turns dictation on.
      fx.refuse.set("dictation.enabled", "the helper did not start");
      await page.click("#dictation-setup-next");
      await page.waitForSelector("#dictation-setup-issue:not([hidden])");
      expect(await text(page, "#dictation-setup-issue")).toBe(
        "dictation.enabled: the helper did not start",
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
        "Dictation stays off: akou has no access to the microphone.",
      );
      await page.click(toggle);
      await step(page, "mic");
      expect(await page.isChecked(toggle)).toBe(false);
      expect(await page.isVisible("#dictation-setup-open-microphone")).toBe(true);
      expect(await page.$("#dictation-setup-next")).toBeNull();
      await page.click("#dictation-setup-cancel");
      await page.waitForSelector("#dictation fieldset[data-group='Keys']");
      expect(await page.isChecked(toggle)).toBe(false);
      expect(fx.patches).toEqual([]);

      // With every grant there, the switch saves at once (positive control for the intercept).
      fx.grants = { mic: "granted", accessibility: "granted" };
      await page.click("#dictation-setup-open");
      await step(page, "mic");
      await page.click("#dictation-setup-cancel");
      await page.waitForSelector("#dictation fieldset[data-group='Keys']");
      await page.click(toggle);
      await until(() => fx.patches.length === 1, 5000, "the switch saved");
      expect(fx.patches).toEqual([{ "dictation.enabled": true }]);
      expect(await page.$("#dictation .dictation-setup")).toBeNull();
    },
    UI_TIMEOUT,
  );

  test(
    "the languages step: a refused or failed save says why and keeps the step, then saves once",
    async () => {
      const { page, fx } = await browserPage({ mic: "granted", accessibility: "granted" });
      await page.click("#dictation-setup-open");
      await step(page, "mic");
      await page.click("#dictation-setup-next");
      await step(page, "languages");
      fx.refuse.set("dictation.languages", "is a list of ISO 639 codes");
      await page.click("#dictation-setup-next");
      await page.waitForSelector("#dictation-setup-issue:not([hidden])");
      expect(await text(page, "#dictation-setup-issue")).toBe(
        "dictation.languages: is a list of ISO 639 codes",
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
      const toggle = "#dictation .dictation-enable input[data-key='dictation.enabled']";
      const page = await rig.open();
      await page.click("#dictation-open");
      await page.waitForSelector(toggle);
      expect(await text(page, "#dictation-off-reason")).toBe(
        "Dictation stays off: akou has no access to the microphone.",
      );
      await page.click(toggle);
      await page.waitForSelector("#dictation .dictation-setup[data-step='mic']");
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
      const toggle = "#dictation .dictation-enable input[data-key='dictation.enabled']";
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
      expect(await page.locator("#dictation .dictation-setup").count()).toBe(0);
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
        dictationRow(2, {
          state: "cancelled",
          app: null,
          engine: "best",
          ms: 640,
          language: "es",
        }),
        dictationRow(3, { state: "failed", text: null, error: "remote akou not reachable" }),
      ]);
      expect(
        await page.$$eval("#dictation-history-list li", (l) => l.map((x) => x.dataset.id)),
      ).toEqual(["d001", "d002", "d003"]);
      expect(await text(page, `${row("d001")} .text`)).toBe("dictation number 1");
      const meta = await text(page, `${row("d002")} .meta`);
      expect(meta).toContain("no app · best 0.6 s · ES · cancelled");
      // A dictation with no language named says none (positive control).
      expect(await text(page, `${row("d001")} .meta`)).not.toContain(" · EN");
      expect(await page.$(`${row("d001")} .language`)).toBeNull();
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

      // A best that could not run is decoded by fast, and the reading says so.
      fx.retry = (d, engine) => ({ ...d, engine: "fast", fallback_from: engine, ms: 120 });
      await page.selectOption(`${row("d001")} select.retry-engine`, "best");
      await page.click(`${row("d001")} button.retry`);
      await page.waitForFunction(
        (sel) => document.querySelector(sel)?.textContent === "fast 0.1 s (instead of best)",
        `${row("d001")} .result.retry small`,
      );
    },
    UI_TIMEOUT,
  );

  test(
    "deleting the last dictation shown says there are none",
    async () => {
      const { page } = await openHistory([dictationRow(1)]);
      await page.click(`${row("d001")} button.delete`);
      await page.click(`${row("d001")} button.delete`);
      await page.waitForSelector("#dictation-history-list li[data-empty]");
      expect(await text(page, "#dictation-history-list li")).toBe("No dictations yet.");
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
    await page.waitForSelector("#dictation-dictionary[open] #dictionary-list li[data-term]");
    return page;
  };
  const term = (x: string) => `#dictionary-list li[data-term='${x}']`;

  test(
    "dot com to .com is written for dictation only, and the next dictation of example dot com inserts example.com",
    async () => {
      const page = await openDictionary();
      await page.fill("#dictionary-heard", "dot com");
      await page.fill("#dictionary-term", ".com");
      await page.click("#dictionary-add");
      await page.waitForSelector(term(".com"));
      expect(await text(page, `${term(".com")} .where`)).toBe("dictation only");
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
        (sel) => document.querySelector(sel)?.textContent === "versal, ver sell",
        `${term("Vercel")} .heard`,
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
      expect(await text(page, `${row} .state`)).toBe("inserted");
      expect(await page.inputValue(`${row} select.retry-engine`)).toBe("best");

      await page.click(`${row} button.retry`);
      await page.waitForSelector(`${row} .result.retry`);
      const readings = await page.$$eval(`${row} .result`, (r) =>
        r.map((x) => [x.getAttribute("data-engine"), x.querySelector(".text")?.textContent]),
      );
      expect(readings).toEqual([
        ["fast", "example.com"],
        ["best", "example.com"],
      ]);

      await page.click(`${row} .result.retry button.insert`);
      await page.click(`${row} .result.first button.insert`);
      await until(() => draftOpens.length === 2, 5000, "both inserts open the draft box");
      expect(draftOpens.map((o) => [o.id, o.text, o.focus])).toEqual([
        [id, "example.com", true],
        [id, "example.com", true],
      ]);

      const audio = d.audio.path(id);
      expect(existsSync(audio)).toBe(true);
      await page.click(`${row} button.delete`);
      await page.click(`${row} button.delete`);
      await page.waitForSelector(row, { state: "detached" });
      expect(existsSync(audio)).toBe(false);
      expect((await rig.api("GET", `/dictations/${id}`)).status).toBe(404);
    },
    UI_TIMEOUT,
  );

  test(
    "on a call, the Dictionary lists that workspace's words read only, with their file, as words for its calls",
    async () => {
      const page = await openDictionary("01J8Z6Q4M2VX0K7B3D4E5F6G7H");
      await page.waitForSelector(term("Hetzner"));
      expect(await text(page, `${term("Hetzner")} .where`)).toBe(
        `calls in work only, from ${join(rig.app.configDir, "vocabulary", "work.yaml")}`,
      );
      expect(await page.isVisible(`${term("Hetzner")} button.remove`)).toBe(false);
      // The global file's words keep their buttons (positive control).
      expect(await page.isVisible(`${term("Vercel")} button.remove`)).toBe(true);
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
      const { page, fx } = await openPage({ grants: { mic: "granted", accessibility: "denied" } });
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
      await page.click("#dictation-history-open");
      await page.waitForSelector("#dictation-history[open]");
      expect(await page.getAttribute(record("dictation.hotkey"), "aria-pressed")).toBe("false");
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
    await page.waitForSelector("#dictation div.setting[data-key='dictation.readField']");
    return page;
  };

  test(
    "on macOS without the grant the setting says it waits; with the grant, or on Linux, it does not",
    async () => {
      const denied = await openPage("darwin", { mic: "granted", accessibility: "denied" });
      expect(
        await text(
          denied,
          "#dictation div.setting[data-key='dictation.readField'] #dictation-read-waiting",
        ),
      ).toContain("Waiting for the Accessibility grant");
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
      const box = "#dictation input[data-key='dictation.readField']";
      const learn = "#dictation [data-key='dictation.learn']:not(div)";
      expect(await note.count()).toBe(1);
      await page.click(box);
      expect(await note.count()).toBe(0);
      await page.click(box);
      expect(await note.count()).toBe(1);
      await page.selectOption(learn, "off");
      expect(await note.count()).toBe(0);
      await page.selectOption(learn, "ask");
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
  const mic = "#dictation [data-key='dictation.mic']:not(div)";
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
        ["", "System default (Built-in Microphone (built-in))"],
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
      await page.click("#dictation-close");
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
            (m) => (m.previousElementSibling as HTMLElement).dataset.key,
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

        // Closing the page lets go of the mic.
        await p.click("#dictation-close");
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
        page.selectOption(`#dictation [data-key='${key}']:not(div)`, v);
      expect(fx.settings["dictation.sounds"]).toBe("auto");
      expect(fx.settings["dictation.pill"]).toBe("bottom");
      expect(await now()).toBe("Now: silent, since the pill shows.");
      await pick("dictation.pill", "off");
      expect(await now()).toBe("Now: soft sounds, since the pill is off.");
      await pick("dictation.sounds", "off");
      expect(await now()).toBe("Now: a dictation neither shows nor sounds.");
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
