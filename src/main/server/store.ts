/**
 * The job store of server mode (docs/ux/SERVER.md SV-J9): one SQLite file, `jobs.db`, opened with
 * `bun:sqlite`, holding three tables and nothing else.
 *
 * - `jobs`: one row per job, from submit until the client deletes it or retention does. The
 *   uploaded audio is a file beside the database, named in the row, deleted when the job ends.
 * - `events`: the per-key feed (SV-E1), one row per outcome, in the order they happened. A deleted
 *   job keeps its events with the job id and the final state only.
 * - `outbox`: one row per webhook delivery (SV-E5), written in the same transaction as its event,
 *   so the delivery and its attempt count are on disk before the first try.
 *
 * Every state change is one transaction. The call event log is never touched, and a job never
 * creates a call folder. The tables use SQLite's row id as their order (`seq`), with no
 * AUTOINCREMENT, which would add a fourth table.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export const JOBS_DB = "jobs.db";

export const JOB_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATES)[number];

export const EVENT_TYPES = [
  "transcription.completed",
  "transcription.failed",
  "transcription.cancelled",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface JobError {
  code: string;
  message: string;
}

export interface Job {
  id: string;
  /** Submit order. */
  seq: number;
  /** The key that submitted it (`app` for the app's token). */
  key_id: string;
  status: JobStatus;
  preset: string;
  /** The recognizer id the job runs (SV-S1); null for a job from before the field existed. */
  model: string | null;
  /** Who chose it: `request`, `server_default` or `hardware`. */
  model_source: string | null;
  /**
   * `remote` for a job only a remote akou can run (section 14): `model` and `preset` are then the
   * names sent to it, which this server's catalog may not have. `local`: a job a remote sent here,
   * or one a remote refused, which is never forwarded. Null: here, or a remote that lists it.
   */
  route: "remote" | "local" | null;
  /** The remote the job was last sent to, and its id there; kept while that remote is down. */
  remote: string | null;
  remote_job: string | null;
  language: string;
  keywords: string[];
  diarize: boolean;
  callback_url: string | null;
  /** The client's JSON, echoed back untouched. */
  metadata: unknown;
  idempotency_key: string | null;
  file_sha256: string;
  /** The uploaded file on disk, until the job ends. */
  audio: string | null;
  created_at: number;
  running_at: number | null;
  /** How many times a process started this job; a job left running is queued again once. */
  starts: number;
  done_at: number | null;
  failed_at: number | null;
  cancelled_at: number | null;
  result: Record<string, unknown> | null;
  error: JobError | null;
}

export interface FeedEvent {
  /** The cursor. */
  seq: number;
  /** `msg_…`: the event's id, and its webhook's `webhook-id` (SV-E2). */
  id: string;
  key_id: string;
  type: EventType;
  job_id: string;
  /** Epoch ms. */
  at: number;
  data: Record<string, unknown>;
}

export type OutboxState = "pending" | "delivered" | "failed" | "disabled" | "refused";

export interface Delivery {
  event_id: string;
  key_id: string;
  url: string;
  /** Tries made so far. */
  attempts: number;
  /** When the next try is due, epoch ms; null once the delivery is over. */
  next_at: number | null;
  state: OutboxState;
  last_status: number | null;
  last_error: string | null;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of time then 80 random bits, Crockford base32, so ids sort by creation. */
export function ulid(now: number): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = (CROCKFORD[t % 32] as string) + time;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(10);
  let bits = 0;
  let acc = 0;
  let rand = "";
  for (const b of r) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      rand += CROCKFORD[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return time + rand;
}

/**
 * The most event data one feed page holds (SV-E1), past its first event: a completed event carries
 * its result inline up to 256 KB, so a page of a thousand could be hundreds of MB.
 */
export const FEED_PAGE_BYTES = 1_048_576;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL,
  preset TEXT NOT NULL,
  language TEXT NOT NULL,
  keywords TEXT NOT NULL,
  diarize INTEGER NOT NULL,
  callback_url TEXT,
  metadata TEXT NOT NULL,
  idempotency_key TEXT,
  file_sha256 TEXT NOT NULL,
  audio TEXT,
  created_at INTEGER NOT NULL,
  running_at INTEGER,
  starts INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  failed_at INTEGER,
  cancelled_at INTEGER,
  result TEXT,
  error TEXT,
  model TEXT,
  model_source TEXT,
  route TEXT,
  remote TEXT,
  remote_job TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON jobs (key_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, seq);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL,
  type TEXT NOT NULL,
  job_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_key ON events (key_id, seq);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id);
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  url TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_at INTEGER,
  state TEXT NOT NULL,
  last_status INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (state, next_at);
