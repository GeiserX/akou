/**
 * The word lists behind read-time vocabulary correction (docs/DESIGN.md section 5.4): which words
 * are real words, per language, so a file pair on a real word is skipped and a file pair on a
 * mishearing applies. Without them the running app could only apply call-scoped pairs.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import config, { MAIN_OUT } from "../electrobun.config.ts";
import { pack, wordList } from "../scripts/build-dictionaries.ts";
import { foldText, heardFormApplies } from "../src/core/vocab/correct.ts";
import {
  callLanguages,
  DICTIONARIES_DIR,
  DICTIONARY_LANGUAGES,
  Dictionaries,
  languageCode,
  readWordList,
} from "../src/main/vocab/dictionary.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");

describe("the bundled word lists", () => {
  test("English and Spanish ship, each a large folded list", () => {
    expect(DICTIONARY_LANGUAGES).toEqual(expect.arrayContaining(["en", "es"]));
    for (const lang of DICTIONARY_LANGUAGES) {
      const words = readWordList(lang);
      expect(words.size).toBeGreaterThan(40_000);
      // Stored the way the fold compares: lowercase with the accents off.
      for (const w of [...words].slice(0, 2000)) expect(w).toBe(foldText(w));
    }
  });

  test("real words are in, mishearings and product names are out", () => {
    const en = readWordList("en");
    const es = readWordList("es");
    for (const w of ["the", "world", "deploy", "meeting"]) expect(en.has(w)).toBe(true);
    // "reunión" and "también" are stored folded.
    for (const w of ["reunion", "tambien", "mundo", "equipo"]) expect(es.has(w)).toBe(true);
    for (const w of ["kubernetis", "hetzna", "kubernetes"]) {
      expect(en.has(w)).toBe(false);
      expect(es.has(w)).toBe(false);
    }
    // Positive control: the lists differ, so choosing the language matters.
    expect(es.has("tambien")).toBe(true);
    expect(en.has("tambien")).toBe(false);
  });

  test("the committed files are exactly what the build script writes from a list", () => {
    expect(wordList("Don't 50\nCafé 30\ncafe 10\n\n")).toEqual(["cafe", "don", "t"]);
    const bytes = pack(["a", "b"]);
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe("a\nb\n");
  });
});

describe("choosing the lists for a call", () => {
  test("language tags reduce to their primary code", () => {
    expect(languageCode("en")).toBe("en");
    expect(languageCode("es-ES")).toBe("es");
    expect(languageCode("<|EN|>")).toBe("en");
  });

  test("empty setting: every bundled list; a set one adds the languages the call detected", () => {
    expect(callLanguages([], [])).toEqual([...DICTIONARY_LANGUAGES].sort());
    expect(callLanguages(["en"], [])).toEqual(["en"]);
    expect(callLanguages(["en"], ["es-ES", "de"])).toEqual(["en", "es"]);
    // A detected language with no list is ignored rather than failing.
    expect(callLanguages(["es"], ["xx"])).toEqual(["es"]);
  });

  test("one predicate per language set, loaded lazily and shared", () => {
    const d = new Dictionaries();
    expect(d.loaded()).toEqual([]);
    const en = d.predicate(["en"]);
    expect(d.loaded()).toEqual(["en"]);
    expect(en?.("world")).toBe(true);
    expect(en?.("tambien")).toBe(false);
    const both = d.predicate(["es", "en"]);
    expect(d.predicate(["en", "es"])).toBe(both);
    expect(both?.("tambien")).toBe(true);
    expect(both?.("world")).toBe(true);
    expect(both?.("kubernetis")).toBe(false);
  });

  test("a missing list is reported and never fatal: with nothing readable there is no predicate", () => {
    const t = tempDir();
    const errors: string[] = [];
    const d = new Dictionaries(t.dir, (m) => errors.push(m));
    expect(d.predicate(["en"])).toBeUndefined();
    expect(errors.join("\n")).toMatch(/en/);
    // Without a predicate a file pair never applies (fail safe), with one it does.
    expect(heardFormApplies("kubernetis", "file", d.predicate(["en"]))).toBe(false);
    expect(heardFormApplies("kubernetis", "file", new Dictionaries().predicate(["en"]))).toBe(true);
    t.cleanup();
  });
});

describe("the lists ship with the app", () => {
  test("the bundle copies the lists beside the main process, where the bundled module looks", async () => {
    const rel = "src/main/vocab/dictionaries";
    expect(existsSync(join(ROOT, rel))).toBe(true);
    expect(DICTIONARIES_DIR.replaceAll("\\", "/").endsWith(rel)).toBe(true);
    expect(config.build?.copy?.[rel]).toBe(`${MAIN_OUT}/dictionaries`);

    // Bundle the module the way the release does, copy the lists as the config says, and load one
    // with a Bun that lives elsewhere.
    const t = tempDir();
    const entry = join(t.dir, "entry.ts");
    await Bun.write(
      entry,
      `import { readWordList } from ${JSON.stringify(join(ROOT, "src/main/vocab/dictionary.ts"))};
console.log(JSON.stringify(readWordList("es").has("tambien")));`,
    );
    const built = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm" });
    expect(built.success).toBe(true);
    const out = join(t.dir, MAIN_OUT);
    await Bun.write(join(out, "index.js"), built.outputs[0] as Blob);
    const run = () => Bun.spawnSync([process.execPath, join(out, "index.js")]);
    // Positive control: without the copy the bundled module cannot find its list.
    expect(run().exitCode).not.toBe(0);
    cpSync(join(ROOT, rel), join(t.dir, config.build?.copy?.[rel] as string), { recursive: true });
    const r = run();
    expect(r.stdout.toString().trim()).toBe("true");
    t.cleanup();
  });

  test("the app smoke check requires the lists and NOTICE credits their source", () => {
    const smoke = readFileSync(join(ROOT, "scripts", "smoke-app.ts"), "utf8");
    expect(smoke).toContain("dictionaries/");
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
    expect(notice).toContain("FrequencyWords");
    expect(notice).toContain("CC BY-SA 4.0");
  });
});
