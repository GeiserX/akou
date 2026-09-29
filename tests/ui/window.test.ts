/**
 * The window's new parts and its traps (docs/DESIGN.md sections 5.1 to 5.3, 7 and 8.3; TRAPS
 * "Page refetched the whole transcript every second", "Wake from sleep"), on the real page in a
 * headless browser: reconnecting without duplicates or gaps, XSS, request counting, the dead-call
 * banner from the fake helper, keyboard access, the notepad, the ask box,
 * settings, playback, "Fix this line", the meters, the share viewer and the page's own guard.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "playwright-core";
import { formatWall } from "../../src/core/log/clock.ts";
import type { LogEvent } from "../../src/core/log/events.ts";
import { NEMOTRON, RECOGNIZER } from "../../src/main/asr/models.ts";
import { renderExport } from "../../src/main/handoff/export.ts";
import { stereoWav } from "../fixtures/audio.ts";
import { modelRegistry } from "../fixtures/model-registry.ts";
import { tempDir } from "../helpers.ts";
import {
  CLIPBOARD_PERMISSIONS,
  FakeProvider,
  hiddenOffenders,
  launch,
  requestLog,
  seedCall,
  seg,
  silentWav,
  standardCall,
  T0,
  TZ,
  UI_TIMEOUT,
  type UiRig,
  uiRig,
  until,
  watchedOffenders,
} from "./rig.ts";

const XSS = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;

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
const rowIds = (page: Page) =>
  page.$$eval("#lines .row", (rows) => rows.map((r) => (r as HTMLElement).dataset.id ?? ""));

/** A saved call of `n` lines, the speakers `c1, c1, c2` over and over, 4 s apart. */
function longCall(b: import("../helpers.ts").LogBuilder, n: number): void {
  b.created();
  b.partStarted(1, T0);
  for (let i = 1; i <= n; i++) {
    b.seg({
      id: `l${String(i).padStart(6, "0")}`,
      ch: "call",
      spk: i % 3 === 0 ? "c2" : "c1",
      w0: T0 + i * 4000,
      text: `line number ${i} of the call`,
    });
  }
  b.partEnded(1, "stop", n * 4);
  b.add({ type: "call.ended", reason: "stop" });
}

const gapOf = (page: Page) =>
  page.evaluate(() => {
    const s = document.getElementById("scroller") as HTMLElement;
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  });

async function events(rig: UiRig, id: string): Promise<LogEvent[]> {
  return (await rig.api("GET", `/calls/${id}/events`)).body.events;
}

