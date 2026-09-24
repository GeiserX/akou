/**
 * The `bpe.vocab` for decode biasing and the tokenization check (bpe-vocab.ts), on a small
 * generated BPE tokenizer shaped like Parakeet's (Metaspace, merges by rank). The real tokenizer is
 * a model file and is never downloaded in CI; tests/integration/asr.local.test.ts runs the same
 * checks against it when the models are present.
 */

import { describe, expect, test } from "bun:test";
import {
  BpeTokenizer,
  buildBpeVocab,
  CHAR_SCORE,
  checkTerm,
  checkTerms,
  coveredBy,
  parseBpeVocab,
  parseTokens,
  planHotwords,
  ssentencepieceEncode,
} from "../src/main/vocab/bpe-vocab.ts";

const CHARS = ["▁", "a", "b", "c", "e", "h", "k", "l", "n", "o", "r", "s", "t", "u", "v", "z"];
const MERGES: [string, string][] = [
  ["e", "r"],
  ["▁", "v"],
  ["▁v", "er"],
  ["c", "e"],
  ["ce", "l"],
  ["▁", "k"],
  ["u", "b"],
  ["▁k", "ub"],
  ["er", "n"],
  ["n", "e"],
  ["e", "t"],
  ["e", "s"],
  ["▁", "h"],
  ["▁h", "et"],
  ["z", "n"],
  ["zn", "er"],
];

function toyJson() {
  const vocab: Record<string, number> = { "<unk>": 0 };
  for (const c of CHARS) vocab[c] = Object.keys(vocab).length;
  for (const [a, b] of MERGES) vocab[a + b] = Object.keys(vocab).length;
  return {
    model: { type: "BPE", vocab, merges: MERGES, byte_fallback: false },
    pre_tokenizer: { type: "Metaspace" },
  };
}

const json = toyJson();
const tok = BpeTokenizer.fromJson(json);
const tokens = new Set(Object.keys(json.model.vocab));
const TERMS = ["vercel", "kubernetes", "hetzner"];

/** The upstream recipe: every token scored by minus its rank. */
function rankFile(): Map<string, number> {
  return new Map(
    Object.entries(json.model.vocab)
      .filter(([k]) => k !== "<unk>")
      .map(([k, v]) => [k, -v]),
  );
}

describe("the model's tokenizer", () => {
  test("BPE merges by rank, leftmost first, with the Metaspace prefix per word", () => {
    expect(tok.encode("vercel")).toEqual(["▁ver", "cel"]);
    expect(tok.encode("kubernetes")).toEqual(["▁kub", "ern", "et", "es"]);
    expect(tok.encode("hetzner vercel")).toEqual(["▁het", "zner", "▁ver", "cel"]);
    // Merges written as "a b" strings (older tokenizer.json) read the same.
    const old = BpeTokenizer.fromJson({
      ...json,
      model: { ...json.model, merges: MERGES.map(([a, b]) => `${a} ${b}`) },
    });
    expect(old.encode("kubernetes")).toEqual(tok.encode("kubernetes"));
  });

  test("a tokenizer that is not BPE is refused", () => {
    expect(() => BpeTokenizer.fromJson({ model: { type: "Unigram" } })).toThrow(/not BPE/);
  });

  test("tokens.txt and a written bpe.vocab read back", () => {
    expect(parseTokens("<unk> 0\n▁ver 19\ncel 21\n")).toEqual(new Set(["<unk>", "▁ver", "cel"]));
    const built = buildBpeVocab(tok, ["vercel"]);
    expect(parseBpeVocab(built.text)).toEqual(new Map(built.pieces));
  });
});

describe("sherpa-onnx's hotword tokenizer, reimplemented", () => {
  test("max total score; a tie goes to the piece that ends first", () => {
    const v = new Map([
      ["▁ver", -1],
      ["cel", -1],
      ["▁v", -1],
      ["ercel", -1],
    ]);
    // Both paths score -2: `▁v ercel` ends its first piece first and wins the tie.
    expect(ssentencepieceEncode(v, "vercel")).toEqual(["▁v", "ercel"]);
  });

  test("a position no piece covers scores 0 and wins: the word comes out with <unk>", () => {
    const v = new Map([
      ["▁ver", -1],
      ["cel", -1],
      ["er", -1],
      ["▁v", -1],
      ["e", -1],
    ]);
    expect(ssentencepieceEncode(v, "vercel")).toEqual(["▁v", "e", "<unk>", "cel"]);
    // With every single character reachable at a low score, the canonical path wins again.
    v.set("r", CHAR_SCORE);
    expect(ssentencepieceEncode(v, "vercel")).toEqual(["▁ver", "cel"]);
  });
});

