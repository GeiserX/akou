/**
 * The transcript and the player (docs/ux/WINDOW.md W4.2, W4.4, W5.3 to W5.6) on the real page in
 * a headless browser: provisional live speaker chips, the line menu by mouse and by keyboard, the
 * wall-time scrubber, playback speed, 5 s seeks, and the transcript following the audio.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { formatWall } from "../../src/core/log/clock.ts";
import { stereoWav } from "../fixtures/audio.ts";
import type { LogBuilder } from "../helpers.ts";
import { tempDir } from "../helpers.ts";
import { seedCall, standardCall, T0, TZ, UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

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

const text = (page: Page, sel: string) => page.locator(sel).first().textContent();

/** Silent stereo audio of `seconds` for part 1 of a seeded call. */
async function audio(rig: UiRig, id: string, seconds: number): Promise<void> {
  const folder = (await rig.api("GET", `/calls/${id}`)).body.folder as string;
  const n = 16000 * seconds;
  writeFileSync(
    join(folder, "audio", "part-001.opus"),
    stereoWav(new Float32Array(n), new Float32Array(n)),
  );
}

const player = (page: Page) =>
  page.evaluate(() => {
    const p = document.getElementById("player") as HTMLAudioElement;
    return { paused: p.paused, at: p.currentTime, rate: p.playbackRate, line: p.dataset.line };
  });

/** Plays a row from its own Play button and waits for its audio to load. */
async function playRow(page: Page, lid: string): Promise<void> {
  await page.hover(`#lines .row[data-id="${lid}"]`);
  await page.click(`#lines .row[data-id="${lid}"] .play`);
  await until(
    async () =>
      await page.evaluate((l) => {
        const p = document.getElementById("player") as HTMLAudioElement;
        return p.dataset.line === l && p.readyState >= 1;
      }, lid),
    8000,
    "the line's audio",
  );
}

/** Pauses the player and waits for its `pause` event, so every listener has run. */
const pauseNow = (page: Page) =>
  page.evaluate(async () => {
    const p = document.getElementById("player") as HTMLAudioElement;
    if (p.paused) return p.currentTime;
    const done = new Promise((r) => p.addEventListener("pause", r, { once: true }));
    p.pause();
    await done;
    return p.currentTime;
  });

/** Moves the player to `t` seconds and waits for `seeked`. */
const seekTo = (page: Page, t: number) =>
  page.evaluate(async (to) => {
    const p = document.getElementById("player") as HTMLAudioElement;
    const done = new Promise((r) => p.addEventListener("seeked", r, { once: true }));
    p.currentTime = to;
    await done;
  }, t);

/** One part of `n` call lines, one second each: enough to scroll. */
function manyLines(b: LogBuilder, n: number): void {
  b.created();
  b.partStarted(1, T0);
  for (let i = 0; i < n; i++) {
    b.seg({
      id: `l${String(i + 1).padStart(6, "0")}`,
      ch: "call",
      spk: "c1",
      a0: i,
      a1: i + 1,
      w0: T0 + i * 1000,
      text: `line number ${i + 1} of the call`,
    });
  }
  b.partEnded(1, "stop", n);
  b.add({ type: "call.ended", reason: "stop" });
}

const scrollerTop = (page: Page) =>
  page.evaluate(() => (document.getElementById("scroller") as HTMLElement).scrollTop);

const chip = (page: Page, lid: string) =>
  page.evaluate((l) => {
    const who = document.querySelector(`#lines .row[data-id="${l}"] .who`) as HTMLElement | null;
    return who
      ? {
          label: who.textContent,
          provisional: who.classList.contains("provisional"),
          aria: who.getAttribute("aria-label"),
        }
      : null;
  }, lid);

