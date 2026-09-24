/**
 * The desktop build (docs/DESIGN.md sections 1.2 and 9): ElectroBun 2.0.1, pinned by the
 * `electrobun` dev dependency, with the real Bun main process (`build.mainProcess: "bun"`), because
 * sherpa-onnx-node and the capture addon were measured to load there and not in Cottontail's
 * Workers.
 *
 * - The main process is `src/main/window/main.ts` (the app plus the tray, hotkey and window); the
 *   window's view is `src/ui/window.ts` with the same `index.html` and `theme.css` the browser
 *   loads.
 * - Hutch copies sherpa-onnx's `.node` file but not the two libraries it loads, so both are listed
 *   in `build.copy`, beside the bundled main process where the addon looks for them: the addon
 *   links both through `@rpath` with an `@loader_path` rpath (TRAPS "Native libraries missing from
 *   the bundle"). Nothing on this branch builds the bundle yet: the ROADMAP M0 gate is what must
 *   prove the place with a load test in the packaged app.
 * - Hutch writes `Info.plist` from a fixed table without `NSAudioCaptureUsageDescription`, so the
 *   `postWrap` hook patches both usage strings in before the bundle is signed (TRAPS "Info.plist
 *   cannot carry the system-audio usage string"; the same M0 gate checks it with `plutil -p`).
 * - The bundle id is stable, so grants survive updates; the capture helper excludes every process
 *   it is responsible for, the WebKit GPU helper that plays the window's audio included.
 * - No CEF: the system webview on every OS.
 */

import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };
import { BUNDLE_ID } from "./src/main/app-info.ts";

/** Where Hutch puts the bundled main process, and so sherpa's `.node` file. */
export const MAIN_OUT = "bun";

/** The two libraries sherpa-onnx's addon links, per platform package (`otool -L`). */
export const SHERPA_LIBS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["libsherpa-onnx-c-api.dylib", "libonnxruntime.dylib"],
};

export function sherpaCopies(platform: string, arch: string): Record<string, string> {
  const pkgName = `sherpa-onnx-${platform === "win32" ? "win" : platform}-${arch}`;
  const out: Record<string, string> = {};
  for (const lib of SHERPA_LIBS[platform] ?? []) {
    out[`node_modules/${pkgName}/${lib}`] = `${MAIN_OUT}/${lib}`;
  }
  return out;
}

export default {
  app: {
    name: "akou",
    identifier: BUNDLE_ID,
    version: pkg.version,
    description: "Record your calls locally, see them live, and question them while they run.",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/main/window/main.ts" },
    views: { main: { entrypoint: "src/ui/window.ts", format: "esm" } },
    copy: {
      "src/ui/index.html": "views/main/index.html",
      "src/ui/theme.css": "views/main/theme.css",
      ...sherpaCopies(process.platform, process.arch),
    },
    mac: {
      codesign: true,
      notarize: true,
      bundleCEF: false,
      defaultRenderer: "native",
      entitlements: { "com.apple.security.device.audio-input": true },
    },
    win: { bundleCEF: false, defaultRenderer: "native" },
    linux: { bundleCEF: false, defaultRenderer: "native" },
  },
  // A tray app: closing the window never quits it.
  runtime: { exitOnLastWindowClosed: false },
  scripts: { postWrap: "./scripts/post-wrap.ts" },
} satisfies ElectrobunConfig;
