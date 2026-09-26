/**
 * What the Models page says of each model (docs/ux/SERVER.md SV-U6), without a browser: the sort
 * orders, "not measured" instead of a number, why a model is kept or when it goes, and the
 * measured speed. The page itself is driven in `tests/ui/models-page.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  bar,
  deleteRefusal,
  keptText,
  type ModelRow,
  measuredText,
  purposeText,
  sizeText,
  sortRows,
} from "../src/ui/models-rows.ts";

const NONE = { score: null, not_measured: "nobody measured it" } as const;

function row(id: string, o: Partial<ModelRow> = {}): ModelRow {
  return {
    id,
    kind: "speech",
    job: "a recognizer",
    languages: ["en", "es"],
    streaming: false,
    from: ["huggingface.co/org/repo"],
    state: "ready",
    bytes: 1e9,
    size: 1e9,
    last_used_at: null,
    evicts_at: null,
    default: false,
    in_use: false,
    accuracy: NONE,
    speed: NONE,
    measured: null,
    set_default: null,
    ...o,
  };
}

const scored = (score: number) => ({
  score,
  metric: "wer" as const,
  value: (100 - score) / 5,
  what: "FLEURS",
  source: "docs/x.md",
  formula: "100 - 5 x WER",
});

describe("[SV-U6] sorting", () => {
  const rows = [
    row("b-fast", {
      accuracy: scored(60),
      speed: scored(90),
      size: 5e8,
      last_used_at: "2026-09-01T00:00:00Z",
    }),
    row("a-accurate", {
      accuracy: scored(85),
      speed: scored(40),
      size: 2e9,
      last_used_at: "2026-09-20T00:00:00Z",
    }),
    row("c-unmeasured", { size: 1e6 }),
  ];
  const ids = (by: Parameters<typeof sortRows>[1]) => sortRows(rows, by).map((r) => r.id);

  test("accuracy and speed best first, the unmeasured last", () => {
    expect(ids("accuracy")).toEqual(["a-accurate", "b-fast", "c-unmeasured"]);
    expect(ids("speed")).toEqual(["b-fast", "a-accurate", "c-unmeasured"]);
  });

  test("size largest first, name A to Z, last used most recent first", () => {
    expect(ids("size")).toEqual(["a-accurate", "b-fast", "c-unmeasured"]);
    expect(ids("name")).toEqual(["a-accurate", "b-fast", "c-unmeasured"]);
    expect(ids("last_used")).toEqual(["a-accurate", "b-fast", "c-unmeasured"]);
  });
});

describe("[SV-U6] the bars say the number, or that there is none", () => {
  test("a measured side: its score, the raw number, and the source in the title", () => {
    const b = bar(scored(77));
    expect(b.value).toBe(77);
    expect(b.label).toBe("77 · WER 4.6 %");
    expect(b.title).toContain("FLEURS");
    expect(b.title).toContain("docs/x.md");
    expect(b.title).toContain("100 - 5 x WER");
  });

  test("an unmeasured side: no value, 'not measured', and the reason", () => {
    expect(bar(NONE)).toEqual({ value: null, label: "not measured", title: "nobody measured it" });
  });
});

describe("[SV-U6] kept, deleted on a date, or never", () => {
  test("the default and a model in use are kept, and say so", () => {
    expect(keptText(row("d", { default: true }), 30)).toContain("Kept: default");
    expect(keptText(row("u", { in_use: true }), 30)).toContain("Kept: in use");
    expect(deleteRefusal(row("d", { default: true }))).toContain("default");
    expect(deleteRefusal(row("u", { in_use: true }))).toContain("in use");
  });

  test("an unused model says when it goes; with the setting at 0 it says it stays", () => {
    const r = row("x", { last_used_at: "2026-09-01T12:00:00Z", evicts_at: "2026-10-01T12:00:00Z" });
    expect(keptText(r, 30)).toContain("Deleted on");
    expect(deleteRefusal(r)).toBeNull();
    expect(keptText(row("x", { last_used_at: "2026-09-01T12:00:00Z" }), 0)).toContain(
      "automatic deletion is off",
    );
    expect(keptText(row("m", { state: "missing" }), 30)).toBe("Not downloaded");
  });
});

describe("[SV-U6] what a model is for, its size, and this machine's speed", () => {
  test("languages, and whether it transcribes during the call", () => {
    expect(purposeText(row("a", { streaming: true }))).toBe(
      "a recognizer · en, es · live and after the call",
    );
    const many = "bg cs da de el en es et fi".split(" ");
    expect(purposeText(row("b", { languages: many }))).toContain("9 languages");
    expect(purposeText(row("s", { kind: "speakers", job: "speaker labels" }))).toBe(
      "speaker labels",
    );
  });

  test("sizes in powers of ten", () => {
    expect(sizeText(2_551_000_000)).toBe("2.55 GB");
    expect(sizeText(40_257_283)).toBe("40 MB");
    expect(sizeText(643_854)).toBe("644 KB");
  });

  test("measured speed: none until a run, then the median as times real time", () => {
    expect(measuredText(row("a"))).toBeNull();
    expect(measuredText(row("a", { measured: { rtf: 0.05, runs: 3 } }))).toBe(
      "Measured here: 20x real time (real-time factor 0.05), median of 3 runs",
    );
  });
});
