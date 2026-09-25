/**
 * The OpenAI transcription endpoint (docs/ux/SERVER.md SV-C1): `POST /v1/audio/transcriptions`,
 * multipart and synchronous, so Nextcloud, Home Assistant, whisper-subs and the `openai` client
 * libraries work with no code on their side. It is a thin translation onto a file job (SV-J1): the
 * upload runs through the same queue and the same final pass, the answer is rendered from the job's
 * result (SV-J4), and the job is deleted as soon as the answer is sent, since the caller holds the
 * only copy it asked for. A caller that hangs up cancels its job.
 *
 * - `model`: a preset name, or an engine id from the preset table; any other name (`whisper-1`)
 *   is `auto`.
 * - `prompt` and `keywords[]`: hotwords. The prompt is split at commas, semicolons and line ends,
 *   and its terms fill what is left of the 24 after the keywords.
 * - `response_format`: `json`, `text`, `srt`, `vtt`, `verbose_json`, `diarized_json` (which turns on
 *   speaker labels). `timestamp_granularities[]` picks `words` and `segments` in `verbose_json`.
 * - `stream=true`: Server-Sent Events, `transcript.text.delta` per segment (or
 *   `transcript.text.segment` for `diarized_json`), then `transcript.text.done`.
 * - Accepted and ignored: `temperature`, `chunking_strategy`, `include[]`, `languages[]`,
 *   `known_speaker_names[]` and `known_speaker_references[]` (until diarization names speakers).
 */

