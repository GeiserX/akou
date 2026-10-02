#!/usr/bin/env bun

/**
 * The soak (docs/TESTING.md TS-24, TRAPS T3.8): one long call through the app's own call manager
 * and capture engine, checked for the slow failures a short test never reaches.
 *
 *   bun scripts/soak.ts [--speed 10] [--minutes 60] [--burner] [--helper <akou-capture>] [--out results.json]
 *
 * - Nightly: the fake helper (scripts/fake-helper.ts) at 10x speed for one runner hour, so ten
 *   hours of audio.
 * - Before a stable release, on the reference Mac (scripts/release-checklist.md): eight hours at
 *   1x with `--burner` (one busy process per core) and `--helper`, the Rust helper in file mode
 *   (`--from-wav` of a generated call, looped; it opens no device), so its Opus file is checked too.
 *
 * What it checks, at the end (`judge`):
 *
 * - The audio has no hole: every packet of each channel starts where the last one ended, and the
 *   helper's `part.ended` file length matches the audio the app received within 0.1 s. With
 *   `--helper`, the Opus file's own length matches it too (T3.8).
 * - Memory stays flat: after the warm-up (a tenth of the run), the peak of the app's heap after a
 *   full collection, and of its resident size, grows by no more than its bound from the first half
 *   of the samples to the second.
 * - The event loop is never held: a 100 ms timer is never more than 2 s late.
 * - The log is whole and small: it reads back with no torn, invalid or out-of-order line, holds no
 *   `call.failed` or `gap`, and grows by at most 2 MB per hour of audio.
 *
 * It prints every number next to its bound (and appends that table to the job summary on CI), writes
 * them to `--out`, and exits 1 when any check fails. Nothing it starts outlives it: the helper is the
 * call's, and each burner exits once its parent is gone.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { readLog } from "../src/core/log/reader.ts";
import { EVENTS_FILE } from "../src/core/log/writer.ts";
import { partFile } from "../src/main/call/folder.ts";
import { CallManager } from "../src/main/call/manager.ts";
import { opusDurationSeconds } from "../src/main/call/recovery.ts";
import { AkouCaptureEngine } from "../src/main/capture/helper.ts";
import { CAPTURE_RATE, type Packet } from "../src/main/capture/protocol.ts";
import { writeCallWav } from "../tests/fixtures/audio.ts";

export const SOAK_BOUNDS = {
  /** Heap after a full collection, peak of the second half minus the first, after the warm-up, MB. */
  heapGrowthMb: 64,
  /** Resident size, the same way, MB. */
  rssGrowthMb: 256,
  /** How late a 100 ms timer may run, ms. */
  lateMs: 2000,
  /** File length against the audio received, seconds. */
  fileSlackSeconds: 0.1,
  /** Log bytes per hour of audio. */
  logBytesPerAudioHour: 2 * 1024 * 1024,
} as const;

export interface SoakSample {
  /** Wall seconds since the call started. */
  at: number;
  heapMb: number;
  rssMb: number;
}

export interface SoakResult {
  speed: number;
  wallSeconds: number;
  /** Audio the app received, seconds: the end of the last mic packet. */
  audioSeconds: number;
  /** Packets of either channel that did not start where the previous one ended. */
  holes: number;
  /** The helper's file length from `part.ended`, summed over parts; null if no part ended. */
  fileSeconds: number | null;
  /** The Opus file's own length, with `--helper`; null with the fake, which writes none. */
  opusSeconds: number | null;
  samples: SoakSample[];
  maxLateMs: number;
  events: Record<string, number>;
  log: { bytes: number; torn: boolean; invalid: number; seqErrors: number };
}

export interface Verdict {
  key: string;
  value: number;
  bound: number;
  ok: boolean;
}

/**
 * How much a memory number grew after the warm-up (the first tenth of the run): the peak of the
 * last half of the samples minus the peak of the half before it. Peaks, not two single samples,
 * because bounded memory is not flat: the recognizer queue keeps up to twice its cap of dropped
 * chunks before it compacts (src/main/capture/ingest.ts), a sawtooth of about 90 MB that a
 * comparison of two samples reads as growth or as shrinkage depending on where they fall.
 */
function growth(r: SoakResult, key: "heapMb" | "rssMb"): number {
  const post = r.samples.filter((s) => s.at >= r.wallSeconds / 10);
  if (post.length < 2) return Number.POSITIVE_INFINITY;
  const mid = Math.floor(post.length / 2);
  const peak = (xs: SoakSample[]) => Math.max(...xs.map((s) => s[key]));
  return peak(post.slice(mid)) - peak(post.slice(0, mid));
}

