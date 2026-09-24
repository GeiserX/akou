import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fold } from "../src/core/log/fold.ts";
import {
  buildDecodeList,
  DECODE_CAP,
  DEFAULT_BOOST,
  hotwordsArg,
  modelKind,
  vocabUsedDraft,
} from "../src/main/vocab/decode-list.ts";
import {
  defaultConfigDir,
  emptyVocab,
  importGlossary,
  MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_HEARD,
  MAX_NOTE_LENGTH,
  MAX_TERM_LENGTH,
  type MergedEntry,
  mergeVocab,
  parseVocab,
  readVocabFile,
  removeEntry,
  serializeVocab,
  toFoldEntries,
  upsertEntry,
  type VocabEntry,
  type VocabFile,
  validateTerm,
  validWorkspace,
  vocabPaths,
  writeVocabFile,
} from "../src/main/vocab/files.ts";
import { isDictionaryWord, LogBuilder, T0, tempDir } from "./helpers.ts";

const PARAKEET = "parakeet-tdt-0.6b-v3-int8";
const entry = (term: string, extra: Partial<VocabEntry> = {}): VocabEntry => ({
  term,
  heard: [],
  source: "user",
  confirmed: true,
  added_at: "2026-09-23",
  ...extra,
});
const file = (...entries: VocabEntry[]): VocabFile => ({ ...emptyVocab(), entries });
const merged = (scope: MergedEntry["scope"], ...entries: VocabEntry[]): MergedEntry[] =>
  entries.map((e) => ({ ...e, scope, file: `${scope}.yaml` }));

describe("vocabulary files: format (REQUIREMENTS V1)", () => {
  test("a file with every field round-trips exactly", () => {
    const f: VocabFile = {
      version: 1,
      entries: [
        entry("Kubernetes", { heard: ["kubernetis", "cubernetes"] }),
        entry("iroh", { heard: ["irah"], source: "call:01J8Z6Q4M2VX0K7B3D4E5F6G7H", decode: 5 }),
        entry("Tauri", { heard: ["tori"], source: "docs:README.md", decode: false }),
        entry("Anika", {
          confirmed: false,
          source: "calendar",
          note: 'attendee of the "weekly" sync',
        }),
      ],
      rejected: ["Foo"],
    };
    const text = serializeVocab(f);
    expect(text.startsWith("# akou vocabulary, version 1\nversion: 1\nentries:\n")).toBe(true);
    const back = parseVocab(text);
    expect(back.errors).toEqual([]);
    expect(back.file).toEqual(f);
    expect(serializeVocab(back.file)).toBe(text);
    expect(serializeVocab(emptyVocab())).toBe(
      "# akou vocabulary, version 1\nversion: 1\nentries: []\n",
    );
  });

  test("[design] A YAML term turns into a boolean: the writer quotes every string and the reader gets a string back", () => {
    const tricky = [
      "No",
      "On",
      "Yes",
      "true",
      "null",
      "~ tilde",
      "123",
      "1e3",
      "a: b",
      "# hash",
      'it\'s "x"',
      "Café",
      "किताब",
      "- dash",
    ];
    const f = file(...tricky.map((t) => entry(t, { heard: [`${t} x`] })));
    const back = parseVocab(serializeVocab(f));
    expect(back.errors).toEqual([]);
    expect(back.file.entries.map((e) => e.term)).toEqual(tricky);
    for (const e of back.file.entries) expect(typeof e.term).toBe("string");
  });

  test("positive control: an unquoted `true` reads back as a boolean, and the reader refuses it", () => {
    const hand =
      'version: 1\nentries:\n  - term: true\n    heard: []\n    source: "user"\n    confirmed: true\n    added_at: "2026-09-23"\n';
    const doc = Bun.YAML.parse(hand) as { entries: { term: unknown }[] };
    expect(typeof doc.entries[0]?.term).toBe("boolean");
    const r = parseVocab(hand);
    expect(r.file.entries).toEqual([]);
    expect(r.errors[0]?.message).toContain("quoted string");
  });

  test("validation skips a bad entry and keeps the rest", () => {
    const text = [
      "version: 1",
      "entries:",
      '  - {term: "Good", heard: [], source: "user", confirmed: true, added_at: "2026-09-23"}',
      '  - {term: "BadSource", heard: [], source: "someone", confirmed: true, added_at: "2026-09-23"}',
      '  - {term: "BadDate", heard: [], source: "user", confirmed: true, added_at: "2026-02-30"}',
      '  - {term: "Typo", heard: [], source: "user", confirmed: true, added_at: "2026-09-23", boost: 4}',
      '  - {term: "good", heard: [], source: "user", confirmed: true, added_at: "2026-09-23"}',
      '  - {term: "Self", heard: ["self", "slf"], source: "user", confirmed: true, added_at: "2026-09-23"}',
    ].join("\n");
    const r = parseVocab(text);
    expect(r.file.entries.map((e) => e.term)).toEqual(["Good", "Self"]);
    expect(r.file.entries[1]?.heard).toEqual(["slf"]);
    expect(r.errors.map((e) => e.entry)).toEqual([1, 2, 3, 4]);
    expect(r.warnings).toHaveLength(1);
    expect(parseVocab("version: 2\nentries: []").errors[0]?.message).toContain("version");
    expect(parseVocab("entries: [").errors[0]?.message).toContain("not valid YAML");
    expect(parseVocab("").file).toEqual(emptyVocab());
  });

  test("[spike] The boost is a slider: per-entry boosts are whole numbers 1 to 5, the default is the constant 3", () => {
    expect(DEFAULT_BOOST).toBe(3);
    const row = (d: string) =>
      `version: 1\nentries:\n  - {term: "X", heard: [], source: "user", confirmed: true, added_at: "2026-09-23", decode: ${d}}`;
    expect(parseVocab(row("5")).file.entries[0]?.decode).toBe(5);
    expect(parseVocab(row("false")).file.entries[0]?.decode).toBe(false);
    for (const bad of ["9", "0", "2.5", '"3"']) expect(parseVocab(row(bad)).errors).toHaveLength(1);
  });

  test("terms are validated for the CLI (exit 65)", () => {
    expect(validateTerm("Kubernetes")).toBeNull();
    expect(validateTerm("")).not.toBeNull();
    expect(validateTerm(" padded")).not.toBeNull();
    expect(validateTerm("two\nlines")).not.toBeNull();
    expect(validateTerm("...")).not.toBeNull();
    expect(validateTerm("x".repeat(101))).not.toBeNull();
  });
});

