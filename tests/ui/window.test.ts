/**
 * The window's new parts and its traps (docs/DESIGN.md sections 5.1 to 5.3, 7 and 8.3; TRAPS
 * "Page refetched the whole transcript every second", "Wake from sleep"), on the real page in a
 * headless browser: reconnecting without duplicates or gaps, XSS, request counting, the dead-call
 * banner from the fake helper, keyboard access, the notepad, the ask box, enhanced notes,
 * settings, playback, "Fix this word", the meters, the share viewer and the page's own guard.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { formatWall } from "../../src/core/log/clock.ts";
import type { LogEvent } from "../../src/core/log/events.ts";
import { stereoWav } from "../fixtures/audio.ts";
import { tempDir } from "../helpers.ts";
import {
  FakeProvider,
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
        const page = await rig.open(id);
        await page.waitForSelector("#banner.dead", { timeout: 25_000 });
        expect(await text(page, "#banner-text")).toContain("CALL AUDIO LOST");
        expect((await events(rig, id)).some((e) => e.type === "health")).toBe(true);
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
          await page.click("#tab-ask");
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
    "Record and Stop are reachable with Tab and work with Enter; the tabs move with the arrow keys",
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
        await focusOn("tab-notes");
        const outline = await page.evaluate(
          () => getComputedStyle(document.activeElement as Element).outlineStyle,
        );
        expect(outline).not.toBe("none");
        await page.keyboard.press("ArrowRight");
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("tab-ask");
        expect(await page.locator("#pane-ask").isVisible()).toBe(true);
      });
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
          await page.click("#tab-ask");
          expect(await page.locator("#ask-presets .preset").allTextContents()).toEqual([
            "Catch me up",
            "Was my name mentioned?",
            "Decisions so far",
            "Action items",
            "What did Ben say?",
          ]);
          await page.click("#ask-presets >> text=What did Ben say?");
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
});

describe("enhanced notes and templates (DESIGN 5.2)", () => {
  test(
    "Enhance writes the notes; the user's lines are marked as theirs, the AI's cite lines",
    async () => {
      let id = "";
      const provider = new FakeProvider();
      provider.answer = () => "## Decisions\n- Move the build to the new box [#l000002]\n- {n0001}";
      await withRig(
        {
          provider,
          seed: (home) => {
            id = seedCall(home, (b) => {
              standardCall(b);
              b.add({
                type: "note",
                id: "n0001",
                rev: 1,
                text: "new box?",
                w: T0 + 4000,
                afterSeq: 4,
                by: "user",
              });
            }).id;
          },
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await page.click("#tab-enhanced");
          await page.waitForSelector("#enhance-template option[value=standup]", {
            state: "attached",
          });
          expect(await text(page, "#enhance")).toBe("Enhance");
          await page.selectOption("#enhance-template", "general");
          await page.click("#enhance");
          await page.waitForSelector("#enhanced-body li.ai");
          expect(await text(page, "#enhanced-body h3")).toBe("Decisions");
          expect(
            await page.locator("#enhanced-body li.ai button.cite").getAttribute("data-line"),
          ).toBe("l000002");
          expect(await text(page, "#enhanced-body li.mine")).toContain("new box?");
          const e = (await events(rig, id)).find((x) => x.type === "enhanced") as LogEvent & {
            template: string;
          };
          expect(e.template).toBe("general");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "during the call the button says Enhance so far",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall();
        const page = await rig.open(id);
        await page.click("#tab-enhanced");
        await until(
          async () => (await text(page, "#enhance")) === "Enhance so far",
          5000,
          "so far",
        );
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );
});

describe("the words to review (DESIGN 5.4, 7)", () => {
  test(
    "Find misheard words runs the pass; the review screen shows each proposal with its line; Approve writes the workspace file",
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
          await page.click("#tab-enhanced");
          await page.click("#vocab-pass");
          await page.waitForSelector("#review[open] .review-item[data-term=Hetzner]");
          // The bad span (hetzner is not in l000001) was dropped; the proposal carries its line.
          expect(await text(page, "#review-status")).toContain("corrected 0 words and proposed 1");
          expect(await text(page, ".review-item[data-term=Hetzner] .review-lines li")).toContain(
            "deploy to hetzner today",
          );
          expect(await page.isVisible("#pill-review")).toBe(true);
          expect(await text(page, "#pill-review")).toBe("1 word to review");
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

describe("re-enhance after the final layer (DESIGN 5.2)", () => {
  test(
    "notes written by hand before the final layer get a Re-enhance button, and it writes them from the final transcript",
    async () => {
      let id = "";
      const provider = new FakeProvider();
      provider.answer = () => "## Decisions\n- Move the build to the new box [#l000002]";
      await withRig(
        {
          provider,
          seed: (home) => {
            const seeded = seedCall(home, (b) => {
              standardCall(b);
              b.add({
                type: "enhanced",
                rev: 1,
                template: "general",
                file: "enhanced/001-general.md",
                coversSeq: 6,
                by: "agent:claude-code",
                model: "agent:claude-code",
                cites: ["l000002"],
              });
              b.add({ type: "final.started", pid: 1 });
              b.add({ type: "final.done", parts: [1], skipped: [] });
            });
            id = seeded.id;
            mkdirSync(join(seeded.dir, "enhanced"), { recursive: true });
            writeFileSync(
              join(seeded.dir, "enhanced", "001-general.md"),
              "## Decisions\n- the build moves [#l000002]\n",
            );
          },
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await page.click("#tab-enhanced");
          await page.waitForSelector("#reenhance");
          expect(await text(page, "#enhance-status")).toContain("written by hand");
          await page.click("#reenhance");
          await until(
            async () => (await events(rig, id)).some((e) => e.type === "enhanced" && e.rev === 2),
            10_000,
            "rev 2",
          );
          const e = (await events(rig, id)).find(
            (x) => x.type === "enhanced" && x.rev === 2,
          ) as LogEvent & { template: string };
          expect(e.template).toBe("general");
          await until(async () => !(await page.isVisible("#reenhance")), 5000, "button gone");
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("enhanced notes with no provider", () => {
  test(
    "one plain sentence under the button, no toast, and a button to the provider setting",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await page.click("#tab-enhanced");
          await page.click("#enhance");
          await until(
            async () => ((await text(page, "#enhance-status")) ?? "").startsWith("No provider"),
            5000,
            "the status line",
          );
          const status = (await text(page, "#enhance-status")) ?? "";
          expect(status).not.toContain("enhance/context");
          expect(await page.locator("#toast").isVisible()).toBe(false);
          await page.locator("#enhance-status button").click();
          await page.waitForSelector("#settings[open]");
          await until(
            async () =>
              (await page.evaluate(
                () => (document.activeElement as HTMLElement | null)?.dataset.key,
              )) === "provider.kind",
            5000,
            "the provider setting focused",
          );
        },
      );
    },
    UI_TIMEOUT,
  );
});

describe("settings (driven by the registry)", () => {
  test(
    "every key the registry keeps file only is shown disabled, read from the schema",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await page.click("#settings-open");
        await page.waitForSelector("#settings[open] .setting >> nth=5");
        const schema = (await rig.api("GET", "/config")).body.schema as Record<
          string,
          { apiWritable: boolean }
        >;
        const fileOnly = Object.keys(schema).filter((k) => schema[k]?.apiWritable === false);
        expect(fileOnly).toContain("provider.baseUrl");
        expect(fileOnly).toContain("provider.harnessPath");
        for (const k of Object.keys(schema)) {
          const disabled = await page.locator(`#settings [data-key="${k}"]:not(div)`).isDisabled();
          expect({ k, disabled }).toEqual({ k, disabled: fileOnly.includes(k) });
        }
      });
    },
    UI_TIMEOUT,
  );

  test(
    "every registry key is shown; a change is saved; an out-of-range value is refused and shown",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await page.click("#settings-open");
        await page.waitForSelector("#settings[open] .setting >> nth=5");
        const keys = await page.$$eval("#settings .setting", (els) =>
          els.map((e) => (e as HTMLElement).dataset.key),
        );
        const schema = Object.keys((await rig.api("GET", "/config")).body.schema);
        expect(keys).toEqual(schema);
        // Programs akou runs are file only.
        expect(
          await page.locator('#settings [data-key="capture.helper"]:not(div)').isDisabled(),
        ).toBe(true);
        await page.fill('#settings [data-key="user.name"]:not(div)', "Ana Maria");
        await page.click("#settings button[type=submit]");
        await until(
          async () => (await rig.api("GET", "/config")).body.settings["user.name"] === "Ana Maria",
          5000,
          "saved",
        );
        // The pane redraws from the saved file; wait for it before typing again.
        await until(
          async () =>
            (await page.inputValue('#settings [data-key="user.name"]:not(div)')) === "Ana Maria" &&
            (await page.locator("#toast.info").isVisible()),
          5000,
          "the redraw after saving",
        );
        await page.fill('#settings [data-key="asr.threads"]:not(div)', "999");
        await page.click("#settings button[type=submit]");
        await page.waitForSelector('#settings div.setting.refused[data-key="asr.threads"]');
        expect((await rig.api("GET", "/config")).body.settings["asr.threads"]).not.toBe(999);
      });
    },
    UI_TIMEOUT,
  );
});

describe("playback and Fix this word", () => {
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
    "Fix this word: a call-scoped correction for the line, then everywhere, then the workspace file",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await page.hover('#lines .row[data-id="l000003"]');
          await page.click('#lines .row[data-id="l000003"] .fix');
          await page.waitForSelector("#popover:not([hidden])");
          await page.fill('#popover input[aria-label="What akou heard"]', "hetzner");
          await page.fill('#popover input[aria-label="What was said"]', "Hetzner Cloud");
          await page.click("#popover button[type=submit]");
          const line = page.locator('#lines .row[data-id="l000003"] .text');
          await until(
            async () => (await line.textContent()) === "deploy to Hetzner Cloud today",
            5000,
            "the correction",
          );
          expect(await line.getAttribute("title")).toBe('heard: "deploy to hetzner today"');
          const adds = () =>
            events(rig, id).then(
              (ev) =>
                ev.filter((e) => e.type === "vocab.add") as (LogEvent & {
                  segs?: string[];
                  by: string;
                })[],
            );
          expect((await adds())[0]).toMatchObject({ segs: ["l000003"], by: "user" });
          await page.click("#popover >> text=Everywhere in this call");
          await until(async () => (await adds()).length === 2, 5000, "the call-wide entry");
          expect((await adds())[1]?.segs).toBeUndefined();
          await page.click("#popover >> text=Add to the workspace vocabulary");
          await until(
            async () =>
              ((await rig.api("GET", "/vocab?workspace=work")).body.entries ?? []).some(
                (e: { term: string }) => e.term === "Hetzner Cloud",
              ),
            5000,
            "the workspace entry",
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

describe("the first-run download card (DESIGN 3)", () => {
  test(
    "a pull or a progress poll whose request fails is a toast or a skipped tick, never an unhandled rejection",
    async () => {
      // One model file that is not on disk, so the card offers the download.
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
        await page.waitForSelector("#models-card:not([hidden]) #models-pull:not([hidden])");

        // The request itself fails (the app quit, the network dropped): the button says so.
        await page.route("**/api/v1/models/pull", (r) => r.abort());
        await page.click("#models-pull");
        await page.waitForSelector("#toast:not([hidden])");
        expect(await text(page, "#toast")).toContain("could not start");

        // A download in progress whose polls fail: each failed tick is skipped, none throws.
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
        await until(async () => polls >= 2, 10_000, "two failed polls");
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
