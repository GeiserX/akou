/**
 * The floating indicator on its real page (docs/ux/DESKTOP.md DK-F1), inside the real shell over
 * the real app with the fake capture helper: Stop stops, Mute mutes, a click opens the main window,
 * a dead channel changes the dot, and nothing a call says, is called or is named by ever reaches
 * the page. The quit question (DK-M3) in the main window's page.
 */

import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import type { EventDraft } from "../../src/core/log/events.ts";
import { tempDir } from "../helpers.ts";
import { type DesktopRig, type DesktopRigOptions, desktopRig } from "./desktop-rig.ts";
import { seg, silentWav, UI_TIMEOUT, uiRig, until, windowPage } from "./rig.ts";

/** Markers carried by the call's title, its lines and its speaker's name. */
const MARKS = ["TITLEMARK-q7x", "SEGMARK-z9k", "NAMEMARK-w3v"] as const;

/** The markers the page shows anywhere: its text, its attributes, its title. */
function leaked(page: Page): Promise<string[]> {
  return page.evaluate((marks) => {
    const all = `${document.title}\n${document.documentElement.outerHTML}`;
    return marks.filter((m) => all.includes(m));
  }, MARKS);
}

async function withDesktop(
  fn: (rig: DesktopRig, dir: string) => Promise<void>,
  o: DesktopRigOptions = {},
): Promise<void> {
  const t = tempDir("akou-ui-desk-");
  const wav = silentWav(t.dir);
  const rig = await desktopRig({ ...o, home: t.dir, helperArgs: ["--from-wav", wav] });
  try {
    await fn(rig, t.dir);
  } finally {
    await rig.close();
    t.cleanup();
  }
}

const indicatorPage = async (rig: DesktopRig): Promise<Page> => {
  await until(() => rig.indicator() !== null, 10_000, "the indicator page");
  const page = rig.indicator() as Page;
  await page.waitForFunction(() => document.getElementById("state")?.textContent === "Recording");
  return page;
};