describe("vocabulary files: on disk", () => {
  test("paths per scope, and a workspace name that could leave the folder is refused", () => {
    expect(defaultConfigDir({}, "darwin", "/home/u")).toBe(join("/home/u", ".config", "akou"));
    expect(
      defaultConfigDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"),
    ).toBe(join("C:\\Users\\u\\AppData\\Roaming", "akou"));
    expect(
      vocabPaths({ configDir: "/c", workspace: "work", extra: ["/repo/vocabulary.yaml"] }),
    ).toEqual([
      { scope: "global", path: join("/c", "vocabulary.yaml") },
      { scope: "workspace", path: join("/c", "vocabulary", "work.yaml") },
      { scope: "extra", path: "/repo/vocabulary.yaml" },
    ]);
    for (const bad of ["../x", "a/b", "..", ""])
      expect(() => vocabPaths({ configDir: "/c", workspace: bad })).toThrow();
  });

  test("a workspace named after a Windows device (CON, NUL, COM1, ...) is refused on every platform", () => {
    for (const bad of ["con", "CON", "nul", "Aux", "prn", "com1", "COM9", "lpt3", "con.notes"]) {
      expect(validWorkspace(bad)).toBe(false);
    }
    // Positive control: names that only start like a device are fine.
    for (const ok of ["console", "conference", "com", "com10", "lpt", "nullable", "work"]) {
      expect(validWorkspace(ok)).toBe(true);
    }
  });

  test("write is atomic and reads back; a missing file is an empty list; the hash is of the bytes", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "vocabulary", "work.yaml");
      const missing = await readVocabFile(path);
      expect(missing).toMatchObject({ exists: false, sha256: "", errors: [] });
      const f = file(entry("Kubernetes", { heard: ["kubernetis"] }));
      const hash = await writeVocabFile(path, f);
      const r = await readVocabFile(path);
      expect(r.exists).toBe(true);
      expect(r.file).toEqual(f);
      expect(r.sha256).toBe(hash);
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      // A hand edit is read as written.
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace('"kubernetis"', '"kubernetis", "cubernetes"'),
      );
      expect((await readVocabFile(path)).file.entries[0]?.heard).toEqual([
        "kubernetis",
        "cubernetes",
      ]);
    } finally {
      cleanup();
    }
  });

  test("the writer refuses a file that would not read back", async () => {
    const { dir, cleanup } = tempDir();
    try {
      await expect(writeVocabFile(join(dir, "v.yaml"), file(entry("")))).rejects.toThrow(
        "refusing",
      );
    } finally {
      cleanup();
    }
  });

  test("the writer refuses a file that reads back as something else, not only one with errors", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "v.yaml");
      // A heard form equal to the term is dropped on read, with only a warning.
      const selfHeard = file(entry("Kubernetes", { heard: ["Kubernetes", "kubernetis"] }));
      await expect(writeVocabFile(path, selfHeard)).rejects.toThrow("refusing");
      const padded = file(entry("Vercel", { heard: [" versal"] }));
      await expect(writeVocabFile(path, padded)).rejects.toThrow("refusing");
      // Positive control: the same entries without the difference are written.
      await writeVocabFile(path, file(entry("Kubernetes", { heard: ["kubernetis"] })));
      expect((await readVocabFile(path)).file.entries[0]?.heard).toEqual(["kubernetis"]);
    } finally {
      cleanup();
    }
  });

  test("size limits: the file, heard forms, notes and the entry count are capped with an error", async () => {
    const long = "k".repeat(MAX_TERM_LENGTH + 1);
    const heard = parseVocab(serializeVocab(file(entry("Kubernetes", { heard: [long] }))));
    expect(heard.file.entries).toEqual([]);
    expect(heard.errors[0]?.message).toContain("heard form");
    const note = parseVocab(
      serializeVocab(file(entry("Kubernetes", { note: "n".repeat(MAX_NOTE_LENGTH + 1) }))),
    );
    expect(note.file.entries).toEqual([]);
    expect(note.errors[0]?.message).toContain("note");
    const many = file(...Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => entry(`term${i}`)));
    const capped = parseVocab(serializeVocab(many));
    expect(capped.file.entries).toHaveLength(MAX_ENTRIES);
    expect(capped.errors.some((e) => e.message.includes(`${MAX_ENTRIES} entries`))).toBe(true);
    const forms = parseVocab(
      serializeVocab(
        file(
          entry("Kubernetes", { heard: Array.from({ length: MAX_HEARD + 1 }, (_, i) => `k${i}`) }),
        ),
      ),
    );
    expect(forms.file.entries).toEqual([]);
    expect(forms.errors[0]?.message).toContain("heard forms");
    const big = parseVocab(`# ${"x".repeat(MAX_FILE_BYTES)}\nversion: 1\nentries: []\n`);
    expect(big.errors[0]?.message).toContain("too large");
    // The reader checks the size before reading the file.
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "big.yaml");
      writeFileSync(path, `# ${"x".repeat(MAX_FILE_BYTES)}\n`);
      const r = await readVocabFile(path);
      expect(r.exists).toBe(true);
      expect(r.errors[0]?.message).toContain("too large");
      expect(r.file.entries).toEqual([]);
    } finally {
      cleanup();
    }
    // Positive control: at the limits everything loads.
    const edge = parseVocab(
      serializeVocab(
        file(
          entry("Kubernetes", {
            heard: ["k".repeat(MAX_TERM_LENGTH)],
            note: "n".repeat(MAX_NOTE_LENGTH),
          }),
        ),
      ),
    );
    expect(edge.errors).toEqual([]);
    expect(edge.file.entries).toHaveLength(1);
  });
});

