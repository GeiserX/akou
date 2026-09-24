/**
 * The notes loop (docs/DESIGN.md sections 5.1 and 5.2): the notepad's events, templates, the
 * citation check with its positive control, and enhancement with a fake provider, including the
 * map-reduce path for long calls and its cache.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { type CallView, fold } from "../src/core/log/fold.ts";
import type { CompleteRequest, CompleteResult, Provider } from "../src/main/llm/provider.ts";
import { citeCheck, contentWords, stripMarker } from "../src/main/notes/cite-check.ts";
import {
  buildEnhanceInput,
  chunkSpans,
  composeNotes,
  ENHANCED_LATEST,
  enhance,
  enhancedDraft,
  storeEnhanced,
  userLine,
} from "../src/main/notes/enhance.ts";
import {
  NoteError,
  noteDeleteDraft,
  noteDraft,
  noteEditDraft,
  noteKind,
} from "../src/main/notes/notepad.ts";
import {
  chooseTemplate,
  listTemplates,
  parseTemplate,
  TemplateError,
} from "../src/main/notes/templates.ts";
import { CallQuery } from "../src/main/query/context.ts";
import { LogBuilder, T0, TZ, tempDir } from "./helpers.ts";

const S = 1000;
const MIN = 60 * S;

/** A short call: three lines, a user note at 15:36:30, an agent note. */
function shortCall(): LogBuilder {
  const b = new LogBuilder();
  b.created({ title: "Daily standup" });
  b.partStarted(1, T0);
  b.seg({ id: "l000001", text: "we should move the build to the new box", w0: T0 + 5 * S });
  b.seg({
    id: "l000002",
    ch: "mic",
    spk: "you",
    text: "agreed, Ben owns the migration",
    w0: T0 + 12 * S,
  });
  b.seg({ id: "l000003", text: "the invoice numbers look wrong for March", w0: T0 + 20 * S });
  b.add({
    type: "note",
    id: "n0007",
    rev: 1,
    text: "build -> new box?",
    w: T0 + 18 * S,
    afterSeq: 4,
    by: "user",
  });
  b.add({
    type: "note",
    id: "n0008",
    rev: 1,
    text: "check invoices",
    w: T0 + 25 * S,
    afterSeq: 5,
    by: "agent:claude-code",
  });
  return b;
}

/** A fake provider: answers from a function of the request, records every request. */
class FakeProvider implements Provider {
  readonly id = "harness" as const;
  readonly requests: CompleteRequest[] = [];
  constructor(private readonly answer: (req: CompleteRequest) => string) {}
  async available() {
    return { ok: true as const, detail: "fake" };
  }
  async complete(req: CompleteRequest, onToken: (t: string) => void): Promise<CompleteResult> {
    this.requests.push(req);
    const text = this.answer(req);
    onToken(text);
    return { text, model: "fake/1.0" };
  }
}

describe("[5.1] the notepad", () => {
  test("a line carries its time, the log position and its author; edits are rev+1; deletes are note.del", () => {
    const b = shortCall();
    const v = fold(b.events);
    const d = noteDraft(v, { text: "  [] send the invoice  ", by: "user", now: T0 + 30 * S });
    expect(d).toEqual({
      type: "note",
      id: `n${String(v.lastSeq + 1).padStart(4, "0")}`,
      rev: 1,
      text: "[] send the invoice",
      w: T0 + 30 * S,
      afterSeq: v.lastSeq,
      by: "user",
    });
    const e = noteEditDraft(v, "n0007", "build -> new box!", "user");
    expect(e).toMatchObject({ id: "n0007", rev: 2, w: T0 + 18 * S, afterSeq: 4 });
    b.add(e);
    b.add(noteDeleteDraft(fold(b.events), "n0008", "user"));
    const after = fold(b.events).notes();
    expect(after.map((n) => [n.id, n.rev, n.text])).toEqual([["n0007", 2, "build -> new box!"]]);
    // The first revision is still in the log.
    expect(b.events.some((x) => x.type === "note" && x.text === "build -> new box?")).toBe(true);
  });

  test("refusals: empty, too long, unknown id", () => {
    const v = fold(shortCall().events);
    expect(() => noteDraft(v, { text: "  ", by: "user", now: 0 })).toThrow(NoteError);
    expect(() => noteDraft(v, { text: "x".repeat(4001), by: "user", now: 0 })).toThrow(/4000/);
    expect(() => noteEditDraft(v, "n9999", "x", "user")).toThrow(/no note n9999/);
    expect(() => noteDeleteDraft(v, "n9999", "user")).toThrow(NoteError);
  });

  test("markers", () => {
    expect(noteKind("[] ship it")).toBe("action");
    expect(noteKind("? who owns it")).toBe("question");
    expect(noteKind("# Budget")).toBe("section");
    expect(noteKind("- point")).toBe("bullet");
    expect(noteKind("plain")).toBe("text");
  });

  test("[decision] Agent-authored notes indistinguishable from the user's: the author is kept", () => {
    const v = fold(shortCall().events);
    const byId = Object.fromEntries(v.notes().map((n) => [n.id, n]));
    expect(byId.n0007).toMatchObject({ author: "human", by: "user" });
    expect(byId.n0008).toMatchObject({ author: "agent", client: "claude-code" });
  });
});

