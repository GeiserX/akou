import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { CallView, fold, PROVISIONAL_TTL_MS, ProvisionalBoard } from "../src/core/log/fold.ts";
import { isDictionaryWord, LogBuilder, T0 } from "./helpers.ts";

const S = 1000;

/** A call with one part and a few live lines. */
function basicCall(): LogBuilder {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.seg({ id: "l000001", ch: "mic", spk: "you", w0: T0 + 1 * S, text: "hi everyone" });
  b.seg({ id: "l000002", spk: "c1", w0: T0 + 2 * S, text: "hello Ana" });
  b.seg({ id: "l000003", spk: "c2", w0: T0 + 3 * S, text: "we should move the build" });
  return b;
}

/** Deep copy for proving the fold never mutates its input. */
const snapshot = (events: readonly LogEvent[]) => JSON.parse(JSON.stringify(events));

describe("the fold: segments and revisions (DESIGN 4.2, 4.6)", () => {
  test("lines render in wall order with speaker labels", () => {
    const v = fold(basicCall().events);
    expect(v.lines().map((l) => [l.speaker, l.text])).toEqual([
      ["Ana", "hi everyone"],
      ["Speaker 1", "hello Ana"],
      ["Speaker 2", "we should move the build"],
    ]);
  });

  test("the latest rev wins, a revision may carry only changed fields, and every revision is kept", () => {
    const b = basicCall();
    b.add({ type: "seg", id: "l000003", rev: 2, text: "we should move the build box", by: "user" });
    const v = fold(b.events);
    const line = v.resolve("l000003");
    expect(line?.text).toBe("we should move the build box");
    expect(line?.spk).toBe("c2"); // carried from revision 1
    expect(line?.edited).toBe(true);
    const seg = v.segment("l000003");
    expect(seg?.recognized).toBe("we should move the build");
    expect(seg?.revisions.map((r) => r.rev)).toEqual([1, 2]);
  });

  test("a stale revision never replaces a newer one", () => {
    const b = basicCall();
    b.add({ type: "seg", id: "l000002", rev: 3, text: "third" });
    b.add({ type: "seg", id: "l000002", rev: 2, text: "second" });
    expect(fold(b.events).resolve("l000002")?.text).toBe("third");
  });

  test("a revision applied to a view that already rendered the line re-renders it", () => {
    const b = basicCall();
    const v = fold(b.events);
    expect(v.resolve("l000002")?.text).toBe("hello Ana");
    v.lines();
    const renders = v.stats.renders;
    v.apply(b.add({ type: "seg", id: "l000002", rev: 2, text: "edited text", by: "user" }));
    expect(v.resolve("l000002")?.text).toBe("edited text");
    expect(v.lines().find((l) => l.id === "l000002")?.text).toBe("edited text");
    expect(v.stats.renders).toBe(renders + 1);
  });

  test("every revisioned event keeps its highest rev, whatever order revisions arrive in", () => {
    const cases: Array<{
      name: string;
      events: (rev: number, value: string) => Parameters<LogBuilder["add"]>[0];
      read: (v: CallView) => unknown;
      expected: unknown;
    }> = [
      {
        name: "note",
        events: (rev, text) => ({
          type: "note",
          id: "n1",
          rev,
          text,
          w: T0,
          afterSeq: 1,
          by: "user",
        }),
        read: (v) => v.notes()[0]?.text,
        expected: "newer",
      },
      {
        name: "remember",
        events: (rev, text) => ({ type: "remember", id: "r1", rev, text, by: "agent:codex" }),
        read: (v) => v.remembered()[0]?.text,
        expected: "newer",
      },
      {
        name: "memo",
        events: (rev, body) => ({ type: "memo", rev, body, coversSeq: 1, by: "user", model: "m" }),
        read: (v) => v.memo?.body,
        expected: "newer",
      },
      {
        name: "vocab.add",
        events: (rev, value) =>
          value === "newer"
            ? { type: "vocab.add", id: "v1", rev, term: null, by: "user" }
            : { type: "vocab.add", id: "v1", rev, term: "Anika", heard: ["annika"], by: "user" },
        read: (v) => v.callVocabulary().length,
        expected: 0,
      },
      {
        name: "vocab.propose",
        events: (rev, value) => ({
          type: "vocab.propose",
          id: "p1",
          rev,
          term: "Vercel",
          heard: ["versal"],
          by: "user",
          evidence: {},
          status: value === "newer" ? "accepted" : "proposed",
        }),
        read: (v) => v.proposals()[0]?.status,
        expected: "accepted",
      },
    ];
    for (const c of cases) {
      const b = basicCall();
      b.add(c.events(2, "newer"));
      b.add(c.events(1, "older"));
      expect([c.name, c.read(fold(b.events))]).toEqual([c.name, c.expected]);
      // Positive control: in ascending order the newer revision is what the read returns.
      const asc = basicCall();
      asc.add(c.events(1, "older"));
      asc.add(c.events(2, "newer"));
      expect([c.name, c.read(fold(asc.events))]).toEqual([c.name, c.expected]);
    }
  });

  test("text: null retracts a line; it stays resolvable", () => {
    const b = basicCall();
    b.add({ type: "seg", id: "l000002", rev: 2, text: null });
    const v = fold(b.events);
    expect(v.lines().map((l) => l.id)).toEqual(["l000001", "l000003"]);
    expect(v.resolve("l000002")?.retracted).toBe(true);
    expect(v.lines("best", { includeRetracted: true })).toHaveLength(3);
  });

  test("echo lines are kept but hidden from views", () => {
    const b = basicCall();
    b.seg({
      id: "l000004",
      ch: "mic",
      spk: "you",
      w0: T0 + 3 * S,
      text: "move the build",
      echo: true,
    });
    const v = fold(b.events);
    expect(v.lines().map((l) => l.id)).not.toContain("l000004");
    expect(v.lines("best", { includeEcho: true }).map((l) => l.id)).toContain("l000004");
    expect(v.resolve("l000004")?.echo).toBe(true);
  });

  test("a revision for a segment that has no revision 1 is reported, not guessed", () => {
    const b = basicCall();
    b.add({ type: "seg", id: "l000099", rev: 2, text: "orphan" });
    const v = fold(b.events);
    expect(v.resolve("l000099")).toBeNull();
    expect(v.issues[0]).toMatch(/l000099/);
  });

  test("[T1.42] the fold uses the one sort order: same w0 puts mic first", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.seg({ id: "l000001", ch: "call", spk: "c1", w0: T0, text: "call first in the log" });
    b.seg({ id: "l000002", ch: "mic", spk: "you", w0: T0, text: "mic second in the log" });
    expect(
      fold(b.events)
        .lines()
        .map((l) => l.id),
    ).toEqual(["l000002", "l000001"]);
  });

  test("incremental apply equals folding the whole log", () => {
    const b = basicCall();
    b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    const inc = new CallView();
    for (const e of b.events) inc.apply(e);
    expect(inc.lines()).toEqual(fold(b.events).lines());
  });

  test("incremental apply equals folding the whole log when an accepted proposal has no heard forms", () => {
    const b = basicCall();
    b.seg({ id: "l000004", w0: T0 + 4 * S, text: "we deploy on kubernetis today" });
    const inc = new CallView({ isDictionaryWord });
    for (const e of b.events) inc.apply(e);
    expect(inc.resolve("l000004")?.text).toBe("we deploy on kubernetis today");
    const propose = (rev: number, status: "proposed" | "accepted" | "rejected") =>
      b.add({
        type: "vocab.propose",
        id: "p1",
        rev,
        term: "Kubernetes",
        heard: [],
        by: "app",
        evidence: {},
        status,
      });
    inc.apply(propose(1, "proposed"));
    inc.apply(propose(2, "accepted"));
    expect(inc.resolve("l000004")?.text).toBe("we deploy on Kubernetes today");
    expect(inc.lines()).toEqual(fold(b.events, { isDictionaryWord }).lines());
    inc.apply(propose(3, "rejected"));
    expect(inc.resolve("l000004")?.text).toBe("we deploy on kubernetis today");
    expect(inc.lines()).toEqual(fold(b.events, { isDictionaryWord }).lines());
  });

  test("an event applied twice (a reader re-reading its cursor) is ignored", () => {
    const b = basicCall();
    const v = fold(b.events);
    v.apply(b.events[2] as LogEvent);
    expect(v.lines()).toHaveLength(3);
    expect(v.issues).toHaveLength(1);
  });
});

