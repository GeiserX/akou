/**
 * The export folder (docs/DESIGN.md section 8.2, item 1): the Markdown with frontmatter, its
 * attachments, idempotent re-export, finding a renamed file, never writing over the user's edits,
 * and file names that are valid on Windows. Every call here is generated.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isBareOffset } from "../src/core/log/clock.ts";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import {
  exportCall,
  frontmatterId,
  isoLocal,
  safeFileTitle,
  yamlScalar,
} from "../src/main/handoff/export.ts";
import { fakeOpus } from "./fixtures/opus.ts";
import { jsonl, LogBuilder, T0, TZ, tempDir } from "./helpers.ts";

const S = 1000;
const ID = "01J8Z6Q4M2VX0K7B3D4E5F6G7H";
const BASE = "2026-09-23 1536 Weekly sync";
const ENHANCED = [
  "## Decisions",
  "- Move the build to the new box [#l000002]",
  "- Kubernetes this time, said Ben [#l000002 #l000003]",
  "- build -> new box? _(your note, 15:37)_",
].join("\n");

/** A finished standup: you, Ben (named), an unnamed second speaker, a vocabulary fix, two notes. */
function standup(): LogBuilder {
  const b = new LogBuilder();
  b.created({ template: "standup" });
  b.partStarted(1, T0);
  b.add({
    type: "vocab.add",
    id: "v0001",
    rev: 1,
    term: "Kubernetes",
    heard: ["kubernetis"],
    by: "user",
  });
  b.seg({ id: "l000001", ch: "mic", spk: "you", w0: T0 + 5 * S, text: "hi everyone" });
  b.seg({
    id: "l000002",
    spk: "c1",
    w0: T0 + 65 * S,
    text: "we should move the build to the new box",
  });
  b.seg({ id: "l000003", spk: "c1", w0: T0 + 70 * S, text: "on kubernetis this time" });
  b.seg({ id: "l000004", spk: "c2", w0: T0 + 90 * S, text: "# not a heading" });
  b.add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" });
  b.add({
    type: "note",
    id: "n0001",
    rev: 1,
    text: "build -> new box?",
    w: T0 + 66 * S,
    afterSeq: 5,
    by: "user",
  });
  b.add({
    type: "note",
    id: "n0002",
    rev: 1,
    text: "ask about the budget",
    w: T0 + 95 * S,
    afterSeq: 7,
    by: "agent:claude-code",
  });
  b.partEnded(1, "stop", 27 * 60 + 28);
  b.add({ type: "call.ended", reason: "stop" });
  return b;
}

interface Rig {
  dir: string;
  root: string;
  events: LogEvent[];
  cleanup(): void;
  /** Folds the log as it is on disk plus anything appended since. */
  run(o?: { audio?: "link" | "copy" | "none"; root?: string }): ReturnType<typeof exportCall>;
  append(e: LogEvent): void;
}

function rig(b = standup(), o: { enhanced?: boolean } = {}): Rig {
  const t = tempDir("akou-export-");
  const dir = join(t.dir, "calls", "work", "2026-09-23_153612_weekly-sync");
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(join(dir, "audio", "part-001.opus"), fakeOpus(1647));
  const events = [...b.events];
  if (o.enhanced !== false) {
    mkdirSync(join(dir, "enhanced"), { recursive: true });
    writeFileSync(join(dir, "enhanced", "001-standup.md"), `${ENHANCED}\n`);
    events.push({
      seq: events.length + 1,
      t: T0 + 3_600_000,
      type: "enhanced",
      rev: 1,
      template: "standup",
      file: "enhanced/001-standup.md",
      coversSeq: events.length,
      by: "user",
      model: "fake/1.0",
      cites: ["l000002"],
    });
  }
  const root = join(t.dir, "export");
  const save = () => writeFileSync(join(dir, "events.jsonl"), jsonl(events));
  save();
  const r: Rig = {
    dir,
    root,
    events,
    cleanup: t.cleanup,
    append: (e) => {
      events.push({ ...e, seq: events.length + 1 } as LogEvent);
      save();
    },
    run: (x = {}) => {
      const res = exportCall({
        view: fold(events),
        dir,
        root: x.root ?? root,
        audio: x.audio ?? "link",
        version: "0.1.0",
      });
      // What the app does: record the export when something was written.
      if (res.draft) r.append({ ...(res.draft as object), seq: 0, t: T0 } as LogEvent);
      return res;
    },
  };
  return r;
}

