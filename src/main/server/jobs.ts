/**
 * File jobs in server mode (docs/ux/SERVER.md section 5): the queue over the job store, the one
 * job Worker, the long-polls, the per-key feed, the webhook outbox and retention.
 *
 * - **One pipeline.** A job's upload is decoded to 16 kHz mono and run through the finalize
 *   Worker's mono pass (SV-J7). The result has one shape (SV-J4) whichever door asked for it:
 *   `POST /v1/jobs`, the OpenAI endpoint or `akou transcribe`.
 * - **A queue a backlog can lean on** (SV-Q1 to SV-Q4). Up to `server.concurrency` jobs run at
 *   once, each in its own Worker with its models loaded; the next is the highest `priority`, then
 *   the oldest. A submit past `server.queue_max` or `server.queue_max_per_key` is refused with a
 *   retry time from the jobs that ended, and the same numbers give the queue's ETA.
 * - **Every state change is one transaction** in the store: the job's state, its feed event and its
 *   delivery. A job the last process left running is queued again at start, in its place.
 * - **Nothing is kept longer than needed** (SV-J6). The upload is deleted when the job ends; a
 *   delete removes the job and its result and leaves the feed the id and the final state; a job
 *   older than `server.retain_days` goes the same way on a timer.
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Identity } from "../api/access.ts";
import { DecodeError } from "../asr/decode.ts";
import { ASR_RATE, type DiarizerKind, type ModelSpec } from "../asr/engine.ts";
import { type JobPassResult, JobWorker } from "../asr/finalize-worker.ts";
import { modelNameFor } from "../asr/live-worker.ts";
import { MODELS, NEMOTRON } from "../asr/models.ts";
import { DEFAULT_BOOST, type DecodeList, modelKind } from "../vocab/decode-list.ts";
import { readUploadAudio } from "./audio.ts";
import {
  DAY_MS,
  hardwareChoice,
  type ModelChoice,
  ModelRefused,
  type ModelStore,
  resolveModel,
  type Waiting,
} from "./model-store.ts";
import {
  type FeedEvent,
  JOBS_DB,
  type Job,
  type JobError,
  type JobStatus,
  JobStore,
  type NewJob,
} from "./store.ts";
import { completedData, Deliverer, type DelivererOptions } from "./webhooks.ts";

/** One catalog model as `GET /models` lists it (SV-M6). */
export interface ModelView {
  id: string;
  state: "ready" | "downloading" | "missing";
  bytes: number;
  size: number;
  last_used_at: string | null;
  evicts_at: string | null;
  default: boolean;
  in_use: boolean;
}

/** How often retention runs, besides at start. */
export const RETENTION_SWEEP_MS = 3_600_000;
export { DAY_MS };
/**
 * Starts a job gets. One left running when the server stopped is queued again once; running at a
 * second stop, it fails `interrupted`, since the job itself may be what stops the server.
 */
export const MAX_JOB_STARTS = 2;

/** The window of `jobs_last_hour` and `audio_seconds_last_hour`. */
export const THROUGHPUT_WINDOW_MS = 3_600_000;
/** How many of the last jobs' running times the mean, the ETA and the retry time are taken from. */
export const MEAN_OF_JOBS = 50;
/** The retry time of a refusal before any job has ended, and its bounds. */
export const RETRY_AFTER_DEFAULT_S = 30;
export const RETRY_AFTER_MAX_S = 3600;

/** The queue as `GET /v1/server` and `GET /healthz` report it (SV-Q4). */
export interface QueueStats {
  /** `server.concurrency`. */
  concurrency: number;
  /** `server.queue_max`, 0 for none. */
  max: number;
  /** `server.queue_max_per_key`, 0 for none. */
  max_per_key: number;
  /** Jobs queued or running: what the limits count. */
  depth: number;
  queued: number;
  running: number;
  /** Jobs that ended, done or failed, in the last hour. */
  jobs_last_hour: number;
  /** Seconds of audio in the jobs done in the last hour. */
  audio_seconds_last_hour: number;
  /** The mean running time of the last jobs, in seconds; null before one has ended. */
  mean_job_seconds: number | null;
  /** Seconds until the queue is empty at that pace; null before a job has ended. */
  eta_seconds: number | null;
}