describe("the fold: call state", () => {
  test("recording, paused, restarting, ended", () => {
    const b = new LogBuilder();
    b.created();
    const v = new CallView();
    const step = (e: LogEvent) => {
      v.apply(e);
      return v.state;
    };
    for (const e of b.events) v.apply(e);
    expect(v.state).toBe("starting");
    expect(step(b.partStarted(1, T0))).toBe("recording");
    expect(v.live).toBe(true);
    expect(step(b.add({ type: "pause", part: 1, a: 10, wall: T0 + 10 * S, mono: 10 }))).toBe(
      "paused",
    );
    expect(step(b.add({ type: "resume", part: 1, a: 10, wall: T0 + 20 * S, mono: 20 }))).toBe(
      "recording",
    );
    expect(step(b.add({ type: "mute", part: 1, a: 12 }))).toBe("recording");
    expect(v.muted).toBe(true);
    expect(step(b.add({ type: "unmute", part: 1, a: 14 }))).toBe("recording");
    expect(v.muted).toBe(false);
    expect(step(b.partEnded(1, "restart"))).toBe("restarting");
    expect(v.live).toBe(true);
    expect(step(b.partStarted(2, T0 + 70 * S))).toBe("recording");
    expect(step(b.partEnded(2, "stop"))).toBe("stopping");
    expect(step(b.add({ type: "call.ended", reason: "stop" }))).toBe("ended");
    expect(v.live).toBe(false);
    expect(v.part(1)?.pauses[0]?.resumed?.wall).toBe(T0 + 20 * S);
    expect(v.part(1)?.mutes).toEqual([{ a: 12, unmutedAt: 14 }]);
  });

  test("a make-before-break restart (part n+1 started before part n ended) is recording, not restarting", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.partStarted(2, T0 + 60 * S);
    const v = fold(b.events);
    v.apply(b.partEnded(1, "restart"));
    expect(v.state).toBe("recording");
    expect(v.live).toBe(true);
    expect(v.part(1)?.ended?.reason).toBe("restart");
    v.apply(b.seg({ id: "l000001", part: 2, w0: T0 + 61 * S, text: "in part two" }));
    expect(v.state).toBe("recording");
    // The newest part ending still moves the call on.
    v.apply(b.partEnded(2, "stop"));
    expect(v.state).toBe("stopping");
  });

  test("a helper exit is an automatic restart: the call stays live until it is interrupted", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    const v = fold(b.events);
    v.apply(b.partEnded(1, "helper-exit"));
    expect(v.state).toBe("restarting");
    expect(v.live).toBe(true);
    v.apply(b.partStarted(2, T0 + 60 * S));
    expect(v.state).toBe("recording");
    v.apply(b.partEnded(2, "helper-exit"));
    v.apply(b.add({ type: "call.ended", reason: "interrupted" }));
    expect(v.state).toBe("interrupted");
    expect(v.live).toBe(false);
  });

  test("[T2.49] Failed start leaves an orphan folder: a call.failed call is failed and never live", () => {
    const b = new LogBuilder();
    b.created();
    b.add({ type: "call.failed", stage: "open", error: "helper exited 77" });
    const v = fold(b.events);
    expect(v.state).toBe("failed");
    expect(v.live).toBe(false);
    expect(v.failure?.error).toBe("helper exited 77");
  });

  test("[T1.26] Stop during a slow start: a cancelled part is not a failure", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.partEnded(1, "cancelled", 0);
    b.add({ type: "call.ended", reason: "stop" });
    const v = fold(b.events);
    expect(v.state).toBe("ended");
    expect(v.failure).toBeNull();
    expect(v.part(1)?.ended?.reason).toBe("cancelled");
  });

  test("[T3.14] `current` points at a finished call: an ended or interrupted call is not live", () => {
    for (const reason of ["stop", "interrupted", "abandoned"] as const) {
      const b = basicCall();
      b.partEnded(1, "stop");
      b.add({ type: "call.ended", reason });
      const v = fold(b.events);
      expect(v.live).toBe(false);
      expect(v.endedReason).toBe(reason);
    }
  });

  test("an app crash leaves an open part, closed later with reason crashed", () => {
    const b = basicCall();
    const v = fold(b.events);
    expect(v.openParts().map((p) => p.part)).toEqual([1]);
    v.apply(b.partEnded(1, "crashed", 42));
    expect(v.openParts()).toEqual([]);
    expect(v.state).toBe("crashed");
  });

  test("a resume after the call ended adds a part and the call is live again", () => {
    const b = basicCall();
    b.partEnded(1, "stop");
    b.add({ type: "call.ended", reason: "interrupted" });
    b.partStarted(2, T0 + 600 * S);
    const v = fold(b.events);
    expect(v.state).toBe("recording");
    expect(v.endedReason).toBeNull();
  });
});

