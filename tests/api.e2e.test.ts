/**
 * The local API end to end (docs/DESIGN.md sections 1.5, 4.5, 5.4, 5.5 and 6.2): a headless app in a
 * temporary `AKOU_HOME`, capturing from `scripts/fake-helper.ts` (which plays a tone-coded WAV the
 * fake recognizer reads as words) and answering over HTTP with the real guard and token.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;
let rig: AppRig;
let wavDir: { dir: string; cleanup: () => void };

/** Mic: "hello world"; call: "deploy to hetzner", which the unbiased fake engine hears "hetzna". */
function writeSpeech(dir: string): string {
  const mic = concat(silence(0.3), speak(["hello", "world"]), silence(2.2));
  const call = concat(silence(1.1), speak(["deploy", "to", "hetzner"], { voice: 2 }), silence(0.6));
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
  const path = join(dir, "speech.wav");
  writeFileSync(path, stereoWav(pad(mic), pad(call)));
  return path;
}

beforeAll(async () => {
  wavDir = tempDir();
  rig = await appRig({
    helperArgs: ["--wav", writeSpeech(wavDir.dir)],
    finalAudio: ({ parts }) => ({
      kind: "module",
      path: FAKE_MODELS,
      options: {
        parts: Object.fromEntries(
          parts.map((p) => [
            p,
            {
              mic: concat(silence(0.3), speak(["hello", "world"]), silence(1)),
              call: concat(silence(1.5), speak(["ok", "great"], { voice: 2 }), silence(0.5)),
            },
          ]),
        ),
      },
    }),
  });
});

afterAll(async () => {
  await rig?.close();
  wavDir?.cleanup();
});

async function live(): Promise<string> {
  const r = await rig.api("GET", "/calls/live");
  if (r.status === 200 && (r.body.state === "recording" || r.body.state === "paused")) {
    return r.body.id;
  }
  return rig.startCall();
}

async function stopAll(): Promise<void> {
  const r = await rig.api("GET", "/calls/live");
  if (r.status === 200) expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
}

async function eventsOf(id: string): Promise<LogEvent[]> {
  return (await rig.api("GET", `/calls/${id}/events`)).body.events;
}

describe("starting a call", () => {
  test(
    "[T3.6] Minutes to start: POST /v1/calls answers 201 fast, after capturing, with the folder",
    async () => {
      await stopAll();
      const t0 = performance.now();
      const r = await rig.api("POST", "/calls", {
        workspace: "work",
        title: "Weekly sync",
        vocab: ["Hetzner", "Ben"],
      });
      const ms = performance.now() - t0;
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ part: 1, url: `akou://call/${r.body.call}` });
      expect(existsSync(join(r.body.folder, "events.jsonl"))).toBe(true);
      // The design's target is 1 s with the app running; CI runners get the cold budget.
      console.log(
        `start: 201 in ${ms.toFixed(0)} ms (helper capturing after ${r.body.firstAudioMs} ms)`,
      );
      expect(ms).toBeLessThan(3000);
      const types = (await eventsOf(r.body.call)).map((e) => e.type);
      // `--vocab` words are written right after call.created, before capture opens.
      expect(types.slice(0, 4)).toEqual(["call.created", "vocab.add", "vocab.add", "part.started"]);
    },
    LONG,
  );

  test("a second start answers 409 already_recording with the live call", async () => {
    const id = await live();
    const r = await rig.api("POST", "/calls", { title: "Other" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: "already_recording",
      message: "a call is already recording",
      call: id,
    });
  });

  test("bad bodies: an unknown field, a bad workspace, a bad vocabulary word", async () => {
    await stopAll();
    expect((await rig.api("POST", "/calls", { titel: "x" })).body.error).toBe("unknown_field");
    const ws = await rig.api("POST", "/calls", { workspace: "../etc" });
    expect([ws.status, ws.body.error]).toEqual([400, "bad_workspace"]);
    const v = await rig.api("POST", "/calls", { vocab: [" padded"] });
    expect([v.status, v.body.error]).toEqual([400, "bad_term"]);
    expect((await rig.api("GET", "/calls/live")).status).toBe(404);
  });
});