/** A submit refused because the queue is full (SV-Q3). */
export interface QueueFull {
  /** The setting that refused it. */
  limit: "server.queue_max" | "server.queue_max_per_key";
  max: number;
  /** The jobs queued or running that the limit counts. */
  depth: number;
  /** When one more job is likely to fit, in seconds. */
  retry_after_s: number;
}

/** One place a job runs: its Worker, the recognizer the Worker holds, and the job in it. */
interface Slot {
  worker: JobWorker | null;
  spec: string;
  model: string | null;
  job: { id: string; abort: AbortController } | null;
}

export interface JobServiceOptions {
  /** The folder of `jobs.db` and the uploads. */
  dir: string;
  version: string;
  /** The engine for one recognizer id, or null when there is none. */
  models(recognizer: string): ModelSpec | null;
  /** The models on disk, their downloads, ledger and sweep (SERVER.md section 12). */
  shelf: ModelStore;
  /** `server.default_model`, as the settings hold it now. */
  defaultModel(): string;
  diarizer(): DiarizerKind;
  /** A key's webhook secrets (SV-E2); none for the app's token or an admin session. */
  secrets(keyId: string): string[];
  /** Does the key list this callback host by name, not only through `*`? (SV-K4) */
  hostListed(keyId: string, host: string): boolean;
  retainDays(): number;
  /** `server.max_audio_minutes`: longer audio fails `too_long` before it is held in memory. */
  maxAudioMinutes(): number;
  /** `server.concurrency`: jobs run at once. Default 1. */
  concurrency?(): number;
  /** `server.queue_max`: jobs queued or running across keys; 0 or absent, no limit. */
  queueMax?(): number;
  /** `server.queue_max_per_key`: the same for one key; 0 or absent, no limit. */
  queueMaxPerKey?(): number;
  /** Test seams: the upload decoder and the delivery's network. */
  decode?: (path: string, signal: AbortSignal, maxSamples: number) => Promise<Float32Array>;
  delivery?: Partial<Omit<DelivererOptions, "store" | "secrets" | "hostListed" | "audit">>;
  now?: () => number;
  log(level: "info" | "warn" | "error", msg: string): void;
}

/** A job as a client sees it (SV-J3), with the download it waits on while queued (SV-M1). */
export function jobView(j: Job, waiting: Waiting | null = null): Record<string, unknown> {
  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
  const finished = j.done_at ?? j.failed_at ?? j.cancelled_at;
  return {
    id: j.id,
    status: j.status,
    key_id: j.key_id,
    created_at: iso(j.created_at),
    started_at: iso(j.running_at),
    finished_at: iso(finished),
    preset: j.preset,
    model: j.model,
    model_source: j.model_source,
    priority: j.priority,
    language: j.language,
    diarize: j.diarize,
    metadata: j.metadata,
    ...(waiting ? { waiting_for: waiting } : {}),
    ...(j.error ? { error: j.error } : {}),
    links: {
      self: `/v1/jobs/${j.id}`,
      result: `/v1/jobs/${j.id}/result`,
      events: "/v1/events",
    },
  };
}

/** A feed event as a client reads it (SV-E1): the cursor is `seq`. */
export function eventView(e: FeedEvent): Record<string, unknown> {
  return {
    id: e.id,
    cursor: e.seq,
    type: e.type,
    timestamp: new Date(e.at).toISOString(),
    job_id: e.job_id,
    data: e.data,
  };
}

/** The model ids a job ran, as the engine registry names them (SV-J4). */
export function jobModels(recognizer: string, diarize: boolean, diarizer: DiarizerKind): string[] {
  const out = [recognizer, "silero-vad"];
  if (diarize) {
    out.push(
      ...(diarizer === "nemotron" ? [NEMOTRON] : ["pyannote-segmentation-3.0", "titanet-small"]),
    );
  }
  return out;
}

/** Every id in `jobModels`'s answer for the built engine is in the registry. */
export function registryKnows(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}

