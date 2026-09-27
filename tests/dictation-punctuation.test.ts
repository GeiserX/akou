/**
 * Spoken punctuation (docs/ux/DICTATION.md DC-S6): a phrase from the list becomes its mark only
 * where it stands alone between pauses, or at the very end with an engine that gives no word
 * times; `dictation.spokenPunctuation` off replaces nothing; a user's file replaces a language.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PAUSE_SECONDS,
  SPOKEN_PUNCTUATION,
  spokenPunctuation,
  type TimedWord,
} from "../src/core/dictation/punctuation.ts";
import { loadPunctuation, PUNCTUATION_FILE } from "../src/main/dictation/punctuation.ts";
import { type DictationEngine, decodeDictation } from "../src/main/dictation/session.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/**
 * Timed words from a script: words 0.3 s long, 0.05 s apart; `|` is a pause of 0.6 s. The words
 * are what the engine heard, without its punctuation.
 */
function timed(script: string): TimedWord[] {
  const out: TimedWord[] = [];
  let t = 0;
  for (const part of script.split(/\s+/)) {
    if (part === "|") {
      t += 0.6;
      continue;
    }
    out.push({ w: part, s: t, e: t + 0.3 });
    t += 0.35;
  }
  return out;
}

describe("DC-S6: a phrase between pauses is a mark", () => {
  const table: [string, string, string, string][] = [
    // [language, engine text, what was said with its pauses, expected]
    ["en", "Hello, comma, world.", "hello | comma | world", "Hello, world."],
    ["en", "Is it done? Question mark.", "is it done | question mark", "Is it done?"],
    ["en", "We ship today period", "we ship today | period", "We ship today."],
    ["en", "Dear team new line thanks", "dear team | new line | thanks", "Dear team\nThanks"],
    ["es", "Hola coma qué tal", "hola | coma | qué tal", "Hola, qué tal"],
    ["es", "Hasta mañana. Punto.", "hasta mañana | punto", "Hasta mañana."],
    ["es", "Vale nueva línea gracias", "vale | nueva línea | gracias", "Vale\nGracias"],
    ["es", "Vienes signo de interrogacion", "vienes | signo de interrogación", "Vienes?"],
  ];
  for (const [lang, text, said, want] of table) {
    test(`${lang}: "${said}" → ${JSON.stringify(want)}`, () => {
      expect(spokenPunctuation(text, timed(said), [lang])).toBe(want);
    });
  }

  test('"new paragraph" between two sentences with a pause yields two newlines', () => {
    const said = timed("first sentence | new paragraph | second sentence");
    expect(spokenPunctuation("First sentence. New paragraph. Second sentence.", said, ["en"])).toBe(
      "First sentence.\n\nSecond sentence.",
    );
  });

  test('"a comma splice is bad", said in one breath, is unchanged', () => {
    const text = "A comma splice is bad.";
    expect(spokenPunctuation(text, timed("a comma splice is bad"), ["en"])).toBe(text);
  });

  test("a pause on one side only is a word, not a mark", () => {
    const text = "The period ended";
    expect(spokenPunctuation(text, timed("the | period ended"), ["en"])).toBe(text);
    expect(spokenPunctuation(text, timed("the period | ended"), ["en"])).toBe(text);
  });

  test("positive control: the same words with the pause on both sides are a mark", () => {
    expect(spokenPunctuation("The period ended", timed("the | period | ended"), ["en"])).toBe(
      "The. Ended",
    );
  });

  test("a phrase that opens the utterance is left alone: there is nothing before it", () => {
    expect(spokenPunctuation("Comma hello", timed("comma | hello"), ["en"])).toBe("Comma hello");
  });

  test(`the pause is ${PAUSE_SECONDS} s: just under it is no pause`, () => {
    const words: TimedWord[] = [
      { w: "hello", s: 0, e: 0.4 },
      { w: "comma", s: 0.4 + PAUSE_SECONDS - 0.01, e: 1 },
      { w: "world", s: 1 + PAUSE_SECONDS, e: 1.8 },
    ];
    expect(spokenPunctuation("hello comma world", words, ["en"])).toBe("hello comma world");
    words[1] = { w: "comma", s: 0.4 + PAUSE_SECONDS, e: 1 };
    expect(spokenPunctuation("hello comma world", words, ["en"])).toBe("hello, world");
  });

  test("gated by language: a Spanish list does not take the English word", () => {
    const said = timed("hello | comma | world");
    expect(spokenPunctuation("hello comma world", said, ["es"])).toBe("hello comma world");
    // Nothing known: every list applies, still only between pauses.
    expect(spokenPunctuation("hello comma world", said, [])).toBe("hello, world");
  });

  test("a known language with no list replaces nothing, not every list", () => {
    const said = timed("il est dans le | coma");
    expect(spokenPunctuation("il est dans le coma", said, ["fr"])).toBe("il est dans le coma");
    expect(spokenPunctuation("il est dans le coma", [], ["fr"])).toBe("il est dans le coma");
  });

  test("the vocabulary changed the count: that phrase is left alone", () => {
    // The engine heard "comma" twice, the first alone; the vocabulary made that one "Karma", so
    // the one left in the text is the second, said in one breath.
    const said = timed("hello | comma | world comma");
    expect(spokenPunctuation("hello Karma world comma", said, ["en"])).toBe(
      "hello Karma world comma",
    );
  });
});

