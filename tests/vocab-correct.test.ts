import { describe, expect, test } from "bun:test";
import {
  correctText,
  FUZZY_THRESHOLD,
  foldText,
  formatCorrection,
  heardFormApplies,
  jaroWinkler,
  tokenize,
  type VocabRule,
} from "../src/core/vocab/correct.ts";
import { isDictionaryWord } from "./helpers.ts";

const k8s: VocabRule = { term: "Kubernetes", heard: ["kubernetis", "cubernetes"], scope: "file" };
const opts = { isDictionaryWord };

describe("read-time correction (DESIGN 5.4)", () => {
  test("folding is case-insensitive and accent-free", () => {
    expect(foldText("Ánnika")).toBe("annika");
    expect(foldText("CAFÉ")).toBe("cafe");
    expect(foldText("Ελλάδα")).toBe("ελλαδα");
    expect(foldText("Йошкар")).toBe(foldText("Иошкар"));
  });

  test("marks that carry meaning in their script are kept: Devanagari vowel signs", () => {
    // Positive control: the old rule, which stripped every combining mark, folds two different
    // words to one key.
    const stripEveryMark = (s: string) =>
      s
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .normalize("NFC");
    expect(stripEveryMark("किताब")).toBe(stripEveryMark("कतब"));
    // The rule in force keeps them apart, and still folds Latin accents.
    expect(foldText("किताब")).not.toBe(foldText("कतब"));
    expect(foldText("किताब")).toBe("किताब".normalize("NFC"));
    expect(foldText("Ánnika")).toBe(foldText("Annika"));
    expect(tokenize("किताब कतब").map((t) => t.folded)).toEqual(["किताब", "कतब"]);
    // A heard form in Devanagari corrects only its own word.
    const r = correctText("किताब कतब", [{ term: "Kitab", heard: ["कतब"], scope: "call" }]);
    expect(r.text).toBe("किताब Kitab");
    expect(tokenize("we deploy on cubernetes, right?").map((t) => t.folded)).toEqual([
      "we",
      "deploy",
      "on",
      "cubernetes",
      "right",
    ]);
  });

  test("[T3.11] Answers from uncorrected recognition: heard forms render as the term with (heard: …)", () => {
    const raw = "we deploy on kubernetis and Cubernetes";
    const r = correctText(raw, [k8s], opts);
    expect(r.text).toBe("we deploy on Kubernetes and Kubernetes");
    expect(r.annotated).toBe(
      'we deploy on Kubernetes (heard: "kubernetis") and Kubernetes (heard: "Cubernetes")',
    );
    expect(r.corrections.map((c) => c.heard)).toEqual(["kubernetis", "Cubernetes"]);
    expect(formatCorrection("Anika", "annika")).toBe('Anika (heard: "annika")');
  });

  test("matching is whole-word only", () => {
    const r = correctText("kubernetisation and xkubernetis", [k8s], opts);
    expect(r.corrections).toEqual([]);
    expect(r.text).toBe("kubernetisation and xkubernetis");
  });

  test("decomposed (NFD) text tokenizes and corrects the same as composed (NFC)", () => {
    const nfc = "Ánnika";
    const nfd = "Ánnika";
    expect(nfd).not.toBe(nfc);
    expect(nfd.normalize("NFC")).toBe(nfc);
    for (const s of [nfc, nfd]) {
      expect(tokenize(s)).toEqual([{ folded: "annika", start: 0, end: s.length }]);
      // A heard form.
      const heard: VocabRule = { term: "Anika", heard: ["annika"], scope: "call" };
      const r = correctText(`ask ${s} now`, [heard]);
      expect(r.text).toBe("ask Anika now");
      expect(r.corrections.map((c) => c.heard)).toEqual([s]);
      // A speaker name written either way fuzzy-corrects to the whole name, not a fragment of it.
      const name: VocabRule = { term: `${s} Ruiz`, heard: [], scope: "name" };
      expect(correctText("ask annikaa", [name], opts).text).toBe(`ask ${s}`);
    }
    // A Devanagari word with vowel signs and a virama stays one token.
    expect(tokenize("नमस्ते किताब").map((t) => [t.start, t.end])).toEqual([
      [0, 6],
      [7, 12],
    ]);
  });

  test("matching is accent-folded", () => {
    const rule: VocabRule = { term: "Anika", heard: ["annika"], scope: "call" };
    expect(correctText("ask Ánnika", [rule]).text).toBe("ask Anika");
  });

  test("multi-word heard forms match across punctuation between the words", () => {
    const rule: VocabRule = { term: "Kubernetes", heard: ["cuber netes"], scope: "file" };
    expect(correctText("on cuber-netes today", [rule], opts).text).toBe("on Kubernetes today");
  });

  test("call-scoped pairs are tried before file pairs", () => {
    const file: VocabRule = { term: "Versal", heard: ["vercell"], scope: "file" };
    const call: VocabRule = { term: "Vercel", heard: ["vercell"], scope: "call" };
    expect(correctText("deploy to vercell", [file, call], opts).text).toBe("deploy to Vercel");
  });

  test("a longer heard form wins over a shorter one starting at the same word", () => {
    const short: VocabRule = { term: "Cube", heard: ["cuber"], scope: "call" };
    const long: VocabRule = { term: "Kubernetes", heard: ["cuber netes"], scope: "call" };
    expect(correctText("on cuber netes", [short, long]).text).toBe("on Kubernetes");
    expect(correctText("on cuber netes", [long, short]).text).toBe("on Kubernetes");
    // Positive control: the shorter form alone does apply there.
    expect(correctText("on cuber netes", [short]).text).toBe("on Cube netes");
  });

  test("a heard form equal to its own term corrects nothing", () => {
    const rule: VocabRule = {
      term: "Kubernetes",
      heard: ["kubernetes", "kubernetis"],
      scope: "call",
    };
    const r = correctText("on kubernetes and kubernetis", [rule]);
    expect(r.corrections.map((c) => c.heard)).toEqual(["kubernetis"]);
    expect(r.annotated).toBe('on kubernetes and Kubernetes (heard: "kubernetis")');
  });

  test("fuzzy: every word of a full speaker name is matched on its own", () => {
    const rule: VocabRule = { term: "Anika Ruiz", heard: [], scope: "name" };
    const r = correctText("I spoke with Anikaa and Ruizz", [rule], opts);
    expect(r.text).toBe("I spoke with Anika and Ruiz");
    expect(r.corrections.map((c) => [c.term, c.heard])).toEqual([
      ["Anika", "Anikaa"],
      ["Ruiz", "Ruizz"],
    ]);
    // Words under 4 characters are not fuzzy terms: "Ben" never rewrites "Bern".
    const ben: VocabRule = { term: "Ben Carter", heard: [], scope: "name" };
    expect(correctText("Bern and Cartr", [ben], opts).text).toBe("Bern and Carter");
  });

  test("fuzzy: a multi-word vocabulary term without heard forms is not split into words", () => {
    const rule: VocabRule = { term: "Visual Studio", heard: [], scope: "file" };
    expect(correctText("open studoi now", [rule], opts).corrections).toEqual([]);
  });

  test("[spike] A heard form that is a real word: file pairs skip dictionary words and forms of 3 characters or fewer", () => {
    const file: VocabRule[] = [
      { term: "Vessl", heard: ["vessel"], scope: "file" },
      { term: "Aira", heard: ["ira"], scope: "file" },
      { term: "Arr", heard: ["r"], scope: "file" },
    ];
    const raw = "the vessel is in the harbour, ira said r";
    expect(correctText(raw, file, opts).text).toBe(raw);
    expect(heardFormApplies("vessel", "file", isDictionaryWord)).toBe(false);
    expect(heardFormApplies("ira", "file", isDictionaryWord)).toBe(false);
    // Positive control: the same pairs, call-scoped, do apply, so the skip above is the rule.
    const call = file.map((r) => ({ ...r, scope: "call" as const }));
    expect(correctText(raw, call, opts).text).toBe("the Vessl is in the harbour, Aira said Arr");
  });

  test("a multi-word form made only of dictionary words is skipped for files", () => {
    const rule: VocabRule = { term: "Forsell", heard: ["for sell"], scope: "file" };
    expect(correctText("up for sell", [rule], opts).text).toBe("up for sell");
  });

  test("without a dictionary only call-scoped pairs apply (fail safe)", () => {
    const call: VocabRule = { term: "Anika", heard: ["annika"], scope: "call" };
    const r = correctText("kubernetis and annika", [k8s, call]);
    expect(r.text).toBe("kubernetis and Anika");
  });

  test("a rule restricted to some segments applies only there", () => {
    const rule: VocabRule = { term: "Anika", heard: ["annika"], scope: "call", segs: ["l000003"] };
    expect(correctText("annika", [rule], { segId: "l000003" }).text).toBe("Anika");
    expect(correctText("annika", [rule], { segId: "l000004" }).text).toBe("annika");
    expect(correctText("annika", [rule]).text).toBe("annika");
  });

  test("Jaro-Winkler matches the textbook values", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler("same", "same")).toBe(1);
    expect(jaroWinkler("", "x")).toBe(0);
  });

  test("fuzzy: terms without heard forms match tokens of 4+ characters at >= 0.92", () => {
    const rule: VocabRule = { term: "Anneliese", heard: [], scope: "file" };
    expect(jaroWinkler("anneliese", "annelise")).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
    const r = correctText("ask annelise about it", [rule], opts);
    expect(r.annotated).toBe('ask Anneliese (heard: "annelise") about it');
    expect(r.corrections[0]?.kind).toBe("fuzzy");
    // Below the threshold nothing happens.
    expect(jaroWinkler("anneliese", "anna")).toBeLessThan(FUZZY_THRESHOLD);
    expect(correctText("ask anna", [rule], opts).corrections).toEqual([]);
  });

  test("fuzzy: tokens under 4 characters are never touched", () => {
    const rule: VocabRule = { term: "Anna", heard: [], scope: "name" };
    // Similar enough, but only 3 characters long.
    expect(jaroWinkler("ana", "anna")).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
    expect(correctText("ana", [rule], opts).corrections).toEqual([]);
    // Positive control: a 4-character token at the same similarity is corrected.
    expect(correctText("annaa", [rule], opts).text).toBe("Anna");
  });

  test("fuzzy: a token that already is the term (case aside) is not a correction", () => {
    const rule: VocabRule = { term: "Kubernetes", heard: [], scope: "file" };
    expect(correctText("kubernetes", [rule], opts).corrections).toEqual([]);
  });

  test("fuzzy: speaker names are matched too", () => {
    const rule: VocabRule = { term: "Siobhan", heard: [], scope: "name" };
    expect(correctText("thanks siobahn", [rule], opts).text).toBe("thanks Siobhan");
  });

  test("[spike] A vocabulary entry never inserts a term where nothing similar was said", () => {
    const rules: VocabRule[] = [
      k8s,
      { term: "Mary", heard: [], scope: "name" },
      { term: "Clauds", heard: [], scope: "file" },
      { term: "Linear", heard: [], scope: "file" },
      { term: "Vessl", heard: ["vessel"], scope: "file" },
      { term: "Anika", heard: ["annika"], scope: "call" },
    ];
    // Control sentences: sound-alikes and real words, no listed term said.
    const controls = [
      "they will marry in the spring",
      "the clouds are low over the harbour",
      "a linear cluster of containers",
      "the vessel is running",
      "carry the cable to the box",
      "annie can take it",
    ];
    for (const s of controls) {
      const r = correctText(s, rules, opts);
      expect(r.corrections).toEqual([]);
      expect(r.text).toBe(s);
    }
    // Positive control: a sentence that does contain a heard form is corrected by the same
    // rules, so the zero above is not an empty rule set passing trivially.
    expect(correctText("the kubernetis cluster", rules, opts).corrections).toHaveLength(1);
  });
});
