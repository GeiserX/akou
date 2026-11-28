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

/** Whether a `dictation.engine` description says `fast`'s Parakeet is always loaded. */
export function fastSaysLoaded(doc: string): boolean {
  return /Parakeet, already loaded/.test(doc);
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

  test("the `dictation.engine` setting never says Parakeet is already loaded for `fast`", () => {
    // A Mac with room for Qwen downloads no Parakeet (src/main/asr/model-set.ts), and `fast`
    // exists only once it is on disk (`fastEngine` in src/main/index.ts).
    const doc = SETTINGS["dictation.engine"].doc;
    expect(fastSaysLoaded(doc)).toBe(false);
    expect(doc).toContain("`akou models pull fast`");
  });

  test("positive control: the old already-loaded `fast` text is caught", () => {
    expect(fastSaysLoaded("`fast`: Parakeet, already loaded, about 0.1 s for 5 s of speech")).toBe(
      true,
    );
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
    expect(
      promisesNoDrop("the final pass decodes the file, so the final transcript still has it."),
    ).toBe(true);
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

/**
 * The lines that say akou keeps no voiceprint across calls, or that the vocabulary is the one
 * thing that carries over. akou keeps a voiceprint per person the user named in `voices.yaml`
 * (src/main/voices/store.ts) and names that voice in a later call (DESIGN 3.5). A bare "names
 * stay per call" is not one: attendee names do stay per call.
 */
export function noVoicesClaims(text: string): string[] {
  const stale = [
    /no voice ?prints?( kept)? across calls/i,
    /keeps? no voice ?prints?/i,
    /voice ?prints? (are|is) not kept/i,
    /keeps nothing across calls/i,
    /nothing carries (over|across)/i,
    /vocabulary is the (one|only) thing that carr(y|ies)/i,
    /only (the|your) vocabulary carr/i,
    /the (one|only) thing that carries[^.]*vocabulary/i,
    /speakers are named per call/i,
    /speaker names? (stay|are) per call/i,
    /\bno (command|answer|route|door)s?\b[^.]*\b(prints?|carr(y|ies)|returns?)\b[^.]*voice ?prints?/i,
  ];
  return text.split("\n").filter((l) => stale.some((re) => re.test(l)));
}

/**
 * The lines that say the voices do nothing yet, or that their window doors are not built. The
 * gate file names voices with TitaNet-small (docs/gates/voices.json), and the window has the
 * Voices list (src/ui/voices-page.ts) and the popover's "Not Ben" (src/ui/app.ts).
 */
export function voicesDoNothingClaims(text: string): string[] {
  return text
    .split("\n")
    .filter((l) =>
      /nothing learns or matches voices|(learns|matches) voices yet|holds no value yet|voices list in settings is not built|not ben button is not built/i.test(
        l,
      ),
    );
}

/**
 * The lines that put legal or consent wording on the voices: the voices are described like any
 * other setting (what akou keeps, where, and how to remove it), with no notice about biometric
 * data, GDPR, BIPA or consent.
 */
export function voiceLegalWording(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /gdpr|bipa|biometric|consent/i.test(l) && /voice|speaker/i.test(l));
}

/** Every Markdown file under `dir`, relative to the repository, outside the folders `skip` names. */
function markdownUnder(dir: string, skip: readonly string[] = []): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.endsWith(".md") && !skip.some((s) => f.startsWith(s)))
    .map((f) => `${dir}/${f}`);
}

/** Every `description` string in the API file, one per line. */
function openapiDescriptions(): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (k === "description" && typeof x === "string") out.push(x.replaceAll("\n", " "));
        else walk(x);
      }
  };
  walk(JSON.parse(read("docs/api/openapi.json")));
  return out.join("\n");
}

/**
 * What a person reads about the voices: README, the pages under docs/ (not the research notes or
 * the gate records) and the skills, the Unreleased part of the changelog (the released entries are
 * history), the API file's descriptions, and the source files that hold the window's, the Models
 * page's and the settings' words.
 */
