/**
 * SI-4 (docs/research/service-interface.md section 9): the single-instance lock and each call's
 * log lock survive a container restart, where Bun is pid 1 every time, without letting two
 * containers on one volume both write.
 *
 * The two-container case runs two real processes, each unable to see the other's pid, as two PID
 * namespaces are: the second is told every pid is dead (`isAlive: () => false`). It runs at a
 * tenth of the real timings (a 1 s heartbeat, a 3 s threshold); the defaults are asserted apart.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireLock,
  INSTANCE_ID,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  LockError,
  LogWriter,
  processAlive,
} from "../src/core/log/writer.ts";
import { APP_LOCK, startApp } from "../src/main/index.ts";
import { writeSettings } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const WRITER = join(import.meta.dir, "..", "src", "core", "log", "writer.ts");
const ENTRY = join(import.meta.dir, "..", "src", "main", "index.ts");

function aged(path: string, seconds: number): void {
  const t = new Date(Date.now() - seconds * 1000);
  utimesSync(path, t, t);
}

function refused(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    if (err instanceof LockError) return true;
    throw err;
  }
}

describe("SI-4: a lock that survives a container restart", () => {
  test("the timings are a 10 s heartbeat and a 30 s threshold", () => {
    expect(LOCK_HEARTBEAT_MS).toBe(10_000);
    expect(LOCK_STALE_MS).toBe(30_000);
  });

  test("the app takes a lock holding its own pid, a foreign id and a 60 s old mtime", async () => {
    const t = tempDir("akou-lock-");
    try {
      writeSettings(t.dir, { "api.port": 0, "server.enabled": true, "api.bind": "127.0.0.1" });
      const lock = join(t.dir, ".config", "akou", APP_LOCK);
      writeFileSync(lock, `${process.pid} 0123456789abcdef\n`);
      aged(lock, 60);
      const app = await startApp({ env: { AKOU_HOME: t.dir }, models: null, onLog: () => {} });
      try {
        expect(readFileSync(lock, "utf8").trim()).toBe(`${process.pid} ${INSTANCE_ID}`);
      } finally {
        await app.quit();
      }
    } finally {
      t.cleanup();
    }
  });

  /** The real entry point on a home, as a container's `CMD` runs it: its exit code and stderr. */
  async function entry(home: string): Promise<{ code: number; err: string }> {
    const proc = Bun.spawn([process.execPath, ENTRY], {
      env: { ...process.env, AKOU_HOME: home, AKOU_HEADLESS: "1" },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, err };
  }

  test("the entry point in server mode exits 75 on a lock too fresh to take, never 0 as if running", async () => {
    const t = tempDir("akou-lock-");
    try {
      writeSettings(t.dir, { "api.port": 0, "server.enabled": true, "api.bind": "127.0.0.1" });
      const lock = join(t.dir, ".config", "akou", APP_LOCK);
      // A holder this process cannot see: after a restart, pid 1 with the earlier start's id.
      const child = Bun.spawn([process.execPath, "--version"], { stdout: "ignore" });
      await child.exited;
      writeFileSync(lock, `${child.pid} 0123456789abcdef\n`);
      aged(lock, 12);
      const fresh = await entry(t.dir);
      // 75 (EX_TEMPFAIL): Docker's restart policies start it again, and the lock ages meanwhile.
      expect(fresh.code).toBe(75);
      expect(fresh.err).toMatch(/lock from an earlier start is 1\d s old; it frees in 1\d s/);
      expect(fresh.err).not.toContain("already running");
      // Positive control: a holder alive here is a running akou, and that is still exit 0.
      writeFileSync(lock, `${process.pid} 0123456789abcdef\n`);
      const running = await entry(t.dir);
      expect(running.code).toBe(0);
      expect(running.err).toContain("already running");
    } finally {
      t.cleanup();
    }
  });

  test("the same lock with a fresh mtime is refused, then taken once 30 s pass", () => {
    const t = tempDir("akou-lock-");
    try {
      const lock = join(t.dir, "akou.lock");
      writeFileSync(lock, `${process.pid} 0123456789abcdef\n`);
      const now = Date.now();
      expect(refused(() => acquireLock(lock, process.pid, processAlive, { now: () => now }))).toBe(
        true,
      );
      expect(
        refused(() => acquireLock(lock, process.pid, processAlive, { now: () => now + 29_000 })),
      ).toBe(true);
      expect(acquireLock(lock, process.pid, processAlive, { now: () => now + 31_000 })).toBe(
        process.pid,
      );
      expect(readFileSync(lock, "utf8").trim()).toBe(`${process.pid} ${INSTANCE_ID}`);
    } finally {
      t.cleanup();
    }
  });

  test("a second acquire inside the same process is refused, even when old", () => {
    const t = tempDir("akou-lock-");
    try {
      const lock = join(t.dir, "akou.lock");
      expect(acquireLock(lock, process.pid, processAlive)).toBeNull();
      aged(lock, 600);
      expect(refused(() => acquireLock(lock, process.pid, processAlive))).toBe(true);
      // And a call's log: a second writer on the same folder in one process.
      const dir = join(t.dir, "call");
      mkdirSync(dir);
      const w = LogWriter.open(dir);
      expect(refused(() => LogWriter.open(dir))).toBe(true);
      w.close();
    } finally {
      t.cleanup();
    }
  });

  test("a lock held by another live process is refused, however old", () => {
    const t = tempDir("akou-lock-");
    try {
      const lock = join(t.dir, "akou.lock");
      // The test runner's parent is alive and is not this process.
      writeFileSync(lock, `${process.ppid} 0123456789abcdef\n`);
      aged(lock, 600);
      expect(processAlive(process.ppid)).toBe(true);
      expect(refused(() => acquireLock(lock, process.pid, processAlive))).toBe(true);
      expect(
        refused(() => acquireLock(lock, process.pid, processAlive, { serverMode: true })),
      ).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("in app mode a lock whose pid is dead is taken at once, fresh or not", async () => {
    const t = tempDir("akou-lock-");
    try {
      const child = Bun.spawn([process.execPath, "--version"], { stdout: "ignore" });
      await child.exited;
      const lock = join(t.dir, "akou.lock");
      writeFileSync(lock, `${child.pid} 0123456789abcdef\n`);
      expect(acquireLock(lock, process.pid, processAlive)).toBe(child.pid);
      // In server mode the same fresh lock waits for its heartbeat to stop: the pid may be alive
      // in another container.
      writeFileSync(lock, `${child.pid} 0123456789abcdef\n`);
      expect(
        refused(() => acquireLock(lock, process.pid, processAlive, { serverMode: true })),
      ).toBe(true);
      aged(lock, 31);
      expect(acquireLock(lock, process.pid, processAlive, { serverMode: true })).toBe(child.pid);
    } finally {
      t.cleanup();
    }
  });

  test("a call's log writer follows the same rule", () => {
    const t = tempDir("akou-lock-");
    try {
      const lock = join(t.dir, ".akou.lock");
      writeFileSync(lock, `${process.pid} 0123456789abcdef\n`);
      expect(refused(() => LogWriter.open(t.dir))).toBe(true);
      aged(lock, 60);
      const w = LogWriter.open(t.dir);
      expect(w.report.staleLockPid).toBe(process.pid);
      w.close();
    } finally {
      t.cleanup();
    }
  });

  /** A second "container": a process holding the lock with a heartbeat, as the app does. */
  function container(lock: string, beatMs: number) {
    const script = `
      import { acquireLock, lockHeartbeat, INSTANCE_ID } from ${JSON.stringify(WRITER)};
      acquireLock(${JSON.stringify(lock)}, process.pid, () => false, { serverMode: true });
      lockHeartbeat(${JSON.stringify(lock)}, process.pid, INSTANCE_ID, ${beatMs});
      console.log("held");
      setInterval(() => {}, 1 << 30);
    `;
    return Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
  }

  async function heldBy(proc: ReturnType<typeof container>): Promise<void> {
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(value)).toContain("held");
  }

  test("two containers on one volume: the second stays refused while the first runs, and takes the lock after SIGKILL", async () => {
    const t = tempDir("akou-lock-");
    const beat = 1000;
    const stale = 3000;
    const a = container(join(t.dir, "akou.lock"), beat);
    try {
      await heldBy(a);
      const lock = join(t.dir, "akou.lock");
      // Container B cannot see A's pid (another namespace): every pid looks dead to it.
      const tryB = () =>
        acquireLock(lock, process.pid, () => false, {
          serverMode: true,
          staleMs: stale,
          id: "b0b0b0b0b0b0b0b0",
        });
      // Refused for longer than the threshold: only A's heartbeat can keep the lock fresh.
      const until1 = Date.now() + stale + 1500;
      while (Date.now() < until1) {
        expect(refused(tryB)).toBe(true);
        await Bun.sleep(250);
      }
      const killedAt = Date.now();
      a.kill("SIGKILL");
      await a.exited;
      await until(async () => !refused(tryB), stale + beat + 2000, "B takes the lock");
      // Within the scaled 40 s: the threshold plus one heartbeat.
      expect(Date.now() - killedAt).toBeLessThan(stale + beat + 1000);
      expect(readFileSync(lock, "utf8").trim()).toBe(`${process.pid} b0b0b0b0b0b0b0b0`);
    } finally {
      a.kill("SIGKILL");
      t.cleanup();
    }
  }, 20_000);

  test("positive control: the pid-and-id rule without the mtime check lets the second container in", async () => {
    const t = tempDir("akou-lock-");
    const a = container(join(t.dir, "akou.lock"), 1000);
    try {
      await heldBy(a);
      // App mode's rule, "a dead pid is taken at once", is the pid-and-id rule with no mtime: in
      // another namespace it takes a live container's lock.
      const taken = acquireLock(join(t.dir, "akou.lock"), process.pid, () => false, {
        id: "b0b0b0b0b0b0b0b0",
      });
      expect(taken).toBe(a.pid);
    } finally {
      a.kill("SIGKILL");
      t.cleanup();
    }
  });
});