/** The result of a job (SV-J4). */
export function jobResult(
  job: Job,
  pass: JobPassResult,
  engine: { version: string; models: string[] },
): Record<string, unknown> {
  return {
    job_id: job.id,
    status: "done",
    text: pass.text,
    // The engine's own guess first; Parakeet detects none, so the client's hint stands in.
    language: pass.language ?? (job.language === "auto" ? null : job.language),
    language_confidence: null,
    duration_s: pass.duration_s,
    // No built engine gives word times yet.
    words: [],
    segments: pass.segments,
    engine: { name: "akou", version: engine.version, preset: job.preset, models: engine.models },
    // Neither words nor segments carry an engine confidence yet.
    confidence: null,
    metadata: job.metadata,
  };
}

function failedData(job: Job, error: JobError): Record<string, unknown> {
  return { job_id: job.id, status: "failed", error, metadata: job.metadata };
}

type Waiter = (j: { id: string; status: JobStatus }) => void;

export class JobService {
  readonly store: JobStore;
  private readonly deliverer: Deliverer;
  private readonly audioDir: string;
  private readonly now: () => number;
  private readonly slots: Slot[] = [];
  private closed = false;
  /** Jobs that ended in this process: when, and the seconds of audio of a done one (SV-Q4). */
  private ended: { at: number; audio_s: number }[] = [];
  /** The running times of the last `MEAN_OF_JOBS` jobs this process ran, in ms. */
  private runTimes: number[] = [];
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly feedWatchers = new Set<(e: FeedEvent) => void>();
  private retention: ReturnType<typeof setInterval> | null = null;

  /** When this process started the service: a job running from before is not timed. */
  private readonly startedAt: number;

