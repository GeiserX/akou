/**
 * A test client of the live door, `GET /v1/live` (docs/server.md "A phone or another live
 * client"): streams an audio file the way a client records it and prints the words as they come,
 * with where they are in the recording and how far behind the audio they arrived.
 *
 *   bun scripts/live-client.ts FILE [--codec ogg-opus|pcm16] [--pace realtime|fast]
 *     [--bitrate 24k] [--language auto] [--model auto] [--json]
 *
 * `AKOU_URL` is the server (default `http://127.0.0.1:8476`), and `AKOU_API_KEY`, or a file named
 * by `AKOU_API_KEY_FILE`, the key. `ffmpeg` turns the file into what the codec sends: Ogg Opus at
 * 16 kHz mono, 20 ms frames in pages of 200 ms (`--bitrate`, 24 kbit/s by default), or raw 16 kHz
 * 16-bit samples in frames of 200 ms. With `--pace realtime` (the default) each frame is sent once
 * the recording would have reached its end, as a phone sends it. `--json` prints one summary line
 * at the end: the words, the lag of each behind its place in the audio, and the bytes sent.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { oggPages, opusHead, readOggPage } from "../src/main/server/ogg.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    codec: { type: "string", default: "ogg-opus" },
    pace: { type: "string", default: "realtime" },
    bitrate: { type: "string", default: "24k" },
    language: { type: "string", default: "auto" },
    model: { type: "string", default: "auto" },
    json: { type: "boolean", default: false },
  },
});
const file = positionals[0];
if (
  !file ||
  !["ogg-opus", "pcm16"].includes(values.codec) ||
  !["realtime", "fast"].includes(values.pace)
) {
  console.error(
    "usage: bun scripts/live-client.ts FILE [--codec ogg-opus|pcm16] [--pace realtime|fast] [--bitrate 24k] [--language auto] [--model auto] [--json]",
  );
  process.exit(64);
}

function key(): string {
  const direct = process.env.AKOU_API_KEY?.trim();
  if (direct) return direct;
  const path = process.env.AKOU_API_KEY_FILE?.trim();
  if (path) return readFileSync(path.replace(/^~(?=\/)/, homedir()), "utf8").trim();
  console.error("live-client: set AKOU_API_KEY or AKOU_API_KEY_FILE");
  process.exit(77);
}

/** The file through ffmpeg, as the codec sends it. */
function convert(path: string, codec: string): Uint8Array {
  const out =
    codec === "pcm16"
      ? ["-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"]
      : [
          ...["-c:a", "libopus", "-b:a", values.bitrate, "-vbr", "on", "-ac", "1", "-ar", "16000"],
          ...["-frame_duration", "20", "-page_duration", "200000", "-application", "voip"],
          ...["-map_metadata", "-1", "-f", "ogg", "pipe:1"],
        ];
  const r = Bun.spawnSync(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", path, ...out]);
  if (r.exitCode !== 0) {
    console.error(`live-client: ffmpeg failed: ${r.stderr.toString().trim()}`);
    process.exit(66);
  }
  return new Uint8Array(r.stdout);
}

/** Each frame, and the second of the recording at which it is complete. */
function frames(bytes: Uint8Array, codec: string): { data: Uint8Array; at: number }[] {
  if (codec === "pcm16") {
    const step = 6400;
    const out: { data: Uint8Array; at: number }[] = [];
    for (let i = 0; i < bytes.length; i += step) {
      const data = bytes.subarray(i, i + step);
      out.push({ data, at: (i + data.length) / 32_000 });
    }
    return out;
  }
  const pages = oggPages(bytes);
  const preSkip = opusHead(readOggPage(pages[0] as Uint8Array).packets[0] as Uint8Array).preSkip;
  return pages.map((data, i) => {
    const g = readOggPage(data).granule;
    // The two header pages go at once; an audio page once its last sample is recorded.
    return { data, at: i < 2 || g < 0n ? 0 : Math.max(0, Number(g) - preSkip) / 48_000 };
  });
}

const base = (process.env.AKOU_URL?.trim() || "http://127.0.0.1:8476").replace(/\/+$/, "");
const url = `${base.replace(/^http/, "ws")}/v1/live`;
const sent = frames(convert(file, values.codec), values.codec);
const bytes = sent.reduce((n, f) => n + f.data.length, 0);
const audioSeconds = sent.at(-1)?.at ?? 0;

const ws = new WebSocket(url, {
  headers: { authorization: `Bearer ${key()}` },
} as unknown as string[]);
ws.binaryType = "arraybuffer";
/** Wall-clock ms when the recording's second 0 was, once the first audio frame is due. */
let t0 = 0;
const words: { text: string; t: number; lag: number; at: number }[] = [];
let ready: Record<string, unknown> | null = null;
/** The `words` messages, and when each came (seconds after second 0 of the recording). */
const arrivals: number[] = [];
let readyMs = 0;
const openedAt = performance.now();

const done = new Promise<{ code: number; reason: string }>((resolve) => {
  ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
});
ws.onerror = () => {
  console.error(`live-client: the socket to ${url} failed`);
};
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  const now = performance.now();
  if (m.type === "ready") {
    ready = m;
    readyMs = now - openedAt;
    if (!values.json)
      console.log(
        `ready: ${m.engine} (${m.lang}), tier ${m.tier_ms} ms, loaded in ${m.load_ms} ms`,
      );
    void stream();
  } else if (m.type === "words") {
    const got = m.tokens.map((x: { text: string; t: number }) => ({
      text: x.text,
      t: x.t,
      lag: (now - t0) / 1000 - x.t,
      at: (now - t0) / 1000,
    }));
    words.push(...got);
    arrivals.push((now - t0) / 1000);
    if (!values.json) {
      const first = got[0];
      console.log(
        `[${first.t.toFixed(2)} s, +${first.lag.toFixed(2)} s]${got.map((x: { text: string }) => x.text).join("")}`,
      );
    }
  } else if (m.type === "error") {
    console.error(`live-client: ${m.code}: ${m.message}`);
  }
};
ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: "hello",
      v: 1,
      codec: values.codec,
      language: values.language,
      model: values.model,
    }),
  );
};

