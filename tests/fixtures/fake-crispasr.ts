/**
 * A fake CrispASR running the word-time aligner, for tests: `--align-only` as akou runs it
 * (aligner.ts), with no model. It reads the text from stdin, finds the tone-coded words of
 * `asr-fake.ts` in the WAV (`bursts`) and gives each word its burst's start and end, answering in
 * CrispASR v0.8.44's `--align-format json` shape, `[{word, start, end}]`. Like CrispASR it splits a
 * hyphenated word (`good-looking,` into `good-` and `looking,`), the two parts sharing the burst.
 *
 *   bun tests/fixtures/fake-crispasr.ts [--fake-log FILE] [--fake-mode MODE] --align-only ...
 *
 * `--fake-log FILE` appends one JSON line per run: `{pid, argv, stdin}`. `--fake-mode` breaks the
 * answer as CrispASR has been seen to, or worse: `outside` puts the last word at 400 s, `backwards`
 * starts the last word before the one before it, `count` drops the last word, `hang` never
 * answers, `exit` exits 3 with nothing on stdout, `slow` answers after 1.5 s, and `miss:WORD`
 * drops the last word only in a text that holds WORD (one piece of a job fails, the rest pass).
 */

import { appendFileSync, readFileSync } from "node:fs";
import { bursts, RATE } from "./asr-fake.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const mode = opt("--fake-mode") ?? "ok";
const text = await new Response(Bun.stdin.stream()).text();
const logFile = opt("--fake-log");
if (logFile)
  appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, argv, stdin: text })}\n`);

if (mode === "slow") await Bun.sleep(1500);
if (mode === "hang") await new Promise(() => setInterval(() => {}, 60_000));
if (mode === "exit") {
  process.stderr.write("crispasr[align-only]: alignment failed or produced no words.\n");
  process.exit(3);
}

/** A 16-bit mono WAV's samples, from the data chunk. */
function readWav(path: string): Float32Array {
  const b = readFileSync(path);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  while (at + 8 <= b.length) {
    const id = b.toString("ascii", at, at + 4);
    const size = v.getUint32(at + 4, true);
    if (id === "data") {
      const n = Math.floor(size / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(at + 8 + i * 2, true) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

const x = readWav(opt("-f") as string);
const runs = bursts(x);
const words = text.split(/\s+/).filter(Boolean);
const out: { word: string; start: number; end: number }[] = [];
words.forEach((w, i) => {
  const run = runs[i] ?? runs.at(-1) ?? [0, x.length];
  const parts = w.replace(/-(?=.)/g, "-\n").split("\n");
  const len = (run[1] - run[0]) / parts.length;
  parts.forEach((p, k) => {
    const s = (run[0] + k * len) / RATE;
    const e = (run[0] + (k + 1) * len) / RATE;
    out.push({ word: p, start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100 });
  });
});
const last = out.at(-1);
if (last && mode === "outside") last.start = last.end = 400;
if (last && mode === "backwards") last.start = Math.max(0, (out.at(-2)?.start ?? 0) - 0.05);
if (mode === "count" || (mode.startsWith("miss:") && words.includes(mode.slice(5)))) out.pop();
process.stdout.write(`${JSON.stringify(out)}\n`);