describe("[5.2] templates", () => {
  test("five ship, each with sections", () => {
    const all = listTemplates("/nonexistent");
    expect(all.map((t) => t.name)).toEqual([
      "customer-call",
      "general",
      "interview",
      "one-on-one",
      "standup",
    ]);
    for (const t of all) expect(t.sections.length).toBeGreaterThan(0);
    const standup = all.find((t) => t.name === "standup");
    expect(standup?.match).toEqual(["standup", "stand-up", "daily", "scrum"]);
    expect(standup?.sections.map((s) => s.heading)).toEqual([
      "Updates per person",
      "Decisions",
      "Action items",
    ]);
    expect(standup?.sections[1]?.instruction).toBe("");
  });

  test("a user's file replaces a shipped one of the same name and adds new ones", () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, "templates"));
      writeFileSync(
        join(t.dir, "templates", "standup.md"),
        "---\nname: standup\nmatch: [sync]\n---\n## Blockers\nOnly blockers.\n",
      );
      writeFileSync(join(t.dir, "templates", "retro.md"), "## Went well\n## To change\n");
      writeFileSync(join(t.dir, "templates", "broken.md"), "no sections here\n");
      const errors: string[] = [];
      const all = listTemplates(t.dir, { onError: (m) => errors.push(m) });
      expect(all.find((x) => x.name === "standup")).toMatchObject({
        bundled: false,
        match: ["sync"],
      });
      expect(all.find((x) => x.name === "retro")?.sections.length).toBe(2);
      expect(errors.join()).toContain('no "## " sections');
    } finally {
      t.cleanup();
    }
  });

  test("choice: explicit, then the call's own, then a title keyword, then general", () => {
    const all = listTemplates("/nonexistent");
    expect(chooseTemplate(all, { explicit: "interview", title: "Daily" }).name).toBe("interview");
    expect(chooseTemplate(all, { callTemplate: "one-on-one", title: "Daily" }).name).toBe(
      "one-on-one",
    );
    expect(chooseTemplate(all, { title: "Daily standup" }).name).toBe("standup");
    expect(chooseTemplate(all, { title: "1:1 with Ben" }).name).toBe("one-on-one");
    // Whole words only: "demolition" is not a demo.
    expect(chooseTemplate(all, { title: "Demolition plan" }).name).toBe("general");
    expect(() => chooseTemplate(all, { explicit: "nope" })).toThrow(TemplateError);
  });

  test("quoted and bare match lists", () => {
    const t = parseTemplate(`---\nmatch: ["a, b", 'c', d]\n---\n## X\n`, "/t/x.md");
    expect(t).toMatchObject({ name: "x", match: ["a, b", "c", "d"] });
  });
});

