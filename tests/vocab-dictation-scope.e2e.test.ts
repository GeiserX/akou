/**
 * A `scope: dictation` entry never reaches a call (docs/ux/DICTATION.md DC-L6), end to end: a
 * headless app with the fake helper and recognizer records a call whose line says "hetzna" while
 * the global file holds `Hetzner heard [hetzna] scope: dictation`. The call text, the vocabulary in
 * force for the call and the post-call pass (on a fake provider) must all ignore the entry; the
 * same entry without the scope rewrites the call and reaches the pass (positive control).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompleteRequest, CompleteResult, Provider } from "../src/main/llm/provider.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;
const LINE = "deploy to kubernetis hetzna";

class PassProvider implements Provider {
  readonly id = "openai-compatible" as const;
  readonly requests: CompleteRequest[] = [];
  async available() {
    return { ok: true as const, detail: "fake" };
  }
  async complete(req: CompleteRequest, onToken: (t: string) => void): Promise<CompleteResult> {
    this.requests.push(req);
    // Corrects the call line's "hetzna" to "Hetzner", which the pass applies only to a known term.
    const m = /#([lf]\d{6,}) [^\n]*: deploy to kubernetis (hetzna|Hetzner)/.exec(req.prompt);
    const text = JSON.stringify({
      corrections: m ? [{ line: `#${m[1]}`, heard: "hetzna", term: "Hetzner" }] : [],
    });
    onToken(text);
    return { text, model: "fake/1.0" };
  }
}

const provider = new PassProvider();
let rig: AppRig;
let wavDir: { dir: string; cleanup: () => void };
let id: string;

function writeVocab(scoped: boolean): void {
  writeFileSync(
    join(rig.app.configDir, "vocabulary.yaml"),
    [
      "version: 1",
      "entries:",
      '  - term: "Hetzner"',
      '    heard: ["hetzna"]',
      '    source: "dictation:d1"',
      "    confirmed: true",
      '    added_at: "2026-09-27"',
      ...(scoped ? ['    scope: "dictation"'] : []),
      "",
    ].join("\n"),
  );
  rig.app.vocabChanged();
}

async function callLine(): Promise<{ text: string }> {
  const lines = (await rig.api("GET", `/calls/${id}/transcript`)).body.lines;
  return lines.find((l: { ch: string; heard?: string; text: string }) =>
    (l.heard ?? l.text).includes("kubernetis"),
  );
}

beforeAll(async () => {
  wavDir = tempDir();
  const mic = concat(silence(0.3), speak(["hello", "world"]), silence(3.2));
  const call = concat(
    silence(1.1),
    speak(["deploy", "to", "kubernetes", "hetzner"], { voice: 2 }),
    silence(0.6),
  );
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
  const wav = join(wavDir.dir, "speech.wav");
  writeFileSync(wav, stereoWav(pad(mic), pad(call)));
  rig = await appRig({ helperArgs: ["--wav", wav], provider });
  writeVocab(true);
  id = await rig.startCall({ title: "Infra sync" });
  await until(async () => (await callLine())?.text !== undefined, 10_000, "the call-channel line");
  expect((await rig.api("POST", `/calls/${id}/stop`)).status).toBe(200);
  await until(
    async () => {
      const c = (await rig.api("GET", `/calls/${id}`)).body;
      return c.state === "ended" && ["done", "failed", "none"].includes(c.final.state);
    },
    15_000,
    "the call to end",
  );
}, LONG);

afterAll(async () => {
  await rig?.close();
  wavDir?.cleanup();
});

describe("DC-L6: a `scope: dictation` entry is never in force for a call", () => {
  test(
    "the call text, the call's vocabulary and the pass ignore it; without the scope all three use it",
    async () => {
      // The call reads its text with the file's pairs: the scoped one is not among them.
      expect((await callLine()).text).toBe(LINE);
      const inForce = (await rig.api("GET", `/calls/${id}/vocab`)).body.entries;
      expect(inForce.map((e: { term: string }) => e.term)).not.toContain("Hetzner");
      // The editor still sees it.
      const all = (await rig.api("GET", "/vocab")).body.entries;
      expect(all.map((e: { term: string }) => e.term)).toContain("Hetzner");

      const pass = await rig.api("POST", `/calls/${id}/vocab/pass`);
      expect(pass.status).toBe(200);
      expect(provider.requests.at(-1)?.prompt).not.toContain("Hetzner (misheard as");
      // Not applied: the correction waits for the user's review as a proposal.
      expect(pass.body.corrections).toEqual([]);
      expect(pass.body.proposals).toEqual([
        expect.objectContaining({ term: "Hetzner", heard: ["hetzna"] }),
      ]);
      expect((await callLine()).text).toBe(LINE);

      // Positive control: the same entry without the scope.
      writeVocab(false);
      expect((await callLine()).text).toBe("deploy to kubernetis Hetzner");
      const now = (await rig.api("GET", `/calls/${id}/vocab`)).body.entries;
      expect(now.map((e: { term: string }) => e.term)).toContain("Hetzner");
      await rig.api("POST", `/calls/${id}/vocab/pass`);
      expect(provider.requests.at(-1)?.prompt).toContain("Hetzner (misheard as: hetzna)");
    },
    LONG,
  );
});
