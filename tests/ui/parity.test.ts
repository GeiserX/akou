/**
 * The window against hark-viewer, one test per row of the parity table in docs/DESIGN.md section 7,
 * on the real page in a headless browser over the real headless app (fake capture helper, fake
 * recognizer). Seeded calls are generated logs; live calls run the fake helper.
 */

import { test as bunTest, describe, expect } from "bun:test";
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

/** The parity row whose test is running, its place, and how many rigs it opened (TS-15c). */
let row = { name: "", n: 0, rigs: 0 };

/** `test`, remembering the row for the screenshots of every screen it reaches (TS-15c). */
function test(name: string, fn: () => Promise<unknown>, timeout?: number): void {
  bunTest(
    name,
    async () => {
      row = { name, n: row.n + 1, rigs: 0 };
      await fn();
    },
    timeout,
  );
}

async function withRig<T>(
  o: Parameters<typeof uiRig>[0] & { seed?: (home: string) => void },
  fn: (rig: UiRig) => Promise<T>,
): Promise<T> {
  const t = tempDir("akou-ui-");
  o.seed?.(t.dir);
  const rig = await uiRig({ ...o, home: t.dir });
  // `parity-<nn>-<the row's first words>`, with `-b` for a row's second rig.
  row.rigs++;
  const words = row.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  rig.shots = `parity-${String(row.n).padStart(2, "0")}-${words.replace(/^-|-$/g, "")}${row.rigs > 1 ? `-${String.fromCharCode(96 + row.rigs)}` : ""}`;
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
    "Header: status dot, state label, title, meta, controls, as the composer row and the call header; provider and engine under Settings",
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
          // The composer row: the workspace chip inside the title field, the live model, the Mic
          // and Call meters with their health dots, and Record, all on screen at once. No template
          // picker here or on the Enhanced tab: notes pick their template automatically.
          expect(await page.locator("#template, #enhance-template").count()).toBe(0);
          for (const c of [
            "#composer .title-field #workspace",
            "#composer .title-field #newtitle",
            "#composer #live",
            "#composer #meter-mic",
            "#composer #meter-call",
            "#composer #health-mic",
            "#composer #health-call",
            "#composer #record",
          ]) {
            expect(await page.locator(c).isVisible()).toBe(true);
          }
          expect(await text(page, '#meters label[for="meter-mic"]')).toBe("Mic");
          expect(await text(page, '#meters label[for="meter-call"]')).toBe("Call");
          // Record is the round red disc with its word, never an accent-filled pill.
          expect(await text(page, "#record")).toBe("Record");
          const look = await page.evaluate(() => {
            const r = document.getElementById("record") as HTMLElement;
            const disc = r.querySelector(".disc i") as HTMLElement;
            const box = r.querySelector(".disc") as HTMLElement;
            const probe = document.createElement("i");
            probe.style.color = "var(--rec)";
            document.body.append(probe);
            const rec = getComputedStyle(probe).color;
            probe.remove();
            return {
              go: r.classList.contains("go"),
              fill: getComputedStyle(r).backgroundColor,
              disc: getComputedStyle(disc).backgroundColor,
              rec,
              round: getComputedStyle(box).borderRadius,
              size: Math.round(box.getBoundingClientRect().width),
            };
          });
          expect(look.go).toBe(false);
          expect(look.fill).toBe("rgba(0, 0, 0, 0)");
          expect(look.disc).toBe(look.rec);
          expect(look.round).toBe("50%");
          expect(look.size).toBe(34);
          // No debug chips: no clock, workspace, template, provider or speech pill anywhere.
          expect(
            await page
              .locator("#pill-clock, #pill-ws, #pill-template, #pill-provider, #pill-models")
              .count(),
          ).toBe(0);
          expect(await page.locator("#composer .pill, #composer #title").count()).toBe(0);
          // The call header over the transcript: the title, then day and start, length,
          // workspace, template and what the state adds; the speakers with their talk time.
          expect(await text(page, "#call-head #title")).toBe("Weekly sync");
          expect(await text(page, "#call-head #meta")).toMatch(
            /^[^·]+, 15:36 · 12 s · work · Template: standup · 4 lines$/,
          );
          expect(await page.locator("#meta").getAttribute("title")).toContain("Times are local");
          expect(await page.locator("#people li").count()).toBe(3);
          // A voice nobody named, before the final pass, is a guess: its chip reads like its lines.
          expect(await text(page, "#people li >> nth=0")).toMatch(/^c1\?\d+ s$/);
          for (const c of ["#record", "#restart", "#settings-open", "#share-start"]) {
            expect(await page.locator(c).isVisible()).toBe(true);
          }
          // The share pill appears, red, once the call is shared.
          expect(await page.locator("#pill-share").isVisible()).toBe(false);
          expect((await rig.api("POST", "/share", { call: id })).status).toBe(201);
          await page.waitForSelector("#pill-share:not([hidden])");
          expect(await text(page, "#share-text")).toBe("Shared live · 0 viewers");
          // What the provider and speech pills said is in Settings, read only, with the version.
          await page.click("#settings-open");
          await page.waitForSelector("#settings-provider-state");
          expect(await text(page, "#settings-provider-state")).toBe(
            "Ask shows the matching parts of the call instead.",
          );
          expect(await text(page, "#settings-engine-state")).toBe("The speech engine is ready.");
          const version = (await rig.api("GET", "/status")).body.app.version as string;
          expect(await text(page, "#settings-version")).toBe(`akou ${version}`);
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
            // Interrupted a minute ago: an interrupted call left for 24 h is closed as abandoned
            // at start (recovery.ts), so a fixed date here stops testing this state a day later.
            const recent = Date.now() - 60_000;
            ids.interrupted = seedCall(home, (b) => {
              b.created({ id: "01J8Z6Q4M2VX0K7B3D4EINTRPT", title: "Interrupted" }, recent);
              b.partStarted(1, recent);
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
          // A new live call takes the window over (W3.17).
          const live = await rig.startCall({ title: "Live one" });
          await page.waitForSelector(`#calls li[data-id="${live}"] button[aria-current="true"]`);
          // Another call picked while it records: the call on screen says so, and Stop names
          // the other call.
          await page.click(`#calls li[data-id="${ids.failed}"] button`);
          await until(async () => (await state()) === "another call is recording", 5000, "other");
          expect(await text(page, "#stop")).toBe("Stop the other call");
          // Back to the live call: recording, then not capturing once no audio arrives for 5 s.
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
          // While it records, Record's spot holds the elapsed time and the round Stop; Mute and
          // Pause are quiet icon buttons whose label is their name and their tooltip.
          expect(await page.locator("#record").isVisible()).toBe(false);
          expect(await page.locator("#elapsed").isVisible()).toBe(true);
          expect(await text(page, "#elapsed")).toMatch(/^\d+ (s|min)/);
          expect(await page.locator("#stop .disc").isVisible()).toBe(true);
          expect(await page.locator("#newtitle").isVisible()).toBe(false);
          await page.click("#mute");
          await until(async () => (await text(page, "#mute")) === "Unmute mic", 5000, "muted");
          expect(await page.getAttribute("#mute", "aria-pressed")).toBe("true");
          expect(await page.getAttribute("#mute", "title")).toBe("Unmute mic");
          expect((await events(rig, id)).some((e) => e.type === "mute")).toBe(true);
          await page.click("#mute");
          await until(async () => (await text(page, "#mute")) === "Mute mic", 5000, "unmuted");
          await page.click("#pause");
          await until(async () => (await text(page, "#pause")) === "Resume", 5000, "paused");
          expect(await page.getAttribute("#pause", "title")).toBe("Resume");
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
    "Workspace menu and title field; the template is the automatic choice, and a script's shows in the header",
    async () => {
      await withRig({}, async (rig) => {
        await rig.api("POST", "/workspaces", { name: "acme" });
        const page = await rig.open();
        await page.waitForFunction(() => document.getElementById("state")?.textContent !== "…");
        await page.click("#workspace");
        await page.click('#workspace-menu [data-ws="acme"]');
        await page.fill("#newtitle", "Kickoff");
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
          undefined,
        ]);
        expect(await text(page, "#title")).toBe("Kickoff");
        expect(await text(page, "#meta")).toContain(" · acme");
        expect(await text(page, "#meta")).not.toContain("Template");
        await page.click("#stop");
        await until(async () => (await text(page, "#state")) === "saved", 8000, "stopped");
        // A template a script names still reaches the call, and its header says so.
        const scripted = await rig.startCall({ workspace: "acme", template: "standup" });
        await until(
          async () => ((await text(page, "#meta")) ?? "").includes("Template: standup"),
          8000,
          "scripted",
        );
        await rig.api("POST", `/calls/${scripted}/stop`);
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
    "[W4.1] The live transcript sits at the bottom: the space above a few lines, the newest and the grey line at the bottom edge, pinned as lines arrive, left alone once scrolled up",
    async () => {
      const t = tempDir("akou-wav-");
      await withRig({ helperArgs: ["--wav", silentWav(t.dir, 120)] }, async (rig) => {
        const id = await rig.startCall();
        const line = (i: number) =>
          rig.write(
            id,
            seg(`l7${String(i).padStart(5, "0")}`, `line ${i} of the call`, { w0: Date.now() + i }),
          );
        for (let i = 1; i <= 3; i++) await line(i);
        const page = await rig.open(id, {
          before: (p) => p.setViewportSize({ width: 1024, height: 700 }),
        });
        await page.waitForSelector("#lines .row >> nth=2");
        // Where the rows are in the transcript's area: the space under the last one (a line, or the
        // grey one being spoken) and over the first.
        const place = () =>
          page.evaluate(() => {
            const s = (document.getElementById("scroller") as HTMLElement).getBoundingClientRect();
            const rows = [...document.querySelectorAll("#lines .row, #partial:not([hidden]) .row")];
            const first = (rows[0] as HTMLElement).getBoundingClientRect();
            const last = rows.at(-1) as HTMLElement;
            return {
              below: s.bottom - last.getBoundingClientRect().bottom,
              above: first.top - s.top,
              last: last.dataset.id ?? "",
            };
          });
        // On screen and within a row's padding and the area's own of the bottom edge.
        // Read once the view stopped moving: a smooth scroll carries the last row past the edge.
        const atEdge = async () => {
          const b = (await place()).below;
          await Bun.sleep(250);
          return b === (await place()).below && b >= -1 && b <= 24;
        };
        await until(atEdge, 3000, "three lines at the bottom");
        expect((await place()).above).toBeGreaterThan(200);
        // The grey line still being spoken is the last row, at the bottom edge.
        rig.app.manager.controller(id)?.view?.provisional.update({
          ch: "call",
          part: 1,
          pseq: 1,
          text: "still being said",
          w0: Date.now(),
          at: Date.now(),
          spk: "c1",
        });
        await page.waitForSelector("#partial .row.draft");
        await until(async () => (await place()).last === "draft-call", 3000, "grey line last");
        expect(await atEdge()).toBe(true);
        // Enough lines to scroll: each one arriving is the last row, at the bottom edge.
        for (let i = 4; i <= 40; i++) await line(i);
        await page.waitForSelector('#lines .row[data-id="l700040"]');
        await page.waitForSelector("#partial", { state: "hidden", timeout: 6000 });
        await until(atEdge, 3000, "pinned at line 40");
        expect((await place()).last).toBe("l700040");
        // Long lines close together, each taller than the 80 px that counts as scrolled up: the
        // view follows them and never reads as scrolled (a smooth scroll's first steps did).
        await page.evaluate(() => {
          const w = window as unknown as { unpinned: number };
          w.unpinned = 0;
          let was = document.body.classList.contains("scrolled");
          new MutationObserver(() => {
            const now = document.body.classList.contains("scrolled");
            if (now && !was) w.unpinned++;
            was = now;
          }).observe(document.body, { attributeFilter: ["class"] });
        });
        const long = "a long sentence that keeps going and going ".repeat(12);
        for (const i of [101, 102, 103]) {
          await rig.write(id, seg(`l7${i}`, long, { w0: Date.now() + i }));
          await Bun.sleep(150);
        }
        await page.waitForSelector('#lines .row[data-id="l7103"]');
        await until(atEdge, 3000, "pinned after the long lines");
        expect((await place()).last).toBe("l7103");
        expect(
          await page.evaluate(() => (window as unknown as { unpinned: number }).unpinned),
        ).toBe(0);
        // A shorter window keeps the newest line at the bottom edge.
        await page.setViewportSize({ width: 1024, height: 560 });
        await until(atEdge, 3000, "pinned, shorter window");
        // A narrower window, two sizes in a row and the font up twice with no wait keep it there
        // too; none of these reads as the reader scrolling up.
        await page.setViewportSize({ width: 774, height: 560 });
        await until(atEdge, 3000, "pinned, narrower window");
        await page.setViewportSize({ width: 1024, height: 640 });
        await page.setViewportSize({ width: 900, height: 600 });
        await until(atEdge, 3000, "pinned, two sizes in a row");
        // The second key lands in the frame after the first re-pin, before its scroll event.
        const twice = (key: string) =>
          page.evaluate(async (k) => {
            const press = () =>
              (document.getElementById("scroller") as HTMLElement).dispatchEvent(
                new KeyboardEvent("keydown", { key: k, bubbles: true }),
              );
            press();
            await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
            press();
          }, key);
        await twice("+");
        await until(atEdge, 3000, "pinned, font up twice");
        await twice("-");
        await until(atEdge, 3000, "pinned, font back down");
        expect(
          await page.evaluate(() => (window as unknown as { unpinned: number }).unpinned),
        ).toBe(0);
        // Scrolled up by the reader: a new line does not move the view, and Back to live shows.
        await page.evaluate(() => {
          const s = document.getElementById("scroller") as HTMLElement;
          s.style.scrollBehavior = "auto";
          s.scrollTop -= 300;
        });
        await page.waitForSelector("#jump", { state: "visible" });
        const top = () =>
          page.evaluate(() => (document.getElementById("scroller") as HTMLElement).scrollTop);
        const held = await top();
        await line(41);
        await page.waitForSelector('#lines .row[data-id="l700041"]');
        await Bun.sleep(300);
        expect(await top()).toBe(held);
        expect(await page.locator("#jump").isVisible()).toBe(true);
        // Back to live goes straight down: on its way it never reads as scrolled up again.
        await page.evaluate(() => {
          (window as unknown as { unpinned: number }).unpinned = 0;
          (document.getElementById("scroller") as HTMLElement).style.scrollBehavior = "";
          (document.getElementById("jump") as HTMLElement).click();
        });
        await until(atEdge, 3000, "back at the bottom");
        expect((await place()).last).toBe("l700041");
        expect(
          await page.evaluate(() => (window as unknown as { unpinned: number }).unpinned),
        ).toBe(0);
        // Again with nothing arriving since the reader scrolled up.
        await page.evaluate(() => {
          const s = document.getElementById("scroller") as HTMLElement;
          s.scrollTo({ top: s.scrollTop - 300, behavior: "instant" });
        });
        await page.waitForSelector("#jump", { state: "visible" });
        await page.evaluate(() => {
          (window as unknown as { unpinned: number }).unpinned = 0;
          (document.getElementById("jump") as HTMLElement).click();
        });
        await until(atEdge, 3000, "back at the bottom, nothing arriving");
        expect(
          await page.evaluate(() => (window as unknown as { unpinned: number }).unpinned),
        ).toBe(0);
        // Back to live from the top, with the window's own smooth scrolling, while long lines
        // arrive: it lands on the newest line and stays pinned.
        await page.evaluate(() => {
          const s = document.getElementById("scroller") as HTMLElement;
          s.style.scrollBehavior = "";
          s.scrollTo({ top: 0, behavior: "instant" });
        });
        await page.waitForSelector("#jump", { state: "visible" });
        const arriving = (async () => {
          for (let i = 201; i <= 215; i++) {
            await rig.write(id, seg(`l7${i}`, long, { w0: Date.now() + i }));
            await Bun.sleep(40);
          }
        })();
        await page.click("#jump");
        await arriving;
        await page.waitForSelector('#lines .row[data-id="l7215"]');
        await until(atEdge, 3000, "pinned after Back to live while lines arrive");
        expect((await place()).last).toBe("l7215");
        expect(await page.locator("#jump").isVisible()).toBe(false);
      });
      t.cleanup();
    },
    UI_TIMEOUT,
  );

  test(
    "[W4.1] A saved call opens at its end, its last line at the bottom edge over the player bar and under the final note",
    async () => {
      const id = "01J8Z6Q4M2VX0K7B3D4E5FRUNN";
      await withRig(
        {
          seed: (home) => {
            seedCall(home, (b) => {
              b.created({ id });
              b.partStarted(1, T0);
              for (let i = 1; i <= 60; i++)
                b.seg({
                  id: `l${String(i).padStart(6, "0")}`,
                  w0: T0 + i * 4000,
                  text: `line number ${i} of the call`,
                });
              b.partEnded(1, "stop", 240);
              b.add({ type: "call.ended", reason: "stop" });
              b.add({ type: "final.started", pid: 1 });
            });
          },
        },
        async (rig) => {
          const page = await rig.open(undefined, {
            before: (p) => p.setViewportSize({ width: 1024, height: 700 }),
          });
          await page.click(`#calls li[data-id="${id}"] button`);
          await page.waitForSelector("#lines .row >> nth=59");
          await page.waitForSelector("#final:not([hidden])");
          await page.waitForSelector("#player-bar:not([hidden])");
          const below = () =>
            page.evaluate(() => {
              const s = (
                document.getElementById("scroller") as HTMLElement
              ).getBoundingClientRect();
              const last = document.querySelector("#lines .row:last-child") as HTMLElement;
              return s.bottom - last.getBoundingClientRect().bottom;
            });
          // Read once the view stopped moving: a smooth scroll carries the last line past the edge.
          await until(
            async () => {
              const b = await below();
              await Bun.sleep(250);
              return b === (await below()) && b >= -1 && b <= 24;
            },
            3000,
            "last line at the bottom edge",
          );
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
          // Split off, Speaker 2 has no name and no final pass behind it: a guess again (W4.2).
          await until(async () => (await who("l000003")) === "c2?", 5000, "unmerged");
          // No transcript was read again for any of it.
          expect(log.paths().filter((p) => /transcript|events$/.test(p))).toEqual([]);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "Stable speaker hues: you = 214 drawn in neutral grey, others in order of first appearance; a renamed speaker keeps its hue",
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
          // You are drawn in a neutral grey, never on the accent's blue; the others keep a hue.
          const spread = (sel: string, prop: "color" | "backgroundColor" = "color") =>
            page.$eval(
              sel,
              (el, p) => {
                const [r, g, b] = (getComputedStyle(el)[p].match(/\d+/g) ?? []).map(Number);
                return Math.max(r ?? 0, g ?? 0, b ?? 0) - Math.min(r ?? 0, g ?? 0, b ?? 0);
              },
              prop,
            );
          expect(await spread('#lines .row[data-id="l000001"] .who')).toBeLessThan(24);
          expect(await spread('#people li[data-spk="you"] i', "backgroundColor")).toBeLessThan(24);
          // Positive control: a speaker with a hue is far from grey, as a line and as a chip.
          expect(await spread('#lines .row[data-id="l000002"] .who')).toBeGreaterThan(60);
          expect(await spread('#people li[data-spk="c1"] i', "backgroundColor")).toBeGreaterThan(
            60,
          );
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
    "Sidebar list of calls by workspace and day; one open at a time; switch without reload; search by title and workspace, never by what was said",
    async () => {
      const ids: string[] = [];
      await withRig(
        {
          seed: (home) => {
            ids.push(seedCall(home, (b) => standardCall(b, "01J8Z6Q4M2VX0K7B3D4E5FIRST")).id);
            ids.push(
              seedCall(home, (b) => {
                // An hour after the first call: created at the same instant, the two would tie and
                // their order would be whatever order the file system lists the folders in.
                b.created(
                  { id: "01J8Z6Q4M2VX0K7B3D4ESECOND", title: "Second call" },
                  T0 + 3_600_000,
                );
                b.partStarted(1, T0 + 3_600_000);
                b.seg({ id: "l000001", ch: "call", w0: T0 + 3_601_000, text: "only line here" });
                b.partEnded(1, "stop");
                b.add({ type: "call.ended", reason: "stop" });
              }).id,
            );
            // A minute ago, in another workspace: its group comes first and its day is Today.
            const recent = Date.now() - 60_000;
            ids.push(
              seedCall(home, (b) => {
                b.created(
                  { id: "01J8Z6Q4M2VX0K7B3D4E5THIRD", title: "Design loop", workspace: "hiring" },
                  recent,
                );
                b.partStarted(1, recent);
                b.seg({ id: "l000001", ch: "call", w0: recent + 1000, text: "hello" });
                b.partEnded(1, "stop");
                b.add({ type: "call.ended", reason: "stop" });
              }).id,
            );
          },
        },
        async (rig) => {
          const page = await rig.open(ids[0]);
          await page.waitForSelector("#lines .row >> nth=3");
          await page.waitForSelector("#calls li >> nth=2");
          const items = page.locator("#calls li");
          const titles = () => page.locator("#calls li .what").allTextContents();
          const groups = () =>
            page.$$eval("#calls .ws-group", (g) =>
              g.map(
                (x) =>
                  `${(x as HTMLElement).dataset.workspace} ${x.querySelector(".cnt")?.textContent}`,
              ),
            );
          // By workspace, the one with the newest call first; newest first inside each.
          expect(await groups()).toEqual(["hiring 1", "work 2"]);
          expect(await titles()).toEqual(["Design loop", "Second call", "Weekly sync"]);
          // Each row: its day, its local start time and how long it ran.
          expect(await items.first().locator(".when").textContent()).toMatch(
            /^Today, \d{2}:\d{2} · (under 1 min|\d+ min)$/,
          );
          expect(await items.nth(1).locator(".when").textContent()).toMatch(
            /^(Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d{1,2} [A-Z][a-z]{2}( \d{4})?), \d{2}:\d{2} · /,
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
          expect(await text(page, "#title")).toBe("Second call");
          expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(
            42,
          );
          expect(new URL(page.url()).searchParams.get("call")).toBe(ids[1] as string);
          expect(
            await page
              .locator(`#calls li[data-id="${ids[1]}"] button`)
              .getAttribute("aria-current"),
          ).toBe("true");
          expect(await page.locator('#calls [aria-current="true"]').count()).toBe(1);

          // The search narrows by title or workspace as you type; clearing it brings every group
          // back. It never reads what was said: "only line here" is in a transcript, not a title.
          const search = page.locator("#calls-search");
          await search.fill("second");
          await until(async () => (await items.count()) === 1, 5000, "narrowed by title");
          expect(await titles()).toEqual(["Second call"]);
          expect(await groups()).toEqual(["work 1"]);
          await search.fill("HIRING");
          await until(async () => (await items.count()) === 1, 5000, "narrowed by workspace");
          expect(await titles()).toEqual(["Design loop"]);
          await search.fill("only line here");
          await until(async () => (await items.count()) === 0, 5000, "no match");
          expect(await text(page, "#calls .none")).toBe(
            "No call title or workspace has “only line here”.",
          );
          await search.fill("");
          await until(async () => (await items.count()) === 3, 5000, "cleared");
          expect(await groups()).toEqual(["hiring 1", "work 2"]);
          await search.fill("weekly");
          await until(async () => (await items.count()) === 1, 5000, "narrowed again");
          await search.press("Escape");
          await until(async () => (await items.count()) === 3, 5000, "Escape clears");
          expect(await search.inputValue()).toBe("");

          // A group folds and unfolds with the mouse and with the keyboard.
          const hiring = page.locator('#calls .ws-head[data-ws="hiring"]');
          await hiring.click();
          await until(
            async () => (await hiring.getAttribute("aria-expanded")) === "false",
            5000,
            "folded",
          );
          expect(await page.isVisible(`#calls li[data-id="${ids[2]}"]`)).toBe(false);
          expect(await page.isVisible(`#calls li[data-id="${ids[1]}"]`)).toBe(true);
          await hiring.click();
          await page.waitForSelector(`#calls li[data-id="${ids[2]}"]`, { state: "visible" });
          const work = page.locator('#calls .ws-head[data-ws="work"]');
          await work.focus();
          await page.keyboard.press("Enter");
          await page.waitForSelector(`#calls li[data-id="${ids[0]}"]`, { state: "hidden" });
          expect(await work.getAttribute("aria-expanded")).toBe("false");
          // The redraw keeps the keyboard on the group, so the same key unfolds it.
          await page.keyboard.press("Space");
          await page.waitForSelector(`#calls li[data-id="${ids[0]}"]`, { state: "visible" });
          expect(await work.getAttribute("aria-expanded")).toBe("true");

          // The readiness row: the models are there.
          expect(await text(page, "#readiness-text")).toBe("Ready");
          expect(await page.getAttribute("#readiness", "data-state")).toBe("ready");
          expect(await page.isVisible("#models-pip")).toBe(false);
          expect(await page.isVisible("#readiness-setup")).toBe(false);
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
          // A log with no model and no figure from the app yet: the note says running, the bar counts parts.
          expect(await text(page, "#final-text")).toBe("final transcript: running");
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
              "final transcript: ready, 1 span skipped  ·  the call side had energy but no text",
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