describe("the fold: parts and restarts", () => {
  test("[T3.2, T2.48] Restart splits one call into several folders: any number of restarts is one call, one log, one clock", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.seg({ id: "l000001", part: 1, w0: T0 + 5 * S, text: "part one" });
    b.partEnded(1, "restart", 30);
    b.partStarted(2, T0 + 31 * S);
    b.seg({ id: "l000002", part: 2, w0: T0 + 40 * S, text: "part two" });
    b.partEnded(2, "helper-exit", 20);
    b.partStarted(3, T0 + 52 * S);
    b.seg({ id: "l000003", part: 3, w0: T0 + 60 * S, text: "part three" });
    b.partEnded(3, "restart", 5);
    b.partStarted(4, T0 + 66 * S);
    b.seg({ id: "l000004", part: 4, w0: T0 + 70 * S, text: "part four" });
    const v = fold(b.events);
    expect(v.parts().map((p) => p.part)).toEqual([1, 2, 3, 4]);
    expect(v.call?.id).toBe("01J8Z6Q4M2VX0K7B3D4E5F6G7H");
    expect(v.lines().map((l) => [l.part, l.text])).toEqual([
      [1, "part one"],
      [2, "part two"],
      [3, "part three"],
      [4, "part four"],
    ]);
    expect(v.state).toBe("recording");
  });

  test("[T2.48, T3.10] Speaker numbers restart per part: ids continue and a name given in part 1 renders in part 2", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.seg({ id: "l000001", part: 1, spk: "c2", w0: T0 + S, text: "before the restart" });
    b.add({ type: "speaker.centroid", spk: "c2", vec: "AAAA" });
    b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    b.partEnded(1, "restart");
    b.partStarted(2, T0 + 70 * S);
    b.seg({ id: "l000002", part: 2, spk: "c2", w0: T0 + 75 * S, text: "after the restart" });
    const v = fold(b.events);
    expect(v.lines().map((l) => [l.part, l.speaker])).toEqual([
      [1, "Ben"],
      [2, "Ben"],
    ]);
    expect(v.centroid("c2")).toBe("AAAA");
  });
});

