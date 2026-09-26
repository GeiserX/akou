/**
 * A fake `llama-server` running Qwen3-ASR, for tests: it speaks the part of llama.cpp's HTTP API
 * akou uses (`GET /health`, `POST /v1/chat/completions` with an `input_audio` part) with no model.
 * It hears the tone-coded words of `asr-fake.ts` through the fake recognizer and answers the way
 * Qwen3-ASR does through llama.cpp, checked against b11200 on an M4:
 *
 * - the content is `language <Name><asr_text><text>`; with an assistant message as the last one
 *   (a forced language), the content starts with that prefill and the log-probs cover only the
 *   tokens after it;
 * - `logprobs.content` is one entry per token, `language`, ` <Name>`, `<asr_text>`, then the words;
 * - a clip with no word is `language None<asr_text>`;
 * - the system message is the context: a glossary term there fixes the word the engine mishears.
 *
 *   bun tests/fixtures/fake-llama-server.ts [--fake-log FILE] [--fake-lang NAME] [--fake-lp NAME=LP]
 *     [--fake-die-after N] [--fake-500 N] [--fake-loading-ms MS] [--fake-refuse-cache] <llama-server args>
 *
 * `--fake-log FILE` appends one JSON line per start (`{argv}`) and per request (`{body}`);
 * `--fake-lang` is the language an auto decode answers (default English); `--fake-lp Spanish=-0.9`
 * sets the per-token log-prob of the words decoded in that language (default -0.05);
 * `--fake-die-after N` exits 70 after answering N completions; `--fake-500 N` answers the first N
 * completions with HTTP 500 (a Metal out-of-memory server), counted across restarts; `--fake-loading-ms` answers 503 on
 * `/health` for that long; `--fake-refuse-cache` exits 64 unless started with `--cache-ram 0`.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { FakeRecognizer } from "./asr-fake.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const all = (name: string) => argv.flatMap((a, i) => (a === name ? [argv[i + 1] as string] : []));

const logFile = opt("--fake-log");
const log = (o: unknown) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(o)}\n`);
};
const autoLang = opt("--fake-lang") ?? "English";
const lps = new Map(all("--fake-lp").map((kv) => kv.split("=") as [string, string]));
const dieAfter = Number(opt("--fake-die-after") ?? Number.POSITIVE_INFINITY);
// The 500s left survive a restart (a state file beside the log), as a real broken GPU would.
const failFile = `${logFile ?? `/tmp/fake-llama-${process.pid}`}.500`;
if (opt("--fake-500") && !existsSync(failFile))
  writeFileSync(failFile, opt("--fake-500") as string);
const takeFailure = (): boolean => {
  if (!existsSync(failFile)) return false;
  const n = Number(readFileSync(failFile, "utf8"));
  if (n <= 0) return false;
  writeFileSync(failFile, String(n - 1));
  return true;
};
const loadedAt = Date.now() + Number(opt("--fake-loading-ms") ?? 0);
const port = Number(opt("--port"));
const host = opt("--host") ?? "127.0.0.1";

if (argv.includes("--fake-refuse-cache") && opt("--cache-ram") !== "0") {
  process.stderr.write("fake-llama-server: started without --cache-ram 0\n");
  process.exit(64);
}
log({ argv, pid: process.pid });

/** 16-bit PCM mono WAV to float samples. */
function wavSamples(bytes: Uint8Array): Float32Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(o, o + 4));
    const size = v.getUint32(o + 4, true);
    if (id === "data") {
      const n = Math.floor(Math.min(size, bytes.length - o - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(o + 8 + i * 2, true) / 32768;
      return out;
    }
    o += 8 + size + (size % 2);
  }
  return new Float32Array(0);
}

interface Part {
  type: string;
  text?: string;
  input_audio?: { data: string; format: string };
}
interface Message {
  role: string;
  content: string | Part[];
}

const recognizer = new FakeRecognizer("fake-parakeet", {});
let answered = 0;

function tok(token: string, logprob: number) {
  return { token, logprob, bytes: [...new TextEncoder().encode(token)], top_logprobs: [] };
}

function complete(body: { messages: Message[]; logprobs?: boolean }): Record<string, unknown> {
  const msgs = body.messages;
  const system = msgs.find((m) => m.role === "system");
  const glossary = typeof system?.content === "string" ? system.content : "";
  const user = msgs.find((m) => m.role === "user");
  const audio = Array.isArray(user?.content)
    ? user.content.find((p) => p.type === "input_audio")?.input_audio?.data
    : undefined;
  const samples = audio ? wavSamples(new Uint8Array(Buffer.from(audio, "base64"))) : null;
  const last = msgs[msgs.length - 1];
  const prefill =
    last?.role === "assistant" && typeof last.content === "string" ? last.content : "";
  const forced = /^language (\w+)<asr_text>$/.exec(prefill)?.[1];
  const hotwords = glossary
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .join("/");
  const heard = samples ? recognizer.decode(samples, hotwords || undefined).text : "";
  const lang = forced ?? (heard === "" ? "None" : autoLang);
  const lp = Number(lps.get(lang) ?? -0.05);
  const words = heard === "" ? [] : heard.split(" ");
  const tokens = [
    ...(forced ? [] : [tok("language", 0), tok(` ${lang}`, -0.01), tok("<asr_text>", 0)]),
    ...words.map((w, i) => tok(i === 0 ? w : ` ${w}`, lp)),
  ];
  const content = `${forced ? prefill : `language ${lang}<asr_text>`}${heard}`;
  return {
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content },
        ...(body.logprobs ? { logprobs: { content: tokens } } : {}),
      },
    ],
    object: "chat.completion",
  };
}

Bun.serve({
  port,
  hostname: host,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Date.now() < loadedAt
        ? Response.json({ error: { code: 503, message: "Loading model" } }, { status: 503 })
        : Response.json({ status: "ok" });
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = (await req.json()) as { messages: Message[]; logprobs?: boolean };
      log({ body: { ...body, messages: body.messages.map(redactAudio) } });
      if (takeFailure()) {
        return Response.json(
          { error: { code: 500, message: "ggml_metal: out of memory" } },
          {
            status: 500,
          },
        );
      }
      const out = complete(body);
      answered++;
      if (answered >= dieAfter) setTimeout(() => process.exit(70), 10);
      return Response.json(out);
    }
    return new Response("not found", { status: 404 });
  },
});

/** The request as logged: the audio replaced by its length. */
function redactAudio(m: Message): Message {
  if (!Array.isArray(m.content)) return m;
  return {
    ...m,
    content: m.content.map((p) =>
      p.input_audio
        ? {
            ...p,
            input_audio: {
              format: p.input_audio.format,
              data: `${p.input_audio.data.length} chars`,
            },
          }
        : p,
    ),
  };
}
