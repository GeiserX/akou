/**
 * The second pass's benchmark rules, shared by tests/live-second-pass.test.ts (the real models,
 * which CI skips) and tests/second-pass-review.test.ts (a small fake, which CI runs): which
 * requests the host sends (`ticks`), how one reviewer works through them on the call's clock
 * (`review`), and a process's peak resident memory while it runs (`peakRss`).
 */

import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wer } from "../scripts/eval/score.ts";
import type { UpgradeOut } from "../src/main/asr/live-worker.ts";
import { reviewBatches, reviewCap, splitToLines } from "../src/main/asr/upgrade.ts";

/** A closed utterance and the call time (s) it closed at. */
export interface Utt {
  at: number;
  u: UpgradeOut;
  samples: Float32Array;
}

/** One review request: its utterances and when it may start (s). */
export interface Req {
  ready: number;
  utts: Utt[];
}

/**
 * The host's rule: `every` seconds after an utterance closes with no review armed, the utterances
 * closed by then, whole, in requests of at most `reviewCap(every)`. A tick past `end` never comes:
 * the call has ended.
 */
export function ticks(utts: readonly Utt[], every: number, end: number): Req[] {
  const out: Req[] = [];
  let i = 0;
  while (i < utts.length) {
    const tick = (utts[i] as Utt).at + every;
    const due: Utt[] = [];
    while (i < utts.length && (utts[i] as Utt).at <= tick) due.push(utts[i++] as Utt);
    if (tick > end) break;
    for (const b of reviewBatches(due, reviewCap(every))) out.push({ ready: tick, utts: b });
  }
  return out;
}

/**
 * This process's peak resident memory while `run` runs, in bytes, sampled every 200 ms by `ps` in
 * a child process. A synchronous decode holds this thread, so no timer here samples during it.
 */
export async function peakRss<T>(run: () => Promise<T>): Promise<{ out: T; peak: number }> {
  const file = join(tmpdir(), `akou-rss-${process.pid}-${Date.now()}`);
  const child = spawn(
    "sh",
    ["-c", `while :; do ps -o rss= -p ${process.pid}; sleep 0.2; done > '${file}'`],
    { stdio: "ignore" },
  );
  let out: T;
  try {
    out = await run();
  } finally {
    const gone = new Promise((r) => child.once("exit", r));
    child.kill();
    await gone;
  }
  try {
    const kb = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return { out, peak: Math.max(process.memoryUsage().rss, ...kb.map((k) => k * 1024)) };
  } finally {
    rmSync(file, { force: true });
  }
}

export interface Line {
  a0: number;
  a1: number;
  stream: string;
  reviewed: string;
  control: string;
}

export interface Result {
  wer: number;
  control: number;
  delays: number[];
  requests: number;
  reviewedUtts: number;
  busy: number;
  cores: number;
  waited: number;
  memMb: number;
  decodeS: number[];
}

/** What decodes one request, from its utterances' audio: its words. */
export type Decoder = (parts: readonly Float32Array[], lang: "en" | "es") => Promise<string[]>;

/** Runs the requests through one reviewer, one at a time, on the call's clock. */
export async function review(
  reqs: readonly Req[],
  segs: ReadonlyMap<number, Line>,
  ref: string,
  seconds: number,
  end: number,
  lang: "en" | "es",
  decode: Decoder,
): Promise<Omit<Result, "memMb">> {
  const lines = new Map([...segs].map(([k, l]) => [k, { ...l }]));
  const delays: number[] = [];
  const decodeS: number[] = [];
  let cpu = 0;
  let waited = 0;
  let reviewedUtts = 0;
  let now = 0;
  for (const job of reqs) {
    // The call has ended: the app sends no more reviews.
    if (now > end) break;
    if (now > job.ready) waited++;
    now = Math.max(now, job.ready);
    const t = performance.now();
    const c0 = process.cpuUsage();
    const words = await decode(
      job.utts.map((x) => x.samples),
      lang,
    );
    const c1 = process.cpuUsage(c0);
    cpu += (c1.user + c1.system) / 1e6;
    const d = (performance.now() - t) / 1000;
    decodeS.push(d);
    now += d;
    // Its answer would land after the call ended: the app gives that review up.
    if (now > end) break;
    reviewedUtts += job.utts.length;
    const keys = job.utts.flatMap((x) => x.u.keys);
    const texts = job.utts.flatMap((x) => x.u.lines);
    const apply = (k: "reviewed" | "control", ws: string[]) => {
      const parts = splitToLines(texts, ws);
      keys.forEach((key, j) => {
        const cur = lines.get(key);
        const text = (parts[j] ?? "").trim();
        if (cur && text !== "") cur[k] = text;
      });
    };
    apply("reviewed", words);
    apply("control", [...words].reverse());
    for (const key of keys) {
      const l = lines.get(key);
      if (!l) continue;
      const n = l.stream.split(/\s+/).filter(Boolean).length;
      for (let w = 0; w < n; w++) delays.push(now - (l.a0 + ((w + 0.5) / n) * (l.a1 - l.a0)));
    }
  }
  const all = [...lines.values()];
  const text = (k: keyof Line) => all.map((l) => l[k]).join(" ");
  const busy = decodeS.reduce((a, b) => a + b, 0);
  return {
    wer: wer([{ ref, hyp: text("reviewed") }]),
    control: wer([{ ref, hyp: text("control") }]),
    delays,
    requests: decodeS.length,
    reviewedUtts,
    busy: busy / seconds,
    cores: cpu / seconds,
    waited,
    decodeS,
  };
}