describe("the fold: speakers", () => {
  test("the mic channel is always you, rendered with the user's name", () => {
    const b = basicCall();
    // Even a mic line that carries a cluster id is the user.
    b.seg({ id: "l000004", ch: "mic", spk: "c3", w0: T0 + 4 * S, text: "mic line" });
    const v = fold(b.events);
    expect(v.resolve("l000001")?.spk).toBe("you");
    expect(v.resolve("l000004")?.speaker).toBe("Ana");
    expect(v.speakerLabel("you")).toBe("Ana");
  });

  test("names: latest wins; unnamed clusters are Speaker N; c? is unknown", () => {
    const b = basicCall();
    b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    b.add({ type: "speaker.name", spk: "c2", name: "Benjamin", by: "agent:claude-code" });
    const v = fold(b.events);
    expect(v.speakerLabel("c2")).toBe("Benjamin");
    expect(v.speakerLabel("c7")).toBe("Speaker 7");
    expect(v.speakerLabel("c?")).toBe("Unknown speaker");
    expect(v.roster().find((r) => r.spk === "c2")?.namedBy).toBe("agent:claude-code");
  });

  test("[judging] A wrong speaker merge with no way back: unmerge restores both ids", () => {
    const b = basicCall();
    b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    b.add({ type: "speaker.merge", from: "c1", into: "c2" });
    b.seg({ id: "l000004", spk: "c1", w0: T0 + 4 * S, text: "later c1 line" });
    const merged = fold(b.events);
    expect(merged.resolve("l000002")?.speaker).toBe("Ben");
    expect(merged.resolve("l000004")?.speaker).toBe("Ben");
    expect(merged.roster().find((r) => r.spk === "c1")?.mergedInto).toBe("c2");
    // Segments were never rewritten.
    expect(merged.segment("l000002")?.spk).toBe("c1");

    b.add({ type: "speaker.unmerge", from: "c1", into: "c2" });
    b.seg({ id: "l000005", spk: "c1", w0: T0 + 5 * S, text: "after the unmerge" });
    const v = fold(b.events);
    expect(v.resolve("l000002")?.speaker).toBe("Speaker 1");
    expect(v.resolve("l000004")?.speaker).toBe("Speaker 1");
    expect(v.resolve("l000005")?.speaker).toBe("Speaker 1");
    expect(v.resolve("l000003")?.speaker).toBe("Ben");
  });

  test("an unmerge only undoes the merge it names", () => {
    const b = basicCall();
    b.add({ type: "speaker.merge", from: "c1", into: "c2" });
    b.add({ type: "speaker.unmerge", from: "c1", into: "c9" });
    const v = fold(b.events);
    expect(v.resolveSpeaker("c1")).toBe("c2");
    // Positive control: the matching unmerge does undo it.
    v.apply(b.add({ type: "speaker.unmerge", from: "c1", into: "c2" }));
    expect(v.resolveSpeaker("c1")).toBe("c1");
  });

  test("a suggestion for a final cluster that is already mapped is ignored", () => {
    const b = basicCall();
    b.add({ type: "speaker.map", final: "s0", live: "c1", overlap: 0.9 });
    b.add({ type: "speaker.suggest", final: "s0", live: "c2", overlap: 0.4 });
    b.add({ type: "speaker.suggest", final: "s1", live: "c2", overlap: 0.4 });
    expect(
      fold(b.events)
        .speakerSuggestions()
        .map((x) => x.final),
    ).toEqual(["s1"]);
  });

  test("merges chain, and a merge cycle cannot hang the reader", () => {
    const b = basicCall();
    b.add({ type: "speaker.merge", from: "c3", into: "c2" });
    b.add({ type: "speaker.merge", from: "c2", into: "c1" });
    b.add({ type: "speaker.name", spk: "c1", name: "Cleo", by: "user" });
    const v = fold(b.events);
    expect(v.speakerLabel("c3")).toBe("Cleo");
    v.apply(b.add({ type: "speaker.merge", from: "c1", into: "c3" }));
    expect(typeof v.speakerLabel("c3")).toBe("string");
  });

  test("a merged group with an unnamed root carries the member's name", () => {
    const b = basicCall();
    b.add({ type: "speaker.name", spk: "c1", name: "Dana", by: "user" });
    b.add({ type: "speaker.merge", from: "c1", into: "c2" });
    expect(fold(b.events).resolve("l000003")?.speaker).toBe("Dana");
  });

  test("[T3.43] The call channel labelled as one person: naming one cluster leaves the other its own label", () => {
    const b = basicCall();
    b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    const v = fold(b.events);
    expect(v.resolve("l000002")?.speaker).toBe("Speaker 1");
    expect(v.resolve("l000003")?.speaker).toBe("Ben");
    expect(v.roster().map((r) => r.label)).toEqual(["Ana", "Speaker 1", "Ben"]);
  });

  test("[T3.10] Names lost after the agent's context is compacted: a fresh fold of the log has the roster", () => {
    const b = basicCall();
    b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "agent:claude-code" });
    b.add({
      type: "remember",
      id: "r1",
      rev: 1,
      text: "Ben owns the box",
      by: "agent:claude-code",
    });
    // A new agent session: nothing survives but the log.
    const fresh = fold(JSON.parse(JSON.stringify(b.events)));
    expect(fresh.roster().find((r) => r.spk === "c2")?.name).toBe("Ben");
    expect(fresh.remembered().map((r) => r.text)).toEqual(["Ben owns the box"]);
  });

  test("final clusters take the live name through speaker.map; a suggestion is not applied", () => {
    const b = basicCall();
    b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    b.seg({ id: "f000001", layer: "final", spk: "s0", w0: T0 + 3 * S, text: "final text" });
    b.seg({ id: "f000002", layer: "final", spk: "s1", w0: T0 + 2 * S, text: "hello Ana" });
    b.add({ type: "speaker.map", final: "s0", live: "c2", overlap: 0.9 });
    b.add({ type: "speaker.suggest", final: "s1", live: "c1", overlap: 0.4 });
    const v = fold(b.events);
    expect(v.resolve("f000001")?.speaker).toBe("Ben");
    expect(v.resolve("f000002")?.spk).toBe("s1");
    expect(v.speakerSuggestions().map((s) => s.final)).toEqual(["s1"]);
  });
});

