/**
 * One version, from `package.json`, in every place that carries one (docs/DESIGN.md section 9, TRAPS
 * T0.30 "Version drift across artifacts"):
 *
 * - `src/main/app-info.ts`: `APP_VERSION`, which the app, `akou --version`, the MCP server and the
 *   API report.
 * - `skills/akou/SKILL.md` and `skills/akou-vocab/SKILL.md`: `metadata.version`, which `akou skill
 *   install` requires to equal the app's.
 * - `.claude-plugin/plugin.json`: the Claude Code plugin's version (PG-K2), which Claude Code
 *   compares to decide whether an installed plugin is out of date.
 * - `native/akou-capture/Cargo.toml` and `Cargo.lock`: the helper's version, reported by
 *   `akou-capture --version` and in its `hello` packet. Skipped while `native/` is absent.
 * - `native/akou-diarize/Cargo.toml` and `Cargo.lock`: the diarization helper's version, reported
 *   by `akou-diarize --version` and in its `ready` line.
 * - `electrobun.config.ts` reads `package.json` itself, so the bundle's `Info.plist`
 *   (`CFBundleVersion`) and `version.json` follow; `--plist` checks a built one.
 *
 *   bun scripts/stamp-version.ts                   write package.json's version everywhere
 *   bun scripts/stamp-version.ts --set 0.1.0       set package.json first, then write everywhere
 *   bun scripts/stamp-version.ts --check           exit 1 if any place differs from package.json
 *   bun scripts/stamp-version.ts --check --tag v0.1.0   and exit 1 unless package.json is 0.1.0
 *   bun scripts/stamp-version.ts --plist PATH...   exit 1 unless each Info.plist's CFBundleVersion matches
 *
 * The release workflow runs `--check --tag "$GITHUB_REF_NAME"` first and `--plist` on the built
 * bundle; `tests/release.test.ts` fails when any place drifts.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** One place a version lives: how to read it and how to write it. */
interface Place {
  file: string;
  /** Skip this place when the file is absent (the helper before its crate is merged). */
  optional?: boolean;
  /** Group 2 is the version; groups 1 and 3 are kept around it when stamping. */
  pattern: RegExp;
}

export const PLACES: readonly Place[] = [
  {
    file: "package.json",
    pattern: /^(\s*"version":\s*")([^"]*)(",?)$/m,
  },
  {
    file: "src/main/app-info.ts",
    pattern: /^(export const APP_VERSION = ")([^"]*)(";)$/m,
  },
  {
    file: "skills/akou/SKILL.md",
    pattern: /^(\s+version:\s*")([^"]*)(")$/m,
  },
  {
    file: "skills/akou-vocab/SKILL.md",
    pattern: /^(\s+version:\s*")([^"]*)(")$/m,
  },
  {
    file: ".claude-plugin/plugin.json",
    pattern: /^(\s*"version":\s*")([^"]*)(",?)$/m,
  },
  {
    file: "native/akou-capture/Cargo.toml",
    optional: true,
    pattern: /^(\[package\][\s\S]*?\nversion = ")([^"]*)(")$/m,
  },
  {
    file: "native/akou-capture/Cargo.lock",
    optional: true,
    pattern: /^(name = "akou-capture"\nversion = ")([^"]*)(")$/m,
  },
  {
    file: "native/akou-diarize/Cargo.toml",
    optional: true,
    pattern: /^(\[package\][\s\S]*?\nversion = ")([^"]*)(")$/m,
  },
  {
    file: "native/akou-diarize/Cargo.lock",
    optional: true,
    pattern: /^(name = "akou-diarize"\nversion = ")([^"]*)(")$/m,
  },
];

export interface Found {
  file: string;
  version: string | null;
}

/** The version `package.json` declares. */
export function sourceVersion(root: string): string {
  const v = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string })
    .version;
  if (!v || !SEMVER.test(v)) throw new Error(`package.json has no valid version: ${v}`);
  return v;
}