describe("following a live call", () => {
  test(
    "[T2.50] Page refetched the whole transcript every second: one stream, no transcript reads, counted",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall();
        let log: ReturnType<typeof requestLog> | null = null;
        const page = await rig.open(id, { before: (p) => (log = requestLog(p)) });
        await until(async () => (await text(page, "#state")) === "rec", 5000, "recording");
        const start = (log as unknown as ReturnType<typeof requestLog>).all.length;
        for (let i = 1; i <= 5; i++) {
          await rig.write(id, seg(`l80000${i}`, `line ${i}`));
          await Bun.sleep(1000);
        }
        await until(async () => (await rowIds(page)).length === 5, 5000, "five rows");
        const during = (log as unknown as ReturnType<typeof requestLog>).all.slice(start);
        const paths = during.map((r) => new URL(r.url()).pathname);
        // Five lines over five seconds cost no request at all: they came down the open stream.
        expect(paths.filter((p) => /transcript|\/events$|\/stream$/.test(p))).toEqual([]);
        expect(during.length).toBeLessThanOrEqual(2);
        // Positive control: the log does see the page's own requests.
        await page.click("#settings-open");
        await until(
          () =>
            (log as unknown as ReturnType<typeof requestLog>)
              .paths()
              .some((p) => p.endsWith("/config")),
          3000,
          "the settings request",
        );
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "a stream dropped by force resumes from Last-Event-ID with no duplicate and no gap",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall();
        const streams: { lastEventId: string | undefined }[] = [];
        const page = await rig.open(id, {
          before: (p) =>
            p.on("request", (r) => {
              if (new URL(r.url()).pathname.endsWith(`/calls/${id}/stream`)) {
                streams.push({ lastEventId: r.headers()["last-event-id"] });
              }
            }),
        });
        for (let i = 1; i <= 3; i++) await rig.write(id, seg(`l70000${i}`, `before ${i}`));
        await until(async () => (await rowIds(page)).length === 3, 5000, "three rows");
        const cursor = Number(await page.evaluate(() => document.body.dataset.cursor));
        expect(rig.app.page?.closeStreams()).toBeGreaterThanOrEqual(1);
        // Written while the page is disconnected: it must fetch exactly these on reconnect.
        for (let i = 4; i <= 6; i++) await rig.write(id, seg(`l70000${i}`, `during ${i}`));
        await until(async () => (await rowIds(page)).length === 6, 8000, "six rows");
        for (let i = 7; i <= 8; i++) await rig.write(id, seg(`l70000${i}`, `after ${i}`));
        await until(async () => (await rowIds(page)).length === 8, 5000, "eight rows");
        const ids = await rowIds(page);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(Array.from({ length: 8 }, (_, i) => `l70000${i + 1}`));
        expect(streams.length).toBeGreaterThanOrEqual(2);
        expect(streams[0]?.lastEventId).toBeUndefined();
        expect(Number(streams[1]?.lastEventId)).toBeGreaterThanOrEqual(cursor);
        // The page applied every event once: its cursor is the log's end, nothing dropped.
        const last = (await events(rig, id)).at(-1)?.seq;
        await until(
          async () => Number(await page.evaluate(() => document.body.dataset.cursor)) === last,
          3000,
          "the page's cursor at the log's end",
        );
        expect(await page.evaluate(() => document.body.dataset.duplicates ?? "0")).toBe("0");
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "[spike, ElectroBun #550] Wake from sleep: a clock that jumped reconnects from the cursor",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall();
        let opens = 0;
        const page = await rig.open(id, {
          before: (p) =>
            p.on("request", (r) => {
              if (new URL(r.url()).pathname.endsWith("/stream") && r.url().includes(id)) opens++;
            }),
        });
        await page.clock.install();
        await rig.write(id, seg("l600001", "before sleep"));
        await until(async () => (await rowIds(page)).length === 1, 5000, "one row");
        const before = opens;
        // The machine slept for a minute: timers jump, and the page must not trust the stream.
        await page.clock.fastForward(60_000);
        await until(() => opens > before, 8000, "a reconnect after the jump");
        await rig.write(id, seg("l600002", "after wake"));
        await until(async () => (await rowIds(page)).length === 2, 5000, "the line after waking");
        expect(await rowIds(page)).toEqual(["l600001", "l600002"]);
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "the red banner appears when the fake helper's call side dies",
    async () => {
      await withRig({ helperArgs: ["--call-dead-at", "0.5"] }, async (rig) => {
        const id = await rig.startCall();
        // The call's health dot as it was when the banner turned red: read in the same turn as
        // the banner's change, so a dot drawn by a later update (a level packet) cannot count.
        // The watch starts before the page's own scripts run, so it sees the banner go red
        // however slowly the page opens; a banner already red when first seen fails the test.
        const page = await rig.open(id, {
          before: (p) =>
            p.addInitScript(() => {
              const w = window as unknown as { __bannerFirst?: string; __dotAtBanner?: string };
              const seen = () => {
                const b = document.getElementById("banner");
                if (!b) return;
                w.__bannerFirst ??= b.classList.contains("dead") ? "dead" : "not dead";
                if (w.__dotAtBanner === undefined && b.classList.contains("dead")) {
                  w.__dotAtBanner = document.getElementById("health-call")?.dataset.state ?? "";
                }
              };
              new MutationObserver(seen).observe(document, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ["class"],
              });
            }),
        });
        await page.waitForSelector("#banner.dead", { timeout: 25_000 });
        expect(await text(page, "#banner-text")).toContain("CALL AUDIO LOST");
        expect((await events(rig, id)).some((e) => e.type === "health")).toBe(true);
        const w = await page.evaluate(() => {
          const g = window as unknown as { __bannerFirst?: string; __dotAtBanner?: string };
          return { first: g.__bannerFirst, dot: g.__dotAtBanner };
        });
        expect(w).toEqual({ first: "not dead", dot: "dead" });
        expect(await page.locator("#health-call").getAttribute("data-state")).toBe("dead");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "the level meters and health dots move with the capture",
    async () => {
      await withRig({}, async (rig) => {
        const id = await rig.startCall();
        const page = await rig.open(id);
        await until(
          async () =>
            Number(await page.locator("#meter-mic").getAttribute("value")) > -60 ||
            (await page.evaluate(
              () => (document.getElementById("meter-mic") as HTMLMeterElement).value,
            )) > -60,
          8000,
          "the mic meter to move",
        );
        expect(await page.locator("#health-mic").getAttribute("data-state")).toBe("ok");
      });
    },
    UI_TIMEOUT,
  );
});

/** The call the sidebar marks as the one on screen. */
const shown = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector<HTMLElement>('#calls button[data-id][aria-current="true"]')?.dataset
        .id ?? null,
  );

describe("[W3.17] a new live call takes the window over, from any door", () => {
  test(
    "a call started from the CLI replaces a call the user picked; a picked call holds until the next one; an ended call stays",
    async () => {
      let old = "";
      await withRig({ seed: (home) => (old = seedCall(home, standardCall).id) }, async (rig) => {
        // The user opened an old call: the window shows it as picked.
        const page = await rig.open(old);
        await until(async () => (await shown(page)) === old, 5000, "the old call on screen");
        // `akou start` from a terminal or an agent: not the window's own start.
        const cli = { "x-akou-client": "cli" };
        const first = await rig.api("POST", "/calls", { workspace: "work", title: "One" }, cli);
        expect(first.status).toBe(201);
        const one = first.body.call as string;
        await until(async () => (await shown(page)) === one, 5000, "the CLI's call on screen");
        await until(async () => (await text(page, "#state")) === "rec", 5000, "recording");
        // The user picks the old call to read it while the call runs: it holds.
        await page.click(`#calls button[data-id="${old}"]`);
        await until(async () => (await shown(page)) === old, 5000, "the old call picked again");
        // A window opened on the old call while one is live (`akou open OLD`) shows what it was
        // asked for.
        const asked = await rig.open(old);
        await until(async () => (await shown(asked)) === old, 5000, "the asked-for call");
        await Bun.sleep(1500);
        expect(await shown(page)).toBe(old);
        expect(await shown(asked)).toBe(old);
        expect((await rig.api("POST", `/calls/${one}/stop`, {}, cli)).status).toBeLessThan(300);
        // The next new live call takes the window over again.
        const second = await rig.api("POST", "/calls", { workspace: "work", title: "Two" }, cli);
        expect(second.status).toBe(201);
        const two = second.body.call as string;
        await until(async () => (await shown(page)) === two, 5000, "the second call on screen");
        // It ends: the window stays on it.
        expect((await rig.api("POST", `/calls/${two}/stop`, {}, cli)).status).toBeLessThan(300);
        await until(
          async () => (await rig.api("GET", "/status")).body?.live === null,
          5000,
          "no live call",
        );
        await Bun.sleep(500);
        expect(await shown(page)).toBe(two);
      });
    },
    UI_TIMEOUT,
  );
});

describe("XSS: every text from a transcript, a note, a name or an answer renders inert", () => {
  test(
    "a payload in a line, a speaker name, a note, a title and an answer stays text",
    async () => {
      let id = "";
      const provider = new FakeProvider();
      provider.answer = () => `Here: ${XSS} [#l000002]`;
      await withRig(
        {
          provider,
          seed: (home) => {
            id = seedCall(home, (b) => {
              b.created({ title: XSS });
              b.partStarted(1, T0);
              b.seg({ id: "l000001", ch: "mic", spk: "you", w0: T0 + 1000, text: XSS });
              b.seg({
                id: "l000002",
                ch: "call",
                spk: "c1",
                w0: T0 + 3000,
                text: "the build moves",
              });
              b.add({ type: "speaker.name", spk: "c1", name: XSS.slice(0, 90), by: "user" });
              b.add({
                type: "note",
                id: "n0001",
                rev: 1,
                text: XSS,
                w: T0 + 2000,
                afterSeq: 3,
                by: "user",
              });
              b.partEnded(1, "stop");
              b.add({ type: "call.ended", reason: "stop" });
            }).id;
          },
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=1");
          await page.fill("#ask-input", "what about the build");
          await page.keyboard.press("Enter");
          await page.waitForSelector("#ask-out .answer button.cite");
          expect(await text(page, '#lines .row[data-id="l000001"] .text')).toBe(XSS);
          expect(await text(page, '#lines .row[data-id="l000002"] .who')).toBe(XSS.slice(0, 90));
          expect(await text(page, "#notes .note-text")).toBe(XSS);
          expect(await text(page, "#ask-out .answer")).toContain(XSS);
          expect(await text(page, "#title")).toContain(XSS);
          expect(
            await page.locator("#lines img, #notes img, #ask-out img, #title img").count(),
          ).toBe(0);
          expect(await page.locator("body script").count()).toBe(0);
          expect(
            await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
          ).toBeUndefined();
          // Positive control: the same payload as markup does run in this browser.
          const probe = await (await launch()).newPage();
          await probe.setContent(`<body>${XSS}</body>`);
          await until(
            async () =>
              (await probe.evaluate(() => (window as unknown as { __xss?: number }).__xss)) !==
              undefined,
            3000,
            "the payload to run as markup",
          );
          await probe.close();
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("keyboard access", () => {
  test(
    "Record and Stop are reachable with Tab and work with Enter, with a visible focus ring",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await page.waitForSelector("#record", { state: "visible" });
        const focusOn = async (id: string) => {
          for (let i = 0; i < 40; i++) {
            if ((await page.evaluate(() => document.activeElement?.id)) === id) return;
            await page.keyboard.press("Tab");
          }
          throw new Error(`Tab never reached #${id}`);
        };
        await focusOn("record");
        await page.keyboard.press("Enter");
        await until(async () => (await text(page, "#state")) === "rec", 8000, "recording");
        await focusOn("stop");
        await page.keyboard.press("Enter");
        await until(async () => (await text(page, "#state")) === "saved", 8000, "stopped");
        // A visible focus ring on the focused control.
        await focusOn("copy-transcript");
        const outline = await page.evaluate(
          () => getComputedStyle(document.activeElement as Element).outlineStyle,
        );
        expect(outline).not.toBe("none");
      });
    },
    UI_TIMEOUT,
  );
});

describe("the notes pane is just Notes (W1.1, TS-15)", () => {
  test(
    "[W1.1] no tabs, no Enhanced pane, no Enhance and no Find misheard words: a word is fixed on its line",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          for (const gone of [
            "[role=tab]",
            "[role=tabpanel]",
            "#pane-enhanced",
            "#enhance",
            "#enhance-template",
            "#vocab-pass",
          ]) {
            expect([gone, await page.locator(gone).count()]).toEqual([gone, 0]);
          }
          const side = (await text(page, "#side")) ?? "";
          for (const word of ["Enhance", "misheard"]) expect(side).not.toContain(word);
          expect(await page.locator("#pane-notes").isVisible()).toBe(true);
          expect(await hiddenOffenders(page)).toEqual([]);
          // Positive control: the check sees a button with those words when one is there.
          await page.evaluate(() => {
            const b = document.createElement("button");
            b.id = "vocab-pass";
            b.textContent = "Find misheard words";
            document.getElementById("pane-notes")?.append(b);
          });
          expect(await page.locator("#vocab-pass").count()).toBe(1);
          expect(await text(page, "#side")).toContain("misheard");
          await page.evaluate(() => document.getElementById("vocab-pass")?.remove());
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[TS-15] positive control: a hidden pane forced to show is reported, by the check and by the watch on every screen",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          expect(await hiddenOffenders(page)).toEqual([]);
          // The rule broken on purpose: the hidden popover forced to show (through the CSSOM,
          // which the page's Content-Security-Policy allows where a style tag is refused).
          const force = (on: boolean) =>
            page.evaluate((show) => {
              const p = document.getElementById("popover") as HTMLElement;
              if (show) p.style.setProperty("display", "flex", "important");
              else p.style.removeProperty("display");
            }, on);
          await force(true);
          expect(await hiddenOffenders(page)).toEqual(["#popover shows"]);
          expect(await watchedOffenders(page, { clear: true })).toEqual(
            expect.arrayContaining(["#popover shows"]),
          );
          // Put right, so this test's own close has nothing to report.
          await force(false);
          expect(await hiddenOffenders(page)).toEqual([]);
          expect(await watchedOffenders(page)).toEqual([]);
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("keyboard access to a row's tools", () => {
  test(
    "Play and Fix are reachable with Tab on every row, one that continues the same speaker included",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => longCall(b, 6)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=5");
          // Rows 2 and 5 continue the speaker before them, so they show no speaker chip.
          expect(
            await page.locator('#lines .row[data-id="l000002"]').getAttribute("class"),
          ).not.toContain("turn");
          await page.focus('#lines .row[data-id="l000001"] .who');
          const reached = new Set<string>();
          for (let i = 0; i < 30; i++) {
            const at = await page.evaluate(() => {
              const a = document.activeElement as HTMLElement | null;
              const row = a?.closest("#lines .row") as HTMLElement | null;
              return row && a?.classList.contains("play") ? (row.dataset.id ?? null) : null;
            });
            if (at) reached.add(at);
            await page.keyboard.press("Tab");
          }
          expect([...reached].sort()).toEqual([
            "l000001",
            "l000002",
            "l000003",
            "l000004",
            "l000005",
            "l000006",
          ]);
          // Out of sight until the row is hovered or focused, then there to click.
          const hit = () =>
            page.evaluate(() => {
              const b = document.querySelector(
                '#lines .row[data-id="l000005"] .play',
              ) as HTMLElement;
              const r = b.getBoundingClientRect();
              return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
            });
          await page.mouse.move(0, 0);
          await page.focus("#settings-open");
          expect(await hit()).toBe(false);
          await page.focus('#lines .row[data-id="l000005"] .play');
          expect(await hit()).toBe(true);
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("the confirm bar", () => {
  test(
    "Share right after Record keeps the consent reminder: each message has its own row and Dismiss",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const page = await rig.open();
        await page.waitForSelector("#record", { state: "visible" });
        await page.click("#record");
        await until(async () => (await text(page, "#state")) === "rec", 8000, "recording");
        await page.click("#share-start");
        await page.waitForSelector("#pill-share:not([hidden])");
        const rows = page.locator("#confirm .confirm-row");
        await until(async () => (await rows.count()) === 2, 5000, "two messages");
        expect(await rows.nth(0).textContent()).toContain(
          "Remember to tell the others you are recording",
        );
        expect(await rows.nth(1).textContent()).toContain("Read-only link:");
        await rows.nth(1).getByRole("button", { name: "Dismiss" }).click();
        expect(await rows.count()).toBe(1);
        expect(await text(page, "#confirm")).toContain("Remember to tell the others");
        await rows.nth(0).getByRole("button", { name: "Dismiss" }).click();
        await page.waitForSelector("#confirm", { state: "hidden" });
        await page.click("#stop");
        await until(async () => (await text(page, "#state")) === "saved", 8000, "stopped");
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );
});

describe("the notepad (DESIGN 5.1)", () => {
  test(
    "a typed line is a note by the user, timed at its first keystroke; agent lines look different",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          const typed = Date.now();
          await page.click("#note-input");
          await page.keyboard.type("[] move the build");
          await page.keyboard.press("Enter");
          await page.waitForSelector("#notes li.note.human");
          const note = (await events(rig, id)).find((e) => e.type === "note") as LogEvent & {
            by: string;
            w: number;
            afterSeq: number;
            text: string;
          };
          expect(note).toMatchObject({ by: "user", text: "[] move the build" });
          expect(Math.abs(note.w - typed)).toBeLessThan(5000);
          expect(note.afterSeq).toBeGreaterThan(0);
          expect(await page.locator("#notes li.note.action").count()).toBe(1);
          // The marker is drawn as a glyph, not as text; an edit starts from the whole line.
          expect(await text(page, "#notes li.note.action .note-text")).toBe("move the build");
          await page.click("#notes li.note.action .edit");
          expect(await page.inputValue("#notes li.note.action .note-edit")).toBe(
            "[] move the build",
          );
          await page.keyboard.press("Escape");
          await page.waitForSelector("#notes .note-edit", { state: "detached" });
          await page.click("#note-input");
          // Edit and delete hidden until hover take no width: the text runs to the row's edge.
          const gap = await page.evaluate(() => {
            const row = document.querySelector("#notes li.note.action") as HTMLElement;
            const t = row.querySelector(".note-text") as HTMLElement;
            return row.getBoundingClientRect().right - t.getBoundingClientRect().right;
          });
          expect(gap).toBeLessThan(16);
          // A pause of 2 s saves the line too, and later keystrokes edit it (rev + 1).
          await page.keyboard.type("? who owns it");
          await until(
            async () => (await events(rig, id)).filter((e) => e.type === "note").length === 2,
            5000,
            "the pause to save",
          );
          await page.keyboard.type(" now");
          await page.keyboard.press("Enter");
          await until(
            async () =>
              (await events(rig, id)).some(
                (e) => e.type === "note" && (e as { rev: number }).rev === 2,
              ),
            5000,
            "the edit",
          );
          // An agent's note is marked as the agent's.
          await rig.api(
            "POST",
            `/calls/${id}/notes`,
            { text: "agent wrote this" },
            { "x-akou-client": "claude-code" },
          );
          await page.waitForSelector("#notes li.note.agent");
          expect(await text(page, "#notes li.note.agent .author")).toBe("agent claude-code");
          // The time gutter scrolls to the transcript there.
          await page.click("#notes li.note.human .gutter");
          await page.waitForSelector("#lines .row.flash");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W6.2] an edit to a note is kept when you click away, and after a 2 s pause; Escape still discards it",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const made = await rig.api("POST", `/calls/${id}/notes`, { text: "budget review" });
          const nid = made.body.note.id as string;
          const revs = async () =>
            (await events(rig, id))
              .filter((e) => e.type === "note" && (e as { id: string }).id === nid)
              .map((e) => ({
                rev: (e as { rev: number }).rev,
                text: (e as { text: string }).text,
              }));
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          const row = `#notes li.note[data-id="${nid}"]`;
          await page.waitForSelector(row);
          const edit = async (typed: string) => {
            await page.click(`${row} .edit`);
            await page.waitForSelector(`${row} .note-edit`);
            await page.keyboard.press("End");
            await page.keyboard.type(typed);
          };
          // Type, then click the transcript: the edit is saved as rev 2 and the editor closes.
          await edit(" first");
          await page.click('#lines .row[data-id="l000002"] .text');
          await until(async () => (await revs()).length === 2, 5000, "the edit saved on blur");
          expect((await revs())[1]).toEqual({ rev: 2, text: "budget review first" });
          await page.waitForSelector(`${row} .note-edit`, { state: "detached", timeout: 5000 });
          await until(
            async () => (await text(page, `${row} .note-text`)) === "budget review first",
            5000,
            "the notepad showing the edit",
          );
          // Type and stop: the pause saves it while the editor stays open.
          await edit(" today");
          await until(async () => (await revs()).length === 3, 5000, "the edit saved on a pause");
          expect((await revs())[2]).toEqual({ rev: 3, text: "budget review first today" });
          expect(await page.evaluate(() => document.activeElement?.className)).toBe("note-edit");
          // A note written meanwhile through another door shows at once; the edit stays open as it was.
          const aside = (await rig.api("POST", `/calls/${id}/notes`, { text: "an aside" })).body
            .note.id as string;
          await page.waitForSelector(`#notes li.note[data-id="${aside}"]`, { timeout: 5000 });
          expect(await page.evaluate(() => document.activeElement?.className)).toBe("note-edit");
          expect(await page.inputValue(`${row} .note-edit`)).toBe("budget review first today");
          // Enter saves what came after; neither the pause timer nor the blur saves it again.
          await page.keyboard.type("!");
          await page.keyboard.press("Enter");
          await until(async () => (await revs()).length === 4, 5000, "the edit saved on Enter");
          expect((await revs())[3]).toEqual({ rev: 4, text: "budget review first today!" });
          // Escape discards: nothing is written, now or after the pause.
          await edit(" nope");
          await page.keyboard.press("Escape");
          await page.waitForSelector(`${row} .note-edit`, { state: "detached", timeout: 5000 });
          await page.waitForTimeout(2500);
          expect((await revs()).length).toBe(4);
          expect(await text(page, `${row} .note-text`)).toBe("budget review first today!");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W6.2] a note save that fails keeps the edit open with its text, the saves after it still go through, and a note deleted elsewhere closes its edit",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const made = await rig.api("POST", `/calls/${id}/notes`, { text: "budget review" });
          const nid = made.body.note.id as string;
          const other = (await rig.api("POST", `/calls/${id}/notes`, { text: "second note" })).body
            .note.id as string;
          const otherRow = `#notes li.note[data-id="${other}"]`;
          const noteTexts = async () =>
            (await events(rig, id))
              .filter((e) => e.type === "note")
              .map((e) => (e as { text: string }).text);
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          const row = `#notes li.note[data-id="${nid}"]`;
          await page.waitForSelector(row);
          // The next note request fails: "net" as a transport error, "500" as a refusal.
          let fail: "net" | "500" | null = null;
          await page.route("**/api/v1/calls/*/notes**", (r) => {
            const f = fail;
            fail = null;
            if (f === "net") return r.abort("failed");
            if (f === "500")
              return r.fulfill({
                status: 500,
                contentType: "application/json",
                body: JSON.stringify({ error: "io", message: "the disk is full" }),
              });
            return r.fallback();
          });
          const toastSays = (msg: string) =>
            until(async () => (await text(page, "#toast")) === msg, 5000, `the toast "${msg}"`);

          // A transport error on the save when focus leaves: a toast, and the text stays to retry.
          await page.click(`${row} .edit`);
          await page.waitForSelector(`${row} .note-edit`);
          await page.keyboard.press("End");
          await page.keyboard.type(" first");
          fail = "net";
          await page.click('#lines .row[data-id="l000002"] .text');
          await toastSays("the note was not saved");
          expect(await page.inputValue(`${row} .note-edit`)).toBe("budget review first");
          await page.click(`${row} .note-edit`);
          await page.keyboard.press("Enter");
          await until(
            async () => (await noteTexts()).includes("budget review first"),
            5000,
            "the retried edit",
          );
          await page.waitForSelector(`${row} .note-edit`, { state: "detached", timeout: 5000 });

          // A refused save on Enter: the app's message, and the editor stays open with its text.
          await page.click(`${row} .edit`);
          await page.waitForSelector(`${row} .note-edit`);
          await page.keyboard.press("End");
          await page.keyboard.type(" again");
          fail = "500";
          await page.keyboard.press("Enter");
          await toastSays("the disk is full");
          expect(await page.inputValue(`${row} .note-edit`)).toBe("budget review first again");
          await page.keyboard.press("Enter");
          await until(
            async () => (await noteTexts()).includes("budget review first again"),
            5000,
            "the edit saved after a refusal",
          );

          // Edit on another note while this edit's save fails: this edit stays open and tracked,
          // the other waits until this one is saved.
          await page.click(`${row} .edit`);
          await page.waitForSelector(`${row} .note-edit`);
          await page.keyboard.press("End");
          await page.keyboard.type(" third");
          fail = "net";
          await page.click(`${otherRow} .edit`);
          await toastSays("the note was not saved");
          await page.waitForTimeout(300);
          expect(await page.locator(`${otherRow} .note-edit`).count()).toBe(0);
          expect(await page.inputValue(`${row} .note-edit`)).toBe(
            "budget review first again third",
          );
          await page.click(`${row} .note-edit`);
          await page.keyboard.press("Enter");
          await until(
            async () => (await noteTexts()).includes("budget review first again third"),
            5000,
            "the edit saved before the other opens",
          );
          await page.waitForSelector(`${row} .note-edit`, { state: "detached", timeout: 5000 });
          // Once it is saved, Edit on the other note opens it as usual, even straight from an edit.
          await page.click(`${row} .edit`);
          await page.waitForSelector(`${row} .note-edit`);
          await page.keyboard.press("End");
          await page.keyboard.type(" fourth");
          await page.click(`${otherRow} .edit`);
          await page.waitForSelector(`${otherRow} .note-edit`, { timeout: 5000 });
          await until(
            async () => (await noteTexts()).includes("budget review first again third fourth"),
            5000,
            "the first edit saved on the way",
          );
          await page.waitForSelector(`${row} .note-edit`, { state: "detached", timeout: 5000 });
          expect(await page.evaluate(() => document.activeElement?.className)).toBe("note-edit");
          await page.keyboard.press("Escape");
          await page.waitForSelector(`${otherRow} .note-edit`, {
            state: "detached",
            timeout: 5000,
          });

          // A new note whose request fails does not stop the next one.
          await page.click("#note-input");
          await page.keyboard.type("lost line");
          fail = "net";
          await page.keyboard.press("Enter");
          await toastSays("the note was not saved");
          await page.keyboard.type("fresh line");
          await page.keyboard.press("Enter");
          await until(
            async () => (await noteTexts()).includes("fresh line"),
            5000,
            "the next new note",
          );

          // Deleted through another door while it is being edited: the row goes, edit and all.
          await page.click(`${row} .edit`);
          await page.waitForSelector(`${row} .note-edit`);
          expect((await rig.api("DELETE", `/calls/${id}/notes/${nid}`, {})).status).toBe(200);
          await page.waitForSelector(row, { state: "detached", timeout: 5000 });
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("the ask box (DESIGN 5.3, 5.4)", () => {
  test(
    "presets, evidence cards first, a streamed answer, citations that scroll to the line and play it",
    async () => {
      let id = "";
      const provider = new FakeProvider();
      provider.delayMs = 400;
      await withRig(
        {
          provider,
          seed: (home) => {
            id = seedCall(home, (b) => {
              standardCall(b);
              b.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
            }).id;
          },
        },
        async (rig) => {
          const folder = (await rig.api("GET", `/calls/${id}`)).body.folder as string;
          writeFileSync(
            join(folder, "audio", "part-001.opus"),
            stereoWav(new Float32Array(16000 * 12), new Float32Array(16000 * 12)),
          );
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          // The answer cites the line the way the pack teaches a model to: [HH:MM Name].
          const minute = formatWall(T0 + 3000, TZ, { seconds: false });
          provider.answer = () => `Ben said to move the build [${minute} Ben].`;
          // Ask is always on screen, above Notes: no tab to open first.
          expect(await page.locator("#ask-input").isVisible()).toBe(true);
          expect(await page.locator("#ask-presets").isVisible()).toBe(false);
          // The presets are a menu on the input.
          await page.click("#ask-presets-open");
          expect(await page.getAttribute("#ask-presets-open", "aria-expanded")).toBe("true");
          expect(await page.locator("#ask-presets .preset").allTextContents()).toEqual([
            "Catch me up",
            "Was my name mentioned?",
            "Decisions so far",
            "Action items",
            "What did Ben say?",
          ]);
          // Escape closes it, with the focus in the menu or back in the input.
          await page.keyboard.press("Escape");
          expect(await page.locator("#ask-presets").isVisible()).toBe(false);
          await page.click("#ask-presets-open");
          await page.click("#ask-input");
          await page.keyboard.press("Escape");
          expect(await page.locator("#ask-presets").isVisible()).toBe(false);
          // The chevron closes an open menu too.
          await page.click("#ask-presets-open");
          await page.click("#ask-presets-open");
          expect(await page.locator("#ask-presets").isVisible()).toBe(false);
          await page.click("#ask-presets-open");
          // WebKit does not focus a clicked button: the preset blurs to nothing before its click
          // lands. The menu has to survive that, or the click asks nothing. Blurring by hand does
          // the same thing in every engine.
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          expect(await page.locator("#ask-presets").isVisible()).toBe(true);
          await page.click("#ask-presets >> text=What did Ben say?");
          // Picking one closes the menu.
          expect(await page.locator("#ask-presets").isVisible()).toBe(false);
          expect(await page.getAttribute("#ask-presets-open", "aria-expanded")).toBe("false");
          await page.waitForSelector("#ask-out .card");
          // The tokens stream: the first half shows before the answer is complete.
          await page.waitForSelector("#ask-out .answer.streaming");
          await page.waitForSelector("#ask-out .answer button.cite");
          const cite = page.locator("#ask-out .answer button.cite").first();
          expect(await cite.getAttribute("data-line")).toBe("l000002");
          await cite.click();
          await page.waitForSelector('#lines .row.flash[data-id="l000002"]');
          await until(
            async () => (await page.locator("#player").getAttribute("data-line")) === "l000002",
            3000,
            "playback from the line",
          );
          const asked = (await events(rig, id)).filter(
            (e) => e.type === "ask" || e.type === "answer",
          );
          expect(asked.map((e) => e.type)).toEqual(["ask", "answer"]);
          expect((asked[0] as { by: string }).by).toBe("user");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "a saved call opens on its last answered question, citations live; a question asked here replaces it",
    async () => {
      let id = "";
      const provider = new FakeProvider();
      await withRig(
        {
          provider,
          seed: (home) => {
            id = seedCall(home, (b) => {
              standardCall(b);
              b.add({ type: "ask", id: "q1", q: "who spoke first?", by: "user" });
              b.add({
                type: "answer",
                ask: "q1",
                text: "An older answer.",
                cites: [],
                model: "fake/1.0",
                pack: { mode: "whole-call", tokens: 10 },
              });
              b.add({ type: "ask", id: "q2", q: "what about the build?", by: "agent:codex" });
              b.add({
                type: "answer",
                ask: "q2",
                text: "Move it to the new box [#l000002].",
                cites: ["l000002"],
                model: "fake/1.0",
                pack: { mode: "whole-call", tokens: 10 },
              });
              // Asked, never answered: not what the column shows.
              b.add({ type: "ask", id: "q3", q: "still thinking?", by: "user" });
            }).id;
          },
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await page.waitForSelector("#ask-out .a-card .answer button.cite");
          expect(await page.locator("#ask-out .qa").count()).toBe(1);
          expect(await text(page, "#ask-out .question")).toBe("what about the build?");
          expect(await text(page, "#ask-out .answer")).toContain("Move it to the new box");
          expect(await text(page, "#ask-out .ask-status")).toBe(
            "asked by agent codex · answered by fake/1.0",
          );
          await page.click("#ask-out .answer button.cite");
          await page.waitForSelector('#lines .row.flash[data-id="l000002"]');
          // A question asked here is the one on screen, and one is all the column holds.
          provider.answer = () => "Ana spoke first.";
          await page.fill("#ask-input", "who spoke first, again?");
          await page.keyboard.press("Enter");
          await until(
            async () => (await text(page, "#ask-out .answer")) === "Ana spoke first.",
            5000,
            "the new answer",
          );
          expect(await page.locator("#ask-out .qa").count()).toBe(1);
          expect(await text(page, "#ask-out .question")).toBe("who spoke first, again?");
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("the side column (WINDOW section 6)", () => {
  test(
    "Ask on top, Notes under it, the note input at the foot with its markers as hints, during a call and after",
    async () => {
      const t = tempDir("akou-wav-");
      const provider = new FakeProvider();
      await withRig({ provider, helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall({ title: "Column" });
        const page = await rig.open(id);
        await page.setViewportSize({ width: 1440, height: 900 });
        await rig.write(id, seg("l000001", "we should move the build", { spk: "c1" }));
        await until(async () => (await rowIds(page)).length === 1, 5000, "the row");
        // Top to bottom: the ask row, the Notes header, the note input.
        const tops = await page.evaluate(() =>
          ["ask-row", "notes-head", "compose"].map(
            (x) => (document.getElementById(x) as HTMLElement).getBoundingClientRect().top,
          ),
        );
        expect(tops).toEqual([...tops].sort((a, b) => a - b));
        expect(await page.getAttribute("#note-input", "placeholder")).toBe(
          "Type a note, Enter to add it",
        );
        // The markers are text under the field, never in its placeholder.
        expect(await text(page, "#note-hints")).toBe("- bullet [] action ? question # section");
        const field = await page.locator("#note-input").boundingBox();
        const hints = await page.locator("#note-hints").boundingBox();
        expect(hints && field && hints.y >= field.y + field.height).toBe(true);
        expect(await page.locator("[role=tab]").count()).toBe(0);
        expect(await page.locator("#ask-input").isVisible()).toBe(true);
        expect(await page.locator("#note-input").isVisible()).toBe(true);
        // A note from the foot lands in the Notes count.
        await page.click("#note-input");
        await page.keyboard.type("- budget first");
        await page.keyboard.press("Enter");
        await until(async () => (await text(page, "#notes-count")) === "1", 5000, "the count");
        // Ask works during the call...
        provider.answer = () => "Move the build.";
        await page.fill("#ask-input", "what did they say?");
        await page.keyboard.press("Enter");
        await until(
          async () => (await text(page, "#ask-out .a-card .answer")) === "Move the build.",
          5000,
          "the answer during the call",
        );
        // ...and after it.
        await rig.api("POST", "/calls/live/stop");
        await until(async () => (await text(page, "#state")) === "saved", 8000, "stopped");
        provider.answer = () => "Still the build.";
        await page.fill("#ask-input", "and now?");
        await page.keyboard.press("Enter");
        await until(
          async () => (await text(page, "#ask-out .a-card .answer")) === "Still the build.",
          5000,
          "the answer after the call",
        );
        expect(await hiddenOffenders(page)).toEqual([]);
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );
});

describe("renaming a call from its title (WINDOW 3.1)", () => {
  test(
    "A live call and a saved one renamed from the header: the header, the sidebar row, its search and the window title follow without a reload, from this window or another door",
    async () => {
      const t = tempDir("akou-wav-");
      let saved = "";
      await withRig(
        {
          helperArgs: ["--wav", silentWav(t.dir)],
          seed: (home) => {
            saved = seedCall(home, (b) => standardCall(b, "01J8Z6Q4M2VX0K7B3D4E5SAVED0")).id;
          },
        },
        async (rig) => {
          const live = await rig.startCall({ title: "Standup" });
          const page = await rig.open(live);
          await until(async () => (await text(page, "#state")) === "rec", 5000, "recording");
          const row = (id: string) => page.locator(`#calls li[data-id="${id}"] .what`);
          await until(async () => (await row(saved).count()) === 1, 5000, "the saved row");
          await page.evaluate(() => {
            (window as unknown as { marker: number }).marker = 7;
          });
          const renames = async (id: string) =>
            (await events(rig, id)).filter((e) => e.type === "call.renamed").length;

          // The live call: a click opens the field on the old name, Enter saves.
          await page.click("#title-text");
          expect(await page.inputValue("#title-input")).toBe("Standup");
          await page.fill("#title-input", "Standup with design");
          await page.press("#title-input", "Enter");
          await until(
            async () => (await row(live).textContent()) === "Standup with design",
            5000,
            "the live row follows",
          );
          expect(await text(page, "#title-text")).toBe("Standup with design");
          expect(await page.locator("#title-input").count()).toBe(0);
          await until(
            async () => (await page.title()) === "Standup with design · akou",
            5000,
            "the window title",
          );
          expect((await rig.api("GET", "/status")).body.live.title).toBe("Standup with design");
          expect(await renames(live)).toBe(1);

          // From the keyboard: Enter on the title opens it; Escape keeps the old name, and an
          // empty title saves nothing.
          await page.focus("#title-text");
          await page.keyboard.press("Enter");
          await page.waitForSelector("#title-input:focus");
          await page.keyboard.type(" and nothing else");
          // An Enter that confirms an IME candidate neither saves nor closes the field.
          await page.dispatchEvent("#title-input", "keydown", { key: "Enter", isComposing: true });
          expect(await page.locator("#title-input").count()).toBe(1);
          await page.keyboard.press("Escape");
          await page.click("#title-text");
          await page.fill("#title-input", "   ");
          await page.press("#title-input", "Enter");
          expect(await page.locator("#title-input").count()).toBe(0);
          expect(await text(page, "#title-text")).toBe("Standup with design");
          expect(await renames(live)).toBe(1);

          // The saved call, picked in the sidebar and renamed the same way; leaving the field saves.
          await page.click(`#calls li[data-id="${saved}"] button`);
          await until(
            async () => (await text(page, "#title-text")) === "Weekly sync",
            5000,
            "switched",
          );
          await page.click("#title-text");
          await page.fill("#title-input", "Q3 planning");
          await page.locator("#title-input").blur();
          await until(
            async () => (await row(saved).textContent()) === "Q3 planning",
            5000,
            "the saved row follows",
          );
          expect(await text(page, "#title-text")).toBe("Q3 planning");
          expect(await renames(saved)).toBe(1);

          // The search finds the call by its new name, and no longer by the old one.
          const search = page.locator("#calls-search");
          const items = page.locator("#calls li");
          await search.fill("q3");
          await until(async () => (await items.count()) === 1, 5000, "found by the new name");
          expect(await page.locator("#calls li .what").allTextContents()).toEqual(["Q3 planning"]);
          await search.fill("weekly");
          await until(async () => (await items.count()) === 0, 5000, "not by the old one");
          await search.fill("");
          await until(async () => (await items.count()) === 2, 5000, "cleared");

          // Another door (the CLI, an agent) renames the live call, which is not the one on
          // screen: its sidebar row follows too.
          expect(
            (await rig.api("PATCH", `/calls/${live}`, { title: "Standup, agreed" })).status,
          ).toBe(200);
          await until(
            async () => (await row(live).textContent()) === "Standup, agreed",
            5000,
            "renamed by another door",
          );
          // A save that fails leaves the field open to try again; opening another call closes
          // it, so Enter can never rename the call that was on screen before.
          await page.route("**/api/v1/calls/*", (route) =>
            route.request().method() === "PATCH"
              ? route.fulfill({ status: 409, json: { error: "conflict", message: "try later" } })
              : route.fallback(),
          );
          await page.click("#title-text");
          await page.fill("#title-input", "Never saved");
          await page.locator("#title-input").blur();
          await until(async () => (await text(page, "#toast")) === "try later", 5000, "refused");
          expect(await page.inputValue("#title-input")).toBe("Never saved");
          await page.unroute("**/api/v1/calls/*");
          await page.click(`#calls li[data-id="${live}"] button`);
          await until(
            async () => (await text(page, "#title-text")) === "Standup, agreed",
            5000,
            "switched back",
          );
          expect(await page.locator("#title-input").count()).toBe(0);
          expect(await page.locator("#title-text").isVisible()).toBe(true);
          expect(await renames(saved)).toBe(1);
          expect(await renames(live)).toBe(2);

          // No reload happened on the way.
          expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(
            7,
          );
          await rig.api("POST", "/calls/live/stop");
        },
      );
      t.cleanup();
    },
    UI_TIMEOUT,
  );
});

describe("the words to review (DESIGN 5.4, 7)", () => {
  test(
    "a pass run from the API: the review screen shows each proposal with its line; Approve writes the workspace file",
    async () => {
      let id = "";
      let home = "";
      const provider = new FakeProvider();
      provider.answer = () =>
        JSON.stringify({
          corrections: [{ line: "#l000001", heard: "hetzner", term: "Hetzner" }],
          proposals: [
            { term: "Hetzner", heard: ["hetzner"], lines: ["#l000003"], why: "a vendor" },
          ],
        });
      await withRig(
        {
          provider,
          seed: (h) => {
            home = h;
            id = seedCall(h, (b) => standardCall(b)).id;
          },
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          // The window has no button for the pass (a word is fixed on its line); the CLI and the
          // API still run it, and its proposals land in the review screen.
          const pass = await rig.api("POST", `/calls/${id}/vocab/pass`);
          expect(pass.status).toBe(200);
          // The bad span (hetzner is not in l000001) was dropped.
          expect(pass.body.corrections).toEqual([]);
          // The pill follows the log, which reaches the page on its own stream.
          await page.waitForSelector("#pill-review:not([hidden])");
          expect(await text(page, "#pill-review")).toBe("1 word to review");
          await page.click("#pill-review");
          await page.waitForSelector("#review[open] .review-item[data-term=Hetzner]");
          expect(await text(page, ".review-item[data-term=Hetzner] .review-lines li")).toContain(
            "deploy to hetzner today",
          );
          await page.click(".review-item[data-term=Hetzner] button.go");
          await until(
            async () =>
              (await text(page, "#review-status"))?.includes("in the vocabulary") ?? false,
            5000,
            "approved",
          );
          const file = readFileSync(
            join(home, ".config", "akou", "vocabulary", "work.yaml"),
            "utf8",
          );
          expect(file).toContain(`source: "call:${id}"`);
          await page.click("#review-close");
          await until(async () => !(await page.isVisible("#pill-review")), 5000, "pill hidden");
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("playback and Fix this line", () => {
  test(
    "a line plays from its own time in the part's audio",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const folder = (await rig.api("GET", `/calls/${id}`)).body.folder as string;
          writeFileSync(
            join(folder, "audio", "part-001.opus"),
            stereoWav(new Float32Array(16000 * 12), new Float32Array(16000 * 12)),
          );
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await page.hover('#lines .row[data-id="l000003"]');
          await page.click('#lines .row[data-id="l000003"] .play');
          await until(
            async () => (await page.locator("#player").getAttribute("data-line")) === "l000003",
            3000,
            "the player on the line",
          );
          expect(await page.locator("#player").getAttribute("data-seek")).toBe("0");
          await until(
            async () =>
              await page.evaluate(
                () => (document.getElementById("player") as HTMLAudioElement).readyState >= 1,
              ),
            5000,
            "the audio to load",
          );
          expect(
            await page.evaluate(() => (document.getElementById("player") as HTMLAudioElement).src),
          ).toMatch(/^blob:/);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W5.2] Space pauses a playing line and resumes it from the same position; the Play button does the same; Space in a text field types",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const folder = (await rig.api("GET", `/calls/${id}`)).body.folder as string;
          writeFileSync(
            join(folder, "audio", "part-001.opus"),
            stereoWav(new Float32Array(16000 * 12), new Float32Array(16000 * 12)),
          );
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          const player = () =>
            page.evaluate(() => {
              const p = document.getElementById("player") as HTMLAudioElement;
              return { paused: p.paused, at: p.currentTime };
            });
          expect(await page.locator("#play").isDisabled()).toBe(true);
          await page.hover('#lines .row[data-id="l000003"]');
          await page.click('#lines .row[data-id="l000003"] .play');
          await until(async () => (await player()).at > 0.3, 8000, "the line playing");
          expect(await text(page, "#play")).toBe("❚❚ Pause");
          // Space, with focus still on the row's Play button, pauses: it does not restart the line.
          await page.keyboard.press("Space");
          const paused = await player();
          expect(paused.paused).toBe(true);
          expect(paused.at).toBeGreaterThan(0.3);
          expect(await text(page, "#play")).toBe("▶ Play");
          await page.waitForTimeout(400);
          expect((await player()).at).toBe(paused.at);
          await page.keyboard.press("Space");
          expect((await player()).paused).toBe(false);
          await until(async () => (await player()).at > paused.at, 5000, "playing on");
          // It went on from where it stopped, not from the line's start.
          expect((await player()).at).toBeGreaterThanOrEqual(paused.at);
          // The button pauses and resumes too.
          await page.click("#play");
          expect((await player()).paused).toBe(true);
          const at = (await player()).at;
          await page.click("#play");
          expect((await player()).paused).toBe(false);
          expect((await player()).at).toBeGreaterThanOrEqual(at);
          // In a text field, Space is a space.
          await page.click("#note-input");
          await page.keyboard.type("a b");
          expect(await page.inputValue("#note-input")).toBe("a b");
          expect((await player()).paused).toBe(false);
          // On any other button, Space presses that button and leaves the audio alone.
          await page.focus("#copy-transcript");
          await page.keyboard.press("Space");
          await page.waitForSelector("#toast:not([hidden])");
          expect((await player()).paused).toBe(false);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W5.2] opening another call stops the first call's audio: Play is disabled and Space plays nothing",
    async () => {
      let a = "";
      let b = "";
      await withRig(
        {
          seed: (home) => {
            a = seedCall(home, (x) => standardCall(x)).id;
            b = seedCall(home, (x) => standardCall(x, "01J8Z6Q4M2VX0K7B3D4E5SECND")).id;
          },
        },
        async (rig) => {
          const folder = (await rig.api("GET", `/calls/${a}`)).body.folder as string;
          writeFileSync(
            join(folder, "audio", "part-001.opus"),
            stereoWav(new Float32Array(16000 * 12), new Float32Array(16000 * 12)),
          );
          const page = await rig.open(a);
          await page.waitForSelector("#lines .row >> nth=3");
          const player = () =>
            page.evaluate(() => {
              const p = document.getElementById("player") as HTMLAudioElement;
              return { paused: p.paused, at: p.currentTime };
            });
          await page.hover('#lines .row[data-id="l000003"]');
          await page.click('#lines .row[data-id="l000003"] .play');
          await until(async () => (await player()).at > 0.3, 8000, "the line playing");
          await page.click(`#calls li[data-id="${b}"] button`);
          await until(
            async () => (await page.locator("#play").isDisabled()) && (await player()).paused,
            5000,
            "the player cleared",
          );
          expect(await text(page, "#play")).toBe("▶ Play");
          expect(await page.locator("#player").getAttribute("data-line")).toBeNull();
          await page.click("#scroller");
          await page.keyboard.press("Space");
          await page.waitForTimeout(300);
          expect((await player()).paused).toBe(true);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[W5.2] a line's audio that arrives after another call opened is not loaded into the player",
    async () => {
      let a = "";
      let b = "";
      await withRig(
        {
          seed: (home) => {
            a = seedCall(home, (x) => standardCall(x)).id;
            b = seedCall(home, (x) => standardCall(x, "01J8Z6Q4M2VX0K7B3D4E5SECND")).id;
          },
        },
        async (rig) => {
          const folder = (await rig.api("GET", `/calls/${a}`)).body.folder as string;
          writeFileSync(
            join(folder, "audio", "part-001.opus"),
            stereoWav(new Float32Array(16000 * 12), new Float32Array(16000 * 12)),
          );
          const page = await rig.open(a);
          await page.waitForSelector("#lines .row >> nth=3");
          // Hold the first call's audio until the other call is open.
          const held: Route[] = [];
          await page.route("**/api/v1/calls/*/audio/*", (r) => void held.push(r));
          await page.hover('#lines .row[data-id="l000003"]');
          await page.click('#lines .row[data-id="l000003"] .play');
          await until(async () => held.length === 1, 5000, "the audio request");
          await page.click(`#calls li[data-id="${b}"] button`);
          expect(await page.getAttribute(`#calls li[data-id="${b}"] button`, "aria-current")).toBe(
            "true",
          );
          const arrived = page.waitForResponse("**/api/v1/calls/*/audio/*");
          await held[0]?.fallback();
          await (await arrived).finished();
          await page.waitForTimeout(500);
          const player = await page.evaluate(() => {
            const p = document.getElementById("player") as HTMLAudioElement;
            return { src: p.getAttribute("src"), line: p.dataset.line ?? null, paused: p.paused };
          });
          expect(player).toEqual({ src: null, line: null, paused: true });
          expect(await page.locator("#play").isDisabled()).toBe(true);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "[decision] File vocabulary that silently corrects nothing: a workspace file entry corrects the window's line, and a change to the files reaches the open window",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          // A file entry, not a call-scoped one: the page's own fold has no dictionary and never
          // applies it, so only the app's reading can.
          const add = await rig.api("POST", "/vocab", {
            term: "Hetzner Cloud",
            heard: ["hetzner"],
            workspace: "work",
            decode: false,
          });
          expect(add.status).toBeLessThan(300);
          const page = await rig.open(id);
          const line = page.locator('#lines .row[data-id="l000003"] .text');
          await until(
            async () => (await line.textContent()) === "deploy to Hetzner Cloud today",
            5000,
            "the file correction",
          );
          expect(await line.getAttribute("title")).toBe('heard: "deploy to hetzner today"');
          const del = await rig.api("DELETE", "/vocab/Hetzner%20Cloud?workspace=work");
          expect(del.status).toBe(200);
          await until(
            async () => (await line.textContent()) === "deploy to hetzner today",
            5000,
            "the entry removed",
          );
          expect(await line.getAttribute("title")).toBeNull();
        },
      );
    },
    UI_TIMEOUT,
  );

  /** A saved call with the same mishearing on two lines. */
  const twice = (b: import("../helpers.ts").LogBuilder) => {
    b.created();
    b.partStarted(1, T0);
    b.seg({
      id: "l000001",
      ch: "call",
      spk: "c1",
      w0: T0 + 1000,
      text: "we should move the build",
    });
    b.seg({ id: "l000002", ch: "call", spk: "c2", w0: T0 + 3000, text: "deploy to hetzner today" });
    b.seg({ id: "l000003", ch: "call", spk: "c1", w0: T0 + 6000, text: "is hetzner up" });
    b.partEnded(1, "stop", 12);
    b.add({ type: "call.ended", reason: "stop" });
  };
  /** Dotted setting and event names (`asr.live`, `vocab.add`) that must never reach a person. */
  const RAW_KEY =
    /\b(asr|vocab|provider|share|capture|dictation|export|api|final|call|seg|note)\.[a-z][A-Za-z.]*/;
  const shownText = (page: Page) =>
    page.evaluate(() =>
      ["#popover", "#toast", "#notes"]
        .map((sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? "")
        .join("\n"),
    );

  test(
    "[W4.8] Fix this line: the same word reads right on every line at once, the term is learned with a quiet toast, and Undo takes it back",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, twice).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector("#lines .row >> nth=2");
        await page.hover('#lines .row[data-id="l000002"]');
        await page.click('#lines .row[data-id="l000002"] .fix');
        await page.waitForSelector("#popover:not([hidden])");
        // One field: the line as it reads.
        expect(await page.locator("#popover input").count()).toBe(1);
        expect(await page.inputValue("#popover input")).toBe("deploy to hetzner today");
        await page.fill("#popover input", "deploy to Hetzner today");
        await page.keyboard.press("Enter");
        const line = (lid: string) => page.locator(`#lines .row[data-id="${lid}"] .text`);
        await until(
          async () => (await line("l000003").textContent()) === "is Hetzner up",
          5000,
          "the other line corrected",
        );
        expect(await line("l000002").textContent()).toBe("deploy to Hetzner today");
        expect(await page.isVisible("#popover")).toBe(false);
        // A quiet one-line toast says what was learned, with Undo.
        await page.waitForSelector("#toast.info:not([hidden])");
        expect(await text(page, "#toast")).toBe(
          "Learned Hetzner: 2 lines fixed. Noted for the final transcript. Undo",
        );
        // In the workspace's vocabulary with no review (a file keeps no heard form that differs
        // from its term only in case), and in the Notes as a fix.
        const words = (await rig.api("GET", "/vocab?workspace=work")).body.entries;
        expect(words).toContainEqual(
          expect.objectContaining({ term: "Hetzner", source: "correction", confirmed: true }),
        );
        await page.waitForSelector("#notes li.note.fix");
        expect(await text(page, "#notes li.note.fix .note-text")).toBe("Fixed: hetzner -> Hetzner");
        expect(await text(page, "#notes li.note.fix .author")).toBe("from a fix");
        expect(await shownText(page)).not.toMatch(RAW_KEY);
        await page.click("#toast button.toast-action");
        await until(
          async () => (await line("l000003").textContent()) === "is hetzner up",
          5000,
          "the fix undone",
        );
        await until(
          async () => (await page.locator("#notes li.note").count()) === 0,
          5000,
          "note gone",
        );
        const after = (await rig.api("GET", "/vocab?workspace=work")).body.entries ?? [];
        expect(after.map((e: { term: string }) => e.term)).not.toContain("Hetzner");
        // Positive control: a raw key in the toast is caught.
        await page.evaluate(() => {
          (document.getElementById("toast") as HTMLElement).textContent = "set asr.live first";
        });
        expect(await shownText(page)).toMatch(RAW_KEY);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "[W4.8] Fix this line: a rewording stays on its line and goes into the Notes",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = seedCall(home, twice).id) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector("#lines .row >> nth=2");
        await page.hover('#lines .row[data-id="l000001"]');
        await page.click('#lines .row[data-id="l000001"] .fix');
        await page.waitForSelector("#popover:not([hidden])");
        await page.fill("#popover input", "we could move the build");
        await page.keyboard.press("Enter");
        await page.waitForSelector("#toast.info:not([hidden])");
        expect(await text(page, "#toast")).toBe(
          "should → could fixed on this line. Noted for the final transcript. Undo",
        );
        expect(await text(page, '#lines .row[data-id="l000001"] .text')).toBe(
          "we could move the build",
        );
        await page.waitForSelector("#notes li.note.fix");
        expect(await text(page, "#notes li.note.fix .note-text")).toBe("Fixed: should -> could");
        const words = (await rig.api("GET", "/vocab?workspace=work")).body.entries ?? [];
        expect(words.map((e: { term: string }) => e.term)).not.toContain("could");
      });
    },
    UI_TIMEOUT,
  );
});

describe("copy the transcript so far (W12.2)", () => {
  /** The export's `## Transcript` section for the call as the app sees it now. */
  const section = async (rig: UiRig, id: string) => {
    const view = (await rig.app.call(id)).view;
    const md = renderExport({ view, version: "0.0.0", enhanced: null, audio: [], rev: 1 });
    return md.slice(md.indexOf("## Transcript"));
  };
  const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

  test(
    "[W12.2] during a call, Mod+Shift+C copies the transcript as the export's Transcript section",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall({ title: "Copy live" });
        const page = await rig.open(id);
        await page.context().grantPermissions([...CLIPBOARD_PERMISSIONS]);
        await page.evaluate(() => navigator.clipboard.writeText("before"));
        await rig.write(id, seg("l000001", "we should move the build", { spk: "c1" }));
        await rig.write(id, seg("l000002", "which region", { spk: "c2" }));
        await until(async () => (await rowIds(page)).length === 2, 5000, "two rows");
        await page.click("#scroller");
        await page.keyboard.press("ControlOrMeta+Shift+C");
        await until(async () => (await clipboard(page)) !== "before", 5000, "the copy");
        const copied = await clipboard(page);
        expect(copied).toBe(await section(rig, id));
        expect(copied).toStartWith("## Transcript\n");
        expect(copied).toContain("which region");
        // The key's scope is the window: it copies while a note is being typed too.
        await page.evaluate(() => navigator.clipboard.writeText("before"));
        await page.click("#note-input");
        await page.keyboard.press("ControlOrMeta+Shift+C");
        await until(
          async () => (await clipboard(page)) !== "before",
          5000,
          "the copy from a field",
        );
        expect(await clipboard(page)).toBe(copied);
        // On a layout where the key is not "c" (Cyrillic "с" here), the physical C key still copies.
        await page.evaluate(() => navigator.clipboard.writeText("before"));
        await page.evaluate(() => {
          const mac = /mac/i.test(navigator.platform);
          document.getElementById("scroller")?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "С",
              code: "KeyC",
              shiftKey: true,
              metaKey: mac,
              ctrlKey: !mac,
              bubbles: true,
            }),
          );
        });
        await until(async () => (await clipboard(page)) !== "before", 5000, "the copy on Cyrillic");
        expect(await clipboard(page)).toBe(copied);
        // The button names the chord with the keys this computer has, never the doc's "Mod".
        const chord = await page.evaluate(() =>
          /mac/i.test(navigator.platform) ? "⌘⇧C" : "Ctrl+Shift+C",
        );
        expect(await page.getAttribute("#copy-transcript", "title")).toBe(
          `Copy the transcript so far as Markdown (${chord})`,
        );
        await rig.api("POST", "/calls/live/stop");
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "[W12.2] after the final pass, the header's Copy transcript copies the final layer",
    async () => {
      let id = "";
      await withRig(
        {
          seed: (home) =>
            (id = seedCall(home, (b) => {
              standardCall(b);
              b.add({ type: "final.started", pid: 1 });
              b.seg({ id: "f000001", ch: "call", spk: "c1", w0: T0 + 3000, text: "final words" });
              b.add({ type: "final.part.done", part: 1 });
              b.add({ type: "final.done", parts: [1], skipped: [] });
            }).id),
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.context().grantPermissions([...CLIPBOARD_PERMISSIONS]);
          await page.waitForSelector("#lines .row");
          // The clipboard can outlive a browser context (Chromium on Linux keeps the earlier
          // test's copy), so wait for this click's write, not for any transcript.
          await page.evaluate(() => navigator.clipboard.writeText("before"));
          await page.click("#copy-transcript");
          await until(async () => (await clipboard(page)) !== "before", 5000, "the copy");
          const copied = await clipboard(page);
          expect(copied).toBe(await section(rig, id));
          expect(copied).toContain("final words");
          expect(copied).not.toContain("hello everyone");
          // A clipboard that refuses says so in plain words, without the browser's own message.
          await page.evaluate(() => {
            const refuse = () =>
              Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
            navigator.clipboard.write = refuse;
            navigator.clipboard.writeText = refuse;
          });
          await page.click("#copy-transcript");
          await until(
            async () => (await text(page, "#toast")) === "The clipboard is not available here.",
            5000,
            "the refusal",
          );
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("the share viewer (DESIGN 8.3)", () => {
  test(
    "the viewer stays where the reader scrolled: pinned only at the bottom, Back to live, + and -, the offset tooltip",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => longCall(b, 60)).id) },
        async (rig) => {
          const share = await rig.api("POST", "/share", { call: id });
          expect(share.status).toBe(201);
          const viewer = await (await launch()).newPage();
          await viewer.goto(share.body.url as string);
          await viewer.waitForSelector("#lines .row >> nth=59");
          await until(async () => (await gapOf(viewer)) < 2, 3000, "pinned at the bottom");
          expect(await viewer.locator("#lines .row time").first().getAttribute("title")).toBe(
            "4 s into the call",
          );
          expect(await viewer.locator("#jump").isVisible()).toBe(false);
          // The reader scrolls up: a new line and a rename leave them where they are. (Let the
          // smooth scroll to the bottom finish first, or its last frame lands after ours.)
          await Bun.sleep(300);
          await viewer.evaluate(() => {
            const s = document.getElementById("scroller") as HTMLElement;
            s.style.scrollBehavior = "auto";
            s.scrollTop = 0;
          });
          await viewer.waitForSelector("#jump", { state: "visible" });
          const top = () =>
            viewer.evaluate(() => (document.getElementById("scroller") as HTMLElement).scrollTop);
          await rig.write(id, seg("l000061", "a brand new line", { w0: T0 + 61 * 4000 }));
          await viewer.waitForSelector('#lines .row[data-id="l000061"]');
          await Bun.sleep(300);
          expect(await top()).toBeLessThan(10);
          expect(
            (await rig.api("POST", `/calls/${id}/speakers`, { spk: "c1", name: "Ben" })).status,
          ).toBe(200);
          await until(
            async () =>
              (await viewer.locator('#lines .row[data-id="l000001"] .who').textContent()) === "Ben",
            5000,
            "renamed in the viewer",
          );
          await Bun.sleep(300);
          expect(await top()).toBeLessThan(10);
          // Back to live, then pinned again.
          await viewer.click("#jump");
          await until(async () => (await gapOf(viewer)) < 2, 3000, "back at the bottom");
          await viewer.waitForSelector("#jump", { state: "hidden" });
          // Font size: + and -, as in the window.
          const size = () =>
            viewer.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--size"),
            );
          await viewer.locator("#scroller").focus();
          await viewer.keyboard.press("+");
          expect(await size()).toBe("24px");
          await viewer.keyboard.press("-");
          await viewer.keyboard.press("-");
          expect(await size()).toBe("20px");
          await viewer.close();
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "the Share button starts a link; the viewer shows the call read only, inert, and counts as a viewer",
    async () => {
      let id = "";
      await withRig(
        {
          seed: (home) => {
            id = seedCall(home, (b) => {
              standardCall(b);
              b.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
              b.add({
                type: "note",
                id: "n0001",
                rev: 1,
                text: "private",
                w: T0 + 1,
                afterSeq: 1,
                by: "user",
              });
            }).id;
          },
        },
        async (rig) => {
          await rig.write(id, seg("l000009", XSS, { w0: T0 + 20_000 }));
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=4");
          await page.click("#share-start");
          await page.waitForSelector("#pill-share:not([hidden])");
          const url = (await rig.api("GET", "/share")).body.shares[0].url as string;
          const viewer = await (await launch()).newPage();
          await viewer.goto(url);
          await viewer.waitForSelector("#lines .row >> nth=4");
          expect(await viewer.locator('#lines .row[data-id="l000002"] .who').textContent()).toBe(
            "Ben",
          );
          expect(await viewer.locator('#lines .row[data-id="l000009"] .text').textContent()).toBe(
            XSS,
          );
          expect(await viewer.locator("#lines img").count()).toBe(0);
          expect(
            await viewer.evaluate(() => (window as unknown as { __xss?: number }).__xss),
          ).toBeUndefined();
          expect(await viewer.locator("#controls, #record, #note-input").count()).toBe(0);
          expect(await viewer.locator("text=private").count()).toBe(0);
          await until(
            async () => (await text(page, "#share-text")) === "Shared live · 1 viewer",
            5000,
            "one viewer",
          );
          // A new line reaches the viewer without a reload.
          await rig.write(id, seg("l000010", "shared live line", { w0: T0 + 30_000 }));
          await viewer.waitForSelector('#lines .row[data-id="l000010"]');
          await viewer.close();
          await page.click("#share-stop");
          await page.waitForSelector("#pill-share", { state: "hidden" });
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("the welcome: readiness drives the shell (WINDOW section 10)", () => {
  test(
    "with the models missing the welcome replaces the workspace, Record waits, and the download's progress rides the status push",
    async () => {
      const reg = modelRegistry(64 * 1024);
      const home = tempDir("akou-ui-welcome-");
      const modelsDir = join(home.dir, "models");
      mkdirSync(modelsDir, { recursive: true });
      const catalog = [reg.entry(RECOGNIZER, ["a.onnx"]), reg.entry(NEMOTRON, ["d.onnx"])];
      // The recognizer's file sends its first bytes, then waits: the download is caught mid-way.
      const release = reg.hold("a.onnx", 4096);
      try {
        await withRig(
          {
            modelRegistry: catalog,
            settings: { "asr.modelsDir": modelsDir, "asr.diarizer": "nemotron" },
          },
          async (rig) => {
            const page = await rig.open();
            await page.waitForSelector("#welcome:not([hidden]) #models-pull:not([hidden])");
            // No transcript, notes or player: they carry hidden, and the watch checks that hidden
            // means hidden. The sidebar stays, with its empty workspace, and its readiness row
            // says what is missing; the Models row carries the amber dot.
            for (const sel of ["#scroller", "#side"]) {
              expect(await page.getAttribute(sel, "hidden")).toBe("");
            }
            expect(await page.isVisible("#notes-title")).toBe(false);
            expect(await page.isVisible("#player-bar")).toBe(false);
            expect(await page.isVisible("#sidebar")).toBe(true);
            expect(await text(page, "#calls .none")).toBe("No calls yet");
            await until(
              async () => (await text(page, "#readiness-text")) === "Models missing",
              5000,
              "the readiness row",
            );
            expect(await page.getAttribute("#readiness", "data-state")).toBe("missing");
            expect(await text(page, "#readiness-setup")).toBe("Setup 1 of 3");
            expect(await page.isVisible("#readiness-where")).toBe(false);
            // Under 1248 px the sidebar narrows; "Setup 1 of 3" must stay inside it and clickable.
            const wide = page.viewportSize() ?? { width: 1280, height: 720 };
            await page.setViewportSize({ width: 1200, height: 800 });
            const bar = await page.locator("#sidebar").boundingBox();
            const setup = await page.locator("#readiness-setup").boundingBox();
            expect(bar && setup).toBeTruthy();
            if (bar && setup) {
              expect(setup.x).toBeGreaterThanOrEqual(bar.x);
              expect(setup.x + setup.width).toBeLessThanOrEqual(bar.x + bar.width);
            }
            await page.click("#readiness-setup", { timeout: 5000 });
            expect(await page.evaluate(() => document.activeElement?.id)).toBe("models-pull");
            await page.setViewportSize(wide);
            expect(await page.isVisible("#models-pip")).toBe(true);
            expect(await text(page, "#welcome h1")).toBe("Welcome to akou");
            // One row per model the download fetches, the recognizer first, each with its size.
            await page.waitForSelector("#models-rows:not([hidden]) li >> nth=1");
            expect(
              await page.$$eval("#models-rows li", (li) =>
                li.map((l) => (l as HTMLElement).dataset.id),
              ),
            ).toEqual([RECOGNIZER, NEMOTRON]);
            expect(await text(page, "#models-rows li .sz")).toBe("66 KB");
            expect(await text(page, "#models-size")).toBe("131 KB");
            expect(await text(page, "#models-text")).toBe("One download, 131 KB");
            expect(await text(page, "#models-where-text")).toBe(
              `Kept in ${modelsDir}. Nothing leaves this computer.`,
            );
            // Record waits, and says why.
            expect(await page.isDisabled("#record")).toBe(true);
            expect(await page.getAttribute("#record", "title")).toBe(
              "Record needs the speech models: download them first.",
            );
            // No workspace means no composer controls: the row keeps only its state word, and
            // that word never says ready while nothing can record.
            expect(await page.isVisible("#state")).toBe(true);
            expect(await text(page, "#state")).toBe("setup");
            for (const sel of ["#record", "#newtitle", "#template", "#meters"]) {
              expect(await page.isVisible(sel)).toBe(false);
            }

            // The agent step's quiet button opens Settings on the provider field.
            await page.click("#welcome-agent");
            await page.waitForSelector("#page-settings:not([hidden])");
            await until(
              async () =>
                (await page.evaluate(
                  () => (document.activeElement as HTMLElement | null)?.dataset.key,
                )) === "provider.kind",
              5000,
              "the provider setting focused",
            );
            // The sidebar's Calls is the way back to the welcome.
            await page.click("#calls-open");
            await page.waitForSelector("#welcome", { state: "visible" });

            // Every GET /models from here on fails, so what moves the bar is the status push.
            await page.route("**/api/v1/models", (r) => r.abort());
            // A reload would lose this mark.
            await page.evaluate(() => {
              (window as unknown as { __same?: boolean }).__same = true;
            });
            await page.click("#models-pull");
            await page.waitForSelector("#models-progress:not([hidden])");
            expect(await page.isVisible("#models-pull")).toBe(false);
            await until(
              async () =>
                (await page.$eval("#models-progress", (p) => (p as HTMLProgressElement).value)) > 0,
              10_000,
              "progress from the status push",
            );
            expect(await text(page, "#models-text")).toMatch(/^\d+ KB of 131 KB · \d+ % · /);
            expect(await page.getAttribute("#record", "title")).toContain("finish downloading");
            expect(await text(page, "#readiness-text")).toBe("Downloading models");

            // The download finishes: the welcome goes by itself, without a reload.
            release();
            await page.waitForSelector("#welcome", { state: "hidden", timeout: 10_000 });
            for (const sel of ["#scroller", "#side"]) {
              expect(await page.getAttribute(sel, "hidden")).toBeNull();
            }
            expect(await page.isVisible("#notes-title")).toBe(true);
            expect(await text(page, "#readiness-text")).toBe("Ready");
            expect(await page.getAttribute("#readiness", "data-state")).toBe("ready");
            expect(await text(page, "#state")).toBe("ready");
            expect(await page.isVisible("#models-pip")).toBe(false);
            expect(await page.isVisible("#readiness-setup")).toBe(false);
            expect(await page.isDisabled("#record")).toBe(false);
            expect(await page.isVisible("#record")).toBe(true);
            expect(await page.getAttribute("#record", "title")).toBe("");
            expect(
              await page.evaluate(() => (window as unknown as { __same?: boolean }).__same),
            ).toBe(true);
          },
        );
      } finally {
        release();
        reg.stop();
        home.cleanup();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "a call picked from the sidebar lifts the welcome; the readiness row brings it back",
    async () => {
      // One model file that is not on disk, so the welcome shows; nothing is downloaded.
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
      let id = "";
      await withRig(
        { modelRegistry, seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open();
          await page.waitForSelector("#welcome:not([hidden]) #models-pull:not([hidden])");
          // The saved call opens behind the welcome on its own; the word still follows the welcome.
          expect(await text(page, "#state")).toBe("setup");
          // The saved call is listed while the welcome shows, and one click opens it.
          await page.click(`#calls li[data-id="${id}"] button`);
          await page.waitForSelector("#welcome", { state: "hidden" });
          await page.waitForSelector("#lines .row >> nth=3");
          expect(await text(page, "#state")).toBe("saved");
          expect(await page.getAttribute("#scroller", "hidden")).toBeNull();
          expect(await text(page, "#readiness-text")).toBe("Models missing");
          // Setup 1 of 3 goes back to the welcome, on its download.
          await page.click("#readiness-setup");
          await page.waitForSelector("#welcome:not([hidden])");
          expect(await page.getAttribute("#scroller", "hidden")).toBe("");
          expect(await page.evaluate(() => document.activeElement?.id)).toBe("models-pull");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "a pull or a fallback poll whose request fails is a toast or a skipped tick, never an unhandled rejection",
    async () => {
      // One model file that is not on disk, so the welcome offers the download.
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
        const page = await rig.open();
        await page.waitForSelector("#welcome:not([hidden]) #models-pull:not([hidden])");

        // The request itself fails (the app quit, the network dropped): the button says so.
        await page.route("**/api/v1/models/pull", (r) => r.abort());
        await page.click("#models-pull");
        await page.waitForSelector("#toast:not([hidden])");
        expect(await text(page, "#toast")).toContain("could not start");

        // A pull answered "downloading" that no status push follows: the poll is the fallback,
        // and each of its failed ticks is skipped, none throws.
        await page.unroute("**/api/v1/models/pull");
        const { dir } = (await rig.api("GET", "/models")).body as { dir: string };
        await page.route("**/api/v1/models/pull", (r) =>
          r.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({ state: "downloading", dir, bytes: 0, total: 1e6 }),
          }),
        );
        let polls = 0;
        await page.route("**/api/v1/models", (r) => {
          polls++;
          return r.abort();
        });
        await page.click("#models-pull");
        await page.waitForSelector("#models-progress:not([hidden])");
        await until(async () => polls >= 2, 15_000, "two failed polls");
      });
    },
    UI_TIMEOUT,
  );
});

describe("the page's own guard", () => {
  test(
    "the code leaves the address bar; a used link is dead; another site cannot drive the app",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall();
        const r = await rig.api("POST", "/window", { call: id });
        const b = await launch();
        const page = await b.newPage();
        await page.goto(r.body.url);
        await page.waitForFunction(() => document.body.dataset.transport === "browser");
        expect(new URL(page.url()).hash).toBe("");
        // The same address again, in a fresh tab: the code is spent.
        const again = await (await b.newContext()).newPage();
        await again.goto(r.body.url);
        await again.waitForSelector("#fatal:not([hidden])");
        expect(await text(again, "#fatal")).toContain("used already or has expired");
        // A page on another origin fires at the page server: refused, the call still recording.
        const origin = rig.app.page?.origin as string;
        const evil = await b.newPage();
        await evil.goto("about:blank");
        const statuses = await evil.evaluate(async (o) => {
          const out: number[] = [];
          for (const init of [
            { method: "POST", mode: "no-cors" as RequestMode, body: "{}" },
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
          ]) {
            try {
              const res = await fetch(`${o}/api/v1/calls/live/stop`, init);
              out.push(res.status);
            } catch {
              out.push(-1);
            }
          }
          return out;
        }, origin);
        expect(statuses.every((s) => s === 0 || s === -1 || s === 403 || s === 401)).toBe(true);
        expect((await rig.api("GET", `/calls/${id}`)).body.state).toBe("recording");
        await rig.api("POST", "/calls/live/stop");
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );
});
