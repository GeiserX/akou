/**
 * Bazarr's whisper endpoints (docs/ux/SERVER.md SV-C3), the requests of its `whisperai` provider,
 * so Bazarr points its endpoint at `http://host:8476/v1` and needs no code on its side:
 *
 * - `POST /v1/asr?task=transcribe&language=&output=srt&encode=false`: one file part `audio_file`,
 *   raw 16 kHz mono s16le PCM with no header (`encode=false`) or any container (`encode=true`).
 *   The answer is the subtitle as text: SRT or WebVTT cues of at most 42 characters (SV-J5) at the
 *   audio's own times, or the plain text. `task=translate` gives the subtitle in English, from
 *   `language` (Canary or Whisper, as a job's `task=translate` chooses).
 * - `POST /v1/detect-language?encode=false`: the same part, the whole track; the first 30 s are
 *   transcribed under the `best` preset (Qwen names the language) and the answer is
 *   `{detected_language, language_code, confidence}`, as whisper-asr-webservice answers. With
 *   `encode=true` the whole file is decoded and transcribed; Bazarr never sends that.
 *
 * Bazarr sends no key, so both routes are open, and answer only while `server.bazarr` is on (a
 * file or environment setting); off, they answer 404 as a server without the dialect does. A key
 * sent as `Authorization: Bearer` is honoured, and the job runs under it. Each request is a quiet
 * file job deleted once the answer is sent, as on the OpenAI door, and a caller that hangs up
 * cancels its job. Bazarr reads only the body: a refusal of any kind becomes "Invalid subtitle"
 * there, so every refusal is also one line in akou's log.
 */

import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { QWEN_LANGUAGES, wavBytes } from "../../asr/qwen.ts";
import type { JobService } from "../../server/jobs.ts";
import type { ModelChoice } from "../../server/model-store.ts";
import type { Job, JobTask } from "../../server/store.ts";
import type { Identity } from "../access.ts";
import {
  HttpError,
  json,
  type QueryParam,
  type RouteDoc,
  type RoutedContext,
  type Router,
} from "../http.ts";
import type { SpooledFile } from "../multipart.ts";
import type { ApiApp } from "../server.ts";
import {
  chooseModel,
  fileField,
  formOf,
  jobsOf,
  LANGUAGE,
  queueFullError,
  requireQueueRoom,
  translateChoice,
} from "./jobs.ts";
import { renderResult } from "./openai.ts";

/** Who a request with no key acts as: one client, counted as one key by the queue's limits. */
export const BAZARR_IDENTITY: Identity = {
  id: "bazarr",
  name: "bazarr",
  scopes: ["jobs"],
  callbackHosts: [],
};

/** The one part Bazarr sends. */
const PART = "audio_file";

/**
 * The PCM bytes `/detect-language` transcribes: 30 s of 16 kHz 16-bit mono, as
 * whisper-asr-webservice reads (it detects on the first 30 s of the track Bazarr sends whole).
 */
export const DETECT_PCM_BYTES = 30 * 16000 * 2;

type Ctx = RoutedContext<ApiApp>;

function who(c: Ctx): Identity {
  return c.identity ?? BAZARR_IDENTITY;
}

/** 404 unless `server.bazarr` is on: the routes stay in the table, the dialect answers only then. */
function on(c: Ctx): void {
  if (c.app.config().settings["server.bazarr"] !== true) {
    throw new HttpError(404, "not_found", "server.bazarr is off");
  }
}

/**
 * Raw 16 kHz mono s16le PCM as a WAV the decoder reads without ffmpeg: a 44-byte header, then the
 * upload's bytes (at most `limitBytes`, whole samples), copied once and hashed on the way. The new
 * `<uuid>.upload` sits in `dir`, so a start after a crash deletes it when no job names it.
 */
export async function wavOf(
  file: SpooledFile,
  dir: string,
  limitBytes = Number.POSITIVE_INFINITY,
): Promise<{ path: string; sha256: string }> {
  const size = Math.min(file.size, limitBytes) - (Math.min(file.size, limitBytes) % 2);
  const head = wavBytes(new Float32Array(0));
  const v = new DataView(head.buffer);
  v.setUint32(4, 36 + size, true);
  v.setUint32(40, size, true);
  const path = join(dir, `${randomUUID()}.upload`);
  const hash = new Bun.CryptoHasher("sha256");
  const out = await open(path, "w");
  try {
    await out.write(head);
    hash.update(head);
    const src = await open(file.path, "r");
    try {
      const buf = Buffer.alloc(1 << 20);
      let at = 0;
      while (at < size) {
        const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, size - at), at);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        hash.update(chunk);
        await out.write(chunk);
        at += bytesRead;
      }
    } finally {
      await src.close();
    }
    await out.close();
  } catch (err) {
    await out.close().catch(() => {});
    await rm(path, { force: true });
    throw err;
  }
  return { path, sha256: hash.digest("hex") };
}

