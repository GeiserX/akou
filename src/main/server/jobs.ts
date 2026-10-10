/**
 * File jobs in server mode (docs/ux/SERVER.md section 5): the queue over the job store, the one
 * job Worker, the long-polls, the per-key feed, the webhook outbox and retention.
 *
 * - **One pipeline.** A job's upload is decoded to 16 kHz mono and run through the finalize
 *   Worker's mono pass (SV-J7). The result has one shape (SV-J4) whichever door asked for it:
 *   `POST /v1/jobs`, the OpenAI endpoint or `akou transcribe`.
 * - **A queue a backlog can lean on** (SV-Q1 to SV-Q4). Up to `server.concurrency` jobs run at
 *   once, each in its own Worker with its models loaded; the next is the highest `priority`, then
 *   the oldest, except that among jobs of one priority a job on a model an idle Worker holds goes
 *   first, so a switch of preset does not reload a model (at most `WARM_PASS_LIMIT` times past one
 *   job). An idle Worker keeps its models for `server.model_idle_minutes`, then lets them go. A
 *   submit past `server.queue_max` or `server.queue_max_per_key` is refused with a retry time
 *   from the jobs that ended, and the same numbers give the queue's ETA.
 * - **One Metal llama-server at a time.** Two on Metal stop each other (llama-server.ts), so a job
 *   whose engine runs on a Metal llama-server waits while another such job runs, in any Worker,
 *   the dictation lane's included.
 * - **Every state change is one transaction** in the store: the job's state, its feed event and its
 *   delivery. A job the last process left running is queued again at start, in its place.
 * - **Remotes** (section 14): a queued job this server cannot run, or one a `server.remotes` entry
 *   names, is sent to another akou over its job API and followed there; its end is concluded here
 *   as any job's, so the client reads it under this server's id, feed and webhook. A remote that
 *   goes away puts the job back in the queue, never fails it.
 * - **A lane for dictation** (DICTATION.md DC-R2). A job submitted `interactive` runs in one of
 *   `server.dictation_slots` Workers of its own, which never take a queued job, in the order the
 *   dictations arrived. It is never refused by the queue's limits, never counted in them, and never
 *   sent to a remote. With no slots, `interactive` is ignored and the job queues like any other.
 * - **Nothing is kept longer than needed** (SV-J6). The upload is deleted when the job ends; a
 *   delete removes the job and its result and leaves the feed the id and the final state; a job
 *   older than `server.retain_days` goes the same way on a timer. A job submitted `keep_audio`
 *   is the one exception the client asked for: its upload stays after it ends, and retention
 *   skips it whole (row, result, events, audio) until a client deletes it.
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Identity } from "../api/access.ts";
import { DecodeError } from "../asr/decode.ts";
import { ASR_RATE, type DiarizerKind, type ModelSpec } from "../asr/engine.ts";
import {
  type JobPassResult,
  type JobProgress,
  type JobTimings,
  JobWorker,
} from "../asr/finalize-worker.ts";
import { engineIds } from "../asr/fusion.ts";
import { modelNameFor } from "../asr/live-worker.ts";
import { MODELS, NEMOTRON } from "../asr/models.ts";
import { DIARIZE_HELPER_NAME } from "../asr/nemotron.ts";
import { findHelper } from "../capture/helper.ts";
import { DEFAULT_BOOST, type DecodeList, modelKind } from "../vocab/decode-list.ts";
import { readUploadAudio } from "./audio.ts";
import {
  DAY_MS,
  type Held,
  hardwareChoice,
  type ModelChoice,
  type ModelSource,
  type ModelStore,
  resolveModel,
  type Waiting,
} from "./model-store.ts";
import { PRESET_NAMES } from "./presets.ts";
import { REMOTE_WAIT_S, RemoteError, type RemoteJob, Remotes } from "./remotes.ts";
import {
  type FeedEvent,
  JOBS_DB,
  type Job,
  type JobError,
  type JobRequest,
  type JobStatus,
  JobStore,
  type NewJob,
} from "./store.ts";
import { completedData, Deliverer, type DelivererOptions } from "./webhooks.ts";

/** How often retention runs, besides at start. */
export const RETENTION_SWEEP_MS = 3_600_000;
/**
 * The most jobs retention removes in one go, and the longest one go holds the thread: a start
 * after days stopped, or an hour of a busy archive, is thousands of jobs, and removing them in one
 * loop answered no request until the last was gone. Each go is one transaction, so one write to
 * the disk; the next runs after the requests that arrived meanwhile.
 */
export const SWEEP_BATCH = 200;
export const SWEEP_SLICE_MS = 50;
export { DAY_MS };
/**
 * Starts a job gets. One left running when the server stopped is queued again once; running at a
 * second stop, it fails `interrupted`, since the job itself may be what stops the server.
 */
export const MAX_JOB_STARTS = 2;

/** `server.model_idle_minutes`' default: an idle Worker keeps its models this long. */
export const MODEL_IDLE_MINUTES = 60;
/**
 * How many times a queued job may be passed over for a job of its priority on a model an idle
 * Worker holds, so a steady stream on one model never starves a job on another.
 */
export const WARM_PASS_LIMIT = 8;

/** The most Workers `server.dictation_slots` reserves. */
export const MAX_DICTATION_SLOTS = 8;