/** Every check of a soak, each with its number and its bound. */
export function judge(r: SoakResult): Verdict[] {
  const B = SOAK_BOUNDS;
  const v = (key: string, value: number, bound: number, ok: boolean): Verdict => ({
    key,
    value: Math.round(value * 1000) / 1000,
    bound,
    ok,
  });
  const heap = growth(r, "heapMb");
  const rss = growth(r, "rssMb");
  const file = r.fileSeconds === null ? Number.POSITIVE_INFINITY : r.fileSeconds - r.audioSeconds;
  const failures = (r.events["call.failed"] ?? 0) + (r.events.gap ?? 0);
  const bad = (r.log.torn ? 1 : 0) + r.log.invalid + r.log.seqErrors;
  const perHour =
    r.audioSeconds > 0 ? r.log.bytes / (r.audioSeconds / 3600) : Number.POSITIVE_INFINITY;
  const out = [
    v("audio.holes", r.holes, 0, r.holes === 0),
    v(
      "audio.file_minus_received_s",
      file,
      B.fileSlackSeconds,
      Math.abs(file) <= B.fileSlackSeconds,
    ),
    v("memory.heap_growth_mb", heap, B.heapGrowthMb, heap <= B.heapGrowthMb),
    v("memory.rss_growth_mb", rss, B.rssGrowthMb, rss <= B.rssGrowthMb),
    v("loop.max_late_ms", r.maxLateMs, B.lateMs, r.maxLateMs <= B.lateMs),
    v("events.failed_or_gap", failures, 0, failures === 0),
    v("log.unreadable_lines", bad, 0, bad === 0),
    v(
      "log.bytes_per_audio_hour",
      perHour,
      B.logBytesPerAudioHour,
      perHour <= B.logBytesPerAudioHour,
    ),
  ];
  if (r.opusSeconds !== null) {
    const opus = r.fileSeconds === null ? Number.POSITIVE_INFINITY : r.opusSeconds - r.fileSeconds;
    out.push(
      v("audio.opus_minus_file_s", opus, B.fileSlackSeconds, Math.abs(opus) <= B.fileSlackSeconds),
    );
  }
  return out;
}

const FAKE = join(import.meta.dir, "fake-helper.ts");

export interface SoakOptions {
  speed: number;
  /** Wall seconds the call records. */
  seconds: number;
  /** The Rust helper, run in file mode; the fake helper when absent. */
  helper?: string;
  log?: (line: string) => void;
}

