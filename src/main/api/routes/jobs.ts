/**
 * The job routes of server mode (docs/ux/SERVER.md sections 5 and 6). Any key reaches them and
 * sees its own jobs and events only; an admin sees every key's.
 *
 * - `POST /v1/jobs`, multipart (SV-J1, SV-J2): `file`, `title`, `preset`, `model`, `language`,
 *   `keywords[]`, `diarize`, `callback_url`, `metadata`, `priority`, and the `Idempotency-Key`
 *   header. 202 with the new job, 200 with the existing one for a repeated key, file and options,
 *   422 `idempotency_conflict` for the same key with another file or options, 429 `queue_full`
 *   with `Retry-After` past a queue limit (SV-Q3), answered before the upload is read. The model is the request's, else `server.default_model`, else the hardware's
 *   (SV-S1); a missing one is downloaded while the job waits (SV-M1).
 * - `GET /v1/jobs/{id}?wait=0..60` (SV-J3): the job, after holding the request until it ends.
 * - `GET /v1/jobs?status=&q=&cursor=&limit=`: the key's jobs, newest first; `q` finds them by
 *   title, id or state (SV-J10).
 * - `PATCH /v1/jobs/{id}` `{title}` (SV-J10): names or renames a job, in any state.
 * - `GET /v1/jobs/{id}/result` (SV-J4): the result of a done job.
 * - `DELETE /v1/jobs/{id}` (SV-J6).
 * - `GET /v1/events?after=&limit=&wait=0..60` (SV-E1): the key's outcomes after the cursor, oldest
 *   first, as JSON `{events, cursor, has_more}`, or as Server-Sent Events with `Accept: text/event-stream`, resumable with
 *   `Last-Event-ID`.
 */

import { eventView, type JobService, type QueueFull } from "../../server/jobs.ts";
import { type ModelChoice, ModelRefused } from "../../server/model-store.ts";
import { PRESET_NAMES } from "../../server/presets.ts";
import { FORWARDED_HEADER } from "../../server/remotes.ts";
import { JOB_STATES, type JobRequest, type JobStatus, type NewJob } from "../../server/store.ts";
import { CallbackRefused, checkCallbackUrl } from "../../server/webhooks.ts";
import type { Identity } from "../access.ts";
import { caller, requireCallbackAllowed } from "../caller.ts";
import {
  HttpError,
  json,
  type RouteContext,
  type RouteDoc,
  type RoutedContext,
  type Router,
} from "../http.ts";
import { readMultipart, type SpooledFile, type StreamedForm } from "../multipart.ts";
import type { ApiApp } from "../server.ts";
import { checkTitle } from "./calls.ts";
import { KEEPALIVE_MS, lastEventId } from "./follow.ts";

export const MAX_WAIT_SECONDS = 60;
export const MAX_KEYWORDS = 24;
export const MAX_METADATA_BYTES = 4096;
/** A job's `priority` runs from -10 to 10, default 0 (SV-Q2). */
export const MAX_PRIORITY = 10;
const LANGUAGE = /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;
const IDEMPOTENCY = /^[\x21-\x7e]{1,255}$/;

/** A multipart body, its file parts already on disk (SV-D3). */
export type Form = StreamedForm;

/**
 * A full queue (SV-Q3): 429 `queue_full`, with `Retry-After` in seconds, the same number in the
 * body. 429, not 503: a client reads it as "come back later", never as a failure of the file.
 */
export function queueFullError(full: QueueFull): HttpError {
  return new HttpError(
    429,
    "queue_full",
    full.limit === "server.queue_max"
      ? `the queue holds ${full.depth} jobs, its limit (server.queue_max); retry after ${full.retry_after_s} s`
      : `this key has ${full.depth} jobs queued or running, its limit (server.queue_max_per_key); retry after ${full.retry_after_s} s`,
    { ...full },
    { "retry-after": String(full.retry_after_s) },
  );
}