describe("the fold: layers", () => {
  function twoPartCall(): LogBuilder {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.seg({ id: "l000001", part: 1, w0: T0 + S, text: "live one" });
    b.partEnded(1, "restart");
    b.partStarted(2, T0 + 60 * S);
    b.seg({ id: "l000002", part: 2, w0: T0 + 61 * S, text: "live two" });
    b.partEnded(2, "stop");
    b.add({ type: "call.ended", reason: "stop" });
    b.add({ type: "final.started", pid: 99 });
    return b;
  }

  test("[design risk] Layer switch confuses a live reader: best switches per part on final.part.done and live ids still resolve", () => {
    const b = twoPartCall();
    const v = fold(b.events);
    expect(v.lines().map((l) => l.id)).toEqual(["l000001", "l000002"]);
    expect(v.final.state).toBe("running");

    // Part 1's final segments land first; part 2 stays live until its own final.part.done.
    v.apply(b.seg({ id: "f000001", layer: "final", part: 1, w0: T0 + S, text: "final one" }));
    expect(v.lines().map((l) => l.id)).toEqual(["l000001", "l000002"]);
    v.apply(b.add({ type: "final.part.done", part: 1 }));
    expect(v.lines().map((l) => l.id)).toEqual(["f000001", "l000002"]);

    v.apply(b.seg({ id: "f000002", layer: "final", part: 2, w0: T0 + 61 * S, text: "final two" }));
    v.apply(b.add({ type: "final.part.done", part: 2 }));
    v.apply(b.add({ type: "final.done", parts: [1, 2], skipped: [] }));
    expect(v.lines().map((l) => l.id)).toEqual(["f000001", "f000002"]);
    expect(v.final.state).toBe("done");

    // The live layer is never removed.
    expect(v.resolve("l000001")?.text).toBe("live one");
    expect(v.lines("live").map((l) => l.id)).toEqual(["l000001", "l000002"]);
    expect(v.lines("final").map((l) => l.id)).toEqual(["f000001", "f000002"]);
  });

  test("[design risk] a resume after final.done shows the new part live until the pass re-runs", () => {
    const b = twoPartCall();
    b.seg({ id: "f000001", layer: "final", part: 1, w0: T0 + S, text: "final one" });
    b.add({ type: "final.part.done", part: 1 });
    b.seg({ id: "f000002", layer: "final", part: 2, w0: T0 + 61 * S, text: "final two" });
    b.add({ type: "final.part.done", part: 2 });
    b.add({ type: "final.done", parts: [1, 2], skipped: [] });
    b.partStarted(3, T0 + 300 * S);
    b.seg({ id: "l000003", part: 3, w0: T0 + 301 * S, text: "live three" });
    const v = fold(b.events);
    expect(v.lines().map((l) => l.id)).toEqual(["f000001", "f000002", "l000003"]);
    // Re-running the pass keeps the finished parts on the final layer meanwhile.
    v.apply(b.add({ type: "final.started", pid: 100 }));
    expect(v.lines().map((l) => l.id)).toEqual(["f000001", "f000002", "l000003"]);
  });

  test("[T2.7] Only channel 0 read: final.done keeps its warning and skipped spans", () => {
    const b = twoPartCall();
    b.add({
      type: "final.done",
      parts: [1, 2],
      skipped: [{ part: 2, from: 10, to: 30 }],
      warning: "call channel had energy but produced no text",
    });
    const v = fold(b.events);
    expect(v.final.done?.warning).toMatch(/no text/);
    expect(v.final.done?.skipped).toHaveLength(1);
  });

  test("final.failed is reported and cleared by the next run", () => {
    const b = twoPartCall();
    b.add({ type: "final.failed", step: "diarize", error: "boom" });
    const v = fold(b.events);
    expect(v.final.state).toBe("failed");
    v.apply(b.add({ type: "final.started", pid: 7 }));
    expect(v.final.state).toBe("running");
    expect(v.final.failed).toBeUndefined();
  });
});