`;

type Row = Record<string, string | number | null>;

function jobOf(r: Row): Job {
  return {
    id: r.id as string,
    seq: r.seq as number,
    key_id: r.key_id as string,
    status: r.status as JobStatus,
    preset: r.preset as string,
    model: (r.model as string | null) ?? null,
    model_source: (r.model_source as string | null) ?? null,
    route: r.route === "remote" || r.route === "local" ? r.route : null,
    remote: (r.remote as string | null) ?? null,
    remote_job: (r.remote_job as string | null) ?? null,
    language: r.language as string,
    keywords: JSON.parse(r.keywords as string),
    diarize: r.diarize === 1,
    callback_url: (r.callback_url as string | null) ?? null,
    metadata: JSON.parse(r.metadata as string),
    idempotency_key: (r.idempotency_key as string | null) ?? null,
    file_sha256: r.file_sha256 as string,
    audio: (r.audio as string | null) ?? null,
    created_at: r.created_at as number,
    running_at: (r.running_at as number | null) ?? null,
    starts: (r.starts as number | null) ?? 0,
    done_at: (r.done_at as number | null) ?? null,
    failed_at: (r.failed_at as number | null) ?? null,
    cancelled_at: (r.cancelled_at as number | null) ?? null,
    result: r.result === null ? null : JSON.parse(r.result as string),
    error: r.error === null ? null : JSON.parse(r.error as string),
  };
}

function eventOf(r: Row): FeedEvent {
  return {
    seq: r.seq as number,
    id: r.id as string,
    key_id: r.key_id as string,
    type: r.type as EventType,
    job_id: r.job_id as string,
    at: r.at as number,
    data: JSON.parse(r.data as string),
  };
}

function deliveryOf(r: Row): Delivery {
  return {
    event_id: r.event_id as string,
    key_id: r.key_id as string,
    url: r.url as string,
    attempts: r.attempts as number,
    next_at: (r.next_at as number | null) ?? null,
    state: r.state as OutboxState,
    last_status: (r.last_status as number | null) ?? null,
    last_error: (r.last_error as string | null) ?? null,
  };
}

export interface NewJob {
  key_id: string;
  preset: string;
  /** The recognizer the job runs (SV-S1); absent, the server's default at run time. */
  model?: string | null;
  model_source?: string | null;
  /** `remote`: only a remote akou can run it; `local`: never forwarded (section 14). */
  route?: "remote" | "local" | null;
  language: string;
  keywords: string[];
  diarize: boolean;
  callback_url: string | null;
  metadata: unknown;
  idempotency_key: string | null;
  file_sha256: string;
  audio: string;
}

/** An outcome to record with a job's last state change: its feed event, and its delivery. */
export interface Outcome {
  type: EventType;
  data: Record<string, unknown>;
  /** The callback to deliver the event to, or none. */
  deliverTo?: string | null;
}

export class JobStore {
  readonly db: Database;

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    // Every commit reaches the disk before the answer that depends on it.
    this.db.run("PRAGMA synchronous = FULL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(SCHEMA);
    // A jobs.db from before SV-S1 gains the model columns; its jobs run the server's default.
    // One from before remote dispatch gains the route columns; its jobs run here.
    const cols = new Set(
      (this.db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const c of ["model", "model_source", "route", "remote", "remote_job"]) {
      if (!cols.has(c)) this.db.run(`ALTER TABLE jobs ADD COLUMN ${c} TEXT`);
    }
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Jobs

  /**
   * A new job, or the key's existing job with the same idempotency key (SV-J2). The lookup and
   * the insert are one transaction, so two submits with one key make one job.
   */
  submit(j: NewJob): { job: Job; existing: boolean } {
    return this.db.transaction(() => {
      if (j.idempotency_key !== null) {
        const found = this.db
          .query("SELECT * FROM jobs WHERE key_id = ? AND idempotency_key = ?")
          .get(j.key_id, j.idempotency_key) as Row | null;
        if (found) return { job: jobOf(found), existing: true };
      }
      const now = this.now();
      const id = `job_${ulid(now)}`;
      this.db
        .query(
          `INSERT INTO jobs (id, key_id, status, preset, model, model_source, route, language,
            keywords, diarize, callback_url, metadata, idempotency_key, file_sha256, audio, created_at)
           VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          j.key_id,
          j.preset,
          j.model ?? null,
          j.model_source ?? null,
          j.route ?? null,
          j.language,
          JSON.stringify(j.keywords),
          j.diarize ? 1 : 0,
          j.callback_url,
          JSON.stringify(j.metadata ?? null),
          j.idempotency_key,
          j.file_sha256,
          j.audio,
          now,
        );
      return { job: this.job(id) as Job, existing: false };
    })();
  }

  job(id: string): Job | null {
    const r = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as Row | null;
    return r ? jobOf(r) : null;
  }

  /** The oldest queued job, by submit order. */
  nextQueued(): Job | null {
    const r = this.db
      .query("SELECT * FROM jobs WHERE status = 'queued' ORDER BY seq LIMIT 1")
      .get() as Row | null;
    return r ? jobOf(r) : null;
  }

  /** Every queued job, oldest first. */
  queued(): Job[] {
    return (
      this.db.query("SELECT * FROM jobs WHERE status = 'queued' ORDER BY seq").all() as Row[]
    ).map(jobOf);
  }

  /** Jobs waiting or running. */
  depth(): number {
    const r = this.db
      .query("SELECT count(*) AS n FROM jobs WHERE status IN ('queued', 'running')")
      .get() as { n: number };
    return r.n;
  }

  markRunning(id: string): Job | null {
    this.db
      .query(
        "UPDATE jobs SET status = 'running', running_at = ?, starts = starts + 1 WHERE id = ? AND status = 'queued'",
      )
      .run(this.now(), id);
    return this.job(id);
  }

  /**
   * A queued job taken by a remote (section 14): running, with no start counted, since this
   * process runs nothing for it. False when it was no longer queued.
   */
  claim(id: string): boolean {
    return (
      this.db
        .query(
          "UPDATE jobs SET status = 'running', running_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(this.now(), id).changes === 1
    );
  }

  /** The remote a job was sent to and its id there, or null for neither. */
  setRemote(id: string, remote: string | null, remoteJob: string | null): void {
    this.db
      .query("UPDATE jobs SET remote = ?, remote_job = ? WHERE id = ?")
      .run(remote, remoteJob, id);
  }

  /** A job a remote refused runs here from now on, and is never forwarded again. */
  setRoute(id: string, route: "remote" | "local" | null): void {
    this.db.query("UPDATE jobs SET route = ? WHERE id = ?").run(route, id);
  }

  /** A running job back to the queue, in its place: its remote went away before it ended. */
  requeue(id: string): boolean {
    return (
      this.db
        .query(
          "UPDATE jobs SET status = 'queued', running_at = NULL WHERE id = ? AND status = 'running'",
        )
        .run(id).changes === 1
    );
  }

  /** Every upload a job row names. */
  uploads(): Set<string> {
    const rows = this.db.query("SELECT audio FROM jobs WHERE audio IS NOT NULL").all() as {
      audio: string;
    }[];
    return new Set(rows.map((r) => r.audio));
  }

  /** Jobs left running, as the last process left them. */
  running(): Job[] {
    return (
      this.db.query("SELECT * FROM jobs WHERE status = 'running' ORDER BY seq").all() as Row[]
    ).map(jobOf);
  }

  /**
   * A job the last process left running goes back to the queue, in its place: it never finished,
   * and its audio is still on disk.
   */
  requeueRunning(): number {
    return this.db
      .query("UPDATE jobs SET status = 'queued', running_at = NULL WHERE status = 'running'")
      .run().changes;
  }

  /**
   * A running job's end, its feed event and its delivery, in one transaction. False when the job
   * is no longer running (a delete got there first), and nothing is written. A queued job can only
   * fail, when the model it waits for cannot be had (SV-M3).
   */
  finish(
    id: string,
    end:
      | { status: "done"; result: Record<string, unknown> }
      | { status: "failed"; error: JobError },
    outcome: Outcome,
  ): FeedEvent | null {
    return this.db.transaction(() => {
      const now = this.now();
      const changed =
        end.status === "done"
          ? this.db
              .query(
                "UPDATE jobs SET status = 'done', done_at = ?, result = ?, audio = NULL WHERE id = ? AND status = 'running'",
              )
              .run(now, JSON.stringify(end.result), id).changes
          : this.db
              .query(
                "UPDATE jobs SET status = 'failed', failed_at = ?, error = ?, audio = NULL WHERE id = ? AND status IN ('running', 'queued')",
              )
              .run(now, JSON.stringify(end.error), id).changes;
      if (changed === 0) return null;
      const job = this.job(id) as Job;
      return this.append(job, outcome, now);
    })();
  }

  /**
   * Removes a job (SV-J6). A job still queued or running first gets its `transcription.cancelled`
   * event; every event of the job then keeps its id and final state only, marked deleted. Returns
   * the job as it was, and its state after (`cancelled` for one that had not ended).
   */
  remove(id: string): { job: Job; final: JobStatus } | null {
    return this.db.transaction(() => {
      const job = this.job(id);
      if (!job) return null;
      const now = this.now();
      let final = job.status;
      if (job.status === "queued" || job.status === "running") {
        final = "cancelled";
        this.append(
          { ...job, status: "cancelled", cancelled_at: now },
          { type: "transcription.cancelled", data: { job_id: id, status: "cancelled" } },
          now,
        );
      }
      this.db.query("DELETE FROM jobs WHERE id = ?").run(id);
      for (const e of this.db.query("SELECT * FROM events WHERE job_id = ?").all(id) as Row[]) {
        const status = (JSON.parse(e.data as string) as { status?: string }).status ?? final;
        this.db
          .query("UPDATE events SET data = ? WHERE seq = ?")
          .run(JSON.stringify({ job_id: id, status, deleted: true }), e.seq as number);
      }
      // A delivery not yet made carries the text; it is dropped with the job.
      this.db
        .query(
          "UPDATE outbox SET state = 'failed', next_at = NULL, last_error = 'the job was deleted' WHERE state = 'pending' AND event_id IN (SELECT id FROM events WHERE job_id = ?)",
        )
        .run(id);
      return { job, final };
    })();
  }

  /** The key's jobs (every key's for null), newest first, before the cursor. */
  list(o: { key: string | null; status?: JobStatus; before?: number; limit: number }): Job[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.key !== null) {
      where.push("key_id = ?");
      args.push(o.key);
    }
    if (o.status) {
      where.push("status = ?");
      args.push(o.status);
    }
    if (o.before !== undefined) {
      where.push("seq < ?");
      args.push(o.before);
    }
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`;
    return (this.db.query(sql).all(...args, o.limit) as Row[]).map(jobOf);
  }

  /** Every job created before `t`: what `server.retain_days` removes. */
  createdBefore(t: number): Job[] {
    return (
      this.db.query("SELECT * FROM jobs WHERE created_at < ? ORDER BY seq").all(t) as Row[]
    ).map(jobOf);
  }

  // -------------------------------------------------------------------------
  // The feed

  private append(job: Job, o: Outcome, now: number): FeedEvent {
    const id = `msg_${ulid(now)}`;
    const r = this.db
      .query(
        "INSERT INTO events (id, key_id, type, job_id, at, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(id, job.key_id, o.type, job.id, now, JSON.stringify(o.data)) as Row;
    if (o.deliverTo) {
      this.db
        .query(
          "INSERT INTO outbox (event_id, key_id, url, attempts, next_at, state) VALUES (?, ?, ?, 0, ?, 'pending')",
        )
        .run(id, job.key_id, o.deliverTo, now);
    }
    return eventOf(r);
  }

  /** The key's events after the cursor (every key's for null), oldest first. */
  events(key: string | null, after: number, limit: number): FeedEvent[] {
    const where = key === null ? "seq > ?" : "key_id = ? AND seq > ?";
    const args = key === null ? [after] : [key, after];
    // The sizes first, then only the rows that fit FEED_PAGE_BYTES: a page of large results is
    // never loaded whole. (Breaking out of `iterate` leaves Bun's cached statement unusable.)
    const sizes = this.db
      .query(`SELECT seq, length(data) AS n FROM events WHERE ${where} ORDER BY seq LIMIT ?`)
      .all(...args, limit) as { seq: number; n: number }[];
    let last = after;
    let bytes = 0;
    for (const r of sizes) {
      bytes += r.n;
      if (last !== after && bytes > FEED_PAGE_BYTES) break;
      last = r.seq;
    }
    if (last === after) return [];
    const rows = this.db
      .query(`SELECT * FROM events WHERE ${where} AND seq <= ? ORDER BY seq`)
      .all(...args, last) as Row[];
    return rows.map(eventOf);
  }

  /** Is there any event of the key (any key's for null) after the cursor? */
  hasEventsAfter(key: string | null, after: number): boolean {
    const r =
      key === null
        ? this.db.query("SELECT 1 FROM events WHERE seq > ? LIMIT 1").get(after)
        : this.db
            .query("SELECT 1 FROM events WHERE key_id = ? AND seq > ? LIMIT 1")
            .get(key, after);
    return r !== null;
  }

  event(id: string): FeedEvent | null {
    const r = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as Row | null;
    return r ? eventOf(r) : null;
  }

  // -------------------------------------------------------------------------
  // The outbox

  /** Deliveries due at `now`, oldest first. */
  due(now: number): Delivery[] {
    return (
      this.db
        .query(
          "SELECT outbox.* FROM outbox JOIN events ON events.id = outbox.event_id WHERE state = 'pending' AND next_at <= ? ORDER BY events.seq",
        )
        .all(now) as Row[]
    ).map(deliveryOf);
  }

  /**
   * When the next pending delivery is due, or null when none is. A delivery whose try is out
   * (`inFlight`) is left out: its due time may already have passed while it waits for the receiver.
   */
  nextDue(inFlight: Iterable<string> = []): number | null {
    const r = this.db
      .query(
        "SELECT min(next_at) AS t FROM outbox WHERE state = 'pending' AND event_id NOT IN (SELECT value FROM json_each(?))",
      )
      .get(JSON.stringify([...inFlight])) as { t: number | null };
    return r.t;
  }

  delivery(eventId: string): Delivery | null {
    const r = this.db.query("SELECT * FROM outbox WHERE event_id = ?").get(eventId) as Row | null;
    return r ? deliveryOf(r) : null;
  }

  /**
   * One try's outcome, written before the next try can start. Only a pending delivery is written:
   * one closed while its try was out (its job deleted) stays closed. False when nothing was written.
   */
  recordAttempt(
    eventId: string,
    o: {
      attempts: number;
      state: OutboxState;
      next_at: number | null;
      status: number | null;
      error: string | null;
    },
  ): boolean {
    return (
      this.db
        .query(
          "UPDATE outbox SET attempts = ?, state = ?, next_at = ?, last_status = ?, last_error = ? WHERE event_id = ? AND state = 'pending'",
        )
        .run(o.attempts, o.state, o.next_at, o.status, o.error, eventId).changes === 1
    );
  }

  /**
   * A receiver answered 410 Gone (SV-E4): every delivery still pending to that URL for that key
   * stops. A later job that names the URL again gets its own delivery.
   */
  disableEndpoint(key: string, url: string): number {
    return this.db
      .query(
        "UPDATE outbox SET state = 'disabled', next_at = NULL WHERE key_id = ? AND url = ? AND state = 'pending'",
      )
      .run(key, url).changes;
  }
}