describe("the export Markdown (DESIGN 8.2)", () => {
  test("frontmatter exactly as the design shows it, local times with the zone's offset", () => {
    const r = rig();
    try {
      const res = r.run();
      expect(res.path).toBe(join(r.root, "work", `${BASE}.md`));
      expect(res.written).toBe(true);
      const md = readFileSync(res.path, "utf8");
      const head = md.slice(0, md.indexOf("\n---\n", 4) + 5);
      expect(head).toBe(
        [
          "---",
          `akou_id: ${ID}`,
          "title: Weekly sync",
          "start: 2026-09-23T15:36:12-05:00",
          "end: 2026-09-23T16:03:40-05:00",
          "duration_min: 27",
          "workspace: work",
          "participants: [Ana (you), Ben, Speaker 2]",
          "template: standup",
          "transcript_layer: live",
          `audio: [attachments/${BASE}/part-001.opus]`,
          "source: akou 0.1.0",
          "shared: false",
          "akou_rev: 1",
          "---",
          "",
        ].join("\n"),
      );
      const sections = md.split("\n").filter((l) => /^#{2,3} /.test(l));
      expect(sections).toEqual(["## Notes", "### Decisions", "## Your raw notes", "## Transcript"]);
    } finally {
      r.cleanup();
    }
  });

  test("notes: the user's lines verbatim, citations as wall time and speaker, agent notes marked", () => {
    const r = rig();
    try {
      const md = readFileSync(r.run().path, "utf8");
      // The model's brackets are not doubled: `[[..]]` would be an Obsidian wikilink.
      expect(md).toContain("- Move the build to the new box [15:37:17 Ben]\n");
      expect(md).toContain("- Kubernetes this time, said Ben [15:37:17 Ben] [15:37:22 Ben]\n");
      expect(md).not.toContain("[[");
      expect(md).toContain("- build -> new box? _(your note, 15:37)_");
      expect(md).not.toContain("#l000002");
      expect(md).toContain("- 15:37:18 build -> new box?\n");
      expect(md).toContain("- 15:37:47 ask about the budget _(agent: claude-code)_");
    } finally {
      r.cleanup();
    }
  });

  test("[T3.11] Answers from uncorrected recognition: the export shows the corrected word and what was heard", () => {
    const r = rig();
    try {
      const md = readFileSync(r.run().path, "utf8");
      expect(md).toContain('on Kubernetes (heard: "kubernetis") this time');
    } finally {
      r.cleanup();
    }
  });

  test("[T3.43] The call channel labelled as one person: named and unnamed clusters keep their own labels", () => {
    const r = rig();
    try {
      const md = readFileSync(r.run().path, "utf8");
      const transcript = md.slice(md.indexOf("## Transcript"));
      expect(transcript).toContain("**Ben** · 15:37:17\nwe should move the build to the new box");
      expect(transcript).toContain("**Speaker 2** · 15:37:42\n\\# not a heading");
      expect(transcript).toContain("**Ana** · 15:36:17\nhi everyone");
    } finally {
      r.cleanup();
    }
  });

  test("[T3.9] Offsets shown as times of day: no export row is a bare mm:ss (with a positive control)", () => {
    const r = rig();
    try {
      const md = readFileSync(r.run().path, "utf8");
      const rows = md.split("\n").flatMap((l) => l.split(" · "));
      expect(rows.filter(isBareOffset)).toEqual([]);
      // The check can fail: an offset rendered alone is caught.
      expect([...rows, "12:30"].filter(isBareOffset)).toEqual(["12:30"]);
    } finally {
      r.cleanup();
    }
  });

  test("a call with no enhanced notes and no notes says so plainly", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.seg({ id: "l000001", w0: T0 + S, text: "hello" });
    b.partEnded(1, "stop", 10);
    b.add({ type: "call.ended", reason: "stop" });
    const r = rig(b, { enhanced: false });
    try {
      const md = readFileSync(r.run().path, "utf8");
      expect(md).toContain("## Notes\n_Not enhanced yet._");
      expect(md).toContain("## Your raw notes\n_No notes._");
    } finally {
      r.cleanup();
    }
  });
});

describe("attachments", () => {
  test("the event log is copied and the audio linked by default", () => {
    const r = rig();
    try {
      const res = r.run();
      const att = join(r.root, "work", "attachments", BASE);
      expect(res.attachments).toBe(att);
      expect(readFileSync(join(att, "events.jsonl"), "utf8").split("\n")[0]).toContain(
        '"call.created"',
      );
      const audio = join(att, "part-001.opus");
      if (process.platform !== "win32") {
        expect(lstatSync(audio).isSymbolicLink()).toBe(true);
        expect(readlinkSync(audio)).toBe(join(r.dir, "audio", "part-001.opus"));
      }
      expect(readFileSync(audio)).toEqual(Buffer.from(fakeOpus(1647)));
    } finally {
      r.cleanup();
    }
  });

  test("copy writes a real file; none leaves the audio out of the folder and the frontmatter", () => {
    const r = rig();
    try {
      const copied = r.run({ audio: "copy" });
      const audio = join(copied.attachments, "part-001.opus");
      expect(lstatSync(audio).isSymbolicLink()).toBe(false);
      expect(readFileSync(audio)).toEqual(Buffer.from(fakeOpus(1647)));
      const other = join(r.root, "..", "export-none");
      const none = r.run({ audio: "none", root: other });
      expect(existsSync(join(none.attachments, "part-001.opus"))).toBe(false);
      expect(readFileSync(none.path, "utf8")).toContain("\naudio: []\n");
    } finally {
      r.cleanup();
    }
  });
});

