/**
 * The real speech pipeline, end to end, on this machine only. It runs when `AKOU_MODELS_DIR` points
 * at a models folder in the registry layout (`<dir>/<model id>/<file>`, every file matching its
 * pinned SHA-256) and macOS `say` can generate speech; otherwise every test here is skipped and the
 * reason is printed. CI never sets `AKOU_MODELS_DIR`, and nothing here downloads anything.
 *
 * What it does: `say` writes two sentences for the mic (left) and two voices for the call (right)
 * into a generated 16 kHz stereo WAV; the fake capture helper replays it as `akou-capture/1`
 * packets; the live Worker runs Silero, Parakeet TDT v3 with hotwords (so with beam decoding,
 * which hotwords need), and TitaNet; the host writes the log. Then the final pass runs with pyannote
 * diarization. The transcript is printed so a run leaves its evidence in the output.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWall } from "../../src/core/log/clock.ts";
import type { LogEvent, Seg } from "../../src/core/log/events.ts";
import { finalizeCall } from "../../src/main/asr/finalize-worker.ts";
import { type CallAccess, LiveAsr, type VocabSource } from "../../src/main/asr/live-worker.ts";
import { modelFile, RECOGNIZER, verifyModels } from "../../src/main/asr/models.ts";
import { padSpan } from "../../src/main/asr/pad.ts";
import { SherpaModels } from "../../src/main/asr/sherpa.ts";
import { CallManager } from "../../src/main/call/manager.ts";
import { AkouCaptureEngine } from "../../src/main/capture/helper.ts";
import type { Packet } from "../../src/main/capture/protocol.ts";
import {
  BpeTokenizer,
  buildBpeVocab,
  checkTerms,
  parseTokens,
} from "../../src/main/vocab/bpe-vocab.ts";
import type { MergedEntry } from "../../src/main/vocab/files.ts";
import { ofType } from "../capture-helpers.ts";
import { stereoWav } from "../fixtures/audio.ts";

const MODELS = process.env.AKOU_MODELS_DIR;
const HAS_SAY = process.platform === "darwin" && spawnSync("which", ["say"]).status === 0;
const SKIP = !MODELS
  ? "AKOU_MODELS_DIR is not set"
  : !HAS_SAY
    ? "macOS `say` is not available to generate speech"
    : null;
if (SKIP) console.log(`asr.local: skipped, ${SKIP}. These tests need the real models on disk.`);

const FAKE_HELPER = join(import.meta.dir, "..", "..", "scripts", "fake-helper.ts");
const RATE = 16000;
const work = mkdtempSync(join(tmpdir(), "akou-asr-local-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A mono 16-bit WAV from `say` (any extra chunks skipped). */
function readMono(path: string): Float32Array {
  const b = new Uint8Array(readFileSync(path));
  const v = new DataView(b.buffer);
  let o = 12;
  while (o + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(o, o + 4));
    const size = v.getUint32(o + 4, true);
    if (id === "data") {
      const n = Math.floor(Math.min(size, b.length - o - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(o + 8 + i * 2, true) / 32768;
      return out;
    }
    o += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no data`);
}

function say(text: string, voice?: string): Float32Array {
  const out = join(work, `say-${Math.random().toString(36).slice(2)}.wav`);
  const args = [...(voice ? ["-v", voice] : []), "-o", out, "--data-format=LEI16@16000", text];
  let r = spawnSync("say", args);
  if (r.status !== 0 && voice) r = spawnSync("say", ["-o", out, "--data-format=LEI16@16000", text]);
  if (r.status !== 0) throw new Error(`say failed: ${r.stderr}`);
  return readMono(out);
}

const sil = (s: number) => new Float32Array(Math.round(s * RATE));

function place(total: number, clips: { at: number; x: Float32Array }[]): Float32Array {
  const out = new Float32Array(Math.round(total * RATE));
  for (const c of clips)
    out.set(c.x.subarray(0, out.length - Math.round(c.at * RATE)), Math.round(c.at * RATE));
  return out;
}

const entry = (term: string): MergedEntry => ({
  term,
  heard: [],
  source: "user",
  confirmed: true,
  added_at: "2026-09-01",
  scope: "workspace",
  file: "work.yaml",
});

describe.skipIf(!!SKIP)("the real pipeline (needs AKOU_MODELS_DIR and macOS `say`)", () => {
  test("the models on disk match their pinned checksums", async () => {
    const bad = (await verifyModels(MODELS as string)).filter((s) => s.state !== "ok");
    expect(bad).toEqual([]);
  }, 120_000);

  test("[spike] The bpe.vocab from the upstream recipe, against Parakeet's real tokenizer", () => {
    const dir = MODELS as string;
    const tok = BpeTokenizer.fromJson(
      JSON.parse(readFileSync(modelFile(dir, RECOGNIZER, "tokenizer.json"), "utf8")),
    );
    const tokens = parseTokens(readFileSync(modelFile(dir, RECOGNIZER, "tokens.txt"), "utf8"));
    const terms = [
      "Vercel",
      "iroh",
      "Behzad",
      "Hetzner",
      "Convex",
      "Tauri",
      "ElectroBun",
      "sherpa-onnx",
      "Parakeet",
      "Kubernetes",
    ];
    const canon = checkTerms(tok, buildBpeVocab(tok, terms).pieces, tokens, terms);
    const rank = new Map<string, number>();
    for (const [piece, id] of tok.vocab) if (!/^<.*>$/.test(piece)) rank.set(piece, -id);
    const upstream = checkTerms(tok, rank, tokens, terms);
    console.log(
      `asr.local: tokenization check over ${terms.length} terms: canonical file ${canon.filter((c) => !c.ok).length} mismatches, upstream -rank file ${upstream.filter((c) => !c.ok).length} (${upstream
        .filter((c) => !c.ok)
        .map((c) => c.term)
        .join(", ")})`,
    );
    expect(canon.filter((c) => !c.ok)).toEqual([]);
    expect(upstream.filter((c) => !c.ok).length).toBeGreaterThan(0);
  });

  test("[T1.9, T4.19] the 0.2 s 'Yes.' fixture against Parakeet: none, leading, trailing", () => {
    const models = new SherpaModels({ dir: MODELS as string, cacheDir: join(work, "cache-yes") });
    const rec = models.prepare(null).recognizer;
    // `say "Yes."` trimmed to its loudest 0.2 s.
    const y = say("Yes.");
    let best = 0;
    let bestE = -1;
    const n = Math.round(0.2 * RATE);
    for (let i = 0; i + n <= y.length; i += 160) {
      let e = 0;
      for (let k = i; k < i + n; k++) e += (y[k] as number) ** 2;
      if (e > bestE) {
        bestE = e;
        best = i;
      }
    }
    const yes = y.slice(best, best + n);
    const none = rec.decode(yes).text;
    const leading = rec.decode(new Float32Array([...sil(0.3), ...yes])).text;
    const trailing = rec.decode(padSpan(yes)).text;
    console.log(
      `asr.local: 0.2 s "Yes." on Parakeet: none -> "${none}", leading 0.3 s -> "${leading}", trailing to 0.5 s -> "${trailing}"`,
    );
    // The rule is that no path loses the word; what Parakeet makes of 0.2 s is recorded above.
    expect(trailing.trim()).not.toBe("");
  }, 60_000);

  test("say -> fake helper -> live Worker -> log: the words and the biased term are there", async () => {
    const micA = say("We should move the build to Vercel tomorrow morning.", "Samantha");
    const callA = say("Sounds good. I will check the Kubernetes cluster on Friday.", "Daniel");
    const callB = say("Please send the invoice to the finance team before noon.", "Karen");
    const micB = say("Yes.", "Samantha");
    let t = 1;
    const clipsMic: { at: number; x: Float32Array }[] = [];
    const clipsCall: { at: number; x: Float32Array }[] = [];
    clipsMic.push({ at: t, x: micA });
    t += micA.length / RATE + 1;
    clipsCall.push({ at: t, x: callA });
    t += callA.length / RATE + 1;
    clipsCall.push({ at: t, x: callB });
    t += callB.length / RATE + 1;
    clipsMic.push({ at: t, x: micB });
    t += micB.length / RATE + 2;
    const total = t;
    const mic = place(total, clipsMic);
    const call = place(total, clipsCall);
    const wav = join(work, "call.wav");
    writeFileSync(wav, stereoWav(mic, call));

    const root = join(work, "calls");
    const logs: string[] = [];
    const vocab: VocabSource = {
      entries: [entry("Vercel"), entry("Kubernetes")],
      files: [{ path: "work.yaml", sha256: "0".repeat(64) }],
    };
    let asr: LiveAsr | null = null;
    let fileSeconds = 0;
    const events: LogEvent[] = [];
    const mgr = new CallManager({
      root,
      engine: new AkouCaptureEngine({
        command: [process.execPath, FAKE_HELPER],
        extraArgs: () => ["--wav", wav, "--speed", "3"],
      }),
      user: "Ana",
      budgets: { flushMs: 60_000, stallMs: 30_000 },
      onEvent: (id, e) => {
        events.push(e);
        asr?.onEvent(id, e);
      },
      onPacket: (id, part, p: Packet, ingest) => {
        fileSeconds = Math.max(fileSeconds, p.fileSeconds);
        asr?.onPacket(id, part, p, ingest);
      },
      beforeEnd: (id) => asr?.flush(id) ?? Promise.resolve(),
    });
    asr = new LiveAsr(
      {
        models: {
          kind: "sherpa",
          dir: MODELS as string,
          cacheDir: join(work, "cache"),
          decoding: "beam",
        },
        vocab: () => vocab,
        onLog: (level, msg) => logs.push(`${level}: ${msg}`),
      },
      (id) => mgr.controller(id) as CallAccess | undefined,
    );
    // A failed expect or a stuck helper must still release the Worker and the helper, or both
    // outlive the test while afterAll deletes the WAV the helper is reading.
    try {
      const t0 = performance.now();
      const res = await mgr.start({ workspace: "work", title: "Integration" });
      if (!res.ok) throw new Error(res.error);
      const startMs = performance.now() - t0;
      // Stop when the file has played once (the fake helper loops its source).
      const deadline = performance.now() + 60_000;
      while (fileSeconds < total - 0.3) {
        if (performance.now() > deadline) {
          throw new Error(`the helper played ${fileSeconds.toFixed(1)} s of ${total.toFixed(1)} s`);
        }
        await Bun.sleep(50);
      }
      await mgr.stop();
      const stopMs = performance.now() - t0;

      const segs = ofType(events, "seg") as Seg[];
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      console.log(
        `asr.local: live, ${total.toFixed(1)} s of audio at 3x, 201 after ${startMs.toFixed(0)} ms, stopped after ${(stopMs / 1000).toFixed(1)} s, loads ${JSON.stringify(asr.loads)}`,
      );
      for (const s of segs) {
        console.log(
          `  ${formatWall(s.w0 as number, tz)} ${s.id} ${String(s.ch).padEnd(4)} ${String(s.spk).padEnd(3)} ${(s.a0 as number).toFixed(2)}-${(s.a1 as number).toFixed(2)} s  ${s.text}`,
        );
      }
      const used = ofType(events, "vocab.used");
      console.log(`  vocab.used: ${JSON.stringify(used.map((u) => u.entries))}`);
      console.log(`  asr.lag: ${JSON.stringify(ofType(events, "asr.lag").map((l) => l.seconds))}`);
      for (const l of logs.filter((x) => !x.startsWith("info"))) console.log(`  log ${l}`);

      const micText = segs
        .filter((s) => s.ch === "mic")
        .map((s) => s.text)
        .join(" ");
      const callText = segs
        .filter((s) => s.ch === "call")
        .map((s) => s.text)
        .join(" ");
      expect(micText.toLowerCase()).toContain("move");
      expect(micText.toLowerCase()).toContain("tomorrow");
      expect(callText.toLowerCase()).toContain("friday");
      expect(callText.toLowerCase()).toContain("invoice");
      expect(micText).toContain("Vercel");
      expect(callText).toContain("Kubernetes");
      expect(used.at(-1)?.entries).toEqual(["Vercel", "Kubernetes"]);

      // Positive control: the same clips decoded with no hotwords.
      const plain = new SherpaModels({
        dir: MODELS as string,
        cacheDir: join(work, "cache-plain"),
        decoding: "beam",
      });
      const unbiased = plain.prepare(null);
      const micPlain = unbiased.recognizer.decode(padSpan(micA)).text;
      const callPlain = unbiased.recognizer.decode(padSpan(callA)).text;
      console.log(`  unbiased control: mic "${micPlain}" | call "${callPlain}"`);
      expect(micPlain).not.toContain("Vercel");
      expect(segs.filter((s) => s.ch === "mic").every((s) => s.spk === "you")).toBe(true);
      expect(asr.loads[RECOGNIZER]).toBe(1);

      // The final pass over the same audio, through its own Worker and the call's writer.
      const c = mgr.controller(res.call);
      if (!c) throw new Error("no controller");
      const f0 = performance.now();
      const fin = await finalizeCall(c, {
        models: {
          kind: "sherpa",
          dir: MODELS as string,
          cacheDir: join(work, "cache"),
          decoding: "beam",
        },
        audio: { kind: "wav", files: { 1: wav } },
        vocab,
        onLog: (level, msg) => logs.push(`final ${level}: ${msg}`),
      });
      console.log(
        `asr.local: final pass ${((performance.now() - f0) / 1000).toFixed(1)} s, ok ${fin.ok}, loads ${JSON.stringify(fin.loads)}, skipped ${fin.skipped.length}`,
      );
      for (const l of c.view.lines("final")) {
        console.log(
          `  ${formatWall(l.w0, tz)} ${l.id} ${l.ch.padEnd(4)} ${l.spkRaw.padEnd(3)} -> ${l.speaker.padEnd(10)} ${l.text}`,
        );
      }
      const { events: all } = await import("../../src/core/log/reader.ts").then((r) =>
        r.readLog(join(res.folder, "events.jsonl")),
      );
      for (const m of all.filter((e) => e.type === "speaker.map" || e.type === "speaker.suggest")) {
        console.log(`  ${JSON.stringify(m)}`);
      }
      expect(fin.ok).toBe(true);
      const finalText = c.view
        .lines("final")
        .map((l) => l.text)
        .join(" ");
      expect(finalText).toContain("Vercel");
      expect(finalText.toLowerCase()).toContain("invoice");
    } finally {
      await asr?.close();
      await mgr.quit();
    }
  }, 180_000);
});