/** What `GET /v1/server` says of the dictation lane (DC-R2). */
export interface DictationStats {
  /** Workers reserved for interactive jobs; 0 when `interactive` is ignored. */
  slots: number;
  /** The engine the lane runs when a dictation names none: `server.dictation_engine` resolved. */
  engine: string;
  /** Interactive jobs that ended in the last hour. */
  served_last_hour: number;
}

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
  /** The recognizers a job Worker holds loaded now, so a client can batch its jobs by them. */
  loaded: string[];
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
  /** The running job and the model it runs (the Worker takes it only once the upload is read). */
  job: { id: string; abort: AbortController; model: string } | null;
  /** When the Worker last ended a job (the service's clock), while it has none. */
  idleSince: number | null;
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
  /** The `fusion` preset as the settings make it now (`fusionChoice`); absent: the preset's own. */
  fusion?(): { fuser: string; engines: readonly string[] };
  /** What `auto` runs here now (SV-R2, `autoChoice`); absent, `fast`. */
  auto?(): { model: string; preset: string };
  diarizer(): DiarizerKind;
  /** A key's webhook secrets (SV-E2); none for the app's token or an admin session. */
  secrets(keyId: string): string[];
  /** Does the key list this callback host by name, not only through `*`? (SV-K4) */
  hostListed(keyId: string, host: string): boolean;
  retainDays(): number;
  /** `server.max_audio_minutes`: longer audio fails `too_long` before it is held in memory. */
  maxAudioMinutes(): number;
  /** `server.remotes` as the settings hold it now (section 14). */
  remotes?(): readonly string[];
  /** `server.remotes_overflow`: a job a remote entry names runs here while every such remote is busy. */
  remotesOverflow?(): boolean;
  /** Where a remote key file's `~/` points. */
  env?: Record<string, string | undefined>;
  /** Test seams: how often the remotes are probed, and their network. */
  remoteProbeMs?: number;
  remoteFetch?: typeof fetch;
  /** `server.concurrency`: jobs run at once. Default 1. */
  concurrency?(): number;
  /**
   * `server.model_idle_minutes`: how long an idle Worker keeps its models before it is closed; 0
   * closes it once no queued job needs its model. Default `MODEL_IDLE_MINUTES`.
   */
  modelIdleMinutes?(): number;
  /** `server.queue_max`: jobs queued or running across keys; 0 or absent, no limit. */
  queueMax?(): number;
  /** `server.queue_max_per_key`: the same for one key; 0 or absent, no limit. */
  queueMaxPerKey?(): number;
  /** `server.dictation_slots`: Workers reserved for interactive jobs (DC-R2); 0 or absent, none. */
  dictationSlots?(): number;
  /** `server.dictation_engine`: what an interactive job runs when it names no model; `auto` or absent, the server's default. */
  dictationEngine?(): string;
  /**
   * Whether an idle Worker holding the default's model stays loaded for the next job. Absent:
   * yes (a server keeps it warm). The desktop app says no: an idle Worker is closed, so its
   * memory is free again once the queue is empty.
   */
  keepIdleWorkers?(): boolean;
  /**
   * The owner's own models, in place of the default model's set: the desktop app's (its
   * recognizer, its final pass, dictation), whose `defaults` are what its settings name, so a job
   * queue's fallback recognizer never reads as its default. Its `inUse` adds to what the queue's
   * jobs and Workers hold. Absent: the default model's set (a server).
   */
  ownerHeld?(): Held;
  /**
   * The owner's one-at-a-time line for a llama-server engine (Qwen): the desktop app's, which a
   * call's final pass also waits on, since a second llama-server on Metal stops the first. A job
   * on such an engine waits for its turn after its audio is read, and calls the function it gets
   * once its pass ends. Absent: no wait (a server's jobs share the GPU through `concurrency`).
   */
  gpuTurn?(jobId: string, signal: AbortSignal): Promise<() => void>;
  /** Test seams: the upload decoder and the delivery's network. */
  decode?: (path: string, signal: AbortSignal, maxSamples: number) => Promise<Float32Array>;
  delivery?: Partial<Omit<DelivererOptions, "store" | "secrets" | "hostListed" | "audit">>;
  now?: () => number;
  log(level: "info" | "warn" | "error", msg: string): void;
}

/**
 * Why a job that asks for speaker labels cannot have them, or null when it can: Nemotron runs in
 * the `akou-diarize` helper, which the app carries but a source checkout does not. Without it the
 * labels would be lost in silence, so the job fails and says what to do.
 */
export function diarizeHelperMissing(spec: ModelSpec): string | null {
  if (spec.kind !== "sherpa" || (spec.diarizer ?? "nemotron") !== "nemotron") return null;
  const helper = findHelper(spec.diarizeHelper ?? [], undefined, { name: DIARIZE_HELPER_NAME });
  if (helper.found) return null;
  return `speaker labels need the ${DIARIZE_HELPER_NAME} helper, and ${helper.command[0]} is not there: put it on PATH or set asr.diarizeHelper to it (docs/server.md says where to get it), set asr.diarizer to embeddings, or send the job without diarize`;
}