/** Refuses a submit before its upload is read, when the queue has no room for it (SV-Q3). */
export function requireQueueRoom(jobs: JobService, key: string, idem: string | null): void {
  const full = jobs.queueFull(key, idem);
  if (full) throw queueFullError(full);
}

/** The job service, or 404 where there is none (the desktop app). */
export function jobsOf(c: RouteContext<ApiApp>): JobService {
  const j = c.app.jobs?.();
  if (!j) throw new HttpError(404, "not_found", "jobs exist in server mode only");
  return j;
}

/**
 * The answer for a job id the caller cannot read: 410 `gone` naming the retain window when the
 * caller once had the job and it was deleted or expired, so a driver resubmits on purpose; 404
 * for an id the server never held for this key, so a typo is never read as an expiry.
 */
export function noJob(jobs: JobService, who: Identity, id: string): HttpError {
  if (jobs.gone(who, id)) {
    const days = jobs.retainDays();
    return new HttpError(
      410,
      "gone",
      `job ${id} is gone: it was deleted, or it passed the ${days} days akou keeps a job from its creation (server.retain_days)`,
      { id, retain_days: days },
    );
  }
  return new HttpError(404, "not_found", `no job ${id}`);
}

function bad(field: string, message: string): HttpError {
  return new HttpError(422, "bad_field", message, { field });
}

/**
 * The model a job runs (SV-S1), and whether it can be had: on disk, downloading, or allowed to
 * start (SV-M1, SV-M2). An unknown name is 422 `unknown_model`; an unbuilt preset, a download over
 * a limit, or a missing model with `server.auto_download` off is 409 `preset_unavailable`.
 */
export function chooseModel(
  jobs: JobService,
  ask: { model?: string; preset?: string },
  unknownIsAuto = false,
): ModelChoice {
  try {
    const choice = jobs.choose(ask, unknownIsAuto);
    jobs.admit(choice.model);
    return choice;
  } catch (err) {
    if (err instanceof ModelRefused) {
      throw new HttpError(err.status, err.code, err.message, err.details);
    }
    throw err;
  }
}

/**
 * The multipart body, its files written into `dir` as they arrive (SV-D3), or 400 when it is not
 * one. The caller deletes the files it does not keep with `form.discard`.
 */
export async function formOf(c: RouteContext<ApiApp>, dir: string): Promise<Form> {
  // An upload can take a while to arrive: no idle cut while it does.
  c.timeout?.(0);
  return readMultipart(c.req.body, c.req.headers.get("content-type"), dir);
}

/** One text field, or undefined; a file where text is expected is refused. */
export function textField(form: Form, name: string): string | undefined {
  const v = form.getAll(name);
  if (v.length === 0) return undefined;
  if (v.length > 1) throw bad(name, `"${name}" is given more than once`);
  const x = v[0];
  if (typeof x !== "string") throw bad(name, `"${name}" must be text, not a file`);
  return x;
}

export function fileField(form: Form): SpooledFile {
  const files = form.getAll("file");
  const f = files[0];
  if (files.length !== 1 || typeof f === "string" || !f) {
    throw new HttpError(422, "missing_field", '"file" is required: the audio, as a file part', {
      field: "file",
    });
  }
  return f;
}

export function keywordsOf(form: Form, extra: string[] = []): string[] {
  const raw = [...form.getAll("keywords[]"), ...form.getAll("keywords"), ...extra];
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== "string") throw bad("keywords[]", "keywords are text");
    const t = k.trim();
    if (t === "") continue;
    if (t.length > 100) throw bad("keywords[]", "a keyword is at most 100 characters");
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_KEYWORDS) throw bad("keywords[]", `at most ${MAX_KEYWORDS} keywords`);
  return out;
}

/**
 * The request's language; `auto` or none means no opinion, and `fallback` decides
 * (`server.default_language`, SV-S2).
 */
