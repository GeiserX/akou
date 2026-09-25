/**
 * One version, from `package.json`, in every place that carries one (docs/DESIGN.md section 9, TRAPS
 * T0.30 "Version drift across artifacts"):
 *
 * - `src/main/app-info.ts`: `APP_VERSION`, which the app, `akou --version`, the MCP server and the
 *   API report.
 * - `skills/akou/SKILL.md` and `skills/akou-vocab/SKILL.md`: `metadata.version`, which `akou skill
 *   install` requires to equal the app's.
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
 *
 * A stable version (1.0.0 or later, no prerelease part) also needs its evidence on record
 * (docs/CI-CD.md CI-28), and `--check` fails without it: the newest row of the terms table in
 * docs/providers.md is dated after the previous stable tag, and every M0 gate G1 to G8 has a Pass
 * verdict in the summary table of docs/gates/M0-results.md. Prereleases never wait on a gate.
 * `tests/release-evidence.test.ts` holds the positive control.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

/** 1.0.0 or later with no prerelease part: a release that must carry its evidence (CI-28). */
export function isStable(version: string): boolean {
  const m = SEMVER.exec(version);
  return m !== null && Number(m[1]) >= 1 && !/^[^+]*-/.test(version);
}

/** -1, 0 or 1 by major, minor and patch; build metadata and prerelease parts are ignored. */
function compareCore(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
  const pb = b.split(/[-+]/)[0]?.split(".").map(Number) ?? [];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The rows of the first Markdown table after `head` in `md`, as trimmed cells; null if none. */
function tableAfter(md: string, head: RegExp): string[][] | null {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => head.test(l));
  if (at === -1) return null;
  const rows: string[][] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.trim().startsWith("|")) break;
    const cells = l
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

/**
 * What is missing from the terms check in docs/providers.md: the newest dated row of its table
 * must be later than `previousStableDate` (YYYY-MM-DD), or exist at all for a first stable release.
 */
export function termsProblems(providersMd: string, previousStableDate: string | null): string[] {
  const where = "docs/providers.md";
  const rows = tableAfter(providersMd, /^\|\s*Date checked\s*\|/);
  if (rows === null) return [`${where}: no terms table (| Date checked | ...)`];
  const dates = rows
    .map((r) => r[0] ?? "")
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const newest = dates.at(-1);
  if (!newest)
    return [
      `${where}: the terms table has no dated row; read the current terms and add one (YYYY-MM-DD)`,
    ];
  if (previousStableDate !== null && newest <= previousStableDate)
    return [
      `${where}: the newest terms check is dated ${newest}, not after the previous stable release (${previousStableDate}); read the current terms and add a dated row`,
    ];
  return [];
}

/** Every M0 gate from G1 to G8 without a Pass verdict in the summary table of M0-results.md. */
export function gateProblems(m0Md: string): string[] {
  const where = "docs/gates/M0-results.md";
  const summary = m0Md.split(/^## Summary\s*$/m)[1]?.split(/^## /m)[0];
  const rows = summary === undefined ? null : tableAfter(summary, /^\|\s*Gate\s*\|\s*Verdict\s*\|/);
  if (rows === null)
    return [`${where}: no summary table (## Summary, then | Gate | Verdict | ...)`];
  const verdicts = new Map<string, string>();
  for (const r of rows) {
    const id = /^(G\d+)\b/.exec(r[0] ?? "")?.[1];
    if (id) verdicts.set(id, r[1] ?? "");
  }
  const out: string[] = [];
  for (let g = 1; g <= 8; g++) {
    const id = `G${g}`;
    const v = verdicts.get(id);
    if (v === undefined) out.push(`${where}: ${id} has no row in the summary table`);
    else if (v.split(/\s/)[0] !== "Pass") out.push(`${where}: ${id} is ${v}, not Pass`);
  }
  return out;
}

/**
 * The newest stable tag below `version` in the git repository at `root`, with its date. Throws
 * when `root` is not the top of a git checkout or is a shallow clone, so a missing history never
 * reads as "no release".
 */
export function previousStable(
  root: string,
  version: string,
): { tag: string; date: string } | null {
  const git = (args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root))
    throw new Error(`cannot list the tags: ${root} is not the top of a git checkout`);
  // A shallow clone holds none of the older tags, so "no stable tag" would be a guess.
  if (git(["rev-parse", "--is-shallow-repository"]).stdout.trim() !== "false")
    throw new Error(
      `cannot list the tags: ${root} is a shallow clone (git fetch --unshallow --tags)`,
    );
  const r = git(["tag", "--list", "v*", "--format=%(refname:short) %(creatordate:short)"]);
  if (r.status !== 0) throw new Error(`cannot list the tags: ${r.stderr.trim()}`);
  let best: { tag: string; date: string; v: string } | null = null;
  for (const line of r.stdout.split("\n")) {
    const [tag, date] = line.trim().split(" ");
    if (!tag || !date) continue;
    const v = tag.replace(/^v/, "");
    if (!SEMVER.test(v) || !isStable(v) || compareCore(v, version) >= 0) continue;
    if (!best || compareCore(v, best.v) > 0) best = { tag, date, v };
  }
  return best && { tag: best.tag, date: best.date };
}

/** What a stable `version` still lacks before it may be released (CI-28); empty for a prerelease. */
export function evidenceProblems(root: string, version: string): string[] {
  if (!isStable(version)) return [];
  const read = (f: string) =>
    existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : "";
  const out: string[] = [];
  let prev: { tag: string; date: string } | null = null;
  try {
    prev = previousStable(root, version);
  } catch (err) {
    // Reported, and the rest is still checked, so one run lists everything that is missing.
    out.push(`${(err as Error).message}; a stable release needs the tag history`);
  }
  out.push(...termsProblems(read("docs/providers.md"), prev?.date ?? null));
  out.push(...gateProblems(read("docs/gates/M0-results.md")));
  return out;
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
    for (const p of evidenceProblems(root, version)) {
      console.error(`stamp-version: ${version} is a stable release: ${p}`);
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
