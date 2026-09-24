/**
 * Builds the macOS app, unsigned, into `dist/release/` (docs/DESIGN.md section 9, docs/install.md):
 *
 *   bun scripts/build-app.ts [--allow-missing-helper]
 *
 * 1. Every version string equals `package.json`'s (`stamp-version.ts`).
 * 2. The capture helper is built from `native/akou-capture` with `cargo build --locked --release`.
 *    Without that folder the build stops: an app without its helper cannot record.
 *    `--allow-missing-helper` builds anyway, for checking the rest of the bundle before the helper
 *    is merged; the smoke check still reports the helper missing.
 * 3. The browser pages (`dist/ui`) and the two recognition Workers (`dist/workers`), which the
 *    ElectroBun bundler does not produce, are built with Bun's.
 * 4. ElectroBun builds the stable app with the Hutch release its npm package pairs with it, checked
 *    against `PINS` before and after. Proxy variables are removed for Hutch (TRAPS "Hutch cannot
 *    fetch behind a proxy"). The `postBuild` and `postWrap` hooks patch both `Info.plist` files;
 *    Hutch then signs both bundles with `ELECTROBUN_DEVELOPER_ID`, which is `-` (ad-hoc) unless a
 *    Developer ID is given, and notarizes only with a real one and Apple credentials.
 * 5. The DMG Hutch makes (the app and an Applications link) and a zip of the same app are copied
 *    to `dist/release/akou-<version>-macos-arm64.{dmg,zip}`.
 *
 * Nothing here opens the app. `scripts/smoke-app.ts` checks what was built.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILT } from "../electrobun.config.ts";
import pkg from "../package.json" with { type: "json" };
import { writeUi } from "../src/main/window/bundle.ts";
import { drift, sourceVersion } from "./stamp-version.ts";

/** The toolchain the release is built with (DESIGN 9, ROADMAP M0). */
export const PINS = {
  /** The `electrobun` npm package, which pins the runtime and pairs the Hutch release. */
  electrobun: "2.0.1",
  /** The Hutch release ElectroBun 2.0.1's npm bootstrap pairs with it (`PAIRED_HUTCH_VERSION`). */
  hutch: "0.24.3",
  /** The Bun ElectroBun 2.0.1 bundles as the app's runtime (`Resources/build.json`). */
  appBun: "1.4.0",
} as const;

/**
 * The oldest macOS the app runs on (DESIGN section 9, "Targets": the process tap the helper records
 * the call with, tested from 14.4). `patch-plist.sh` writes it as `LSMinimumSystemVersion`, so an older Mac refuses
 * the app with its own dialog instead of opening it and failing at the first recording.
 */
export const MIN_MACOS = "14.4";

export const ROOT = join(import.meta.dir, "..");
export const PLATFORM = "macos-arm64";
export const WRAPPER_APP = join(ROOT, "build", `stable-${PLATFORM}`, "akou.app");
export const HUTCH_DMG = join(ROOT, "artifacts", `${PLATFORM}-akou.dmg`);
export const RELEASE_DIR = join(ROOT, "dist", "release");

export function releaseName(version: string): string {
  return `akou-${version}-${PLATFORM}`;
}

/** `PAIRED_HUTCH_VERSION` in the installed `electrobun` npm bootstrap, or null. */
export function pairedHutch(root: string = ROOT): string | null {
  const file = join(root, "node_modules", "electrobun", "bin", "resolve-hutch.cjs");
  if (!existsSync(file)) return null;
  return /const PAIRED_HUTCH_VERSION = "([^"]+)";/.exec(readFileSync(file, "utf8"))?.[1] ?? null;
}

/** The Hutch release the bootstrap cached and ran, from its `hutch-release.json`, or null. */
export function cachedHutch(env: Record<string, string | undefined> = process.env): string | null {
  const home = env.HUTCH_HOME ?? env.DASH_HOME ?? join(homedir(), ".hutch");
  const file = join(home, "npm", "electrobun", PINS.electrobun, PLATFORM, "hutch-release.json");
  if (!existsSync(file)) return null;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The environment Hutch runs in: no proxy variables, no update check, and an ad-hoc signing
 * identity unless a Developer ID is given.
 */
export function hutchEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^(https?|all)_proxy$/i.test(k)) continue;
    out[k] = v;
  }
  out.HUTCH_NO_UPDATE_CHECK = "1";
  if (!out.ELECTROBUN_DEVELOPER_ID) out.ELECTROBUN_DEVELOPER_ID = "-";
  return out;
}

