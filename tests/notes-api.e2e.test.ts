/**
 * Asking, the notepad and enhanced notes end to end (docs/DESIGN.md sections 5.1 to 5.3, 6.1, 6.2
 * and 6.4): a headless app with the fake helper and recognizer, and a fake provider, driven over
 * the local API and the CLI. No test runs a real harness.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { runCli } from "../src/main/cli/cli.ts";
import { HarnessProvider } from "../src/main/llm/harness.ts";
import {
  type CompleteRequest,
  type CompleteResult,
  type Provider,
  ProviderError,
  readSse,
} from "../src/main/llm/provider.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;
const FIX = join(import.meta.dir, "fixtures", "harness");
const FAKE_HARNESS = join(import.meta.dir, "fixtures", "fake-harness.ts");

/**
 * The provider the app uses, switchable per test: `answer` builds the reply from the request,
 * `inner` replaces the fake with another provider (a harness over a fake program).
 */
class SwitchProvider implements Provider {
  readonly id = "harness" as const;
  answer: (req: CompleteRequest) => string = () => "fine";
  inner: Provider | null = null;
  delayMs = 0;
  fail: ProviderError | null = null;
  readonly requests: CompleteRequest[] = [];
  aborted = 0;
  async available() {
    return this.inner ? this.inner.available() : { ok: true as const, detail: "fake" };
  }
  async complete(
    req: CompleteRequest,
    onToken: (t: string) => void,
    signal: AbortSignal,
  ): Promise<CompleteResult> {
    if (this.inner) return this.inner.complete(req, onToken, signal);
    this.requests.push(req);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          this.aborted++;
          resolve();
        });
      });
      if (signal.aborted) throw new ProviderError("cancelled", "cancelled");
    }
    if (this.fail) throw this.fail;
    const text = this.answer(req);
    // Two tokens, so a stream has more than one.
    const half = Math.ceil(text.length / 2);
    onToken(text.slice(0, half));
    onToken(text.slice(half));
    return { text, model: "fake/1.0" };
  }
}

const provider = new SwitchProvider();
let rig: AppRig;
let wavDir: { dir: string; cleanup: () => void };
let id: string;
let callLine: { id: string; time: string; speaker: string };

function writeSpeech(dir: string): string {
  const mic = concat(silence(0.3), speak(["hello", "world"]), silence(2.2));
  const call = concat(silence(1.1), speak(["deploy", "to", "hetzner"], { voice: 2 }), silence(0.6));
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
  const path = join(dir, "speech.wav");
  writeFileSync(path, stereoWav(pad(mic), pad(call)));
  return path;
}

async function events(): Promise<LogEvent[]> {
  return (await rig.api("GET", `/calls/${id}/events`)).body.events;
}

beforeAll(async () => {
  wavDir = tempDir();
  rig = await appRig({ helperArgs: ["--wav", writeSpeech(wavDir.dir)], provider });
  id = await rig.startCall({ title: "Daily standup" });
  await until(
    async () =>
      (await rig.api("GET", `/calls/${id}/transcript`)).body.lines.some(
        (l: { ch: string }) => l.ch === "call",
      ),
    10_000,
    "a call-channel line",
  );
  const lines = (await rig.api("GET", `/calls/${id}/transcript`)).body.lines;
  const l = lines.find((x: { ch: string }) => x.ch === "call");
  callLine = { id: l.id, time: l.time.slice(0, 5), speaker: l.speaker };
}, LONG);

afterAll(async () => {
  await rig?.close();
  wavDir?.cleanup();
});

