/**
 * The job store at the size a busy server reaches (docs/ux/SERVER.md SV-J9, TRAPS "A store too big
 * to read on the server's thread"): 20,000 done jobs with their results and events, about 100 MB.
 * Every store statement runs on the one thread that answers requests, so the start, the hourly
 * sweep, `/healthz`, `GET /v1/server` and a key's list must each find their rows through an index,
 * and retention must give the thread back between bounded goes. The texts are generated.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS } from "../src/main/asr/models.ts";
import { JobService, SWEEP_BATCH } from "../src/main/server/jobs.ts";
import { ModelStore } from "../src/main/server/model-store.ts";
import { HOT_INDEXES, JOBS_DB, JobStore, warmForIndexes } from "../src/main/server/store.ts";
import { appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";
import { SERVER } from "./server-helpers.ts";

setDefaultTimeout(60_000);

const DAY = 86_400_000;
const JOBS = 20_000;
/** The oldest jobs, already past a 7-day retention when the store is made. */
const EXPIRED = 5_000;
/** A start on the full store, and one request while retention works through it, each in ms. */
const START_BUDGET_MS = 2_000;
const ANSWER_BUDGET_MS = 1_000;

const seed = tempDir("akou-scale-seed-");
const T = Date.now();
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});
afterAll(() => seed.cleanup());

/** A transcript of about 2.6 KB, the mean of a voice-note archive's results. */
function result(i: number): string {
  const text = Array.from({ length: 420 }, (_, w) => `w${(i * 31 + w) % 997}`).join(" ");
  return JSON.stringify({ job_id: jobId(i), status: "done", text, timings: { transcribe: 1.5 } });
}

function jobId(i: number): string {
  return `job_${String(i).padStart(26, "0")}`;
}

/**
 * The seed: `EXPIRED` jobs eight days old, the rest spread over the last six, each done with its
 * completed event; five of them another key's; one eight-day-old job that keeps its audio; and one
 * eight-day-old cancelled event that still carries metadata.
 */
beforeAll(() => {
  mkdirSync(join(seed.dir, "audio"));
  const s = new JobStore(join(seed.dir, JOBS_DB));
  const job = s.db.query(
    `INSERT INTO jobs (id, key_id, status, preset, language, keywords, diarize, metadata, file_sha256,
       created_at, done_at, result, keep_audio, kept)
     VALUES (?, ?, 'done', 'fast', 'auto', '[]', 0, 'null', ?, ?, ?, ?, ?, ?)`,
  );
  const event = s.db.query(
    "INSERT INTO events (id, key_id, type, job_id, at, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  s.db.transaction(() => {
    for (let i = 0; i < JOBS; i++) {
      const at = i < EXPIRED ? T - 8 * DAY + i : T - 6 * DAY + i * 20_000;
      const key = i % 4_000 === 3_999 ? "key_rare" : "key_a";
      const r = result(i);
      job.run(jobId(i), key, "0".repeat(64), at, at + 1000, r, 0, null);
      event.run(`msg_${i}`, key, "transcription.completed", jobId(i), at + 1000, r);
    }
    const at = T - 8 * DAY;
    job.run(jobId(JOBS), "key_a", "0".repeat(64), at, at, result(JOBS), 1, "kept.upload");
    const gone = { job_id: "job_gone", status: "cancelled", metadata: { x: 1 } };
    event.run("msg_gone", "key_a", "transcription.cancelled", "job_gone", at, JSON.stringify(gone));
  })();
  s.close();
});

/** A jobs folder holding a copy of the seed, a kept upload a row names and one no row names. */
function folder(home?: string): { dir: string; kept: string; orphan: string } {
  const t = home ? null : tempDir("akou-scale-");
  if (t) cleanups.push(t.cleanup);
  const dir = home ? join(home, ".config", "akou", "jobs") : (t?.dir as string);
  mkdirSync(join(dir, "audio"), { recursive: true });
  copyFileSync(join(seed.dir, JOBS_DB), join(dir, JOBS_DB));
  const kept = join(dir, "audio", "kept.upload");
  const orphan = join(dir, "audio", "orphan.upload");
  writeFileSync(kept, "audio");
  writeFileSync(orphan, "audio");
  // The row names its upload by its full path.
  const s = new JobStore(join(dir, JOBS_DB));
  s.db.query("UPDATE jobs SET kept = ? WHERE kept = 'kept.upload'").run(kept);
  s.close();
  return { dir, kept, orphan };
}