export function languageOf(form: Form, fallback = "auto"): string {
  const l = textField(form, "language")?.trim() || "auto";
  if (!LANGUAGE.test(l)) throw bad("language", "language is a BCP-47 tag, or auto");
  return l === "auto" ? fallback : l;
}

/** A true or false field, or null when absent (or empty), so an explicit `false` stays false. */
export function booleanOf(form: Form, name: string): boolean | null {
  const v = textField(form, name)?.trim().toLowerCase();
  if (v === undefined || v === "") return null;
  if (v === "false" || v === "0") return false;
  if (v === "true" || v === "1") return true;
  throw bad(name, `"${name}" is true or false`);
}

/**
 * Refuses a submit before its upload is read when the queue has no room (SV-Q3), on a server with
 * no dictation lane. With one, an `interactive` field in the body may take the lane (DC-R2), so the
 * refusal waits for the body: `JobService.submit` makes the same check in its transaction.
 */
export function requireRoomUnlessLane(jobs: JobService, key: string, idem: string | null): void {
  if (!jobs.interactive(true)) requireQueueRoom(jobs, key, idem);
}

/** Whether the form asks for the dictation lane and gets it: false with no dictation slots. */
export function interactiveOf(jobs: JobService, form: Form): boolean {
  return jobs.interactive(booleanOf(form, "interactive") === true);
}

/**
 * The model an interactive job asks for (DC-R2): the request's, else `server.dictation_engine`
 * where the request named no preset either.
 */
export function laneAsk(
  jobs: JobService,
  ask: { model?: string; preset?: string },
): { model?: string; preset?: string } {
  const named = (v: string | undefined) => (v ?? "").trim() !== "" && v?.trim() !== "auto";
  if (named(ask.model) || named(ask.preset)) return ask;
  return { ...ask, preset: jobs.dictationEngine() };
}

/** `priority`, an integer from -10 to 10; absent or empty, 0. */
function priorityOf(form: Form): number {
  const v = textField(form, "priority")?.trim();
  if (v === undefined || v === "") return 0;
  const n = Number(v);
  if (!/^-?\d+$/.test(v) || Math.abs(n) > MAX_PRIORITY) {
    throw bad("priority", `priority is a whole number from -${MAX_PRIORITY} to ${MAX_PRIORITY}`);
  }
  return n;
}

const JOB_FIELDS = new Set([
  "file",
  "title",
  "priority",
  "preset",
  "model",
  "language",
  "keywords[]",
  "keywords",
  "diarize",
  "callback_url",
  "metadata",
  "interactive",
]);

/** A callback the caller may name (SV-K4), at an address the rules allow (SV-E7), and can sign. */
function callbackOf(app: ApiApp, who: Identity, url: string | undefined): string | null {
  if (url === undefined || url.trim() === "") return null;
  const u = url.trim();
  requireCallbackAllowed(who, u);
  try {
    checkCallbackUrl(u);
  } catch (err) {
    if (err instanceof CallbackRefused) {
      throw new HttpError(422, "callback_not_allowed", err.message, { callback_url: u });
    }
    throw err;
  }
  if ((app.keys?.()?.secretOf(who.id) ?? null) === null) {
    throw new HttpError(
      422,
      "callback_not_allowed",
      "only an akou key has a webhook secret to sign a callback with",
      {
        callback_url: u,
      },
    );
  }
  return u;
}

/** The `title` field: one line, trimmed; absent or blank, the job has none (SV-J10). */
function titleOf(form: Form): string | null {
  const t = textField(form, "title");
  return t === undefined || t.trim() === "" ? null : checkTitle(t);
}

export function metadataOf(form: Form): unknown {
  const m = textField(form, "metadata");
  if (m === undefined) return null;
  if (Buffer.byteLength(m) > MAX_METADATA_BYTES) {
    throw bad("metadata", `metadata is at most ${MAX_METADATA_BYTES} bytes of JSON`);
  }
  try {
    return JSON.parse(m);
  } catch {
    throw bad("metadata", "metadata is JSON");
  }
}