describe("re-export", () => {
  test("idempotent: nothing changed means nothing written and no export.done", () => {
    const r = rig();
    try {
      const first = r.run();
      const before = readFileSync(first.path, "utf8");
      const second = r.run();
      expect(second).toMatchObject({ written: false, draft: null, path: first.path, rev: 1 });
      expect(readFileSync(first.path, "utf8")).toBe(before);
      expect(r.events.filter((e) => e.type === "export.done")).toHaveLength(1);
    } finally {
      r.cleanup();
    }
  });

  test("a name given after the export rewrites the file with the next revision", () => {
    const r = rig();
    try {
      const first = r.run();
      r.append({ seq: 0, t: T0, type: "speaker.name", spk: "c2", name: "Cleo", by: "user" });
      const second = r.run();
      expect(second).toMatchObject({ written: true, rev: 2, path: first.path, update: false });
      const md = readFileSync(first.path, "utf8");
      expect(md).toContain("participants: [Ana (you), Ben, Cleo]");
      expect(md).toContain("akou_rev: 2");
    } finally {
      r.cleanup();
    }
  });

  test("a file the user renamed is found by its akou_id", () => {
    const r = rig();
    try {
      const first = r.run();
      const renamed = join(r.root, "work", "Standup with Ben.md");
      renameSync(first.path, renamed);
      expect(frontmatterId(renamed)).toBe(ID);
      r.append({ seq: 0, t: T0, type: "speaker.name", spk: "c2", name: "Cleo", by: "user" });
      const second = r.run();
      expect(second.path).toBe(renamed);
      expect(existsSync(first.path)).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  test("a file the user edited is never overwritten: the new version goes beside it", () => {
    const r = rig();
    try {
      const first = r.run();
      const edited = `${readFileSync(first.path, "utf8")}\nMy own conclusion.\n`;
      writeFileSync(first.path, edited);
      r.append({ seq: 0, t: T0, type: "speaker.name", spk: "c2", name: "Cleo", by: "user" });
      const second = r.run();
      expect(second.update).toBe(true);
      expect(second.path).toBe(join(r.root, "work", `${BASE} (akou update).md`));
      expect(readFileSync(first.path, "utf8")).toBe(edited);
      // The next change goes into the same update file, which is still akou's own.
      r.append({ seq: 0, t: T0, type: "speaker.name", spk: "c2", name: "Cleo B", by: "user" });
      const third = r.run();
      expect(third.path).toBe(second.path);
      expect(readFileSync(third.path, "utf8")).toContain("Cleo B");
    } finally {
      r.cleanup();
    }
  });

  test("a file of the same name that is not this call's is left alone", () => {
    const r = rig();
    try {
      const mine = join(r.root, "work", `${BASE}.md`);
      mkdirSync(join(r.root, "work"), { recursive: true });
      writeFileSync(mine, "my own page about the weekly sync\n");
      const res = r.run();
      expect(res.path).toBe(join(r.root, "work", `${BASE} (2).md`));
      expect(readFileSync(mine, "utf8")).toBe("my own page about the weekly sync\n");
    } finally {
      r.cleanup();
    }
  });
});

describe("file names safe on Windows", () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for.
  const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]|[. ]$/;

  test("every forbidden character, control character and trailing dot is gone", () => {
    const raw = 'a/b: c? <d> "e" | f*\u0007 end. ';
    // Positive control: the raw title would be refused.
    expect(FORBIDDEN.test(raw)).toBe(true);
    const safe = safeFileTitle(raw);
    expect(FORBIDDEN.test(safe)).toBe(false);
    expect(safe).toBe("a-b- c- -d- -e- - f- end");
  });

  test("long titles are capped and an empty one falls back", () => {
    expect([...safeFileTitle("x".repeat(500))].length).toBe(80);
    expect(safeFileTitle(" ... ")).toBe("Call");
    expect(safeFileTitle("Réunion 週次")).toBe("Réunion 週次");
  });

  test("the exported file carries the safe name, and YAML quotes what needs quoting", () => {
    const b = standup();
    (b.events[0] as { title: string }).title = 'Q3: plan / "go"?';
    const r = rig(b);
    try {
      const res = r.run();
      expect(res.path).toBe(join(r.root, "work", "2026-09-23 1536 Q3- plan - -go.md"));
      expect(readFileSync(res.path, "utf8")).toContain('title: "Q3: plan / \\"go\\"?"');
    } finally {
      r.cleanup();
    }
  });

  test("yamlScalar leaves plain words plain and quotes the ambiguous", () => {
    expect(yamlScalar("Weekly sync")).toBe("Weekly sync");
    expect(yamlScalar("Ana (you)")).toBe("Ana (you)");
    expect(yamlScalar("yes")).toBe('"yes"');
    expect(yamlScalar("1536")).toBe('"1536"');
    expect(yamlScalar("a, b")).toBe('"a, b"');
    expect(yamlScalar("#tag")).toBe('"#tag"');
  });

  test("isoLocal states the zone's offset, including a half-hour zone", () => {
    expect(isoLocal(T0, TZ)).toBe("2026-09-23T15:36:12-05:00");
    expect(isoLocal(T0, "Asia/Kolkata")).toBe("2026-09-24T02:06:12+05:30");
    expect(isoLocal(T0, "UTC")).toBe("2026-09-23T20:36:12+00:00");
  });
});