/** Jobs retention may remove at `cutoff` that are still in the store. */
function expiredLeft(s: JobStore, cutoff: number): number {
  const r = s.db
    .query("SELECT count(*) AS n FROM jobs WHERE created_at < ? AND keep_audio = 0")
    .get(cutoff) as { n: number };
  return r.n;
}

/** The statements `run` sends to SQLite, as the store wrote them. */
function statements(s: JobStore, run: () => void): string[] {
  const seen = new Set<string>();
  const query = s.db.query.bind(s.db);
  s.db.query = ((sql: string) => {
    seen.add(sql);
    return query(sql);
  }) as typeof s.db.query;
  try {
    run();
  } finally {
    s.db.query = query;
  }
  return [...seen];
}

/** What the server asks the store at start, on the sweep, per tick, per health check and per list. */
const HOT: Record<string, (s: JobStore) => void> = {
  "start: running": (s) => void s.running(),
  "start: requeueRunning": (s) => void s.requeueRunning(),
  "start: uploads": (s) => void s.uploads(),
  "sweep: expired": (s) => void s.expired(T - 7 * DAY, SWEEP_BATCH),
  "sweep: scrubCancelled": (s) => void s.scrubCancelled(0),
  "tick: queued": (s) => void s.queued(),
  "healthz and /v1/server: counts": (s) => void s.depth(),
  "submit: counts of a key": (s) => void s.counts("key_rare"),
  "list: one key": (s) => void s.list({ key: "key_rare", limit: 100 }),
  "list: one state": (s) => void s.list({ key: null, status: "failed", limit: 100 }),
  "outbox: due": (s) => void s.due(T),
  "outbox: nextDue": (s) => void s.nextDue(),
};