/** Records one call for `seconds` of wall time and measures it. */
export async function soak(o: SoakOptions): Promise<SoakResult> {
  const root = mkdtempSync(join(tmpdir(), "akou-soak-"));
  const say = o.log ?? (() => {});
  const events: Record<string, number> = {};
  const next = { mic: -1, call: -1 };
  let holes = 0;
  let audioSeconds = 0;
  const onPacket = (p: Packet) => {
    const at = next[p.ch];
    if (at >= 0 && Math.abs(p.fileSeconds - at) > 0.001) holes++;
    next[p.ch] = p.fileSeconds + p.samples.length / CAPTURE_RATE;
    if (p.ch === "mic") audioSeconds = next.mic;
  };
  let engine: AkouCaptureEngine;
  if (o.helper) {
    const wav = join(root, "source.wav");
    writeCallWav(wav, 60);
    engine = new AkouCaptureEngine({
      command: [o.helper],
      extraArgs: () => ["--from-wav", wav, "--loop", "--speed", String(o.speed)],
      env: { ...process.env, AKOU_CAPTURE_FILE_ONLY: "1" },
    });
  } else {
    engine = new AkouCaptureEngine({
      command: [process.execPath, FAKE],
      extraArgs: () => ["--speed", String(o.speed)],
    });
  }
  const mgr = new CallManager({
    root: join(root, "calls"),
    engine,
    onEvent: (_, e: LogEvent) => {
      events[e.type] = (events[e.type] ?? 0) + 1;
    },
    onPacket: (_, __, p) => onPacket(p),
  });
  let maxLateMs = 0;
  let expected = performance.now() + 100;
  const ticker = setInterval(() => {
    const now = performance.now();
    maxLateMs = Math.max(maxLateMs, now - expected);
    expected = now + 100;
  }, 100);
  const samples: SoakSample[] = [];
  const t0 = performance.now();
  const sample = () => {
    Bun.gc(true);
    const m = process.memoryUsage();
    const s = {
      at: (performance.now() - t0) / 1000,
      heapMb: m.heapUsed / 2 ** 20,
      rssMb: m.rss / 2 ** 20,
    };
    samples.push(s);
    say(
      `${s.at.toFixed(0)} s: ${(audioSeconds / 3600).toFixed(2)} h of audio, heap ${s.heapMb.toFixed(1)} MB, rss ${s.rssMb.toFixed(1)} MB`,
    );
  };
  try {
    const started = await mgr.start({ workspace: "soak", title: "Soak" });
    if (!started.ok) throw new Error(`the call did not start: ${JSON.stringify(started)}`);
    const folder = started.folder;
    sample();
    // Ten seconds at most, so a peak of the queue's sawtooth (a minute long at 10x) is never missed.
    const every = Math.max(1, Math.min(10, o.seconds / 20));
    while (performance.now() - t0 < o.seconds * 1000) {
      await Bun.sleep(Math.min(every * 1000, o.seconds * 1000 - (performance.now() - t0)));
      sample();
    }
    const wallSeconds = (performance.now() - t0) / 1000;
    const stopped = await mgr.stop("live");
    if (!stopped.ok) throw new Error(`the call did not stop: ${JSON.stringify(stopped)}`);
    const read = await readLog(join(folder, EVENTS_FILE));
    const ended = read.events.filter(
      (e): e is Extract<LogEvent, { type: "part.ended" }> => e.type === "part.ended",
    );
    const parts = read.events.filter((e) => e.type === "part.started").length;
    let opusSeconds: number | null = null;
    if (o.helper) {
      opusSeconds = 0;
      for (let p = 1; p <= parts; p++)
        opusSeconds += opusDurationSeconds(join(folder, partFile(p))) ?? Number.NaN;
    }
    return {
      speed: o.speed,
      wallSeconds,
      audioSeconds,
      holes,
      fileSeconds: ended.length > 0 ? ended.reduce((a, e) => a + e.fileSeconds, 0) : null,
      opusSeconds,
      samples,
      maxLateMs,
      events,
      log: {
        bytes: statSync(join(folder, EVENTS_FILE)).size,
        torn: read.torn !== null,
        invalid: read.invalid.length,
        seqErrors: read.seqErrors.length,
      },
    };
  } finally {
    clearInterval(ticker);
    await mgr.quit();
    rmSync(root, { recursive: true, force: true });
  }
}

/** One busy process per core, each ending itself once its parent is gone (T3.8's CPU load). */
function burners(): () => void {
  const code =
    "const p = process.ppid; for (;;) { for (let i = 0; i < 1e7; i++); if (process.ppid !== p) process.exit(0); }";
  const procs = Array.from({ length: availableParallelism() }, () =>
    Bun.spawn([process.execPath, "-e", code], { stdout: "ignore", stderr: "ignore" }),
  );
  return () => {
    for (const p of procs) p.kill("SIGKILL");
  };
}

export function report(r: SoakResult, verdicts: readonly Verdict[], helper: string): string {
  return [
    `### soak on ${process.platform}-${process.arch}`,
    "",
    `${helper} at ${r.speed}x for ${(r.wallSeconds / 60).toFixed(1)} min: ${(r.audioSeconds / 3600).toFixed(2)} h of audio, events ${JSON.stringify(r.events)}`,
    "",
    "| | Check | Value | Bound |",
    "|---|---|---|---|",
    ...verdicts.map(
      (v) => `| ${v.ok ? "ok" : "**FAIL**"} | \`${v.key}\` | ${v.value} | ${v.bound} |`,
    ),
    "",
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? undefined : argv[i + 1];
  };
  const speed = Number(flag("--speed") ?? 10);
  const minutes = Number(flag("--minutes") ?? 60);
  if (!(speed > 0) || !(minutes > 0)) {
    console.error(
      "usage: bun scripts/soak.ts [--speed 10] [--minutes 60] [--burner] [--helper <akou-capture>] [--out results.json]",
    );
    return 64;
  }
  const helper = flag("--helper");
  const stopBurners = argv.includes("--burner") ? burners() : () => {};
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      stopBurners();
      process.exit(130);
    });
  let r: SoakResult;
  try {
    r = await soak({ speed, seconds: minutes * 60, helper, log: (l) => console.error(l) });
  } finally {
    stopBurners();
  }
  const verdicts = judge(r);
  const text = report(
    r,
    verdicts,
    `${helper ? "akou-capture (file mode)" : "the fake helper"}${argv.includes("--burner") ? " with a burner on every core" : ""}`,
  );
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, text, { flag: "a" });
  const out = flag("--out");
  if (out) writeFileSync(out, `${JSON.stringify({ ...r, verdicts }, null, 2)}\n`);
  return verdicts.every((v) => v.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