describe("[DK-F1] the floating indicator", () => {
  test(
    "shows the state and no call content; a dead channel changes the dot",
    async () => {
      await withDesktop(async (rig) => {
        const id = await rig.startCall({ title: `Weekly ${MARKS[0]}` });
        const page = await indicatorPage(rig);
        expect(rig.indicatorShown()).toBe(true);
        await rig.app.write(id, seg("l000001", `we ship ${MARKS[1]} on friday`));
        await rig.app.write(id, {
          type: "speaker.name",
          spk: "c1",
          name: MARKS[2],
          by: "user",
        } as EventDraft);
        // Wait for the page to have had the events, then read it.
        await until(
          async () => (await rig.api("GET", `/calls/${id}`)).body?.state === "recording",
          5000,
          "recording",
        );
        await Bun.sleep(400);
        expect(await leaked(page)).toEqual([]);
        // Positive control: a marker put on the page is found by the same check.
        await page.evaluate((m) => {
          const s = document.createElement("span");
          s.id = "control";
          s.textContent = m;
          document.body.append(s);
        }, MARKS[1] as string);
        expect(await leaked(page)).toEqual([MARKS[1]]);
        await page.evaluate(() => document.getElementById("control")?.remove());

        expect(await page.getAttribute("#dot", "data-state")).toBe("recording");
        await rig.app.write(id, {
          type: "health",
          part: 1,
          ch: "call",
          state: "dead",
          silentFor: 12,
          rebuilds: 1,
          detail: "no call audio",
        } as EventDraft);
        await page.waitForFunction(() => document.getElementById("dot")?.dataset.state === "warn");
        expect(await page.textContent("#state")).toBe("call side silent");
        expect(await page.textContent("#dot")).toBe("⚠");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Mute mutes, a click opens the main window, Stop stops and closes it; there is no Ask",
    async () => {
      await withDesktop(async (rig) => {
        const id = await rig.startCall({ title: "Sync" });
        const page = await indicatorPage(rig);

        await page.click("#mute");
        await until(
          async () => (await rig.api("GET", `/calls/${id}`)).body?.muted === true,
          5000,
          "muted",
        );
        await page.waitForFunction(
          () => document.getElementById("mute")?.getAttribute("aria-pressed") === "true",
        );
        expect(await page.textContent("#mute")).toBe("Unmute");
        await page.click("#mute");
        await until(
          async () => (await rig.api("GET", `/calls/${id}`)).body?.muted === false,
          5000,
          "unmuted",
        );

        // Asking goes through the palette (PRINCIPLES.md), not the indicator.
        expect(await page.$("#ask")).toBeNull();
        expect(rig.main()).toBeNull();
        await page.click("#open");
        await until(() => rig.main() !== null, 10_000, "the main window");
        // The main window has the focus now: the indicator steps aside.
        expect(rig.indicatorShown()).toBe(false);

        await page.click("#stop");
        await until(
          async () => (await rig.api("GET", `/calls/${id}`)).body?.state !== "recording",
          10_000,
          "stopped",
        );
        await until(() => rig.indicator() === null, 5000, "the indicator closed");
      });
    },
    UI_TIMEOUT,
  );
});

/** The indicator's two bars, as drawn. */
const bars = (page: Page) =>
  page.evaluate(() =>
    (["mic", "call"] as const).map(
      (ch) => (document.getElementById(`lvl-${ch}`) as HTMLMeterElement).value,
    ),
  );

describe("[DK-F1] the indicator's level bars", () => {
  for (const frames of [true, false])
    test(
      `both bars move with the capture ${frames ? "in a page in front" : "in a page that runs no animation frame, as the always-on-top window on macOS"}`,
      async () => {
        await withDesktop(
          async (rig) => {
            await rig.startCall({ title: "Sync" });
            const page = await indicatorPage(rig);
            // The fake helper sends the mic at -20 dBFS and the call at -24, four times a second.
            await until(
              async () => (await bars(page)).every((db) => db > -40),
              8000,
              "both indicator bars to move",
            );
          },
          { indicatorWithoutFrames: !frames },
        );
      },
      UI_TIMEOUT,
    );
});

/** The pill's width, CSS px, and what the page paints around it. */
const pill = (page: Page) =>
  page.evaluate(() => {
    const bg = (e: Element) => getComputedStyle(e).backgroundColor;
    return {
      width: (document.getElementById("bar") as HTMLElement).getBoundingClientRect().width,
      around: [bg(document.documentElement), bg(document.body)],
      own: bg(document.getElementById("bar") as HTMLElement),
    };
  });

describe("[DK-F1] the indicator's window is as wide as its pill", () => {
  test(
    "recording, muted, paused and past an hour: the window follows the pill, and nothing around it is painted",
    async () => {
      await withDesktop(
        async (rig) => {
          const id = await rig.startCall({ title: "Sync" });
          const page = await indicatorPage(rig);
          const fits = async (what: string) => {
            await until(
              async () =>
                Math.abs((await pill(page)).width - (rig.indicatorFrame()?.width ?? 0)) <= 1,
              5000,
              `${what}: the window ${rig.indicatorFrame()?.width} px wide, the pill ${(await pill(page)).width} px`,
            );
            return (await pill(page)).width;
          };
          const text = (sel: string, want: RegExp) =>
            page.waitForFunction(
              ([s, w]) =>
                new RegExp(w as string).test(
                  document.querySelector(s as string)?.textContent ?? "",
                ),
              [sel, want.source],
            );

          const recording = await fits("recording");
          // The window opens 480 px wide; the pill is narrower, so the fit really moved it.
          expect(recording).toBeLessThan(480);
          const p = await pill(page);
          expect(p.around).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
          expect(p.own).not.toBe("rgba(0, 0, 0, 0)");
          // It keeps its right edge: from the top right corner it stays 16 px from the edge.
          const f = rig.indicatorFrame();
          expect((f?.x ?? 0) + (f?.width ?? 0)).toBe(1440 - 16);

          await page.click("#mute");
          await text("#mute", /^Unmute$/);
          expect(await fits("muted")).toBeGreaterThan(recording);
          await page.click("#mute");
          await text("#mute", /^Mute$/);
          expect(await fits("unmuted")).toBe(recording);

          expect((await rig.api("POST", `/calls/${id}/pause`)).status).toBeLessThan(300);
          await text("#state", /^Paused$/);
          await fits("paused");
          expect((await rig.api("POST", `/calls/${id}/resume`)).status).toBeLessThan(300);
          await text("#state", /^Recording$/);

          await page.clock.fastForward("01:00:00");
          await text("#elapsed", /^1:00:\d\d$/);
          expect(await fits("past an hour")).toBeGreaterThan(recording);
        },
        { indicatorClock: true },
      );
    },
    UI_TIMEOUT,
  );
});

describe("[DK-F1] Open transcript on the indicator", () => {
  test(
    "a call started outside the window opens no window; Open transcript shows it on the live call",
    async () => {
      await withDesktop(async (rig) => {
        const id = await rig.startCall({ title: "Sync" });
        const page = await indicatorPage(rig);
        const button = page.locator("#show");
        expect(await button.textContent()).toBe("Open transcript");
        expect(await button.isEnabled()).toBe(true);
        // The start raised nothing: only the indicator is up.
        await Bun.sleep(300);
        expect(rig.main()).toBeNull();
        await button.click();
        await until(() => rig.main() !== null, 10_000, "the main window");
        const main = rig.main() as Page;
        await main.waitForFunction(
          (call) =>
            document.querySelector<HTMLElement>('#calls button[aria-current="true"]')?.dataset
              .id === call,
          id,
          { timeout: 10_000 },
        );
      });
    },
    UI_TIMEOUT,
  );
});

describe("[DK-M3] the quit question is asked in the window", () => {
  test(
    "Cancel has the focus: Return and Escape keep the call; Stop and quit quits",
    async () => {
      await withDesktop(async (rig) => {
        const id = await rig.startCall({ title: "Sync" });
        // The app's quit is counted, not run: the rig's own close runs it.
        let quits = 0;
        const realQuit = rig.app.quit;
        rig.app.quit = async () => {
          quits++;
        };
        await using _restore = {
          [Symbol.asyncDispose]: async () => {
            rig.app.quit = realQuit;
          },
        };
        const question = async () => {
          const main = rig.main() as Page;
          await main.waitForSelector("#quit-question[open]");
          return main;
        };
        const recording = async () =>
          (await rig.api("GET", `/calls/${id}`)).body?.state === "recording";

        expect(rig.quitRequested()).toBe(true);
        await until(() => rig.main() !== null, 10_000, "the main window");
        let main = await question();
        expect(await main.textContent("#quit-message")).toBe(
          "A call is recording. Stop it and quit?",
        );
        expect(await main.evaluate(() => document.activeElement?.id)).toBe("quit-cancel");
        // While the question is up, the app still answers: nothing blocks the main process.
        expect((await rig.api("GET", "/status")).status).toBe(200);
        await main.keyboard.press("Enter");
        await main.waitForSelector("#quit-question", { state: "detached" });
        await Bun.sleep(100);
        expect(await recording()).toBe(true);
        expect([quits, rig.exits()]).toEqual([0, 0]);

        expect(rig.quitRequested()).toBe(true);
        main = await question();
        await main.keyboard.press("Escape");
        await main.waitForSelector("#quit-question", { state: "detached" });
        await Bun.sleep(100);
        expect(await recording()).toBe(true);
        expect([quits, rig.exits()]).toEqual([0, 0]);

        // Positive control: the confirm button does quit.
        expect(rig.quitRequested()).toBe(true);
        main = await question();
        await main.click("#quit-go");
        await until(() => rig.exits() === 1, 5000, "the exit");
        expect(quits).toBe(1);
      });
    },
    UI_TIMEOUT,
  );
});

describe("[DK-K4] Settings warns about a Control+Alt hotkey", () => {
  /**
   * The page in one OS's browser, over an app on another: the browser's platform is faked, and
   * the app's `/status` answers the host's.
   */
  const as = (browser: string, host: string) => async (page: Page) => {
    await page.addInitScript((p) => {
      Object.defineProperty(navigator, "platform", { get: () => p });
    }, browser);
    await page.route("**/api/v1/status", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.app.platform = host;
      await route.fulfill({ response: res, json: body });
    });
  };

  test(
    "the host's OS decides, not the browser's: a Windows host warns in a Mac browser, a Mac host never",
    async () => {
      const t = tempDir("akou-ui-hk-");
      const rig = await uiRig({ home: t.dir });
      try {
        for (const [browser, host, warns] of [
          ["MacIntel", "win32", true],
          ["Win32", "darwin", false],
          ["Linux x86_64", "linux", true],
        ] as const) {
          const page = await rig.open(undefined, { before: as(browser, host) });
          await page.click("#settings-open");
          // The record shortcut is recorded with Change; the warning is the recorder's note.
          const change = page.locator('.pg-row[data-key="app.hotkey"] button.record-key');
          await change.waitFor();
          const hint = page.locator('.pg-row[data-key="app.hotkey"] .recorder-note');
          await change.click();
          await page.keyboard.press("Control+Shift+F9");
          await until(async () => (await change.textContent()) === "Change", 3000, "recorded");
          expect(await hint.isHidden()).toBe(true);
          await change.click();
          await page.keyboard.press("Control+Alt+KeyX");
          await until(async () => (await change.textContent()) === "Change", 3000, "recorded");
          if (warns) {
            await hint.waitFor({ state: "visible" });
            expect(await hint.textContent()).toContain("AltGr");
          } else {
            await Bun.sleep(100);
            expect(await hint.isHidden()).toBe(true);
          }
          await page.close();
        }
      } finally {
        await rig.close();
        t.cleanup();
      }
    },
    UI_TIMEOUT,
  );
});

/** What the title bar strip looks like on the page: the inset, the tops, the drag regions. */
function titleBarState(page: Page) {
  return page.evaluate(() => {
    const DRAG = "electrobun-webkit-app-region-drag";
    const NO_DRAG = "electrobun-webkit-app-region-no-drag";
    const top = (sel: string) =>
      Math.round(document.querySelector(sel)?.getBoundingClientRect().top ?? -1);
    const controls = "input, select, button, textarea, [tabindex]";
    return {
      inset: document.body.classList.contains("inset"),
      tops: {
        wordmark: top("#sidebar .brand svg"),
        record: top("#record"),
        ask: top("#ask-form"),
      },
      drag: [...document.querySelectorAll(`.${DRAG}`)].map(
        (el) => el.id || el.className.split(" ")[0],
      ),
      // A control inside a drag region with no no-drag between them would move the window.
      loose: [...document.querySelectorAll(`.${DRAG} :is(${controls})`)]
        .filter((el) => !el.closest(`.${NO_DRAG}`))
        .map((el) => el.id || el.tagName),
      controls: [
        ...document.querySelectorAll(`#composer :is(${controls}), #ask-row :is(${controls})`),
      ].length,
    };
  });
}

/**
 * The page's own strip and header: their heights, tops, drag regions and loose controls. `at` is
 * the page on screen; a page left behind keeps its header hidden, which counts for nothing.
 */
function pageTitleBar(page: Page, at = "#page-settings") {
  return page.evaluate((at) => {
    const DRAG = "electrobun-webkit-app-region-drag";
    const NO_DRAG = "electrobun-webkit-app-region-no-drag";
    const controls = "input, select, button, textarea, a, [tabindex]";
    const inPages = [...document.querySelectorAll<HTMLElement>(`#pages .${DRAG}`)].filter((el) =>
      el.checkVisibility(),
    );
    return {
      bar: Math.round(
        document.querySelector("#pages > .pg-bar")?.getBoundingClientRect().height ?? -1,
      ),
      title: Math.round(
        document.querySelector(`${at} .pg-top h1`)?.getBoundingClientRect().top ?? -1,
      ),
      drag: inPages.map((el) => el.className.split(" ")[0]).sort(),
      controls: inPages.flatMap((el) => [...el.querySelectorAll(controls)]).length,
      loose: inPages
        .flatMap((el) => [...el.querySelectorAll(controls)])
        .filter((el) => !el.closest(`.${NO_DRAG}`))
        .map((el) => el.id || el.tagName),
    };
  }, at);
}

describe("[DK-M7] the macOS window's title bar strip", () => {
  test(
    "on macOS the top rows start under the traffic lights and drag; Windows, Linux and a browser keep their spacing",
    async () => {
      const t = tempDir("akou-ui-titlebar-");
      const rig = await uiRig({ home: t.dir });
      try {
        // The page header's tops on macOS, which the other platforms draw 28 px higher.
        const onMac: number[] = [];
        const modelsOnMac: number[] = [];
        const dictationOnMac: number[] = [];
        const subOnMac: number[] = [];
        for (const platform of ["darwin", "win32", "linux"]) {
          const w = await windowPage(rig, { platform });
          const { page } = w;
          try {
            await page.setViewportSize({ width: 1280, height: 820 });
            // The status has been applied once the state word replaced its placeholder.
            await page.waitForFunction(() => document.getElementById("state")?.textContent !== "…");
            const s = await titleBarState(page);
            const zooms = () => w.requests.filter((r) => r.name === "zoomWindow").length;
            // A double-click on the row's empty top-left corner, then on a field in it.
            const box = await page.locator("#composer").boundingBox();
            if (!box) throw new Error("no composer");
            await page.mouse.dblclick(box.x + 4, box.y + 4);
            await page.dblclick("#newtitle");
            if (platform === "darwin") {
              expect(s.inset).toBe(true);
              // The traffic lights take the top 28 px of the window; nothing is drawn under them.
              expect(Math.min(s.tops.wordmark, s.tops.record, s.tops.ask)).toBeGreaterThanOrEqual(
                28,
              );
              expect(s.drag.sort()).toEqual(["ask-row", "brand", "composer", "pg-bar"]);
              expect(s.controls).toBeGreaterThan(5);
              expect(s.loose).toEqual([]);
              await until(() => zooms() === 1, 5000, "the zoom");
            } else {
              expect(`${platform}: ${s.inset} ${s.drag}`).toBe(`${platform}: false `);
              expect(Math.max(s.tops.wordmark, s.tops.record, s.tops.ask)).toBeLessThan(28);
            }
            // The title field's double-click selects its word; only the strip zooms.
            await new Promise((r) => setTimeout(r, 200));
            expect(`${platform}: ${zooms()}`).toBe(`${platform}: ${platform === "darwin" ? 1 : 0}`);
            // A page's header, on the page and on a page under it, starts under the strip too.
            await page.click("#settings-open");
            await page.waitForSelector("#page-settings .pg-top h1");
            const home = await pageTitleBar(page);
            // Scrolled, the strip stays at the window's top and the rows pass under it.
            const stuck = await page.evaluate(() => {
              const pages = document.getElementById("pages");
              pages?.scrollTo({ top: 300, behavior: "instant" });
              const bar = document.querySelector("#pages > .pg-bar")?.getBoundingClientRect();
              const r = pages?.getBoundingClientRect();
              const hit = r && document.elementFromPoint(r.left + r.width / 2, 14);
              const seen = `${pages?.scrollTop} ${bar?.top} ${hit?.className}`;
              pages?.scrollTo({ top: 0, behavior: "instant" });
              return seen;
            });
            // A double-click on the header's empty middle zooms; one on its search box does not.
            const gap = await page.evaluate(() => {
              const h1 = document
                .querySelector("#page-settings .pg-head h1")
                ?.getBoundingClientRect();
              const find = document
                .querySelector("#page-settings .pg-find")
                ?.getBoundingClientRect();
              return h1 && find
                ? { x: (h1.right + find.left) / 2, y: h1.top + h1.height / 2 }
                : null;
            });
            if (!gap) throw new Error("no page header");
            await page.mouse.dblclick(gap.x, gap.y);
            await page.dblclick("#page-settings .pg-find .ico");
            await page.click("#page-settings button.pg-link[id^='settings-go-']");
            await page.waitForSelector("#page-settings .pg-back");
            // The click scrolled the link into view; the page under it opens at its top, smoothly.
            await page.waitForFunction(() => document.getElementById("pages")?.scrollTop === 0);
            const sub = await pageTitleBar(page);
            await new Promise((r) => setTimeout(r, 200));
            if (platform === "darwin") {
              for (const p of [home, sub]) {
                expect(p.bar).toBe(28);
                expect(p.title).toBeGreaterThanOrEqual(28 + 28);
                expect(p.drag).toEqual(["pg-bar", "pg-top"]);
                expect(p.controls).toBeGreaterThan(0);
                expect(p.loose).toEqual([]);
              }
              expect(zooms()).toBe(2);
              expect(stuck).toStartWith("300 0 pg-bar");
              onMac.push(home.title, sub.title);
            } else {
              for (const p of [home, sub])
                expect(`${platform}: ${p.bar} ${p.drag}`).toBe(`${platform}: 0 `);
              // The same header, without the strip above it.
              expect([home.title, sub.title]).toEqual(onMac.map((top) => top - 28));
              expect(`${platform}: ${zooms()}`).toBe(`${platform}: 0`);
            }
            // The Models page and its Helpers page start under the same strip, with the same drag.
            await page.click("#models-open");
            await page.waitForSelector("#page-models .pg-top h1");
            const models = await pageTitleBar(page, "#page-models");
            await page.click("#models-go-helpers");
            await page.waitForSelector("#page-models .pg-back");
            const helpers = await pageTitleBar(page, "#page-models");
            if (platform === "darwin") {
              for (const p of [models, helpers]) {
                expect(p.bar).toBe(28);
                expect(p.title).toBeGreaterThanOrEqual(28 + 28);
                expect(p.drag).toEqual(["pg-bar", "pg-top"]);
                expect(p.controls).toBeGreaterThan(0);
                expect(p.loose).toEqual([]);
              }
              modelsOnMac.push(models.title, helpers.title);
            } else {
              for (const p of [models, helpers])
                expect(`${platform}: ${p.bar} ${p.drag}`).toBe(`${platform}: 0 `);
              expect([models.title, helpers.title]).toEqual(modelsOnMac.map((top) => top - 28));
            }
            // The Dictation page and its Advanced page start under the same strip, with the same drag.
            await page.click("#dictation-open");
            await page.waitForSelector("#page-dictation .pg-top h1");
            const dictation = await pageTitleBar(page, "#page-dictation");
            await page.click("#dictation-advanced");
            await page.waitForSelector("#page-dictation .pg-back");
            // The click scrolled the row into view; the page under it opens at its top, smoothly.
            await page.waitForFunction(() => document.getElementById("pages")?.scrollTop === 0);
            const advanced = await pageTitleBar(page, "#page-dictation");
            if (platform === "darwin") {
              for (const p of [dictation, advanced]) {
                expect(p.bar).toBe(28);
                expect(p.title).toBeGreaterThanOrEqual(28 + 28);
                expect(p.drag).toEqual(["pg-bar", "pg-top"]);
                expect(p.loose).toEqual([]);
              }
              // The back link is a control inside the dragging header.
              expect(advanced.controls).toBeGreaterThan(0);
              dictationOnMac.push(dictation.title, advanced.title);
            } else {
              for (const p of [dictation, advanced])
                expect(`${platform}: ${p.bar} ${p.drag}`).toBe(`${platform}: 0 `);
              expect([dictation.title, advanced.title]).toEqual(
                dictationOnMac.map((top) => top - 28),
              );
            }
            // Words and History, under Dictation, too; History's search is a control in the header.
            await page.click("#page-dictation .pg-back");
            await page.click("#dictation-dictionary-open");
            await page.waitForSelector("#page-dictation .pg-back");
            await page.waitForFunction(() => document.getElementById("pages")?.scrollTop === 0);
            const words = await pageTitleBar(page, "#page-dictation");
            await page.click("#page-dictation .pg-back");
            await page.click("#dictation-history-open");
            await page.waitForSelector("#page-dictation #dictation-history-q");
            await page.waitForFunction(() => document.getElementById("pages")?.scrollTop === 0);
            const history = await pageTitleBar(page, "#page-dictation");
            if (platform === "darwin") {
              for (const p of [words, history]) {
                expect(p.bar).toBe(28);
                expect(p.title).toBeGreaterThanOrEqual(28 + 28);
                expect(p.drag).toEqual(["pg-bar", "pg-top"]);
                expect(p.loose).toEqual([]);
              }
              // The back link, and History's search beside its title.
              expect(history.controls).toBeGreaterThan(words.controls);
              subOnMac.push(words.title, history.title);
            } else {
              for (const p of [words, history])
                expect(`${platform}: ${p.bar} ${p.drag}`).toBe(`${platform}: 0 `);
              expect([words.title, history.title]).toEqual(subOnMac.map((top) => top - 28));
            }
          } finally {
            await w.close();
          }
        }
        // A browser tab on a Mac has no window to move.
        const page = await rig.open(undefined, {
          before: (p) =>
            p.route(
              (u) => u.pathname === "/api/v1/status",
              async (route) => {
                const res = await route.fetch();
                const real = (await res.json()) as { app: Record<string, unknown> };
                return route.fulfill({
                  response: res,
                  json: { ...real, app: { ...real.app, platform: "darwin" } },
                });
              },
            ),
        });
        await page.waitForFunction(() => document.getElementById("state")?.textContent !== "…");
        const s = await titleBarState(page);
        expect(`browser: ${s.inset} ${s.drag}`).toBe("browser: false ");
      } finally {
        await rig.close();
        t.cleanup();
      }
    },
    UI_TIMEOUT,
  );
});
