/**
 * The word lists behind read-time vocabulary correction (docs/DESIGN.md section 5.4): which words
 * are real words, per language, so a file pair on a real word is skipped and a file pair on a
 * mishearing applies. Without them the running app could only apply call-scoped pairs.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import config, { MAIN_OUT } from "../electrobun.config.ts";
import { pack, unpack, wordList } from "../scripts/build-dictionaries.ts";
import { foldText, heardFormApplies, tokenize } from "../src/core/vocab/correct.ts";
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

  test("the build script folds, splits, deduplicates and sorts a frequency list", () => {
    expect(wordList("Don't 50\nCafé 30\ncafe 10\n\n")).toEqual(["cafe", "don", "t"]);
    expect(unpack(pack(["a", "b"]))).toBe("a\nb\n");
  });

  /**
   * What the build script guarantees of any list it writes, checked on a packed list: one folded
   * transcript token per line, sorted, no repeats, newline-terminated. (The release also runs
   * `scripts/build-dictionaries.ts --check` against the pinned source, which needs the network.)
   */
  function listProblems(bytes: Uint8Array<ArrayBuffer>): string[] {
    const text = unpack(bytes);
    const words = text.split("\n").slice(0, -1);
    const out: string[] = [];
    if (!text.endsWith("\n")) out.push("not newline-terminated");
    if (words.some((w) => w === "")) out.push("an empty line");
    const bad = words.filter((w) => {
      const t = tokenize(w);
      return w !== foldText(w) || t.length !== 1 || t[0]?.folded !== w;
    });
    if (bad.length > 0) out.push(`not a folded token: ${bad.slice(0, 3).join(", ")}`);
    for (let i = 1; i < words.length; i++) {
      const [a, b] = [words[i - 1] as string, words[i] as string];
      if (a === b) out.push(`repeated: ${a}`);
      else if (a > b) out.push(`out of order: ${a} before ${b}`);
      if (out.length > 5) break;
    }
    return out;
  }

  test("the committed lists hold what the build script writes: folded tokens, sorted, once each", () => {
    for (const lang of DICTIONARY_LANGUAGES) {
      const bytes = readFileSync(join(DICTIONARIES_DIR, `${lang}.txt.gz`));
      expect({ lang, problems: listProblems(bytes) }).toEqual({ lang, problems: [] });
    }
    // Positive controls: a hand edit of each kind is caught.
    expect(listProblems(pack(["a", "b"]))).toEqual([]);
    expect(listProblems(pack(["b", "a"]))).toEqual(["out of order: b before a"]);
    expect(listProblems(pack(["a", "a"]))).toEqual(["repeated: a"]);
    expect(listProblems(pack(["Café"]))[0]).toStartWith("not a folded token");
    expect(listProblems(pack(["don't"]))[0]).toStartWith("not a folded token");
    expect(listProblems(Bun.gzipSync(new TextEncoder().encode("a\nb")))).toEqual([
      "not newline-terminated",
    ]);
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

  test("a failed read is not cached: the list is read again once it can be", () => {
    const t = tempDir();
    const d = new Dictionaries(t.dir);
    expect(d.predicate(["en"])).toBeUndefined();
    expect(d.loaded()).toEqual([]);
    // The read failed for a passing reason (here the file was not there yet); it is now readable.
    cpSync(join(DICTIONARIES_DIR, "en.txt.gz"), join(t.dir, "en.txt.gz"));
    const en = d.predicate(["en"]);
    expect(en?.("world")).toBe(true);
    expect(d.loaded()).toEqual(["en"]);
    t.cleanup();
  });

  test("a predicate built while one list was unreadable is not kept for that language set", () => {
    const t = tempDir();
    cpSync(join(DICTIONARIES_DIR, "en.txt.gz"), join(t.dir, "en.txt.gz"));
    const d = new Dictionaries(t.dir);
    const partial = d.predicate(["en", "es"]);
    expect(partial?.("world")).toBe(true);
    expect(partial?.("tambien")).toBe(false);
    cpSync(join(DICTIONARIES_DIR, "es.txt.gz"), join(t.dir, "es.txt.gz"));
    const whole = d.predicate(["en", "es"]);
    expect(whole?.("tambien")).toBe(true);
    // Once every list is read, the predicate is shared again.
    expect(d.predicate(["es", "en"])).toBe(whole);
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

  test("NOTICE and LICENSE travel with the app and the CLI archive, and their checks require them", () => {
    // CC BY-SA 4.0 (section 3(a)) wants the credit and the licence notice to go with the lists.
    for (const f of ["NOTICE", "LICENSE"] as const) {
      expect(config.build?.copy?.[f]).toBe(`${MAIN_OUT}/${f}`);
      expect(existsSync(join(ROOT, f))).toBe(true);
    }
    const smokeApp = readFileSync(join(ROOT, "scripts", "smoke-app.ts"), "utf8");
    expect(smokeApp).toMatch(/"NOTICE",\s*"LICENSE"/);
    const buildCli = readFileSync(join(ROOT, "scripts", "build-cli.ts"), "utf8");
    expect(buildCli).toContain('copyFileSync(join(ROOT, "NOTICE"), join(dir, "NOTICE"))');
    const smokeCli = readFileSync(join(ROOT, "scripts", "smoke-cli.ts"), "utf8");
    expect(smokeCli).toMatch(/\["LICENSE", "NOTICE"\]/);
  });

  test("the app smoke check requires the lists and NOTICE credits their source", () => {
    const smoke = readFileSync(join(ROOT, "scripts", "smoke-app.ts"), "utf8");
    expect(smoke).toContain("dictionaries/");
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
    expect(notice).toContain("FrequencyWords");
    expect(notice).toContain("CC BY-SA 4.0");
  });
});
