/**
 * Bazarr's whisper endpoints (docs/ux/SERVER.md SV-C3), through the real API: `POST /v1/asr` and
 * `POST /v1/detect-language` take the request Bazarr's `whisperai` provider sends, byte for byte
 * (one part `audio_file` with a filename and no Content-Type, raw 16 kHz mono s16le, the
 * `Subliminal/2.1` user agent, no key), and answer what it reads: an SRT body, or JSON with
 * `language_code`. The recognizer is the fake engine in a real finalize Worker; detection runs
 * the `best` preset on the fake llama-server.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DETECT_PCM_BYTES } from "../src/main/api/routes/bazarr.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { llamaRuntime } from "../src/main/asr/llama-server.ts";
import { hostPlatform, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav, roomNoise } from "./fixtures/audio.ts";
import { modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";
import { clip, newKey, SERVER, submit } from "./server-helpers.ts";

// Every case runs real jobs through a finalize Worker; a loaded CI box is slow.
setDefaultTimeout(30_000);

const FAKE_LLAMA = join(import.meta.dir, "fixtures", "fake-llama-server.ts");

/** Raw 16 kHz mono s16le, as Bazarr's ffmpeg writes it: the WAV's samples with no header. */
function pcm(x: Float32Array): Uint8Array {
  return monoWav(x).subarray(44);
}

/** Three seconds of silence, then the words: the first cue must start after the silence. */
const LATE = pcm(concat(silence(3), speak(["hello", "world"]), silence(0.6)));

/**
 * The body `requests` builds for Bazarr's `files={"audio_file": bytes}`: a part with a filename
 * and no Content-Type. Built by hand, since `FormData` would add a part Content-Type.
 */
function bazarrBody(audio: Uint8Array, part = 'name="audio_file"; filename="audio_file"'): Buffer {
  return Buffer.concat([
    Buffer.from(`--b\r\nContent-Disposition: form-data; ${part}\r\n\r\n`),
    Buffer.from(audio),
    Buffer.from("\r\n--b--\r\n"),
  ]);
}

interface Reply {
  status: number;
  type: string;
  text: string;
}

