/**
 * The release's own checks (docs/DESIGN.md section 9): one version everywhere (TRAPS T0.30), the
 * toolchain pins the build scripts assert, and the pieces of the bundle layout that need no build.
 * Nothing here builds or opens the app; the release workflow does the build and its smoke checks.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import config, {
  builtCopies,
  helperBuildPath,
  helperCopies,
  MAIN_OUT,
  signing,
  UPDATE_FEED,
} from "../electrobun.config.ts";
import pkg from "../package.json" with { type: "json" };
import {
  DESKTOP_PLATFORMS,
  diarizeSteps,
  hutchEnv,
  PINS,
  pairedHutch,
  releaseName,
} from "../scripts/build-app.ts";
import {
  atLeast,
  CLI_ENTITLEMENTS,
  cliSignArgs,
  developerId,
  helperSignArgs,
  hostTarget,
  MIN_BUN,
} from "../scripts/build-cli.ts";
import { main as bumpCask, dmgName, dmgSum, renderCask } from "../scripts/bump-cask.ts";
import { checkDir, checkUrl, MANIFEST, manifestProblems } from "../scripts/check-feed.ts";
import { look, verdict } from "../scripts/ci/tested-commit.ts";
import {
  changelogSection,
  drift,
  main,
  readAll,
  releaseNotes,
  stamp,
  tagVersion,
} from "../scripts/stamp-version.ts";
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
    ".claude-plugin/plugin.json",
    "docs/api/openapi.json",
    "examples/compose/telegram-archive/.env.example",
    "README.md",
    "docs/server.md",
    "docs/server-hardware.md",
  ]) {
    mkdirSync(join(t.dir, f, ".."), { recursive: true });
    cpSync(join(ROOT, f), join(t.dir, f));
  }
  // The tests below also release a 0.1.0, which needs its changelog section (CI-20).
  writeFileSync(
    join(t.dir, "CHANGELOG.md"),
    `${readFileSync(join(ROOT, "CHANGELOG.md"), "utf8")}\n## 0.1.0\n\n- a change\n`,
  );
  mkdirSync(join(t.dir, "native", "akou-capture"), { recursive: true });
  writeFileSync(
    join(t.dir, "native", "akou-capture", "Cargo.toml"),
    `[package]\nname = "akou-capture"\nversion = "${pkg.version}"\nedition = "2024"\n\n[dependencies]\nogg = { version = "0.9" }\n`,
  );
  writeFileSync(
    join(t.dir, "native", "akou-capture", "Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "akou-capture"\nversion = "${pkg.version}"\ndependencies = [\n "ogg",\n]\n\n[[package]]\nname = "ogg"\nversion = "0.9.2"\n`,
  );
  // A stable version also needs its evidence (CI-28), which tests/release-evidence.test.ts covers.
  // Here it is on record, so these tests see drift and the changelog alone: a dated terms row,
  // every gate a plain Pass, and a git repository with no tag, which reads as the first stable
  // release.
  writeFileSync(
    join(t.dir, "docs", "providers.md"),
    "| Date checked | Anthropic | OpenAI | Change made |\n|---|---|---|---|\n| 2026-10-10 | ok | ok | none |\n",
  );
  mkdirSync(join(t.dir, "docs", "gates"), { recursive: true });
  writeFileSync(
    join(t.dir, "docs", "gates", "M0-results.md"),
    `## Summary\n\n| Gate | Verdict |\n|---|---|\n${[1, 2, 3, 4, 5, 6, 7, 8].map((g) => `| G${g} | Pass |`).join("\n")}\n`,
  );
  // The user's git settings never reach this scratch repository (as in release-evidence.test.ts).
  const empty = join(t.dir, "empty.gitconfig");
  writeFileSync(empty, "");
  const init = Bun.spawnSync(["git", "-C", t.dir, "init", "-q"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (init.exitCode !== 0) throw new Error(`git init: ${init.stderr.toString()}`);
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
        ".claude-plugin/plugin.json",
        "docs/api/openapi.json",
        "README.md",
        "docs/server.md",
        "docs/server-hardware.md",
      ]),
    );
  });

  test("[T0.30] positive control: a stale image tag or clone line after the first in a doc is drift; stamping repairs every one", () => {
    const t = repoCopy();
    try {
      const server = join(t.dir, "docs", "server.md");
      const original = readFileSync(server, "utf8");
      const tag = `drumsergio/akou:${pkg.version}`;
      // The first tag stays current; a later one and the clone line go stale.
      const first = original.indexOf(tag);
      expect(first).toBeGreaterThan(-1);
      const later = original.indexOf(tag, first + tag.length);
      expect(later).toBeGreaterThan(-1);
      const stale = `${original.slice(0, later)}drumsergio/akou:1.0.0${original.slice(later + tag.length)}`;
      writeFileSync(server, stale.replace(`--branch v${pkg.version}`, "--branch v1.0.1"));
      const hardware = join(t.dir, "docs", "server-hardware.md");
      const hw = readFileSync(hardware, "utf8");
      writeFileSync(hardware, hw.replace(`akou:${pkg.version}-cuda`, "akou:1.0.2-cuda"));
      const readme = join(t.dir, "README.md");
      const rd = readFileSync(readme, "utf8");
      writeFileSync(readme, rd.replace(`akou-${pkg.version}-macos`, "akou-1.0.3-macos"));
      expect(drift(t.dir, pkg.version)).toEqual([
        { file: "README.md", version: "1.0.3" },
        { file: "docs/server.md", version: `${pkg.version}, 1.0.0, 1.0.1` },
        { file: "docs/server-hardware.md", version: `${pkg.version}, 1.0.2` },
      ]);
      expect(quiet(() => main(["--check", "--root", t.dir]))).toBe(1);
      expect(stamp(t.dir, pkg.version)).toEqual([
        "README.md",
        "docs/server.md",
        "docs/server-hardware.md",
      ]);
      // Every occurrence is back, the -vulkan and -cuda suffixes kept, nothing else changed.
      expect(readFileSync(server, "utf8")).toBe(original);
      expect(readFileSync(hardware, "utf8")).toBe(hw);
      expect(readFileSync(readme, "utf8")).toBe(rd);
      expect(quiet(() => main(["--check", "--root", t.dir]))).toBe(0);
    } finally {
      t.cleanup();
    }
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

  test("[PG-K2] the plugin's version is the app's: a drifted plugin.json is reported, stamping repairs it", () => {
    const t = repoCopy();
    const manifest = join(t.dir, ".claude-plugin", "plugin.json");
    const original = readFileSync(manifest, "utf8");
    writeFileSync(manifest, original.replace(`"version": "${pkg.version}"`, '"version": "9.9.7"'));
    expect(drift(t.dir, pkg.version)).toEqual([
      { file: ".claude-plugin/plugin.json", version: "9.9.7" },
    ]);
    expect(quiet(() => main(["--check", "--root", t.dir]))).toBe(1);
    expect(stamp(t.dir, pkg.version)).toEqual([".claude-plugin/plugin.json"]);
    // Stamping changes the version and nothing else in the manifest.
    expect(readFileSync(manifest, "utf8")).toBe(original);
    t.cleanup();
  });

  test("[T0.30] --set moves every place, and the tag must equal package.json", () => {
    const t = repoCopy();
    expect(quiet(() => main(["--set", "0.1.0", "--root", t.dir]))).toBe(0);
    expect(readAll(t.dir).every((f) => f.version === "0.1.0")).toBe(true);
    expect(readAll(t.dir)).toHaveLength(12);
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
    const env = hutchEnv(
      {
        HTTPS_PROXY: "http://p:1",
        http_proxy: "http://p:1",
        ALL_PROXY: "x",
        PATH: "/bin",
      },
      "darwin",
    );
    expect(env).toEqual({ PATH: "/bin", HUTCH_NO_UPDATE_CHECK: "1", ELECTROBUN_DEVELOPER_ID: "-" });
    // On Windows, Windows' own tar before Git's, whatever the variable's case.
    expect(hutchEnv({ Path: "C:\\Git\\usr\\bin", SystemRoot: "C:\\Windows" }, "win32").Path).toBe(
      "C:\\Windows\\System32;C:\\Git\\usr\\bin",
    );
    expect(hutchEnv({ PATH: "/bin" }, "linux").PATH).toBe("/bin");
    expect(
      hutchEnv({ ELECTROBUN_DEVELOPER_ID: "Developer ID Application: X (T)" })
        .ELECTROBUN_DEVELOPER_ID,
    ).toBe("Developer ID Application: X (T)");
  });
});

describe("[SV-P8] a CLI for every machine the server runs on", () => {
  test("linux-arm64 is released beside darwin-arm64, linux-x64 and windows-x64", () => {
    expect(hostTarget("linux", "arm64")).toBe("linux-arm64");
    expect(hostTarget("linux", "x64")).toBe("linux-x64");
    expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTarget("win32", "x64")).toBe("windows-x64");
    // Positive control: a machine with no release still gets none.
    expect(hostTarget("linux", "ia32")).toBeNull();
  });

  test("the release builds the Linux CLIs on their own runners, arm64 included", () => {
    const wf = Bun.YAML.parse(
      readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
    ) as { jobs: Record<string, { strategy?: { matrix?: { os?: string[] } } }> };
    const os = wf.jobs.cli?.strategy?.matrix?.os ?? [];
    expect(os).toContain("ubuntu-24.04-arm");
    expect(os).toContain("ubuntu-24.04");
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

describe("signing secrets never reach a pull request", () => {
  /**
   * Every line of the workflow that reads a secret and is not gated on a tag push or on any event
   * but a pull request (a dispatch by hand: only someone with write access can start one).
   */
  function ungatedSecretReads(workflow: string): string[] {
    return workflow
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.includes("secrets.") && !line.startsWith("#"))
      .filter(
        ({ line }) =>
          !line.includes("github.event_name == 'push' &&") &&
          !line.includes("github.event_name != 'pull_request' &&"),
      )
      .map(({ line, n }) => `${n}: ${line}`);
  }

  test("a pull request's dry run never loads a signing secret; a pushed tag or a dispatch does", () => {
    // The dry run on a pull request runs the branch's own build scripts, so a secret in its
    // environment is a secret those scripts can read. GitHub withholds secrets from forks, not from
    // branches of this repository.
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(workflow).toContain("pull_request:");
    expect(ungatedSecretReads(workflow)).toEqual([]);
    // Positive control: an ungated read is reported.
    const ungated = `      X: $${"{{"} secrets.MACOS_CERTIFICATE_P12 }}`;
    expect(ungatedSecretReads(ungated)).toHaveLength(1);
    expect(
      ungatedSecretReads(ungated.replace("secrets.", "github.event_name == 'push' && secrets.")),
    ).toEqual([]);
    expect(
      ungatedSecretReads(
        ungated.replace("secrets.", "github.event_name != 'pull_request' && secrets."),
      ),
    ).toEqual([]);
    // The wrong way round lets a pull request in.
    expect(
      ungatedSecretReads(
        ungated.replace("secrets.", "github.event_name == 'pull_request' && secrets."),
      ),
    ).toHaveLength(1);
  });

  test("a tag or a dispatch fails without a signing secret and checks what it signed", () => {
    const app = releaseWorkflow().jobs.app;
    const setup = app?.steps?.find((s) => s.run?.includes("security create-keychain"));
    expect(setup?.if).toBe("env.SIGN == 'true'");
    for (const name of [
      "MACOS_CERTIFICATE_P12",
      "MACOS_CERTIFICATE_PASSWORD",
      "ELECTROBUN_DEVELOPER_ID",
      "ELECTROBUN_TEAMID",
      "ELECTROBUN_APPLEID",
      "ELECTROBUN_APPLEIDPASS",
    ]) {
      expect(setup?.run).toContain(name);
    }
    expect(setup?.run).toContain("exit 1");
    const check = app?.steps?.find((s) => s.run?.includes("spctl --assess"));
    expect(check?.if).toBe("env.SIGN == 'true'");
    expect(check?.run).toContain("source=Notarized Developer ID");
    expect(check?.run).toContain("--check-notarization -R=notarized");
  });

  test("[#448] the akou-diarize archive is checked for the Developer ID and Apple's notarization", () => {
    // 1.3.0 and 1.3.1 shipped it ad-hoc signed and nothing failed: the check read the app and the
    // CLI only. The helper is checked from the archive a user downloads.
    const check = releaseWorkflow().jobs.app?.steps?.find((s) => s.run?.includes("spctl --assess"));
    const run = check?.run ?? "";
    expect(run).toContain(
      'tar -xzf dist/release/akou-diarize-*-darwin-arm64.tar.gz -C "$check/diarize"',
    );
    expect(run).toContain('notarized_bin "$check/diarize/akou-diarize"');
    // notarized_bin checks the team and the hardened runtime, then the notarization.
    const fn = /notarized_bin\(\) \{\n([\s\S]*?)\n\}/.exec(run)?.[1] ?? "";
    expect(fn).toContain('signed_by_team "$1"');
    expect(fn).toContain('codesign --verify --strict --check-notarization -R=notarized "$1"');
    expect(fn).toContain("exit 1");
  });
});