describe("the fold: notes, memory, memo, Q&A, enhanced", () => {
  test("notes: latest rev, deletion, and two visible authors", () => {
    const b = basicCall();
    b.add({
      type: "note",
      id: "n1",
      rev: 1,
      text: "build -> box?",
      w: T0 + 2 * S,
      afterSeq: 4,
      by: "user",
    });
    b.add({
      type: "note",
      id: "n1",
      rev: 2,
      text: "build -> new box?",
      w: T0 + 2 * S,
      afterSeq: 4,
      by: "user",
    });
    b.add({
      type: "note",
      id: "n2",
      rev: 1,
      text: "- Ben to move the build",
      w: T0 + 3 * S,
      afterSeq: 5,
      by: "agent:claude-code",
    });
    b.add({
      type: "note",
      id: "n3",
      rev: 1,
      text: "scratch",
      w: T0 + 4 * S,
      afterSeq: 5,
      by: "user",
    });
    b.add({ type: "note.del", id: "n3", by: "user" });
    const v = fold(b.events);
    expect(v.notes().map((n) => [n.id, n.text, n.author, n.client])).toEqual([
      ["n1", "build -> new box?", "human", undefined],
      ["n2", "- Ben to move the build", "agent", "claude-code"],
    ]);
  });

  test("remember items are corrected by rev and retracted by text: null", () => {
    const b = basicCall();
    b.add({ type: "remember", id: "r1", rev: 1, text: "Ben owns the box", by: "agent:codex" });
    b.add({ type: "remember", id: "r2", rev: 1, text: "Deadline Friday", by: "agent:codex" });
    b.add({ type: "remember", id: "r2", rev: 2, text: "Deadline Thursday", by: "agent:codex" });
    b.add({ type: "remember", id: "r1", rev: 2, text: null, by: "agent:codex" });
    expect(
      fold(b.events)
        .remembered()
        .map((r) => r.text),
    ).toEqual(["Deadline Thursday"]);
  });

  test("the memo is the latest memo event; chunk summaries are never read as the memo", () => {
    const b = basicCall();
    b.add({ type: "memo", rev: 1, body: "memo one", coversSeq: 4, by: "user", model: "m" });
    b.add({ type: "chunk.summary", from: 1, to: 5, body: "chunk body", model: "m" });
    b.add({ type: "memo", rev: 2, body: "memo two", coversSeq: 5, by: "user", model: "m" });
    b.add({ type: "chunk.summary", from: 6, to: 9, body: "later chunk", model: "m" });
    const v = fold(b.events);
    expect(v.memo?.body).toBe("memo two");
    expect(v.memo?.coversSeq).toBe(5);
    expect(v.chunkSummaries()).toHaveLength(2);
  });

  test("asks pair with their answers; enhanced notes keep every rev", () => {
    const b = basicCall();
    b.add({ type: "ask", id: "q1", q: "what did Ben say?", by: "user" });
    b.add({
      type: "answer",
      ask: "q1",
      text: "Move the build [15:36 Ben]",
      cites: ["l000003"],
      model: "claude-code/2",
      pack: { mode: "whole-call", tokens: 900 },
    });
    b.add({ type: "ask", id: "q2", q: "and after that?", by: "agent:codex" });
    for (const [rev, template] of [
      [1, "general"],
      [2, "standup"],
    ] as const) {
      b.add({
        type: "enhanced",
        rev,
        template,
        file: "notes.enhanced.md",
        coversSeq: 5,
        by: "user",
        model: "m",
        cites: [],
      });
    }
    const v = fold(b.events);
    expect(v.qa().map((x) => [x.ask.id, x.answer?.cites])).toEqual([
      ["q1", ["l000003"]],
      ["q2", undefined],
    ]);
    expect(v.enhanced()).toHaveLength(2);
    expect(v.latestEnhanced()?.template).toBe("standup");
  });
});