async function bazarr(
  rig: AppRig,
  path: string,
  audio: Uint8Array,
  o: { headers?: Record<string, string>; part?: string } = {},
): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1${path}`, {
    method: "POST",
    headers: {
      "user-agent": "Subliminal/2.1",
      "content-type": "multipart/form-data; boundary=b",
      ...o.headers,
    },
    body: bazarrBody(audio, o.part),
  });
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    text: await res.text(),
  };
}

/** The cues of an SRT body, or a failure naming what is not SRT (a JSON refusal, say). */
function srtCues(body: string): { n: number; start: string; end: string; text: string }[] {
  const blocks = body.replace(/\r\n/g, "\n").trim().split(/\n\n+/);
  return blocks.map((b, i) => {
    const m = /^(\d+)\n(\d\d:\d\d:\d\d,\d{3}) --> (\d\d:\d\d:\d\d,\d{3})\n([\s\S]+)$/.exec(b);
    if (!m || Number(m[1]) !== i + 1) throw new Error(`cue ${i + 1} is not SRT: ${b}`);
    return { n: Number(m[1]), start: m[2] as string, end: m[3] as string, text: m[4] as string };
  });
}

function uploads(rig: AppRig): string[] {
  const dir = join(rig.app.configDir, "jobs", "audio");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function created(rig: AppRig): string[] {
  return rig.logs.filter((l) => l.msg.startsWith("job.created ")).map((l) => l.msg);
}

describe("[SV-C3] Bazarr's /asr on a server with server.bazarr on", () => {
  let rig: AppRig;

  beforeAll(async () => {
    rig = await appRig({
      settings: { ...SERVER, "server.bazarr": true, "server.max_audio_minutes": 1 },
    });
  });
  afterAll(async () => {
    await rig?.close();
  });

  test("[SV-C3] Bazarr's exact /asr request returns an SRT with the words", async () => {
    const r = await bazarr(rig, "/asr?task=transcribe&language=en&output=srt&encode=false", LATE);
    expect(`${r.status} ${r.text}`).toStartWith("200 ");
    expect(r.type).toStartWith("text/plain");
    expect(r.text).toMatch(
      /^1\r?\n(\d\d:\d\d:\d\d,\d{3}) --> \d\d:\d\d:\d\d,\d{3}\r?\nhello world/,
    );
    const cues = srtCues(r.text);
    // Absolute times from the first sample: Bazarr pads with `adelay` and keeps the times as sent.
    expect(cues[0]?.start.localeCompare("00:00:02,500")).toBeGreaterThanOrEqual(0);
    // The job ran as Bazarr's stand-in, and is gone with its upload once the answer was sent.
    expect(created(rig).at(-1)).toEndWith(" key bazarr");
    expect(uploads(rig)).toEqual([]);
  });

  test("[T4.37] a track of room noise gets a 200 and an empty subtitle, never an invented cue", async () => {
    const r = await bazarr(
      rig,
      "/asr?task=transcribe&language=en&output=srt&encode=false",
      pcm(roomNoise(10)),
    );
    expect([r.status, r.text.trim()]).toEqual([200, ""]);
    // Positive control: the same request with speech in it has a cue.
    const said = await bazarr(
      rig,
      "/asr?task=transcribe&language=en&output=srt&encode=false",
      LATE,
    );
    expect(srtCues(said.text).length).toBeGreaterThan(0);
  });

  test("[SV-C3] red controls: the SRT check fails on a JSON refusal; a part with no filename is no file", async () => {
    const refusal = await bazarr(rig, "/asr?task=summarize&output=srt&encode=false", LATE);
    expect(() => srtCues(refusal.text)).toThrow("is not SRT");
    // The same bytes as a text part: the text cap or the file check refuses them, so the
    // test above sends a file part.
    const text = await bazarr(rig, "/asr?output=srt&encode=false", LATE, {
      part: 'name="audio_file"',
    });
    expect([413, 422]).toContain(text.status);
  });

  test("[SV-C3] encode=true with a WAV body transcribes through the container path", async () => {
    const wav = monoWav(concat(silence(0.4), speak(["hello", "world"]), silence(0.6)));
    const r = await bazarr(rig, "/asr?task=transcribe&language=en&output=txt&encode=true", wav);
    expect(`${r.status} ${r.text}`).toBe("200 hello world\n");
  });

  test("[SV-C3] output=vtt starts with WEBVTT; output=txt is the text", async () => {
    const v = await bazarr(rig, "/asr?output=vtt&encode=false", LATE);
    expect(v.status).toBe(200);
    expect(v.text).toStartWith("WEBVTT\n");
    expect(v.text).toContain("hello world");
    const t = await bazarr(rig, "/asr?encode=false", LATE);
    expect(`${t.status} ${t.text}`).toBe("200 hello world\n");
  });

  test("[SV-C3] task=translate returns an English SRT; a language no engine reads is a logged 422", async () => {
    const r = await bazarr(rig, "/asr?task=translate&language=es&output=srt&encode=false", LATE);
    expect(r.status).toBe(200);
    expect(srtCues(r.text).length).toBeGreaterThan(0);
    expect(r.text).toContain("hello world");
    expect(uploads(rig)).toEqual([]);
    const tlh = await bazarr(rig, "/asr?task=translate&language=tlh&output=srt&encode=false", LATE);
    expect(`${tlh.status} ${JSON.parse(tlh.text).error}`).toBe("422 unsupported_language");
    expect(rig.logs.some((l) => l.level === "warn" && l.msg.includes("unsupported_language"))).toBe(
      true,
    );
  });

  test("[SV-C3] values the dialect does not speak are refused, and logged", async () => {
    const r = await bazarr(rig, "/asr?task=summarize&language=en&output=srt&encode=false", LATE);
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text)).toMatchObject({ error: "bad_param", param: "task" });
    expect(rig.logs.some((l) => l.level === "warn" && l.msg.includes("bad_param"))).toBe(true);
    // Other values the dialect does not speak are refused by the declared enums.
    for (const q of ["output=json", "encode=maybe"]) {
      const x = await bazarr(rig, `/asr?${q}`, LATE);
      expect(`${q} ${x.status} ${JSON.parse(x.text).error}`).toBe(`${q} 400 bad_param`);
    }
    const lang = await bazarr(rig, "/asr?language=not_a_tag&encode=false", LATE);
    expect(`${lang.status} ${JSON.parse(lang.text).error}`).toBe("422 bad_field");
    const extra = await bazarr(rig, "/asr?encode=false", LATE, {
      part: 'name="file"; filename="x"',
    });
    expect(`${extra.status} ${JSON.parse(extra.text).error}`).toBe("400 unknown_field");
    expect(uploads(rig)).toEqual([]);
  });

  test("[SV-C3] a Bearer key is honoured on the open route", async () => {
    const k = await newKey(rig, "bazarr-keyed");
    const keyed = await bazarr(rig, "/asr?output=srt&encode=false", LATE, {
      headers: { authorization: `Bearer ${k.key}` },
    });
    expect(keyed.status).toBe(200);
    expect(created(rig).at(-1)).toEndWith(` key ${k.id}`);
    const anon = await bazarr(rig, "/asr?output=srt&encode=false", LATE);
    expect(anon.text).toBe(keyed.text);
    expect(created(rig).at(-1)).toEndWith(" key bazarr");
    // An unknown bearer on an open route is anonymous, not refused.
    const wrong = await bazarr(rig, "/asr?output=srt&encode=false", LATE, {
      headers: { authorization: "Bearer ak_not_a_key" },
    });
    expect(wrong.text).toBe(keyed.text);
  });

  test("[SV-C3] GET /v1/server reports capabilities.bazarr true while the setting is on", async () => {
    const s = await fetch(`http://127.0.0.1:${rig.port}/v1/server`);
    expect(((await s.json()) as { capabilities: { bazarr: boolean } }).capabilities.bazarr).toBe(
      true,
    );
  });

  test("[SV-C3] the setting is not writable over the API", async () => {
    const r = await rig.api("PATCH", "/config", { "server.bazarr": false });
    expect(r.status).not.toBe(200);
    expect(rig.app.config().settings["server.bazarr"]).toBe(true);
  });
});

