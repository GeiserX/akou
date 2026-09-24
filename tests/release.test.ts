/**
 * The release's own checks (docs/DESIGN.md section 9): one version everywhere (TRAPS T0.30), the
 * toolchain pins the build scripts assert, and the pieces of the bundle layout that need no build.
 * Nothing here builds or opens the app; the release workflow does the build and its smoke checks.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import config, {
  builtCopies,
  helperBuildPath,
  helperCopies,
  MAIN_OUT,
  signing,
} from "../electrobun.config.ts";
import pkg from "../package.json" with { type: "json" };
import { hutchEnv, PINS, pairedHutch } from "../scripts/build-app.ts";
import { atLeast, hostTarget, MIN_BUN } from "../scripts/build-cli.ts";
import { drift, main, readAll, stamp, tagVersion } from "../scripts/stamp-version.ts";
import { APP_VERSION } from "../src/main/app-info.ts";
import { siblingModule } from "../src/main/asr/sibling.ts";
import { HELPER_NAME } from "../src/main/capture/helper.ts";
import { defaultLaunch, isCompiled } from "../src/main/cli/client.ts";
import { skillSourceDir } from "../src/main/cli/commands/skill.ts";
import { prebuiltUi } from "../src/main/window/bundle.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");

/** A copy of the files that carry a version, plus a helper crate like PR #6's. */
function repoCopy(): { dir: string; cleanup(): void } {
  const t = tempDir();
  for (const f of [
    "package.json",
    "src/main/app-info.ts",
    "skills/akou/SKILL.md",
    "skills/akou-vocab/SKILL.md",
  ]) {
    mkdirSync(join(t.dir, f, ".."), { recursive: true });
    cpSync(join(ROOT, f), join(t.dir, f));
  }
  mkdirSync(join(t.dir, "native", "akou-capture"), { recursive: true });
  writeFileSync(
    join(t.dir, "native", "akou-capture", "Cargo.toml"),
    `[package]\nname = "akou-capture"\nversion = "${pkg.version}"\nedition = "2024"\n\n[dependencies]\nogg = { version = "0.9" }\n`,
  );
  writeFileSync(
    join(t.dir, "native", "akou-capture", "Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "akou-capture"\nversion = "${pkg.version}"\ndependencies = [\n "ogg",\n]\n\n[[package]]\nname = "ogg"\nversion = "0.9.2"\n`,
  );
  return t;
}

const quiet = <T>(fn: () => T): T => {
  const [log, err] = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
};

describe("one version everywhere", () => {
  test("[T0.30] Version drift across artifacts: every place in the repository says package.json's version", () => {
    expect(drift(ROOT, pkg.version)).toEqual([]);
    expect(APP_VERSION).toBe(pkg.version);
    // The places that must exist on main are all found (the helper's join once its crate is here).
    const files = readAll(ROOT).map((f) => f.file);
    expect(files).toEqual(
      expect.arrayContaining([
        "package.json",
        "src/main/app-info.ts",
        "skills/akou/SKILL.md",
        "skills/akou-vocab/SKILL.md",
      ]),
    );
  });

  test("[T0.30] positive control: a drifted place is reported and --check exits 1; stamping repairs it", () => {
    const t = repoCopy();
    expect(drift(t.dir, pkg.version)).toEqual([]);
    const info = join(t.dir, "src", "main", "app-info.ts");
    writeFileSync(
      info,
      readFileSync(info, "utf8").replace(`APP_VERSION = "${pkg.version}"`, 'APP_VERSION = "9.9.9"'),
    );
    const lock = join(t.dir, "native", "akou-capture", "Cargo.lock");
    writeFileSync(
      lock,
      readFileSync(lock, "utf8").replace(
        `name = "akou-capture"\nversion = "${pkg.version}"`,
        'name = "akou-capture"\nversion = "9.9.8"',
      ),
    );
    expect(drift(t.dir, pkg.version)).toEqual([
      { file: "src/main/app-info.ts", version: "9.9.9" },
      { file: "native/akou-capture/Cargo.lock", version: "9.9.8" },
    ]);
    expect(quiet(() => main(["--check", "--root", t.dir]))).toBe(1);
    expect(stamp(t.dir, pkg.version).sort()).toEqual([
      "native/akou-capture/Cargo.lock",
      "src/main/app-info.ts",
    ]);
    expect(quiet(() => main(["--check", "--root", t.dir]))).toBe(0);
    // A dependency's version in the lock is never touched.
    expect(readFileSync(lock, "utf8")).toContain('name = "ogg"\nversion = "0.9.2"');
    t.cleanup();
  });

  test("[T0.30] --set moves every place, and the tag must equal package.json", () => {
    const t = repoCopy();
    expect(quiet(() => main(["--set", "0.1.0", "--root", t.dir]))).toBe(0);
    expect(readAll(t.dir).every((f) => f.version === "0.1.0")).toBe(true);
    expect(readAll(t.dir)).toHaveLength(6);
    expect(quiet(() => main(["--check", "--tag", "v0.1.0", "--root", t.dir]))).toBe(0);
    expect(quiet(() => main(["--check", "--tag", "v0.1.1", "--root", t.dir]))).toBe(1);
    expect(tagVersion("refs/tags/v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    expect(() => tagVersion("release-1")).toThrow();
    expect(() => stamp(t.dir, "1.2")).toThrow();
    t.cleanup();
  });
});

describe("the toolchain pins", () => {
  test("[spike] Hutch and ElectroBun version pairing: the installed bootstrap pairs the pinned Hutch", () => {
    expect(pkg.devDependencies.electrobun).toBe(PINS.electrobun);
    expect(pairedHutch()).toBe(PINS.hutch);
    // Positive control: a tree without the bootstrap has no pairing to trust.
    const t = tempDir();
    expect(pairedHutch(t.dir)).toBeNull();
    t.cleanup();
  });

  test("[spike] Compiled Bun binary killed on launch: the CLI build refuses Bun before 1.4.2", () => {
    expect(atLeast("1.4.2", MIN_BUN)).toBe(true);
    expect(atLeast("1.5.0", MIN_BUN)).toBe(true);
    expect(atLeast("1.4.1", MIN_BUN)).toBe(false);
    expect(atLeast("1.4.0", MIN_BUN)).toBe(false);
    expect(atLeast("1.3.12", MIN_BUN)).toBe(false);
    expect(atLeast("1.4.2-canary.1", MIN_BUN)).toBe(false);
    expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTarget("win32", "x64")).toBe("windows-x64");
    expect(hostTarget("darwin", "x64")).toBeNull();
  });

  test("[spike] Hutch cannot fetch behind a proxy: Hutch runs with no proxy variables and signs ad-hoc by default", () => {
    const env = hutchEnv({
      HTTPS_PROXY: "http://p:1",
      http_proxy: "http://p:1",
      ALL_PROXY: "x",
      PATH: "/bin",
    });
    expect(env).toEqual({ PATH: "/bin", HUTCH_NO_UPDATE_CHECK: "1", ELECTROBUN_DEVELOPER_ID: "-" });
    expect(
      hutchEnv({ ELECTROBUN_DEVELOPER_ID: "Developer ID Application: X (T)" })
        .ELECTROBUN_DEVELOPER_ID,
    ).toBe("Developer ID Application: X (T)");
  });
});

describe("signing is a seam, not a code change", () => {
  test("ad-hoc signs and never notarizes; a Developer ID with Apple credentials notarizes", () => {
    expect(signing({})).toEqual({ codesign: false, notarize: false });
    expect(
      signing({
        ELECTROBUN_DEVELOPER_ID: "-",
        ELECTROBUN_APPLEAPIKEY: "k",
        ELECTROBUN_APPLEAPIISSUER: "i",
      }),
    ).toEqual({
      codesign: true,
      notarize: false,
    });
    expect(signing({ ELECTROBUN_DEVELOPER_ID: "Developer ID Application: X (T)" })).toEqual({
      codesign: true,
      notarize: false,
    });
    expect(
      signing({
        ELECTROBUN_DEVELOPER_ID: "Developer ID Application: X (T)",
        ELECTROBUN_APPLEAPIKEY: "k",
        ELECTROBUN_APPLEAPIISSUER: "i",
      }),
    ).toEqual({ codesign: true, notarize: true });
  });
});

describe("what the bundle carries beside the main process", () => {
  test("the helper and the built pieces are copied once built, and only then", () => {
    const none = () => false;
    const all = () => true;
    expect(helperCopies("darwin", none)).toEqual({});
    expect(helperCopies("darwin", all)).toEqual({
      "native/akou-capture/target/release/akou-capture": `${MAIN_OUT}/akou-capture`,
      "native/akou-diarize/target/release/akou-diarize": `${MAIN_OUT}/akou-diarize`,
    });
    expect(helperCopies("win32", all)).toEqual({
      "native/akou-capture/target/release/akou-capture.exe": `${MAIN_OUT}/akou-capture.exe`,
      "native/akou-diarize/target/release/akou-diarize.exe": `${MAIN_OUT}/akou-diarize.exe`,
    });
    // Each helper is copied once it is built, whatever the other's state.
    expect(helperCopies("darwin", (p) => p.includes("akou-diarize"))).toEqual({
      "native/akou-diarize/target/release/akou-diarize": `${MAIN_OUT}/akou-diarize`,
    });
    expect(builtCopies(none)).toEqual({});
    expect(builtCopies(all)).toEqual({
      "dist/ui": `${MAIN_OUT}/ui`,
      "dist/workers/live-worker.js": `${MAIN_OUT}/live-worker.js`,
      "dist/workers/finalize-worker.js": `${MAIN_OUT}/finalize-worker.js`,
    });
    expect(config.build?.copy?.["src/main/notes/templates"]).toBe(`${MAIN_OUT}/templates`);
    expect(config.scripts?.postBuild).toBe("./scripts/post-build.ts");
  });

  test("the app finds the helper beside its bundled main module, not beside its runtime", async () => {
    // The release bundles the resolver into Resources/app/bun/index.js, copies the helper into the
    // same folder (helperCopies) and runs it with Contents/MacOS/bun. Bundle it the same way, run
    // it with a Bun that lives elsewhere, and ask it where the helper is.
    const t = tempDir();
    const entry = join(t.dir, "entry.ts");
    writeFileSync(
      entry,
      `import { locateHelper } from ${JSON.stringify(join(ROOT, "src/main/capture/helper.ts"))};
console.log(JSON.stringify(locateHelper([])));`,
    );
    const out = join(t.dir, MAIN_OUT);
    const built = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm" });
    expect(built.success).toBe(true);
    await Bun.write(join(out, "index.js"), built.outputs[0] as Blob);
    const where = () =>
      JSON.parse(Bun.spawnSync([process.execPath, join(out, "index.js")]).stdout.toString());

    expect(where()).toEqual({ command: [HELPER_NAME], source: "path" });
    const target = helperCopies(process.platform, () => true)[helperBuildPath()] as string;
    writeFileSync(join(t.dir, target), "");
    // Bun reports the module's folder resolved (macOS /var is /private/var; a Windows 8.3 short name
    // such as RUNNER~1 is spelled out), so compare the files, not the spellings.
    const found = where() as { command: string[]; source: string };
    expect(found.source).toBe("bundled");
    expect(found.command).toHaveLength(1);
    expect(realpathSync.native(found.command[0] as string)).toBe(
      realpathSync.native(join(out, HELPER_NAME)),
    );
    t.cleanup();
  });

  test("a Worker is its .ts file from source and the bundled .js file when packaged", () => {
    const t = tempDir();
    const base = pathToFileURL(join(t.dir, "index.js")).href;
    writeFileSync(join(t.dir, "live-worker.js"), "");
    expect(fileURLToPath(siblingModule(base, "live-worker"))).toBe(join(t.dir, "live-worker.js"));
    writeFileSync(join(t.dir, "live-worker.ts"), "");
    expect(fileURLToPath(siblingModule(base, "live-worker"))).toBe(join(t.dir, "live-worker.ts"));
    t.cleanup();
  });

  test("the packaged app serves the prebuilt pages; without all five it builds from source", () => {
    const t = tempDir();
    expect(prebuiltUi(t.dir)).toBeNull();
    for (const f of ["index.html", "index.js", "theme.css", "share.html", "share.js"]) {
      writeFileSync(join(t.dir, f), f);
    }
    const ui = prebuiltUi(t.dir);
    expect(ui?.get("/index.js")).toEqual({
      type: "text/javascript; charset=utf-8",
      body: "index.js",
    });
    expect(ui?.size).toBe(5);
    t.cleanup();
  });

  test("[T3.0] the skill ships inside the program: with no skills folder the built-in copy installs", () => {
    const t = tempDir();
    const src = skillSourceDir(join(t.dir, "nowhere"));
    expect(src).not.toBe(join(t.dir, "nowhere"));
    expect(readFileSync(join(src, "SKILL.md"), "utf8")).toBe(
      readFileSync(join(ROOT, "skills", "akou", "SKILL.md"), "utf8"),
    );
    expect(skillSourceDir(join(ROOT, "skills", "akou"))).toBe(join(ROOT, "skills", "akou"));
    t.cleanup();
  });
});

describe("the compiled CLI starts the installed app, never itself", () => {
  test("from source it runs Bun on the entry; compiled on macOS it opens akou.app through LaunchServices", () => {
    expect(isCompiled("/$bunfs/root")).toBe(true);
    expect(isCompiled("B:\\~BUN\\root")).toBe(true);
    expect(isCompiled("/Users/x/akou/src/main/cli")).toBe(false);
    expect(defaultLaunch({ dir: "/repo/src/main/cli", execPath: "/bin/bun" })).toEqual([
      "/bin/bun",
      join("/repo/src/main/cli", "..", "index.ts"),
    ]);
    const compiled = { dir: "/$bunfs/root", home: "/Users/x" };
    // The per-user app path is joined with this platform's separator; only macOS ever uses it.
    const userApp = join("/Users/x", "Applications", "akou.app");
    expect(
      defaultLaunch({ ...compiled, platform: "darwin", exists: (p) => p === userApp }),
    ).toEqual(["/usr/bin/open", "-g", "-j", "-a", userApp, "--env", "AKOU_HEADLESS=1"]);
    expect(defaultLaunch({ ...compiled, platform: "darwin", exists: () => false })).toBeNull();
    expect(defaultLaunch({ ...compiled, platform: "linux", exists: () => true })).toBeNull();
  });
});

describe("the unsigned first open", () => {
  test("the release notes give the first-open step per macOS version, as install.md does", () => {
    const notes = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const install = readFileSync(join(ROOT, "docs", "install.md"), "utf8");
    // Control-click Open no longer gets past Gatekeeper from macOS 15: only Open Anyway does.
    for (const doc of [notes, install]) {
      expect(doc).toMatch(/On macOS 14, Control-click akou in Applications, choose Open/);
      expect(doc).toMatch(/On macOS 15 and later,[^\n]*Privacy & Security[^\n]*Open Anyway/);
    }
  });
});