async function stream(): Promise<void> {
  t0 = performance.now();
  for (const f of sent) {
    if (values.pace === "realtime") {
      const wait = t0 + f.at * 1000 - performance.now();
      if (wait > 0) await Bun.sleep(wait);
    }
    ws.send(f.data);
  }
  ws.send(JSON.stringify({ type: "stop" }));
}

const closed = await done;
function median(x: number[]): number | null {
  if (x.length === 0) return null;
  const s = [...x].sort((a, b) => a - b);
  return Math.round((s[Math.floor(s.length / 2)] as number) * 1000) / 1000;
}
const lags = words.map((w) => w.lag).sort((a, b) => a - b);
const pct = (p: number) =>
  lags.length ? (lags[Math.min(lags.length - 1, Math.floor(p * lags.length))] as number) : null;
const summary = {
  codec: values.codec,
  bitrate: values.codec === "ogg-opus" ? values.bitrate : "256k",
  pace: values.pace,
  engine: (ready as { engine?: string } | null)?.engine ?? null,
  ready_ms: Math.round(readyMs),
  audio_s: Math.round(audioSeconds * 100) / 100,
  bytes,
  kbit_per_s: Math.round((bytes * 8) / 1000 / Math.max(audioSeconds, 0.001)),
  tokens: words.length,
  tokens_per_s: Math.round((words.length / Math.max(audioSeconds, 0.001)) * 100) / 100,
  messages: arrivals.length,
  gap_p50_s: median(arrivals.slice(1).map((a, i) => a - (arrivals[i] as number))),
  text: words
    .map((w) => w.text)
    .join("")
    .trim(),
  first_word_lag_s: words[0] ? Math.round(words[0].lag * 1000) / 1000 : null,
  first_word_at_s: words[0] ? Math.round(words[0].at * 1000) / 1000 : null,
  lag_p50_s: pct(0.5),
  lag_p95_s: pct(0.95),
  close: closed.code,
};
if (values.json) console.log(JSON.stringify(summary));
else
  console.log(
    `closed ${closed.code}; ${words.length} tokens, lag p50 ${summary.lag_p50_s?.toFixed(2)} s`,
  );
process.exit(closed.code === 1000 ? 0 : 1);
