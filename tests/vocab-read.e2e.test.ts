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
import { CallView, type FoldOptions } from "../src/core/log/fold.ts";
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

interface ReadLines {
  all: boolean;
  lines: { id: string; rev: number; text: string; heard?: string }[];
}

/**
 * Follows the call's SSE stream (what the window's page follows in a browser) and collects its
 * `read` events: the app's rendering of the lines its vocabulary corrects.
 */
function followReads(): { reads: ReadLines[]; stop(): void } {
  const ctl = new AbortController();
  const reads: ReadLines[] = [];
  void (async () => {
    const res = await fetch(`http://127.0.0.1:${rig.port}/v1/calls/${id}/stream?after=0`, {
      headers: { authorization: `Bearer ${rig.token}` },
      signal: ctl.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += dec.decode(value, { stream: true });
      let i = text.indexOf("\n\n");
      while (i >= 0) {
        const block = text.slice(0, i);
        text = text.slice(i + 2);
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (/^event: read$/m.test(block) && data) reads.push(JSON.parse(data) as ReadLines);
        i = text.indexOf("\n\n");
      }
    }
  })().catch(() => {});
  return { reads, stop: () => ctl.abort() };
}

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

  test("[decision] File vocabulary that silently corrects nothing: the call's stream carries the app's corrected text for the window, and again when the files change", async () => {
    const f = followReads();
    try {
      const corrected = (r: ReadLines | undefined) =>
        r?.lines.find((l) => l.text === "deploy to Kubernetes");
      await until(async () => f.reads.length > 0, 5000, "the first read");
      expect(f.reads[0]?.all).toBe(true);
      expect(corrected(f.reads[0])).toMatchObject({ heard: "deploy to kubernetis" });
      // The page's own fold renders call-scoped pairs; "world" is inert in the file, so the app
      // sends nothing for the mic line.
      expect(f.reads[0]?.lines.some((l) => l.text.includes("Globex"))).toBe(false);
      const n = f.reads.length;
      expect((await rig.api("DELETE", "/vocab/Kubernetes?workspace=work")).status).toBe(200);
      await until(async () => f.reads.length > n, 5000, "a read after the change");
      const after = f.reads.at(-1);
      expect(after?.all).toBe(true);
      expect(corrected(after)).toBeUndefined();
      const add = await rig.api("POST", "/vocab", {
        term: "Kubernetes",
        heard: ["kubernetis"],
        workspace: "work",
        decode: false,
      });
      expect(add.status).toBeLessThan(300);
      await until(async () => corrected(f.reads.at(-1)) !== undefined, 5000, "the entry back");
    } finally {
      f.stop();
    }
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

  test(
    "a call opened from disk reads its vocabulary files once and is corrected",
    async () => {
      await rig.close();
      const seen = new Set<unknown>();
      const original = CallView.prototype.setReadOptions;
      CallView.prototype.setReadOptions = function (this: CallView, o: FoldOptions) {
        if (o.vocabFiles) seen.add(o.vocabFiles);
        original.call(this, o);
      };
      try {
        rig = await appRig({ home: join(work.dir, "home") });
        expect((await lineOf("call"))?.text).toBe("deploy to Kubernetes");
        // One read of the files: every view set from it gets the same entries.
        expect(seen.size).toBe(1);
      } finally {
        CallView.prototype.setReadOptions = original;
      }
    },
    LONG,
  );
});
