/**
 * Read-time vocabulary in the running app (docs/DESIGN.md section 5.4): the vocabulary files and
 * the bundled word lists reach every view the app builds, so a file pair corrects a transcript read
 * through the API, a file pair whose heard form is a real word does not, and a call-scoped pair
 * always does. The fake recognizer hears "kubernetes" as "kubernetis" unless it is a hotword, and
 * both file entries are `decode: false`, so only the read-time rules can change the text.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeVocabFile } from "../src/main/vocab/files.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;
let rig: AppRig;
let work: { dir: string; cleanup: () => void };
let id: string;

/** Mic: "hello world"; call: "deploy to kubernetes", heard "kubernetis" without a hotword. */
function writeSpeech(dir: string): string {
  const mic = concat(silence(0.3), speak(["hello", "world"]), silence(2.2));
  const call = concat(
    silence(1.1),
    speak(["deploy", "to", "kubernetes"], { voice: 2 }),
    silence(0.6),
  );
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
  const path = join(dir, "speech.wav");
  writeFileSync(path, stereoWav(pad(mic), pad(call)));
  return path;
}

interface Row {
  ch: string;
  text: string;
  heard?: string;
}

async function lines(): Promise<Row[]> {
  return (await rig.api("GET", `/calls/${id}/transcript`)).body.lines;
}

const lineOf = async (ch: string) => (await lines()).find((l) => l.ch === ch);

beforeAll(async () => {
  work = tempDir("akou-vocab-read-");
  const home = join(work.dir, "home");
  const vocabDir = join(home, ".config", "akou", "vocabulary");
  mkdirSync(vocabDir, { recursive: true });
  const entry = (term: string, heard: string[]) => ({
    term,
    heard,
    source: "user",
    confirmed: true,
    added_at: "2026-09-24",
    decode: false,
  });
  await writeVocabFile(join(vocabDir, "work.yaml"), {
    version: 1,
    // "world" is an English word: a file pair on it must never fire.
    entries: [entry("Kubernetes", ["kubernetis"]), entry("Globex", ["world"])],
    rejected: [],
  });
  rig = await appRig({ home, helperArgs: ["--wav", writeSpeech(work.dir)] });
  id = await rig.startCall({ workspace: "work", title: "Vocab" });
  await until(
    async () => {
      const ls = await lines();
      return ls.some((l) => l.ch === "call") && ls.some((l) => l.ch === "mic");
    },
    15_000,
    "both channels transcribed",
  );
}, LONG);

afterAll(async () => {
  await rig?.close();
  work?.cleanup();
});

describe("read-time vocabulary through the API", () => {
  test("[decision] File vocabulary that silently corrects nothing: a file entry corrects a live line through the API, raw text kept", async () => {
    expect(await lineOf("call")).toMatchObject({
      text: "deploy to Kubernetes",
      heard: "deploy to kubernetis",
    });
    const ctx = await rig.api("POST", `/calls/${id}/context`, { question: "where do we deploy?" });
    expect(ctx.status).toBe(200);
    expect(ctx.body.pack).toContain('Kubernetes (heard: "kubernetis")');
  });

  test("[spike] A heard form that is a real word: the file pair stays inert, a call-scoped one applies", async () => {
    const mic = await lineOf("mic");
    expect(mic?.text).toBe("hello world");
    expect(mic?.heard).toBeUndefined();
    const add = await rig.api("POST", `/calls/${id}/vocab`, { term: "Globex", heard: ["world"] });
    expect(add.status).toBe(201);
    expect((await lineOf("mic"))?.text).toBe("hello Globex");
    const del = await rig.api("DELETE", `/calls/${id}/vocab/${add.body.vocab.id}`);
    expect(del.status).toBe(200);
    expect((await lineOf("mic"))?.text).toBe("hello world");
  });

  test("a change to the vocabulary files reaches an open call, both ways", async () => {
    const del = await rig.api("DELETE", "/vocab/Kubernetes?workspace=work");
    expect(del.status).toBe(200);
    expect((await lineOf("call"))?.text).toBe("deploy to kubernetis");
    const add = await rig.api("POST", "/vocab", {
      term: "Kubernetes",
      heard: ["kubernetis"],
      workspace: "work",
      decode: false,
    });
    expect(add.status).toBeLessThan(300);
    expect((await lineOf("call"))?.text).toBe("deploy to Kubernetes");
  });

  test(
    "the export of the ended call carries the correction",
    async () => {
      expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
      const out = join(work.dir, "export");
      mkdirSync(out, { recursive: true });
      const r = await rig.api("POST", `/calls/${id}/export`, { to: out });
      expect(r.status).toBe(200);
      const md = readFileSync(r.body.path, "utf8");
      expect(md).toContain('Kubernetes (heard: "kubernetis")');
      expect(md).not.toContain("Globex");
    },
    LONG,
  );
});
