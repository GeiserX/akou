/**
 * The OpenAI transcription endpoint (docs/ux/SERVER.md SV-C1): `POST /v1/audio/transcriptions`,
 * multipart and synchronous, so Nextcloud, Home Assistant, whisper-subs and the `openai` client
 * libraries work with no code on their side. It is a thin translation onto a file job (SV-J1): the
 * upload runs through the same queue and the same final pass, the answer is rendered from the job's
 * result (SV-J4), and the job is deleted as soon as the answer is sent, since the caller holds the
 * only copy it asked for. A caller that hangs up cancels its job.
 *
 * - `model`: a preset name, or a recognizer id from the model catalog, over `server.default_model`
 *   as on `POST /v1/jobs` (SV-S1); any other name (`whisper-1`) is no opinion, so the server's
 *   default decides.
 * - `prompt` and `keywords[]`: hotwords. The prompt is split at commas, semicolons and line ends,
 *   and its terms fill what is left of the 24 after the keywords.
 * - `response_format`: `json`, `text`, `srt`, `vtt`, `verbose_json`, `diarized_json` (which turns on
 *   speaker labels). `timestamp_granularities[]` picks `words` and `segments` in `verbose_json`.
 * - `interactive=true` (DICTATION.md DC-R2): a dictation, run in the reserved lane of
 *   `server.dictation_slots` Workers in arrival order and never refused by the queue's limits; with
 *   no model named it runs `server.dictation_engine`. Ignored when the server has no dictation slots.
 *   A dictation may stream its body during the hold (DC-R6): chunked, with a WAV whose length says
 *   "to the end"; nothing is decoded until the body ends, as for any other upload.
 * - `metadata` (JSON, as on `POST /v1/jobs`): the OpenAI request has no name field, so a string
 *   `metadata.title` names the job while it runs, on the Jobs page and in `GET /v1/jobs` (SV-J10).
 * - `stream=true`: Server-Sent Events, `transcript.text.delta` per segment (or
 *   `transcript.text.segment` for `diarized_json`), then `transcript.text.done`.
 * - `languages[]`, as on `POST /v1/jobs`: the codes an `auto` language may come out as.
 * - Accepted and ignored: `temperature`, `chunking_strategy`, `include[]`,
 *   `known_speaker_names[]` and `known_speaker_references[]` (until diarization names speakers).
 */

