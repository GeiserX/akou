/**
 * The desktop build (docs/DESIGN.md sections 1.2 and 9): ElectroBun 2.0.1, pinned by the
 * `electrobun` dev dependency, which pairs it with Hutch 0.24.3, with the real Bun main process
 * (`build.mainProcess: "bun"`), because sherpa-onnx-node and the capture addon were measured to load
 * there and not in Cottontail's Workers. `scripts/build-app.ts` is the one way to build it.
 *
 * - The main process is `src/main/window/main.ts` (the app plus the tray, hotkey and window); the
 *   window's view is `src/ui/window.ts` with the same `index.html` and `theme.css` the browser
 *   loads.
 * - Hutch bundles the main process into `Resources/app/bun/index.js` and copies nothing else the
 *   app reads at run time, so everything it loads by path is listed in `build.copy`, beside that
 *   file (TRAPS "Native libraries missing from the bundle"):
 *   - sherpa-onnx-node and its platform package under `bun/node_modules`, where the app's
 *     `createRequire` finds them; the `.node` file links its two libraries through `@rpath` with an
 *     `@loader_path` rpath, so they sit beside it in the platform package;
 *   - the two recognition Workers and the browser pages, which `build-app.ts` builds first;
 *   - the shipped note templates;
 *   - the capture helper from `native/akou-capture`.
 *   Built pieces are listed only once built; `build-app.ts` builds them and the smoke check proves
 *   each is in the bundle.
 * - Hutch writes `Info.plist` from a fixed table without `NSAudioCaptureUsageDescription`. The app
 *   that runs is the inner bundle the stable wrapper extracts, so `postBuild` patches the inner
 *   plist before Hutch signs and packs it, and `postWrap` patches the wrapper's before Hutch signs
 *   it (TRAPS "Info.plist cannot carry the system-audio usage string").
 * - Hutch signs every Mach-O file in both bundles (the helper, the `.node` file and sherpa's
 *   libraries included), then each bundle, with the hardened runtime and the entitlements below,
 *   using the identity in `ELECTROBUN_DEVELOPER_ID`. `build-app.ts` sets it to `-`, an ad-hoc
 *   signature, when no Developer ID is given: v0.1 ships unsigned but sealed, so
 *   `codesign --verify --deep --strict` holds and macOS offers "Open Anyway" rather than calling
 *   the app damaged. Notarization needs a real Developer ID and Apple credentials; adding them as
 *   release secrets is the whole switch (docs/install.md, scripts/release-checklist.md).
 * - The bundle id is stable, so grants survive updates once the app is signed with a Developer ID
 *   (ad-hoc signed, each release may ask again: docs/install.md, "Permissions"); the capture helper
 *   excludes every process it is responsible for, the WebKit GPU helper that plays the window's
 *   audio included.
 * - No CEF: the system webview on every OS.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json" with { type: "json" };
import { BUNDLE_ID } from "./src/main/app-info.ts";

/** Where Hutch puts the bundled main process, and so everything it loads by path. */
export const MAIN_OUT = "bun";

/** The two libraries sherpa-onnx's addon links, per platform package (`otool -L`). */
export const SHERPA_LIBS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["libsherpa-onnx-c-api.dylib", "libonnxruntime.dylib"],
};

/** Where the build steps before Hutch leave their output (`scripts/build-app.ts`). */
export const BUILT = {
  ui: "dist/ui",
  workers: ["dist/workers/live-worker.js", "dist/workers/finalize-worker.js"],
} as const;

type Exists = (path: string) => boolean;

/**
 * Is a project file there? Hutch evaluates this config from a temporary folder, so a relative
 * path is resolved against the config's own place, never the working directory.
 */
const projectFileExists: Exists = (path) =>
  existsSync(fileURLToPath(new URL(path, import.meta.url)));

/** Where `cargo build --release` puts the capture helper. */
export function helperBuildPath(platform: string = process.platform): string {
  return `native/akou-capture/target/release/akou-capture${platform === "win32" ? ".exe" : ""}`;
}

/** The helper beside the main process, when it has been built. */
export function helperCopies(
  platform: string = process.platform,
  exists: Exists = projectFileExists,
): Record<string, string> {
  const src = helperBuildPath(platform);
  return exists(src) ? { [src]: `${MAIN_OUT}/${src.split("/").pop()}` } : {};
}

/** The Workers and the browser pages beside the main process, when they have been built. */
export function builtCopies(exists: Exists = projectFileExists): Record<string, string> {
  const out: Record<string, string> = {};
  if (exists(`${BUILT.ui}/index.js`)) out[BUILT.ui] = `${MAIN_OUT}/ui`;
  for (const w of BUILT.workers) {
    if (exists(w)) out[w] = `${MAIN_OUT}/${w.split("/").pop()}`;
  }
  return out;
}

/** sherpa-onnx-node and the platform package whose `.node` file and libraries it loads. */
export function sherpaCopies(platform: string, arch: string): Record<string, string> {
  const libs = SHERPA_LIBS[platform];
  if (!libs) return {};
  const pkgName = `sherpa-onnx-${platform === "win32" ? "win" : platform}-${arch}`;
  const out: Record<string, string> = {
    "node_modules/sherpa-onnx-node": `${MAIN_OUT}/node_modules/sherpa-onnx-node`,
  };
  for (const f of ["package.json", "sherpa-onnx.node", ...libs]) {
    out[`node_modules/${pkgName}/${f}`] = `${MAIN_OUT}/node_modules/${pkgName}/${f}`;
  }
  return out;
}

/**
 * Signing needs an identity (`-` is ad-hoc); notarization needs a real Developer ID and Apple
 * credentials.
 */
export function signing(env: Record<string, string | undefined> = process.env): {
  codesign: boolean;
  notarize: boolean;
} {
  const id = env.ELECTROBUN_DEVELOPER_ID ?? "";
  const codesign = id !== "";
  const apple =
    (!!env.ELECTROBUN_APPLEAPIKEY && !!env.ELECTROBUN_APPLEAPIISSUER) ||
    (!!env.ELECTROBUN_APPLEID && !!env.ELECTROBUN_APPLEIDPASS && !!env.ELECTROBUN_TEAMID);
  return { codesign, notarize: codesign && id !== "-" && apple };
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
      "src/main/notes/templates": `${MAIN_OUT}/templates`,
      ...sherpaCopies(process.platform, process.arch),
      ...builtCopies(),
      ...helperCopies(),
    },
    mac: {
      ...signing(),
      bundleCEF: false,
      defaultRenderer: "native",
      entitlements: { "com.apple.security.device.audio-input": true },
    },
    win: { bundleCEF: false, defaultRenderer: "native" },
    linux: { bundleCEF: false, defaultRenderer: "native" },
  },
  // A tray app: closing the window never quits it.
  runtime: { exitOnLastWindowClosed: false },
  scripts: { postBuild: "./scripts/post-build.ts", postWrap: "./scripts/post-wrap.ts" },
} satisfies ElectrobunConfig;