/**
 * The job, submitted, waited for and deleted, as the OpenAI door does: a caller that hangs up
 * cancels it, and the answer is the done job or the refusal its error names.
 */
async function runJob(
  c: Ctx,
  jobs: JobService,
  me: Identity,
  audio: { path: string; sha256: string },
  choice: ModelChoice,
  language: string,
  task: JobTask = "transcribe",
): Promise<Job> {
  let owned = false;
  try {
    const submitted = jobs.submit({
      key_id: me.id,
      preset: choice.preset,
      model: choice.model,
      model_source: choice.source,
      task,
      language,
      keywords: [],
      languages: [],
      diarize: false,
      callback_url: null,
      metadata: null,
      idempotency_key: null,
      interactive: false,
      // Bazarr has the answer in the response; the feed never hears of the job (SV-E1).
      quiet: true,
      file_sha256: audio.sha256,
      audio: audio.path,
    });
    if ("full" in submitted) throw queueFullError(submitted.full);
    if ("conflict" in submitted) throw new Error("a job with no idempotency key cannot conflict");
    // The job owns its file from here, and deletes it when it is removed below.
    owned = true;
    const id = submitted.job.id;
    c.timeout?.(0);
    const hangUp = () => jobs.remove(me, id);
    c.req.signal.addEventListener("abort", hangUp);
    try {
      let job = jobs.get(me, id);
      while (job && (job.status === "queued" || job.status === "running")) {
        await jobs.wait(me, id, 60_000, c.req.signal);
        if (c.req.signal.aborted) throw new HttpError(499, "cancelled", "the caller went away");
        job = jobs.get(me, id);
      }
      if (!job) throw new HttpError(409, "cancelled", "the job was deleted before it finished");
      if (job.status !== "done") {
        const e = job.error ?? { code: "transcription_failed", message: `the job ${job.status}` };
        const theirs = e.code === "decode_failed" || e.code === "too_long";
        throw new HttpError(theirs ? 422 : 500, e.code, e.message);
      }
      return job;
    } finally {
      c.req.signal.removeEventListener("abort", hangUp);
      jobs.remove(me, id);
    }
  } finally {
    if (!owned) await rm(audio.path, { force: true });
  }
}

/** The upload as the job's audio: raw PCM in a WAV (`encode=false`), or the container as sent. */
async function audioOf(
  c: Ctx,
  jobs: JobService,
  limitBytes?: number,
): Promise<{ path: string; sha256: string }> {
  const encode = c.query.oneOf<"true" | "false">("encode") === "true";
  const form = await formOf(c, jobs.uploadDir);
  let kept: SpooledFile | undefined;
  try {
    for (const k of form.keys()) {
      if (k !== PART)
        throw new HttpError(400, "unknown_field", `unknown field "${k}"`, { field: k });
    }
    const file = fileField(form, PART);
    if (encode) {
      kept = file;
      return { path: file.path, sha256: file.sha256 };
    }
    return await wavOf(file, jobs.uploadDir, limitBytes);
  } finally {
    await form.discard(kept);
  }
}

/** Runs a handler, logging any refusal: Bazarr reads only the body, so the log names the cause. */
function logged(route: string, handler: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx): Promise<Response> => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof HttpError) {
        c.app.jobs?.()?.log("warn", `bazarr: ${route} ${err.status} ${err.code}: ${err.message}`);
      }
      throw err;
    }
  };
}

async function asr(c: Ctx): Promise<Response> {
  on(c);
  const task = c.query.oneOf<JobTask>("task");
  const output = c.query.oneOf<"srt" | "vtt" | "txt">("output");
  const asked = c.query.raw("language")?.trim() ?? "";
  if (asked !== "" && !LANGUAGE.test(asked)) {
    throw new HttpError(422, "bad_field", "language is a BCP-47 tag, or auto", {
      field: "language",
    });
  }
  c.query.raw("video_file");
  const fallback = c.app.config().settings["server.default_language"];
  // An explicit `auto` stays for a translation, which Whisper then detects; a transcription takes
  // the server's language for it, as before.
  const language = asked === "" || (asked === "auto" && task !== "translate") ? fallback : asked;
  const jobs = jobsOf(c);
  const me = who(c);
  requireQueueRoom(jobs, me.id, null);
  // The server's default, as for any request that names no model (SV-S1); a translation runs the
  // engine that reads its language.
  const choice =
    task === "translate"
      ? translateChoice(jobs, undefined, language, { diarize: false })
      : chooseModel(jobs, {}, { diarize: false }, true);
  const audio = await audioOf(c, jobs);
  const job = await runJob(c, jobs, me, audio, choice, language, task);
  return renderResult(job, output === "txt" ? "text" : output);
}