describe("asking", () => {
  test("status names the provider; akou answers over the pack and logs the Q&A with citations", async () => {
    const st = await rig.api("GET", "/status");
    expect(st.body.provider).toMatchObject({ state: "available", id: "harness" });
    provider.answer = () => `They said deploy to Hetzner [${callLine.time} ${callLine.speaker}].`;
    const r = await rig.api("POST", "/calls/live/ask", { question: "what about deploy?" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ answered: true, kind: "answer", model: "fake/1.0" });
    expect(r.body.cites).toEqual([callLine.id]);
    // The provider got akou's pack and the question, never the whole call folder.
    const req = provider.requests.at(-1) as CompleteRequest;
    expect(req.prompt).toStartWith("LIVE, recording now");
    expect(req.prompt).toEndWith("Question: what about deploy?");
    const log = await events();
    const askE = log.find((e) => e.type === "ask" && e.id === r.body.ask);
    expect(askE).toMatchObject({ q: "what about deploy?", by: "agent:test" });
    const ans = log.find((e) => e.type === "answer" && e.ask === r.body.ask);
    expect(ans).toMatchObject({ cites: [callLine.id], model: "fake/1.0", pack: { mode: "whole" } });
    // The next pack carries the Q&A.
    const ctx = await rig.api("POST", "/calls/live/context", { question: "and then?" });
    expect(ctx.body.pack).toContain("Q ");
    expect(ctx.body.pack).toContain("what about deploy?");
  });

  test("streamed: the excerpts first, then tokens, then the answer", async () => {
    provider.answer = () => "Deploy to Hetzner.";
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${rig.port}/v1/calls/live/ask`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rig.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question: "deploy?", stream: true }),
    });
    expect(res.headers.get("content-type")).toStartWith("text/event-stream");
    const seen: { event: string; data: Record<string, unknown>; ms: number }[] = [];
    for await (const ev of readSse(res.body as ReadableStream<Uint8Array>)) {
      seen.push({ event: ev.event, data: JSON.parse(ev.data), ms: performance.now() - t0 });
    }
    expect(seen.map((e) => e.event)).toEqual(["excerpts", "token", "token", "answer"]);
    console.log(`ask stream: excerpts after ${seen[0]?.ms.toFixed(0)} ms`);
    expect(seen[0]?.ms).toBeLessThan(1000);
    expect((seen[0]?.data.excerpts as unknown[] | undefined)?.length).toBeGreaterThan(0);
    expect(
      seen
        .slice(1, 3)
        .map((e) => e.data.t)
        .join(""),
    ).toBe("Deploy to Hetzner.");
    expect(seen[3]?.data).toMatchObject({ answered: true, text: "Deploy to Hetzner." });
  });

  test(
    "[decision] Provider unavailable answered with nothing: a fake claude exiting 1 with a usage limit",
    async () => {
      provider.inner = new HarnessProvider({
        target: () => ({
          kind: "claude",
          command: [
            process.execPath,
            FAKE_HARNESS,
            join(FIX, "claude-usage-limit.synthetic.jsonl"),
          ],
          version: "2.1.281",
        }),
        env: { ...process.env, FAKE_EXIT: "1" },
      });
      try {
        const r = await rig.api("POST", "/calls/live/ask", { question: "deploy?" });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ answered: false, kind: "excerpts", errorKind: "exhausted" });
        // The reset time is stated in local wall-clock time.
        expect(r.body.reason).toMatch(
          /^Claude Code reported its usage limit is reached until \d\d:\d\d/,
        );
        expect(r.body.text).toStartWith("No model answered (Claude Code reported");
        expect(r.body.text).toContain("hetzna");
        expect(r.body.context).toMatch(/^LIVE/);
        // No answer is logged for the question.
        const log = await events();
        expect(log.some((e) => e.type === "answer" && e.ask === r.body.ask)).toBe(false);
      } finally {
        provider.inner = null;
      }
    },
    LONG,
  );

  test("a client that goes away cancels the provider run", async () => {
    provider.delayMs = 5000;
    try {
      const ac = new AbortController();
      const req = fetch(`http://127.0.0.1:${rig.port}/v1/calls/live/ask`, {
        method: "POST",
        headers: { authorization: `Bearer ${rig.token}`, "content-type": "application/json" },
        body: JSON.stringify({ question: "slow?", stream: true }),
        signal: ac.signal,
      });
      const res = await req;
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      const before = provider.aborted;
      ac.abort();
      await until(async () => provider.aborted > before, 3000, "the provider to be cancelled");
    } finally {
      provider.delayMs = 0;
    }
  });

  test("a naming question writes the name with no model", async () => {
    const before = provider.requests.length;
    const r = await rig.api("POST", "/calls/live/ask", { question: "c7 is Zed" });
    expect(r.body).toMatchObject({ answered: true, kind: "naming" });
    expect(provider.requests.length).toBe(before);
    const log = await events();
    expect(log.some((e) => e.type === "speaker.name" && e.spk === "c7" && e.name === "Zed")).toBe(
      true,
    );
  });

  test("the question is checked", async () => {
    expect((await rig.api("POST", "/calls/live/ask", { question: "  " })).status).toBe(400);
    const long = await rig.api("POST", "/calls/live/ask", { question: "x".repeat(2001) });
    expect(long.status).toBe(400);
  });
});