describe("vocabulary files: merging and editing", () => {
  test("an extra file wins over the workspace, which wins over the global file, on the same term", () => {
    const m = mergeVocab([
      {
        scope: "global",
        path: "g",
        file: file(entry("Vercel", { heard: ["versal"] }), entry("Ana")),
      },
      { scope: "workspace", path: "w", file: file(entry("vercel", { heard: ["vercell"] })) },
      { scope: "extra", path: "x", file: file(entry("VERCEL", { heard: ["versel"] })) },
    ]);
    expect(m.map((e) => [e.term, e.scope, e.heard.join()])).toEqual([
      ["VERCEL", "extra", "versel"],
      ["Ana", "global", ""],
    ]);
  });

  test("upsert replaces in place and remove drops by folded term", () => {
    let f = file(entry("A"), entry("Béta"), entry("C"));
    f = upsertEntry(f, entry("beta", { heard: ["bayta"] }));
    expect(f.entries.map((e) => e.term)).toEqual(["A", "beta", "C"]);
    f = upsertEntry(f, entry("D"));
    f = removeEntry(f, "BETA");
    expect(f.entries.map((e) => e.term)).toEqual(["A", "C", "D"]);
  });

  test("[decision] An unconfirmed entry does something: it neither corrects nor enters the decode list", () => {
    const build = (confirmed: boolean) => {
      const m = mergeVocab([
        {
          scope: "workspace",
          path: "w",
          file: file(entry("Kubernetes", { heard: ["kubernetis"], confirmed })),
        },
      ]);
      const b = new LogBuilder();
      b.created();
      b.partStarted(1, T0);
      b.seg({ id: "l000001", text: "we deploy on kubernetis" });
      const view = fold(b.events, { vocabFiles: toFoldEntries(m), isDictionaryWord });
      const list = buildDecodeList({ model: PARAKEET, callVocab: [], names: [], files: m });
      return { text: view.lines()[0]?.text, terms: list.entries.map((e) => e.term) };
    };
    expect(build(false)).toEqual({ text: "we deploy on kubernetis", terms: [] });
    // Positive control: the same entry, confirmed, does both.
    expect(build(true)).toEqual({ text: "we deploy on Kubernetes", terms: ["Kubernetes"] });
  });
});