describe("[W4.2] live speaker labels look provisional until named or final", () => {
  /** Part 1 and part 2, live lines only; the final pass will skip part 2. */
  function twoParts(b: LogBuilder): void {
    b.created();
    b.partStarted(1, T0);
    b.seg({ id: "l000001", ch: "mic", spk: "you", w0: T0 + 1000, text: "hello everyone" });
    b.seg({ id: "l000002", ch: "call", spk: "c1", w0: T0 + 3000, text: "we should move" });
    b.seg({ id: "l000003", ch: "call", spk: "c2", w0: T0 + 6000, text: "which region" });
    b.partEnded(1, "restart", 10);
    b.partStarted(2, T0 + 20_000);
    b.seg({ id: "l000004", part: 2, ch: "call", spk: "c3", w0: T0 + 21_000, text: "part two" });
    b.partEnded(2, "stop", 10);
    b.add({ type: "call.ended", reason: "stop" });
  }

  test(
    "a live cluster chip reads c1? and is provisional; a name is solid at once; after final.done the same speaker is solid",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, twoParts).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector('#lines .row[data-id="l000004"]');
        expect(await chip(page, "l000002")).toEqual({
          label: "c1?",
          provisional: true,
          // The accessible name starts with the text shown, so "click c1?" finds it (WCAG 2.5.3).
          aria: "c1? (Speaker 1, a guess until the final pass): rename, merge or unmerge",
        });
        expect((await chip(page, "l000004"))?.label).toBe("c3?");
        // You, on the mic, are never a guess.
        expect(await chip(page, "l000001")).toMatchObject({ label: "Ana", provisional: false });
        // Not by colour alone: the dashed chip and the question mark both say it.
        expect(
          await page.$eval(
            '#lines .row[data-id="l000002"] .who',
            (el) => getComputedStyle(el).borderTopStyle,
          ),
        ).toBe("dashed");

        // A name makes that speaker solid at once, on every row of theirs.
        await rig.api("POST", `/calls/${id}/speakers`, { spk: "c2", name: "Ben" });
        await until(
          async () => (await chip(page, "l000003"))?.label === "Ben",
          5000,
          "the name on the chip",
        );
        expect((await chip(page, "l000003"))?.provisional).toBe(false);
        expect((await chip(page, "l000002"))?.provisional).toBe(true);

        // The final layer of part 1 lands: its lines are the final pass's, solid.
        await rig.write(id, { type: "final.started", pid: 1 });
        await rig.write(id, {
          type: "seg",
          id: "f000001",
          rev: 1,
          layer: "final",
          part: 1,
          ch: "call",
          spk: "c1",
          a0: 3,
          a1: 4,
          w0: T0 + 3000,
          w1: T0 + 3900,
          text: "we should move the build",
          model: "fake",
        });
        await rig.write(id, { type: "final.part.done", part: 1 });
        await page.waitForSelector('#lines .row[data-id="f000001"]');
        expect(await chip(page, "f000001")).toMatchObject({
          label: "Speaker 1",
          provisional: false,
        });
        // Part 2 has no final layer yet, and the pass is not done: still a guess.
        expect(await chip(page, "l000004")).toMatchObject({ label: "c3?", provisional: true });

        // final.done: the pass is over, so the live line it skipped is as good as it gets.
        await rig.write(id, { type: "final.done", parts: [1], skipped: [2] });
        await until(
          async () => (await chip(page, "l000004"))?.label === "Speaker 3",
          5000,
          "the solid chip after final.done",
        );
        expect((await chip(page, "l000004"))?.provisional).toBe(false);

        // The call is reopened after the pass (Call.restart makes part 3): its new live speaker is
        // a guess again, and what the pass finished stays solid.
        await rig.write(id, {
          type: "part.started",
          part: 3,
          file: "audio/part-003.opus",
          wallStart: T0 + 60_000,
          monoStart: 2_000_000,
          mic: "Built-in Microphone",
          call: { mode: "system", exclude: [] },
          capture: "akou-capture 0.1.0",
        });
        await rig.write(id, {
          type: "seg",
          id: "l000005",
          rev: 1,
          layer: "live",
          part: 3,
          ch: "call",
          spk: "c4",
          a0: 1,
          a1: 2,
          w0: T0 + 61_000,
          w1: T0 + 62_000,
          text: "back again",
          model: "fake",
        });
        await page.waitForSelector('#lines .row[data-id="l000005"]');
        expect(await chip(page, "l000005")).toMatchObject({ label: "c4?", provisional: true });
        expect(await chip(page, "l000004")).toMatchObject({
          label: "Speaker 3",
          provisional: false,
        });
        // A second pass starting does not turn the finished lines back into guesses.
        await rig.write(id, { type: "final.started", pid: 2 });
        await rig.write(id, {
          type: "seg",
          id: "l000006",
          rev: 1,
          layer: "live",
          part: 3,
          ch: "call",
          spk: "c4",
          a0: 2,
          a1: 3,
          w0: T0 + 62_000,
          w1: T0 + 63_000,
          text: "still here",
          model: "fake",
        });
        await page.waitForSelector('#lines .row[data-id="l000006"]');
        // A name redraws every row, so each chip is worked out again while the re-run runs.
        await rig.api("POST", `/calls/${id}/speakers`, { spk: "c1", name: "Cleo" });
        await until(
          async () => (await chip(page, "f000001"))?.label === "Cleo",
          5000,
          "every row redrawn with the name",
        );
        expect(await chip(page, "l000004")).toMatchObject({
          label: "Speaker 3",
          provisional: false,
        });
        expect((await chip(page, "l000006"))?.label).toBe("c4?");
      });
    },
    UI_TIMEOUT,
  );
});