describe("controls", () => {
  test(
    "pause, resume, mute, unmute and stop, each an event in the log",
    async () => {
      const id = await live();
      for (const [action, state] of [
        ["pause", "paused"],
        ["resume", "recording"],
        ["mute", "recording"],
        ["unmute", "recording"],
      ] as const) {
        const r = await rig.api("POST", `/calls/live/${action}`);
        expect([action, r.status, r.body.state]).toEqual([action, 200, state]);
      }
      expect((await rig.api("POST", "/calls/live/resume")).body.error).toBe("not_paused");
      const stop = await rig.api("POST", `/calls/${id}/stop`);
      expect(stop.body).toMatchObject({ ok: true, call: id, state: "ended" });
      const types: string[] = (await eventsOf(id)).map((e) => e.type);
      for (const t of ["pause", "resume", "mute", "unmute", "part.ended", "call.ended"]) {
        expect(types).toContain(t);
      }
    },
    LONG,
  );

  test("[T3.14] `current` points at a finished call: live is 404 with last, last is refused on controls", async () => {
    await stopAll();
    const last = rig.app.manager.calls()[0];
    const r = await rig.api("GET", "/calls/live");
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: "no_live_call", last: { id: last?.id } });
    for (const c of ["stop", "pause", "resume", "mute", "unmute"]) {
      const x = await rig.api("POST", `/calls/last/${c}`);
      expect([c, x.status, x.body.error]).toEqual([c, 400, "last_refused"]);
    }
    // Writes refuse `last` too, with a message naming every route that takes it (DESIGN 6.2);
    // reads (context and ask are questions, not changes) and the post-call actions accept it.
    const note = await rig.api("POST", "/calls/last/notes", { text: "x" });
    expect(note.status).toBe(400);
    for (const route of ["restart", "finalize", "export", "enhance", "context", "ask"]) {
      expect(note.body.message).toContain(route);
    }
    const ask = await rig.api("POST", "/calls/last/ask", { question: "what happened?" });
    expect(ask.body.error).not.toBe("last_refused");
    expect((await rig.api("GET", "/calls/last")).body.id).toBe(last?.id);
    const ctx = await rig.api("POST", "/calls/last/context", { question: "what happened?" });
    expect(ctx.status).toBe(200);
    expect(ctx.body.pack).toMatch(/^ENDED at \d\d:\d\d/);
    const q = await rig.api("POST", "/calls/live/context", { question: "what happened?" });
    expect(q.status).toBe(404);
    expect(q.body.error).toBe("no_live_call");
  });

  test(
    "restart: a live call gets part 2; `last` after stop gets part 3, in the same folder",
    async () => {
      const id = await rig.startCall({ title: "Restarts" });
      const r1 = await rig.api("POST", "/calls/live/restart");
      expect(r1.body).toMatchObject({ ok: true, call: id, part: 2 });
      await rig.api("POST", "/calls/live/stop");
      const r2 = await rig.api("POST", "/calls/last/restart", {});
      expect(r2.body).toMatchObject({ ok: true, call: id, part: 3 });
      const detail = await rig.api("GET", `/calls/${id}`);
      expect(detail.body.parts.map((p: { part: number }) => p.part)).toEqual([1, 2, 3]);
      await rig.api("POST", "/calls/live/stop");
    },
    LONG,
  );

  test("an unknown call is 404, an unknown route 404, a wrong method 405", async () => {
    expect((await rig.api("GET", "/calls/01XXXXXXXXXXXXXXXXXXXXXXXX")).status).toBe(404);
    expect((await rig.api("GET", "/nope")).status).toBe(404);
    expect((await rig.api("DELETE", "/status")).status).toBe(405);
  });
});