/** The hot statements whose plan reads a whole table, and every plan as text. */
function scans(s: JobStore): { scanning: string[]; plans: string } {
  const scanning: string[] = [];
  const plans: string[] = [];
  for (const [name, run] of Object.entries(HOT)) {
    for (const sql of statements(s, () => run(s))) {
      const plan = (s.db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(" | ");
      plans.push(`${name}: ${plan}`);
      // `jobs_upload` holds only the rows that name an upload, and the start wants them all.
      if (plan === "SCAN jobs USING COVERING INDEX jobs_upload") continue;
      if (/\bSCAN (jobs|events|outbox)\b/.test(plan)) scanning.push(name);
      else expect(plan).toMatch(/SEARCH (jobs|events|outbox) USING (COVERING )?INDEX /);
    }
  }
  return { scanning, plans: plans.join("\n") };
}

function service(dir: string, logs: string[] = []): JobService {
  const svc = new JobService({
    dir,
    version: "0.0.0",
    models: () => null,
    shelf: new ModelStore({
      dir: () => join(dir, "models"),
      machine: () => null,
      catalog: () => MODELS,
      autoDownload: () => false,
      maxGb: () => 0,
      unusedDays: () => 0,
      log: () => {},
    }),
    defaultModel: () => "auto",
    diarizer: () => "embeddings",
    secrets: () => [],
    hostListed: () => false,
    retainDays: () => 7,
    maxAudioMinutes: () => 240,
    log: (_level, msg) => logs.push(msg),
  });
  cleanups.push(() => svc.close());
  return svc;
}

describe("[akou-nby] A store too big to read on the server's thread", () => {
  test("every statement of the start, the sweep, the tick, /healthz and a key's list uses an index", () => {
    const s = new JobStore(join(folder().dir, JOBS_DB));
    cleanups.push(() => s.close());
    const { scanning, plans } = scans(s);
    expect(scanning).toEqual([]);
    expect(plans).toContain("start: uploads: SCAN jobs USING COVERING INDEX jobs_upload");
    expect(plans).toContain("sweep: expired: SEARCH jobs USING COVERING INDEX jobs_expiry");
    expect(plans).toContain("sweep: scrubCancelled: SEARCH events USING INDEX events_cancelled");
    expect(plans).toContain("list: one key: SEARCH jobs USING INDEX jobs_key");
  });

  test("positive control: without the indexes four of them read a whole table, and an older file gains the indexes at open", () => {
    const { dir } = folder();
    const old = new JobStore(join(dir, JOBS_DB));
    for (const name of Object.keys(HOT_INDEXES)) old.db.run(`DROP INDEX ${name}`);
    expect(scans(old).scanning).toEqual([
      "start: uploads",
      "sweep: expired",
      "sweep: scrubCancelled",
      "list: one key",
    ]);
    old.close();
    const s = new JobStore(join(dir, JOBS_DB));
    cleanups.push(() => s.close());
    expect(scans(s).scanning).toEqual([]);
  });

  test("a file from before the indexes is read once in order, off the thread, before it is opened; one that has them is not", async () => {
    const { dir } = folder();
    const path = join(dir, JOBS_DB);
    expect(await warmForIndexes(join(dir, "none.db"))).toBe(0);
    expect(await warmForIndexes(path)).toBe(0);
    const old = new JobStore(path);
    old.db.run("DROP INDEX jobs_expiry");
    old.close();
    // As a clean stop on Linux, or a restored backup, leaves it: the file alone.
    for (const x of ["-wal", "-shm"]) rmSync(path + x, { force: true });
    let ticks = 0;
    // clock: a real timer, which runs only while the read leaves this thread free.
    const tick = setInterval(() => ticks++, 1);
    try {
      expect(await warmForIndexes(path)).toBe(statSync(path).size);
    } finally {
      clearInterval(tick);
    }
    expect(ticks).toBeGreaterThan(0);
    new JobStore(path).close();
    expect(await warmForIndexes(path)).toBe(0);
  });

  test("a crash's WAL is left for the store to recover: the index check neither copies it back nor fails on it", async () => {
    const { dir } = folder();
    const path = join(dir, JOBS_DB);
    const old = new JobStore(path);
    old.db.run("DROP INDEX jobs_expiry");
    old.close();
    // A process that commits into the WAL and dies before any checkpoint.
    const die = Bun.spawnSync([
      process.execPath,
      "-e",
      `const { Database } = require("bun:sqlite");
       const db = new Database(${JSON.stringify(path)});
       db.run("PRAGMA wal_autocheckpoint = 0");
       db.run("UPDATE jobs SET title = 'x' WHERE seq % 2 = 0");
       process.kill(process.pid, "SIGKILL");`,
    ]);
    expect(die.exitCode).not.toBe(0);
    const wal = statSync(`${path}-wal`).size;
    expect(wal).toBeGreaterThan(1_000_000);
    expect(await warmForIndexes(path)).toBe(statSync(path).size);
    expect(statSync(`${path}-wal`).size).toBe(wal);
    // Positive control: a writable connection that reads anything copies the WAL back at close.
    const { Database } = await import("bun:sqlite");
    const rw = new Database(path, { readwrite: true });
    rw.query("SELECT count(*) FROM sqlite_schema").get();
    rw.close();
    // Deleted on Linux and Windows; macOS's own SQLite keeps the file, empty.
    expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
  });

  test("a retention cleanup that throws is logged and the rest of the go is still cleaned up", () => {
    const t = tempDir("akou-scale-cleanup-");
    cleanups.push(t.cleanup);
    const audio = join(t.dir, "audio");
    mkdirSync(join(audio, "held", "inside"), { recursive: true });
    const logs: string[] = [];
    const svc = service(t.dir, logs);
    const files = ["held", "a.upload", "b.upload"].map((f) => join(audio, f));
    for (const f of files.slice(1)) writeFileSync(f, "audio");
    for (const f of files) {
      const { job } = svc.store.submit({
        key_id: "key_a",
        preset: "fast",
        language: "auto",
        keywords: [],
        diarize: false,
        callback_url: null,
        metadata: null,
        idempotency_key: null,
        file_sha256: "0".repeat(64),
        audio: f,
      });
      svc.store.db.query("UPDATE jobs SET created_at = ? WHERE id = ?").run(T - 8 * DAY, job.id);
    }
    // The first job's upload cannot be deleted (a folder, as a file Windows holds open is).
    expect(svc.sweep()).toBe(3);
    expect(expiredLeft(svc.store, T - 7 * DAY)).toBe(0);
    expect(files.map((f) => existsSync(f))).toEqual([true, false, false]);
    expect(logs.filter((l) => l.includes("its cleanup failed"))).toHaveLength(1);
  });

  test("a start with thousands of jobs past retention removes one go of them and returns; the rest go in goes that leave the thread free", async () => {
    const { dir, kept, orphan } = folder();
    const logs: string[] = [];
    const svc = service(dir, logs);
    const cutoff = T - 7 * DAY;
    const t0 = performance.now();
    svc.start();
    expect(performance.now() - t0).toBeLessThan(START_BUDGET_MS);
    const left = expiredLeft(svc.store, cutoff);
    expect(SWEEP_BATCH).toBeLessThan(EXPIRED);
    expect(left).toBeGreaterThanOrEqual(EXPIRED - SWEEP_BATCH);
    expect(left).toBeLessThan(EXPIRED);
    // The upload no row names went at start, found without reading the table.
    expect(existsSync(orphan)).toBe(false);
    // The longest the thread was held while the rest went.
    let worst = 0;
    let last = performance.now();
    // clock: a real timer, measuring how long this thread goes without running one.
    const tick = setInterval(() => {
      const t = performance.now();
      worst = Math.max(worst, t - last);
      last = t;
    }, 1);
    try {
      await until(() => expiredLeft(svc.store, cutoff) === 0, 30_000, "retention to end");
    } finally {
      clearInterval(tick);
    }
    expect(worst).toBeLessThan(ANSWER_BUDGET_MS);
    // Nothing younger went, the job that keeps its audio stays with its file, the removed jobs'
    // events keep the id and the state only, and the old cancelled event lost its metadata.
    const count = (sql: string) => (svc.store.db.query(sql).get() as { n: number }).n;
    expect(count("SELECT count(*) AS n FROM jobs")).toBe(JOBS - EXPIRED + 1);
    expect(existsSync(kept)).toBe(true);
    expect(svc.store.event("msg_0")?.data).toEqual({
      job_id: jobId(0),
      status: "done",
      deleted: true,
    });
    await until(() => logs.some((l) => l.includes("retention removed")), 3000, "the sweep's line");
    expect(svc.store.event("msg_gone")?.data).toEqual({
      job_id: "job_gone",
      status: "cancelled",
      deleted: true,
    });
    expect(logs.filter((l) => l.includes("retention removed"))).toEqual([
      `jobs: retention removed ${EXPIRED} job(s) older than 7 days`,
    ]);
  });

  test("positive control: fewer jobs past retention than one go removes are all gone when the start returns", () => {
    const { dir } = folder();
    const few = SWEEP_BATCH - 1;
    const s = new JobStore(join(dir, JOBS_DB));
    s.db.query("DELETE FROM jobs WHERE seq > ? AND seq <= ?").run(few, EXPIRED);
    s.close();
    const svc = service(dir);
    expect(expiredLeft(svc.store, T - 7 * DAY)).toBe(few);
    svc.start();
    expect(expiredLeft(svc.store, T - 7 * DAY)).toBe(0);
  });

  test("the server starts on the full store within its budget, and /healthz, /v1/server and a key's list answer while retention removes every job", async () => {
    const home = tempDir("akou-scale-home-");
    cleanups.push(home.cleanup);
    folder(home.dir);
    let now = T;
    const t0 = performance.now();
    const rig = await appRig({
      home: home.dir,
      settings: { ...SERVER, "server.retain_days": 7 },
      jobs: { now: () => now },
    });
    try {
      const healthz = () => fetch(`http://127.0.0.1:${rig.port}/healthz`);
      expect((await healthz()).status).toBe(200);
      expect(performance.now() - t0).toBeLessThan(START_BUDGET_MS);
      const jobs = rig.app.jobs();
      if (!jobs) throw new Error("no job service");
      await until(() => expiredLeft(jobs.store, T - 7 * DAY) === 0, 30_000, "the start's sweep");
      // A week later every job left is past retention: one go is removed before the sweep
      // returns, and requests are answered between the goes that follow.
      now += 8 * DAY;
      const all = expiredLeft(jobs.store, now - 7 * DAY);
      expect(all).toBe(JOBS - EXPIRED);
      const first = jobs.sweep();
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThanOrEqual(SWEEP_BATCH);
      expect(expiredLeft(jobs.store, now - 7 * DAY)).toBe(all - first);
      expect(all - first).toBeGreaterThan(0);
      let during = 0;
      let worst = 0;
      const asks = [
        () => healthz().then((r) => r.status),
        () => rig.api("GET", "/server").then((r) => r.status),
        () => rig.api("GET", "/jobs?key=key_rare&limit=100").then((r) => r.status),
      ];
      for (let i = 0; expiredLeft(jobs.store, now - 7 * DAY) > 0; i++) {
        const t = performance.now();
        expect(await (asks[i % asks.length] as () => Promise<number>)()).toBe(200);
        worst = Math.max(worst, performance.now() - t);
        if (expiredLeft(jobs.store, now - 7 * DAY) > 0) during++;
      }
      expect(during).toBeGreaterThan(0);
      expect(worst).toBeLessThan(ANSWER_BUDGET_MS);
    } finally {
      await rig.close();
    }
  });
});