async function submit(c: RouteContext<ApiApp>): Promise<Response> {
  const jobs = jobsOf(c);
  const who = caller(c);
  const idem = c.req.headers.get("idempotency-key");
  if (idem !== null && !IDEMPOTENCY.test(idem)) {
    throw new HttpError(400, "bad_header", "Idempotency-Key is 1 to 255 printable characters");
  }
  // A full queue answers before the upload is read: a client pacing itself sends no bytes twice.
  // With a dictation lane, only after it, since the body says whether the lane takes it (DC-R2).
  requireRoomUnlessLane(jobs, who.id, idem);
  const form = await formOf(c, jobs.uploadDir);
  // The job owns its file once submitted; every other file, and this one on a refusal, is deleted.
  let kept: SpooledFile | undefined;
  try {
    for (const k of form.keys()) {
      if (!JOB_FIELDS.has(k))
        throw new HttpError(400, "unknown_field", `unknown field "${k}"`, { field: k });
    }
    const file = fileField(form);
    const presetName = textField(form, "preset")?.trim() || "auto";
    if (!(PRESET_NAMES as readonly string[]).includes(presetName)) {
      throw bad("preset", `preset is one of ${PRESET_NAMES.join(", ")}`);
    }
    const settings = c.app.config().settings;
    const model = textField(form, "model");
    const interactive = interactiveOf(jobs, form);
    const diarize = booleanOf(form, "diarize");
    const keywords = keywordsOf(form);
    // The options as sent, before a server default fills a gap: what a repeated Idempotency-Key is
    // compared against (SV-J2), so a retry still matches after a default changes.
    const request: JobRequest = {
      preset: presetName,
      model: model?.trim() || null,
      language: textField(form, "language")?.trim() || "auto",
      keywords,
      diarize,
    };
    const job: Omit<NewJob, "file_sha256" | "audio"> = {
      key_id: who.id,
      // A name only: not compared on a repeated Idempotency-Key, like `metadata`.
      title: titleOf(form),
      preset: presetName,
      model: null,
      model_source: null,
      priority: priorityOf(form),
      // A request with no opinion gets the server's defaults (SV-S2).
      language: languageOf(form, settings["server.default_language"]),
      keywords,
      diarize: diarize ?? settings["server.default_diarize"],
      callback_url: callbackOf(c.app, who, textField(form, "callback_url")),
      metadata: metadataOf(form),
      idempotency_key: idem,
      request,
      interactive,
    };
    // Checked after the fields and before the upload is kept: a job that could never run is refused.
    // One this server cannot run goes to a remote that offers it (section 14), unless a remote sent
    // it here: a forwarded job is never forwarded again.
    const ask = interactive
      ? laneAsk(jobs, { model, preset: presetName })
      : { model, preset: presetName };
    const forwarded = c.req.headers.get(FORWARDED_HEADER) !== null;
    try {
      const choice = chooseModel(jobs, ask);
      job.preset = choice.preset;
      job.model = choice.model;
      job.model_source = choice.source;
      job.route = forwarded ? "local" : null;
    } catch (err) {
      // A dictation runs here or not at all: the lane never forwards (DC-R2).
      const remote =
        !forwarded &&
        !interactive &&
        err instanceof HttpError &&
        (err.status === 409 || err.status === 422)
          ? jobs.remoteChoice(ask)
          : null;
      if (!remote) throw err;
      job.preset = remote.preset;
      job.model = remote.model;
      job.model_source = remote.source;
      job.route = "remote";
    }
    const r = jobs.submit({ ...job, file_sha256: file.sha256, audio: file.path });
    // A repeated submit's file is deleted by `submit` itself.
    kept = file;
    return answerSubmit(jobs, r);
  } finally {
    await form.discard(kept);
  }
}

