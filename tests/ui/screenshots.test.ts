/**
 * Screenshots for review (docs/TESTING.md TS-15c): with `AKOU_UI_SHOTS` set, a rig saves every page
 * its test left open in both themes as it closes. Never compared, so never a gate; this proves the
 * files are written, that each theme really took, and that the page is handed back to the system's.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";
import { screenshots, UI_TIMEOUT, uiRig } from "./rig.ts";

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
