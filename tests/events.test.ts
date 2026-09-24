import { describe, expect, test } from "bun:test";
import {
  EVENT_FIELDS,
  EVENT_TYPES,
  LIFECYCLE_TYPES,
  validateDraft,
  validateEvent,
} from "../src/core/log/events.ts";

const env = { seq: 5, t: 1790170572000 };

/** One valid example of every event type in schema v1 (DESIGN 4.3). */
export const EXAMPLES: Record<string, Record<string, unknown>> = {
  "call.created": {
    id: "01J8Z6Q4M2VX0K7B3D4E5F6G7H",
    schema: 1,
    workspace: "work",
    title: "Weekly sync",
    tz: "America/Chicago",
    user: "Ana",
    akou: "0.1.0",
    template: "standup",
  },
  "call.ended": { reason: "stop" },
  "call.failed": { stage: "open", error: "exit 77" },
  "part.started": {
    part: 1,
    file: "audio/part-001.opus",
    wallStart: 1790170572392,
    monoStart: 123456789,
    mic: "MacBook Pro Microphone",
    call: { mode: "system", exclude: ["akou Graphics and Media"] },
    capture: "akou-capture 0.1.0",
  },
  "part.ended": { part: 1, reason: "restart", fileSeconds: 12.5 },
  pause: { part: 1, a: 30, wall: 1790170602392, mono: 123486789 },
  resume: { part: 1, a: 30, wall: 1790170902392, mono: 123786789 },
  mute: { part: 1, a: 40 },
  unmute: { part: 1, a: 50 },
  gap: { part: 1, a: 60, wallFrom: 1790170700000, wallTo: 1790171700000, reason: "sleep" },
  seg: {
    id: "l000031",
    rev: 1,
    layer: "live",
    part: 1,
    ch: "call",
    spk: "c2",
    a0: 131.2,
    a1: 136.9,
    w0: 1790170703592,
    w1: 1790170709292,
    text: "we should move the build to the new box",
    lang: "en",
    model: "parakeet-tdt-0.6b-v3-fp32",
  },
  "speaker.centroid": { spk: "c2", vec: "AAAAAA==" },
  "speaker.merge": { from: "c3", into: "c2" },
  "speaker.unmerge": { from: "c3", into: "c2" },
  "speaker.name": { spk: "c2", name: "Ben", by: "agent:claude-code" },
  "speaker.map": { final: "f1", live: "c2", overlap: 0.82 },
  "speaker.suggest": { final: "f2", live: "c3", overlap: 0.41 },
  note: {
    id: "n0004",
    rev: 1,
    text: "build -> new box?",
    w: 1790170740800,
    afterSeq: 63,
    by: "user",
  },
  "note.del": { id: "n0004", by: "user" },
  remember: { id: "r1", rev: 1, text: "Ben owns the build box", by: "agent:claude-code" },
  memo: { rev: 1, body: "Topics: build box", coversSeq: 60, by: "user", model: "claude-code/2" },
  "chunk.summary": { from: 1, to: 60, body: "chunk", model: "claude-code/2" },
  ask: { id: "q1", q: "what did Ben say?", by: "user" },
  answer: {
    ask: "q1",
    text: "He wants the new box [15:41 Ben]",
    cites: ["l000031"],
    model: "claude-code/2",
    pack: { mode: "retrieval", tokens: 4200 },
  },
  enhanced: {
    rev: 1,
    template: "standup",
    file: "notes.enhanced.md",
    coversSeq: 90,
    by: "user",
    model: "claude-code/2",
    cites: ["l000031"],
  },
  "vocab.used": {
    entries: ["Kubernetes"],
    files: ["~/.config/akou/vocab.yaml"],
    sha256: ["ab"],
    model: "parakeet-tdt-0.6b-v3-fp32",
  },
  "vocab.add": { id: "v1", rev: 1, term: "Anika", heard: ["annika"], by: "user" },
  "vocab.propose": {
    id: "p1",
    rev: 1,
    term: "Vercel",
    heard: ["versal"],
    by: "app",
    evidence: { segs: ["l000031"] },
    status: "proposed",
  },
  health: {
    part: 1,
    ch: "call",
    state: "dead",
    silentFor: 12,
    rebuilds: 1,
    detail: "output running, probe heard audio, rebuilding",
  },
  "asr.lag": { part: 1, seconds: 12 },
  "final.started": { pid: 4242 },
  "final.part.done": { part: 1 },
  "final.done": { parts: [1, 2], languages: ["en"], skipped: [], warning: "no text" },
  "final.failed": { step: "diarize", error: "model missing" },
  "share.started": {
    bind: "tailnet",
    expires: "call-end",
    include: { transcript: true, names: true, notes: false, enhanced: false, audio: false },
  },
  "share.stopped": {},
  "export.done": { path: "/exports/work/2026-09-23 1536 Weekly sync.md", sha256: "ab" },
  "hook.done": { name: "git-commit", exit: 0, ms: 120 },
  "webhook.done": { url: "https://example.invalid/hook", status: 200, attempts: 1 },
};