describe("[SV-C3] server.bazarr off", () => {
  let rig: AppRig;
  beforeAll(async () => {
    rig = await appRig({ settings: { ...SERVER } });
  });
  afterAll(async () => {
    await rig?.close();
  });

  test("[SV-C3] server.bazarr off answers 404 not_found and capabilities.bazarr is false", async () => {
    for (const path of ["/asr?output=srt&encode=false", "/detect-language?encode=false"]) {
      const r = await bazarr(rig, path, LATE);
      expect(`${path} ${r.status}`).toBe(`${path} 404`);
      expect(JSON.parse(r.text).error).toBe("not_found");
      expect(JSON.parse(r.text).message).toBe("server.bazarr is off");
    }
    const s = (await (await fetch(`http://127.0.0.1:${rig.port}/v1/server`)).json()) as {
      capabilities: { bazarr: boolean };
    };
    expect(s.capabilities.bazarr).toBe(false);
    expect(uploads(rig)).toEqual([]);
  });
});

describe("[SV-C3] /detect-language", () => {
  let rig: AppRig;
  const decoded: number[] = [];

  beforeAll(async () => {
    rig = await appRig({
      settings: {
        ...SERVER,
        "server.bazarr": true,
        "server.max_audio_minutes": 1,
        "asr.llamaServer": [process.execPath, FAKE_LLAMA, "--fake-lang", "Spanish"],
      },
      jobs: {
        decode: async (path: string, signal: AbortSignal, maxSamples: number) => {
          const x = await readUploadAudio(path, { signal, maxSamples });
          decoded.push(x.length);
          return x;
        },
      },
    });
  });
  afterAll(async () => {
    await rig?.close();
  });

  test("[SV-C3] /detect-language names the language under best, from the first 30 s only", async () => {
    // 40 s of track, as Bazarr sends the whole of it.
    const track = pcm(concat(silence(0.4), speak(["hello", "world"]), silence(39)));
    expect(track.length).toBeGreaterThan(DETECT_PCM_BYTES);
    const r = await bazarr(
      rig,
      "/detect-language?encode=false&video_file=%2Fmovies%2Fa.mkv",
      track,
    );
    expect(`${r.status} ${r.text}`).toStartWith("200 ");
    expect(JSON.parse(r.text)).toEqual({
      detected_language: "spanish",
      language_code: "es",
      confidence: null,
    });
    expect(created(rig).at(-1)).toContain(" key bazarr");
    // The job decoded at most 30 s: 480 000 samples, not the 640 000 sent.
    expect(decoded.at(-1)).toBe(DETECT_PCM_BYTES / 2);
    expect(uploads(rig)).toEqual([]);
  });

  test("[T4.37] no speech in the first 30 s: 200 and unknown, never an invented language", async () => {
    // Room noise for the first 30 s, then speech the detection never reads.
    const track = pcm(concat(roomNoise(30), speak(["hello", "world"]), silence(5)));
    const r = await bazarr(rig, "/detect-language?encode=false", track);
    expect(`${r.status} ${r.text}`).toStartWith("200 ");
    expect(JSON.parse(r.text)).toEqual({
      detected_language: "unknown",
      language_code: "und",
      confidence: null,
    });
    expect(decoded.at(-1)).toBe(DETECT_PCM_BYTES / 2);
  });
});

