/**
 * The job routes of server mode (docs/ux/SERVER.md sections 5 and 6). Any key reaches them and
 * sees its own jobs and events only; an admin sees every key's.
 *
 * - `POST /v1/jobs`, multipart (SV-J1, SV-J2): `file`, `preset`, `language`, `keywords[]`,
 *   `diarize`, `callback_url`, `metadata`, and the `Idempotency-Key` header. 202 with the new job,
 *   200 with the existing one for a repeated key and file, 422 for the same key and another file.
 * - `GET /v1/jobs/{id}?wait=0..60` (SV-J3): the job, after holding the request until it ends.
 * - `GET /v1/jobs?status=&cursor=&limit=`: the key's jobs, newest first.
 * - `GET /v1/jobs/{id}/result` (SV-J4): the result of a done job.
 * - `DELETE /v1/jobs/{id}` (SV-J6).
 * - `GET /v1/events?after=&limit=&wait=0..60` (SV-E1): the key's outcomes after the cursor, oldest
 *   first, as JSON `{events, cursor, has_more}`, or as Server-Sent Events with `Accept: text/event-stream`, resumable with
 *   `Last-Event-ID`.
 */

import { eventView, type JobService, jobView } from "../../server/jobs.ts";
import { PRESET_NAMES } from "../../server/presets.ts";
import { JOB_STATES, type JobStatus, type NewJob } from "../../server/store.ts";
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
import { KEEPALIVE_MS, lastEventId } from "./follow.ts";

export const MAX_WAIT_SECONDS = 60;
export const MAX_KEYWORDS = 24;
export const MAX_METADATA_BYTES = 4096;
const LANGUAGE = /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;
const IDEMPOTENCY = /^[\x21-\x7e]{1,255}$/;

/** A multipart body, its file parts already on disk (SV-D3). */
export type Form = StreamedForm;

/** The job service, or 404 where there is none (the desktop app). */
export function jobsOf(c: RouteContext<ApiApp>): JobService {
  const j = c.app.jobs?.();
  if (!j) throw new HttpError(404, "not_found", "jobs exist in server mode only");
  return j;
}

function bad(field: string, message: string): HttpError {
  return new HttpError(422, "bad_field", message, { field });
}

/**
 * The preset a job runs, after `auto` (SV-R1, SV-R2 not built: `auto` is `fast`). A preset whose
 * engines are not built, or whose models are missing, is refused with the command that fixes it.
 */
export function resolvePreset(app: ApiApp, name: string): string {
  const ready = app.models().state === "ready";
  const preset = name === "auto" ? "fast" : name;
  if (preset !== "fast") {
    throw new HttpError(
      409,
      "preset_unavailable",
      `the ${name} preset's engines are not built in this version; use fast or auto`,
      {
        preset: name,
      },
    );
  }
  if (!ready) {
    throw new HttpError(409, "preset_unavailable", "the speech models are not downloaded", {
      preset: name,
      run: "akou models pull",
    });
  }
  return preset;
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

/** A true or false field; absent (or empty) it is `fallback`, so an explicit `false` stays false. */
function booleanOf(form: Form, name: string, fallback = false): boolean {
  const v = textField(form, name)?.trim().toLowerCase();
  if (v === undefined || v === "") return fallback;
  if (v === "false" || v === "0") return false;
  if (v === "true" || v === "1") return true;
  throw bad(name, `"${name}" is true or false`);
}

const JOB_FIELDS = new Set([
  "file",
  "preset",
  "language",
  "keywords[]",
  "keywords",
  "diarize",
  "callback_url",
  "metadata",
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

function metadataOf(form: Form): unknown {
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
    const job: Omit<NewJob, "file_sha256" | "audio"> = {
      key_id: who.id,
      preset: presetName,
      // A request with no opinion gets the server's defaults (SV-S2).
      language: languageOf(form, settings["server.default_language"]),
      keywords: keywordsOf(form),
      diarize: booleanOf(form, "diarize", settings["server.default_diarize"]),
      callback_url: callbackOf(c.app, who, textField(form, "callback_url")),
      metadata: metadataOf(form),
      idempotency_key: idem,
    };
    // Checked after the fields and before the upload is kept: a job that could never run is refused.
    job.preset = resolvePreset(c.app, presetName);
    const r = jobs.submit({ ...job, file_sha256: file.sha256, audio: file.path });
    // A repeated submit's file is deleted by `submit` itself.
    kept = file;
    return answerSubmit(r);
  } finally {
    await form.discard(kept);
  }
}

function answerSubmit(r: ReturnType<JobService["submit"]>): Response {
  if ("conflict" in r) {
    throw new HttpError(
      422,
      "idempotency_conflict",
      "this Idempotency-Key was used for another file",
      {
        id: r.conflict.id,
      },
    );
  }
  return json(r.existing ? 200 : 202, jobView(r.job));
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
      doc: "Submit an audio file for transcription; answers at once with the queued job. An `Idempotency-Key` header makes a retried submit of the same file return the first job. `metadata` (JSON, up to 4 KB) comes back on the job; `callback_url` gets a signed webhook when it ends.",
      ...JOB_ROUTE,
      body: {
        multipart: {
          file: "file",
          "preset?": "string",
          "language?": "string",
          "keywords[]?": "string[]",
          "diarize?": "boolean",
          "callback_url?": "string",
          "metadata?": "string",
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
      doc: "The key's jobs, newest first (an admin key sees every key's, or one key's with `key`). `status` keeps one state; `cursor` pages on from the last job's `seq`.",
      ...JOB_ROUTE,
      query: {
        status: { type: "string", values: JOB_STATES, doc: "Only jobs in this state." },
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
        before,
        limit,
      });
      return json(200, {
        jobs: list.map(jobView),
        cursor: list.length === limit ? (list.at(-1)?.seq ?? null) : null,
      });
    },
  );

  r.add(
    "GET",
    "/jobs/:id",
    {
      id: "jobs.get",
      doc: "One job and its state. `wait` holds the request until the job ends, up to 60 s.",
      ...JOB_ROUTE,
      params: { id: JOB_ID },
      query: { wait: WAIT },
      ok: 200,
    },
    async (c) => {
      const jobs = jobsOf(c);
      const wait = waitParam(c);
      const j = await jobs.wait(caller(c), c.params.id as string, wait * 1000, c.req.signal);
      if (!j) throw new HttpError(404, "not_found", `no job ${c.params.id}`);
      // A job deleted while the request waited answers its final state, once.
      return json(200, "seq" in j ? jobView(j) : { id: j.id, status: j.status });
    },
  );

  r.add(
    "GET",
    "/jobs/:id/result",
    {
      id: "jobs.result",
      doc: "The transcript of a done job: text, segments with speakers and times, and the engines that made it. 409 `not_done` before the job is done.",
      ...JOB_ROUTE,
      params: { id: JOB_ID },
      ok: 200,
    },
    (c) => {
      const j = jobsOf(c).get(caller(c), c.params.id as string);
      if (!j) throw new HttpError(404, "not_found", `no job ${c.params.id}`);
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
      doc: "Delete a job: a queued one is dropped, a running one stopped within two seconds, and its file and result removed.",
      ...JOB_ROUTE,
      params: { id: JOB_ID },
      ok: 200,
    },
    (c) => {
      const gone = jobsOf(c).remove(caller(c), c.params.id as string);
      if (!gone) throw new HttpError(404, "not_found", `no job ${c.params.id}`);
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
