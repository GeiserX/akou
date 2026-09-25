/**
 * The OpenAI transcription endpoint (docs/ux/SERVER.md SV-C1) and its conformance test (SV-T3):
 * the request fields and the answers are checked against a pinned copy of the OpenAI OpenAPI file's
 * transcription operation (`fixtures/openai-transcription.json`, MIT, with its source commit). A
 * field the pinned file adds without a sample here fails the test, and so does any answer that does
 * not match its schema, including a property the schema does not name.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  presetForModel,
  promptTerms,
  RESPONSE_FORMATS,
  srt,
  vtt,
} from "../src/main/api/routes/openai.ts";
import { RECOGNIZER } from "../src/main/asr/models.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { validate } from "./fixtures/json-schema.ts";

// Every case runs real jobs through a finalize Worker, several per case; a loaded CI box is slow.
setDefaultTimeout(30_000);

// biome-ignore lint/suspicious/noExplicitAny: the pinned OpenAPI file is walked by key.
const SPEC: any = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "openai-transcription.json"), "utf8"),
);
const SCHEMAS = SPEC.components.schemas;
const OK = SPEC.operation.responses["200"].content;

function check(schema: Record<string, unknown>, value: unknown): string[] {
  return validate(SPEC, schema, value, { strict: true });
}

const NOTE = monoWav(
  concat(
    silence(0.4),
    speak(["hello", "world"]),
    silence(0.8),
    speak(["ok", "great"]),
    silence(0.6),
  ),
);

/** One value per request field of the pinned operation; `[]` marks a list field. */
const SAMPLES: Record<string, [string, string][]> = {
  file: [],
  model: [["model", "whisper-1"]],
  language: [["language", "en"]],
  languages: [["languages[]", "en"]],
  keywords: [["keywords[]", "Hetzner"]],
  prompt: [["prompt", "Kubernetes, deploy"]],
  response_format: [["response_format", "json"]],
  temperature: [["temperature", "0.2"]],
  include: [["include[]", "logprobs"]],
  timestamp_granularities: [
    ["timestamp_granularities[]", "word"],
    ["timestamp_granularities[]", "segment"],
  ],
  stream: [["stream", "false"]],
  chunking_strategy: [["chunking_strategy", "auto"]],
  known_speaker_names: [["known_speaker_names[]", "agent"]],
  known_speaker_references: [["known_speaker_references[]", "data:audio/wav;base64,UklGRg=="]],
};

let rig: AppRig;
let key: string;

async function post(
  fields: [string, string][],
  file: Uint8Array | null = NOTE,
): Promise<{ status: number; type: string; text: string }> {
  const form = new FormData();
  if (file) form.append("file", new Blob([file], { type: "audio/wav" }), "note.wav");
  for (const [k, v] of fields) form.append(k, v);
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    text: await res.text(),
  };
}

beforeAll(async () => {
  rig = await appRig({ settings: { "server.enabled": true, "api.bind": "127.0.0.1" } });
  const r = await cli({ ...process.env, ...rig.env }, [
    "keys",
    "create",
    "--name",
    "nextcloud",
    "--json",
  ]);
  expect(r.code).toBe(0);
  key = r.json.key;
});

afterAll(async () => {
  await rig?.close();
});