describe("[SV-C3] refusals Bazarr cannot read, answered as akou's JSON", () => {
  test("[SV-C3] /detect-language with best refused answers akou's refusal, no language_code", async () => {
    const reg = modelRegistry();
    const build = llamaRuntime(
      { "asr.accelerator": "auto", "asr.llamaServer": [] },
      hostPlatform(),
    ) as string;
    const catalog = [
      reg.entry(RECOGNIZER, ["a.onnx"]),
      reg.entry("silero-vad", ["vad.onnx"]),
      reg.entry(NEMOTRON, ["diar.onnx"]),
      reg.entry(QWEN_ASR, ["q.gguf", "p.gguf"]),
      reg.entry(build, ["llama.tar.gz"]),
    ];
    const t = tempDir("akou-bazarr-refused-");
    const models = join(t.dir, "models");
    for (const e of catalog.slice(0, 3)) reg.install(models, e);
    const rig = await appRig({
      modelRegistry: catalog,
      settings: {
        ...SERVER,
        "server.bazarr": true,
        "asr.modelsDir": models,
        "server.auto_download": false,
      },
      jobs: { modelStore: { freeBytes: () => 1e12 } },
    });
    try {
      const r = await bazarr(rig, "/detect-language?encode=false", LATE);
      expect(r.status).toBe(409);
      const body = JSON.parse(r.text);
      expect(body.error).toBe("preset_unavailable");
      expect(body.language_code).toBeUndefined();
      expect(rig.logs.some((l) => l.level === "warn" && l.msg.includes("preset_unavailable"))).toBe(
        true,
      );
      expect(uploads(rig)).toEqual([]);
    } finally {
      await rig.close();
      reg.stop();
      t.cleanup();
    }
  });

  test("[SV-C3] queue_full comes back as 429 JSON", async () => {
    let open = () => {};
    const held = new Promise<void>((r) => {
      open = r;
    });
    const rig = await appRig({
      settings: { ...SERVER, "server.bazarr": true, "server.queue_max": 1 },
      jobs: {
        decode: async (path: string, signal: AbortSignal) => {
          await held;
          return readUploadAudio(path, { signal });
        },
      },
    });
    try {
      const k = await newKey(rig, "parked");
      expect((await submit(rig, k.key, clip(["hello"], 2), {})).status).toBe(202);
      const r = await bazarr(rig, "/asr?output=srt&encode=false", LATE);
      expect(r.status).toBe(429);
      expect(JSON.parse(r.text)).toMatchObject({ error: "queue_full", limit: "server.queue_max" });
      // Only the parked job's upload is on disk: the refused body was never kept.
      expect(uploads(rig)).toHaveLength(1);
    } finally {
      open();
      await rig.close();
    }
  });
});
