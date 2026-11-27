/**
 * Screenshots for review (docs/TESTING.md TS-15c): with `AKOU_UI_SHOTS` set, a rig saves every page
 * its test left open in both themes as it closes. Never compared, so never a gate; this proves the
 * files are written, that each theme really took, that no shot is taken while the theme's colours
 * are still fading in, and that the page is handed back to the system's.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { tempDir } from "../helpers.ts";
import { screenshots, seedCall, settle, standardCall, UI_TIMEOUT, uiRig } from "./rig.ts";

/** The page's animations and transitions that end and are running now. */
const fading = (page: Page) =>
  page.evaluate(
    () =>
      document
        .getAnimations()
        .filter(
          (a) =>
            a.playState === "running" &&
            a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY,
        ).length,
  );

/** The PNG's width and height, from its IHDR chunk. */
const size = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];

describe("[TS-15c] every UI run saves screenshots for review", () => {
  test(
    "a page is saved dark then light, the two differ, and the theme goes back to the system's",
    async () => {
      const t = tempDir("akou-ui-");
      const rig = await uiRig({ home: t.dir });
      try {
        const page = await rig.open();
        const dark = () => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
        const before = await dark();
        const files = await screenshots(page, join(t.dir, "shots"), "empty");
        expect(files).toEqual([
          join(t.dir, "shots", "empty-dark.png"),
          join(t.dir, "shots", "empty-light.png"),
        ]);
        const [d, l] = files.map((f) => readFileSync(f));
        expect(d?.subarray(1, 4).toString()).toBe("PNG");
        expect(size(d as Buffer)[0]).toBeGreaterThan(0);
        // Positive control: the same screen in the other theme is another picture.
        expect(Buffer.compare(d as Buffer, l as Buffer)).not.toBe(0);
        expect(await dark()).toBe(before);
      } finally {
        await rig.close();
        t.cleanup();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "each shot waits until the theme's colours have finished fading in",
    async () => {
      const t = tempDir("akou-ui-");
      const id = seedCall(t.dir, (b) => standardCall(b, "01J8Z6Q4M2VX0K7B3D4E5SHOTS")).id;
      const rig = await uiRig({ home: t.dir });
      try {
        const page = await rig.open(id);
        await page.waitForSelector("#lines .row >> nth=3");
        await settle(page);
        // Positive control: a theme switch starts the rows' colour transition, so a shot taken
        // at once would catch it.
        await page.emulateMedia({ colorScheme: "dark" });
        expect(await fading(page)).toBeGreaterThan(0);
        await page.emulateMedia({ colorScheme: "light" });
        await settle(page);
        const atShot: number[] = [];
        const shoot = page.screenshot.bind(page);
        page.screenshot = async (o) => {
          atShot.push(await fading(page));
          return shoot(o);
        };
        await screenshots(page, join(t.dir, "shots"), "rows");
        expect(atShot).toEqual([0, 0]);
      } finally {
        await rig.close();
        t.cleanup();
      }
    },
    UI_TIMEOUT,
  );

  test(
    "a rig named for screenshots saves its open pages at close only when AKOU_UI_SHOTS is set",
    async () => {
      const t = tempDir("akou-ui-");
      const dir = join(t.dir, "shots");
      const was = process.env.AKOU_UI_SHOTS;
      try {
        for (const set of [false, true]) {
          if (set) process.env.AKOU_UI_SHOTS = dir;
          else delete process.env.AKOU_UI_SHOTS;
          const rig = await uiRig({ home: join(t.dir, String(set)) });
          rig.shots = `row-${set}`;
          await rig.open();
          await rig.open();
          await rig.close();
        }
        expect(existsSync(join(dir, "row-false-1-dark.png"))).toBe(false);
        for (const n of [1, 2])
          for (const scheme of ["dark", "light"])
            expect(existsSync(join(dir, `row-true-${n}-${scheme}.png`))).toBe(true);
      } finally {
        if (was === undefined) delete process.env.AKOU_UI_SHOTS;
        else process.env.AKOU_UI_SHOTS = was;
        t.cleanup();
      }
    },
    UI_TIMEOUT,
  );
});