async function detectLanguage(c: Ctx): Promise<Response> {
  on(c);
  c.query.raw("video_file");
  const jobs = jobsOf(c);
  const me = who(c);
  requireQueueRoom(jobs, me.id, null);
  // Only Qwen names the language it heard; there is no language-only pass.
  const choice = chooseModel(jobs, { preset: "best" }, { diarize: false });
  const audio = await audioOf(c, jobs, DETECT_PCM_BYTES);
  const job = await runJob(c, jobs, me, audio, choice, "auto");
  const code = ((job.result as Record<string, unknown>).language ?? null) as string | null;
  if (code === null) {
    return json(200, { detected_language: "unknown", language_code: "und", confidence: null });
  }
  return json(200, {
    detected_language: (QWEN_LANGUAGES[code] ?? code).toLowerCase(),
    language_code: code,
    confidence: null,
  });
}

const ENCODE: QueryParam = {
  type: "string",
  values: ["true", "false"],
  default: "true",
  doc: "`false`: the part is raw 16 kHz mono 16-bit PCM with no header, as Bazarr sends; `true`: an audio or video file.",
};
const VIDEO_FILE: QueryParam = {
  type: "string",
  doc: "The video's path on Bazarr's side, sent when its option to pass the video name is on. Read and ignored.",
};

const ERRORS: RouteDoc["errors"] = {
  400: ["bad_param", "unknown_field"],
  404: ["not_found"],
  409: ["cancelled", "preset_unavailable"],
  422: ["bad_field", "decode_failed", "missing_field", "too_long", "unsupported_language"],
  429: ["queue_full"],
  499: ["cancelled"],
  500: [
    "diarize_unavailable",
    "engine_unavailable",
    "interrupted",
    "model_download_failed",
    "models_missing",
    "remote_refused",
    "transcription_failed",
  ],
};

export function bazarrRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/asr",
    {
      id: "bazarr.asr",
      doc: "Bazarr's whisper transcription request: a file part `audio_file` in, a subtitle out as text. Bazarr sends `encode=false` and raw 16 kHz mono 16-bit PCM with no header; `encode=true` takes any audio or video file. `output` is srt (the default Bazarr asks for), vtt or txt; cues hold at most 42 characters and keep the audio's own times. The job runs `server.default_model` in `language`, else `server.default_language`. `task=translate` gives the subtitle in English: `canary-1b-v2` translates from the 25 languages it reads, `whisper-large-v3` from the rest and from `auto`, and a language neither reads answers 422 `unsupported_language`. Needs no key, and answers only while `server.bazarr` is on (404 otherwise); a key sent as a bearer token is honoured. A caller that hangs up cancels its job, and the job is deleted once the answer is sent.",
      access: "open",
      modes: ["server"],
      door: "compat",
      query: {
        task: {
          type: "string",
          values: ["transcribe", "translate"],
          default: "transcribe",
          doc: "`transcribe`: the subtitle in the language spoken; `translate`: in English.",
        },
        language: {
          type: "string",
          doc: "The spoken language as an ISO 639 code or BCP-47 tag, or `auto`; absent: `server.default_language`.",
        },
        output: {
          type: "string",
          values: ["srt", "vtt", "txt"],
          default: "txt",
          doc: "The subtitle format: SubRip, WebVTT, or the plain text.",
        },
        encode: ENCODE,
        video_file: VIDEO_FILE,
      },
      body: { multipart: { audio_file: "file" } },
      ok: 200,
      type: "text",
      errors: ERRORS,
    },
    logged("POST /v1/asr", asr),
  );
  r.add(
    "POST",
    "/detect-language",
    {
      id: "bazarr.detectLanguage",
      doc: "Bazarr's whisper language detection: a file part `audio_file` in (raw 16 kHz mono 16-bit PCM with `encode=false`, as Bazarr sends the whole track; any audio or video file with `encode=true`), `{detected_language, language_code, confidence}` out. The first 30 s of raw PCM are transcribed under the `best` preset, whose Qwen names the language; with `encode=true` the whole file is decoded and transcribed (Bazarr never sends that): `language_code` is its ISO code, `detected_language` its English name in lower case, `confidence` null; `und` and `unknown` when no language was heard. With `best` unavailable the refusal is akou's own JSON (409 `preset_unavailable`). Needs no key, and answers only while `server.bazarr` is on (404 otherwise).",
      access: "open",
      modes: ["server"],
      door: "compat",
      query: { encode: ENCODE, video_file: VIDEO_FILE },
      body: { multipart: { audio_file: "file" } },
      ok: 200,
      type: "json",
      reply: {
        type: "object",
        required: ["detected_language", "language_code", "confidence"],
        properties: {
          detected_language: { type: "string" },
          language_code: { type: "string" },
          confidence: { type: "null" },
        },
      },
      errors: ERRORS,
    },
    logged("POST /v1/detect-language", detectLanguage),
  );
}