describe("SV-T3: conformance with the pinned OpenAI transcription operation", () => {
  test("the pinned file is the operation, from a named commit", () => {
    expect(SPEC.source).toContain("github.com/openai/openai-openapi/blob/");
    expect(`${SPEC.method} ${SPEC.path}`).toBe("post /audio/transcriptions");
    expect(Object.keys(SPEC.operation.requestBody.content)).toEqual(["multipart/form-data"]);
  });

  test("every request field of the operation has a sample here", () => {
    const fields = Object.keys(SCHEMAS.CreateTranscriptionRequest.properties);
    expect(Object.keys(SAMPLES).sort()).toEqual([...fields].sort());
    // Positive control: a field the file adds is caught.
    expect([...fields, "new_field"].filter((f) => !(f in SAMPLES))).toEqual(["new_field"]);
    // And every sample fits its field's schema.
    for (const [name, values] of Object.entries(SAMPLES)) {
      const schema = SCHEMAS.CreateTranscriptionRequest.properties[name];
      const isList = schema.type === "array";
      if (values.length === 0) continue;
      const v = isList ? values.map(([, x]) => x) : (values[0] as [string, string])[1];
      const typed = name === "temperature" ? Number(v) : name === "stream" ? v === "true" : v;
      expect(`${name}: ${check(schema, typed).join("; ")}`).toBe(`${name}: `);
    }
  });

  for (const name of Object.keys(SAMPLES)) {
    test(`a request with ${name} is taken, and the answer matches the operation's 200 schema`, async () => {
      const fields =
        name === "model" ? SAMPLES.model : [...(SAMPLES.model ?? []), ...(SAMPLES[name] ?? [])];
      const r = await post(fields as [string, string][]);
      expect(r.status).toBe(200);
      expect(r.type).toContain("application/json");
      expect(check(OK["application/json"].schema, JSON.parse(r.text))).toEqual([]);
    });
  }

  test("every field at once is taken", async () => {
    const all = Object.values(SAMPLES).flat();
    const r = await post(all.filter(([k]) => k !== "response_format"));
    expect(r.status).toBe(200);
    expect(check(OK["application/json"].schema, JSON.parse(r.text))).toEqual([]);
  });

  test("the pinned response formats are exactly the ones akou answers", () => {
    expect([...RESPONSE_FORMATS].sort()).toEqual([...SCHEMAS.AudioResponseFormat.enum].sort());
  });

  const JSON_FORMATS: Record<string, string> = {
    json: "CreateTranscriptionResponseJson",
    verbose_json: "CreateTranscriptionResponseVerboseJson",
    diarized_json: "CreateTranscriptionResponseDiarizedJson",
  };
  for (const [format, name] of Object.entries(JSON_FORMATS)) {
    test(`response_format=${format} matches ${name}, and only it of the three`, async () => {
      const r = await post([
        ["model", "whisper-1"],
        ["response_format", format],
        ["timestamp_granularities[]", "word"],
        ["timestamp_granularities[]", "segment"],
      ]);
      expect(r.status).toBe(200);
      const body = JSON.parse(r.text);
      expect(check({ $ref: `#/components/schemas/${name}` }, body)).toEqual([]);
      expect(check(OK["application/json"].schema, body)).toEqual([]);
      expect(body.text).toBe("hello world ok great");
    });
  }

  test("verbose_json carries language, duration, text, words and segments with the OpenAI fields, and usage", async () => {
    const r = await post([
      ["model", "fast"],
      ["language", "en"],
      ["response_format", "verbose_json"],
      ["timestamp_granularities[]", "word"],
      ["timestamp_granularities[]", "segment"],
    ]);
    const b = JSON.parse(r.text);
    expect(Object.keys(b).sort()).toEqual([
      "duration",
      "language",
      "segments",
      "text",
      "usage",
      "words",
    ]);
    expect(b.language).toBe("en");
    expect(b.segments.length).toBeGreaterThan(0);
    expect(b.usage).toEqual({ type: "duration", seconds: b.duration });
    // Positive control: renaming one field of akou's answer fails the schema check.
    const { duration, ...rest } = b;
    expect(check(OK["application/json"].schema, { ...rest, dur: duration })).not.toEqual([]);
    const { words, ...noWords } = b;
    expect(check(OK["application/json"].schema, { ...noWords, word: words })).not.toEqual([]);
    const seg = { ...b.segments[0], start_s: b.segments[0].start };
    expect(check(OK["application/json"].schema, { ...b, segments: [seg] })).not.toEqual([]);
  });

  test("text, srt and vtt answer plain text", async () => {
    const text = await post([["response_format", "text"]]);
    expect(text.type).toContain("text/plain");
    expect(text.text).toBe("hello world ok great\n");
    const s = await post([["response_format", "srt"]]);
    const cues = s.text.trim().split(/\n\n/);
    expect(cues.length).toBeGreaterThan(0);
    for (const [i, c] of cues.entries()) {
      expect(c).toMatch(
        new RegExp(`^${i + 1}\\n\\d\\d:\\d\\d:\\d\\d,\\d{3} --> \\d\\d:\\d\\d:\\d\\d,\\d{3}\\n.+$`),
      );
    }
    const v = await post([["response_format", "vtt"]]);
    expect(v.text.startsWith("WEBVTT\n")).toBe(true);
    expect(v.text).toMatch(/\d\d:\d\d:\d\d\.\d{3} --> \d\d:\d\d:\d\d\.\d{3}\n/);
  });

  test("stream=true answers Server-Sent Events that each match the stream event schema", async () => {
    for (const format of ["json", "diarized_json"]) {
      const r = await post([
        ["response_format", format],
        ["stream", "true"],
      ]);
      expect(r.type).toContain("text/event-stream");
      const events = r.text
        .split("\n\n")
        .filter((f) => f.startsWith("data: "))
        .map((f) => JSON.parse(f.slice(6)));
      expect(events.length).toBeGreaterThan(1);
      for (const e of events) {
        expect(check(OK["text/event-stream"].schema, e)).toEqual([]);
      }
      const last = events.at(-1);
      expect(last).toEqual({ type: "transcript.text.done", text: "hello world ok great" });
      const kinds = new Set(events.slice(0, -1).map((e) => e.type));
      expect([...kinds]).toEqual([
        format === "diarized_json" ? "transcript.text.segment" : "transcript.text.delta",
      ]);
      if (format === "json") {
        expect(
          events
            .slice(0, -1)
            .map((e) => e.delta)
            .join(""),
        ).toBe("hello world ok great");
      }
    }
  });
});

