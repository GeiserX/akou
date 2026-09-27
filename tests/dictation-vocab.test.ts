/**
 * The dictation vocabulary (docs/ux/DICTATION.md DC-L6): an entry with `scope: dictation` is a
 * fix the user taught while dictating. Dictation always applies it; a call never reads it.
 */

import { describe, expect, test } from "bun:test";
import { fold } from "../src/core/log/fold.ts";
import { correctDictation } from "../src/main/dictation/vocab.ts";
import { buildDecodeList } from "../src/main/vocab/decode-list.ts";
import {
  callEntries,
  mergeVocab,
  parseVocab,
  serializeVocab,
  toFoldEntries,
} from "../src/main/vocab/files.ts";
import { LogBuilder, T0 } from "./helpers.ts";

const COMMON = new Set(["the", "we", "on", "at", "example", "dot", "com", "box", "ship", "it"]);
const isCommon = (w: string) => COMMON.has(w);

/** A vocabulary file with the two DC-L6 entries, with or without their `scope: dictation`. */
function vocabYaml(scoped: boolean): string {
  const scope = scoped ? '\n    scope: "dictation"' : "";
  return [
    "version: 1",
    "entries:",
    '  - term: "Vercel"',
    '    heard: ["versal"]',
    '    source: "dictation:d1"',
    "    confirmed: true",
    `    added_at: "2026-09-27"${scope}`,
    '  - term: ".com"',
    '    heard: ["dot com"]',
    '    source: "dictation:d2"',
    "    confirmed: true",
    `    added_at: "2026-09-27"${scope}`,
    "",
  ].join("\n");
}

function merged(scoped: boolean) {
  const parsed = parseVocab(vocabYaml(scoped));
  expect(parsed.errors).toEqual([]);
  return mergeVocab([{ scope: "workspace", path: "w.yaml", file: parsed.file }]);
}

describe("DC-L6: the `scope: dictation` key of a vocabulary entry", () => {
  test("it parses, writes back the same, and an unknown scope value is refused", () => {
    const parsed = parseVocab(vocabYaml(true));
    expect(parsed.errors).toEqual([]);
    expect(parsed.file.entries.map((e) => [e.term, e.entryScope, e.source])).toEqual([
      ["Vercel", "dictation", "dictation:d1"],
      [".com", "dictation", "dictation:d2"],
    ]);
    expect(parseVocab(serializeVocab(parsed.file)).file).toEqual(parsed.file);

    const bad = parseVocab(vocabYaml(true).replace('scope: "dictation"', 'scope: "calls"'));
    expect(bad.errors).toEqual([
      { entry: 0, message: '"scope" must be "dictation" (term "Vercel")' },
    ]);
    expect(bad.file.entries.map((e) => e.term)).toEqual([".com"]);
  });

  test("[spike] A heard form that is a real word: a call never reads a dictation entry, in the fold or the decode list", () => {
    const call = (scoped: boolean) => {
      const entries = callEntries(merged(scoped));
      const b = new LogBuilder();
      b.created();
      b.partStarted(1, T0);
      b.seg({ id: "l000001", text: "we ship it on versal at example dot com" });
      const view = fold(b.events, {
        vocabFiles: toFoldEntries(entries),
        isDictionaryWord: isCommon,
      });
      const list = buildDecodeList({
        model: "parakeet-tdt-0.6b-v3",
        callVocab: [],
        names: [],
        files: entries,
      });
      return { text: view.lines()[0]?.text, decode: list.entries.map((e) => e.term) };
    };
    expect(call(true)).toEqual({ text: "we ship it on versal at example dot com", decode: [] });
    // Positive control: the same entries with no scope are call entries, and rewrite the call.
    expect(call(false)).toEqual({
      text: "we ship it on Vercel at example dot com",
      decode: ["Vercel", ".com"],
    });
  });

  test("[spike] A heard form that is a real word: dictation applies its own entries, a plain file pair stays inert", () => {
    const raw = "we ship it on versal at example dot com";
    expect(correctDictation(raw, merged(true), isCommon)).toBe(
      "we ship it on Vercel at example .com",
    );
    // Positive control: as plain file entries, "dot com" is two dictionary words and stays inert.
    expect(correctDictation(raw, merged(false), isCommon)).toBe(
      "we ship it on Vercel at example dot com",
    );
    // With no word list at all a plain file pair cannot be judged, so only the scoped ones apply.
    expect(correctDictation(raw, merged(false), undefined)).toBe(raw);
    expect(correctDictation(raw, merged(true), undefined)).toBe(
      "we ship it on Vercel at example .com",
    );
  });

  test("an unconfirmed dictation entry does nothing", () => {
    const parsed = parseVocab(vocabYaml(true).replaceAll("confirmed: true", "confirmed: false"));
    const m = mergeVocab([{ scope: "global", path: "g.yaml", file: parsed.file }]);
    expect(correctDictation("on versal", m, isCommon)).toBe("on versal");
  });
});
