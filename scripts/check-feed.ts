/**
 * The update feed the app's updater reads (docs/CI-CD.md CI-23): `stable-macos-arm64-update.json`
 * and the bundle it names, at `release.baseUrl` in electrobun.config.ts.
 *
 *   bun scripts/check-feed.ts --dir dist/release   the files the build made, before they are published
 *   bun scripts/check-feed.ts --url                the published feed, fetched as the updater fetches it
 *
 * Either way it exits 1 unless the manifest is this app's, on the stable macOS arm64 channel, at
 * package.json's version, and the bundle it names is there.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_FEED } from "../electrobun.config.ts";
import { BUNDLE_ID } from "../src/main/app-info.ts";
import { sourceVersion } from "./stamp-version.ts";

/** ElectroBun's platform prefix for the stable channel on macOS arm64. */
export const FEED_PREFIX = "stable-macos-arm64";
/** The file `Updater.checkForUpdate()` fetches from `release.baseUrl`. */
export const MANIFEST = `${FEED_PREFIX}-update.json`;

/** What is wrong with an update manifest for `version`; empty when the updater would accept it. */
export function manifestProblems(doc: unknown, version: string): string[] {
  if (typeof doc !== "object" || doc === null) return ["the manifest is not a JSON object"];
  const m = doc as Record<string, unknown>;
  const want: Record<string, unknown> = {
    schemaVersion: 1,
    identifier: BUNDLE_ID,
    channel: "stable",
    platform: "macos",
    arch: "arm64",
    version,
  };
  const out = Object.entries(want)
    .filter(([k, v]) => m[k] !== v)
    .map(([k, v]) => `${k} is ${JSON.stringify(m[k])}, expected ${JSON.stringify(v)}`);
  if (typeof m.hash !== "string" || m.hash === "") out.push("hash is missing");
  const file = bundleName(doc) ?? "";
  if (!/^stable-macos-arm64-[^/\\]+\.tar\.zst$/.test(file))
    out.push(`artifact.file is ${JSON.stringify(file)}, expected ${FEED_PREFIX}-<name>.tar.zst`);
  return out;
}

/** The bundle file a manifest names, or null. */
export function bundleName(doc: unknown): string | null {
  const file = (doc as { artifact?: { file?: unknown } } | null)?.artifact?.file;
  return typeof file === "string" ? file : null;
}

/** The feed as the build left it in `dir`. */
export function checkDir(dir: string, version: string): string[] {
  const path = join(dir, MANIFEST);
  if (!existsSync(path))
    return [`no ${MANIFEST} in ${dir} (it holds ${readdirSync(dir).join(", ") || "nothing"})`];
  const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
  const out = manifestProblems(doc, version);
  const file = bundleName(doc);
  if (file && !existsSync(join(dir, file))) out.push(`the bundle ${file} is not in ${dir}`);
  return out;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The published feed at `base`, fetched the way the updater fetches it: the manifest with a
 * random query, then the first byte of the bundle it names.
 */
export async function checkUrl(
  base: string,
  version: string,
  get: Fetch = fetch,
): Promise<string[]> {
  const url = `${base}/${MANIFEST}?${randomBytes(8).toString("hex")}`;
  const r = await get(url);
  if (!r.ok) return [`GET ${url}: HTTP ${r.status}`];
  let doc: unknown;
  try {
    doc = await r.json();
  } catch {
    return [`${url} is not JSON`];
  }
  const out = manifestProblems(doc, version);
  const file = bundleName(doc);
  if (out.length > 0 || !file) return out;
  const bundle = `${base}/${encodeURIComponent(file)}?cache=${randomBytes(8).toString("hex")}`;
  const b = await get(bundle, { headers: { range: "bytes=0-0" } });
  await b.body?.cancel();
  if (!b.ok) out.push(`GET ${bundle}: HTTP ${b.status}`);
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const version = sourceVersion(join(import.meta.dir, ".."));
  let problems: string[];
  if (argv[0] === "--dir" && argv[1]) {
    problems = checkDir(argv[1], version);
  } else if (argv[0] === "--url") {
    const base = argv[1] ?? UPDATE_FEED;
    // A replaced release asset can take a few seconds to be served.
    for (let attempt = 1; ; attempt++) {
      problems = await checkUrl(base, version);
      if (problems.length === 0 || attempt === 6) break;
      console.log(`check-feed: not yet (${problems.join("; ")}), retrying in 10 s`);
      await Bun.sleep(10_000);
    }
  } else {
    console.error("usage: bun scripts/check-feed.ts --dir <folder> | --url [base]");
    return 64;
  }
  for (const p of problems) console.error(`check-feed: ${p}`);
  if (problems.length === 0) console.log(`check-feed: the feed offers ${version}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