function answerSubmit(jobs: JobService, r: ReturnType<JobService["submit"]>): Response {
  if ("full" in r) throw queueFullError(r.full);
  if ("conflict" in r) {
    throw new HttpError(
      422,
      "idempotency_conflict",
      `this Idempotency-Key was used for a request with another ${r.fields.join(", ")}; send it again unchanged, or use a new key`,
      { id: r.conflict.id, fields: r.fields },
    );
  }
  return json(r.existing ? 200 : 202, jobs.view(r.job));
}

/** `wait`, as the job and event routes declare it. */
const WAIT = {
  type: "integer",
  min: 0,
  max: MAX_WAIT_SECONDS,
  default: 0,
  doc: "Seconds to hold the request until the job ends (or an event arrives), up to 60.",
} as const;

const JOB_ID = "The job id.";

function waitParam(c: RoutedContext<ApiApp>): number {
  const wait = c.query.int("wait") as number;
  if (wait > 0) c.timeout?.(wait + 15);
  return wait;
}

/** Every job route: any key, server mode only (the desktop app has no job queue). */
const JOB_ROUTE = { access: "jobs", modes: ["server"] } as const satisfies Partial<RouteDoc>;

export function jobRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/jobs",
    {
      id: "jobs.create",
      doc: "Submit an audio file for transcription; answers at once with the queued job. `title` (optional, one line up to 200 characters) names the job in the lists and their search; `PATCH /v1/jobs/{id}` names it later. `model` (a preset or a recognizer id) overrides `preset`, which overrides `server.default_model`; a model not on disk is downloaded while the job waits (`waiting_for`). An `Idempotency-Key` header makes a retried submit of the same file and options (keywords in any order, `language` in any case) return the first job (200); the same key with another file, `preset`, `model`, `language`, `keywords[]` or `diarize` answers 422 `idempotency_conflict` with the job's `id` and the differing `fields`. `title`, `metadata`, `callback_url` and `priority` are not compared: a retry gets the first job with its own. `metadata` (JSON, up to 4 KB) comes back on the job; `callback_url` gets a signed webhook when it ends. `priority` (-10 to 10, default 0): a higher one runs first, then submit order. A full queue (`server.queue_max`, `server.queue_max_per_key`) answers 429 `queue_full` with `Retry-After` in seconds. `interactive=true` (a dictation) runs in the reserved lane of `server.dictation_slots` Workers, in arrival order, never refused by the queue's limits and never sent to a remote; with no dictation slots the field is ignored (`GET /v1/server` `capabilities.interactive` says which).",
      ...JOB_ROUTE,
      body: {
        multipart: {
          file: "file",
          "title?": "string",
          "preset?": "string",
          "model?": "string",
          "language?": "string",
          "keywords[]?": "string[]",
          "diarize?": "boolean",
          "callback_url?": "string",
          "metadata?": "string",
          "priority?": "integer",
          "interactive?": "boolean",
        },
      },
      ok: 202,
    },
    submit,
  );

  r.add(
    "GET",
    "/jobs",
    {
      id: "jobs.list",
      doc: "The key's jobs, newest first (an admin key sees every key's, or one key's with `key`). `status` keeps one state; `q` keeps the jobs whose title, id or state contains it, in any case; `cursor` pages on from the last job's `seq`.",
      ...JOB_ROUTE,
      query: {
        status: { type: "string", values: JOB_STATES, doc: "Only jobs in this state." },
        q: {
          type: "string",
          doc: "Only jobs whose title, id or state contains this text, in any case.",
        },
        key: {
          type: "string",
          doc: "Only the jobs of this key id. A key that is not admin sees its own jobs only.",
        },
        cursor: {
          type: "integer",
          min: 1,
          max: Number.MAX_SAFE_INTEGER,
          doc: "The `cursor` of the page before: jobs older than it.",
        },
        limit: { type: "integer", min: 1, max: 200, default: 50, doc: "Jobs per page." },
      },
      ok: 200,
    },
    (c) => {
      const jobs = jobsOf(c);
      const status = c.query.raw("status") || undefined;
      if (status !== undefined && !(JOB_STATES as readonly string[]).includes(status)) {
        throw new HttpError(400, "bad_param", `status is one of ${JOB_STATES.join(", ")}`, {
          param: "status",
        });
      }
      const before = c.query.int("cursor");
      const limit = c.query.int("limit") as number;
      const key = c.query.raw("key") || undefined;
      const list = jobs.list(caller(c), {
        key,
        status: status as JobStatus | undefined,
        q: c.query.raw("q") || undefined,
        before,
        limit,
      });
      return json(200, {
        jobs: list.map((j) => jobs.view(j)),
        cursor: list.length === limit ? (list.at(-1)?.seq ?? null) : null,
      });
    },
  );

  r.add(
    "GET",
    "/jobs/:id",
    {
      id: "jobs.get",
      doc: "One job and its state. `wait` holds the request until the job ends, up to 60 s. A job running here answers `progress`: `stage` (`decode`, `diarize` or `transcribe`), `done_s` (seconds of the file transcribed so far) and `total_s`; a done one answers `timings`, the wall seconds of each stage. akou keeps a job, its result and its events for `server.retain_days` (`retain_days` in `GET /v1/server`, default 7) from its creation; after that, or after a delete, the job's id answers 410 `gone` with `retain_days` in the body, and an id the server never held for this key answers 404.",
      ...JOB_ROUTE,
      params: { id: JOB_ID },
      query: { wait: WAIT },
      ok: 200,
    },
    async (c) => {
      const jobs = jobsOf(c);
      const wait = waitParam(c);
      const j = await jobs.wait(caller(c), c.params.id as string, wait * 1000, c.req.signal);
      if (!j) throw noJob(jobsOf(c), caller(c), c.params.id as string);
      // A job deleted while the request waited answers its final state, once.
      return json(200, "seq" in j ? jobs.view(j) : { id: j.id, status: j.status });
    },
  );

  r.add(
    "PATCH",
    "/jobs/:id",
    {
      id: "jobs.rename",
      doc: "Name or rename a job, in any state: `title` is what the lists, their search and the Jobs page show from now on. The result, the event feed and a webhook do not carry it. An empty title answers 422 and the old name stays.",
      ...JOB_ROUTE,
      params: { id: JOB_ID },
      body: { title: "string" },
      ok: 200,
    },
    async (c) => {
      const jobs = jobsOf(c);
      const b = await c.body<{ title: string }>();
      const title = checkTitle(b.title);
      const j = jobs.rename(caller(c), c.params.id as string, title);
      if (!j) throw noJob(jobsOf(c), caller(c), c.params.id as string);
      return json(200, jobs.view(j));
    },
  );

  r.add(
    "GET",
    "/jobs/:id/result",
    {
      id: "jobs.result",
      doc: "The transcript of a done job: text, segments with speakers and times, and the engines that made it. A segment's `speaker` is `s0`, `s1`, … when the job asked for `diarize`, one per speaker found in this file (the numbers name speakers within one job only), the nearest turn's speaker for a segment outside every turn, never `s?`; null without `diarize`, or when the speaker model found no turns or failed. 409 `not_done` before the job is done; 410 `gone` once the job was deleted or passed `server.retain_days`.",
      ...JOB_ROUTE,
      params: { id: JOB_ID },
      ok: 200,
    },
    (c) => {
      const j = jobsOf(c).get(caller(c), c.params.id as string);
      if (!j) throw noJob(jobsOf(c), caller(c), c.params.id as string);
      if (j.status !== "done" || !j.result) {
        throw new HttpError(409, "not_done", `the job is ${j.status}`, {
          status: j.status,
          ...(j.error ? { job_error: j.error } : {}),
        });
      }
      return json(200, j.result);
    },
  );

  r.add(
    "DELETE",
    "/jobs/:id",
    {
      id: "jobs.delete",
      doc: "Delete a job: a queued one is dropped, a running one stopped within two seconds, and its file and result removed. From then on its id answers 410 `gone`.",
      ...JOB_ROUTE,
      params: { id: JOB_ID },
      ok: 200,
    },
    (c) => {
      const gone = jobsOf(c).remove(caller(c), c.params.id as string);
      if (!gone) throw noJob(jobsOf(c), caller(c), c.params.id as string);
      return json(200, { ...gone, deleted: true });
    },
  );

  r.add(
    "GET",
    "/events",
    {
      id: "events.list",
      doc: "The key's job outcomes after a cursor, oldest first, as `{events, cursor, has_more}`; `wait` holds the request until one arrives. With `Accept: text/event-stream`, a stream resumable with `Last-Event-ID`.",
      ...JOB_ROUTE,
      query: {
        after: {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          default: 0,
          doc: "The `cursor` of the answer before: only events after it.",
        },
        limit: { type: "integer", min: 1, max: 1000, default: 500, doc: "Events per answer." },
        wait: WAIT,
      },
      ok: 200,
    },
    async (c) => {
      const jobs = jobsOf(c);
      const who = caller(c);
      const after = Math.max(c.query.int("after") as number, lastEventId(c.req));
      const limit = c.query.int("limit") as number;
      if ((c.req.headers.get("accept") ?? "").includes("text/event-stream")) {
        c.timeout?.(0);
        return sseEvents(jobs, who, after, c.req.signal);
      }
      const wait = waitParam(c);
      let events = jobs.events(who, after, limit);
      if (events.length === 0 && wait > 0) {
        await new Promise<void>((resolve) => {
          const mine = (key: string) => who.scopes.includes("admin") || key === who.id;
          const stop = jobs.onEvent((e) => {
            if (mine(e.key_id)) finish();
          });
          // clock: the long-poll's own bound, `wait` seconds.
          const timer = setTimeout(() => finish(), wait * 1000);
          const finish = () => {
            stop();
            clearTimeout(timer);
            c.req.signal.removeEventListener("abort", finish);
            resolve();
          };
          c.req.signal.addEventListener("abort", finish);
        });
        events = jobs.events(who, after, limit);
      }
      const cursor = events.at(-1)?.seq ?? after;
      // A page ends at `limit` events or at FEED_PAGE_BYTES of their data, whichever comes first.
      return json(200, {
        events: events.map(eventView),
        cursor,
        has_more: jobs.hasEventsAfter(who, cursor),
      });
    },
  );
}

