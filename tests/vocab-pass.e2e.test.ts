/**
 * Vocabulary layer 3 end to end (docs/DESIGN.md sections 5.4, 6.1, 6.2 and 7, ROADMAP M2): a
 * headless app with the fake helper and recognizer records a call; after it ends, the post-call
 * pass runs on a fake provider over the API and the CLI, a correction with a real span is applied, a
 * deliberately bad span is dropped, the proposals reach the words to review, and an approved one
 * lands in the workspace file with `source: call:<id>`. No test runs a real model.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompleteRequest, CompleteResult, Provider } from "../src/main/llm/provider.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;

class PassProvider implements Provider {
  readonly id = "openai-compatible" as const;
  answer: (req: CompleteRequest) => string = () => "{}";
  readonly requests: CompleteRequest[] = [];
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

const provider = new PassProvider();
let rig: AppRig;
let wavDir: { dir: string; cleanup: () => void };
let id: string;

function writeSpeech(dir: string): string {
  const mic = concat(silence(0.3), speak(["hello", "world"]), silence(3.2));
  const call = concat(
    silence(1.1),
    speak(["deploy", "to", "kubernetes", "hetzner"], { voice: 2 }),
    silence(0.6),
  );
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
  const path = join(dir, "speech.wav");
  writeFileSync(path, stereoWav(pad(mic), pad(call)));
  return path;
}

/** The id a prompt gives the line that says `words`. */
function lineOf(prompt: string, words: string): string {
  const m = new RegExp(`#([lf]\\d{6,}) [^\\n]*: ${words}`).exec(prompt);
  if (!m) throw new Error(`no line "${words}" in the prompt`);
  return m[1] as string;
}

beforeAll(async () => {
  wavDir = tempDir();
  rig = await appRig({ helperArgs: ["--wav", writeSpeech(wavDir.dir)], provider });
  id = await rig.startCall({ title: "Infra sync" });
  await until(
    async () =>
      (await rig.api("GET", `/calls/${id}/transcript`)).body.lines.some(
        (l: { ch: string; text: string }) => l.ch === "call" && l.text.includes("hetzna"),
      ),
    10_000,
    "the call-channel line",
  );
}, LONG);

afterAll(async () => {
  await rig?.close();
  wavDir?.cleanup();
});