describe("[judging] Hallucinated citation in enhanced notes", () => {
  const view = () => fold(shortCall().events);

  test("a bullet citing a fake id, citing nothing, or sharing no word with its line is dropped", () => {
    const md = [
      "## Decisions",
      "- Move the build to the new box [#l000001]",
      "- Ben owns the migration [#l000002 #l000999]",
      "- The invoices for March look wrong",
      "- Quarterly revenue doubled [#l000003]",
      "- The invoice numbers for March look wrong [#l000003]",
    ].join("\n");
    const r = citeCheck(md, { view: view() });
    expect(r.markdown).toBe(
      [
        "## Decisions",
        "- Move the build to the new box [#l000001]",
        "- The invoice numbers for March look wrong [#l000003]",
      ].join("\n"),
    );
    expect(r.dropped.map((d) => d.reason)).toEqual([
      "cites #l000999, which is not a line of this call",
      "cites no segment",
      "shares no word with the lines it cites",
    ]);
    expect(r.cites).toEqual(["l000001", "l000003"]);
  });

  test("positive control: the same bullets pass once the cited lines exist and match", () => {
    const b = shortCall();
    b.seg({ id: "l000999", text: "Ben owns the migration", w0: T0 + 40 * S });
    b.seg({ id: "l000004", text: "quarterly revenue doubled", w0: T0 + 45 * S });
    const r = citeCheck(
      "- Ben owns the migration [#l000002 #l000999]\n- Quarterly revenue doubled [#l000004]",
      { view: fold(b.events) },
    );
    expect(r.dropped).toEqual([]);
    expect(r.kept).toBe(2);
  });

  test("a line after the covered span is out of range; the user's own line needs no citation", () => {
    const r = citeCheck("- build -> new box?\n- move the build [#l000003]", {
      view: view(),
      maxSeq: 4,
      userLines: ["build -> new box?"],
    });
    expect(r.userKept).toBe(1);
    expect(r.dropped[0]?.reason).toContain("after the span these notes cover");
  });

  test("a fake provider's bad citation never reaches the stored notes", async () => {
    const q = new CallQuery(fold(shortCall().events));
    const provider = new FakeProvider(() =>
      [
        "## Updates per person",
        "- Ben owns the build migration [#l000002]",
        "- Ben promised a raise [#l000042]",
        "## Decisions",
        "- {n0007}",
        "- Build moves to the new box [#l000001]",
        "## Action items",
        "- [ ] Ana: fix March invoice numbers [#l000003]",
      ].join("\n"),
    );
    const events: unknown[] = [];
    const r = await enhance({
      q,
      template: chooseTemplate(listTemplates("/nonexistent"), { title: "Daily standup" }),
      provider,
      now: T0 + MIN,
      write: async (d) => {
        events.push(d);
        return d as LogEvent;
      },
    });
    expect(r.markdown).not.toContain("raise");
    expect(r.dropped).toEqual([
      {
        text: "- Ben promised a raise [#l000042]",
        reason: "cites #l000042, which is not a line of this call",
      },
    ]);
    // Positive control: the model did say it; the check removed it.
    expect(provider.requests.length).toBe(1);
    expect(r.cites).toEqual(["l000002", "l000001", "l000003"]);
    expect(r.mode).toBe("whole");
    expect(events).toEqual([]);
  });
});

