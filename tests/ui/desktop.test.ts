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
import { type DesktopRig, desktopRig } from "./desktop-rig.ts";
import { seg, silentWav, UI_TIMEOUT, uiRig, until } from "./rig.ts";

/** Markers carried by the call's title, its lines and its speaker's name. */
const MARKS = ["TITLEMARK-q7x", "SEGMARK-z9k", "NAMEMARK-w3v"] as const;

/** The markers the page shows anywhere: its text, its attributes, its title. */
function leaked(page: Page): Promise<string[]> {
  return page.evaluate((marks) => {
    const all = `${document.title}\n${document.documentElement.outerHTML}`;
    return marks.filter((m) => all.includes(m));
  }, MARKS);
}

async function withDesktop(fn: (rig: DesktopRig, dir: string) => Promise<void>): Promise<void> {
  const t = tempDir("akou-ui-desk-");
  const wav = silentWav(t.dir);
  const rig = await desktopRig({ home: t.dir, helperArgs: ["--from-wav", wav] });
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
  /** The page as it runs on another OS: the pane reads the OS from the browser. */
  const as = (platform: string, ua: string) => (page: Page) =>
    page.addInitScript(
      ([p, u]) => {
        Object.defineProperty(navigator, "platform", { get: () => p });
        Object.defineProperty(navigator, "userAgent", { get: () => u });
      },
      [platform, ua],
    );

  test(
    "off macOS the field warns while you type; on macOS it does not",
    async () => {
      const t = tempDir("akou-ui-hk-");
      const rig = await uiRig({ home: t.dir });
      try {
        for (const [platform, ua, warns] of [
          ["Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", true],
          ["MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4)", false],
        ] as const) {
          const page = await rig.open(undefined, { before: as(platform, ua) });
          await page.click("#settings-open");
          const field = page.locator("#set-app-hotkey");
          await field.waitFor();
          const hint = page.locator('div.setting[data-key="app.hotkey"] small.issue');
          await field.fill("Control+Shift+F9");
          expect(await hint.isHidden()).toBe(true);
          await field.fill("Control+Alt+X");
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