describe("schema v1 (DESIGN 4.3)", () => {
  test("every event type in the design has an example and validates", () => {
    expect([...EVENT_TYPES].sort() as string[]).toEqual(Object.keys(EXAMPLES).sort());
    for (const type of EVENT_TYPES) {
      const r = validateEvent({ ...env, type, ...EXAMPLES[type] });
      expect(r.ok ? "ok" : `${type}: ${r.error}`).toBe("ok");
    }
  });

  test("the design's own sample lines validate", () => {
    const lines = [
      '{"seq":1,"t":1790170572000,"type":"call.created","id":"01J8Z6Q4M2VX0K7B3D4E5F6G7H","schema":1,"workspace":"work","title":"Weekly sync","tz":"America/Chicago","user":"Ana","akou":"0.1.0","template":"standup"}',
      '{"seq":2,"t":1790170572410,"type":"part.started","part":1,"file":"audio/part-001.opus","wallStart":1790170572392,"monoStart":123456789,"mic":"MacBook Pro Microphone","call":{"mode":"system","exclude":["akou Graphics and Media"]},"capture":"akou-capture 0.1.0"}',
      '{"seq":57,"t":1790170710100,"type":"seg","id":"l000031","rev":1,"layer":"live","part":1,"ch":"call","spk":"c2","a0":131.2,"a1":136.9,"w0":1790170703592,"w1":1790170709292,"text":"we should move the build to the new box","lang":"en","model":"parakeet-tdt-0.6b-v3-fp32"}',
      '{"seq":58,"t":1790170711000,"type":"speaker.name","spk":"c2","name":"Ben","by":"agent:claude-code"}',
      '{"seq":64,"t":1790170741000,"type":"note","id":"n0004","rev":1,"text":"build -> new box?","w":1790170740800,"afterSeq":63,"by":"user"}',
      '{"seq":90,"t":1790170900000,"type":"health","part":1,"ch":"call","state":"dead","silentFor":12,"rebuilds":1,"detail":"output running, probe heard audio, rebuilding"}',
    ];
    for (const l of lines) expect(validateEvent(JSON.parse(l)).ok).toBe(true);
  });

  test("an unknown type is refused", () => {
    const r = validateEvent({ ...env, type: "seg.partial", text: "hi" });
    expect(r).toEqual({ ok: false, error: 'unknown event type "seg.partial"' });
  });

  test("provisional lines can never be written as events", () => {
    for (const type of ["partial", "provisional", "draft", "level"]) {
      expect(validateDraft({ type, text: "still being spoken" }).ok).toBe(false);
    }
  });

  test("every required field is enforced: dropping any one is refused", () => {
    const optional: Record<string, string[]> = {
      "call.created": ["template"],
      seg: ["lang"],
      "final.done": ["languages", "warning"],
    };
    let checked = 0;
    for (const type of EVENT_TYPES) {
      const example = EXAMPLES[type] as Record<string, unknown>;
      for (const field of Object.keys(example)) {
        if (optional[type]?.includes(field)) continue;
        const { [field]: _dropped, ...rest } = example;
        const r = validateEvent({ ...env, type, ...rest });
        expect(r.ok ? `${type} accepted without ${field}` : "refused").toBe("refused");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("every field's type is enforced: a wrong-typed value in any field is refused", () => {
    const wrong: Record<string, unknown[]> = {
      string: [42, null, ["x"]],
      number: ["1", Number.NaN, null],
      int: [1.5, "1", null],
      boolean: ["true", 1],
      "string|null": [42, ["x"]],
      "string[]": ["x", [1]],
      "number[]": ["x", ["1"]],
      array: ["x", {}],
      object: ["x", [], null],
      author: [42, "claude"],
      noteAuthor: [42, "app"],
      channel: ["left", 1],
      layer: ["draft", 1],
    };
    let checked = 0;
    for (const type of EVENT_TYPES) {
      const example = EXAMPLES[type] as Record<string, unknown>;
      for (const [field, spec] of Object.entries(EVENT_FIELDS[type])) {
        if (spec.kind === "any") continue;
        const bad = Array.isArray(spec.kind) ? ["not-in-enum", 1] : wrong[spec.kind as string];
        expect([type, field, bad === undefined]).toEqual([type, field, false]);
        for (const value of bad ?? []) {
          const r = validateEvent({ ...env, type, ...example, [field]: value });
          expect(r.ok ? `${type}.${field} accepted ${JSON.stringify(value)}` : "refused").toBe(
            "refused",
          );
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(250);
  });

  test("optional fields may be left out", () => {
    const { template: _t, ...created } = EXAMPLES["call.created"] as Record<string, unknown>;
    expect(validateEvent({ ...env, type: "call.created", ...created }).ok).toBe(true);
    const {
      languages: _l,
      warning: _w,
      ...done
    } = EXAMPLES["final.done"] as Record<string, unknown>;
    expect(validateEvent({ ...env, type: "final.done", ...done }).ok).toBe(true);
  });

  test("the envelope is required: seq positive integer, t a number", () => {
    const body = { type: "call.ended", reason: "stop" };
    expect(validateEvent({ ...body, t: 1 }).ok).toBe(false);
    expect(validateEvent({ ...body, seq: 0, t: 1 }).ok).toBe(false);
    expect(validateEvent({ ...body, seq: 1.5, t: 1 }).ok).toBe(false);
    expect(validateEvent({ ...body, seq: 1 }).ok).toBe(false);
    expect(validateEvent({ ...body, seq: 1, t: 1 }).ok).toBe(true);
  });

  test("enums are closed", () => {
    expect(validateEvent({ ...env, type: "call.ended", reason: "done" }).ok).toBe(false);
    expect(
      validateEvent({ ...env, type: "part.ended", part: 1, reason: "wedged", fileSeconds: 1 }).ok,
    ).toBe(false);
    expect(validateEvent({ ...env, ...EXAMPLES.seg, type: "seg", ch: "left" }).ok).toBe(false);
  });

  test("a seg revision may carry only the fields that changed; revision 1 must carry all", () => {
    expect(validateEvent({ ...env, type: "seg", id: "l000031", rev: 2, text: "fixed" }).ok).toBe(
      true,
    );
    expect(validateEvent({ ...env, type: "seg", id: "l000031", rev: 2, text: null }).ok).toBe(true);
    const r = validateEvent({ ...env, type: "seg", id: "l000031", rev: 1, text: "only text" });
    expect(r.ok).toBe(false);
  });

  test("a seg id must match its layer", () => {
    const r = validateEvent({ ...env, type: "seg", ...EXAMPLES.seg, id: "f000031" });
    expect(r.ok).toBe(false);
  });

  test("call.created carries schema 1 only", () => {
    const r = validateEvent({
      ...env,
      type: "call.created",
      ...EXAMPLES["call.created"],
      schema: 2,
    });
    expect(r.ok).toBe(false);
  });

  test("vocab.add: a term needs heard forms; a null term retracts", () => {
    expect(
      validateEvent({ ...env, type: "vocab.add", id: "v1", rev: 1, term: "Anika", by: "user" }).ok,
    ).toBe(false);
    expect(
      validateEvent({ ...env, type: "vocab.add", id: "v1", rev: 2, term: null, by: "user" }).ok,
    ).toBe(true);
    expect(
      validateEvent({
        ...env,
        type: "vocab.add",
        id: "v1",
        rev: 1,
        term: " ",
        heard: [],
        by: "user",
      }).ok,
    ).toBe(false);
  });

  test("[decision] Agent-authored notes indistinguishable from the user's: by is user or agent:<client>", () => {
    const note = EXAMPLES.note as Record<string, unknown>;
    expect(validateEvent({ ...env, type: "note", ...note, by: "agent:codex" }).ok).toBe(true);
    expect(validateEvent({ ...env, type: "note", ...note, by: "user" }).ok).toBe(true);
    // Positive control: an author that hides who wrote it is refused.
    for (const by of ["claude", "agent:", "app", "", "User"]) {
      expect(validateEvent({ ...env, type: "note", ...note, by }).ok).toBe(false);
    }
  });

  test("[decision] every author field takes user, app or agent:<client>, and nothing else", () => {
    const carriers = EVENT_TYPES.filter((t) => "by" in EVENT_FIELDS[t]);
    expect(carriers.length).toBeGreaterThanOrEqual(10);
    for (const type of carriers) {
      const body = { ...env, type, ...EXAMPLES[type] };
      const isNote = type === "note" || type === "note.del";
      for (const by of ["user", "agent:codex"]) {
        expect([type, by, validateEvent({ ...body, by }).ok]).toEqual([type, by, true]);
      }
      expect([type, "app", validateEvent({ ...body, by: "app" }).ok]).toEqual([
        type,
        "app",
        !isNote,
      ]);
      for (const by of ["claude", "agent:", "", "User", "agent: x", " user"]) {
        expect([type, by, validateEvent({ ...body, by }).ok]).toEqual([type, by, false]);
      }
    }
  });

  test("non-finite numbers are refused, since JSON would write them as null", () => {
    const done = EXAMPLES["final.done"] as Record<string, unknown>;
    expect(validateDraft({ type: "final.done", ...done, parts: [Number.NaN] }).ok).toBe(false);
    expect(validateDraft({ type: "final.done", ...done, parts: [1, Infinity] }).ok).toBe(false);
    const answer = EXAMPLES.answer as Record<string, unknown>;
    const pack = (tokens: number) => ({ type: "answer", ...answer, pack: { mode: "r", tokens } });
    expect(validateDraft(pack(Infinity)).ok).toBe(false);
    expect(validateDraft(pack(Number.NaN)).ok).toBe(false);
    // Positive control: the same shapes with finite numbers are accepted.
    expect(validateDraft({ type: "final.done", ...done, parts: [1, 2] }).ok).toBe(true);
    expect(validateDraft(pack(4200)).ok).toBe(true);
  });

  test("round trip: whatever a writer accepts, a reader parses back as valid", () => {
    const odd: unknown[] = [Number.NaN, Infinity, -Infinity, [Number.NaN], [1, Infinity]];
    // Every leaf of every example, nested ones included, replaced by each odd value in turn.
    function* variants(v: unknown): Generator<unknown> {
      yield* odd;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          for (const x of variants(v[i])) yield v.map((e, j) => (j === i ? x : e));
        }
      } else if (typeof v === "object" && v !== null) {
        for (const [k, e] of Object.entries(v)) {
          for (const x of variants(e)) yield { ...v, [k]: x };
        }
      }
    }
    let accepted = 0;
    let tried = 0;
    for (const type of EVENT_TYPES) {
      for (const draft of variants({ type, ...EXAMPLES[type] })) {
        tried++;
        if (!validateDraft(draft).ok) continue;
        accepted++;
        const line = JSON.stringify({ ...env, ...(draft as object) });
        const back = validateEvent(JSON.parse(line));
        expect(back.ok ? "ok" : `${line} -> ${back.error}`).toBe("ok");
      }
    }
    expect(tried).toBeGreaterThan(1000);
    // The property is not vacuous: odd values inside free-form fields are accepted and survive.
    expect(accepted).toBeGreaterThan(0);
  });

  test("lifecycle events are a subset of the schema", () => {
    for (const t of LIFECYCLE_TYPES) expect(EVENT_TYPES).toContain(t);
  });
});