describe("the notepad over the API", () => {
  test("add, edit, delete; an unknown note is 404", async () => {
    const a = await rig.api(
      "POST",
      "/calls/live/notes",
      { text: "build -> new box?" },
      {
        "x-akou-client": "cli",
      },
    );
    expect(a.status).toBe(201);
    const nid = a.body.note.id;
    expect(a.body.note).toMatchObject({ rev: 1, by: "agent:cli" });
    const e = await rig.api("PATCH", `/calls/live/notes/${nid}`, { text: "build -> new box!" });
    expect(e.body.note).toMatchObject({ id: nid, rev: 2, w: a.body.note.w });
    const tmp = await rig.api("POST", "/calls/live/notes", { text: "scratch" });
    const d = await rig.api("DELETE", `/calls/live/notes/${tmp.body.note.id}`);
    expect(d.body.deleted).toMatchObject({ type: "note.del", id: tmp.body.note.id });
    const notes = (await rig.api("GET", "/calls/live/notes")).body.notes;
    expect(notes.map((n: { id: string }) => n.id)).not.toContain(tmp.body.note.id);
    expect((await rig.api("DELETE", "/calls/live/notes/n9999")).status).toBe(404);
    expect((await rig.api("PATCH", "/calls/live/notes/n9999", { text: "x" })).status).toBe(404);
  });
});

describe("enhanced notes", () => {
  test("enhance so far: cited bullets kept, a hallucinated one dropped, the files and the event written", async () => {
    // A user's own note (the window writes `by: user`); the API's writers are agents.
    const n = await rig.app.write(id, (c) => ({
      type: "note",
      id: `n${String(c.view.lastSeq + 1).padStart(4, "0")}`,
      rev: 1,
      text: "ask Ben about the box",
      w: Date.now(),
      afterSeq: c.view.lastSeq,
      by: "user",
    }));
    provider.answer = () =>
      [
        "## Updates per person",
        `- Deploy to Hetzner came up [#${callLine.id}]`,
        "- Ben quit his job [#l999999]",
        "## Decisions",
        `- {${(n as { id: string }).id}}`,
        "## Action items",
      ].join("\n");
    const r = await rig.api("POST", "/calls/live/enhance", {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rev: 1, template: "standup", model: "fake/1.0", live: true });
    expect(r.body.markdown).toContain(`- Deploy to Hetzner came up [#${callLine.id}]`);
    expect(r.body.markdown).toContain("- ask Ben about the box _(your note,");
    expect(r.body.markdown).not.toContain("quit");
    expect(r.body.dropped).toHaveLength(1);
    const folder = (await rig.api("GET", `/calls/${id}`)).body.folder;
    expect(readFileSync(join(folder, "enhanced/001-standup.md"), "utf8")).toBe(
      `${r.body.markdown}\n`,
    );
    expect(readFileSync(join(folder, "notes.enhanced.md"), "utf8")).toBe(`${r.body.markdown}\n`);
    const e = (await events()).find((x) => x.type === "enhanced");
    expect(e).toMatchObject({
      rev: 1,
      template: "standup",
      file: "enhanced/001-standup.md",
      model: "fake/1.0",
      cites: [callLine.id],
    });

    // Another template keeps both revisions.
    provider.answer = () => `## Summary\n- Deploy to Hetzner [#${callLine.id}]`;
    const g = await rig.api("POST", "/calls/live/enhance", { template: "general" });
    expect(g.body).toMatchObject({ rev: 2, file: "enhanced/002-general.md" });
    expect(existsSync(join(folder, "enhanced/001-standup.md"))).toBe(true);
    expect((await rig.api("POST", "/calls/live/enhance", { template: "nope" })).status).toBe(400);
  });

  test("one enhancement at a time per call", async () => {
    provider.delayMs = 800;
    try {
      const first = rig.api("POST", "/calls/live/enhance", {});
      await Bun.sleep(150);
      const second = await rig.api("POST", "/calls/live/enhance", {});
      expect([second.status, second.body.error]).toEqual([409, "enhance_running"]);
      expect((await first).status).toBe(200);
    } finally {
      provider.delayMs = 0;
    }
  });

  test("a provider that cannot write says why: 503 with the reason", async () => {
    provider.fail = new ProviderError("auth", "Claude Code is not logged in");
    try {
      const r = await rig.api("POST", "/calls/live/enhance", {});
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ error: "provider_unavailable", kind: "auth" });
    } finally {
      provider.fail = null;
    }
  });

  test("an agent writes them itself: the context, then PUT with the same checks", async () => {
    const ctx = await rig.api("GET", `/calls/${id}/enhance/context?template=general`);
    expect(ctx.body).toMatchObject({ template: "general", mode: "whole" });
    expect(ctx.body.input).toContain("## Summary");
    expect(ctx.body.input).toContain(`#${callLine.id}`);
    expect(ctx.body.instructions).toContain("[#l000031]");
    const put = await rig.api(
      "PUT",
      `/calls/${id}/enhanced`,
      {
        markdown: `## Summary\n- Deploy to Hetzner [#${callLine.id}]\n- invented [#l424242]`,
        coversSeq: ctx.body.coversSeq,
      },
      { "x-akou-client": "claude-code" },
    );
    expect(put.status).toBe(200);
    expect(put.body.dropped.map((d: { text: string }) => d.text)).toEqual([
      "- invented [#l424242]",
    ]);
    // The user's line the agent left out is still there.
    expect(put.body.markdown).toContain("## Your notes\n- ask Ben about the box");
    const e = (await events()).filter((x) => x.type === "enhanced").at(-1);
    expect(e).toMatchObject({ by: "agent:claude-code", model: "agent:claude-code" });
    const bad = await rig.api("PUT", `/calls/${id}/enhanced`, { markdown: "x", coversSeq: 1e9 });
    expect(bad.status).toBe(400);
  });
});