describe("[5.2] enhanced notes", () => {
  test("the user's lines are kept word for word and marked; unplaced ones are added; agent lines are not the user's", () => {
    const v = fold(shortCall().events);
    const notes = v.notes().filter((n) => n.author === "human");
    const placed = composeNotes("## Decisions\n- {n0007}\n- {n0007}\n- {n0008}\n- {n0099}", {
      view: v,
      tz: TZ,
      maxSeq: v.lastSeq,
      notes,
    });
    expect(placed.markdown).toBe("## Decisions\n- build -> new box? _(your note, 15:36)_");
    const unplaced = composeNotes("## Decisions\n- Move the build to the new box [#l000001]", {
      view: v,
      tz: TZ,
      maxSeq: v.lastSeq,
      notes,
    });
    expect(unplaced.appended).toEqual([userLine(notes[0] as never, TZ)]);
    expect(unplaced.markdown).toEndWith("## Your notes\n- build -> new box? _(your note, 15:36)_");
  });

  test("the input: template, the user's notes by id, the agent's notes as context, the transcript, local times", () => {
    const q = new CallQuery(fold(shortCall().events));
    const t = chooseTemplate(listTemplates("/nonexistent"), { title: "Daily standup" });
    const input = buildEnhanceInput(q, t, { now: T0 + MIN });
    expect(input.mode).toBe("whole");
    expect(input.prompt).toContain("## Updates per person");
    expect(input.prompt).toContain("{n0007} 15:36:30 (you) build -> new box?");
    expect(input.prompt).toContain("Notes an agent added during the call (context only):");
    expect(input.prompt).toContain("#l000001 15:36:17");
    expect(input.userNotes.map((n) => n.id)).toEqual(["n0007"]);
  });

  test("a long call: stretches are summarised once, cached as chunk.summary, and reused", async () => {
    const b = new LogBuilder();
    b.created({ title: "Planning" });
    b.partStarted(1, T0);
    // 40 minutes, a line a minute: three 15-minute stretches.
    for (let i = 0; i < 40; i++) {
      b.seg({
        id: `l${String(i + 1).padStart(6, "0")}`,
        text: `topic number ${i} discussed at length`,
        w0: T0 + i * MIN,
      });
    }
    b.add({
      type: "note",
      id: "n0100",
      rev: 1,
      text: "topic 12 matters",
      w: T0 + 12 * MIN,
      afterSeq: 14,
      by: "user",
    });
    const view: CallView = fold(b.events);
    const q = new CallQuery(view);
    const t = chooseTemplate(listTemplates("/nonexistent"), {});
    expect(chunkSpans(view.lines("best")).map((s) => s.lines.length)).toEqual([15, 15, 10]);
    const provider = new FakeProvider((req) =>
      req.system.startsWith("You summarise")
        ? `- ${/topic number (\d+)/.exec(req.prompt)?.[0]} came up [#l${String(Number(/topic number (\d+)/.exec(req.prompt)?.[1]) + 1).padStart(6, "0")}]`
        : "## Summary\n- topic number 0 came up [#l000001]\n- {n0100}",
    );
    const write = async (d: Parameters<typeof b.add>[0]) => {
      const e = b.add(d);
      view.apply(e);
      return e;
    };
    // A small whole-transcript limit forces the chunked path on a small fixture.
    const o = { q, template: t, provider, now: T0 + 50 * MIN, write, wholeLimit: 100 };
    const first = await enhance(o);
    expect(first.mode).toBe("chunked");
    expect(first.mapCalls).toBe(3);
    expect(view.chunkSummaries().length).toBe(3);
    expect(first.markdown).toContain("- topic number 0 came up [#l000001]");
    expect(first.markdown).toContain("- topic 12 matters _(your note, 15:48)_");
    // The reduce step read the summaries and the note's surrounding lines, not the whole transcript.
    const reduce = provider.requests.at(-1) as CompleteRequest;
    expect(reduce.prompt).toContain("Summaries of the call, stretch by stretch:");
    expect(reduce.prompt).toContain("#l000013 15:48:12");
    expect(reduce.prompt).not.toContain("#l000030 ");
    // Again: nothing changed, so no stretch is summarised twice.
    const again = await enhance(o);
    expect(again.mapCalls).toBe(0);
    // A revised line invalidates only its own stretch.
    b.add({ type: "seg", id: "l000035", rev: 2, text: "topic number 34 revised" } as never);
    view.apply(b.events.at(-1) as LogEvent);
    const third = await enhance(o);
    expect(third.mapCalls).toBe(1);
  });

  test("stored as a file per revision plus notes.enhanced.md, then the event", () => {
    const t = tempDir();
    try {
      const file = storeEnhanced(t.dir, 3, "standup", "## A\n- x [#l000001]");
      expect(file).toBe("enhanced/003-standup.md");
      expect(readFileSync(join(t.dir, file), "utf8")).toBe("## A\n- x [#l000001]\n");
      expect(readFileSync(join(t.dir, ENHANCED_LATEST), "utf8")).toBe("## A\n- x [#l000001]\n");
      storeEnhanced(t.dir, 4, "general", "## B");
      expect(existsSync(join(t.dir, "enhanced/003-standup.md"))).toBe(true);
      expect(readFileSync(join(t.dir, ENHANCED_LATEST), "utf8")).toBe("## B\n");
      expect(
        enhancedDraft({
          rev: 4,
          template: "general",
          coversSeq: 9,
          by: "agent:cli",
          model: "m",
          cites: [],
        }),
      ).toMatchObject({ type: "enhanced", file: "enhanced/004-general.md" });
    } finally {
      t.cleanup();
    }
  });

  test("content words and markers", () => {
    expect([...contentWords("We should move the build to the NEW box [#l000001] in 2026")]).toEqual(
      ["move", "build", "new", "box", "2026"],
    );
    expect(stripMarker("  - [ ] Ben: ship")).toBe("Ben: ship");
    expect(stripMarker("2. item")).toBe("item");
  });
});