/** The feed as Server-Sent Events, the call stream's contract (PG-S1): `id` is the cursor. */
function sseEvents(jobs: JobService, who: Identity, after: number, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start: (ctl) => {
      let closed = false;
      let cursor = after;
      const send = (text: string) => {
        if (closed) return;
        try {
          ctl.enqueue(enc.encode(text));
        } catch {
          stop();
        }
      };
      const flush = () => {
        for (;;) {
          const batch = jobs.events(who, cursor, 500);
          for (const e of batch) {
            send(`id: ${e.seq}\nevent: event\ndata: ${JSON.stringify(eventView(e))}\n\n`);
            cursor = e.seq;
          }
          // A page may end early by size (FEED_PAGE_BYTES), so only an empty one means caught up.
          if (batch.length === 0) return;
        }
      };
      const unsubscribe = jobs.onEvent((e) => {
        if (who.scopes.includes("admin") || e.key_id === who.id) flush();
      });
      // clock: a keep-alive comment, so a reader can tell a quiet feed from a dead connection.
      const keepalive = setInterval(() => send(": keep-alive\n\n"), KEEPALIVE_MS);
      const stop = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(keepalive);
        signal.removeEventListener("abort", stop);
        try {
          ctl.close();
        } catch {}
      };
      cleanup = stop;
      signal.addEventListener("abort", stop);
      send("retry: 1000\n\n");
      flush();
    },
    cancel: () => cleanup(),
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