function fail(msg: string): never {
  console.error(`build-app: ${msg}`);
  process.exit(1);
}

function run(cmd: string[], env: Record<string, string | undefined> = process.env): void {
  console.log(`build-app: $ ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0] as string, cmd.slice(1), {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv,
    stdio: "inherit",
  });
  if (r.status !== 0) fail(`${cmd[0]} exited ${r.status ?? r.signal}`);
}

async function main(argv: string[]): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail(
      `the app is built on macOS arm64 only (ElectroBun cannot cross-compile); this is ${process.platform}-${process.arch}`,
    );
  }
  const allowMissingHelper = argv.includes("--allow-missing-helper");
  const version = sourceVersion(ROOT);

  // 1. One version.
  const drifted = drift(ROOT, version);
  if (drifted.length > 0) {
    fail(
      `version drift: ${drifted.map((d) => `${d.file} says ${d.version}`).join("; ")}; run bun scripts/stamp-version.ts`,
    );
  }

  // The toolchain pins, before anything is fetched.
  if (pkg.devDependencies.electrobun !== PINS.electrobun) {
    fail(
      `package.json pins electrobun ${pkg.devDependencies.electrobun}, the release pins ${PINS.electrobun}`,
    );
  }
  const paired = pairedHutch();
  if (paired !== PINS.hutch) {
    fail(
      `the electrobun bootstrap pairs Hutch ${paired ?? "(not installed: run bun install)"}, the release pins ${PINS.hutch}`,
    );
  }

  // 2. The capture helper.
  const manifest = join(ROOT, "native", "akou-capture", "Cargo.toml");
  if (existsSync(manifest)) {
    run(["cargo", "build", "--locked", "--release", "--manifest-path", manifest]);
  } else if (allowMissingHelper) {
    console.warn("build-app: native/akou-capture is absent; building WITHOUT the capture helper");
  } else {
    fail(
      "native/akou-capture is not in this tree, so there is no capture helper to ship. Merge the helper first, or pass --allow-missing-helper to check the rest of the bundle",
    );
  }

  // 3. The pieces Hutch's bundler does not make.
  rmSync(join(ROOT, "dist", "ui"), { recursive: true, force: true });
  await writeUi(join(ROOT, BUILT.ui));
  for (const out of BUILT.workers) {
    const name = out.split("/").pop()?.replace(/\.js$/, "") as string;
    const r = await Bun.build({
      entrypoints: [join(ROOT, "src", "main", "asr", `${name}.ts`)],
      target: "bun",
      format: "esm",
      // Loaded at run time from the bundle's own node_modules, beside the Workers.
      external: ["sherpa-onnx-node"],
    });
    if (!r.success || !r.outputs[0]) fail(`the ${name} bundle failed: ${r.logs.join("; ")}`);
    await Bun.write(join(ROOT, out), r.outputs[0]);
  }

  // 4. ElectroBun, through the paired Hutch.
  rmSync(join(ROOT, "build"), { recursive: true, force: true });
  rmSync(join(ROOT, "artifacts"), { recursive: true, force: true });
  run(
    [
      process.execPath,
      join(ROOT, "node_modules", "electrobun", "bin", "electrobun.cjs"),
      "build",
      "--env=stable",
    ],
    hutchEnv(process.env),
  );
  const ran = cachedHutch();
  if (ran !== PINS.hutch)
    fail(`the build ran Hutch ${ran ?? "(unknown)"}, the release pins ${PINS.hutch}`);
  if (!existsSync(WRAPPER_APP)) fail(`no app at ${WRAPPER_APP}`);
  if (!existsSync(HUTCH_DMG)) fail(`no DMG at ${HUTCH_DMG}`);

  // 5. The release files.
  mkdirSync(RELEASE_DIR, { recursive: true });
  const name = releaseName(version);
  copyFileSync(HUTCH_DMG, join(RELEASE_DIR, `${name}.dmg`));
  rmSync(join(RELEASE_DIR, `${name}.zip`), { force: true });
  run([
    "/usr/bin/ditto",
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    WRAPPER_APP,
    join(RELEASE_DIR, `${name}.zip`),
  ]);
  const id = hutchEnv(process.env).ELECTROBUN_DEVELOPER_ID;
  const signed = id === "-" ? "ad-hoc signed, not notarized" : `signed by ${id}`;
  console.log(
    `build-app: ${name}.dmg and ${name}.zip are in ${RELEASE_DIR} (Hutch ${ran}, ${signed})`,
  );
}

if (import.meta.main) await main(process.argv.slice(2));