describe("SV-C1: the OpenAI endpoint is a thin door onto a job", () => {
  test("a model is a preset or an engine id, and any other name is auto", () => {
    expect(presetForModel("fast")).toBe("fast");
    expect(presetForModel(RECOGNIZER)).toBe("fast");
    expect(presetForModel("qwen3-asr-1.7b")).toBe("best");
    expect(presetForModel("whisper-1")).toBe("auto");
    expect(presetForModel(undefined)).toBe("auto");
  });

  test("a preset that is not built is refused with 409 preset_unavailable", async () => {
    const r = await post([["model", "best"]]);
    expect(r.status).toBe(409);
    expect(JSON.parse(r.text).error).toBe("preset_unavailable");
  });

  test("prompt and keywords[] both reach the hotwords", async () => {
    const speech = monoWav(concat(silence(0.4), speak(["hetzner", "kubernetes"]), silence(0.6)));
    const plain = await post([["response_format", "text"]], speech);
    expect(plain.text).toBe("hetzna kubernetis\n");
    const hinted = await post(
      [
        ["response_format", "text"],
        ["prompt", "Kubernetes, the cluster"],
        ["keywords[]", "Hetzner"],
      ],
      speech,
    );
    expect(hinted.text).toBe("Hetzner Kubernetes\n");
    expect(promptTerms("a, b;c\nd", ["k"])).toEqual(["k", "a", "b", "c", "d"]);
    expect(
      promptTerms(
        "x, y",
        Array.from({ length: 24 }, (_, i) => `k${i}`),
      ).length,
    ).toBe(24);
  });

  test("the job is gone once the answer is sent: akou keeps no copy", async () => {
    const r = await post([["response_format", "json"]]);
    expect(r.status).toBe(200);
    const jobs = await fetch(`http://127.0.0.1:${rig.port}/v1/jobs`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(((await jobs.json()) as { jobs: unknown[] }).jobs).toEqual([]);
  });

  test("no file is 422 with the one error shape", async () => {
    const r = await post([["model", "whisper-1"]], null);
    expect(r.status).toBe(422);
    expect(JSON.parse(r.text)).toMatchObject({ error: "missing_field", field: "file" });
  });

  test("srt and vtt cues from segments", () => {
    const segs = [
      { s: 0.5, e: 1.25, text: "hello", speaker: null },
      { s: 3661.001, e: 3662, text: "world", speaker: null },
    ];
    expect(srt(segs)).toBe(
      "1\n00:00:00,500 --> 00:00:01,250\nhello\n\n2\n01:01:01,001 --> 01:01:02,000\nworld\n",
    );
    expect(vtt(segs)).toBe(
      "WEBVTT\n\n00:00:00.500 --> 00:00:01.250\nhello\n\n01:01:01.001 --> 01:01:02.000\nworld\n",
    );
  });
});
