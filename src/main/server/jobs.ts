/**
 * File jobs in server mode (docs/ux/SERVER.md section 5): the queue over the job store, the one
 * job Worker, the long-polls, the per-key feed, the webhook outbox and retention.
 *
 * - **One pipeline.** A job's upload is decoded to 16 kHz mono and run through the finalize
 *   Worker's mono pass (SV-J7), one job at a time, in submit order. The result has one shape
 *   (SV-J4) whichever door asked for it: `POST /v1/jobs`, the OpenAI endpoint or `akou transcribe`.
 * - **Every state change is one transaction** in the store: the job's state, its feed event and its
 *   delivery. A job the last process left running is queued again at start, in its place.
 * - **Nothing is kept longer than needed** (SV-J6). The upload is deleted when the job ends; a
 *   delete removes the job and its result and leaves the feed the id and the final state; a job
 *   older than `server.retain_days` goes the same way on a timer.
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
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
  type FeedEvent,
  JOBS_DB,
  type Job,
  type JobError,
  type JobStatus,
  JobStore,
  type NewJob,
} from "./store.ts";
import { completedData, Deliverer, type DelivererOptions } from "./webhooks.ts";

/** How often retention runs, besides at start. */
export const RETENTION_SWEEP_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/**
 * Starts a job gets. One left running when the server stopped is queued again once; running at a
 * second stop, it fails `interrupted`, since the job itself may be what stops the server.
 */
export const MAX_JOB_STARTS = 2;

export interface JobServiceOptions {
  /** The folder of `jobs.db` and the uploads. */
  dir: string;
  version: string;
  /** The recognizer's models, or null while they are missing. */
  models(): ModelSpec | null;
  diarizer(): DiarizerKind;
  /** A key's webhook secrets (SV-E2); none for the app's token or an admin session. */
  secrets(keyId: string): string[];
  /** Does the key list this callback host by name, not only through `*`? (SV-K4) */
  hostListed(keyId: string, host: string): boolean;
  retainDays(): number;
  /** `server.max_audio_minutes`: longer audio fails `too_long` before it is held in memory. */
  maxAudioMinutes(): number;
  /** Test seams: the upload decoder and the delivery's network. */
  decode?: (path: string, signal: AbortSignal, maxSamples: number) => Promise<Float32Array>;
  delivery?: Partial<Omit<DelivererOptions, "store" | "secrets" | "hostListed" | "audit">>;
  now?: () => number;
  log(level: "info" | "warn" | "error", msg: string): void;
}

/** A job as a client sees it (SV-J3). */
export function jobView(j: Job): Record<string, unknown> {
  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
  const finished = j.done_at ?? j.failed_at ?? j.cancelled_at;
  return {
    id: j.id,
    status: j.status,
    created_at: iso(j.created_at),
    started_at: iso(j.running_at),
    finished_at: iso(finished),
    preset: j.preset,
    language: j.language,
    diarize: j.diarize,
    metadata: j.metadata,
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
  private worker: JobWorker | null = null;
  private workerSpec = "";
  private running: { id: string; abort: AbortController } | null = null;
  private pumping = false;
  private closed = false;
  private readonly waiters = new Map<string, Set<Waiter>>();
  private readonly feedWatchers = new Set<(e: FeedEvent) => void>();
  private retention: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: JobServiceOptions) {
    this.now = o.now ?? Date.now;
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
    this.sweep();
    // clock: retention runs hourly; each run reads the store's own times.
    this.retention = setInterval(() => this.sweep(), RETENTION_SWEEP_MS);
    this.deliverer.kick();
    this.pump();
  }

  depth(): number {
    return this.store.depth();
  }

  // -------------------------------------------------------------------------
  // Submit, read, delete

  /** Keeps an upload on disk and returns its path and SHA-256. */
  async keepUpload(file: Blob): Promise<{ path: string; sha256: string }> {
    const path = join(this.audioDir, `${crypto.randomUUID()}.upload`);
    const hash = createHash("sha256");
    const sink = Bun.file(path).writer();
    try {
      for await (const chunk of file.stream()) {
        hash.update(chunk);
        sink.write(chunk);
      }
    } finally {
      await sink.end();
    }
    return { path, sha256: hash.digest("hex") };
  }

  /**
   * A new job, the key's existing one for the same idempotency key and file, or a conflict when
   * the same key names another file (SV-J2).
   */
  submit(j: NewJob): { job: Job; existing: boolean } | { conflict: Job } {
    const r = this.store.submit(j);
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

  /** The key's jobs (every key's for an admin), newest first. */
  list(who: Identity, o: { status?: JobStatus; before?: number; limit: number }): Job[] {
    return this.store.list({ key: who.scopes.includes("admin") ? null : who.id, ...o });
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
    if (this.running?.id === id) {
      this.running.abort.abort();
      this.worker?.cancel("the job was deleted");
    }
    if (r.job.audio) rmSync(r.job.audio, { force: true });
    this.notify(id, r.final);
    if (r.final === "cancelled") this.announce(id);
    return { id, status: r.final };
  }

  /** Every job older than `server.retain_days` is deleted as a client's delete would. */
  sweep(): number {
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

  private workerFor(spec: ModelSpec): JobWorker {
    const key = JSON.stringify(spec);
    if (!this.worker || this.workerSpec !== key) {
      this.worker?.close();
      this.worker = new JobWorker(spec, (level, msg) => this.o.log(level, `job: ${msg}`));
      this.workerSpec = key;
    }
    return this.worker;
  }

  /** Runs queued jobs one at a time, oldest first, until none is left. */
  private pump(): void {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    void (async () => {
      try {
        for (;;) {
          if (this.closed) return;
          const next = this.store.nextQueued();
          if (!next) return;
          const job = this.store.markRunning(next.id);
          if (job?.status !== "running") continue;
          this.notify(job.id, "running");
          await this.run(job);
        }
      } finally {
        this.pumping = false;
      }
    })();
  }

  private async run(job: Job): Promise<void> {
    const abort = new AbortController();
    this.running = { id: job.id, abort };
    let end:
      | { status: "done"; result: Record<string, unknown> }
      | { status: "failed"; error: JobError };
    try {
      const spec = this.o.models();
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
      const decode: DecodeList | null =
        job.keywords.length === 0
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
      const pass = await this.workerFor(spec).run({
        samples,
        diarize: job.diarize,
        decode: decode && modelKind(decode.model) === "transducer" ? decode : null,
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
      if (this.running?.id === job.id) this.running = null;
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
    this.o.log(
      end.status === "done" ? "info" : "warn",
      `job.${end.status} ${job.id} key ${job.key_id}`,
    );
    this.notify(job.id, end.status);
    for (const fn of [...this.feedWatchers]) fn(e);
    if (job.callback_url) this.deliverer.kick();
  }

  close(): void {
    this.closed = true;
    if (this.retention) clearInterval(this.retention);
    this.deliverer.close();
    this.running?.abort.abort();
    this.worker?.close();
    this.worker = null;
    this.store.close();
  }
}
