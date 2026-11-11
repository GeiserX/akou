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