/** A job as a client sees it (SV-J3), with the download it waits on while queued (SV-M1). */
export function jobView(
  j: Job,
  waiting: Waiting | null = null,
  progress: JobProgress | null = null,
): Record<string, unknown> {
  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
  const finished = j.done_at ?? j.failed_at ?? j.cancelled_at;
  return {
    id: j.id,
    title: j.title,
    status: j.status,
    key_id: j.key_id,
    created_at: iso(j.created_at),
    started_at: iso(j.running_at),
    finished_at: iso(finished),
    preset: j.preset,
    model: j.model,
    model_source: j.model_source,
    priority: j.priority,
    interactive: j.interactive,
    keep_audio: j.keep_audio,
    language: j.language,
    languages: j.languages,
    diarize: j.diarize,
    metadata: j.metadata,
    ...(waiting ? { waiting_for: waiting } : {}),
    // A running job here says where it is (akou-5an.116); a done one, how long each stage took.
    ...(progress && j.status === "running" ? { progress } : {}),
    ...(j.result?.timings ? { timings: j.result.timings } : {}),
    ...(j.error ? { error: j.error } : {}),
    links: {
      self: `/v1/jobs/${j.id}`,
      result: `/v1/jobs/${j.id}/result`,
      events: "/v1/events",
      ...(j.keep_audio ? { audio: `/v1/jobs/${j.id}/audio` } : {}),
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

/**
 * The model ids a job ran, as the engine registry names them (SV-J4): a fused model's engines that
 * decoded (`rover-conf(a,b)` is `a` and `b`), else the recognizer, then the helpers; the speaker
 * models only when they ran, so a job whose labels failed does not name them.
 */
export function jobModels(recognizer: string, diarize: boolean, diarizer: DiarizerKind): string[] {
  const out = [...engineIds(recognizer), "silero-vad"];
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

/** What a client is told about a result that is less than it asked for. */
export function jobWarnings(pass: Pick<JobPassResult, "speakers" | "segments">): string[] {
  const { asked, labelled, error } = pass.speakers;
  if (!asked || labelled || pass.segments.length === 0) return [];
  return [
    error === null
      ? "speaker labels were asked for, but the speaker model found no turns: every speaker is null"
      : `speaker labels were asked for and failed: every speaker is null (${error})`,
  ];
}

/** The result of a job (SV-J4). */
export function jobResult(
  job: Job,
  pass: JobPassResult,
  engine: { version: string; models: string[] },
  timings?: JobTimings,
): Record<string, unknown> {
  return {
    job_id: job.id,
    status: "done",
    text: pass.text,
    // The engine's own guess first; Parakeet detects none, so the client's hint stands in.
    language: pass.language ?? (job.language === "auto" ? null : job.language),
    language_confidence: null,
    duration_s: pass.duration_s,
    // Parakeet gives word times; Qwen gives none, so its words' `s` and `e` are null.
    words: pass.words,
    segments: pass.segments,
    engine: {
      name: "akou",
      version: engine.version,
      preset: job.preset,
      models: engine.models,
      // The N-engine pass: which engines decoded, which were left out and why (ASR-6).
      ...(pass.fusion ? { fusion: pass.fusion } : {}),
    },
    confidence: pass.confidence,
    skipped: pass.skipped.map((x) => ({ s: x.s, e: x.e, reason: x.error })),
    speakers: pass.speakers,
    warnings: jobWarnings(pass),
    metadata: job.metadata,
    // Wall seconds per stage (akou-5an.115): reading the file, speaker labels, transcribing.
    ...(timings ? { timings } : {}),
  };
}

function failedData(job: Job, error: JobError): Record<string, unknown> {
  return { job_id: job.id, status: "failed", error, metadata: job.metadata };
}

type Waiter = (j: { id: string; status: JobStatus }) => void;

/** Where a queued job runs now: here, on a remote, or nowhere yet. */
export type Route = { where: "local" } | { where: "wait" } | { where: "remote"; url: string };

/**
 * Where a job goes when no remote that would take it has room: here when overflow is on, every
 * such remote is known to be full (`busy`) and this server can run it, else it waits. A remote not
 * probed yet (`pending`) may have room, so the job waits for its probe. A job only a remote can
 * run (`route` `remote`) always waits.
 */
export function overflowRoute(
  route: Job["route"],
  overflow: boolean,
  full: "busy" | "pending",
): Route {
  return overflow && full === "busy" && route !== "remote" ? { where: "local" } : { where: "wait" };
}

/** A job only a remote can run: the names sent to it (section 14). */
export interface RemoteChoice {
  model: string | null;
  preset: string;
  source: ModelSource;
}

export class JobService {
  readonly store: JobStore;
  private readonly deliverer: Deliverer;
  private readonly audioDir: string;
  private readonly now: () => number;
  private readonly slots: Slot[] = [];
  /** The dictation lane's Workers (DC-R2): they run interactive jobs only. */
  private readonly laneSlots: Slot[] = [];
  /** When each interactive job ended, for `served_last_hour`. */
  private served: number[] = [];
  private closed = false;
  /** Jobs that ended in this process: when, and the seconds of audio of a done one (SV-Q4). */
  private ended: { at: number; audio_s: number }[] = [];
  /** The running times of the last `MEAN_OF_JOBS` jobs this process ran, in ms. */
  private runTimes: number[] = [];
  private readonly waiters = new Map<string, Set<Waiter>>();
  /** Where each job running here is (akou-5an.116); dropped when it ends. */
  private readonly progress = new Map<string, JobProgress>();
  private readonly feedWatchers = new Set<(e: FeedEvent) => void>();
  private retention: ReturnType<typeof setInterval> | null = null;
  /** The next go of a retention sweep that had more jobs than one go removes, and its count so far. */
  private sweepMore: ReturnType<typeof setTimeout> | null = null;
  private swept = 0;
  /** Wakes `releaseIdle` when the next idle Worker's time is up. */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many times each queued job was passed over for a job on a loaded model. */
  private readonly passedOver = new Map<string, number>();
  /** The other akou servers jobs are sent to (section 14). */
  readonly remotes: Remotes;
  /** The jobs out on a remote now, and how to stop following one. */
  private readonly sent = new Map<string, { url: string; abort: AbortController }>();
  /** A job a remote turned away waits until then (monotonic ms) before it is sent again. */
  private readonly heldUntil = new Map<string, number>();
  private dispatching = false;

  /** When this process started the service: a job running from before is not timed. */
  private readonly startedAt: number;

  constructor(private readonly o: JobServiceOptions) {
    this.now = o.now ?? Date.now;
    this.remotes = new Remotes({
      entries: () => o.remotes?.() ?? [],
      env: o.env,
      fetch: o.remoteFetch,
      probeMs: o.remoteProbeMs,
      onChange: () => {
        this.dispatch();
        this.pump();
      },
      log: o.log,
    });
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
    this.remotes.start();
    this.dispatch();
    this.pump();
  }

  depth(): number {
    return this.store.depth();
  }

  private concurrency(): number {
    return Math.max(1, this.o.concurrency?.() ?? 1);
  }

  /** `server.dictation_slots`, bounded: the Workers of the dictation lane (DC-R2). */
  private laneSize(): number {
    const n = Math.floor(this.o.dictationSlots?.() ?? 0);
    return Number.isFinite(n) ? Math.min(MAX_DICTATION_SLOTS, Math.max(0, n)) : 0;
  }

  /** Whether a request that asks for `interactive` gets the dictation lane: only while it has slots. */
  interactive(asked: boolean): boolean {
    return asked && this.laneSize() > 0;
  }

  /** `server.dictation_engine`, `auto` when unset. */
  dictationEngine(): string {
    return this.o.dictationEngine?.()?.trim() || "auto";
  }

  /**
   * The engine a dictation that names none runs (DC-R4): `server.dictation_engine` resolved, so
   * `auto` reports the preset it picks, and a recognizer id outside the presets reports itself. A
   * setting that cannot run reports as written; the dictation itself gets the refusal.
   */
  private laneEngine(): string {
    const setting = this.dictationEngine();
    try {
      const c = this.choose({ preset: setting });
      return c.preset === "custom" ? c.model : c.preset;
    } catch {
      return setting;
    }
  }

  /** The dictation lane as `GET /v1/server` reports it (DC-R2). */
  dictationStats(): DictationStats {
    const since = this.now() - THROUGHPUT_WINDOW_MS;
    this.served = this.served.filter((t) => t > since);
    return {
      slots: this.laneSize(),
      engine: this.laneEngine(),
      served_last_hour: this.served.length,
    };
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
      loaded: this.loaded(),
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
   * The model a request runs: its `model`, its `preset`, `server.default_model`, then what `auto`
   * runs here. Throws `ModelRefused`; `unknownIsAuto` is the OpenAI door's leniency.
   */
  choose(ask: { model?: string; preset?: string }, unknownIsAuto = false): ModelChoice {
    return resolveModel(ask, {
      catalog: this.o.shelf.catalog(),
      defaultModel: this.o.defaultModel(),
      fusion: this.o.fusion?.(),
      unknownIsAuto,
      auto: () => this.auto(),
    });
  }

  /** What `auto` runs here now. */
  private auto(): { model: string; preset: string } {
    return this.o.auto?.() ?? hardwareChoice();
  }

  /** The recognizer a request with no opinion runs; the hardware's when the setting is unusable. */
  defaultRecognizer(): string {
    try {
      return this.choose({}).model;
    } catch {
      return this.auto().model;
    }
  }

  /**
   * Whether a job on `model` can be had: its files on disk, downloading, or allowed to start (SV-M1,
   * SV-M2). Throws `ModelRefused`; the route answers it before the upload is kept. Given the `job`,
   * only the models it runs count: no live-only model, the speaker models only with diarize.
   */
  admit(model: string, job?: { diarize: boolean }): void {
    this.o.shelf.admit(this.o.shelf.needs(model, job));
  }

  private modelOf(j: Job): string {
    return j.model ?? this.defaultRecognizer();
  }

  /** The models a job needs on this server's disk: none for one only a remote can run. */
  private localNeeds(j: Job): string[] {
    return j.route === "remote" ? [] : this.o.shelf.needs(this.modelOf(j), j);
  }

  /** The job as a client sees it, with its download's progress while it waits. */
  view(j: Job): Record<string, unknown> {
    const waiting =
      j.status === "queued" && j.route !== "remote"
        ? this.o.shelf.waiting(this.localNeeds(j))
        : null;
    return jobView(j, waiting, this.progress.get(j.id) ?? null);
  }

  /**
   * A job this server cannot run, as a remote that has offered it would take it (section 14): the
   * request's `model`, its `preset`, `server.default_model`, then the hardware's preset, first
   * named wins. Null when no remote has offered that name since start.
   */
  remoteChoice(ask: { model?: string; preset?: string }): RemoteChoice | null {
    const named = (v: string | undefined, source: ModelSource) => {
      const x = (v ?? "").trim();
      return x === "" || x === "auto" ? null : { name: x, source };
    };
    const n = named(ask.model, "request") ??
      named(ask.preset, "request") ??
      named(this.o.defaultModel(), "server_default") ?? {
        name: this.auto().preset,
        source: "hardware" as const,
      };
    if (!this.remotes.offered([n.name])) return null;
    const preset = (PRESET_NAMES as readonly string[]).includes(n.name);
    return {
      model: preset ? null : n.name,
      preset: preset ? n.name : "custom",
      source: n.source,
    };
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

  /** The recognizers the job Workers hold loaded now, the queue's and the dictation lane's. */
  loaded(): string[] {
    const ids = [...this.slots, ...this.laneSlots]
      .filter((s) => s.worker && s.model)
      .map((s) => s.model as string);
    return [...new Set(ids)];
  }

  /** Every queued job waiting on `model` fails: its download failed for good (SV-M3). */
  private failWaiting(model: string, cause: string): void {
    for (const j of this.store.queued()) {
      if (!this.localNeeds(j).includes(model)) continue;
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
   * A new job, the key's existing one for the same idempotency key, file and options, a conflict
   * naming what differs when the same key comes with another file or options (SV-J2), or a refusal
   * when the queue is full (SV-Q3). The limit's check and the insert are one transaction, so two
   * submits racing for the last place make one job.
   */
  submit(
    j: NewJob,
  ): { job: Job; existing: boolean } | { conflict: Job; fields: string[] } | { full: QueueFull } {
    // A dictation takes the lane when there is one: no queue limit, never a remote (DC-R2).
    const lane = this.interactive(j.interactive === true);
    const row: NewJob = lane
      ? { ...j, interactive: true, route: "local" }
      : { ...j, interactive: false };
    const r = this.store.db.transaction(() => {
      const full = lane ? null : this.queueFull(j.key_id, j.idempotency_key);
      return full ? { full } : this.store.submit(row);
    })();
    if ("full" in r) {
      rmSync(j.audio, { force: true });
      return r;
    }
    if (r.existing) {
      rmSync(j.audio, { force: true });
      const fields = requestDiffers(r.job, j);
      if (fields.length > 0) return { conflict: r.job, fields };
      return r;
    }
    this.o.log("info", `job.created ${r.job.id} key ${r.job.key_id}`);
    this.dispatch();
    this.pump();
    return r;
  }

  /** The job, when the caller may see it: its own, or any for an admin. */
  get(who: Identity, id: string): Job | null {
    const j = this.store.job(id);
    return j && this.visible(who, j.key_id) ? j : null;
  }

  /**
   * Whether the caller once had this job and the server no longer holds it: deleted by a client or
   * past `server.retain_days`. False for an id that never was, or another key's.
   */
  gone(who: Identity, id: string): boolean {
    if (this.store.job(id)) return false;
    const key = this.store.formerKey(id);
    return key !== null && this.visible(who, key);
  }

  /** `server.retain_days`: how long a job is kept, from its creation. */
  retainDays(): number {
    return this.o.retainDays();
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
    o: { key?: string; status?: JobStatus; q?: string; before?: number; limit: number },
  ): Job[] {
    const admin = who.scopes.includes("admin");
    if (!admin && o.key !== undefined && o.key !== who.id) return [];
    return this.store.list({ ...o, key: admin ? (o.key ?? null) : who.id });
  }

  /**
   * Names or renames a job the caller may see, in any state; null when it cannot see one by that
   * id. The name is the job's own: the result, the feed and a remote's copy never carry it.
   */
  rename(who: Identity, id: string, title: string): Job | null {
    const j = this.get(who, id);
    if (!j || !this.store.rename(j.id, title)) return null;
    return this.store.job(j.id);
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
    return r ? this.dropped(r) : null;
  }

  /** What a removed job leaves outside the store: its Worker, its remote copy, its files, its waiters. */
  private dropped(r: { job: Job; final: JobStatus }): { id: string; status: JobStatus } {
    const id = r.job.id;
    const slot = [...this.slots, ...this.laneSlots].find((s) => s.job?.id === id);
    if (slot) {
      slot.job?.abort.abort();
      slot.worker?.cancel("the job was deleted");
      // The slot is free now: an aborted run touches neither it nor its Worker again.
      slot.job = null;
      slot.idleSince = this.now();
    }
    this.heldUntil.delete(id);
    this.passedOver.delete(id);
    // A job sent to a remote is deleted there too, so its audio and text do not outlive it.
    this.sent.get(id)?.abort.abort();
    if (r.job.remote && r.job.remote_job) this.remotes.cancel(r.job.remote, r.job.remote_job);
    if (r.job.audio) rmSync(r.job.audio, { force: true });
    if (r.job.kept) rmSync(r.job.kept, { force: true });
    this.notify(id, r.final);
    if (r.final === "cancelled") this.announce(id);
    if (slot) this.pump();
    return { id, status: r.final };
  }

  /**
   * The hourly sweep: jobs past `server.retain_days`, then models unused for
   * `server.models_unused_days` (SV-M5). Returns the number of jobs removed before it returns: at
   * most `SWEEP_BATCH`, the rest following in goes of their own (`sweepJobs`).
   */
  sweep(): number {
    const n = this.sweepJobs();
    this.sweepModels();
    return n;
  }

  /**
   * The default's set (or the owner's own, `ownerHeld`), and what a queued or running job or the
   * live worker needs.
   */
  held(): Held & { defaults: Set<string>; inUse: Set<string> } {
    const shelf = this.o.shelf;
    const owner = this.o.ownerHeld?.();
    const defaults = new Set(owner ? owner.defaults : shelf.needs(this.defaultRecognizer()));
    const inUse = new Set<string>(owner?.inUse ?? []);
    for (const j of [...this.store.queued(), ...this.store.running()]) {
      for (const id of this.localNeeds(j)) inUse.add(id);
    }
    for (const s of [...this.slots, ...this.laneSlots]) {
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

  /**
   * Every job older than `server.retain_days` is deleted as a client's delete would, except a job
   * that keeps its audio, which only a client's delete removes.
   */
  private sweepJobs(): number {
    if (this.sweepMore) clearTimeout(this.sweepMore);
    this.sweepMore = null;
    const before = this.now() - this.o.retainDays() * DAY_MS;
    const ids = this.store.expired(before, SWEEP_BATCH);
    const until = performance.now() + SWEEP_SLICE_MS;
    const removed = this.store.db.transaction(() => {
      const out: { job: Job; final: JobStatus }[] = [];
      for (const id of ids) {
        const r = this.store.remove(id);
        if (r) out.push(r);
        if (performance.now() >= until) break;
      }
      return out;
    })();
    for (const r of removed) this.dropped(r);
    this.swept += removed.length;
    if (removed.length > 0 && (removed.length < ids.length || ids.length === SWEEP_BATCH)) {
      // clock: the next go runs as soon as the requests waiting on this thread have been answered.
      this.sweepMore = setTimeout(() => {
        if (!this.closed) this.sweepJobs();
      }, 0);
      return removed.length;
    }
    this.store.scrubCancelled(before);
    if (this.swept > 0)
      this.o.log(
        "info",
        `jobs: retention removed ${this.swept} job(s) older than ${this.o.retainDays()} days`,
      );
    this.swept = 0;
    return removed.length;
  }

  // -------------------------------------------------------------------------
  // The feed

  /** The feed's id (SV-E1): a new one means a new jobs.db, whose cursors start at 0 again. */
  get feedId(): string {
    return this.store.feedId;
  }

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
   * loaded, else an empty one, else a new one while there is room for it, else any idle one,
   * whose Worker is rebuilt.
   */
  private slotFor(model: string, slots: Slot[], room: number): Slot {
    const idle = slots.filter((s) => !s.job);
    const slot =
      idle.find((s) => s.worker && s.model === model) ??
      idle.find((s) => !s.worker) ??
      (slots.length < room ? undefined : idle[0]);
    if (slot) return slot;
    const fresh: Slot = { worker: null, spec: "", model: null, job: null, idleSince: null };
    slots.push(fresh);
    return fresh;
  }

  private idleMs(): number {
    const m = this.o.modelIdleMinutes?.() ?? MODEL_IDLE_MINUTES;
    return Number.isFinite(m) ? Math.max(0, m) * 60_000 : 0;
  }

  /**
   * Closes the idle Workers whose time is up: an idle Worker keeps its models while a queued job
   * needs them, and where idle Workers are kept warm (a server) for `server.model_idle_minutes`
   * after its last job; at most as many Workers as `server.concurrency` stay. So consecutive jobs
   * reuse one model load, and an idle box gets its memory back. The desktop app keeps no idle
   * Worker: one no queued job needs is closed at once. The idle timer calls it; a test with its own
   * clock calls it too.
   */
  releaseIdle(): void {
    if (this.closed) return;
    let kept = this.slots.filter((s) => s.job).length;
    const room = this.concurrency();
    const queued = this.store.queued();
    const warm = this.o.keepIdleWorkers?.() ?? true;
    const idleMs = this.idleMs();
    const now = this.now();
    let wake = Number.POSITIVE_INFINITY;
    for (const s of this.slots) {
      if (s.job || !s.worker) continue;
      const needed = s.model !== null && queued.some((j) => this.modelOf(j) === s.model);
      const left = idleMs - (now - (s.idleSince ?? now));
      // Kept warm (a server) for its idle minutes; the desktop app keeps none.
      if ((needed || (warm && s.model !== null && left > 0)) && kept < room) {
        kept++;
        if (!needed) wake = Math.min(wake, left);
        continue;
      }
      if (!needed && s.model !== null && idleMs > 0 && left <= 0) {
        this.o.log("info", `jobs: ${s.model} unloaded after ${idleMs / 60_000} min with no job`);
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (Number.isFinite(wake)) {
      // clock: wakes when the next idle Worker's time is up; the check reads the service's clock.
      this.idleTimer = setTimeout(() => this.releaseIdle(), Math.max(1000, wake));
      this.idleTimer.unref?.();
    }
  }

  /** Whether a model's engine runs on a Metal llama-server (Qwen on Apple silicon). */
  private onMetal(model: string): boolean {
    try {
      return this.o.models(model)?.final?.accelerator === "metal";
    } catch {
      return false;
    }
  }

  /** A job on a Metal llama-server runs now, in any Worker (the queue's or the lane's). */
  private metalBusy(): boolean {
    return [...this.slots, ...this.laneSlots].some((s) => s.job && this.onMetal(s.job.model));
  }

  /**
   * The next queued job whose models are on disk, in the queue's order. A job whose models are
   * missing starts their download and waits, holding no worker (SV-M1). A job on a Metal
   * llama-server waits while another one runs. Among the jobs of the first one's priority, a job
   * on a model an idle Worker holds goes first, unless the first was passed over
   * `WARM_PASS_LIMIT` times already.
   */
  private nextRunnable(): Job | null {
    const lane = this.laneSize() > 0;
    const warm = new Set(
      this.slots.filter((s) => !s.job && s.worker && s.model).map((s) => s.model as string),
    );
    let head: Job | null = null;
    for (const j of this.store.queued()) {
      // The lane's jobs are the lane's while it has slots; with none, they queue as any other.
      if (lane && j.interactive) continue;
      if (this.routeOf(j).where !== "local") continue;
      if (head && j.priority !== head.priority) break;
      const needs = this.localNeeds(j);
      if (this.o.shelf.missing(needs).length > 0) {
        if (!head) this.o.shelf.fetch(needs);
        continue;
      }
      const model = this.modelOf(j);
      if (this.onMetal(model) && this.metalBusy()) continue;
      if (!head) {
        head = j;
        if (warm.size === 0 || warm.has(model)) return j;
        if ((this.passedOver.get(j.id) ?? 0) >= WARM_PASS_LIMIT) return j;
        continue;
      }
      if (warm.has(model)) {
        this.passedOver.set(head.id, (this.passedOver.get(head.id) ?? 0) + 1);
        return j;
      }
    }
    return head;
  }

  /**
   * The next interactive job whose models are on disk, oldest first: a dictation is answered in the
   * order it arrived, whatever its `priority` (DC-R2).
   */
  private nextInteractive(): Job | null {
    const queued = this.store.queued().filter((j) => j.interactive);
    queued.sort((a, b) => a.seq - b.seq);
    for (const j of queued) {
      const needs = this.localNeeds(j);
      if (this.o.shelf.missing(needs).length > 0) {
        this.o.shelf.fetch(needs);
        continue;
      }
      if (this.onMetal(this.modelOf(j)) && this.metalBusy()) continue;
      return j;
    }
    return null;
  }

  /** Starts interactive jobs while a lane Worker is free; idle lane Workers keep their model. */
  private pumpLane(): void {
    const size = this.laneSize();
    while (this.laneSlots.filter((s) => s.job).length < size) {
      const next = this.nextInteractive();
      if (!next) break;
      this.start1(next, this.laneSlots, size);
    }
    // Past a lower `server.dictation_slots`, idle lane Workers go.
    for (let i = this.laneSlots.length - 1; i >= 0 && this.laneSlots.length > size; i--) {
      const s = this.laneSlots[i] as Slot;
      if (s.job) continue;
      s.worker?.close();
      this.laneSlots.splice(i, 1);
    }
  }

  /** Marks one queued job running in a slot of `slots`, and runs it. */
  private start1(next: Job, slots: Slot[], room: number): void {
    const job = this.store.markRunning(next.id);
    if (job?.status !== "running") return;
    this.passedOver.delete(job.id);
    const model = this.modelOf(job);
    const slot = this.slotFor(model, slots, room);
    const abort = new AbortController();
    slot.job = { id: job.id, abort, model };
    slot.idleSince = null;
    this.notify(job.id, "running");
    void this.run(job, slot, abort).finally(() => {
      if (slot.job?.id === job.id) {
        slot.job = null;
        slot.idleSince = this.now();
      }
      this.pump();
    });
  }

  /** Starts queued jobs while a slot is free, up to `server.concurrency` at once. */
  private pump(): void {
    if (this.closed) return;
    this.pumpLane();
    while (this.slots.filter((s) => s.job).length < this.concurrency()) {
      const next = this.nextRunnable();
      if (!next) break;
      this.start1(next, this.slots, this.concurrency());
    }
    this.releaseIdle();
  }

  private async run(job: Job, slot: Slot, abort: AbortController): Promise<void> {
    let end:
      | { status: "done"; result: Record<string, unknown> }
      | { status: "failed"; error: JobError };
    const model = this.modelOf(job);
    const needs = this.o.shelf.needs(model, job);
    // A model is used when a job on it starts and when it ends (SV-M4).
    this.o.shelf.touch(needs);
    // The GPU line's turn, once taken (`gpuTurn`); given back however the run ends.
    let release: (() => void) | null = null;
    try {
      const spec = this.o.models(model);
      if (!spec)
        throw Object.assign(
          new Error("the speech models are not downloaded; run `akou models pull`"),
          { code: "models_missing" },
        );
      const helperless = job.diarize ? diarizeHelperMissing(spec) : null;
      if (helperless) throw Object.assign(new Error(helperless), { code: "diarize_unavailable" });
      let samples: Float32Array;
      this.progress.set(job.id, { stage: "decode", done_s: 0, total_s: null });
      const decodeFrom = performance.now();
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
      const decodeS = Math.round(performance.now() - decodeFrom) / 1000;
      this.progress.set(job.id, {
        stage: job.diarize ? "diarize" : "transcribe",
        done_s: 0,
        total_s: Math.round((samples.length / ASR_RATE) * 1000) / 1000,
      });
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
      // Read before the run: the samples' buffer is handed to the Worker, which empties it here.
      const audioS = samples.length / ASR_RATE;
      // A llama-server engine waits for the owner's GPU line (the desktop app's final passes),
      // whether it is the job's one final engine or one engine of a fused pass.
      if (takesGpuTurn(spec) && this.o.gpuTurn) {
        release = await this.o.gpuTurn(job.id, abort.signal);
        if (abort.signal.aborted) return;
      }
      const pass = await this.workerFor(slot, spec, model).run({
        samples,
        diarize: job.diarize,
        decode: decode && modelKind(decode.model) === "transducer" ? decode : null,
        language: job.language,
        glossary: job.keywords,
        progress: (p) => {
          if (this.progress.has(job.id)) this.progress.set(job.id, p);
        },
        languages: job.languages,
      });
      const recognizer = pass.model ?? modelNameFor(spec);
      // This machine's speed on the model, for the Models page (SV-U6): decode time over audio
      // time, without the model loads or the speaker labels. A fused job times each engine.
      if (pass.fusion) {
        for (const e of pass.fusion.engines) this.o.shelf.recordRun(e.id, audioS, e.decode_s);
      } else if (pass.decode_s !== undefined) {
        this.o.shelf.recordRun(model, audioS, pass.decode_s);
      }
      end = {
        status: "done",
        result: jobResult(
          job,
          pass,
          {
            version: this.o.version,
            // The speaker models are named only when they ran: not after a missing helper or a
            // missed deadline, nor on a file with no speech for them.
            models: jobModels(recognizer, pass.diarized, this.o.diarizer()),
          },
          {
            decode_s: decodeS,
            diarize_s: pass.stages?.diarize_s ?? null,
            transcribe_s: pass.stages?.transcribe_s ?? 0,
          },
        ),
      };
    } catch (err) {
      if (abort.signal.aborted) return;
      const code = (err as { code?: string }).code ?? "transcription_failed";
      end = { status: "failed", error: { code, message: (err as Error).message } };
    } finally {
      release?.();
      this.o.shelf.touch(needs);
      this.progress.delete(job.id);
    }
    this.conclude(job, end);
  }

  /** A running job's end: the store, its event and delivery, its upload deleted, the watchers. */
  private conclude(
    job: Job,
    end:
      | { status: "done"; result: Record<string, unknown> }
      | { status: "failed"; error: JobError },
    remote: string | null = null,
  ): void {
    // A queued job that ends without starting (a failed download, a remote's answer) is not
    // passed over again.
    this.passedOver.delete(job.id);
    const r =
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
    // A job that keeps its audio holds the upload from now on (`kept`), until it is deleted.
    if (job.audio && !job.keep_audio) rmSync(job.audio, { force: true });
    if (!r) return;
    this.measure(job, end);
    this.o.log(
      end.status === "done" ? "info" : "warn",
      remote === null
        ? `job.${end.status} ${job.id} key ${job.key_id} model ${this.modelOf(job)}`
        : `job.${end.status} ${job.id} key ${job.key_id} model ${job.model ?? job.preset} on ${remote}`,
    );
    this.notify(job.id, end.status);
    const e = r.event;
    if (e) for (const fn of [...this.feedWatchers]) fn(e);
    if (job.callback_url) this.deliverer.kick();
  }

  // -------------------------------------------------------------------------
  // Remotes (section 14)

  /** The names a remote is asked for: the preset and the model, or what only a remote can run. */
  private namesOf(j: Job): string[] {
    if (j.route === "remote") return [j.model ?? j.preset];
    return [j.preset, j.model].filter((n): n is string => !!n && n !== "custom" && n !== "auto");
  }

  /**
   * Where a queued job runs now. A job only a remote can run waits for one that is up and offers
   * it; a job a remote entry names goes there first while it is up and offers it, and runs here
   * otherwise; every other job runs here. With `server.remotes_overflow` on, a job a remote entry
   * names also runs here while every remote that would take it is busy, instead of waiting.
   */
  private routeOf(j: Job): Route {
    if (j.route === "local" || !this.remotes.configured()) return { where: "local" };
    const names = this.namesOf(j);
    // Back to the remote that already has it, so a returning remote's copy is followed, not redone.
    if (j.remote && this.remotes.up(j.remote, names)) return { where: "remote", url: j.remote };
    const url = this.remotes.pick(names, j.route !== "remote");
    if (url === "busy" || url === "pending")
      return overflowRoute(j.route, this.o.remotesOverflow?.() ?? false, url);
    if (url !== null) return { where: "remote", url };
    return j.route === "remote" ? { where: "wait" } : { where: "local" };
  }

  /** A setting that changes where a queued job runs was saved: route the queue again now. */
  reroute(): void {
    this.dispatch();
    this.pump();
  }

  /** Sends every queued job whose route is a remote to it, while each remote has room. */
  private dispatch(): void {
    if (this.closed || this.dispatching || !this.remotes.configured()) return;
    this.dispatching = true;
    try {
      for (const j of this.store.queued()) {
        if ((this.heldUntil.get(j.id) ?? 0) > performance.now()) continue;
        const r = this.routeOf(j);
        if (r.where !== "remote" || !this.store.claim(j.id)) continue;
        this.heldUntil.delete(j.id);
        const abort = new AbortController();
        this.remotes.hold(r.url);
        this.sent.set(j.id, { url: r.url, abort });
        this.notify(j.id, "running");
        void this.runRemote({ ...j, status: "running" }, r.url, abort);
      }
    } finally {
      this.dispatching = false;
    }
  }

  /** What a remote is sent: the names, the options, the audio; never the metadata or callback. */
  private remoteJob(j: Job): RemoteJob {
    const preset = j.route === "remote" ? (j.model === null ? j.preset : undefined) : j.preset;
    return {
      id: j.id,
      audio: j.audio as string,
      preset: preset === "custom" ? undefined : preset,
      model: j.model ?? undefined,
      language: j.language,
      keywords: j.keywords,
      languages: j.languages,
      diarize: j.diarize,
    };
  }

  /**
   * Sends one job to a remote, or finds the copy it already has, and follows it there to its end.
   * The remote's result is this job's result under this job's id and metadata. A remote that stops
   * answering puts the job back in the queue; one that refuses it sends it elsewhere or here.
   */
  private async runRemote(job: Job, url: string, abort: AbortController): Promise<void> {
    let rid = job.remote === url ? job.remote_job : null;
    try {
      if (rid === null) {
        rid = await this.remotes.submit(url, this.remoteJob(job), abort.signal);
        this.store.setRemote(job.id, url, rid);
        this.o.log("info", `job.sent ${job.id} to ${url} as ${rid}`);
      }
      for (;;) {
        const s = await this.remotes.job(url, rid, REMOTE_WAIT_S, abort.signal);
        if (s.status === "done") {
          const result = await this.remotes.result(url, rid, abort.signal);
          if (abort.signal.aborted) return;
          this.conclude(
            job,
            {
              status: "done",
              result: { ...result, job_id: job.id, status: "done", metadata: job.metadata },
            },
            url,
          );
          return;
        }
        if (s.status === "failed") {
          this.conclude(
            job,
            {
              status: "failed",
              error: s.error ?? { code: "transcription_failed", message: `it failed on ${url}` },
            },
            url,
          );
          return;
        }
        if (s.status === "cancelled") {
          throw new RemoteError("lost", `${url} no longer has the job (${s.status})`);
        }
      }
    } catch (err) {
      if (abort.signal.aborted || this.closed) return;
      const e = err instanceof RemoteError ? err : new RemoteError("down", (err as Error).message);
      this.o.log("warn", `job.returned ${job.id} from ${url}: ${e.message}`);
      if (e.kind === "lost") {
        this.store.setRemote(job.id, null, null);
      } else if (e.kind === "rejected") {
        this.store.setRemote(job.id, null, null);
        if (e.status === 409) {
          // The remote no longer offers it: asked again after its next probe.
          this.heldUntil.set(job.id, performance.now() + (this.o.remoteProbeMs ?? 30_000));
          void this.remotes.probeAll();
        } else if (job.route === "remote") {
          this.conclude(job, {
            status: "failed",
            error: { code: e.code ?? "remote_refused", message: e.message },
          });
          return;
        } else {
          this.store.setRoute(job.id, "local");
        }
      } else {
        this.remotes.failed(url, e);
      }
      this.store.requeue(job.id);
    } finally {
      this.sent.delete(job.id);
      this.remotes.release(url);
      if (!this.closed) {
        this.dispatch();
        this.pump();
      }
    }
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
    // A dictation is the lane's, not the queue's: it counts in `served_last_hour` only.
    if (job.interactive) {
      this.served.push(now);
      this.served = this.served.filter((t) => t > now - THROUGHPUT_WINDOW_MS);
      return;
    }
    const audio = end.status === "done" ? Number(end.result.duration_s) : 0;
    this.ended.push({ at: now, audio_s: Number.isFinite(audio) ? audio : 0 });
    this.ended = this.ended.filter((e) => e.at > now - THROUGHPUT_WINDOW_MS);
    if (job.running_at !== null && job.running_at >= this.startedAt) {
      this.runTimes.push(Math.max(0, now - job.running_at));
      if (this.runTimes.length > MEAN_OF_JOBS) this.runTimes.shift();
    }
  }

  /**
   * Stops the queue. `keepShelf` leaves the model store open: the desktop app shares it with the
   * Models page, so a queue that failed to start must not take the store down with it.
   */
  close(o: { keepShelf?: boolean } = {}): void {
    if (this.closed) return;
    this.closed = true;
    this.remotes.close();
    for (const s of this.sent.values()) s.abort.abort();
    if (this.retention) clearInterval(this.retention);
    if (this.sweepMore) clearTimeout(this.sweepMore);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.deliverer.close();
    for (const s of [...this.slots, ...this.laneSlots]) {
      s.job?.abort.abort();
      s.worker?.close();
      s.worker = null;
    }
    if (!o.keepShelf) this.o.shelf.close();
    this.store.close();
  }
}

/**
 * Whether a job on this spec decodes on llama-server (Qwen) and so waits its turn on the owner's
 * GPU line: as the spec's final engine, or as one engine of its fused pass.
 */
export function takesGpuTurn(spec: ModelSpec): boolean {
  return (
    Boolean(spec.final) || (spec.fusion?.engines.some((e) => e.kind === "llama-server") ?? false)
  );
}

const REQUEST_FIELDS = [
  "preset",
  "model",
  "language",
  "keywords",
  "languages",
  "diarize",
] as const satisfies readonly (keyof JobRequest)[];

/**
 * The options as compared, not as stored: keywords and languages in any order and a language tag
 * in any case (BCP-47 tags are case-insensitive) make the same transcript, so they are the same
 * request. The row keeps the options as sent, so a job stored before this compares the same way;
 * one stored before `languages[]` existed compares as a request with none.
 */
function comparable(r: JobRequest): JobRequest {
  return {
    ...r,
    language: r.language.toLowerCase(),
    keywords: [...new Set(r.keywords)].sort(),
    languages: [...new Set((r.languages ?? []).map((l) => l.toLowerCase()))].sort(),
  };
}

/**
 * What a repeated `Idempotency-Key` changed against the job it names (SV-J2): `file` when the
 * upload differs, then each option of `JobRequest` sent otherwise. Empty for a plain retry. A job
 * stored before the options were kept is compared by its file only.
 */
export function requestDiffers(held: Job, j: NewJob): string[] {
  const fields: string[] = held.file_sha256 === j.file_sha256 ? [] : ["file"];
  if (!held.request || !j.request) return fields;
  const a = comparable(held.request);
  const b = comparable(j.request);
  for (const k of REQUEST_FIELDS) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) fields.push(k);
  }
  return fields;
}
