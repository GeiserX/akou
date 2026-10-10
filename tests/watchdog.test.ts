/**
 * DK-M8, TRAPS "An app that takes the connection and never answers": the watchdog inside the app.
 * A thread that stops beating for the silence is logged; with no call recording the process and
 * the processes below it end, with a call recording nothing ends. Work in bursts shorter than the
 * silence, and a process stopped and continued (a Mac asleep), never fire it.
 */

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/core/log/writer.ts";
import { appBundle, relaunchCommand } from "../src/main/watchdog.ts";
import { tempDir } from "./helpers.ts";

const APP = join(import.meta.dir, "fixtures", "watchdog-app.ts");
const LONG = 60_000;
const SILENCE = 1500;

async function run(flags: string[], dir?: string, env?: Record<string, string | undefined>) {
  const t = dir ? { dir, cleanup: () => {} } : tempDir("akou-wd-");
  const log = join(t.dir, "app.log");
  const hangs = join(t.dir, "hangs");
  const proc = Bun.spawn(
    [process.execPath, APP, log, hangs, "--silence", String(SILENCE), ...flags],
    {
      stdout: "pipe",
      stderr: "inherit",
      ...(env ? { env } : {}),
    },
  );
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("ready\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const child = Number(/child (\d+)/.exec(text)?.[1] ?? 0);
  const read = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  /** Resolves with the exit, or null when the process is still alive after `ms`. */
  const exitWithin = (ms: number) =>
    Promise.race([
      // Windows ends a process with no signal to report: its exit code stands in.
      proc.exited.then(() => proc.signalCode ?? `exit ${proc.exitCode}`),
      Bun.sleep(ms).then(() => null),
    ]);
  const cleanup = () => {
    for (const pid of [proc.pid, child]) {
      // A process can end between the check and the kill (an exiting child not yet reaped).
      try {
        if (pid && processAlive(pid)) process.kill(pid, "SIGKILL");
      } catch {}
    }
    t.cleanup();
  };
  return { proc, child, log: read, hangs, exitWithin, cleanup };
}

describe("[DK-M8] the watchdog inside the app", () => {
  test(
    "a stuck thread with no call recording: a log line, then the process and its children end",
    async () => {
      const r = await run(["--block", "30000"]);
      try {
        const ended = await r.exitWithin(SILENCE + 8000);
        expect(ended).toMatch(process.platform === "win32" ? /^exit \d+$/ : /^SIGKILL$/);
        const log = r.log();
        expect(log).toMatch(
          /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} [+-]\d\d:\d\d error watchdog: the app's thread has not answered for \d+ s; no call is recording$/m,
        );
        expect(log).toContain(
          `warn watchdog: ending akou (pid ${r.proc.pid}), so the next command starts a fresh one`,
        );
        // Windows has no process tree to walk; the desktop app is macOS's.
        if (process.platform !== "win32") {
          await Bun.sleep(300);
          expect(processAlive(r.child)).toBe(false);
        }
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test(
    "positive control: without the watchdog the same stuck process stays alive",
    async () => {
      const r = await run(["--block", "30000", "--no-watchdog"]);
      try {
        expect(await r.exitWithin(SILENCE + 3000)).toBeNull();
        expect(r.log()).toBe("");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test(
    "with a call recording nothing ends: it logs, and logs again when the thread answers",
    async () => {
      const r = await run(["--block", String(SILENCE + 1500), "--recording"]);
      try {
        expect(await r.exitWithin(SILENCE + 3500)).toBeNull();
        expect(processAlive(r.child)).toBe(true);
        const log = r.log();
        expect(log).toMatch(
          /error watchdog: the app's thread has not answered for \d+ s; a call is recording/,
        );
        expect(log).toContain("akou keeps running, so the capture helper keeps writing the audio");
        expect(log).toMatch(/info watchdog: the app's thread answered again after about \d+ s/);
        expect(log).not.toContain("ending akou");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test(
    "work in bursts shorter than the silence never fires it",
    async () => {
      const r = await run(["--busy", String(SILENCE * 3)]);
      try {
        await r.proc.exited;
        expect(r.proc.exitCode).toBe(0);
        expect(r.log()).toBe("");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(process.platform === "win32")(
    "a process stopped and continued, as a Mac asleep, never fires it",
    async () => {
      const r = await run(["--busy", String(SILENCE * 4)]);
      try {
        process.kill(r.proc.pid, "SIGSTOP");
        await Bun.sleep(SILENCE * 2);
        process.kill(r.proc.pid, "SIGCONT");
        await r.proc.exited;
        expect(r.proc.exitCode).toBe(0);
        expect(r.log()).toBe("");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(process.platform !== "darwin")(
    "on macOS the hang leaves a sample of the stuck process beside the log",
    async () => {
      const r = await run(["--block", "30000", "--sample"]);
      try {
        expect(await r.exitWithin(SILENCE + 12_000)).toBe("SIGKILL");
        const files = readdirSync(r.hangs);
        expect(files.length).toBe(1);
        expect(readFileSync(join(r.hangs, files[0] as string), "utf8")).toContain(
          `[${r.proc.pid}]`,
        );
        // A sample names the process's threads and libraries: the owner's alone.
        expect(statSync(join(r.hangs, files[0] as string)).mode & 0o777).toBe(0o600);
        expect(r.log()).toContain("a sample of the stuck process is in");
        // Where the main thread was, by name: this process's sits in a wait.
        expect(r.log()).toMatch(/info watchdog: in the sample the main thread was in \S+ \(/);
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );
  test.skipIf(process.platform === "win32")(
    "with the window open the app is opened again after it ends, at most once in ten minutes",
    async () => {
      const t = tempDir("akou-wd-");
      const marker = join(t.dir, "reopened.marker");
      try {
        const first = await run(["--block", "30000", "--window", "--reopen", marker], t.dir);
        expect(await first.exitWithin(SILENCE + 8000)).toMatch(/^SIGKILL$/);
        expect(first.log()).toContain(
          "info watchdog: opening akou again, because its window was open",
        );
        // Nothing here answers as an app, so the reopen opens it a second time, then gives up.
        expect(await waitFor(first.log, "did not come up after being opened twice", 10_000)).toBe(
          true,
        );
        expect(readFileSync(marker, "utf8")).toBe("xx");
        // The reopened app hangs too: it is ended, and not opened again.
        const second = await run(["--block", "30000", "--window", "--reopen", marker], t.dir);
        expect(await second.exitWithin(SILENCE + 8000)).toMatch(/^SIGKILL$/);
        await Bun.sleep(3000);
        expect(readFileSync(marker, "utf8")).toBe("xx");
        expect(second.log()).toMatch(
          /warn watchdog: not opening akou again: it was reopened \d+ min ago/,
        );
      } finally {
        t.cleanup();
      }
    },
    LONG,
  );

  test.skipIf(process.platform === "win32")(
    "positive control: with the window closed nothing is opened again",
    async () => {
      const t = tempDir("akou-wd-");
      const marker = join(t.dir, "reopened.marker");
      try {
        const r = await run(["--block", "30000", "--reopen", marker], t.dir);
        expect(await r.exitWithin(SILENCE + 8000)).toMatch(/^SIGKILL$/);
        await Bun.sleep(1000);
        expect(existsSync(marker)).toBe(false);
        expect(r.log()).not.toContain("opening akou again");
      } finally {
        t.cleanup();
      }
    },
    LONG,
  );

  test("the app is opened again through its bundle on macOS, and not at all elsewhere", () => {
    // `-n`: a launcher left with no app must not make `open` start nothing (TRAPS "Minutes to start").
    expect(relaunchCommand("/Applications/akou.app/Contents/MacOS/bun", "darwin")).toEqual([
      "/usr/bin/open",
      "-n",
      "-a",
      "/Applications/akou.app",
    ]);
    expect(appBundle("/Applications/akou.app/Contents/MacOS/bun", "darwin")).toBe(
      "/Applications/akou.app",
    );
    expect(appBundle("/usr/local/bin/bun", "darwin")).toBeNull();
    // The headless app the CLI starts from source, and other systems: the next command starts it.
    expect(relaunchCommand("/usr/local/bin/bun", "darwin")).toBeNull();
    expect(relaunchCommand("/Applications/akou.app/Contents/MacOS/bun", "linux")).toBeNull();
  });
  test.skipIf(process.platform === "win32")(
    "a recording helper spawned after the last beat is never ended, though the live flag still says no call (no process tree on Windows)",
    async () => {
      const t = tempDir("akou-wd-");
      const audio = join(t.dir, "part-1.opus");
      try {
        const r = await run(["--block", "30000", "--late-helper", audio], t.dir);
        expect(await r.exitWithin(SILENCE + 4000)).toBeNull();
        const log = r.log();
        expect(log).toMatch(/no call is recording/);
        expect(log).toMatch(
          /warn watchdog: a capture helper is recording \(pid \d+\), so akou keeps running/,
        );
        expect(log).not.toContain("ending akou");
        const size = statSync(audio).size;
        await Bun.sleep(400);
        expect(statSync(audio).size).toBeGreaterThan(size);
        r.cleanup();
      } finally {
        t.cleanup();
      }
    },
    LONG,
  );

  test(
    "a call that goes live is published at once by touch, not at the next beat",
    async () => {
      const r = await run(["--block", "30000", "--touch-recording"]);
      try {
        expect(await r.exitWithin(SILENCE + 4000)).toBeNull();
        expect(r.log()).toMatch(/the app's thread has not answered for \d+ s; a call is recording/);
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );
  test.skipIf(process.platform === "win32")(
    "a process list that cannot be read ends nothing, so a helper in it is never left orphaned or killed",
    async () => {
      const r = await run(["--block", "30000", "--ps-fails"]);
      try {
        expect(await r.exitWithin(SILENCE + 4000)).toBeNull();
        expect(processAlive(r.child)).toBe(true);
        expect(r.log()).toMatch(
          /error watchdog: could not list the processes below akou \(ps failed\), so nothing was ended/,
        );
        expect(r.log()).not.toContain("ending akou");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );
});

const FAKE_SAMPLER = join(import.meta.dir, "fixtures", "fake-sampler.ts");
const sampler = (...mode: string[]) => JSON.stringify([process.execPath, FAKE_SAMPLER, ...mode]);

describe("[DK-M8] a hang always leaves evidence", () => {
  test(
    "the hang's line is followed by the machine's load and how late the watchdog's own ticks ran",
    async () => {
      const r = await run(["--block", "30000"]);
      try {
        expect(await r.exitWithin(SILENCE + 8000)).not.toBeNull();
        const lines = r.log().trimEnd().split("\n");
        expect(lines[0]).toMatch(/error watchdog: the app's thread has not answered for \d+ s/);
        expect(lines[1]).toMatch(
          process.platform === "win32"
            ? /info watchdog: the watchdog's own ticks ran at most \d+ ms late$/
            : /info watchdog: load average \d+\.\d \d+\.\d \d+\.\d on \d+ cores; the watchdog's own ticks ran at most \d+ ms late$/,
        );
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test(
    "a sample that fails is said in the log, with how, and the app is still ended",
    async () => {
      const r = await run(["--block", "30000", "--sampler", sampler("fail")]);
      try {
        expect(await r.exitWithin(SILENCE + 8000)).not.toBeNull();
        expect(r.log()).toMatch(
          /warn watchdog: no sample of the stuck process: .+ exited with 3$/m,
        );
        expect(r.log()).not.toContain("a sample of the stuck process is in");
        expect(readdirSync(r.hangs).filter((f) => f.startsWith("hang-"))).toEqual([]);
        expect(r.log()).toContain(`warn watchdog: ending akou (pid ${r.proc.pid})`);
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test(
    "a sample that never ends is cut at its cap and said in the log, and the app is still ended",
    async () => {
      const t = tempDir("akou-wd-");
      const pidFile = join(t.dir, "sampler.pid");
      const r = await run(
        ["--block", "30000", "--sampler", sampler("hang", pidFile), "--sample-cap", "1500"],
        t.dir,
      );
      try {
        expect(await r.exitWithin(SILENCE + 10_000)).not.toBeNull();
        expect(r.log()).toMatch(
          /warn watchdog: no sample of the stuck process: .+ did not finish within 1\.5 s$/m,
        );
        expect(r.log()).toContain(`warn watchdog: ending akou (pid ${r.proc.pid})`);
        await Bun.sleep(300);
        expect(processAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
      } finally {
        r.cleanup();
        t.cleanup();
      }
    },
    LONG,
  );

  test(
    "a sample that takes its time is waited for: its place and the main thread's are in the log before the app is ended",
    async () => {
      const r = await run(["--block", "30000", "--sampler", sampler("slow", "1500")]);
      try {
        // Not ended while the sample is being taken.
        expect(await r.exitWithin(SILENCE + 1000)).toBeNull();
        expect(await r.exitWithin(8000)).not.toBeNull();
        const log = r.log();
        const files = readdirSync(r.hangs).filter((f) => f.startsWith("hang-"));
        expect(files.length).toBe(1);
        expect(log).toContain(
          `info watchdog: a sample of the stuck process is in ${join(r.hangs, files[0] as string)}`,
        );
        // The heaviest path's named frames, innermost first; the lighter branch and the other
        // thread are not it.
        expect(log).toContain(
          "info watchdog: in the sample the main thread was in mach_msg2_trap (libsystem_kernel.dylib) < mach_msg (libsystem_kernel.dylib) < -[NSApplication run] (AppKit) < start (dyld)\n",
        );
        expect(log.indexOf("a sample of the stuck process is in")).toBeLessThan(
          log.indexOf("ending akou"),
        );
        if (process.platform !== "win32") {
          expect(statSync(join(r.hangs, files[0] as string)).mode & 0o777).toBe(0o600);
        }
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );

  test(
    "a thread that answers while the sample is taken is not ended: the log says it answered",
    async () => {
      // Silent for 3 s: the watchdog fires at 1.5 s, and the sample is done 2.5 s after that.
      const r = await run([
        "--block",
        String(SILENCE + 1500),
        "--sampler",
        sampler("slow", "2500"),
      ]);
      try {
        expect(await r.exitWithin(SILENCE + 5500)).toBeNull();
        expect(processAlive(r.child)).toBe(true);
        const log = r.log();
        expect(log).toMatch(/error watchdog: the app's thread has not answered for \d+ s; no call/);
        expect(log).toMatch(/info watchdog: the app's thread answered again after about \d+ s/);
        expect(log).toContain("a sample of the stuck process is in");
        expect(log).not.toContain("ending akou");
      } finally {
        r.cleanup();
      }
    },
    LONG,
  );
});

const FAKE_BUNDLE = join(import.meta.dir, "fixtures", "fake-bundle.ts");

/** A fake unpacked bundle in `dir`, whose launcher is this Bun, and what the reopen tests share. */
function fakeBundle(dir: string) {
  const bundle = join(dir, "akou.app");
  const launcher = join(bundle, "Contents", "MacOS", "launcher");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  symlinkSync(process.execPath, launcher);
  const pids = join(dir, "pids.txt");
  const runtime = join(dir, ".config", "akou", "runtime.json");
  const env = { ...process.env, AKOU_HOME: dir };
  /** A process run as the bundle's launcher in a role of the fixture. */
  const as = (role: string, ...more: string[]) =>
    spawn(launcher, [FAKE_BUNDLE, role, "-a", bundle, "--pids", pids, ...more], {
      stdio: "ignore",
      env,
    });
  /**
   * The wrapper as the real one is left: idle, with one child that exited and that it never
   * reaps (the `open` it ran). The shell starts that child, then becomes the launcher.
   */
  const leftWrapper = () =>
    spawn(
      "/bin/sh",
      ["-c", 'true & exec "$0" "$@"', launcher, FAKE_BUNDLE, "stray", "-a", bundle, "--pids", pids],
      { stdio: "ignore", env },
    );
  /** The children of `pid` that exited unreaped, as `ps` lists them. */
  const unreaped = (pid: number) =>
    spawnSync("ps", ["-A", "-o", "ppid=,args="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((l) => l.trim().startsWith(`${pid} `) && l.includes("<defunct>")).length;
  /** `open` on the unpacked bundle, as LaunchServices answers it; `flags` go before `-a`. */
  const open = (...flags: string[]) => [
    process.execPath,
    FAKE_BUNDLE,
    "open",
    "--installed",
    ...flags,
    "-a",
    bundle,
    "--pids",
    pids,
    "--delay",
    "200",
  ];
  /** The pid of the app that says it is up in `runtime.json`, once it does; 0 after `ms`. */
  const appUp = async (ms: number) => {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      try {
        const rt = JSON.parse(readFileSync(runtime, "utf8")) as { pid: number };
        if (processAlive(rt.pid)) return rt.pid;
      } catch {}
      await Bun.sleep(100);
    }
    return 0;
  };
  const cleanup = (...more: number[]) => {
    const all = [...more];
    if (existsSync(pids)) {
      for (const l of readFileSync(pids, "utf8").trim().split("\n"))
        all.push(Number(l.split(" ")[1]));
    }
    // Never pid 0: that signals this process group, the test runner included.
    for (const pid of all.filter((p) => p > 0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  };
  return { bundle, launcher, pids, runtime, env, as, leftWrapper, unreaped, open, appUp, cleanup };
}

/** Waits until `text()` holds `what`, at most `ms`. */
async function waitFor(text: () => string, what: string | RegExp, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  const has = () => (typeof what === "string" ? text().includes(what) : what.test(text()));
  while (!has() && performance.now() < until) await Bun.sleep(100);
  return has();
}

describe.skipIf(process.platform === "win32")(
  "[DK-M8] [T3.6] the watchdog's reopen with a launcher left behind (no ps on Windows)",
  () => {
    test(
      "a launcher with nothing below it is stopped, the app comes up, and app.log says both",
      async () => {
        const t = tempDir("akou-wd-");
        const b = fakeBundle(t.dir);
        const stray = b.leftWrapper();
        // These two look like it and are not it: a launcher of another bundle whose path starts
        // the same, and a process that only names the launcher.
        mkdirSync(join(`${b.bundle}2`, "Contents", "MacOS"), { recursive: true });
        symlinkSync(process.execPath, join(`${b.bundle}2`, "Contents", "MacOS", "launcher"));
        const other = spawn(
          join(`${b.bundle}2`, "Contents", "MacOS", "launcher"),
          ["-e", "setInterval(() => {}, 1000)"],
          { stdio: "ignore" },
        );
        const names = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", b.launcher], {
          stdio: "ignore",
        });
        const kept = [other.pid, names.pid] as number[];
        let r: Awaited<ReturnType<typeof run>> | null = null;
        try {
          // As the real wrapper, it has a child that exited and was never reaped.
          await Bun.sleep(500);
          expect(b.unreaped(stray.pid as number)).toBe(1);
          // `open` with no `-n`, which starts nothing while the stray is alive: the app comes up
          // only because the stray was stopped first.
          r = await run(
            [
              "--block",
              "30000",
              "--window",
              "--open",
              JSON.stringify(b.open()),
              "--runtime",
              b.runtime,
              "--reopen-wait",
              "8000",
            ],
            t.dir,
            b.env,
          );
          expect(await r.exitWithin(SILENCE + 8000)).toMatch(/^SIGKILL$/);
          const app = await b.appUp(15_000);
          expect(app).toBeGreaterThan(0);
          expect(processAlive(stray.pid as number)).toBe(false);
          for (const pid of kept) expect(processAlive(pid)).toBe(true);
          expect(await waitFor(r.log, `info watchdog: akou is open again (pid ${app})`, 5000)).toBe(
            true,
          );
          expect(r.log()).toContain(
            `warn watchdog: stopped a launcher of akou left with nothing below (pid ${stray.pid}), which open would have taken for the running app`,
          );
          expect(r.log()).not.toContain("did not answer");
        } finally {
          b.cleanup(stray.pid as number, ...kept);
          r?.cleanup();
          t.cleanup();
        }
      },
      LONG,
    );

    test(
      "a launcher whose app still runs is not stopped, and the watchdog's own open -n starts the app beside it",
      async () => {
        const t = tempDir("akou-wd-");
        const b = fakeBundle(t.dir);
        const stray = b.as("stray");
        const busy = b.as("stray", "--with-child");
        let r: Awaited<ReturnType<typeof run>> | null = null;
        try {
          r = await run(
            [
              "--block",
              "30000",
              "--window",
              "--open",
              JSON.stringify(b.open("-n")),
              "--runtime",
              b.runtime,
              "--reopen-wait",
              "8000",
            ],
            t.dir,
            b.env,
          );
          expect(await r.exitWithin(SILENCE + 8000)).toMatch(/^SIGKILL$/);
          expect(await b.appUp(15_000)).toBeGreaterThan(0);
          expect(processAlive(stray.pid as number)).toBe(false);
          expect(processAlive(busy.pid as number)).toBe(true);
        } finally {
          b.cleanup(stray.pid as number, busy.pid as number);
          r?.cleanup();
          t.cleanup();
        }
      },
      LONG,
    );

    test(
      "positive control: the same open, with the launcher still there and nothing stopping it, starts nothing",
      async () => {
        const t = tempDir("akou-wd-");
        const b = fakeBundle(t.dir);
        const stray = b.as("stray");
        try {
          await Bun.sleep(300);
          const open = b.open();
          // What the watchdog ran before: `open -a` on the bundle, and nothing after it.
          spawnSync(open[0] as string, open.slice(1), { env: b.env });
          expect(await b.appUp(3000)).toBe(0);
          expect(processAlive(stray.pid as number)).toBe(true);
          // With `-n`, as the watchdog's own command has it, the same open starts the app.
          const anew = b.open("-n");
          spawnSync(anew[0] as string, anew.slice(1), { env: b.env });
          expect(await b.appUp(10_000)).toBeGreaterThan(0);
        } finally {
          b.cleanup(stray.pid as number);
          t.cleanup();
        }
      },
      LONG,
    );

    test(
      "an app that never comes up is opened once more, and app.log says it did not come up",
      async () => {
        const t = tempDir("akou-wd-");
        const b = fakeBundle(t.dir);
        const marker = join(t.dir, "opens.marker");
        let r: Awaited<ReturnType<typeof run>> | null = null;
        try {
          r = await run(
            ["--block", "30000", "--window", "--reopen", marker, "--runtime", b.runtime],
            t.dir,
            b.env,
          );
          expect(await r.exitWithin(SILENCE + 8000)).toMatch(/^SIGKILL$/);
          expect(
            await waitFor(
              r.log,
              "error watchdog: akou did not come up after being opened twice (exit code 0); open it by hand, or run any akou command",
              15_000,
            ),
          ).toBe(true);
          expect(r.log()).toContain(
            "warn watchdog: akou did not answer within 0.3 s of being opened again (exit code 0); opening it once more",
          );
          expect(readFileSync(marker, "utf8")).toBe("xx");
          expect(r.log()).not.toContain("akou is open again");
        } finally {
          b.cleanup();
          r?.cleanup();
          t.cleanup();
        }
      },
      LONG,
    );
  },
);