describe("[spike] The bpe.vocab from the upstream recipe", () => {
  test("the canonical-pieces file passes the check for every term", () => {
    const built = buildBpeVocab(tok, TERMS);
    const checks = checkTerms(tok, built.pieces, tokens, TERMS);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(built.text.startsWith("<unk>\t0\n")).toBe(true);
    // Every line is `piece<TAB>score` with no whitespace in the piece: sherpa-onnx exits on
    // anything else.
    for (const line of built.text.trim().split("\n")) expect(line).toMatch(/^\S+\t-?\d+$/);
  });

  test("positive control: the rank-scored file is caught spelling terms differently", () => {
    const checks = checkTerms(tok, rankFile(), tokens, TERMS);
    expect(checks.filter((c) => !c.ok).map((c) => c.term)).toEqual(TERMS);
    expect(checks[0]?.reason).toContain("sherpa-onnx spells it");
  });

  test("positive control: without the single-character floor the dead-end rule breaks a term", () => {
    // Terms whose pieces leave a character uncovered for another term.
    const built = buildBpeVocab(tok, ["vercel", "kubernetes"]);
    const noChars = new Map([...built.pieces].filter(([, s]) => s !== CHAR_SCORE));
    noChars.set("▁v", -1);
    noChars.set("e", -1);
    expect(checkTerm(tok, noChars, tokens, "vercel").ok).toBe(false);
    expect(checkTerm(tok, built.pieces, tokens, "vercel").ok).toBe(true);
  });
});

describe("[spike] Hotwords that silently do nothing", () => {
  test("a term with a piece the model does not have is dropped with the reason", () => {
    const noCel = new Set([...tokens].filter((t) => t !== "cel"));
    const built = buildBpeVocab(tok, ["vercel"]);
    const c = checkTerm(tok, built.pieces, noCel, "vercel");
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("pieces not in the model: cel");
  });

  test("a term the model spells with unknown characters is dropped, never passed", () => {
    const c = checkTerm(tok, buildBpeVocab(tok, ["vxq"]).pieces, tokens, "vxq");
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/unknown or byte tokens/);
  });

  test("the plan keeps what passes and drops the rest, with reasons", () => {
    const plan = planHotwords(tok, tokens, null, ["vercel", "vxq", "hetzner"]);
    expect(plan.keep).toEqual(["vercel", "hetzner"]);
    expect(plan.dropped.map((d) => d.term)).toEqual(["vxq"]);
  });
});

describe("the file a recognizer loaded and a new list", () => {
  test("a list inside the loaded file needs no reload; a new word's pieces do", () => {
    const first = planHotwords(tok, tokens, null, ["vercel", "hetzner"]);
    expect(first.reload).toEqual(["vercel", "hetzner"]);
    const same = planHotwords(tok, tokens, first.vocab, ["hetzner"]);
    expect(same.reload).toBeNull();
    expect(same.keep).toEqual(["hetzner"]);
    const added = planHotwords(tok, tokens, first.vocab, ["vercel", "hetzner", "kubernetes"]);
    expect(coveredBy(tok, first.vocab, ["kubernetes"])).toBe(false);
    expect(added.reload).toEqual(["vercel", "hetzner", "kubernetes"]);
    expect(added.keep).toEqual(["vercel", "hetzner", "kubernetes"]);
  });

  test("a covered term the loaded file spoils gets a file for this list, not a drop", () => {
    // Its own tokenizer: "abc" merges to one piece that "abcd" never forms, so a file holding
    // "abc" and "bd" gives "abcd" a two-piece path that beats its canonical three.
    const merges: [string, string][] = [
      ["c", "d"],
      ["b", "c"],
      ["▁", "a"],
      ["▁a", "bc"],
    ];
    const v: Record<string, number> = { "<unk>": 0 };
    for (const c of ["▁", "a", "b", "c", "d"]) v[c] = Object.keys(v).length;
    for (const [a, b] of merges) v[a + b] = Object.keys(v).length;
    const t = BpeTokenizer.fromJson({
      model: { type: "BPE", vocab: v, merges, byte_fallback: false },
      pre_tokenizer: { type: "Metaspace" },
    });
    const ts = new Set(Object.keys(v));
    const first = planHotwords(t, ts, null, ["abc", "bd", "abcd"]);
    expect(first.dropped.map((d) => d.term)).toEqual(["abcd"]);
    expect(coveredBy(t, first.vocab, ["abcd"])).toBe(true);
    const next = planHotwords(t, ts, first.vocab, ["abcd"]);
    expect(next.reload).toEqual(["abcd"]);
    expect(next.keep).toEqual(["abcd"]);
    // Positive control: when a fresh file fails the term too (here a model without "cd"), the
    // loaded file stays and the term is dropped, so there is no pointless reload.
    const noCd = new Set([...ts].filter((p) => p !== "cd"));
    const stuck = planHotwords(t, noCd, first.vocab, ["abcd"]);
    expect(stuck.reload).toBeNull();
    expect(stuck.dropped.map((d) => d.term)).toEqual(["abcd"]);
  });

  test("a single character in the file is not a canonical piece for coverage", () => {
    const built = buildBpeVocab(tok, ["vercel"]);
    expect(built.pieces.get("h")).toBe(CHAR_SCORE);
    expect(coveredBy(tok, built.pieces, ["hetzner"])).toBe(false);
  });
});