import type { JobSegment, JobWord } from "../../asr/finalize-worker.ts";
import type { Job } from "../../server/store.ts";
import { caller } from "../caller.ts";
import { HttpError, json, type RouteContext, type Router } from "../http.ts";
import type { SpooledFile } from "../multipart.ts";
import type { ApiApp } from "../server.ts";
import { checkTitle } from "./calls.ts";
import {
  chooseModel,
  type Form,
  fileField,
  formOf,
  interactiveOf,
  jobsOf,
  keywordsOf,
  laneAsk,
  languageOf,
  languagesOf,
  MAX_KEYWORDS,
  metadataOf,
  queueFullError,
  requireRoomUnlessLane,
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
  "interactive",
  "metadata",
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

/** A subtitle line holds at most this many characters (SV-J5). */
export const CUE_CHARS = 42;

/**
 * Subtitle cues from timed words (SV-J5): words join a cue while it stays within `CUE_CHARS` and
 * inside one segment, so a cue never runs across a pause or a change of speaker. Null when a word
 * has no time (an engine that gives none, such as Qwen): the segments are the cues then.
 */
export function wordCues(
  words: readonly JobWord[],
  segments: readonly JobSegment[],
): JobSegment[] | null {
  if (words.length === 0 || words.some((w) => w.s === null || w.e === null)) return null;
  const out: JobSegment[] = [];
  let cue: JobSegment | null = null;
  let seg = 0;
  let cueSeg = -1;
  for (const w of words) {
    const s = w.s as number;
    // The segment the word starts in: the words and the segments are both in time order.
    while (seg < segments.length - 1 && s >= (segments[seg] as JobSegment).e) seg++;
    if (cue && (seg !== cueSeg || cue.text.length + 1 + w.w.length > CUE_CHARS)) {
      out.push(cue);
      cue = null;
    }
    if (cue) {
      cue.text += ` ${w.w}`;
      cue.e = w.e as number;
    } else {
      cue = { s, e: w.e as number, text: w.w, speaker: segments[seg]?.speaker ?? null };
      cueSeg = seg;
    }
  }
  if (cue) out.push(cue);
  return out;
}

/** The formats of a job's result (SV-J5). */
export const RESULT_FORMATS = ["json", "verbose_json", "text", "srt", "vtt"] as const;
export type ResultFormat = (typeof RESULT_FORMATS)[number];

/**
 * A done job's result in a format of SV-J5: `json` is the result as stored; `verbose_json` the
 * OpenAI shape of SV-C1 with its segments; `srt` and `vtt` cues from the timed words, else from
 * the segments; `text` the text.
 */
export function renderResult(job: Job, format: ResultFormat): Response {
  if (format === "json") return json(200, job.result);
  const r = rendered(job);
  if (format === "srt" || format === "vtt") {
    const words = ((job.result as Record<string, unknown>).words ?? []) as JobWord[];
    const cues = wordCues(words, r.segments) ?? r.segments;
    return renderOpenAI({ ...r, segments: cues }, format, []);
  }
  return renderOpenAI(r, format, ["segment"]);
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
        // This door does not carry the engine's words yet (akou-5an.84): asked-for words are an
        // empty list, never guesses.
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

/** The job's name from `metadata.title`, when that is a string that is not blank. */
function titleIn(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const t = (metadata as { title?: unknown }).title;
  return typeof t === "string" && t.trim() !== "" ? checkTitle(t) : null;
}

/** Does `model` name a preset or recognizer this server knows (not `whisper-1` or empty)? */
function namesModel(jobs: ReturnType<typeof jobsOf>, model: string | undefined): boolean {
  if ((model ?? "").trim() === "") return false;
  try {
    return jobs.choose({ model }, true).source === "request";
  } catch {
    // A known name that cannot run: chooseModel refuses it with the reason.
    return true;
  }
}

async function transcriptions(c: RouteContext<ApiApp>): Promise<Response> {
  const jobs = jobsOf(c);
  const who = caller(c);
  requireRoomUnlessLane(jobs, who.id, null);
  const form = await formOf(c, jobs.uploadDir);
  // Every file but the job's is deleted, and the job's too when the request is refused first.
  let kept: SpooledFile | undefined;
  try {
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
    const language = languageOf(form, c.app.config().settings["server.default_language"]);
    const keywords = promptTerms(textField(form, "prompt"), keywordsOf(form));
    list(form, "include");
    const languages = languagesOf(form);
    list(form, "known_speaker_names");
    list(form, "known_speaker_references");
    textField(form, "chunking_strategy");
    const interactive = interactiveOf(jobs, form);
    const metadata = metadataOf(form);
    const asked = { model: textField(form, "model") };
    // `whisper-1` and other unknown names are no opinion here, so the lane's engine decides.
    const choice = chooseModel(
      jobs,
      interactive && !namesModel(jobs, asked.model) ? laneAsk(jobs, {}) : asked,
      true,
    );
    const submitted = jobs.submit({
      key_id: who.id,
      preset: choice.preset,
      model: choice.model,
      model_source: choice.source,
      language,
      keywords,
      languages,
      diarize: format === "diarized_json",
      callback_url: null,
      metadata,
      title: titleIn(metadata),
      idempotency_key: null,
      interactive,
      // The caller has the answer in the response; the feed never hears of the job (SV-E1).
      quiet: true,
      file_sha256: file.sha256,
      audio: file.path,
    });
    // The job owns its file from here, and deletes it when it is removed below.
    kept = file;
    if ("full" in submitted) throw queueFullError(submitted.full);
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
        // The caller's file is at fault for these two; anything else is the server's.
        const theirs = e.code === "decode_failed" || e.code === "too_long";
        throw new HttpError(theirs ? 422 : 500, e.code, e.message);
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
  } finally {
    await form.discard(kept);
  }
}

export function openaiRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/audio/transcriptions",
    {
      id: "openai.transcribe",
      doc: "The OpenAI transcription endpoint: a file in, its transcript out, in one request. `model` names a preset or a recognizer id (anything else leaves it to `server.default_model`); `response_format` is json, text, srt, vtt, verbose_json or diarized_json, whose segments carry `speaker` `s0`, `s1`, … (one per speaker found in this file) or `unknown` when the speaker model found no turns or failed; `stream=true` sends Server-Sent Events. `interactive=true` (a dictation) runs in the reserved lane of `server.dictation_slots` Workers, in arrival order, never refused by the queue's limits, running `server.dictation_engine` when no model is named; with no dictation slots the field is ignored. `metadata` (JSON, up to 4 KB) is kept on the job while it runs, and a string `metadata.title` names it in `GET /v1/jobs` and on the Jobs page. `languages[]` bounds an `auto` language as on `POST /v1/jobs`; a code no engine here can choose answers 422 `unsupported_language`. The body may arrive chunked while the audio is still being recorded (a dictation streamed during the hold); a 16 kHz 16-bit PCM WAV whose data size is 0 or 0xFFFFFFFF is read to the end of the file, and the transcript starts once the body ends.",
      access: "jobs",
      modes: ["server"],
      door: "compat",
      body: {
        multipart: {
          file: "file",
          "model?": "string",
          "language?": "string",
          "prompt?": "string",
          "keywords[]?": "string[]",
          "response_format?": "string",
          "timestamp_granularities[]?": "string[]",
          "stream?": "boolean",
          "temperature?": "number",
          "interactive?": "boolean",
          "metadata?": "string",
        },
      },
      ok: 200,
      errors: {
        400: ["unknown_field"],
        404: ["not_found"],
        409: ["cancelled", "preset_unavailable"],
        422: ["bad_field", "decode_failed", "missing_field", "too_long", "unsupported_language"],
        429: ["queue_full"],
        499: ["cancelled"],
        500: [
          "diarize_unavailable",
          "interrupted",
          "model_download_failed",
          "models_missing",
          "remote_refused",
          "transcription_failed",
        ],
      },
    },
    transcriptions,
  );
}
