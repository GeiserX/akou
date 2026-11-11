/**
 * Claims in the user docs that the code once outgrew (TRAPS [T1.39] "Docs drift from code"). Each
 * check reads the committed page and fails on the stale claim, with a positive control that runs
 * the same check over the old sentence.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

/**
 * The lines that give the first download as about 3.0 GB alone. A Mac with a GPU and 16 GB of
 * memory downloads streaming Nemotron and Qwen3-ASR, about 3.7 GB (src/main/asr/model-set.ts), so
 * a size for the first download names both.
 */
export function loneDownloadSize(md: string): string[] {
  return md.split("\n").filter((l) => /\b3\.0 GB\b/.test(l) && !/\b3\.7 GB\b/.test(l));
}

/** The user pages: README.md and the top level of docs/. */
function userPages(): string[] {
  const docs = readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`);
  // The server pulls one named preset (`models pull fast`), whose size is 3.0 GB alone.
  return ["README.md", ...docs.filter((f) => f !== "docs/server.md")];
}

describe("[T1.39] Docs drift from code: the first download", () => {
  test("every user page that sizes the first download names both 3.0 and 3.7 GB", () => {
    const stale = userPages().flatMap((f) => loneDownloadSize(read(f)).map((l) => `${f}: ${l}`));
    expect(stale).toEqual([]);
  });

  test("positive control: the old Parakeet-only size is caught", () => {
    expect(
      loneDownloadSize("The speech models are one download of about 3.0 GB, each file checked."),
    ).toHaveLength(1);
    expect(loneDownloadSize("about 3.0 to 3.7 GB, by what the Mac runs")).toEqual([]);
  });
});

/**
 * Whether the `auto` row of the dictation engine table names `dictation.final`. The app passes
 * `dictation.final` (default `live`) with every press, so `auto` follows it
 * (src/main/dictation/engines.ts), and never picks Qwen by the machine alone.
 */
export function autoRowFollowsFinal(md: string): boolean {
  const row = md.split("\n").find((l) => l.startsWith("| `auto` |"));
  return row !== undefined && row.includes("`dictation.final`") && row.includes("`live`");
}

describe("[T1.39] Docs drift from code: the dictation engine", () => {
  test("the dictation page says `auto` follows `dictation.final`, live by default", () => {
    expect(autoRowFollowsFinal(read("docs/dictation.md"))).toBe(true);
  });

  test("positive control: the old machine-based `auto` row is caught", () => {
    expect(
      autoRowFollowsFinal(
        "| `auto` | `best` where Qwen runs on a GPU and is downloaded, `fast` elsewhere. The default |",
      ),
    ).toBe(false);
  });
});

/**
 * The lines of a Security section that claim the desktop app listens on loopback alone. The app
 * can also listen on `network.bind` (`network.enabled`) and `share.bind` (a share link).
 */
export function loopbackOnlyClaims(md: string): string[] {
  const section = md.split(/^## Security\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const lines = section.split("\n").filter((l) => /127\.0\.0\.1 only/.test(l));
  return section.includes("`network.enabled`") && section.includes("share") ? lines : [section];
}

describe("[T1.39] Docs drift from code: what the desktop app listens on", () => {
  test("How it works names both opt-in listeners and never says 127.0.0.1 only", () => {
    expect(loopbackOnlyClaims(read("docs/how-it-works.md"))).toEqual([]);
  });

  test("positive control: the old loopback-only bullet is caught", () => {
    expect(
      loopbackOnlyClaims(
        "## Security\n\n- The desktop app listens on 127.0.0.1 only. Every request needs the token.\n",
      ),
    ).not.toEqual([]);
  });
});