  constructor(private readonly o: JobServiceOptions) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    this.audioDir = join(o.dir, "audio");
    mkdirSync(this.audioDir, { recursive: true, mode: 0o700 });
    this.store = new JobStore(join(o.dir, JOBS_DB), this.now);
    this.deliverer = new Deliverer({
      store: this.store,
      secrets: o.secrets,
      hostListed: o.hostListed,
      now: this.now,
      ...o.delivery,
      audit: (what, d, detail) =>
        o.log(
          what === "webhook.done" ? "info" : "warn",
          `${what} ${d.event_id} key ${d.key_id}: ${detail}`,
        ),
    });
    // A download's end: its jobs run, or, once it has failed for good, fail (SV-M3).
    o.shelf.onEnd((e) => {
      if (!e.ok) this.failWaiting(e.model, e.error);
      this.pump();
    });
  }

  /** Resumes what the last process left: running jobs queued again, the outbox, retention. */
  start(): void {
    for (const job of this.store.running()) {
      if (job.starts < MAX_JOB_STARTS) continue;
      this.conclude(job, {
        status: "failed",
        error: {
          code: "interrupted",
          message: `the server stopped ${job.starts} times while this job ran, so it is not run again`,
        },
      });
    }
    const requeued = this.store.requeueRunning();
    if (requeued > 0)
      this.o.log("info", `jobs: ${requeued} left running at the last stop are queued again`);
    // An upload no job names was left by a crash (mid-upload, or between a job's end and the
    // file's delete): nothing would ever read or delete it.
    const named = this.store.uploads();
    let orphans = 0;
    for (const f of readdirSync(this.audioDir)) {
      const path = join(this.audioDir, f);
      if (!f.endsWith(".upload") || named.has(path)) continue;
      rmSync(path, { force: true });
      orphans++;
    }
    if (orphans > 0) this.o.log("info", `jobs: ${orphans} upload(s) no job names were deleted`);
    this.sweep();
    // clock: retention runs hourly; each run reads the store's own times.
    this.retention = setInterval(() => this.sweep(), RETENTION_SWEEP_MS);
    this.deliverer.kick();
    this.pump();
  }

  depth(): number {
    return this.store.depth();
  }

  private concurrency(): number {
    return Math.max(1, this.o.concurrency?.() ?? 1);
  }

  /** The mean running time of the last jobs, in ms, or null before one has ended. */
  private meanRunMs(): number | null {
    if (this.runTimes.length === 0) return null;
    return this.runTimes.reduce((a, b) => a + b, 0) / this.runTimes.length;
  }

  /** Seconds until `jobs` more have run at the current pace: rounds of `concurrency` jobs each. */
  private secondsFor(jobs: number): number | null {
    const mean = this.meanRunMs();
    if (mean === null) return null;
    return Math.ceil((Math.ceil(jobs / this.concurrency()) * mean) / 1000);
  }

  /** The queue's settings, depth, throughput and ETA (SV-Q4). */
  queueStats(): QueueStats {
    const c = this.store.counts(null);
    const depth = c.queued + c.running;
    const since = this.now() - THROUGHPUT_WINDOW_MS;
    this.ended = this.ended.filter((e) => e.at > since);
    const mean = this.meanRunMs();
    return {
      concurrency: this.concurrency(),
      max: this.o.queueMax?.() ?? 0,
      max_per_key: this.o.queueMaxPerKey?.() ?? 0,
      depth,
      queued: c.queued,
      running: c.running,
      jobs_last_hour: this.ended.length,
      audio_seconds_last_hour: Math.round(this.ended.reduce((a, e) => a + e.audio_s, 0)),
      mean_job_seconds: mean === null ? null : Math.round(mean / 100) / 10,
      eta_seconds: depth === 0 ? 0 : this.secondsFor(depth),
    };
  }

  /**
   * Whether one more job from `key` is refused (SV-Q3): the queue at `server.queue_max`, or the
   * key at `server.queue_max_per_key`. A retry of a job the key already holds (its idempotency
   * key) is never refused: it adds nothing, and its answer is that job.
   */
  queueFull(key: string, idem: string | null): QueueFull | null {
    if (idem !== null && this.store.hasIdempotent(key, idem)) return null;
    const check = (
      limit: QueueFull["limit"],
      max: number,
      c: { queued: number; running: number },
    ) => {
      const depth = c.queued + c.running;
      if (max <= 0 || depth < max) return null;
      const wait = this.secondsFor(depth - max + 1) ?? RETRY_AFTER_DEFAULT_S;
      return {
        limit,
        max,
        depth,
        retry_after_s: Math.min(RETRY_AFTER_MAX_S, Math.max(1, wait)),
      };
    };
    return (
      check("server.queue_max", this.o.queueMax?.() ?? 0, this.store.counts(null)) ??
      check("server.queue_max_per_key", this.o.queueMaxPerKey?.() ?? 0, this.store.counts(key))
    );
  }

  // -------------------------------------------------------------------------
  // Which model (SV-S1)

  /**
   * The model a request runs: its `model`, its `preset`, `server.default_model`, then the
   * hardware's choice. Throws `ModelRefused`; `unknownIsAuto` is the OpenAI door's leniency.
   */
  choose(ask: { model?: string; preset?: string }, unknownIsAuto = false): ModelChoice {
    return resolveModel(ask, {
      catalog: this.o.shelf.catalog(),
      defaultModel: this.o.defaultModel(),
      unknownIsAuto,
    });
  }

  /** The recognizer a request with no opinion runs; the hardware's when the setting is unusable. */
  defaultRecognizer(): string {
    try {
      return this.choose({}).model;
    } catch {
      return hardwareChoice().model;
    }
  }

  /**
   * Whether a job on `model` can be had: its files on disk, downloading, or allowed to start (SV-M1,
   * SV-M2). Throws `ModelRefused`; the route answers it before the upload is kept.
   */
  admit(model: string): void {
    this.o.shelf.admit(this.o.shelf.needs(model));
  }

  private modelOf(j: Job): string {
    return j.model ?? this.defaultRecognizer();
  }

  /** The job as a client sees it, with its download's progress while it waits. */
  view(j: Job): Record<string, unknown> {
    const waiting =
      j.status === "queued" ? this.o.shelf.waiting(this.o.shelf.needs(this.modelOf(j))) : null;
    return jobView(j, waiting);
  }

  /** Whether a job on `model` could run now: its files on disk, or allowed to be fetched. */
  obtainable(model: string): boolean {
    try {
      this.admit(model);
      return true;
    } catch {
      return false;
    }
  }

  /** The recognizer a live worker holds (the first, with several), or null. */
  workerModel(): string | null {
    return this.slots.find((s) => s.worker && s.model)?.model ?? null;
  }

  /** Every queued job waiting on `model` fails: its download failed for good (SV-M3). */
  private failWaiting(model: string, cause: string): void {
    for (const j of this.store.queued()) {
      if (!this.o.shelf.needs(this.modelOf(j)).includes(model)) continue;
      this.conclude(j, {
        status: "failed",
        error: {
          code: "model_download_failed",
          message: `the ${model} model could not be downloaded: ${cause}`,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Submit, read, delete

  /**
   * The folder uploads are written into as they arrive (SV-D3), as `<uuid>.upload`; one that no
   * job names is deleted at the next start.
   */
  get uploadDir(): string {
    return this.audioDir;
  }

  /**
   * A new job, the key's existing one for the same idempotency key and file, a conflict when the
   * same key names another file (SV-J2), or a refusal when the queue is full (SV-Q3). The limit's
   * check and the insert are one transaction, so two submits racing for the last place make one job.
   */
  submit(j: NewJob): { job: Job; existing: boolean } | { conflict: Job } | { full: QueueFull } {
    const r = this.store.db.transaction(() => {
      const full = this.queueFull(j.key_id, j.idempotency_key);
      return full ? { full } : this.store.submit(j);
    })();
    if ("full" in r) {
      rmSync(j.audio, { force: true });
      return r;
    }
    if (r.existing) {
      rmSync(j.audio, { force: true });
      if (r.job.file_sha256 !== j.file_sha256) return { conflict: r.job };
      return r;
    }
    this.pump();
    return r;
  }

  /** The job, when the caller may see it: its own, or any for an admin. */
  get(who: Identity, id: string): Job | null {
    const j = this.store.job(id);
    return j && this.visible(who, j.key_id) ? j : null;
  }

  private visible(who: Identity, key: string): boolean {
    return who.scopes.includes("admin") || who.id === key;
  }

  /**
   * The key's jobs (every key's for an admin, or the one `key` names), newest first. A key that is
   * not admin sees its own only, whatever `key` names.
   */
  list(
    who: Identity,
    o: { key?: string; status?: JobStatus; before?: number; limit: number },
  ): Job[] {
    const admin = who.scopes.includes("admin");
    if (!admin && o.key !== undefined && o.key !== who.id) return [];
    return this.store.list({ ...o, key: admin ? (o.key ?? null) : who.id });
  }

  /**
   * Resolves with the job once it leaves `queued` and `running`, or after `ms`, or when the client
   * goes away; the answer is the job's state at that moment (null once it was deleted).
   */
  async wait(
    who: Identity,
    id: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<Job | { id: string; status: JobStatus } | null> {
    const j = this.get(who, id);
    if (!j || ms <= 0 || (j.status !== "queued" && j.status !== "running")) return j;
    const ended = await new Promise<{ id: string; status: JobStatus } | null>((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = (v: { id: string; status: JobStatus } | null) => {
        set.delete(fn);
        if (set.size === 0) this.waiters.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(v);
      };
      const fn: Waiter = (s) => {
        if (s.status !== "queued" && s.status !== "running") done(s);
      };
      const abort = () => done(null);
      // clock: the long-poll's own bound, `wait` seconds.
      const timer = setTimeout(() => done(null), ms);
      signal?.addEventListener("abort", abort);
      set.add(fn);
    });
    return this.store.job(id) ?? ended;
  }

  private notify(id: string, status: JobStatus): void {
    for (const fn of [...(this.waiters.get(id) ?? [])]) fn({ id, status });
  }

  /**
   * Deletes a job (SV-J6): a queued one is dropped, a running one's Worker is terminated, a
   * finished one's result goes. The feed keeps the id and the final state.
   */
  remove(who: Identity, id: string): { id: string; status: JobStatus } | null {
    const j = this.get(who, id);
    if (!j) return null;
    return this.drop(j.id);
  }

  private drop(id: string): { id: string; status: JobStatus } | null {
    const r = this.store.remove(id);
    if (!r) return null;
    const slot = this.slots.find((s) => s.job?.id === id);
    if (slot) {
      slot.job?.abort.abort();
      slot.worker?.cancel("the job was deleted");
      // The slot is free now: an aborted run touches neither it nor its Worker again.
      slot.job = null;
    }
    if (r.job.audio) rmSync(r.job.audio, { force: true });
    this.notify(id, r.final);
    if (r.final === "cancelled") this.announce(id);
    if (slot) this.pump();
    return { id, status: r.final };
  }

  /**
   * The hourly sweep: jobs past `server.retain_days`, then models unused for
   * `server.models_unused_days` (SV-M5). Returns the number of jobs removed.
   */
  sweep(): number {
    const n = this.sweepJobs();
    this.sweepModels();
    return n;
  }

  /** The default's set, and what a queued or running job or the live worker needs. */
  private held(): { defaults: Set<string>; inUse: Set<string> } {
    const shelf = this.o.shelf;
    const defaults = new Set(shelf.needs(this.defaultRecognizer()));
    const inUse = new Set<string>();
    for (const j of [...this.store.queued(), ...this.store.running()]) {
      for (const id of shelf.needs(this.modelOf(j))) inUse.add(id);
    }
    for (const s of this.slots) {
      if (s.worker && s.model) for (const id of shelf.needs(s.model)) inUse.add(id);
    }
    return { defaults, inUse };
  }

  /**
   * Deletes the models nobody used for `server.models_unused_days`, never the default's set, one a
   * queued or running job needs, one the worker holds, or one downloading (the store's own rule).
   */
  sweepModels(): void {
    const { defaults, inUse } = this.held();
    this.o.shelf.sweep(new Set([...defaults, ...inUse]));
  }

  /** Every catalog model as the Models page and `GET /models` show it (SV-M6). */
  modelList(): ModelView[] {
    const shelf = this.o.shelf;
    const { defaults, inUse } = this.held();
    const ledger = shelf.ledger();
    const days = this.o.shelf.unusedDays();
    const iso = (t: number | undefined) => (t === undefined ? null : new Date(t).toISOString());
    return shelf.catalog().map((m) => {
      const state = shelf.state(m.id);
      const last = state === "ready" ? ledger[m.id] : undefined;
      const kept = defaults.has(m.id) || inUse.has(m.id);
      return {
        id: m.id,
        state,
        ...shelf.size(m.id),
        last_used_at: iso(last),
        evicts_at: last === undefined || kept || days === 0 ? null : iso(last + days * DAY_MS),
        default: defaults.has(m.id),
        in_use: inUse.has(m.id),
      };
    });
  }

  private modelView(id: string): ModelView {
    return this.modelList().find((m) => m.id === id) as ModelView;
  }

  /** Fetches one catalog model under the limits of an on-demand download (SV-M6, SV-M2). */
  pullModel(id: string): ModelView {
    const shelf = this.o.shelf;
    if (!shelf.catalog().some((m) => m.id === id)) {
      throw new ModelRefused(422, "unknown_model", `no model ${id} in the catalog`, {
        field: "model",
        model: id,
      });
    }
    shelf.admit([id]);
    shelf.fetch([id]);
    return this.modelView(id);
  }

  /**
   * Deletes one model under the sweep's rules (SV-M6): never the default's set, one in use, or one
   * downloading. Logged as `model.deleted` with the key that asked.
   */
  deleteModel(id: string, by: string): { id: string; deleted: true; bytes: number } {
    const shelf = this.o.shelf;
    if (!shelf.catalog().some((m) => m.id === id) || shelf.state(id) === "missing") {
      throw new ModelRefused(404, "not_found", `no model ${id} on disk`, { model: id });
    }
    const { defaults, inUse } = this.held();
    if (defaults.has(id) || inUse.has(id)) {
      throw new ModelRefused(
        409,
        "model_in_use",
        defaults.has(id)
          ? `${id} is part of the default model's set (server.default_model)`
          : `${id} is needed by a queued or running job`,
        { model: id, default: defaults.has(id) },
      );
    }
    const bytes = shelf.remove(id);
    this.o.log("info", `model.deleted ${id} key ${by} bytes_freed ${bytes}`);
    return { id, deleted: true, bytes };
  }

  /** Every job older than `server.retain_days` is deleted as a client's delete would. */
  private sweepJobs(): number {
    const before = this.now() - this.o.retainDays() * DAY_MS;
    let n = 0;
    for (const j of this.store.createdBefore(before)) if (this.drop(j.id)) n++;
    if (n > 0)
      this.o.log(
        "info",
        `jobs: retention removed ${n} job(s) older than ${this.o.retainDays()} days`,
      );
    return n;
  }

  // -------------------------------------------------------------------------
  // The feed

  events(who: Identity, after: number, limit: number): FeedEvent[] {
    return this.store.events(who.scopes.includes("admin") ? null : who.id, after, limit);
  }

  /** Does the key (every key, for an admin) have an event after the cursor? */
  hasEventsAfter(who: Identity, after: number): boolean {
    return this.store.hasEventsAfter(who.scopes.includes("admin") ? null : who.id, after);
  }

  /** Told of every new event; the routes filter by key. Returns the unsubscribe function. */
  onEvent(fn: (e: FeedEvent) => void): () => void {
    this.feedWatchers.add(fn);
    return () => this.feedWatchers.delete(fn);
  }

  private announce(jobId: string): void {
    const last = this.store.db
      .query("SELECT seq FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT 1")
      .get(jobId) as { seq: number } | null;
    if (!last) return;
    const e = this.store.events(null, last.seq - 1, 1)[0];
    if (e) for (const fn of [...this.feedWatchers]) fn(e);
  }

  // -------------------------------------------------------------------------
  // The runner

  private workerFor(slot: Slot, spec: ModelSpec, recognizer: string): JobWorker {
    const key = JSON.stringify(spec);
    if (!slot.worker || slot.spec !== key) {
      slot.worker?.close();
      slot.worker = new JobWorker(spec, (level, msg) => this.o.log(level, `job: ${msg}`));
      slot.spec = key;
    }
    slot.model = recognizer;
    return slot.worker;
  }

  /**
   * An idle slot for a job on `model`: one whose Worker holds it already, so its models stay
   * loaded, else an empty one, else any idle one, whose Worker is rebuilt.
   */
  private slotFor(model: string): Slot {
    const idle = this.slots.filter((s) => !s.job);
    const slot =
      idle.find((s) => s.worker && s.model === model) ?? idle.find((s) => !s.worker) ?? idle[0];
    if (slot) return slot;
    const fresh: Slot = { worker: null, spec: "", model: null, job: null };
    this.slots.push(fresh);
    return fresh;
  }

  /**
   * Idle Workers are closed when they hold a model other than the default's that no queued job
   * needs, so an idle worker never pins a model the sweep should free (SV-M4), and when there are
   * more of them than `server.concurrency` allows.
   */
  private releaseWorkers(): void {
    let kept = this.slots.filter((s) => s.job).length;
    const room = this.concurrency();
    const queued = this.store.queued();
    const fallback = this.defaultRecognizer();
    for (const s of this.slots) {
      if (s.job || !s.worker) continue;
      const wanted =
        s.model !== null &&
        (s.model === fallback || queued.some((j) => this.modelOf(j) === s.model));
      if (wanted && kept < room) {
        kept++;
        continue;
      }
      s.worker.close();
      s.worker = null;
      s.spec = "";
      s.model = null;
    }
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i] as Slot;
      if (!s.job && !s.worker) this.slots.splice(i, 1);
    }
  }

  /**
   * The next queued job whose models are on disk, in the queue's order. A job whose models are
   * missing starts their download and waits, holding no worker (SV-M1).
   */
  private nextRunnable(): Job | null {
    for (const j of this.store.queued()) {
      const needs = this.o.shelf.needs(this.modelOf(j));
      if (this.o.shelf.missing(needs).length === 0) return j;
      this.o.shelf.fetch(needs);
    }
    return null;
  }

  /** Starts queued jobs while a slot is free, up to `server.concurrency` at once. */
  private pump(): void {
    if (this.closed) return;
    while (this.slots.filter((s) => s.job).length < this.concurrency()) {
      const next = this.nextRunnable();
      if (!next) break;
      const job = this.store.markRunning(next.id);
      if (job?.status !== "running") continue;
      const slot = this.slotFor(this.modelOf(job));
      const abort = new AbortController();
      slot.job = { id: job.id, abort };
      this.notify(job.id, "running");
      void this.run(job, slot, abort).finally(() => {
        if (slot.job?.id === job.id) slot.job = null;
        this.pump();
      });
    }
    this.releaseWorkers();
  }

  private async run(job: Job, slot: Slot, abort: AbortController): Promise<void> {
    let end:
      | { status: "done"; result: Record<string, unknown> }
      | { status: "failed"; error: JobError };
    const model = this.modelOf(job);
    const needs = this.o.shelf.needs(model);
    // A model is used when a job on it starts and when it ends (SV-M4).
    this.o.shelf.touch(needs);
    try {
      const spec = this.o.models(model);
      if (!spec)
        throw Object.assign(
          new Error("the speech models are not downloaded; run `akou models pull`"),
          { code: "models_missing" },
        );
      let samples: Float32Array;
      try {
        const maxSamples = this.o.maxAudioMinutes() * 60 * ASR_RATE;
        samples = await (
          this.o.decode ?? ((p, signal, max) => readUploadAudio(p, { signal, maxSamples: max }))
        )(job.audio as string, abort.signal, maxSamples);
      } catch (err) {
        throw Object.assign(err as Error, {
          code: err instanceof DecodeError ? err.code : "decode_failed",
        });
      }
      if (abort.signal.aborted) return;
      // A llama-server engine (Qwen) takes the keywords as its glossary instead of hotwords.
      const decode: DecodeList | null =
        job.keywords.length === 0 || spec.final
          ? null
          : {
              model: modelNameFor(spec),
              entries: job.keywords.map((term) => ({
                term,
                boost: DEFAULT_BOOST,
                tier: 1,
                source: "call",
              })),
              dropped: [],
              warnings: [],
            };
      // A model that takes no hotwords gets none (the engine would refuse them).
      const pass = await this.workerFor(slot, spec, model).run({
        samples,
        diarize: job.diarize,
        decode: decode && modelKind(decode.model) === "transducer" ? decode : null,
        language: job.language,
        glossary: job.keywords,
      });
      const recognizer = pass.model ?? modelNameFor(spec);
      end = {
        status: "done",
        result: jobResult(job, pass, {
          version: this.o.version,
          models: jobModels(recognizer, job.diarize, this.o.diarizer()),
        }),
      };
    } catch (err) {
      if (abort.signal.aborted) return;
      const code = (err as { code?: string }).code ?? "transcription_failed";
      end = { status: "failed", error: { code, message: (err as Error).message } };
    } finally {
      this.o.shelf.touch(needs);
    }
    this.conclude(job, end);
  }

  /** A running job's end: the store, its event and delivery, its upload deleted, the watchers. */
  private conclude(
    job: Job,
    end:
      | { status: "done"; result: Record<string, unknown> }
      | { status: "failed"; error: JobError },
  ): void {
    const e =
      end.status === "done"
        ? this.store.finish(job.id, end, {
            type: "transcription.completed",
            data: completedData(end.result, job.id),
            deliverTo: job.callback_url,
          })
        : this.store.finish(job.id, end, {
            type: "transcription.failed",
            data: failedData(job, end.error),
            deliverTo: job.callback_url,
          });
    if (job.audio) rmSync(job.audio, { force: true });
    if (!e) return;
    this.measure(job, end);
    this.o.log(
      end.status === "done" ? "info" : "warn",
      `job.${end.status} ${job.id} key ${job.key_id} model ${this.modelOf(job)}`,
    );
    this.notify(job.id, end.status);
    for (const fn of [...this.feedWatchers]) fn(e);
    if (job.callback_url) this.deliverer.kick();
  }

  /**
   * A job that ended counts in the hour's throughput; its running time counts in the mean when this
   * process ran it from its start (not a job failed while it waited, or one a restart interrupted).
   */
  private measure(
    job: Job,
    end: { status: "done"; result: Record<string, unknown> } | { status: "failed" },
  ): void {
    const now = this.now();
    const audio = end.status === "done" ? Number(end.result.duration_s) : 0;
    this.ended.push({ at: now, audio_s: Number.isFinite(audio) ? audio : 0 });
    this.ended = this.ended.filter((e) => e.at > now - THROUGHPUT_WINDOW_MS);
    if (job.running_at !== null && job.running_at >= this.startedAt) {
      this.runTimes.push(Math.max(0, now - job.running_at));
      if (this.runTimes.length > MEAN_OF_JOBS) this.runTimes.shift();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retention) clearInterval(this.retention);
    this.deliverer.close();
    for (const s of this.slots) {
      s.job?.abort.abort();
      s.worker?.close();
      s.worker = null;
    }
    this.o.shelf.close();
    this.store.close();
  }
}
