/**
 * Renders the macOS app icon (`assets/brand/akou-app-icon.svg`) into the iconset Hutch turns into
 * `AppIcon.icns` with `iconutil` (`build.mac.icons` in `electrobun.config.ts`):
 *
 *   bun scripts/app-icon.ts
 *
 * The ten PNGs are the sizes `iconutil` expects, drawn by the Chromium headless shell the UI tests
 * already use. A browser's rasterizer differs a little between builds, so the files are committed
 * and a test checks their names and pixel sizes, not their bytes. Run this after changing the SVG.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
export const ICON_SVG = join(ROOT, "assets", "brand", "akou-app-icon.svg");
export const ICONSET = join(ROOT, "assets", "brand", "akou.iconset");

/** Every file `iconutil` reads from an iconset, with its pixel size. */
export const ICONSET_FILES: Readonly<Record<string, number>> = Object.fromEntries(
  [16, 32, 128, 256, 512].flatMap((pt) => [
    [`icon_${pt}x${pt}.png`, pt],
    [`icon_${pt}x${pt}@2x.png`, pt * 2],
  ]),
);

if (import.meta.main) {
  mkdirSync(ICONSET, { recursive: true });
  const svg = readFileSync(ICON_SVG).toString("base64");
  // Loaded here, not at the top: the tests import this file for the iconset list only.
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, px] of Object.entries(ICONSET_FILES)) {
      const page = await browser.newPage({ viewport: { width: px, height: px } });
      await page.setContent(
        `<body style="margin:0"><img src="data:image/svg+xml;base64,${svg}" width="${px}" height="${px}" style="display:block"></body>`,
      );
      await page.screenshot({ path: join(ICONSET, name), omitBackground: true });
      await page.close();
      console.log(`${name}: ${px} px`);
    }
  } finally {
    await browser.close();
  }
}