describe("settings for the provider", () => {
  test("the API key is never shown back; program and address settings are not API-writable", async () => {
    const set = await rig.api("PATCH", "/config", { "provider.apiKey": "sk-secret-123" });
    expect(set.status).toBe(200);
    expect(JSON.stringify(set.body)).not.toContain("sk-secret-123");
    const got = await rig.api("GET", "/config");
    expect(got.body.settings["provider.apiKey"]).toBe("(set)");
    expect(JSON.stringify(got.body)).not.toContain("sk-secret-123");
    // Positive control: the key is in the file the user owns.
    expect(readFileSync(join(rig.app.configDir, "config.json"), "utf8")).toContain("sk-secret-123");
    for (const key of ["provider.harnessPath", "provider.baseUrl"]) {
      const r = await rig.api("PATCH", "/config", { [key]: "/tmp/x" });
      expect(r.status).toBe(400);
      expect(r.body.message).toContain("not writable over the API");
    }
    await rig.api("PATCH", "/config", { "provider.apiKey": null });
  });
});

describe("the CLI", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    const streamed: string[] = [];
    return {
      out,
      err,
      streamed,
      io: {
        env: { ...process.env, ...rig.env },
        out: (t: string) => out.push(t),
        err: (t: string) => err.push(t),
        write: (t: string) => streamed.push(t),
      },
    };
  };

  test("ask streams the answer to a terminal; without a terminal it prints it whole", async () => {
    provider.answer = () => "Deploy to Hetzner.";
    const t = io();
    expect(await runCli(["ask", "deploy?"], t.io, { launch: null })).toBe(0);
    expect(t.streamed.join("")).toBe("Deploy to Hetzner.\n");
    const plain = io();
    const { write: _w, ...noWrite } = plain.io;
    expect(await runCli(["ask", "deploy?"], noWrite, { launch: null })).toBe(0);
    expect(plain.out).toEqual(["Deploy to Hetzner."]);
  });

  test("ask with no provider prints the excerpts, says why, exits 69", async () => {
    provider.fail = new ProviderError("missing", "no harness found");
    try {
      const t = io();
      expect(await runCli(["ask", "deploy?"], t.io, { launch: null })).toBe(69);
      expect(t.out.join("\n")).toStartWith("No model answered (no harness found)");
      expect(t.err.join("\n")).toContain('akou context "deploy?"');
    } finally {
      provider.fail = null;
    }
  });

  test("note --edit and --del; enhance prints the notes and where they went", async () => {
    const t = io();
    expect(await runCli(["note", "first", "line", "--json"], t.io, { launch: null })).toBe(0);
    const nid = JSON.parse(t.out[0] as string).note.id;
    const e = io();
    expect(await runCli(["note", "--edit", nid, "second"], e.io, { launch: null })).toBe(0);
    expect(e.out[0]).toBe(`Edited ${nid} (rev 2)`);
    const d = io();
    expect(await runCli(["note", "--del", nid], d.io, { launch: null })).toBe(0);
    expect(d.out[0]).toBe(`Deleted ${nid}`);
    const bad = io();
    expect(await runCli(["note", "--del", nid, "extra"], bad.io, { launch: null })).toBe(64);

    provider.answer = () => `## Summary\n- Deploy to Hetzner [#${callLine.id}]`;
    const en = io();
    expect(
      await runCli(["enhance", "--call", id, "--template", "general"], en.io, { launch: null }),
    ).toBe(0);
    expect(en.out[0]).toContain(`- Deploy to Hetzner [#${callLine.id}]`);
    expect(en.out[0]).toMatch(
      /\(rev \d+, template general · by fake\/1\.0 · so far \(the call is still live\) · saved to enhanced\/\d{3}-general\.md\)$/,
    );
  });
});