/** What every present place says; null where the pattern is not found. */
export function readAll(root: string): Found[] {
  const out: Found[] = [];
  for (const p of PLACES) {
    const path = join(root, p.file);
    if (!existsSync(path)) {
      if (p.optional) continue;
      out.push({ file: p.file, version: null });
      continue;
    }
    const m = p.pattern.exec(readFileSync(path, "utf8"));
    out.push({ file: p.file, version: m ? (m[2] as string) : null });
  }
  return out;
}

/** Every place that does not say `expected`. */
export function drift(root: string, expected: string): Found[] {
  return readAll(root).filter((f) => f.version !== expected);
}

/** Writes `version` into every present place. Throws if a pattern is missing. */
export function stamp(root: string, version: string): string[] {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version}`);
  const changed: string[] = [];
  for (const p of PLACES) {
    const path = join(root, p.file);
    if (!existsSync(path)) {
      if (p.optional) continue;
      throw new Error(`${p.file} is missing`);
    }
    const text = readFileSync(path, "utf8");
    if (!p.pattern.test(text)) throw new Error(`${p.file}: no version found where expected`);
    const next = text.replace(
      p.pattern,
      (_all, a: string, _v: string, b: string) => a + version + b,
    );
    if (next !== text) {
      writeFileSync(path, next);
      changed.push(p.file);
    }
  }
  return changed;
}

/** `v0.1.0` or `0.1.0` to `0.1.0`; throws on anything else. */
export function tagVersion(tag: string): string {
  const v = tag.replace(/^refs\/tags\//, "").replace(/^v/, "");
  if (!SEMVER.test(v)) throw new Error(`the tag ${tag} is not v<semver>`);
  return v;
}

/** `CFBundleVersion` of a built `Info.plist` (macOS only: plutil). */
export function plistVersion(plist: string): string | null {
  const r = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleVersion", "raw", plist]);
  return r.status === 0 ? r.stdout.toString().trim() : null;
}

export function main(argv: string[]): number {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  // `--root` is for the tests' copies of the repository.
  const root = flag("--root") ?? join(import.meta.dir, "..");
  const set = flag("--set");
  if (set) {
    stamp(root, set);
  }
  const version = sourceVersion(root);
  if (argv.includes("--plist")) {
    const plists = argv.slice(argv.indexOf("--plist") + 1).filter((a) => !a.startsWith("--"));
    let bad = 0;
    for (const p of plists) {
      const v = plistVersion(p);
      if (v !== version) {
        console.error(`stamp-version: ${p} says CFBundleVersion ${v}, package.json ${version}`);
        bad++;
      }
    }
    if (plists.length === 0) {
      console.error("stamp-version: --plist needs at least one path");
      return 64;
    }
    if (bad === 0) console.log(`stamp-version: ${plists.length} Info.plist file(s) say ${version}`);
    return bad === 0 ? 0 : 1;
  }
  if (argv.includes("--check")) {
    const tag = flag("--tag");
    let bad = 0;
    if (tag) {
      const want = tagVersion(tag);
      if (want !== version) {
        console.error(`stamp-version: the tag ${tag} is ${want} but package.json is ${version}`);
        bad++;
      }
    }
    for (const d of drift(root, version)) {
      console.error(
        `stamp-version: ${d.file} says ${d.version ?? "(none)"}, package.json ${version}`,
      );
      bad++;
    }
    if (bad === 0) {
      const n = readAll(root).length;
      console.log(`stamp-version: ${n} places say ${version}${tag ? `, as the tag ${tag}` : ""}`);
    }
    return bad === 0 ? 0 : 1;
  }
  const changed = stamp(root, version);
  console.log(
    changed.length > 0
      ? `stamp-version: wrote ${version} into ${changed.join(", ")}`
      : `stamp-version: every place already says ${version}`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