describe("importing the older list formats", () => {
  test("`Canonical <= variant | variant  # comment`, CAUTION lines and plain names", () => {
    const text = [
      "# old glossary",
      "",
      "Kubernetes <= kubernetis | cubernetes  # infra",
      "Vercel <= versal|vercell",
      "Tauri <= tori | tory  # CAUTION: common word",
      "Anika Ruiz",
      "vercel <= versel",
      "Self <= self",
      "<= orphan",
    ].join("\n");
    const r = importGlossary(text, { source: "import:glossary.txt", date: "2026-09-24" });
    expect(r.entries.map((e) => [e.term, e.heard, e.decode, e.note])).toEqual([
      ["Kubernetes", ["kubernetis", "cubernetes"], undefined, "infra"],
      ["Vercel", ["versal", "vercell", "versel"], undefined, undefined],
      ["Tauri", [], false, "CAUTION: common word"],
      ["Anika Ruiz", [], undefined, undefined],
      ["Self", [], undefined, undefined],
    ]);
    expect(r.entries.every((e) => e.confirmed && e.source === "import:glossary.txt")).toBe(true);
    expect(r.skipped.map((s) => s.line)).toEqual([9]);
    expect(
      importGlossary("X <= y # do not auto", { source: "import:f", date: "2026-09-24" }).entries[0],
    ).toMatchObject({ heard: [], decode: false });
    // A `#` inside a term is part of it; only a `#` after whitespace starts a comment.
    const sharp = importGlossary("C# <= see sharp | c sharp\nF# <= f sharp  # a language", {
      source: "import:f",
      date: "2026-09-24",
    });
    expect(sharp.entries.map((e) => [e.term, e.heard, e.note])).toEqual([
      ["C#", ["see sharp", "c sharp"], undefined],
      ["F#", ["f sharp"], "a language"],
    ]);
    expect(sharp.skipped).toEqual([]);
    // The result is a valid file.
    expect(parseVocab(serializeVocab(file(...r.entries))).errors).toEqual([]);
  });
});