describe("the post-call pass", () => {
  test("is refused on a call that is still recording", async () => {
    const r = await rig.api("POST", "/calls/live/vocab/pass");
    expect([r.status, r.body.error]).toEqual([409, "not_ended"]);
    expect(provider.requests).toHaveLength(0);
  });

  test(
    "a real span is corrected, a bad span is dropped, proposals reach the review list, an approval lands in the file",
    async () => {
      expect((await rig.api("POST", `/calls/${id}/stop`)).status).toBe(200);
      await until(
        async () => {
          const c = (await rig.api("GET", `/calls/${id}`)).body;
          return c.state === "ended" && ["done", "failed", "none"].includes(c.final.state);
        },
        15_000,
        "the call to end",
      );
      // A term the user already has, added after the call so the recognizer never knew it.
      const add = await rig.api("POST", "/vocab", { term: "Kubernetes", workspace: "work" });
      expect(add.status).toBe(201);

      provider.answer = (req) => {
        const call = lineOf(req.prompt, "deploy to kubernetis hetzna");
        const mic = lineOf(req.prompt, "hello world");
        return JSON.stringify({
          corrections: [
            { line: `#${call}`, heard: "kubernetis", term: "Kubernetes" },
            // Positive control: a span that is not in that line.
            { line: `#${mic}`, heard: "kubernetis", term: "Kubernetes" },
          ],
          proposals: [{ term: "Hetzner", heard: ["hetzna"], lines: [`#${call}`], why: "a vendor" }],
        });
      };
      const r = await rig.api("POST", `/calls/${id}/vocab/pass`);
      expect(r.status).toBe(200);
      expect(r.body.corrections).toHaveLength(1);
      expect(r.body.corrections[0]).toMatchObject({ term: "Kubernetes", heard: "kubernetis" });
      expect(r.body.dropped.map((d: { reason: string }) => d.reason)).toEqual([
        expect.stringMatching(/^"kubernetis" is not in #/),
      ]);
      expect(r.body.proposals.map((p: { term: string }) => p.term).sort()).toEqual([
        "Hetzner",
        "Kubernetes",
      ]);

      // The correction shows when the call is read; the raw text is kept.
      const lines = (await rig.api("GET", `/calls/${id}/transcript`)).body.lines;
      const fixed = lines.find((l: { text: string }) => l.text.includes("Kubernetes"));
      expect(fixed).toMatchObject({ heard: "deploy to kubernetis hetzna" });

      // The words to review: each proposal with the line it rests on.
      const v = await rig.api("GET", `/calls/${id}/vocab`);
      const review = v.body.review.proposals;
      expect(review.map((p: { term: string }) => p.term).sort()).toEqual(["Hetzner", "Kubernetes"]);
      const hz = review.find((p: { term: string }) => p.term === "Hetzner");
      expect(hz).toMatchObject({ heard: ["hetzna"], why: "a vendor" });
      expect(hz.lines[0]).toMatchObject({ text: "deploy to kubernetis hetzna" });
      expect(hz.lines[0].time).toMatch(/^\d\d:\d\d:\d\d$/);

      // Nothing lands in the file until the user says yes.
      const path = join(rig.home, ".config", "akou", "vocabulary", "work.yaml");
      expect(readFileSync(path, "utf8")).not.toContain("Hetzner");
      const ok = await rig.api("POST", "/vocab/approve", { terms: ["Hetzner"], call: id });
      expect(ok.body.approved).toEqual(["Hetzner"]);
      const file = readFileSync(path, "utf8");
      expect(file).toContain(`term: "Hetzner"`);
      expect(file).toContain(`source: "call:${id}"`);
      // Approving a heard form of a term the file has keeps the entry and adds the form.
      await rig.api("POST", "/vocab/approve", { terms: ["Kubernetes"], call: id });
      const merged = (await rig.api("GET", "/vocab?workspace=work")).body.entries.find(
        (e: { term: string }) => e.term === "Kubernetes",
      );
      expect(merged).toMatchObject({
        heard: ["kubernetis"],
        source: "agent:test",
        confirmed: true,
      });
      const after = (await rig.api("GET", `/calls/${id}/vocab`)).body.review;
      expect(after.proposals).toEqual([]);
    },
    LONG,
  );

  test("the CLI runs the pass on the last call; a second run writes nothing new", async () => {
    const r = await rigCli(rig)(["vocab", "pass"]);
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(r.out).toContain("Dropped");
    const again = await rig.api("POST", `/calls/${id}/vocab/pass`);
    expect(again.body.written).toBe(0);
  });

  test("the words to review over the CLI", async () => {
    provider.answer = (req) => {
      const mic = lineOf(req.prompt, "hello world");
      return JSON.stringify({ proposals: [{ term: "Helo", heard: ["hello"], lines: [mic] }] });
    };
    await rig.api("POST", `/calls/${id}/vocab/pass`);
    const r = await rigCli(rig)(["vocab", "list", "--call", id, "--unconfirmed"]);
    expect(r.code).toBe(0);
    const text = r.out;
    expect(text).toContain("Helo (heard: hello)");
    expect(text).toMatch(/\d\d:\d\d:\d\d .+: hello world/);
    expect(text).toContain("akou vocab approve TERM --call ID");
  });

  test("an entry the file holds unconfirmed is only proposed, never corrected at once", async () => {
    // An inferred entry (an agent's, sent with `confirmed: false`) waits for the user's yes.
    const add = await rig.api("POST", "/vocab", {
      term: "Wurld",
      workspace: "work",
      confirmed: false,
    });
    expect(add.status).toBe(201);
    provider.answer = (req) => {
      const mic = lineOf(req.prompt, "hello world");
      return JSON.stringify({ corrections: [{ line: `#${mic}`, heard: "world", term: "Wurld" }] });
    };
    const r = await rig.api("POST", `/calls/${id}/vocab/pass`);
    expect(r.status).toBe(200);
    expect(r.body.corrections).toEqual([]);
    expect(r.body.proposals).toEqual([
      expect.objectContaining({ term: "Wurld", heard: ["world"] }),
    ]);
    const lines = (await rig.api("GET", `/calls/${id}/transcript`)).body.lines;
    expect(lines.some((l: { text: string }) => l.text === "hello world")).toBe(true);
    expect(lines.some((l: { text: string }) => l.text.includes("Wurld"))).toBe(false);
  });

  test("approving a call's proposal for an unconfirmed file entry keeps the heard form", async () => {
    const add = await rig.api("POST", "/vocab", {
      term: "Hallo",
      workspace: "work",
      confirmed: false,
    });
    expect(add.status).toBe(201);
    provider.answer = (req) => {
      const mic = lineOf(req.prompt, "hello world");
      return JSON.stringify({ proposals: [{ term: "Hallo", heard: ["hello"], lines: [mic] }] });
    };
    const r = await rig.api("POST", `/calls/${id}/vocab/pass`);
    expect(r.body.proposals).toEqual([
      expect.objectContaining({ term: "Hallo", heard: ["hello"] }),
    ]);
    const ok = await rig.api("POST", "/vocab/approve", { terms: ["Hallo"], call: id });
    expect(ok.status).toBe(200);
    expect(ok.body.approved).toEqual(["Hallo"]);
    const entry = (await rig.api("GET", "/vocab?workspace=work")).body.entries.find(
      (e: { term: string }) => e.term === "Hallo",
    );
    expect(entry).toMatchObject({ heard: ["hello"], confirmed: true });
  });

  test("a term rejected in the file is never proposed again", async () => {
    const rej = await rig.api("POST", "/vocab/reject", { terms: ["Hellow"], workspace: "work" });
    expect(rej.status).toBe(200);
    provider.answer = (req) => {
      const mic = lineOf(req.prompt, "hello world");
      return JSON.stringify({ proposals: [{ term: "Hellow", heard: ["hello"], lines: [mic] }] });
    };
    const r = await rig.api("POST", `/calls/${id}/vocab/pass`);
    expect(r.status).toBe(200);
    expect(r.body.proposals).toEqual([]);
    expect(r.body.dropped.map((d: { reason: string }) => d.reason)).toContain(
      '"Hellow" was rejected before',
    );
    expect(provider.requests.at(-1)?.prompt).toMatch(/Rejected, never propose: .*Hellow/);
  });

  test("suggestions come from the call, ranked, without known words", async () => {
    const r = await rig.api("POST", "/vocab/suggest", { call: id, k: 5 });
    expect(r.status).toBe(200);
    expect(r.body.call).toBe(id);
    for (const s of r.body.suggestions) {
      expect(["Kubernetes", "Hetzner"]).not.toContain(s.term);
    }
    const text = await rig.api("POST", "/vocab/suggest", {
      text: "We met Anika at GitHub. Anika agreed.",
    });
    expect(text.body.suggestions[0]).toMatchObject({ term: "Anika", count: 2 });
    expect((await rig.api("POST", "/vocab/suggest", {})).status).toBe(400);
  });
});