describe("DC-S6: an engine with no word times", () => {
  test('"ese es el punto de hoy" is unchanged', () => {
    const text = "Ese es el punto de hoy.";
    expect(spokenPunctuation(text, [], ["es"])).toBe(text);
  });

  test('"hasta mañana punto" ends in a period', () => {
    expect(spokenPunctuation("hasta mañana punto", [], ["es"])).toBe("hasta mañana.");
    expect(spokenPunctuation("Hasta mañana punto.", [], ["es"])).toBe("Hasta mañana.");
  });

  test("only the phrase at the very end: one earlier stays a word", () => {
    expect(spokenPunctuation("El punto es este punto", [], ["es"])).toBe("El punto es este.");
  });

  test("a phrase that is the whole utterance stays a word", () => {
    expect(spokenPunctuation("punto", [], ["es"])).toBe("punto");
  });
});

describe("DC-S6 in a dictation", () => {
  const engine: DictationEngine = {
    name: "fast",
    decode: async () => ({
      text: "Hello, comma, world.",
      words: timed("hello | comma | world").map((w) => ({ ...w, c: 1 })),
      language: null,
      model: "stub",
      ms: 1,
      spans: 1,
    }),
  };
  const samples = new Float32Array(16000);

  test("on: the inserted text has the mark, and the raw text is kept", async () => {
    const r = await decodeDictation(
      { punctuation: () => SPOKEN_PUNCTUATION, languages: () => ["en"] },
      engine,
      samples,
      undefined,
    );
    expect(r).toMatchObject({
      kind: "text",
      text: "Hello, world.",
      d: { text: "Hello, comma, world." },
    });
  });

  test("positive control for the switch: off (the default) replaces nothing", async () => {
    const r = await decodeDictation(
      { punctuation: () => null, languages: () => ["en"] },
      engine,
      samples,
      undefined,
    );
    expect(r).toMatchObject({ kind: "text", text: "Hello, comma, world." });
  });

  test("a password field gets exactly what was heard", async () => {
    const r = await decodeDictation(
      { punctuation: () => SPOKEN_PUNCTUATION },
      engine,
      samples,
      undefined,
      true,
    );
    expect(r).toMatchObject({ kind: "text", text: "Hello, comma, world." });
  });

  test("a broken lists file inserts the text as it was and says why", async () => {
    const logs: string[] = [];
    const r = await decodeDictation(
      {
        punctuation: () => {
          throw new Error(`${PUNCTUATION_FILE}: bad`);
        },
        onLog: (_l, m) => logs.push(m),
      },
      engine,
      samples,
      undefined,
    );
    expect(r).toMatchObject({ kind: "text", text: "Hello, comma, world." });
    expect(logs).toEqual([`dictation: spoken punctuation not applied: ${PUNCTUATION_FILE}: bad`]);
  });
});

describe("DC-S6: the lists are a file the user can override", () => {
  function dir(): string {
    const t = tempDir("akou-dict-punct-");
    cleanups.push(t.cleanup);
    return t.dir;
  }

  test("with no file, the shipped lists", () => {
    expect(loadPunctuation(dir())).toBe(SPOKEN_PUNCTUATION);
  });

  test("a language in the file replaces the shipped list; the others stay", () => {
    const d = dir();
    writeFileSync(join(d, PUNCTUATION_FILE), JSON.stringify({ en: { "full stop": "." } }));
    const lists = loadPunctuation(d);
    expect(lists.en).toEqual({ "full stop": "." });
    expect(lists.es).toEqual(SPOKEN_PUNCTUATION.es as Record<string, string>);
    const said = timed("we are done | full stop");
    expect(spokenPunctuation("We are done full stop", said, ["en"], lists)).toBe("We are done.");
    // "period" is the user's word again.
    expect(
      spokenPunctuation("We are done period", timed("we are done | period"), ["en"], lists),
    ).toBe("We are done period");
  });

  test("a file that is not the shape is refused, naming it", () => {
    const d = dir();
    writeFileSync(join(d, PUNCTUATION_FILE), JSON.stringify({ en: ["comma"] }));
    expect(() => loadPunctuation(d)).toThrow(PUNCTUATION_FILE);
    writeFileSync(join(d, PUNCTUATION_FILE), "{ not json");
    expect(() => loadPunctuation(d)).toThrow(PUNCTUATION_FILE);
  });
});