describe("[W4.4] every transcript line has a context menu, reachable by keyboard", () => {
  const menu = (page: Page) =>
    page.evaluate(() => {
      const m = document.getElementById("line-menu") as HTMLElement;
      return {
        open: !m.hidden,
        role: m.getAttribute("role"),
        items: [...m.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent),
        focused:
          document.activeElement?.getAttribute("role") === "menuitem"
            ? document.activeElement.textContent
            : null,
      };
    });
  const ITEMS = [
    "Play from here",
    "Copy line",
    "Copy with time and speaker",
    "Name this speaker…",
    "Fix a word…",
  ];
  const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
  const clear = (page: Page) => page.evaluate(() => navigator.clipboard.writeText("before"));

  test(
    "right-click on a line opens its menu, and each item runs its action",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          await audio(rig, id, 12);
          const page = await rig.open(id);
          await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
          await page.waitForSelector("#lines .row >> nth=3");
          const row = '#lines .row[data-id="l000003"] .text';
          const pick = async (label: string) => {
            await page.click(row, { button: "right" });
            expect(await menu(page)).toMatchObject({ open: true, role: "menu", items: ITEMS });
            await page.click(`#line-menu [role="menuitem"] >> text="${label}"`);
            expect((await menu(page)).open).toBe(false);
          };

          await clear(page);
          await pick("Copy line");
          await until(async () => (await clipboard(page)) !== "before", 5000, "the line copied");
          expect(await clipboard(page)).toBe("deploy to hetzner today");

          await clear(page);
          await pick("Copy with time and speaker");
          await until(async () => (await clipboard(page)) !== "before", 5000, "the cited copy");
          expect(await clipboard(page)).toBe(
            `[${formatWall(T0 + 6000, TZ)} Speaker 2] deploy to hetzner today`,
          );

          await pick("Play from here");
          await until(
            async () => (await player(page)).line === "l000003",
            5000,
            "the line playing",
          );
          await pauseNow(page);

          await pick("Name this speaker…");
          await page.waitForSelector("#popover:not([hidden])");
          expect(await page.getAttribute("#popover input", "aria-label")).toBe(
            "Name for Speaker 2",
          );
          await page.keyboard.press("Escape");
          await page.waitForSelector("#popover[hidden]", { state: "attached" });

          await pick("Fix a word…");
          await page.waitForSelector("#popover:not([hidden])");
          expect(await text(page, "#popover h3")).toBe("Fix this word");
          expect(await text(page, "#popover .hint")).toBe("In the line: deploy to hetzner today");
          await page.keyboard.press("Escape");

          // A click anywhere else closes the menu and runs nothing.
          await clear(page);
          await page.click(row, { button: "right" });
          expect((await menu(page)).open).toBe(true);
          await page.click("#scroller", { position: { x: 5, y: 5 } });
          expect((await menu(page)).open).toBe(false);
          expect(await clipboard(page)).toBe("before");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Shift+F10 and the Menu key open the same menu on the focused line; arrows move, Enter runs, Esc closes and gives focus back",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
          await page.waitForSelector("#lines .row >> nth=3");
          const back = () =>
            page.evaluate(() => {
              const a = document.activeElement as HTMLElement | null;
              return {
                row: (a?.closest(".row") as HTMLElement | null)?.dataset.id ?? null,
                play: !!a?.classList.contains("play"),
              };
            });

          await page.focus('#lines .row[data-id="l000002"] .play');
          await page.keyboard.press("Shift+F10");
          expect(await menu(page)).toEqual({
            open: true,
            role: "menu",
            items: ITEMS,
            focused: "Play from here",
          });
          // The platform may send its own contextmenu when the key is let go (WebView2 on the
          // Menu key): it lands on our menu, and the webview's menu must not open over it.
          expect(
            await page.evaluate(() => {
              const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
              document.activeElement?.dispatchEvent(e);
              return e.defaultPrevented;
            }),
          ).toBe(true);
          expect((await menu(page)).focused).toBe("Play from here");
          await page.keyboard.press("ArrowDown");
          expect((await menu(page)).focused).toBe("Copy line");
          await page.keyboard.press("ArrowUp");
          await page.keyboard.press("ArrowUp");
          expect((await menu(page)).focused).toBe("Fix a word…");
          await page.keyboard.press("Home");
          await page.keyboard.press("ArrowDown");
          await clear(page);
          await page.keyboard.press("Enter");
          await until(async () => (await clipboard(page)) !== "before", 5000, "the line copied");
          expect(await clipboard(page)).toBe("we should move the build to the new box");
          expect((await menu(page)).open).toBe(false);
          expect(await back()).toEqual({ row: "l000002", play: true });

          // The Menu key opens it too; Esc closes it and runs nothing.
          await page.keyboard.press("ContextMenu");
          expect((await menu(page)).open).toBe(true);
          await page.keyboard.press("Escape");
          expect((await menu(page)).open).toBe(false);
          expect(await back()).toEqual({ row: "l000002", play: true });

          // Away from the transcript, the key opens nothing.
          await page.focus("#note-input");
          await page.keyboard.press("Shift+F10");
          expect((await menu(page)).open).toBe(false);
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("[W4.4] the line menu stays with its line", () => {
  test(
    "a scroll moves the menu with its line; the line leaving the view, a window blur or a resize close it",
    async () => {
      const N = 40;
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => manyLines(b, N)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector(`#lines .row >> nth=${N - 1}`);
          const row = '#lines .row[data-id="l000020"]';
          const state = () =>
            page.evaluate((sel) => {
              const m = document.getElementById("line-menu") as HTMLElement;
              const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
              return { open: !m.hidden, gap: m.getBoundingClientRect().top - r.top };
            }, row);
          const scrollBy = (dy: number) =>
            page.evaluate((d) => {
              const s = document.getElementById("scroller") as HTMLElement;
              s.scrollTo({ top: s.scrollTop + d, behavior: "instant" });
            }, dy);
          const open = async () => {
            await page.$eval(row, (el) => el.scrollIntoView({ block: "center" }));
            await page.click(`${row} .text`, { button: "right" });
            expect((await state()).open).toBe(true);
          };
          const closes = async (what: string) =>
            await until(async () => !(await state()).open, 5000, `the menu closed by ${what}`);

          await open();
          const gap = (await state()).gap;
          // New lines or the reader move the transcript: the menu goes with the line it acts on.
          await scrollBy(-60);
          await until(
            async () => Math.abs((await state()).gap - gap) < 1,
            5000,
            "the menu beside its line",
          );
          expect((await state()).open).toBe(true);
          await scrollBy(4000);
          await closes("the line leaving the view");

          await open();
          await page.evaluate(() => window.dispatchEvent(new Event("blur")));
          await closes("a blur");

          await open();
          const size = page.viewportSize() ?? { width: 1200, height: 800 };
          await page.setViewportSize({ width: size.width - 40, height: size.height });
          await closes("a resize");
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("the player bar (W5.3 to W5.6)", () => {
  test(
    "[W5.3] seeking to 50 % shows the wall time of that instant, never a bare offset",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          await audio(rig, id, 12);
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          // Nothing to scrub before a line is played.
          expect(await page.locator("#scrub").isDisabled()).toBe(true);
          await playRow(page, "l000003");
          await pauseNow(page);
          await until(
            async () => (await page.getAttribute("#scrub", "max")) === "12",
            5000,
            "the scrubber spanning the part",
          );
          expect(await text(page, "#pos-end")).toBe(formatWall(T0 + 12_000, TZ));
          // Drag to the middle: the input event a pointer drag sends.
          await page.$eval("#scrub", (el) => {
            const s = el as HTMLInputElement;
            s.value = String(Number(s.max) / 2);
            s.dispatchEvent(new Event("input", { bubbles: true }));
          });
          const half = formatWall(T0 + 6000, TZ);
          await until(async () => (await player(page)).at === 6, 5000, "the seek");
          expect(await text(page, "#pos")).toBe(half);
          expect(await page.getAttribute("#scrub", "aria-valuetext")).toBe(half);
          expect(half).toMatch(/^\d{1,2}:\d{2}:\d{2}/);
          expect(await text(page, "#pos")).not.toMatch(/^\d{1,2}:\d{2}$/);
          // Keys on the scrubber move it too, and the time follows.
          await page.focus("#scrub");
          await page.keyboard.press("End");
          await until(async () => (await player(page)).at === 12, 5000, "the end");
          expect(await text(page, "#pos")).toBe(formatWall(T0 + 12_000, TZ));
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W5.4] ] twice sets 1.5x, reload keeps it, a played line takes it; held at 0.75x and 2x; [ and ] type in a text field",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          await audio(rig, id, 12);
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          expect(await page.inputValue("#speed")).toBe("1");
          await page.click("#scroller", { position: { x: 5, y: 5 } });
          await page.keyboard.press("]");
          await page.keyboard.press("]");
          expect(await page.inputValue("#speed")).toBe("1.5");
          expect(await text(page, "#speed option:checked")).toBe("1.5x");
          expect((await player(page)).rate).toBe(1.5);

          await page.reload();
          await page.waitForSelector("#lines .row >> nth=3");
          expect(await page.inputValue("#speed")).toBe("1.5");
          // Loading a part resets an element's rate to its default: the speed must survive it.
          await playRow(page, "l000003");
          expect((await player(page)).rate).toBe(1.5);
          await pauseNow(page);

          await page.click("#scroller", { position: { x: 5, y: 5 } });
          for (let i = 0; i < 5; i++) await page.keyboard.press("]");
          expect(await page.inputValue("#speed")).toBe("2");
          for (let i = 0; i < 6; i++) await page.keyboard.press("[");
          expect(await page.inputValue("#speed")).toBe("0.75");
          expect((await player(page)).rate).toBe(0.75);
          // The picker sets it as the keys do.
          await page.selectOption("#speed", "1.25");
          expect((await player(page)).rate).toBe(1.25);

          await page.click("#note-input");
          await page.keyboard.type("[a]");
          expect(await page.inputValue("#note-input")).toBe("[a]");
          expect(await page.inputValue("#speed")).toBe("1.25");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W5.5] Shift+→ and Shift+← move 5 s and clamp at the part bounds; in a text field they select text",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          await audio(rig, id, 12);
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await playRow(page, "l000003");
          await pauseNow(page);
          await seekTo(page, 3);
          await page.click("#scroller", { position: { x: 5, y: 5 } });
          const at = async () => (await player(page)).at;
          const press = async (key: string, want: number) => {
            await page.keyboard.press(key);
            await until(async () => (await at()) === want, 5000, `${key} to ${want} s`);
          };
          await press("Shift+ArrowRight", 8);
          await press("Shift+ArrowRight", 12);
          await press("Shift+ArrowRight", 12);
          await press("Shift+ArrowLeft", 7);
          await press("Shift+ArrowLeft", 2);
          await press("Shift+ArrowLeft", 0);
          await page.fill("#note-input", "abc");
          await page.focus("#note-input");
          await page.keyboard.press("Shift+ArrowLeft");
          await page.waitForTimeout(200);
          expect(await at()).toBe(0);
          expect(
            await page.$eval("#note-input", (el) => {
              const i = el as HTMLInputElement;
              return (i.selectionEnd ?? 0) - (i.selectionStart ?? 0);
            }),
          ).toBe(1);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W5.6] with playback running the highlighted row's a0 <= t < a1 and stays in view; a manual scroll stops auto-scroll until Follow",
    async () => {
      const N = 40;
      let id = "";
      await withRig(
        {
          seed: (home) => (id = seedCall(home, (b) => manyLines(b, N)).id),
        },
        async (rig) => {
          await audio(rig, id, N);
          const page = await rig.open(id);
          await page.waitForSelector(`#lines .row >> nth=${N - 1}`);
          /** The highlighted rows, and whether the one row is inside the transcript's view. */
          const lit = () =>
            page.evaluate(() => {
              const rows = [...document.querySelectorAll("#lines .row.playing")] as HTMLElement[];
              const s = (
                document.getElementById("scroller") as HTMLElement
              ).getBoundingClientRect();
              const r = rows[0]?.getBoundingClientRect();
              return {
                ids: rows.map((x) => x.dataset.id ?? ""),
                inView: !!r && r.top >= s.top && r.bottom <= s.bottom,
                current: rows[0]?.getAttribute("aria-current") ?? null,
              };
            });
          const index = (lid: string) => Number(lid.slice(1)) - 1;
          const top = () => scrollerTop(page);
          /** Pauses and checks the rule at that exact instant: a0 <= t < a1 (here a0 = index). */
          const check = async () => {
            const t = await pauseNow(page);
            const l = await lit();
            expect(l.ids.length).toBe(1);
            const a0 = index(l.ids[0] as string);
            expect(a0 <= t && t < a0 + 1).toBe(true);
            expect(l.current).toBe("true");
            return l;
          };
          const resume = () =>
            page.evaluate(() => (document.getElementById("player") as HTMLAudioElement).play());

          await page.click("#scroller", { position: { x: 5, y: 5 } });
          for (let i = 0; i < 4; i++) await page.keyboard.press("]");
          await playRow(page, "l000002");
          await until(async () => (await player(page)).at > 3.2, 8000, "a few lines played");
          expect((await check()).inView).toBe(true);
          // The row being played left the view (the reader was elsewhere, not by hand): playing
          // brings it back.
          await page.evaluate(() => {
            // Instant: the transcript scrolls smoothly by default.
            (document.getElementById("scroller") as HTMLElement).scrollTo({
              top: 1e6,
              behavior: "instant",
            });
          });
          expect((await lit()).inView).toBe(false);
          await resume();
          await until(async () => (await lit()).inView, 5000, "the playing row back in view");
          await until(async () => (await player(page)).at > 8, 8000, "more lines played");
          expect((await check()).inView).toBe(true);
          expect(await page.locator("#follow").isHidden()).toBe(true);

          // A scroll by hand stops the following, and Follow appears.
          await resume();
          await page.mouse.move(400, 300);
          await page.mouse.wheel(0, 3000);
          await until(async () => await page.locator("#follow").isVisible(), 5000, "Follow shown");
          let settled = -1;
          await until(
            async () => {
              const now = await top();
              const same = now === settled;
              settled = now;
              return same;
            },
            5000,
            "the wheel's scroll settling",
          );
          const before = (await lit()).ids[0];
          await until(
            async () => (await lit()).ids[0] !== before && (await player(page)).at > 14,
            10000,
            "the next lines playing",
          );
          expect(await top()).toBe(settled);
          const away = await check();
          expect(away.inView).toBe(false);

          // Follow brings the line being played back and follows again.
          await resume();
          await page.click("#follow");
          await until(async () => (await lit()).inView, 5000, "the row in view after Follow");
          expect(await page.locator("#follow").isHidden()).toBe(true);
          await until(async () => (await player(page)).at > 20, 10000, "later lines");
          expect((await check()).inView).toBe(true);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W5.6] PageUp with focus on a line's Play, and a drag of an overlay scrollbar, stop auto-scroll too",
    async () => {
      const N = 40;
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => manyLines(b, N)).id) },
        async (rig) => {
          await audio(rig, id, N);
          const page = await rig.open(id);
          await page.waitForSelector(`#lines .row >> nth=${N - 1}`);
          const following = () => page.locator("#follow").isHidden();
          /** Plays long enough for the pane to have kept the line in view a few times. */
          const playFor = async (s: number) => {
            const from = (await player(page)).at;
            await until(async () => (await player(page)).at > from + s, 8000, `${s} s played`);
          };

          // Clicking a line's Play leaves focus on that button: the most common state.
          await playRow(page, "l000030");
          await playFor(1);
          expect(await following()).toBe(true);
          expect(
            await page.evaluate(() => document.activeElement?.classList.contains("play")),
          ).toBe(true);
          await page.keyboard.press("PageUp");
          await page.keyboard.press("PageUp");
          await until(async () => await page.locator("#follow").isVisible(), 5000, "Follow shown");
          // The transcript scrolls smoothly: wait for the keys' scroll to come to rest.
          let moved = -1;
          await until(
            async () => {
              const now = await scrollerTop(page);
              const same = now === moved;
              moved = now;
              return same;
            },
            5000,
            "the keys' scroll settling",
          );
          await playFor(1.5);
          // Not yanked back to the line being played.
          expect(await scrollerTop(page)).toBe(moved);

          await page.click("#follow");
          await until(async () => await following(), 5000, "following again");
          await playFor(1);
          expect(await following()).toBe(true);

          // A scrollbar drawn over the content (macOS's default, and headless Chromium's hidden
          // one) takes no width, so a press on it lands inside the scroller's content box. The
          // press, then the scroll it drives while held.
          const dragged = await page.evaluate(() => {
            const s = document.getElementById("scroller") as HTMLElement;
            const r = s.getBoundingClientRect();
            const at = { bubbles: true, clientX: r.right - 3, clientY: r.top + r.height / 2 };
            s.dispatchEvent(new MouseEvent("mousedown", at));
            s.scrollTo({ top: 0, behavior: "instant" });
            return new Promise<number>((done) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  s.dispatchEvent(new MouseEvent("mouseup", at));
                  done(s.scrollTop);
                }),
              ),
            );
          });
          expect(dragged).toBe(0);
          await until(async () => await page.locator("#follow").isVisible(), 5000, "Follow shown");
          await playFor(1.5);
          expect(await scrollerTop(page)).toBe(0);

          // Positive control: the pane's own scrolls never count as by hand. Follow, then the
          // line being played leaves the view by a scroll nobody made by hand (content moving),
          // and playing brings it back with Follow still hidden.
          await page.click("#follow");
          await until(async () => await following(), 5000, "following again");
          await page.evaluate(() =>
            (document.getElementById("scroller") as HTMLElement).scrollTo({
              top: 0,
              behavior: "instant",
            }),
          );
          await until(
            async () => (await scrollerTop(page)) > 0,
            5000,
            "the line brought back into view",
          );
          expect(await following()).toBe(true);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W5.5] the keys the player bar promises work with focus on the scrubber and the speed picker",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          await audio(rig, id, 12);
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await playRow(page, "l000003");
          await pauseNow(page);
          await seekTo(page, 1);
          const at = async () => (await player(page)).at;
          const press = async (key: string, want: number) => {
            await page.keyboard.press(key);
            await until(async () => (await at()) === want, 5000, `${key} to ${want} s`);
          };
          // The scrubber's title promises Shift+← and Shift+→; its arrows take the same 5 s.
          expect(await page.getAttribute("#scrub", "title")).toContain("Shift+→");
          await page.focus("#scrub");
          await press("Shift+ArrowRight", 6);
          await press("ArrowRight", 11);
          await press("Shift+ArrowLeft", 6);
          await press("ArrowLeft", 1);
          // Space plays and pauses from the scrubber, as it does from the transcript.
          await page.keyboard.press(" ");
          await until(async () => !(await player(page)).paused, 5000, "playing from the scrubber");
          await page.keyboard.press(" ");
          await until(async () => (await player(page)).paused, 5000, "paused from the scrubber");
          await page.keyboard.press("]");
          expect(await page.inputValue("#speed")).toBe("1.25");

          // After picking a speed, the brackets and the seeks still work from the picker.
          await page.selectOption("#speed", "1.5");
          await page.focus("#speed");
          await page.keyboard.press("]");
          expect(await page.inputValue("#speed")).toBe("1.75");
          await page.keyboard.press("[");
          expect(await page.inputValue("#speed")).toBe("1.5");
          const from = await at();
          await press("Shift+ArrowRight", Math.min(12, from + 5));
          expect(await page.inputValue("#speed")).toBe("1.5");
          // Space stays the picker's own key (it opens the list): the player does not start.
          expect((await player(page)).paused).toBe(true);
          await page.keyboard.press(" ");
          await page.waitForTimeout(300);
          expect((await player(page)).paused).toBe(true);
        },
      );
    },
    UI_TIMEOUT,
  );
});