describe("the fold: vocabulary at read time (DESIGN 5.4)", () => {
  const files = [{ term: "Kubernetes", heard: ["kubernetis", "cubernetes"], confirmed: true }];

  test("[T3.11] Answers from uncorrected recognition: rows carry the corrected text and the raw heard text", () => {
    const b = basicCall();
    b.seg({ id: "l000004", w0: T0 + 4 * S, text: "we run it on kubernetis" });
    const v = fold(b.events, { vocabFiles: files, isDictionaryWord });
    const line = v.resolve("l000004");
    expect(line?.text).toBe("we run it on Kubernetes");
    expect(line?.annotated).toBe('we run it on Kubernetes (heard: "kubernetis")');
    expect(line?.heard).toBe("we run it on kubernetis");
    expect(v.segment("l000004")?.text).toBe("we run it on kubernetis");
    // A line with nothing to correct carries no heard field.
    expect(v.resolve("l000003")?.heard).toBeUndefined();
  });

  test("[decision] A mid-call add applies backward to reading: segment 3 renders corrected after a vocab.add at segment 10", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    for (let i = 1; i <= 10; i++) {
      const text = i === 3 ? "ask annika about the deploy" : `line ${i} of the call`;
      b.seg({ id: `l${String(i).padStart(6, "0")}`, w0: T0 + i * S, text });
    }
    const v = fold(b.events);
    expect(v.resolve("l000003")?.text).toBe("ask annika about the deploy");
    v.apply(
      b.add({
        type: "vocab.add",
        id: "v1",
        rev: 1,
        term: "Anika",
        heard: ["annika"],
        by: "agent:claude-code",
      }),
    );
    expect(v.resolve("l000003")?.annotated).toBe('ask Anika (heard: "annika") about the deploy');
    expect(v.segment("l000003")?.text).toBe("ask annika about the deploy");
    expect(v.callVocabulary().map((e) => [e.term, e.decode])).toEqual([["Anika", true]]);
  });

  test("[T1.19] Quadratic token mapping: a vocab.add re-renders only the segments its heard forms occur in", () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    const n = 3000; // a 3-hour call at one line every 3.6 s
    for (let i = 1; i <= n; i++) {
      const text = i % 500 === 0 ? `mention of annika number ${i}` : `ordinary line ${i}`;
      b.seg({ id: `l${String(i).padStart(6, "0")}`, w0: T0 + i * 3600, text });
    }
    const v = fold(b.events);
    expect(v.lines()).toHaveLength(n);
    expect(v.stats.renders).toBe(n);
    v.apply(
      b.add({ type: "vocab.add", id: "v1", rev: 1, term: "Anika", heard: ["annika"], by: "user" }),
    );
    const lines = v.lines();
    expect(v.stats.renders).toBe(n + n / 500);
    expect(lines.filter((l) => l.text.includes("Anika"))).toHaveLength(n / 500);
    // Reading again without changes renders nothing.
    v.lines();
    expect(v.stats.renders).toBe(n + n / 500);
  });

  test("vocab.add with segs applies only to those segments; a retraction removes it", () => {
    const b = basicCall();
    b.seg({ id: "l000004", w0: T0 + 4 * S, text: "annika here" });
    b.seg({ id: "l000005", w0: T0 + 5 * S, text: "annika there" });
    b.add({
      type: "vocab.add",
      id: "v1",
      rev: 1,
      term: "Anika",
      heard: ["annika"],
      by: "user",
      segs: ["l000005"],
    });
    const v = fold(b.events);
    expect(v.resolve("l000004")?.text).toBe("annika here");
    expect(v.resolve("l000005")?.text).toBe("Anika there");
    v.apply(b.add({ type: "vocab.add", id: "v1", rev: 2, term: null, by: "user" }));
    expect(v.resolve("l000005")?.text).toBe("annika there");
    expect(v.callVocabulary()).toEqual([]);
  });

  test("[decision] The raw heard text is never overwritten: every correction path leaves the events untouched", () => {
    const b = basicCall();
    b.seg({ id: "l000004", w0: T0 + 4 * S, text: "on kubernetis with annika and versal" });
    b.add({ type: "vocab.add", id: "v1", rev: 1, term: "Anika", heard: ["annika"], by: "user" });
    b.add({
      type: "vocab.propose",
      id: "p1",
      rev: 1,
      term: "Vercel",
      heard: ["versal"],
      by: "app",
      evidence: {},
      status: "proposed",
    });
    b.add({
      type: "vocab.propose",
      id: "p1",
      rev: 2,
      term: "Vercel",
      heard: ["versal"],
      by: "user",
      evidence: {},
      status: "accepted",
    });
    b.add({
      type: "seg",
      id: "l000004",
      rev: 2,
      text: "on kubernetis with annika and versal!",
      by: "user",
    });
    const before = snapshot(b.events);
    const v = fold(b.events, { vocabFiles: files, isDictionaryWord });
    const line = v.resolve("l000004");
    expect(line?.text).toBe("on Kubernetes with Anika and Vercel!");
    expect(b.events).toEqual(before);
    // The user's whole-line edit is a revision; revision 1 is still in the log as written.
    expect(v.segment("l000004")?.revisions[0]?.text).toBe("on kubernetis with annika and versal");
    // Positive control: the same comparison catches a fold that writes into its input.
    const mutated = snapshot(before);
    (mutated.at(-1) as { text: string }).text = "on Kubernetes with Anika and Vercel!";
    expect(mutated).not.toEqual(before);
  });

  test("[decision] An unconfirmed entry does nothing", () => {
    const b = basicCall();
    b.seg({ id: "l000004", w0: T0 + 4 * S, text: "on kubernetis" });
    const unconfirmed = [{ term: "Kubernetes", heard: ["kubernetis"], confirmed: false }];
    expect(
      fold(b.events, { vocabFiles: unconfirmed, isDictionaryWord }).resolve("l000004")?.text,
    ).toBe("on kubernetis");
    // Positive control: the same entry confirmed does correct.
    const confirmed = [{ ...unconfirmed[0], confirmed: true } as (typeof unconfirmed)[0]];
    expect(
      fold(b.events, { vocabFiles: confirmed, isDictionaryWord }).resolve("l000004")?.text,
    ).toBe("on Kubernetes");
  });

  test("[spike] A heard form that is a real word: a file pair on a dictionary word renders unchanged, a call-scoped one applies", () => {
    const b = basicCall();
    b.seg({ id: "l000004", w0: T0 + 4 * S, text: "the vessel is ready" });
    const file = [{ term: "Vessl", heard: ["vessel"], confirmed: true }];
    expect(fold(b.events, { vocabFiles: file, isDictionaryWord }).resolve("l000004")?.text).toBe(
      "the vessel is ready",
    );
    b.add({ type: "vocab.add", id: "v1", rev: 1, term: "Vessl", heard: ["vessel"], by: "user" });
    expect(fold(b.events, { vocabFiles: file, isDictionaryWord }).resolve("l000004")?.text).toBe(
      "the Vessl is ready",
    );
  });

  test("a proposal is inert until accepted", () => {
    const b = basicCall();
    b.seg({ id: "l000004", w0: T0 + 4 * S, text: "deploy to versal" });
    const propose = (rev: number, status: "proposed" | "accepted" | "rejected") =>
      b.add({
        type: "vocab.propose",
        id: "p1",
        rev,
        term: "Vercel",
        heard: ["versal"],
        by: "app",
        evidence: {},
        status,
      });
    propose(1, "proposed");
    const v = fold(b.events, { isDictionaryWord });
    expect(v.resolve("l000004")?.text).toBe("deploy to versal");
    expect(v.proposals("proposed")).toHaveLength(1);
    v.apply(propose(2, "accepted"));
    expect(v.resolve("l000004")?.text).toBe("deploy to Vercel");
    expect(v.proposals("proposed")).toHaveLength(0);
    v.apply(propose(3, "rejected"));
    expect(v.resolve("l000004")?.text).toBe("deploy to versal");
  });

  test("speaker names are fuzzy terms: naming a speaker corrects its misspellings", () => {
    const b = basicCall();
    b.seg({ id: "l000004", w0: T0 + 4 * S, text: "thanks siobahn" });
    const v = fold(b.events, { isDictionaryWord });
    expect(v.resolve("l000004")?.text).toBe("thanks siobahn");
    v.apply(b.add({ type: "speaker.name", spk: "c2", name: "Siobhan", by: "user" }));
    expect(v.resolve("l000004")?.text).toBe("thanks Siobhan");
  });

  test("a full speaker name corrects misspellings of each of its words", () => {
    const b = basicCall();
    b.seg({ id: "l000004", w0: T0 + 4 * S, text: "I spoke with Anikaa and Ruizz yesterday" });
    const v = fold(b.events, { isDictionaryWord });
    v.apply(b.add({ type: "speaker.name", spk: "c2", name: "Anika Ruiz", by: "user" }));
    expect(v.resolve("l000004")?.text).toBe("I spoke with Anika and Ruiz yesterday");
  });

  test("vocab.used: the latest decode list in force", () => {
    const b = basicCall();
    b.add({
      type: "vocab.used",
      entries: ["Kubernetes"],
      files: ["a.yaml"],
      sha256: ["1"],
      model: "m",
    });
    b.add({
      type: "vocab.used",
      entries: ["Kubernetes", "Anika"],
      files: ["a.yaml"],
      sha256: ["1"],
      model: "m",
    });
    expect(fold(b.events).vocabUsed?.entries).toEqual(["Kubernetes", "Anika"]);
  });
});