function voicePages(): [string, string][] {
  const changelog = read("CHANGELOG.md").split(/^## (?!Unreleased)/m)[0] ?? "";
  const settings = Object.values(SETTINGS)
    .map((s) => s.doc)
    .join("\n");
  return [
    ...[
      "README.md",
      ...markdownUnder("docs", ["research/", "gates/"]),
      ...markdownUnder("skills"),
    ].map((f): [string, string] => [f, read(f)]),
    ["CHANGELOG.md (Unreleased)", changelog],
    ["docs/api/openapi.json (descriptions)", openapiDescriptions()],
    ["src/main/config/schema.ts (setting docs)", settings],
    ...[
      "src/main/asr/models.ts",
      "src/ui/models-rows.ts",
      "src/ui/settings-labels.ts",
      "src/ui/voices-page.ts",
      "src/ui/app.ts",
      "src/ui/transcript.ts",
    ].map((f): [string, string] => [f, read(f)]),
  ];
}

describe("[T1.39] Docs drift from code: the voices akou keeps across calls", () => {
  test("no page says akou keeps no voiceprints, or that only the vocabulary carries over", () => {
    const stale = voicePages().flatMap(([f, text]) =>
      noVoicesClaims(text).map((l) => `${f}: ${l}`),
    );
    expect(stale).toEqual([]);
  });

  test("no page says the voices do nothing yet, or that their window doors are not built", () => {
    const stale = voicePages().flatMap(([f, text]) =>
      voicesDoNothingClaims(text).map((l) => `${f}: ${l}`),
    );
    expect(stale).toEqual([]);
  });

  test("no page puts biometric, GDPR, BIPA or consent wording on the voices", () => {
    const legal = voicePages().flatMap(([f, text]) =>
      voiceLegalWording(text).map((l) => `${f}: ${l}`),
    );
    expect(legal).toEqual([]);
  });

  test("the pages say plainly what akou keeps and how to forget it", () => {
    for (const f of ["docs/how-it-works.md", "docs/faq.md", "docs/DESIGN.md"]) {
      const page = read(f);
      expect(page).toContain("voices.yaml");
      expect(page).toContain("150 people");
      expect(page).toMatch(/3.year/);
    }
    const how = read("docs/how-it-works.md");
    for (const said of [
      "## Voices you named",
      "`akou voices forget --all`",
      "`POST /v1/voices/forget`",
      "`akou_voice_forget`",
      "Nowhere. akou computes the voiceprints on this computer and keeps them there.",
      "No voices command, route or tool returns a voiceprint.",
      "An `ak_` key never gets them",
      "A name from an MCP agent, a name sent with an `ak_` key",
      "an `ak_` key gets 403",
      "(`voices.enabled`) is on by default. Off, akou stops learning and matching voices and keeps `voices.yaml`",
      "**Server mode** has no voice recognition.",
    ])
      expect(how).toContain(said);
  });

  test("positive control: the old sentences are caught", () => {
    for (const old of [
      "akou keeps no cross-meeting library, no weekly rollups, no voiceprints kept across calls.",
      "akou keeps no voiceprints of anyone.",
      "Voice prints are not kept after the call.",
      "## The vocabulary is the one thing that carries over",
      "The vocabulary is the one thing that carries across calls, and nothing",
      "and keeps nothing across calls that would compete with them",
      "Nothing carries over from one call to the next but the words.",
      "Only your vocabulary carries over.",
      "The one thing that carries across calls is the vocabulary.",
      "| Voiceprints across calls | heed | Speakers are named per call |",
      "Speaker names stay per call.",
      "voices (exit 78). A voices.yaml akou cannot read exits 78 too. No command prints a voiceprint.",
      "No answer carries a voiceprint or a score: the call roster's `voice` is the name and its status.",
    ])
      expect(noVoicesClaims(old)).toHaveLength(1);
    expect(noVoicesClaims("akou keeps a voiceprint per person you named.")).toEqual([]);
    expect(
      noVoicesClaims("| People and company directories | Granola | Attendee names stay per call |"),
    ).toEqual([]);
  });

  test("positive control: the old does-nothing-yet sentences are caught", () => {
    for (const old of [
      "Only the window or the config file sets the switch. Nothing learns or matches voices yet.",
      "akou learns voices yet only in tests.",
      "[gates/voices.json](gates/voices.json) holds no value yet, so akou names no one by voice |",
      'window: { none: "the Voices list in Settings is not built yet" },',
      'window: { none: "the speaker popover\'s Not Ben button is not built yet" },',
    ])
      expect(voicesDoNothingClaims(old)).toHaveLength(1);
    // DESIGN 3.5's rule for a model with no numbers, and the CAM++ line, are true as they stand.
    expect(
      voicesDoNothingClaims(
        "While its entry has no numbers, nothing learns and nothing is named: naming a speaker saves no voice.",
      ),
    ).toEqual([]);
    expect(
      voicesDoNothingClaims("CAM++ has none, so akou names no one by voice with it |"),
    ).toEqual([]);
  });

  test("positive control: legal wording about voices is caught", () => {
    expect(
      voiceLegalWording("Voiceprints are biometric data (GDPR art. 9; Illinois BIPA)."),
    ).toHaveLength(1);
    expect(
      voiceLegalWording(
        "Tell the people you record, and get their consent before akou keeps their voice.",
      ),
    ).toHaveLength(1);
    expect(voiceLegalWording("Tell the others you are recording.")).toEqual([]);
  });
});