describe("the per-call decode list (DESIGN 3)", () => {
  const callAdd = (term: string, seq: number, decode = true) => ({
    id: `v${seq}`,
    rev: 1,
    term,
    heard: [],
    by: "user",
    decode,
    seq,
  });

  test("priority: mid-call adds, then attendees and names, then workspace high-miss and newest, then global with decode set", () => {
    const files = [
      ...merged("extra", entry("RepoWord", { added_at: "2026-09-01" })),
      ...merged(
        "workspace",
        entry("Old", { added_at: "2026-01-01" }),
        entry("New", { added_at: "2026-09-20" }),
        entry("Missed", { added_at: "2025-01-01", decode: 5 }),
        entry("ReadOnly", { decode: false }),
      ),
      ...merged("global", entry("GlobalDefault"), entry("GlobalOn", { decode: true })),
    ];
    const list = buildDecodeList({
      model: PARAKEET,
      callVocab: [callAdd("Attendee", 2), callAdd("FixedWord", 9)],
      captureStartSeq: 3,
      names: ["Ben Ortiz"],
      files,
    });
    expect(list.entries.map((e) => [e.term, e.tier, e.boost])).toEqual([
      ["FixedWord", 1, 3],
      ["Attendee", 2, 3],
      ["Ben Ortiz", 2, 3],
      ["Missed", 3, 5],
      ["New", 3, 3],
      ["RepoWord", 3, 3],
      ["Old", 3, 3],
      ["GlobalOn", 4, 3],
    ]);
    expect(list.dropped.map((d) => d.term).sort()).toEqual(["GlobalDefault", "ReadOnly"]);
    expect(hotwordsArg(list)).toBe(
      "FixedWord/Attendee/Ben Ortiz/Missed :5/New/RepoWord/Old/GlobalOn",
    );
  });

  test("[spike] The decode list is long: 100 workspace entries give a vocab.used of 24 and a warning", () => {
    const hundred = merged(
      "workspace",
      ...Array.from({ length: 100 }, (_, i) => entry(`Term${i}`)),
    );
    const list = buildDecodeList({ model: PARAKEET, callVocab: [], names: [], files: hundred });
    const used = vocabUsedDraft(list, [{ path: "work.yaml", sha256: "ab" }]);
    expect(used).toMatchObject({
      type: "vocab.used",
      files: ["work.yaml"],
      sha256: ["ab"],
      model: PARAKEET,
    });
    expect(used.type === "vocab.used" && used.entries).toHaveLength(DECODE_CAP);
    expect(list.warnings[0]).toContain("kept the first 24");
    // Positive control: with the cap lifted the same input lists all 100.
    expect(
      buildDecodeList({ model: PARAKEET, callVocab: [], names: [], files: hundred, cap: 1000 })
        .entries,
    ).toHaveLength(100);
  });

  test("[spike] Hotwords to a non-transducer model kill the process: Moonshine and Whisper get no list", () => {
    const files = merged("workspace", entry("Kubernetes"));
    for (const model of [
      "moonshine-base",
      "whisper-large-v3-turbo",
      // NeMo's CTC Parakeet variants are not transducers.
      "sherpa-onnx-nemo-parakeet-ctc-0.6b",
      "nemo-parakeet_tdt_ctc-110m",
    ]) {
      expect(modelKind(model)).toBe("other");
      const list = buildDecodeList({
        model,
        callVocab: [callAdd("Ben", 5)],
        captureStartSeq: 3,
        names: [],
        files,
      });
      expect(list.entries).toEqual([]);
      expect(hotwordsArg(list)).toBe("");
      expect(list.warnings[0]).toContain("read time only");
    }
    // Positive control: Parakeet TDT and zipformer transducers get the words.
    expect(modelKind("sherpa-onnx-zipformer-en-2023-06-26")).toBe("transducer");
    expect(hotwordsArg(buildDecodeList({ model: PARAKEET, callVocab: [], names: [], files }))).toBe(
      "Kubernetes",
    );
  });

  test("[decision] A mid-call add applies forward to decoding: the next list carries the word", () => {
    const b = new LogBuilder();
    b.created();
    const started = b.partStarted(1, T0);
    b.seg({ id: "l000001", text: "we use tauri" });
    const view = fold(b.events);
    const input = () => ({
      model: PARAKEET,
      callVocab: view.callVocabulary(),
      captureStartSeq: started.seq,
      names: view.roster().flatMap((r) => (r.name ? [r.name] : [])),
      files: [],
    });
    expect(hotwordsArg(buildDecodeList(input()))).toBe("");
    view.apply(
      b.add({
        type: "vocab.add",
        id: "v1",
        rev: 1,
        term: "Tauri",
        heard: ["tauri"],
        by: "agent:claude-code",
      }),
    );
    view.apply(b.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" }));
    const list = buildDecodeList(input());
    expect(list.entries.map((e) => [e.term, e.tier])).toEqual([
      ["Tauri", 1],
      ["Ben", 2],
    ]);
  });

  test("a term with a hotword separator is kept out of the list", () => {
    const list = buildDecodeList({
      model: PARAKEET,
      callVocab: [],
      names: [],
      files: merged("workspace", entry("CI/CD"), entry("Rust")),
    });
    expect(list.entries.map((e) => e.term)).toEqual(["Rust"]);
    expect(list.dropped[0]?.term).toBe("CI/CD");
  });
});