describe("following and asking about a live call", () => {
  let id: string;

  test(
    "the transcript fills from the fake recognizer: json rows with local times, txt and md",
    async () => {
      await stopAll();
      id = await rig.startCall({ title: "Deploy talk" });
      await until(
        async () =>
          (await rig.api("GET", `/calls/${id}/transcript`)).body.lines.some(
            (l: { ch: string }) => l.ch === "call",
          ),
        10_000,
        "a call-channel line",
      );
      const j = await rig.api("GET", `/calls/${id}/transcript`);
      const mic = j.body.lines.find((l: { ch: string }) => l.ch === "mic");
      expect(mic).toMatchObject({ speaker: "Ana", spk: "you", text: "hello world" });
      expect(mic.time).toMatch(/^\d\d:\d\d:\d\d$/);
      const call = j.body.lines.find((l: { ch: string }) => l.ch === "call");
      expect(call.text).toBe("deploy to hetzna");
      const txt = await rig.api("GET", `/calls/live/transcript?format=txt`);
      expect(txt.headers.get("content-type")).toContain("text/plain");
      expect(txt.text).toMatch(/^Deploy talk\nTimes are local, /);
      expect(txt.text).toMatch(/\d\d:\d\d:\d\d Ana: hello world/);
      const md = await rig.api("GET", `/calls/live/transcript?format=md&speaker=you`);
      expect(md.text).toMatch(/\*\*\d\d:\d\d:\d\d Ana:\*\* hello world/);
      expect(md.text).not.toContain("hetzna");
      expect((await rig.api("GET", `/calls/live/transcript?layer=bogus`)).status).toBe(400);
    },
    LONG,
  );

  test("[T3.11] a mid-call word applies backward to reading: text corrected, heard kept", async () => {
    const add = await rig.api("POST", "/calls/live/vocab", { term: "Hetzner", heard: ["hetzna"] });
    expect(add.status).toBe(201);
    expect(add.body.vocab).toMatchObject({ type: "vocab.add", term: "Hetzner", by: "agent:test" });
    const j = await rig.api("GET", `/calls/${id}/transcript`);
    const call = j.body.lines.find((l: { ch: string }) => l.ch === "call");
    expect(call).toMatchObject({ text: "deploy to Hetzner", heard: "deploy to hetzna" });
    const listed = await rig.api("GET", "/calls/live/vocab");
    expect(listed.body.callVocab.map((v: { term: string }) => v.term)).toContain("Hetzner");
    // Retraction: a new revision with term null; the raw text comes back.
    const del = await rig.api("DELETE", `/calls/live/vocab/${add.body.vocab.id}`);
    expect(del.body.vocab).toMatchObject({ term: null, rev: 2 });
    expect((await rig.api("DELETE", "/calls/live/vocab/v9999")).status).toBe(404);
  });

  test("context: the pack, a cursor, the state, and names and memory from the log", async () => {
    const name = await rig.api("POST", "/calls/live/speakers", { spk: "c1", name: "Ben" });
    expect(name.status).toBe(200);
    const rem = await rig.api("POST", "/calls/live/remember", { text: "Ben owns the deploy" });
    expect(rem.status).toBe(201);
    const r = await rig.api("POST", "/calls/live/context", { question: "what did Ben say?" });
    expect(r.status).toBe(200);
    expect(r.body.pack).toMatch(/^LIVE, recording now/);
    expect(r.body.pack).toContain("Ben owns the deploy");
    expect(r.body.pack).toContain("c1 = Ben");
    expect(r.body).toMatchObject({ state: "LIVE", call: id });
    expect(r.body.cursor).toBeGreaterThan(0);
    expect(typeof r.body.memoStale).toBe("boolean");
    expect(r.body.tokens).toBeLessThanOrEqual(6000);
    const bad = await rig.api("POST", "/calls/live/context", { question: "x", budget: 0 });
    expect(bad.status).toBe(400);
    // Forget: a retraction; the pack no longer carries it.
    const forget = await rig.api("DELETE", `/calls/live/remember/${rem.body.remember.id}`);
    expect(forget.body.remember).toMatchObject({ text: null, rev: 2 });
    const again = await rig.api("POST", "/calls/live/context", { question: "what did Ben say?" });
    expect(again.body.pack).not.toContain("Ben owns the deploy");
  });

  test("search: BM25 hits with a wall-time citation", async () => {
    const r = await rig.api("GET", "/calls/live/search?q=deploy&k=3");
    expect(r.status).toBe(200);
    expect(r.body.hits.length).toBeGreaterThan(0);
    expect(r.body.hits[0].citation).toMatch(/^\[\d\d:\d\d (Ana|Ben)\]$/);
    expect(r.body.hits[0].lines.join("\n")).toMatch(/\d\d:\d\d:\d\d Ben: deploy to/);
    expect((await rig.api("GET", "/calls/live/search")).status).toBe(400);
  });

  test("notes: agent-authored, editable by revision; speakers merge and unmerge", async () => {
    const n = await rig.api("POST", "/calls/live/notes", { text: "build -> new box?" });
    expect(n.status).toBe(201);
    expect(n.body.note).toMatchObject({ type: "note", rev: 1, by: "agent:test" });
    const edit = await rig.api("PATCH", `/calls/live/notes/${n.body.note.id}`, {
      text: "build -> new box, Friday",
    });
    expect(edit.body.note).toMatchObject({ id: n.body.note.id, rev: 2 });
    const notes = await rig.api("GET", "/calls/live/notes");
    expect(notes.body.notes).toEqual([
      expect.objectContaining({
        id: n.body.note.id,
        text: "build -> new box, Friday",
        author: "agent",
      }),
    ]);
    expect((await rig.api("PATCH", "/calls/live/notes/n9999", { text: "x" })).status).toBe(404);
    const m = await rig.api("POST", "/calls/live/speakers/merge", { from: "c3", into: "c1" });
    expect(m.status).toBe(200);
    const u = await rig.api("POST", "/calls/live/speakers/unmerge", { spk: "c3" });
    expect(u.body.unmerge).toMatchObject({ type: "speaker.unmerge", from: "c3", into: "c1" });
    expect((await rig.api("POST", "/calls/live/speakers/unmerge", { spk: "c3" })).status).toBe(409);
    expect((await rig.api("POST", "/calls/live/speakers", { spk: "../x", name: "B" })).status).toBe(
      400,
    );
  });

  test("the memo: written by the agent, checked against the log", async () => {
    const cursor = (await rig.api("GET", "/calls/live/memo")).body.cursor;
    const put = await rig.api("PUT", "/calls/live/memo", {
      text: "Topics: deploy to Hetzner [15:41]",
      coversSeq: cursor,
    });
    expect(put.status).toBe(200);
    const got = await rig.api("GET", "/calls/live/memo");
    expect(got.body.memo).toMatchObject({ rev: 1, coversSeq: cursor, by: "agent:test" });
    const past = await rig.api("PUT", "/calls/live/memo", { text: "x", coversSeq: 1e9 });
    expect([past.status, past.body.error]).toEqual([400, "bad_memo"]);
  });

  test("events: the raw log after a cursor, long-polled until the next event", async () => {
    const all = await rig.api("GET", "/calls/live/events");
    const cursor = all.body.cursor as number;
    expect(all.body.events[0].type).toBe("call.created");
    const t0 = performance.now();
    const wait = rig.api("GET", `/calls/live/events?after=${cursor}&wait=10`);
    // Mute the mic channel's recognizer input is not an event we control the time of; a note is.
    setTimeout(() => void rig.api("POST", "/calls/live/notes", { text: "while waiting" }), 300);
    const r = await wait;
    expect(performance.now() - t0).toBeLessThan(9000);
    expect(r.body.events.length).toBeGreaterThan(0);
    expect(r.body.events.every((e: LogEvent) => e.seq > cursor)).toBe(true);
    expect(r.body.cursor).toBe(r.body.events.at(-1).seq);
    expect((await rig.api("GET", "/calls/live/events?wait=99")).status).toBe(400);
  });

  test(
    "stream: SSE with the backlog then live events, each seq once and in order, plus the partial and level channels",
    async () => {
      const ctl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${rig.port}/v1/calls/live/stream?after=0`, {
        headers: { authorization: `Bearer ${rig.token}` },
        signal: ctl.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let text = "";
      const seqs: number[] = [];
      const kinds = new Set<string>();
      let posted = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        let i = text.indexOf("\n\n");
        while (i >= 0) {
          const block = text.slice(0, i);
          text = text.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          if (ev) kinds.add(ev);
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev === "event" && data) seqs.push((JSON.parse(data) as LogEvent).seq);
          i = text.indexOf("\n\n");
        }
        if (!posted && seqs.length > 0) {
          posted = true;
          await rig.api("POST", "/calls/live/notes", { text: "streamed note" });
        }
        const last = await rig.api("GET", "/calls/live/events");
        if (posted && kinds.has("level") && seqs.at(-1) === last.body.cursor) break;
      }
      ctl.abort();
      expect(seqs[0]).toBe(1);
      for (let k = 1; k < seqs.length; k++) expect(seqs[k]).toBe((seqs[k - 1] as number) + 1);
      expect(kinds.has("partial")).toBe(true);
      expect(kinds.has("level")).toBe(true);
    },
    LONG,
  );

  test("ask without a provider: 503 with the reason and the excerpts, never nothing", async () => {
    const r = await rig.api("POST", "/calls/live/ask", { question: "what was said?" });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("provider_unavailable");
    expect(r.body.context).toMatch(/^LIVE/);
  });

  test("the call's header: parts, roster, health, final state", async () => {
    const r = await rig.api("GET", "/calls/live");
    expect(r.body).toMatchObject({ id, title: "Deploy talk", workspace: "work", live: true });
    expect(r.body.roster).toEqual(
      expect.arrayContaining([expect.objectContaining({ spk: "c1", name: "Ben" })]),
    );
    const list = await rig.api("GET", "/calls?workspace=work&limit=2");
    expect(list.body.calls[0]).toMatchObject({ id, workspace: "work" });
    expect(list.body.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("after the call", () => {
  test(
    "stop runs the final pass; finalize again needs force; audio has range requests",
    async () => {
      const id = await live();
      await rig.api("POST", "/calls/live/stop");
      await until(
        async () => (await rig.api("GET", `/calls/${id}`)).body.final.state === "done",
        10_000,
        "the final pass",
      );
      const again = await rig.api("POST", `/calls/${id}/finalize`);
      expect([again.status, again.body.error]).toEqual([409, "already_final"]);
      const forced = await rig.api("POST", "/calls/last/finalize", { force: true });
      expect(forced.status).toBe(202);

      const detail = (await rig.api("GET", `/calls/${id}`)).body;
      const file = join(detail.folder, detail.parts[0].file);
      writeFileSync(file, Buffer.from(Array.from({ length: 100 }, (_, i) => i)));
      const res = await fetch(`http://127.0.0.1:${rig.port}/v1/calls/${id}/audio/1`, {
        headers: { authorization: `Bearer ${rig.token}`, range: "bytes=10-19" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([
        10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
      ]);
      const bad = await fetch(`http://127.0.0.1:${rig.port}/v1/calls/${id}/audio/1`, {
        headers: { authorization: `Bearer ${rig.token}`, range: "bytes=500-" },
      });
      expect(bad.status).toBe(416);
      expect((await rig.api("GET", `/calls/${id}/audio/9`)).status).toBe(404);
    },
    LONG,
  );

  test("what is not built answers plainly: 501 or 503, never a fake success", async () => {
    expect((await rig.api("POST", "/calls/last/export")).status).toBe(501);
    expect((await rig.api("POST", "/calls/last/enhance")).status).toBe(503);
    expect((await rig.api("GET", "/calls/last/enhance/context")).status).toBe(501);
    expect((await rig.api("POST", "/share", { bind: "lan" })).status).toBe(501);
    expect((await rig.api("GET", "/share")).body).toEqual({ active: false, shares: [] });
    expect((await rig.api("POST", "/vocab/suggest", {})).status).toBe(501);
  });
});

describe("the vocabulary files", () => {
  test("add, list, approve an unconfirmed entry, reject, import, remove", async () => {
    const add = await rig.api("POST", "/vocab", {
      term: "Kubernetes",
      heard: ["kubernetis"],
      workspace: "work",
    });
    expect(add.status).toBe(201);
    expect(add.body.path).toMatch(/vocabulary[/\\]work\.yaml$/);
    const proposed = await rig.api("POST", "/vocab", {
      term: "Anika",
      workspace: "work",
      confirmed: false,
    });
    expect(proposed.body.entry.confirmed).toBe(false);
    const un = await rig.api("GET", "/vocab?workspace=work&unconfirmed=true");
    expect(un.body.entries.map((e: { term: string }) => e.term)).toEqual(["Anika"]);
    const ok = await rig.api("POST", "/vocab/approve", { terms: ["Anika"], workspace: "work" });
    expect(ok.body.approved).toEqual(["Anika"]);
    const all = await rig.api("GET", "/vocab?workspace=work");
    expect(all.body.entries.every((e: { confirmed: boolean }) => e.confirmed)).toBe(true);
    const imp = await rig.api("POST", "/vocab/import", {
      text: "Vercel <= versal | vercell\n# comment\n",
      workspace: "work",
    });
    expect(imp.body.imported).toBe(1);
    expect((await rig.api("DELETE", "/vocab/Vercel?workspace=work")).status).toBe(200);
    expect((await rig.api("DELETE", "/vocab/Vercel?workspace=work")).status).toBe(404);
    const bad = await rig.api("POST", "/vocab", { term: "" });
    expect([bad.status, bad.body.error]).toEqual([400, "bad_term"]);
    expect((await rig.api("GET", "/vocab?workspace=..")).status).toBe(400);
  });
});

describe("settings over the API", () => {
  test("[T4.9] PATCH /config validates like a hand-edited file and writes config.json 0600", async () => {
    const bad = await rig.api("PATCH", "/config", { "asr.segmentPause": 99 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain("asr.segmentPause: 99 is out of range");
    const helper = await rig.api("PATCH", "/config", { "capture.helper": ["/bin/sh"] });
    expect(helper.status).toBe(400);
    expect(helper.body.message).toContain("not writable over the API");
    const boost = await rig.api("PATCH", "/config", { "vocab.boost": 4 });
    expect(boost.body.message).toContain("constant 3");
    const ok = await rig.api("PATCH", "/config", { "asr.segmentPause": 0.9 });
    expect(ok.status).toBe(200);
    expect(ok.body.settings["asr.segmentPause"]).toBe(0.9);
    const file = join(rig.app.configDir, "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))["asr.segmentPause"]).toBe(0.9);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const reset = await rig.api("PATCH", "/config", { "asr.segmentPause": null });
    expect(reset.body.settings["asr.segmentPause"]).toBe(0.7);
    const got = await rig.api("GET", "/config");
    expect(got.body.schema["api.port"]).toMatchObject({ type: "integer", min: 1024 });
  });

  test("status always answers 200 and names what is missing", async () => {
    const r = await rig.api("GET", "/status");
    expect(r.status).toBe(200);
    expect(r.body.app).toMatchObject({ headless: true, port: rig.port, pid: process.pid });
    expect(r.body.asr.state).toBe("ready");
    expect(r.body.provider.state).toBe("unavailable");
    expect((await rig.api("GET", "/templates")).body.templates).toEqual([]);
  });
});
