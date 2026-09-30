/**
 * What the Models page says (docs/ux/design-explorations/sd-a-models.html, SERVER.md SV-U6),
 * without a browser: each fact as a plain sentence built from the real numbers in
 * `asr/model-scores.ts` and `asr/live-setups.ts`, every accuracy figure naming its test set, the
 * "next call" and "this call" marks, why a model is kept or when it goes, and sizes. The page
 * itself is driven in `tests/ui/models-page.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { LIVE_SETUPS, type LiveView, REVIEWS } from "../src/main/asr/live-setups.ts";
import { LLAMA_CATALOG, QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { type Measure, type NotMeasured, SCORES } from "../src/main/asr/model-scores.ts";
import { modelsFor, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { SETTINGS } from "../src/main/config/schema.ts";
import { scoreView } from "../src/main/server/model-store.ts";
import { PRESETS } from "../src/main/server/presets.ts";
import {
  accuracyText,
  afterCallHelp,
  autoHelp,
  bestHelp,
  DEFAULTS,
  DIARIZERS,
  gbText,
  hourText,
  joinAnd,
  keptText,
  liveHelp,
  MODELS_KEYS,
  type ModelRow,
  modelName,
  PRESET_ENGINES,
  QWEN_ID,
  RECOGNIZER_ID,
  reasonText,
  removeRefusal,
  sizeText,
  speakersHelp,
  totalText,
} from "../src/ui/models-rows.ts";

const NONE = { score: null, not_measured: "nobody measured it" } as const;

function row(id: string, o: Partial<ModelRow> = {}): ModelRow {
  const s = SCORES[id];
  return {
    id,
    kind: "speech",
    job: "a recognizer",
    name: null,
    short: null,
    lines: {},
    languages: ["en", "es"],
    streaming: false,
    after_call: true,
    from: ["huggingface.co/org/repo"],
    state: "ready",
    bytes: 1e9,
    size: 1e9,
    last_used_at: null,
    evicts_at: null,
    default: false,
    in_use: false,
    accuracy: s ? scoreView(s.accuracy) : NONE,
    speed: s ? scoreView(s.speed) : NONE,
    measured: null,
    set_default: null,
    ...o,
  };
}

function setup(id: keyof typeof LIVE_SETUPS) {
  const s = LIVE_SETUPS[id];
  return {
    id,
    title: s.title,
    what: s.what,
    plain: s.plain,
    line: s.line,
    unavailable: s.unavailable ?? null,
    selected: false,
    running: false,
    models: [],
    accuracy: scoreView(s.accuracy),
    latency: scoreView(s.latency),
    cores: scoreView(s.cores),
    memory: scoreView(s.memory),
  };
}

function view(o: Partial<LiveView>): LiveView {
  return {
    setting: "auto",
    next: "nemotron",
    note: null,
    running: null,
    setups: (["nemotron", "parakeet", "voxtral"] as const).map(setup),
    review: { setting: "none", everySeconds: 60, next: null, running: null, choices: [] },
    slots: { live: [], review: [] },
    runningId: null,
    ...o,
  };
}

describe("[SV-U6] facts as plain sentences, each accuracy figure naming its test set", () => {
  test("the recognizers, from their measured WER on read speech", () => {
    expect(accuracyText(row(RECOGNIZER).accuracy)).toBe(
      "About 5 words in 100 wrong on read speech.",
    );
    expect(accuracyText(row(QWEN_ASR).accuracy)).toBe("About 3 words in 100 wrong on read speech.");
    expect(afterCallHelp(row(RECOGNIZER), "this Mac")).toBe(
      "Writes the accurate transcript when a call ends. About 5 words in 100 wrong on read speech. An hour of audio in 1.3 minutes.",
    );
    expect(bestHelp(row(QWEN_ASR))).toBe(
      "The most accurate: about 3 words in 100 wrong on read speech. It also rewrites live lines and checks the words akou learns. Without it, dictation uses Fast.",
    );
  });

  test("the speaker models, from their DER on real calls", () => {
    expect(speakersHelp("nemotron", [row(NEMOTRON, { kind: "speakers" })])).toBe(
      "Who spoke when, live and after the call. About 1 second in 10 given to the wrong speaker on real calls.",
    );
    const fingerprints = [
      row("pyannote-segmentation-3.0", { kind: "speakers" }),
      row("titanet-small", { kind: "speakers" }),
    ];
    expect(speakersHelp("embeddings", fingerprints)).toBe(
      "The older way: about 6 seconds in 10 given to the wrong speaker on real calls.",
    );
  });

  test("the live setups, from their WER on meetings, then how their lines behave", () => {
    expect(liveHelp(setup("nemotron"))).toBe(
      "About 1 word in 5 wrong on meetings. Words appear as they are said and never change.",
    );
    expect(liveHelp(setup("parakeet"))).toBe(
      "About 1 word in 3 wrong on meetings. Words can change as you watch.",
    );
    expect(liveHelp(setup("voxtral"))).toMatch(/^Not available yet/);
  });

  test("a figure nobody measured says nothing rather than a number", () => {
    expect(accuracyText(NONE)).toBeNull();
    expect(accuracyText(row("silero-vad", { kind: "helper" }).accuracy)).toBeNull();
  });

  test("every accuracy figure in the scores and the live setups names its test set", () => {
    const figures: [string, Measure | NotMeasured][] = [
      ...Object.entries(SCORES).map(([id, s]) => [id, s.accuracy] as [string, Measure]),
      ...Object.entries(LIVE_SETUPS).map(
        ([id, s]) => [`live ${id}`, s.accuracy] as [string, Measure],
      ),
    ];
    const unnamed = figures.filter(([, m]) => !("notMeasured" in m) && !m.set).map(([id]) => id);
    expect(unnamed).toEqual([]);
  });

  test("this machine's own speed wins over the reference machine's", () => {
    const measured = row(RECOGNIZER, { measured: { rtf: 0.02, runs: 3 } });
    expect(hourText(measured, "this Mac")).toBe("An hour of audio in 1.2 minutes on this Mac.");
    expect(hourText(row("x"), "this Mac")).toBe("");
  });

  test("no sentence quotes a setting's key or a value in code quotes", () => {
    const keys = Object.keys(SETTINGS);
    for (const s of [...Object.values(LIVE_SETUPS), ...Object.values(REVIEWS)]) {
      expect(s.plain.includes("`")).toBe(false);
      expect(keys.filter((k) => s.plain.includes(k))).toEqual([]);
    }
  });
});

describe("[SV-U6] the live transcript's Automatic row", () => {
  test("it says what it runs here: Nemotron once a streaming model is here, else Parakeet", () => {
    expect(autoHelp(view({}), "this Mac")).toBe("Uses Nemotron, since it is on this Mac.");
    expect(autoHelp(view({ next: "parakeet" }), "this Mac")).toBe(
      "Uses Parakeet until Nemotron is on this Mac.",
    );
  });
});

describe("[SV-U6] kept, removed, or deleted on a date", () => {
  test("the default and a model in use are kept, and say why", () => {
    // A default a setting chooses can be chosen away; one no setting chooses, akou needs.
    const chosen = { key: "asr.diarizer", value: "nemotron" };
    expect(keptText(row("d", { default: true, set_default: chosen }), 30)).toContain(
      "Kept: the default",
    );
    expect(keptText(row("d", { default: true }), 30)).toContain("Kept: akou needs it");
    expect(keptText(row("u", { in_use: true }), 30)).toContain("Kept: in use");
    expect(removeRefusal(row("d", { default: true }))).toContain("by default");
    expect(removeRefusal(row("u", { in_use: true }))).toContain("in use");
  });

  test("an unused model says when it goes; with the setting at 0 it says it stays", () => {
    const r = row("x", { last_used_at: "2026-09-01T12:00:00Z", evicts_at: "2026-10-01T12:00:00Z" });
    expect(keptText(r, 30)).toContain("Deleted on");
    expect(removeRefusal(r)).toBeNull();
    expect(keptText(row("x", { last_used_at: "2026-09-01T12:00:00Z" }), 0)).toContain(
      "nothing is deleted for being unused",
    );
    expect(keptText(row("m", { state: "missing" }), 30)).toBe("Not downloaded");
  });
});

describe("[SV-U6] sizes and the page's own names", () => {
  test("sizes: the page in GB, the welcome in the nearest unit", () => {
    expect(gbText(2_520_744_288)).toBe("2.52 GB");
    expect(gbText(400_000_000)).toBe("0.40 GB");
    // Under 0.1 GB one unit rule for the whole page: MB, then KB.
    expect(gbText(47_000_000)).toBe("47 MB");
    expect(gbText(2_000_000)).toBe("2 MB");
    expect(gbText(643_854)).toBe("644 KB");
    expect(sizeText(2_551_000_000)).toBe("2.55 GB");
    expect(sizeText(40_257_283)).toBe("40 MB");
    expect(sizeText(643_854)).toBe("644 KB");
    const rows = [
      row("a", { size: 4e9 }),
      row("b", { size: 2.2e9 }),
      row("c", { state: "missing" }),
    ];
    expect(totalText(rows, "this Mac", false)).toBe(
      "6.2 GB on this Mac. Nothing leaves this computer.",
    );
    expect(totalText([row("c", { state: "missing" })], "this server", true)).toBe(
      "Nothing downloaded yet.",
    );
  });

  test("each build of Qwen3-ASR's program is named by what it runs on, never alike", () => {
    const builds = LLAMA_CATALOG.filter((m) => m.id.startsWith("llama-server"));
    const platforms = new Set(builds.flatMap((m) => m.platforms ?? []));
    expect(platforms.size).toBeGreaterThan(1);
    for (const p of platforms) {
      const names = builds
        .filter((m) => m.platforms?.includes(p))
        .map((m) => modelName({ id: m.id, job: m.job }));
      expect(`${p}: ${new Set(names).size}`).toBe(`${p}: ${names.length}`);
      for (const n of names) expect(n).toMatch(/^Qwen3-ASR's program for (the|an) /);
    }
  });

  test("a refusal in plain words: no id, key or byte count", () => {
    const said: [string, string][] = [
      [
        "downloading qwen3-asr-1.7b (2520744288 bytes) would take the models folder past server.models_max_gb (40 GB)",
        "it would pass the size you keep models under",
      ],
      [
        "downloading qwen3-asr-1.7b needs 2520744288 bytes and 1 GB to spare, and the volume has 1000 bytes free",
        "there is not enough free disk space",
      ],
      ["ENOSPC: no space left on device, write '/x/y'", "there is not enough free disk space"],
      [
        "the qwen3-asr-1.7b model is not downloaded and server.auto_download is off",
        "downloading a missing model is turned off",
      ],
      ["qwen3-asr-1.7b is downloading", "it is downloading"],
      ["akou is still starting", "akou is still starting"],
      ["fetch failed", "the network failed"],
      ["something nobody expected at /x/y", ""],
    ];
    for (const [server, plain] of said) expect(reasonText(server)).toBe(plain);
    expect(reasonText(null)).toBe("");
    expect(joinAnd(["A"])).toBe("A");
    expect(joinAnd(["A", "b", "c"])).toBe("A, b and c");
  });

  test("the ids and defaults the page names are the catalog's and the registry's", () => {
    expect(RECOGNIZER_ID).toBe(RECOGNIZER);
    expect(QWEN_ID).toBe(QWEN_ASR);
    expect(DIARIZERS.nemotron).toEqual([NEMOTRON]);
    // Each speaker choice holds only what it adds: what the other choice leaves out. TitaNet runs
    // under both, so neither choice's Remove may reach it.
    const set = (d: string) => modelsFor({ "asr.diarizer": d }, "darwin-arm64").map((m) => m.id);
    for (const [d, ids] of Object.entries(DIARIZERS)) {
      const other = d === "nemotron" ? "embeddings" : "nemotron";
      expect([d, ids]).toEqual([d, set(d).filter((id) => !set(other).includes(id))]);
    }
    // A preset in server.default_model marks the recognizer that preset runs.
    for (const [name, engine] of Object.entries(PRESET_ENGINES))
      expect(`${name}: ${PRESETS.find((p) => p.name === name && p.built)?.engines[0]}`).toBe(
        `${name}: ${engine}`,
      );
    const reg = SETTINGS as Record<string, { default?: unknown; values?: readonly string[] }>;
    expect(Object.keys(DIARIZERS).sort()).toEqual([...(reg["asr.diarizer"]?.values ?? [])].sort());
    for (const [key, value] of Object.entries(DEFAULTS))
      expect([key, reg[key]?.default]).toEqual([key, value]);
    expect(MODELS_KEYS.filter((k) => !(k in SETTINGS))).toEqual([]);
  });
});