describe("the fold: health, sharing, hand-off", () => {
  test("health is kept per part and channel; the newest part wins", () => {
    const b = basicCall();
    const h = (part: number, state: string) =>
      b.add({ type: "health", part, ch: "call", state, silentFor: 12, rebuilds: 1, detail: "" });
    h(1, "dead");
    h(1, "ok");
    b.partEnded(1, "restart");
    b.partStarted(2, T0 + 90 * S);
    h(2, "dead");
    b.add({ type: "asr.lag", part: 2, seconds: 31 });
    const v = fold(b.events);
    expect(v.channelHealth("call")?.state).toBe("dead");
    expect(v.channelHealth("call")?.part).toBe(2);
    expect(v.health().map((x) => [x.part, x.state])).toEqual([
      [1, "ok"],
      [2, "dead"],
    ]);
    expect(v.healthHistory()).toHaveLength(3);
    expect(v.asrLag?.seconds).toBe(31);
  });

  test("share on and off, exports, hooks and webhooks", () => {
    const b = basicCall();
    b.add({
      type: "share.started",
      bind: "tailnet",
      expires: "call-end",
      include: { transcript: true },
    });
    const v = fold(b.events);
    expect(v.share.active).toBe(true);
    v.apply(b.add({ type: "share.stopped" }));
    expect(v.share.active).toBe(false);
    v.apply(b.add({ type: "export.done", path: "x.md", sha256: "ab" }));
    v.apply(b.add({ type: "hook.done", name: "git", exit: 0, ms: 5 }));
    v.apply(
      b.add({ type: "webhook.done", url: "https://example.invalid", status: 200, attempts: 1 }),
    );
    const h = v.handoff();
    expect([h.exports.length, h.hooks.length, h.webhooks.length]).toEqual([1, 1, 1]);
  });
});

describe("provisional lines (DESIGN 3.1 step 6)", () => {
  test("[design] Provisional text quoted as fact: a draft expires after 3 s", () => {
    const board = new ProvisionalBoard();
    board.update({ ch: "call", part: 1, pseq: 1, text: "we should", w0: T0, at: T0 });
    expect(board.current(T0 + PROVISIONAL_TTL_MS - 1)).toHaveLength(1);
    expect(board.current(T0 + PROVISIONAL_TTL_MS)).toHaveLength(0);
  });

  test("newest wins: an older update never replaces a newer one", () => {
    const board = new ProvisionalBoard();
    board.update({ ch: "call", part: 1, pseq: 2, text: "we should move", w0: T0, at: T0 + 1000 });
    expect(
      board.update({ ch: "call", part: 1, pseq: 1, text: "we should", w0: T0, at: T0 + 1100 }),
    ).toBe(false);
    expect(board.current(T0 + 1200)[0]?.text).toBe("we should move");
  });

  test("cleared on close: the committed line replaces the draft; drafts are never events", () => {
    const b = basicCall();
    const v = fold(b.events);
    v.provisional.update({
      ch: "call",
      part: 1,
      pseq: 1,
      text: "the build bo",
      w0: T0 + 10 * S,
      at: T0 + 11 * S,
    });
    v.provisional.update({
      ch: "mic",
      part: 1,
      pseq: 1,
      text: "yes",
      w0: T0 + 10 * S,
      at: T0 + 11 * S,
    });
    expect(v.provisional.current(T0 + 11 * S).map((p) => p.ch)).toEqual(["mic", "call"]);
    v.apply(b.seg({ id: "l000004", w0: T0 + 10 * S, text: "the build box" }));
    expect(v.provisional.current(T0 + 11 * S).map((p) => p.ch)).toEqual(["mic"]);
    expect(v.lastSeq).toBe(b.events.length);
  });
});