import type { JobSegment } from "../../asr/finalize-worker.ts";
import { PRESET_NAMES, PRESETS } from "../../server/presets.ts";
import type { Job } from "../../server/store.ts";
import { caller } from "../caller.ts";
import { HttpError, json, type RouteContext, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import {
  type Form,
  fileField,
  formOf,
  jobsOf,
  keywordsOf,
  languageOf,
  MAX_KEYWORDS,
  resolvePreset,
  textField,
} from "./jobs.ts";

export const RESPONSE_FORMATS = [
  "json",
  "text",
  "srt",
  "vtt",
  "verbose_json",
  "diarized_json",
] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

/** The request fields of the OpenAI operation; a list field also comes as `name[]`. */
const FIELDS = new Set([
  "file",
  "model",
  "language",
  "languages",
  "keywords",
  "prompt",
  "response_format",
  "temperature",
  "include",
  "timestamp_granularities",
  "stream",
  "chunking_strategy",
  "known_speaker_names",
  "known_speaker_references",
]);

function bad(field: string, message: string): HttpError {
  return new HttpError(422, "bad_field", message, { field });
}

/** Every value of a list field, sent as `name[]` or `name`. */
function list(form: Form, name: string): string[] {
  return [...form.getAll(`${name}[]`), ...form.getAll(name)].map((v) => {
    if (typeof v !== "string") throw bad(name, `"${name}" is text, not a file`);
    return v;
  });
}

/** The preset a `model` names: a preset, an engine of one, or `auto`. */
export function presetForModel(model: string | undefined): string {
  const m = (model ?? "").trim();
  if ((PRESET_NAMES as readonly string[]).includes(m)) return m;
  return PRESETS.find((p) => p.engines.includes(m))?.name ?? "auto";
}

/** The prompt's terms, after the keywords, up to the 24 the decoder takes. */
export function promptTerms(prompt: string | undefined, keywords: readonly string[]): string[] {
  const out = [...keywords];
  for (const raw of (prompt ?? "").split(/[,;\n]/)) {
    const t = raw.trim();
    if (out.length >= MAX_KEYWORDS) break;
    if (t !== "" && t.length <= 100 && !out.includes(t)) out.push(t);
  }
  return out;
}

function stamp(seconds: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
}

/** SubRip cues from the segments. */
export function srt(segments: readonly JobSegment[]): string {
  return segments
    .map((s, i) => `${i + 1}\n${stamp(s.s, ",")} --> ${stamp(s.e, ",")}\n${s.text}\n`)
    .join("\n");
}

/** WebVTT cues from the segments. */
export function vtt(segments: readonly JobSegment[]): string {
  return [
    "WEBVTT\n",
    ...segments.map((s) => `${stamp(s.s, ".")} --> ${stamp(s.e, ".")}\n${s.text}\n`),
  ].join("\n");
}

interface Rendered {
  segments: JobSegment[];
  text: string;
  language: string | null;
  duration: number;
}

function rendered(job: Job): Rendered {
  const r = job.result as Record<string, unknown>;
  return {
    segments: (r.segments ?? []) as JobSegment[],
    text: (r.text ?? "") as string,
    language: (r.language ?? null) as string | null,
    duration: (r.duration_s ?? 0) as number,
  };
}

const usage = (seconds: number) => ({ type: "duration", seconds });

/** The answer in the format asked for. */
export function renderOpenAI(
  r: Rendered,
  format: ResponseFormat,
  granularities: readonly string[],
): Response {
  const plain = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  switch (format) {
    case "text":
      return plain(`${r.text}\n`);
    case "srt":
      return plain(srt(r.segments));
    case "vtt":
      return plain(vtt(r.segments));
    case "verbose_json":
      return json(200, {
        language: r.language ?? "unknown",
        duration: r.duration,
        text: r.text,
        // No built engine gives word times yet: asked-for words are an empty list, never guesses.
        ...(granularities.includes("word") ? { words: [] } : {}),
        ...(granularities.includes("segment")
          ? {
              segments: r.segments.map((s, id) => ({
                id,
                seek: 0,
                start: s.s,
                end: s.e,
                text: s.text,
                // The engine reports no tokens or log probabilities; these are neutral values.
                tokens: [],
                temperature: 0,
                avg_logprob: 0,
                compression_ratio: 1,
                no_speech_prob: 0,
              })),
            }
          : {}),
        usage: usage(r.duration),
      });
    case "diarized_json":
      return json(200, {
        task: "transcribe",
        duration: r.duration,
        text: r.text,
        segments: r.segments.map((s, i) => diarizedSegment(s, i)),
        usage: usage(r.duration),
      });
    default:
      return json(200, { text: r.text, usage: usage(r.duration) });
  }
}

function diarizedSegment(s: JobSegment, i: number) {
  return {
    type: "transcript.text.segment",
    id: `seg_${i}`,
    start: s.s,
    end: s.e,
    text: s.text,
    speaker: s.speaker ?? "unknown",
  };
}

/** The result as Server-Sent Events: the segments, then the whole text. */
function streamOpenAI(r: Rendered, diarized: boolean): Response {
  const lines: string[] = [];
  const send = (o: unknown) => lines.push(`data: ${JSON.stringify(o)}\n\n`);
  r.segments.forEach((s, i) => {
    if (diarized) send(diarizedSegment(s, i));
    else
      send({
        type: "transcript.text.delta",
        delta: i === 0 ? s.text : ` ${s.text}`,
        segment_id: `seg_${i}`,
      });
  });
  send({ type: "transcript.text.done", text: r.text });
  return new Response(lines.join(""), {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

async function transcriptions(c: RouteContext<ApiApp>): Promise<Response> {
  const jobs = jobsOf(c);
  const who = caller(c);
  const form = await formOf(c);
  for (const k of form.keys()) {
    if (!FIELDS.has(k.replace(/\[\]$/, ""))) {
      throw new HttpError(400, "unknown_field", `unknown field "${k}"`, { field: k });
    }
  }
  const file = fileField(form);
  const format = (textField(form, "response_format")?.trim() || "json") as ResponseFormat;
  if (!RESPONSE_FORMATS.includes(format)) {
    throw bad("response_format", `response_format is one of ${RESPONSE_FORMATS.join(", ")}`);
  }
  const granularities = list(form, "timestamp_granularities");
  for (const g of granularities) {
    if (g !== "word" && g !== "segment") {
      throw bad("timestamp_granularities[]", "timestamp_granularities[] are word and segment");
    }
  }
  const stream = textField(form, "stream")?.trim().toLowerCase();
  if (stream !== undefined && !["", "true", "false"].includes(stream)) {
    throw bad("stream", "stream is true or false");
  }
  const temperature = textField(form, "temperature");
  if (temperature !== undefined && Number.isNaN(Number(temperature))) {
    throw bad("temperature", "temperature is a number");
  }
  const language = languageOf(form);
  const keywords = promptTerms(textField(form, "prompt"), keywordsOf(form));
  list(form, "include");
  list(form, "languages");
  list(form, "known_speaker_names");
  list(form, "known_speaker_references");
  textField(form, "chunking_strategy");
  const preset = resolvePreset(c.app, presetForModel(textField(form, "model")));
  const kept = await jobs.keepUpload(file);
  const submitted = jobs.submit({
    key_id: who.id,
    preset,
    language,
    keywords,
    diarize: format === "diarized_json",
    callback_url: null,
    metadata: null,
    idempotency_key: null,
    file_sha256: kept.sha256,
    audio: kept.path,
  });
  if ("conflict" in submitted) throw new Error("a job with no idempotency key cannot conflict");
  const id = submitted.job.id;
  // Synchronous: no idle cut while the queue and the pass run; a caller that hangs up cancels.
  c.timeout?.(0);
  const hangUp = () => jobs.remove(who, id);
  c.req.signal.addEventListener("abort", hangUp);
  try {
    let job = jobs.get(who, id);
    while (job && (job.status === "queued" || job.status === "running")) {
      await jobs.wait(who, id, 60_000, c.req.signal);
      if (c.req.signal.aborted) throw new HttpError(499, "cancelled", "the caller went away");
      job = jobs.get(who, id);
    }
    if (!job) throw new HttpError(409, "cancelled", "the job was deleted before it finished");
    if (job.status !== "done") {
      const e = job.error ?? { code: "transcription_failed", message: `the job ${job.status}` };
      throw new HttpError(e.code === "decode_failed" ? 422 : 500, e.code, e.message);
    }
    const r = rendered(job);
    return stream === "true" && format !== "text" && format !== "srt" && format !== "vtt"
      ? streamOpenAI(r, format === "diarized_json")
      : renderOpenAI(r, format, granularities.length ? granularities : ["segment"]);
  } finally {
    c.req.signal.removeEventListener("abort", hangUp);
    // The caller has the only copy it asked for; akou keeps none (SV-J6).
    jobs.remove(who, id);
  }
}

export function openaiRoutes(r: Router<ApiApp>): void {
  r.add("POST", "/audio/transcriptions", transcriptions, { access: "jobs", upload: true });
}
