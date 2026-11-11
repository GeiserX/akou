/**
 * Claims in the user docs that the code once outgrew (TRAPS [T1.39] "Docs drift from code"). Each
 * check reads the committed page and fails on the stale claim, with a positive control that runs
 * the same check over the old sentence.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "../src/main/config/schema.ts";

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

/** Whether a `dictation.engine` description still picks `best` by the machine for `auto`. */
export function autoPicksByMachine(doc: string): boolean {
  return /`auto`: best where Qwen runs on a GPU/.test(doc);
}

describe("[T1.39] Docs drift from code: the dictation engine", () => {
  test("the dictation page says `auto` follows `dictation.final`, live by default", () => {
    expect(autoRowFollowsFinal(read("docs/dictation.md"))).toBe(true);
  });

  test("the `dictation.engine` setting says `auto` follows `dictation.final`", () => {
    const doc = SETTINGS["dictation.engine"].doc;
    expect(autoPicksByMachine(doc)).toBe(false);
    expect(doc).toContain("`auto`: what `dictation.final` names");
  });

  test("positive control: the old machine-based `auto` setting text is caught", () => {
    expect(
      autoPicksByMachine("`auto`: best where Qwen runs on a GPU and is downloaded, fast elsewhere"),
    ).toBe(true);
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

/**
 * The Model cells of DESIGN section 3's model table that name a recognizer akou has no build of.
 * The catalog (src/main/asr/models.ts) has no Moonshine, no Whisper tiny or base and no Whisper
 * turbo; its one Whisper is large-v3 as a GGUF on transcribe-cpp.
 */
export function unbuiltModels(design: string): string[] {
  const section = design.split(/^## 3\. /m)[1]?.split(/^## /m)[0] ?? "";
  return section
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Job "))
    .map((l) => l.split("|")[2]?.trim() ?? "")
    .filter((model) => /moonshine|turbo|whisper tiny|whisper base/i.test(model));
}

describe("[T1.39] Docs drift from code: the models DESIGN section 3 lists", () => {
  test("every model the table names is one the catalog has", () => {
    expect(unbuiltModels(readFileSync(join(ROOT, "docs", "DESIGN.md"), "utf8"))).toEqual([]);
  });

  test("positive control: the old Moonshine and Whisper turbo rows are caught", () => {
    const old = [
      "## 3. Speech recognition",
      "",
      "| Job | Model | Weights licence | Notes |",
      "|---|---|---|---|",
      "| Live recognition on slow machines | Moonshine tiny/base | MIT | English only |",
      "| Other languages | Whisper large-v3-turbo through sherpa-onnx | MIT | Chosen per workspace |",
      "",
      "## 4. The event log",
    ].join("\n");
    expect(unbuiltModels(old)).toEqual([
      "Moonshine tiny/base",
      "Whisper large-v3-turbo through sherpa-onnx",
    ]);
  });
});

/**
 * Whether DESIGN 3.1 still promises that the recognizer never loses audio. PcmQueue
 * (src/main/capture/ingest.ts) drops the oldest audio past `capture.queueSeconds`, and nothing
 * reads that span back during the call; only the final pass covers it.
 */
export function promisesNoDrop(design: string): boolean {
  return /never dropped for the recognizer|reads back from the Opus file|final transcript still has it/.test(
    design,
  );
}

describe("[T1.39] Docs drift from code: a full recognizer queue", () => {
  test("DESIGN 3.1 says the live layer drops the overflow and the final pass covers it", () => {
    const design = readFileSync(join(ROOT, "docs", "DESIGN.md"), "utf8");
    expect(promisesNoDrop(design)).toBe(false);
    expect(design).toContain("the recording keeps it and the final pass decodes it");
  });

  test("positive control: the old read-back promise is caught", () => {
    expect(
      promisesNoDrop(
        "Beyond that the Worker reads back from the Opus file. Audio is never dropped for the recognizer; it only lags.",
      ),
    ).toBe(true);
    // The final pass can fail or skip a piece (DESIGN 3.3), so it promises nothing either.
    expect(promisesNoDrop("the final pass decodes the file, so the final transcript still has it.")).toBe(
      true,
    );
  });
});

/**
 * The lines that say the default model keeps whichever is on disk. With both on disk the default
 * is not a tie: live prefers a downloaded Nemotron over Parakeet (chooseLiveEngine,
 * src/main/asr/live-engines.ts) and the final pass a downloaded Qwen (src/main/asr/model-set.ts).
 */
export function tiedDefaultClaims(md: string): string[] {
  return md.split("\n").filter((l) => /keeps whichever/.test(l));
}

describe("[T1.39] Docs drift from code: the default model with both on disk", () => {
  test("How it works names the order the default prefers, Nemotron or Qwen first", () => {
    const page = read("docs/how-it-works.md");
    expect(tiedDefaultClaims(page)).toEqual([]);
    expect(page).toContain("a downloaded Nemotron first, else a downloaded Parakeet");
    expect(page).toContain("a downloaded Qwen3-ASR first, else a downloaded Parakeet");
  });

  test("positive control: the old keeps-whichever sentence is caught", () => {
    expect(
      tiedDefaultClaims(
        "The default keeps whichever of the two is already on disk, so a Mac that has Parakeet keeps Parakeet.",
      ),
    ).toHaveLength(1);
  });
});
