/**
 * The window against hark-viewer, one test per row of the parity table in docs/DESIGN.md section 7,
 * on the real page in a headless browser over the real headless app (fake capture helper, fake
 * recognizer). Seeded calls are generated logs; live calls run the fake helper.
 */

import { describe, expect, test } from "bun:test";
import { formatWall } from "../../src/core/log/clock.ts";
import type { LogEvent } from "../../src/core/log/events.ts";
import { HUES, YOU_HUE } from "../../src/ui/model.ts";
import { speechWav } from "../api-helpers.ts";
import { tempDir } from "../helpers.ts";
import {
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

const text = (page: import("playwright-core").Page, sel: string) =>
  page.locator(sel).first().textContent();

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

async function events(rig: UiRig, id: string): Promise<LogEvent[]> {
  return (await rig.api("GET", `/calls/${id}/events`)).body.events;
}

describe("DESIGN 7 parity with hark-viewer", () => {
  test(
    "Header: status dot, state label, title, meta, controls, plus local clock, workspace, template, provider and share pills",
    async () => {
      let id = "";
      await withRig(
        {
          seed: (home) => {
            id = seedCall(home, (b) => {
              standardCall(b);
              (b.events[0] as { template?: string }).template = "standup";
            }).id;
          },
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          expect(await page.locator("#dot").count()).toBe(1);
          expect(await text(page, "#state")).toBe("saved");
          expect(await text(page, "#title")).toBe("work · Weekly sync");
          expect(await text(page, "#meta")).toBe("4 lines");
          expect(await text(page, "#pill-clock")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
          expect(await page.locator("#pill-clock").getAttribute("title")).toContain(
            "Times are local",
          );
          expect(await text(page, "#pill-ws")).toBe("workspace: work");
          expect(await text(page, "#pill-template")).toBe("template: standup");
          expect(await text(page, "#pill-provider")).toBe("provider: none (unavailable)");
          for (const c of ["#record", "#restart", "#settings-open", "#share-start"]) {
            expect(await page.locator(c).isVisible()).toBe(true);
          }
          // The share pill appears, red, once the call is shared.
          expect(await page.locator("#pill-share").isVisible()).toBe(false);
          expect((await rig.api("POST", "/share", { call: id })).status).toBe(201);
          await page.waitForSelector("#pill-share:not([hidden])");
          expect(await text(page, "#share-text")).toBe("Shared live · 0 viewers");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "States: ready, recording, paused, saved, ended unexpectedly, interrupted, failed, not capturing, another call recording",
    async () => {
      const ids: Record<string, string> = {};
      await withRig(
        {
          helperArgs: ["--stall-at", "0.3"],
          settings: { "capture.stallSeconds": 120 },
          seed: (home) => {
            ids.saved = seedCall(home, (b) => standardCall(b, "01J8Z6Q4M2VX0K7B3D4E5SAVED")).id;
            ids.crashed = seedCall(home, (b) => {
              b.created({ id: "01J8Z6Q4M2VX0K7B3D4ECRASHD", title: "Crashed" });
              b.partStarted(1, T0);
              b.partEnded(1, "crashed", 5);
            }).id;
            ids.interrupted = seedCall(home, (b) => {
              b.created({ id: "01J8Z6Q4M2VX0K7B3D4EINTRPT", title: "Interrupted" });
              b.partStarted(1, T0);
              b.partEnded(1, "helper-exit", 5);
              b.add({ type: "call.ended", reason: "interrupted" });
            }).id;
            ids.failed = seedCall(home, (b) => {
              b.created({ id: "01J8Z6Q4M2VX0K7B3D4EFAILED", title: "Failed" });
              b.add({ type: "call.failed", stage: "open", error: "permission denied" });
            }).id;
          },
        },
        async (rig) => {
          const page = await rig.open(ids.saved);
          const state = () => text(page, "#state");
          await until(async () => (await state()) === "saved", 5000, "saved");
          for (const [k, label] of [
            ["crashed", "ended unexpectedly"],
            ["interrupted", "interrupted"],
            ["failed", "recording failed"],
          ] as const) {
            await page.click(`#calls li[data-id="${ids[k]}"] button`);
            await until(async () => (await state()) === label, 5000, label);
            // Restart stays visible when a call failed, crashed or was interrupted.
            expect(await page.locator("#restart").isVisible()).toBe(true);
          }
          expect(await text(page, "#meta")).toContain("open: permission denied");
          // A live call elsewhere: the call on screen says so, and Stop names the other call.
          const live = await rig.startCall({ title: "Live one" });
          await until(async () => (await state()) === "another call is recording", 5000, "other");
          expect(await text(page, "#stop")).toBe("■ Stop the other call");
          // Open the live call: recording, then not capturing once no audio arrives for 5 s.
          await page.click(`#calls li[data-id="${live}"] button`);
          await until(async () => (await state()) === "rec", 5000, "rec");
          await until(async () => (await state()) === "not capturing", 12_000, "not capturing");
          await page.click("#pause");
          await until(async () => (await state()) === "paused", 5000, "paused");
          await page.click("#stop");
          await until(async () => (await state()) === "saved", 8000, "saved after stop");
        },
      );
      // Ready: a fresh app with no call at all.
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await until(async () => (await text(page, "#state")) === "ready", 5000, "ready");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Banners: red dead, amber guess, grey quiet, green recovered, check permission, amber transcript behind",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall();
        const page = await rig.open(id);
        await page.clock.install();
        const banner = page.locator("#banner");
        const kind = () => banner.getAttribute("class");
        const health = (state: string, extra: Record<string, unknown> = {}) =>
          rig.write(id, {
            type: "health",
            part: 1,
            ch: "call",
            state,
            silentFor: 12,
            rebuilds: 1,
            detail: "test",
            ...extra,
          } as never);
        await health("dead");
        await until(async () => (await kind()) === "dead", 5000, "red banner");
        expect(await text(page, "#banner-text")).toContain("CALL AUDIO LOST");
        expect(await text(page, "#banner-action")).toBe("↻ Restart");
        await health("ok", { rebuilds: 2 });
        await until(async () => (await kind()) === "recovered", 5000, "green banner");
        expect(await text(page, "#banner-text")).toBe("call audio is back after 2 rebuilds");
        await health("permission-suspect");
        await until(async () => (await kind()) === "permission", 5000, "permission banner");
        expect(await text(page, "#banner-action")).toBe("Open System Settings");
        await page.click("#banner-action");
        if (process.platform === "darwin") {
          await until(() => rig.opened.length === 1, 3000, "the settings pane");
          expect(rig.opened[0]).toContain("Privacy_AudioCapture");
        } else {
          await page.waitForSelector("#toast:not([hidden])");
        }
        await health("ok", { rebuilds: 0 });
        await rig.write(id, { type: "asr.lag", part: 1, seconds: 42 } as never);
        await until(async () => (await kind()) === "lag", 5000, "lag banner");
        expect(await text(page, "#banner-text")).toContain("transcript 42 s behind");
        await rig.write(id, { type: "asr.lag", part: 1, seconds: 0 } as never);
        // No new line for 100 s: an amber guess, never red.
        await page.clock.fastForward(100_000);
        await until(async () => (await kind()) === "guess", 5000, "amber guess");
        expect(await text(page, "#banner-text")).toContain("no new lines for");
        // A line arrives, but the call side stays silent: grey.
        await rig.write(id, seg("l990001", "someone on the mic", { ch: "mic" }));
        await until(async () => (await kind()) === "quiet", 5000, "grey quiet");
        expect(await text(page, "#banner-text")).toContain("call side quiet for");
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "Record, Mute, Pause, Stop, Restart; toasts",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig(
        { helperArgs: ["--wav", speechWav(t.dir)], settings: { "share.bind": "203.0.113.5" } },
        async (rig) => {
          const page = await rig.open();
          const state = () => text(page, "#state");
          await page.click("#record");
          await until(async () => (await state()) === "rec", 8000, "recording");
          const id = (await rig.api("GET", "/status")).body.live.call as string;
          await page.click("#mute");
          await until(async () => (await text(page, "#mute")) === "Unmute mic", 5000, "muted");
          expect((await events(rig, id)).some((e) => e.type === "mute")).toBe(true);
          await page.click("#mute");
          await until(async () => (await text(page, "#mute")) === "Mute mic", 5000, "unmuted");
          await page.click("#pause");
          await until(async () => (await text(page, "#pause")) === "Resume", 5000, "paused");
          await page.click("#pause");
          await until(async () => (await state()) === "rec", 5000, "resumed");
          await page.click("#stop");
          await until(async () => (await state()) === "saved", 8000, "stopped");
          // Restart stays visible once the call ended, and carries on in the same call.
          await page.waitForSelector("#restart", { state: "visible" });
          await page.click("#restart");
          await until(async () => (await state()) === "rec", 8000, "restarted");
          expect((await events(rig, id)).filter((e) => e.type === "part.started")).toHaveLength(2);
          await page.click("#stop");
          await until(async () => (await state()) === "saved", 8000, "stopped again");
          // A refusal is a toast, never silence.
          await page.click("#share-start");
          await page.waitForSelector("#toast:not([hidden])");
          expect(await text(page, "#toast")).toContain("cannot listen on 203.0.113.5");
        },
      );
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "Workspace picker, title field, template picker",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await page.waitForSelector("#template option[value=standup]", { state: "attached" });
        await page.fill("#workspace", "acme");
        await page.fill("#newtitle", "Kickoff");
        await page.selectOption("#template", "standup");
        await page.click("#record");
        await until(async () => (await text(page, "#state")) === "rec", 8000, "recording");
        const live = (await rig.api("GET", "/status")).body.live.call as string;
        const created = (await events(rig, live))[0] as LogEvent & {
          workspace: string;
          title: string;
          template?: string;
        };
        expect([created.workspace, created.title, created.template]).toEqual([
          "acme",
          "Kickoff",
          "standup",
        ]);
        expect(await text(page, "#title")).toBe("acme · Kickoff");
        await page.click("#stop");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Layout: the transcript keeps its room when the font grows; the side columns do not grow with it",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          // The desktop shell's own frame.
          await page.setViewportSize({ width: 1280, height: 820 });
          await page.waitForSelector("#lines .row >> nth=3");
          const widths = () =>
            page.evaluate(() => {
              const w = (x: string) =>
                Math.round(
                  (document.getElementById(x) as HTMLElement).getBoundingClientRect().width,
                );
              return { sidebar: w("sidebar"), scroller: w("scroller"), side: w("side") };
            });
          const at22 = await widths();
          await page.locator("#scroller").focus();
          for (let i = 0; i < 20; i++) await page.keyboard.press("+");
          const at44 = await widths();
          expect(at44.sidebar).toBe(at22.sidebar);
          expect(at44.side).toBe(at22.side);
          // At the largest size the transcript still has at least half the window.
          expect(at44.scroller).toBeGreaterThanOrEqual(640);
          // A narrower window still gives it half.
          await page.setViewportSize({ width: 900, height: 700 });
          expect((await widths()).scroller).toBeGreaterThanOrEqual(450);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Rows: wall-clock time column, speaker on change, last 3 bright, rise, pinned scroll, Back to live after 80 px, font 14 to 44 px",
    async () => {
      let id = "";
      await withRig(
        {
          seed: (home) => {
            id = seedCall(home, (b) => {
              b.created();
              b.partStarted(1, T0);
              for (let i = 1; i <= 60; i++) {
                b.seg({
                  id: `l${String(i).padStart(6, "0")}`,
                  ch: "call",
                  spk: i % 3 === 0 ? "c2" : "c1",
                  w0: T0 + i * 4000,
                  text: `line number ${i} of the call`,
                });
              }
            }).id;
          },
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=59");
          const rows = page.locator("#lines .row");
          // The time column is local wall clock, the offset only in a labelled tooltip.
          expect(await rows.nth(0).locator("time").textContent()).toBe(formatWall(T0 + 4000, TZ));
          expect(await rows.nth(0).locator("time").getAttribute("title")).toBe("4 s into the call");
          // The chip shows on a change of speaker only: rows 1 and 2 are both Speaker 1.
          expect(await rows.nth(0).getAttribute("class")).toContain("turn");
          expect(await rows.nth(1).getAttribute("class")).not.toContain("turn");
          expect(await rows.nth(2).getAttribute("class")).toContain("turn");
          expect(await rows.nth(1).locator(".who").isVisible()).toBe(false);
          // The last three rows are bright, the ones before dim.
          const color = (i: number) => rows.nth(i).evaluate((el) => getComputedStyle(el).color);
          const bright = await page.evaluate(() => getComputedStyle(document.body).color);
          await until(async () => (await color(59)) === bright, 3000, "bright last row");
          expect(await color(57)).toBe(bright);
          expect(await color(56)).not.toBe(bright);
          // Pinned to the bottom, then "Back to live" once scrolled up more than 80 px.
          const gap = () =>
            page.evaluate(() => {
              const s = document.getElementById("scroller") as HTMLElement;
              return s.scrollHeight - s.scrollTop - s.clientHeight;
            });
          await until(async () => (await gap()) < 2, 3000, "pinned at the bottom");
          await page.evaluate(() => {
            const s = document.getElementById("scroller") as HTMLElement;
            s.style.scrollBehavior = "auto";
            s.scrollTop -= 40;
          });
          await Bun.sleep(100);
          expect(await page.locator("#jump").isVisible()).toBe(false);
          await page.evaluate(() => {
            (document.getElementById("scroller") as HTMLElement).scrollTop -= 200;
          });
          await page.waitForSelector("#jump", { state: "visible" });
          await page.click("#jump");
          await until(async () => (await gap()) < 2, 3000, "back at the bottom");
          await page.waitForSelector("#jump", { state: "hidden" });
          // A new line rises in and, pinned, stays in view.
          await rig.write(id, seg("l000061", "a brand new line", { w0: T0 + 61 * 4000 }));
          const fresh = page.locator('#lines .row[data-id="l000061"]');
          await fresh.waitFor();
          expect(await fresh.getAttribute("class")).toContain("new");
          await until(async () => (await gap()) < 2, 3000, "still pinned");
          // Font size: + and - between 14 and 44 px.
          const size = () =>
            page.evaluate(() =>
              getComputedStyle(document.documentElement).getPropertyValue("--size"),
            );
          await page.locator("#scroller").focus();
          for (let i = 0; i < 20; i++) await page.keyboard.press("+");
          expect(await size()).toBe("44px");
          for (let i = 0; i < 20; i++) await page.keyboard.press("-");
          expect(await size()).toBe("14px");
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Speaker chips: click to rename, merge and unmerge, rewriting rows in place",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          const log = requestLog(page);
          const who = (lid: string) =>
            page.locator(`#lines .row[data-id="${lid}"] .who`).textContent();
          await page.click('#lines .row[data-id="l000002"] .who');
          await page.waitForSelector("#popover:not([hidden])");
          await page.fill("#popover input", "Ben");
          await page.click("#popover button[type=submit]");
          await until(async () => (await who("l000002")) === "Ben", 5000, "renamed");
          expect(await who("l000004")).toBe("Ben");
          const named = (await events(rig, id)).find(
            (e) => e.type === "speaker.name",
          ) as LogEvent & {
            by: string;
            name: string;
          };
          expect([named.name, named.by]).toEqual(["Ben", "user"]);
          // Merge Speaker 2 into Ben: its rows take Ben's name and hue.
          await page.click('#lines .row[data-id="l000003"] .who');
          await page.waitForSelector("#popover:not([hidden])");
          await page.selectOption("#popover select", "c1");
          await page.click("#popover >> text=Merge into");
          await until(async () => (await who("l000003")) === "Ben", 5000, "merged");
          const hue = (lid: string) =>
            page.locator(`#lines .row[data-id="${lid}"]`).getAttribute("data-h");
          expect(await hue("l000003")).toBe(await hue("l000002"));
          // A merged chip offers the way back.
          await page.click('#lines .row[data-id="l000002"] .who');
          await page.click("#popover >> text=Split off Speaker 2 (c2)");
          await until(async () => (await who("l000003")) === "Speaker 2", 5000, "unmerged");
          // No transcript was read again for any of it.
          expect(log.paths().filter((p) => /transcript|events$/.test(p))).toEqual([]);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Stable speaker hues: you = 214, others in order of first appearance; a renamed speaker keeps its hue",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          const hue = (lid: string) =>
            page.locator(`#lines .row[data-id="${lid}"]`).getAttribute("data-h");
          expect(await hue("l000001")).toBe(String(YOU_HUE));
          expect(await hue("l000002")).toBe(String(HUES[0]));
          expect(await hue("l000003")).toBe(String(HUES[1]));
          await rig.api("POST", `/calls/${id}/speakers`, { spk: "c1", name: "Ben" });
          await until(
            async () =>
              (await page.locator('#lines .row[data-id="l000002"] .who').textContent()) === "Ben",
            5000,
            "renamed",
          );
          expect(await hue("l000002")).toBe(String(HUES[0]));
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Grey provisional row, dashed border, gone 3 s after its last update",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir)] }, async (rig) => {
        const id = await rig.startCall();
        const page = await rig.open(id);
        await until(async () => (await text(page, "#state")) === "rec", 5000, "recording");
        const view = rig.app.manager.controller(id)?.view;
        view?.provisional.update({
          ch: "call",
          part: 1,
          pseq: 1,
          text: "still being said",
          w0: Date.now(),
          at: Date.now(),
          spk: "c1",
        });
        const draft = page.locator("#partial .row.draft");
        await draft.waitFor();
        expect(await draft.locator(".text").textContent()).toBe("still being said");
        expect(
          await draft.locator(".body").evaluate((el) => getComputedStyle(el).borderLeftStyle),
        ).toBe("dashed");
        // Never a row of the transcript.
        expect(await page.locator("#lines .row").count()).toBe(0);
        await page.waitForSelector("#partial", { state: "hidden", timeout: 6000 });
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "Dark and light from prefers-color-scheme, 22 px base",
    async () => {
      await withRig({}, async (rig) => {
        const page = await rig.open();
        const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        await page.emulateMedia({ colorScheme: "dark" });
        expect(await bg()).toBe("rgb(13, 14, 16)");
        await page.emulateMedia({ colorScheme: "light" });
        expect(await bg()).toBe("rgb(251, 251, 250)");
        expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("22px");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Sidebar list of calls by date and title; one open at a time; switch without reload; no search",
    async () => {
      const ids: string[] = [];
      await withRig(
        {
          seed: (home) => {
            ids.push(seedCall(home, (b) => standardCall(b, "01J8Z6Q4M2VX0K7B3D4E5FIRST")).id);
            ids.push(
              seedCall(home, (b) => {
                b.created({ id: "01J8Z6Q4M2VX0K7B3D4ESECOND", title: "Second call" });
                b.partStarted(1, T0 + 3_600_000);
                b.seg({ id: "l000001", ch: "call", w0: T0 + 3_601_000, text: "only line here" });
                b.partEnded(1, "stop");
                b.add({ type: "call.ended", reason: "stop" });
              }).id,
            );
          },
        },
        async (rig) => {
          const page = await rig.open(ids[0]);
          await page.waitForSelector("#lines .row >> nth=3");
          const items = page.locator("#calls li");
          expect(await items.count()).toBe(2);
          expect(await items.allTextContents()).toEqual([
            expect.stringContaining("Second call"),
            expect.stringContaining("Weekly sync"),
          ]);
          expect(await items.first().locator(".when").textContent()).toMatch(
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
          );
          await page.evaluate(() => {
            (window as unknown as { marker: number }).marker = 42;
          });
          await page.click(`#calls li[data-id="${ids[1]}"] button`);
          await until(
            async () => (await page.locator("#lines .row").count()) === 1,
            5000,
            "switched",
          );
          expect(await text(page, "#title")).toBe("work · Second call");
          expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(
            42,
          );
          expect(new URL(page.url()).searchParams.get("call")).toBe(ids[1] as string);
          expect(
            await page
              .locator(`#calls li[data-id="${ids[1]}"] button`)
              .getAttribute("aria-current"),
          ).toBe("true");
          expect(
            await page
              .locator(`#calls li[data-id="${ids[0]}"] button`)
              .getAttribute("aria-current"),
          ).toBe("false");
          expect(await page.locator("#sidebar input").count()).toBe(0);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Final transcript note: running with a progress bar, failed, done with skipped spans and the warning",
    async () => {
      const ended = (b: import("../helpers.ts").LogBuilder, id: string) => {
        b.created({ id });
        b.partStarted(1, T0);
        b.seg({ id: "l000001", w0: T0 + 1000, text: "a line" });
        b.partEnded(1, "stop");
        b.add({ type: "call.ended", reason: "stop" });
      };
      const ids = {
        run: "01J8Z6Q4M2VX0K7B3D4E5FRUNN",
        fail: "01J8Z6Q4M2VX0K7B3D4E5FFAIL",
        done: "01J8Z6Q4M2VX0K7B3D4E5FDONE",
      };
      await withRig(
        {
          seed: (home) => {
            seedCall(home, (b) => {
              ended(b, ids.run);
              b.add({ type: "final.started", pid: 1 });
            });
            seedCall(home, (b) => {
              ended(b, ids.fail);
              b.add({ type: "final.started", pid: 1 });
              b.add({ type: "final.failed", step: "diarize", error: "the model is missing" });
            });
            seedCall(home, (b) => {
              ended(b, ids.done);
              b.add({ type: "final.started", pid: 1 });
              b.add({ type: "final.part.done", part: 1 });
              b.add({
                type: "final.done",
                parts: [1],
                skipped: [{ from: 1, to: 2 }],
                warning: "the call side had energy but no text",
              });
            });
          },
        },
        async (rig) => {
          const page = await rig.open(ids.run);
          await page.waitForSelector("#final:not([hidden])");
          expect(await text(page, "#final-text")).toBe("final transcript: running (0 of 1 part)");
          expect(await page.locator("#final-progress").isVisible()).toBe(true);
          await page.click(`#calls li[data-id="${ids.fail}"] button`);
          await until(
            async () =>
              (await text(page, "#final-text")) ===
              "final transcript: failed (the model is missing)",
            5000,
            "failed note",
          );
          expect(await page.locator("#final-progress").isVisible()).toBe(false);
          await page.click(`#calls li[data-id="${ids.done}"] button`);
          await until(
            async () =>
              (await text(page, "#final-text")) ===
              "final transcript: ready (1 span skipped)  ·  the call side had energy but no text",
            5000,
            "done note",
          );
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Languages chip after the final pass, only when a model reported the language",
    async () => {
      const ids = { en: "01J8Z6Q4M2VX0K7B3D4E5LANGS", none: "01J8Z6Q4M2VX0K7B3D4E5NOLNG" };
      await withRig(
        {
          seed: (home) => {
            for (const [id, languages] of [
              [ids.en, ["en", "es"]],
              [ids.none, undefined],
            ] as const) {
              seedCall(home, (b) => {
                b.created({ id });
                b.partStarted(1, T0);
                b.partEnded(1, "stop");
                b.add({ type: "call.ended", reason: "stop" });
                b.add({
                  type: "final.done",
                  parts: [1],
                  skipped: [],
                  ...(languages ? { languages: [...languages] } : {}),
                });
              });
            }
          },
        },
        async (rig) => {
          const page = await rig.open(ids.en);
          await page.waitForSelector("#pill-lang:not([hidden])");
          expect(await text(page, "#pill-lang")).toBe("languages: en, es");
          await page.click(`#calls li[data-id="${ids.none}"] button`);
          await page.waitForSelector("#pill-lang", { state: "hidden" });
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Empty state: the same text as hark-viewer",
    async () => {
      const t = tempDir("akou-wav-");
      let empty = "";
      await withRig(
        {
          helperArgs: ["--wav", silentWav(t.dir)],
          seed: (home) => {
            empty = seedCall(home, (b) => {
              b.created({ id: "01J8Z6Q4M2VX0K7B3D4E5EMPTY" });
              b.partStarted(1, T0);
              b.partEnded(1, "stop");
              b.add({ type: "call.ended", reason: "stop" });
            }).id;
          },
        },
        async (rig) => {
          const page = await rig.open(empty);
          await until(
            async () => (await text(page, "#empty")) === "No transcript lines in this call.",
            5000,
            "empty call text",
          );
          const live = await rig.startCall();
          await page.click(`#calls li[data-id="${live}"] button`);
          await until(
            async () =>
              (await text(page, "#empty")) ===
              "Listening. A line appears each time someone pauses.",
            5000,
            "listening text",
          );
          await rig.api("POST", "/calls/live/stop");
        },
      );
      await withRig({}, async (rig) => {
        const page = await rig.open();
        await until(
          async () => (await text(page, "#empty")) === "Press Record to start a call.",
          5000,
          "no call text",
        );
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "Relabel command replaced by click-to-rename: a name is one event by the user, no relabel pass",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          const before = (await events(rig, id)).length;
          const log = requestLog(page);
          await page.click('#lines .row[data-id="l000003"] .who');
          await page.fill("#popover input", "Carol");
          await page.keyboard.press("Enter");
          await until(
            async () =>
              (await page.locator('#lines .row[data-id="l000003"] .who').textContent()) === "Carol",
            5000,
            "renamed",
          );
          const after = await events(rig, id);
          expect(after.length).toBe(before + 1);
          expect(after.at(-1)).toMatchObject({
            type: "speaker.name",
            spk: "c2",
            name: "Carol",
            by: "user",
          });
          // The only request was the rename itself.
          expect(log.all.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([
            `POST /api/v1/calls/${id}/speakers`,
          ]);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Third-party comparison lane dropped: one transcript, one source, nothing else read",
    async () => {
      let id = "";
      await withRig(
        { seed: (home) => (id = seedCall(home, (b) => standardCall(b)).id) },
        async (rig) => {
          let log: ReturnType<typeof requestLog> | null = null;
          const page = await rig.open(id, { before: (p) => (log = requestLog(p)) });
          await page.waitForSelector("#lines .row >> nth=3");
          await Bun.sleep(500);
          expect(await page.locator('[role="log"]').count()).toBe(1);
          expect(await page.locator("text=/comparison|lane/i").count()).toBe(0);
          // Every request goes to this page's own origin: the page, the session, the one stream of
          // the call, the status stream and the small reads of the header.
          const paths = (log as unknown as ReturnType<typeof requestLog>).paths();
          expect(paths.filter((x) => x.endsWith("/stream") && x.startsWith("/api/"))).toEqual([
            `/api/v1/calls/${id}/stream`,
          ]);
          expect(paths.filter((x) => /transcript|\/events$/.test(x))).toEqual([]);
        },
      );
    },
    UI_TIMEOUT,
  );
});