describe("the CLI's signature", () => {
  test("ad-hoc without a Developer ID; with one, the hardened runtime, a timestamp and Bun's JIT entitlements", () => {
    expect(developerId({})).toBeNull();
    expect(developerId({ ELECTROBUN_DEVELOPER_ID: "-" })).toBeNull();
    expect(cliSignArgs({})).toEqual(["-s", "-", "-f"]);
    expect(cliSignArgs({ ELECTROBUN_DEVELOPER_ID: "-" })).toEqual(["-s", "-", "-f"]);
    expect(cliSignArgs({ ELECTROBUN_DEVELOPER_ID: "ABC123" })).toEqual([
      "-s",
      "ABC123",
      "-f",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      CLI_ENTITLEMENTS,
    ]);
    const plist = readFileSync(CLI_ENTITLEMENTS, "utf8");
    expect(plist).toContain("<key>com.apple.security.cs.allow-jit</key>");
    expect(plist).toContain("<key>com.apple.security.cs.allow-unsigned-executable-memory</key>");
  });
});

describe("[#448] the akou-diarize archive's signature", () => {
  test("signed like the CLI before it is packed: with a Developer ID, the hardened runtime and a timestamp", () => {
    expect(helperSignArgs({})).toEqual(["-s", "-", "-f"]);
    expect(helperSignArgs({ ELECTROBUN_DEVELOPER_ID: "-" })).toEqual(["-s", "-", "-f"]);
    expect(helperSignArgs({ ELECTROBUN_DEVELOPER_ID: "ABC123" })).toEqual([
      "-s",
      "ABC123",
      "-f",
      "--options",
      "runtime",
      "--timestamp",
    ]);
    const bin = "/stage/akou-diarize";
    const steps = diarizeSteps(bin, "/out/akou-diarize-1.0.0-darwin-arm64.tar.gz", {
      ELECTROBUN_DEVELOPER_ID: "ABC123",
    });
    expect(steps.sign).toEqual([
      ["/usr/bin/codesign", "-s", "ABC123", "-f", "--options", "runtime", "--timestamp", bin],
      ["/usr/bin/codesign", "--verify", "--strict", bin],
    ]);
    // The archive packs the file that was signed, alone at its top, not cargo's build output.
    expect(steps.pack).toEqual([
      "tar",
      "-czf",
      "/out/akou-diarize-1.0.0-darwin-arm64.tar.gz",
      "-C",
      "/stage",
      "akou-diarize",
    ]);
    expect(diarizeSteps(bin, "/out/x.tar.gz", {}).sign[0]).toEqual([
      "/usr/bin/codesign",
      "-s",
      "-",
      "-f",
      bin,
    ]);
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
    expect(builtCopies(all, "darwin")).toEqual({
      "dist/ui": `${MAIN_OUT}/ui`,
      // The command line the akou menu links into PATH (DK-M6).
      "dist/app-cli/akou": `${MAIN_OUT}/akou`,
      "dist/workers/live-worker.js": `${MAIN_OUT}/live-worker.js`,
      "dist/workers/finalize-worker.js": `${MAIN_OUT}/finalize-worker.js`,
    });
    expect(builtCopies(all, "win32")).toEqual({
      "dist/ui": `${MAIN_OUT}/ui`,
      "dist/app-cli/akou.exe": `${MAIN_OUT}/akou.exe`,
      "dist/workers/live-worker.js": `${MAIN_OUT}/live-worker.js`,
      "dist/workers/finalize-worker.js": `${MAIN_OUT}/finalize-worker.js`,
    });
    expect(config.build?.copy?.["src/main/notes/templates"]).toBe(`${MAIN_OUT}/templates`);
    expect(config.build?.copy?.["src/main/notes/presets"]).toBe(`${MAIN_OUT}/presets`);
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

describe("the first open", () => {
  test("the release notes say the build is signed and notarized; getting-started.md keeps the step for older builds", () => {
    const notes = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const install = readFileSync(join(ROOT, "docs", "getting-started.md"), "utf8");
    expect(notes).toContain("**Signed and notarized.**");
    expect(notes).not.toContain("not signed by Apple");
    // Control-click Open no longer gets past Gatekeeper from macOS 15: only Open Anyway does.
    expect(install).toMatch(/On macOS 14, Control-click akou in Applications, choose Open/);
    expect(install).toMatch(/On macOS 15 and later,[^\n]*Privacy & Security[^\n]*Open Anyway/);
  });
});

/** The release workflow, parsed. */
function releaseWorkflow(): {
  jobs: Record<
    string,
    {
      needs?: string | string[];
      if?: string;
      environment?: string;
      permissions?: Record<string, string>;
      steps?: {
        name?: string;
        uses?: string;
        if?: string;
        run?: string;
        env?: Record<string, string>;
        with?: Record<string, string>;
      }[];
    }
  >;
} {
  return Bun.YAML.parse(
    readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
  ) as never;
}

describe("[CI-16] no release checkout leaves the job token for later steps", () => {
  // No job pushes through its checkout (bump-cask clones the tap with its own token), so a
  // persisted token would only be in reach of every script that runs after the checkout.
  const keepingToken = (wf: ReturnType<typeof releaseWorkflow>): string[] =>
    Object.entries(wf.jobs).flatMap(([name, job]) =>
      (job.steps ?? [])
        .filter((s) => s.uses?.startsWith("actions/checkout@"))
        .filter((s) => String(s.with?.["persist-credentials"]) !== "false")
        .map(() => name),
    );

  test("every checkout sets persist-credentials: false", () => {
    const wf = releaseWorkflow();
    const checkouts = Object.values(wf.jobs).flatMap((j) =>
      (j.steps ?? []).filter((s) => s.uses?.startsWith("actions/checkout@")),
    );
    expect(checkouts.length).toBeGreaterThanOrEqual(7);
    expect(keepingToken(wf)).toEqual([]);
  });

  test("positive control: a checkout without it is caught", () => {
    const wf = releaseWorkflow();
    const co = wf.jobs.release?.steps?.find((s) => s.uses?.startsWith("actions/checkout@"));
    delete co?.with?.["persist-credentials"];
    expect(keepingToken(wf)).toEqual(["release"]);
  });
});

describe("[WFS-1] a release secret is read only inside the release environment", () => {
  type Workflow = ReturnType<typeof releaseWorkflow>;
  /** The gate of every secret a job reads: `X` in `X && secrets.NAME`, "" when it has none. */
  const gatesOf = (job: Workflow["jobs"][string]): string[] =>
    [...JSON.stringify(job).matchAll(/\$\{\{\s*(?:([^}]*?)\s*&&\s*)?secrets\.(\w+)/g)]
      .filter((m) => m[2] !== "GITHUB_TOKEN")
      .map((m) => (m[1] ?? "").trim());
  /**
   * Every secret read that can happen outside the `release` environment: the job names no
   * environment, or names it behind another gate than the read's own. The environment is what
   * limits a secret to the refs its deployment policy allows; a gate in the workflow file holds
   * only for the file of the ref that runs.
   */
  const outsideRelease = (wf: Workflow): string[] =>
    Object.entries(wf.jobs).flatMap(([name, job]) =>
      gatesOf(job)
        .filter(
          (gate) =>
            job.environment !== "release" &&
            job.environment !== `$${"{{"} ${gate} && 'release' || '' }}`,
        )
        .map((gate) => `${name}: ${gate || "always"}`),
    );

  test("every job that reads a secret runs in the release environment whenever it can read it", () => {
    const wf = releaseWorkflow();
    // The check is not empty: these four jobs read the signing, Docker Hub and tap secrets.
    expect(
      Object.entries(wf.jobs)
        .filter(([, job]) => gatesOf(job).length > 0)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["app", "cask", "image", "image-manifest"]);
    expect(outsideRelease(wf)).toEqual([]);
    // A pull request's dry run builds unsigned and pushes nothing, so it never needs the
    // environment, whose policy would refuse a pull request's ref.
    expect(wf.jobs.app?.environment).toBe(
      `$${"{{"} github.event_name != 'pull_request' && 'release' || '' }}`,
    );
    expect(wf.jobs.image?.environment).toBe(
      `$${"{{"} github.event_name == 'push' && 'release' || '' }}`,
    );
  });

  test("positive control: a job without the environment, or behind a looser gate, is caught", () => {
    const wf = releaseWorkflow();
    const cask = wf.jobs.cask;
    if (cask) delete cask.environment;
    expect(outsideRelease(wf)).toEqual(["cask: github.event_name == 'push'"]);
    const app = releaseWorkflow();
    // The app reads its secrets on a dispatch too; an environment only on a push leaves that out.
    const job = app.jobs.app;
    if (job) job.environment = `$${"{{"} github.event_name == 'push' && 'release' || '' }}`;
    expect(outsideRelease(app).every((r) => r.startsWith("app: "))).toBe(true);
    expect(outsideRelease(app).length).toBeGreaterThan(0);
  });
});

describe("[WFS-2] the workflows keep no token, publish nothing from a cache, and are linted", () => {
  type Workflow = ReturnType<typeof releaseWorkflow>;
  const WORKFLOWS = join(ROOT, ".github", "workflows");
  const workflow = (file: string): Workflow =>
    Bun.YAML.parse(readFileSync(join(WORKFLOWS, file), "utf8")) as never;
  const files = (): string[] =>
    readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  /** Every checkout that leaves the job token in the checkout for the steps after it. */
  const keepingToken = (file: string, wf: Workflow): string[] =>
    Object.entries(wf.jobs).flatMap(([name, job]) =>
      (job.steps ?? [])
        .filter((s) => s.uses?.startsWith("actions/checkout@"))
        .filter((s) => String(s.with?.["persist-credentials"]) !== "false")
        .map(() => `${file}: ${name}`),
    );

  /** The release's own job, every job it needs, and every job that needs it: what is published. */
  const publishing = (wf: Workflow): Set<string> => {
    const out = new Set(["release"]);
    const visit = (name: string) => {
      for (const n of [wf.jobs[name]?.needs ?? []].flat()) {
        if (out.has(n)) continue;
        out.add(n);
        visit(n);
      }
    };
    visit("release");
    for (const [name, job] of Object.entries(wf.jobs))
      if ([job.needs ?? []].flat().includes("release")) out.add(name);
    return out;
  };

  /** Every cache a publishing job restores: actions/cache, or setup-bun's own unless no-cache. */
  const cachesInPublishing = (wf: Workflow): string[] =>
    [...publishing(wf)].flatMap((name) =>
      (wf.jobs[name]?.steps ?? [])
        .filter(
          (s) =>
            /^actions\/cache(\/restore)?@/.test(s.uses ?? "") ||
            (s.uses?.startsWith("oven-sh/setup-bun@") && String(s.with?.["no-cache"]) !== "true"),
        )
        .map((s) => `${name}: ${s.name ?? s.uses}`),
    );

  test("no checkout in any workflow keeps the token: none of them pushes through it", () => {
    expect(files().length).toBeGreaterThanOrEqual(7);
    expect(files().flatMap((f) => keepingToken(f, workflow(f)))).toEqual([]);
    // Positive control: a checkout that keeps it is caught.
    const ci = workflow("ci.yml");
    const co = ci.jobs.check?.steps?.find((s) => s.uses?.startsWith("actions/checkout@"));
    delete co?.with?.["persist-credentials"];
    expect(keepingToken("ci.yml", ci)).toEqual(["ci.yml: check"]);
  });

  test("a job whose build is published restores no cache; only the unpublished desktop build may", () => {
    const wf = releaseWorkflow();
    expect([...publishing(wf)].sort()).toEqual(
      ["app", "cask", "cli", "image", "image-manifest", "release", "version"].sort(),
    );
    expect(cachesInPublishing(wf)).toEqual([]);
    // Positive control: setup-bun's own cache, and an actions/cache step, in the release job.
    const steps = wf.jobs.release?.steps ?? [];
    const bun = steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun@"));
    delete bun?.with?.["no-cache"];
    steps.push({ name: "a cache", uses: "actions/cache@0000000000000000000000000000000000000000" });
    expect(cachesInPublishing(wf)).toEqual([
      "release: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
      "release: a cache",
    ]);
  });

  test("ci.yml lints every workflow with pinned actionlint, ShellCheck and zizmor, under ci-ok", () => {
    const ci = workflow("ci.yml");
    const job = ci.jobs.workflows;
    const run = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");
    // Each tool is a release binary checked against its SHA-256 before it runs.
    for (const tool of [
      "actionlint_1.7.12_",
      "shellcheck-v0.11.0",
      "zizmor/releases/download/v1.32.0",
    ])
      expect(run).toMatch(new RegExp(`${tool.replace(/[.]/g, "\\.")}\\S* [0-9a-f]{64}\\n`));
    expect(run).toContain("sha256sum -c -");
    expect(run).toContain('actionlint -color -shellcheck "$RUNNER_TEMP/workflow-lint/shellcheck"');
    expect(run).toContain("zizmor --offline --min-severity medium --config .github/zizmor.yml .");
    expect([ci.jobs["ci-ok"]?.needs].flat()).toContain("workflows");
    // An action referenced by a tag fails: every action, the official ones too, is hash-pinned.
    const config = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "zizmor.yml"), "utf8")) as {
      rules: { "unpinned-uses": { config: { policies: Record<string, string> } } };
    };
    expect(config.rules["unpinned-uses"].config.policies).toEqual({ "*": "hash-pin" });
  });
});

describe("[CI-19] a release publishes only a commit whose ci-ok is green", () => {
  const sha = "0".repeat(40);
  const run = (status: string, conclusion: string | null) => ({
    id: 1,
    status,
    conclusion,
    html_url: "https://example.invalid/run/1",
  });
  const job = (conclusion: string | null) => ({ name: "ci-ok", status: "completed", conclusion });

  test("green only when the newest CI run finished and its ci-ok passed", () => {
    expect(verdict(sha, run("completed", "success"), job("success"))).toEqual({ state: "green" });
    // Still running, including a rerun of the failed legs: wait for it.
    expect(verdict(sha, run("in_progress", null), null).state).toBe("wait");
    expect(verdict(sha, run("queued", null), job("failure")).state).toBe("wait");
  });

  test("positive control: a red, cancelled, missing or never-run ci-ok stops the release", () => {
    const red = verdict(sha, run("completed", "failure"), job("failure"));
    expect(red).toMatchObject({ state: "stop" });
    expect(red.state !== "green" && red.why).toContain("ci-ok is failure");
    expect(verdict(sha, run("completed", "cancelled"), job("cancelled")).state).toBe("stop");
    expect(verdict(sha, run("completed", "success"), null).state).toBe("stop");
    const never = verdict(sha, null, null);
    expect(never.state !== "green" && never.why).toContain("never ran");
  });

  test("the tag looks up ci-ok instead of running check again", () => {
    const version = releaseWorkflow().jobs.version;
    const runs = (version?.steps ?? []).map((s) => s.run ?? "");
    expect(runs.some((r) => r.includes("bun run check"))).toBe(false);
    const gate = version?.steps?.find((s) => s.run?.includes("scripts/ci/tested-commit.ts"));
    expect(gate?.if).toBe("github.ref_type == 'tag'");
    expect(gate?.run).toContain('"$SHA"');
    expect(version?.permissions).toEqual({ contents: "read", actions: "read" });
  });

  // A fake API that, like GitHub, ignores nothing it is not asked to filter: it returns every run
  // of the commit, so only the script's own query and pick decide which run counts.
  const fakeApi = (runs: object[]) => {
    const paths: string[] = [];
    const get = async <T>(path: string): Promise<T> => {
      paths.push(path);
      if (path.startsWith("actions/workflows/")) return { workflow_runs: runs } as T;
      return { jobs: [job("success")] } as T;
    };
    return { get, paths };
  };

  test("only a push run on main counts, never a pull request's run of the same commit", async () => {
    const pr = { ...run("completed", "success"), event: "pull_request", head_branch: "feature" };
    const { get, paths } = fakeApi([pr]);
    const v = await look(sha, get);
    expect(v.state).toBe("stop");
    expect(v.state !== "green" && v.why).toContain("as a push to main");
    expect(paths[0]).toContain("event=push");
    expect(paths[0]).toContain("branch=main");
  });

  test("positive control: the same green run, pushed to main, releases", async () => {
    const pushed = { ...run("completed", "success"), event: "push", head_branch: "main" };
    const pr = { ...run("completed", "failure"), event: "pull_request", head_branch: "main" };
    expect(await look(sha, fakeApi([pr, pushed]).get)).toEqual({ state: "green" });
  });

  test("a tag on a commit that is not on main stops before ci-ok is read", () => {
    const gate = releaseWorkflow().jobs.version?.steps?.find((s) =>
      s.run?.includes("scripts/ci/tested-commit.ts"),
    );
    const lines = (gate?.run ?? "").split("\n");
    const ancestor = lines.findIndex((l) =>
      l.includes('git merge-base --is-ancestor "$SHA" origin/main'),
    );
    expect(ancestor).toBeGreaterThanOrEqual(0);
    expect(lines[ancestor]).toContain("exit 1");
    expect(ancestor).toBeLessThan(lines.findIndex((l) => l.includes("tested-commit.ts")));
  });
});

describe("[CI-20] every release has a changelog section", () => {
  const md =
    "# Changelog\n\n## 0.2.0 — two\n\nSee [the docs](docs/a.md), [x](https://x.test/) and [y](#y).\n\n## 0.1.0\n\n- one\n";

  test("the section runs from its heading to the next version's", () => {
    expect(changelogSection(md, "0.2.0")).toBe(
      "## 0.2.0 — two\n\nSee [the docs](docs/a.md), [x](https://x.test/) and [y](#y).",
    );
    expect(changelogSection(md, "0.1.0")).toBe("## 0.1.0\n\n- one");
    // A prefix is not a match: 0.1 is not 0.1.0, and 0.1.0 is not 0.1.01.
    expect(changelogSection(md, "0.1")).toBeNull();
    expect(changelogSection(md.replace("## 0.1.0", "## 0.1.01"), "0.1.0")).toBeNull();
  });

  test("the notes point relative links at the tagged tree and leave the rest", () => {
    expect(releaseNotes(md, "0.2.0", "o/r")).toBe(
      "## 0.2.0 — two\n\nSee [the docs](https://github.com/o/r/blob/v0.2.0/docs/a.md), [x](https://x.test/) and [y](#y).",
    );
    expect(releaseNotes(md, "0.3.0", "o/r")).toBeNull();
  });

  test("this version has its section", () => {
    expect(
      changelogSection(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), pkg.version),
    ).not.toBeNull();
  });

  test("positive control: --check fails without the version's section, and --notes prints it", () => {
    const t = repoCopy();
    try {
      expect(quiet(() => main(["--check", "--root", t.dir]))).toBe(0);
      expect(quiet(() => main(["--notes", "--root", t.dir]))).toBe(0);
      expect(quiet(() => main(["--set", "0.1.1", "--root", t.dir]))).toBe(0);
      expect(quiet(() => main(["--check", "--root", t.dir]))).toBe(1);
      expect(quiet(() => main(["--notes", "--root", t.dir]))).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  test("the release notes start with the section the version job wrote", () => {
    const wf = releaseWorkflow();
    const write = wf.jobs.version?.steps?.find((s) => s.run?.includes("--notes"));
    expect(write?.run).toContain("> notes/changelog.md");
    const publish = wf.jobs.release?.steps?.find((s) => s.run?.includes("gh release create"));
    const body = publish?.run ?? "";
    expect(body).toMatch(/\{ cat \.\.\/notes\/changelog\.md; echo; \} > notes\.md\n/);
    expect(body.indexOf("> notes.md")).toBeLessThan(body.indexOf(">> notes.md"));
    expect(body).toContain("--generate-notes");
  });
});

describe("[CI-21] every release asset carries a build attestation", () => {
  test("the release job attests every file SHA256SUMS lists and verifies each before publishing", () => {
    const wf = releaseWorkflow();
    const steps = wf.jobs.release?.steps ?? [];
    const attest = steps.findIndex((s) => s.uses?.startsWith("actions/attest-build-provenance@"));
    const verify = steps.findIndex((s) => s.run?.includes("gh attestation verify"));
    const publish = steps.findIndex((s) => s.run?.includes("gh release create"));
    expect(steps[attest]?.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(steps[attest]?.with).toEqual({ "subject-checksums": "dist/SHA256SUMS" });
    expect(steps[verify]?.run).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(attest).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(attest);
    expect(publish).toBeGreaterThan(verify);
  });

  test("only the release job may mint an identity token or write attestations", () => {
    const wf = releaseWorkflow();
    expect(wf.jobs.release?.permissions).toEqual({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name === "release") continue;
      expect(job.permissions?.["id-token"]).toBeUndefined();
      expect(job.permissions?.attestations).toBeUndefined();
    }
  });
});

describe("[CI-23] releases publish the update feed the app reads", () => {
  const bundle = "stable-macos-arm64-akou.app.tar.zst";
  const manifest = (version: string, over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    identifier: "io.github.geiserx.akou",
    channel: "stable",
    version,
    hash: "abc123",
    platform: "macos",
    arch: "arm64",
    artifact: { file: bundle },
    ...over,
  });

  test("the app's updater reads the fixed update-feed release, which a prerelease can fill", () => {
    expect(UPDATE_FEED).toBe("https://github.com/GeiserX/akou/releases/download/update-feed");
    expect(config.release).toEqual({ baseUrl: UPDATE_FEED, generatePatch: false });
  });

  test("a manifest for this app, channel and version passes; positive control: any other fails", () => {
    expect(manifestProblems(manifest("0.6.0"), "0.6.0")).toEqual([]);
    expect(manifestProblems(manifest("0.5.4"), "0.6.0")).toEqual([
      'version is "0.5.4", expected "0.6.0"',
    ]);
    expect(manifestProblems(manifest("0.6.0", { identifier: "x" }), "0.6.0")).toHaveLength(1);
    expect(manifestProblems(manifest("0.6.0", { channel: "canary" }), "0.6.0")).toHaveLength(1);
    expect(
      manifestProblems(manifest("0.6.0", { artifact: { file: "akou.app.tar.zst" } }), "0.6.0"),
    ).toHaveLength(1);
    expect(manifestProblems(null, "0.6.0")).toHaveLength(1);
  });

  test("the build's feed folder needs the manifest and the bundle it names", () => {
    const t = tempDir();
    try {
      expect(checkDir(t.dir, "0.6.0")[0]).toContain(`no ${MANIFEST}`);
      writeFileSync(join(t.dir, MANIFEST), JSON.stringify(manifest("0.6.0")));
      expect(checkDir(t.dir, "0.6.0")).toEqual([`the bundle ${bundle} is not in ${t.dir}`]);
      writeFileSync(join(t.dir, bundle), "x");
      expect(checkDir(t.dir, "0.6.0")).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("the smoke test fetches the published manifest and the bundle's first byte, as the updater does", async () => {
    const base = "https://feed.invalid";
    const seen: string[] = [];
    const feed =
      (version: string, bundleStatus = 206) =>
      async (url: string, init?: RequestInit) => {
        seen.push(`${url.split("?")[0]} ${new Headers(init?.headers).get("range") ?? ""}`);
        if (url.startsWith(`${base}/${MANIFEST}?`)) return Response.json(manifest(version));
        if (url.startsWith(`${base}/${bundle}?cache=`))
          return new Response("x", { status: bundleStatus });
        return new Response("", { status: 404 });
      };
    expect(await checkUrl(base, "0.6.0", feed("0.6.0"))).toEqual([]);
    expect(seen).toEqual([`${base}/${MANIFEST} `, `${base}/${bundle} bytes=0-0`]);
    // Positive controls: a feed still on the previous version, a missing bundle, no feed at all.
    expect(await checkUrl(base, "0.6.0", feed("0.5.4"))).toEqual([
      'version is "0.5.4", expected "0.6.0"',
    ]);
    expect((await checkUrl(base, "0.6.0", feed("0.6.0", 404)))[0]).toContain("HTTP 404");
    expect((await checkUrl("https://none.invalid", "0.6.0", feed("0.6.0")))[0]).toContain(
      "HTTP 404",
    );
  });

  test("the release replaces the feed, bundle before manifest, then fetches it; the build checks it first", () => {
    const wf = releaseWorkflow();
    const app = (wf.jobs.app?.steps ?? []).map((s) => s.run ?? "");
    expect(app.findIndex((r) => r.includes("check-feed.ts --dir dist/release"))).toBeGreaterThan(
      app.findIndex((r) => r.includes("scripts/build-app.ts")),
    );
    const steps = wf.jobs.release?.steps ?? [];
    const versioned = steps.findIndex((s) => s.run?.includes('gh release create "$TAG"'));
    const feed = steps.findIndex((s) => s.run?.includes("gh release upload update-feed"));
    const smoke = steps.findIndex((s) => s.run === "bun scripts/check-feed.ts --url");
    expect(steps[versioned]?.run).toContain("-- akou-* stable-* SHA256SUMS");
    expect(feed).toBeGreaterThan(versioned);
    expect(smoke).toBeGreaterThan(feed);
    const upload = steps[feed]?.run ?? "";
    expect(upload).toContain("gh release create update-feed");
    expect(upload).toContain("--latest=false");
    expect(upload.indexOf("--clobber -- stable-*.tar.zst")).toBeGreaterThan(-1);
    expect(upload.indexOf("--clobber -- stable-*.tar.zst")).toBeLessThan(
      upload.indexOf("--clobber -- stable-*-update.json"),
    );
  });
});

/** The cask installs the macOS app, whatever OS runs these tests. */
const MACOS = DESKTOP_PLATFORMS["darwin-arm64"] as string;

describe("[CI-25] tags bump the Homebrew cask", () => {
  const sha = "a".repeat(64);
  const sums = `${"b".repeat(64)}  akou-cli-${pkg.version}-darwin-arm64.tar.gz\n${sha}  ${releaseName(pkg.version, MACOS)}.dmg\n`;

  /** A bare git repository standing in for the tap, with one commit on its branch. */
  function fakeTap(): {
    dir: string;
    tap: string;
    head(): string;
    cask(): string;
    cleanup(): void;
  } {
    const t = tempDir();
    const tap = join(t.dir, "tap.git");
    const run = (cwd: string, ...args: string[]) => {
      const r = Bun.spawnSync(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args],
        {
          cwd,
        },
      );
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    run(t.dir, "init", "--quiet", "--bare", tap);
    run(t.dir, "clone", "--quiet", tap, "seed");
    writeFileSync(join(t.dir, "seed", "README.md"), "tap\n");
    run(join(t.dir, "seed"), "add", "README.md");
    run(join(t.dir, "seed"), "commit", "--quiet", "-m", "seed");
    run(join(t.dir, "seed"), "push", "--quiet", "origin", "HEAD");
    writeFileSync(join(t.dir, "SHA256SUMS"), sums);
    return {
      dir: t.dir,
      tap,
      head: () => run(tap, "rev-parse", "HEAD"),
      cask: () => run(tap, "show", "HEAD:Casks/akou.rb"),
      cleanup: t.cleanup,
    };
  }

  test("the cask installs this version's DMG, checked by its SHA-256, on Apple silicon", () => {
    expect(dmgName(pkg.version)).toBe(`${releaseName(pkg.version, MACOS)}.dmg`);
    // The release name follows the platform asked for; the cask's DMG stays macOS's on any host,
    // a Windows runner included, where this machine's own release name is the Windows app's.
    expect(releaseName(pkg.version, DESKTOP_PLATFORMS["win32-x64"])).toBe(
      `akou-${pkg.version}-windows-x64`,
    );
    expect(dmgName(pkg.version)).not.toContain("windows");
    const cask = renderCask("1.2.3", sha);
    expect(cask).toContain('version "1.2.3"');
    expect(cask).toContain(`sha256 "${sha}"`);
    expect(cask).toContain(
      'url "https://github.com/GeiserX/akou/releases/download/v#{version}/akou-#{version}-macos-arm64.dmg"',
    );
    expect(cask).toContain("depends_on arch: :arm64");
    expect(cask).toContain('app "akou.app"');
  });

  test("the DMG's line is read from SHA256SUMS, and nothing else", () => {
    expect(dmgSum(sums, pkg.version)).toBe(sha);
    expect(dmgSum(`${sha} *${releaseName(pkg.version, MACOS)}.dmg`, pkg.version)).toBe(sha);
    expect(dmgSum(sums, "9.9.9")).toBeNull();
  });

  test("[T4.12] Homebrew tap push without a token: a dry-run bump without the secret fails loudly", () => {
    const t = fakeTap();
    try {
      const before = t.head();
      const sumsFile = join(t.dir, "SHA256SUMS");
      const args = ["--sums", sumsFile, "--tap", t.tap, "--dry-run"];
      const said: string[] = [];
      const err = console.error;
      console.error = (m: string) => said.push(m);
      try {
        expect(bumpCask(args, {})).toBe(1);
      } finally {
        console.error = err;
      }
      expect(said.join("\n")).toContain("::error::bump-cask: TAP_PUSH_TOKEN is not set");
      // Positive control: with the secret the same dry run passes, and pushes nothing.
      expect(quiet(() => bumpCask(args, { TAP_PUSH_TOKEN: "x" }))).toBe(0);
      expect(t.head()).toBe(before);
    } finally {
      t.cleanup();
    }
  });

  test("with TAP_PUSH_TOKEN set the bump lands in the tap, once", () => {
    const t = fakeTap();
    try {
      const args = ["--sums", join(t.dir, "SHA256SUMS"), "--tap", t.tap];
      expect(quiet(() => bumpCask(args, { TAP_PUSH_TOKEN: "x" }))).toBe(0);
      expect(t.cask()).toBe(renderCask(pkg.version, sha).trim());
      const bumped = t.head();
      // The same version again changes nothing.
      expect(quiet(() => bumpCask(args, { TAP_PUSH_TOKEN: "x" }))).toBe(0);
      expect(t.head()).toBe(bumped);
    } finally {
      t.cleanup();
    }
  });

  test("the bump runs after the release, from a tag push only, with the secret", () => {
    const cask = releaseWorkflow().jobs.cask;
    expect(cask?.needs).toBe("release");
    expect(cask?.if).toBe("github.ref_type == 'tag'");
    const step = cask?.steps?.find((s) => s.run?.includes("scripts/bump-cask.ts"));
    expect(step?.run).toContain("bun scripts/bump-cask.ts --sums SHA256SUMS");
    expect(step?.run).not.toContain("--dry-run");
    expect(step?.env?.TAP_PUSH_TOKEN).toBe(
      `$${"{{"} github.event_name == 'push' && secrets.TAP_PUSH_TOKEN || '' }}`,
    );
  });
});
