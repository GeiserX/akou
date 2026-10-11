/**
 * `POST /provider/warm` against the app (#383): the ask box's focus starts the user's harness
 * early, a second warm keeps the same process, other providers start nothing, and quitting akou
 * stops the harness that waited. The harness is the fake one behind a pinned path; no test runs a
 * real harness.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "../src/main/config/schema.ts";
import { appRig } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-harness.ts");
const FIX = join(import.meta.dir, "fixtures", "harness", "claude-ok.jsonl");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean, ms = 5000) => {
  const end = performance.now() + ms;
  while (!ok() && performance.now() < end) await Bun.sleep(20);
  return ok();
};

describe("POST /provider/warm", () => {
  test("with no assistant there is nothing to start", async () => {
    const rig = await appRig();
    try {
      const r = await rig.api("POST", "/provider/warm", {});
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ warming: false, reason: "the none provider has nothing to start" });
    } finally {
      await rig.close();
    }
  });

  test.skipIf(process.platform === "win32")(
    "the harness starts once, waits with nothing sent, and stops when akou quits (a POSIX shell stand-in; skipped on Windows)",
    async () => {
      const t = tempDir();
      const pidFile = join(t.dir, "harness.pid");
      const record = join(t.dir, "record.json");
      // The app gives the harness its own small environment: the stand-in sets what the fake reads.
      const claude = join(t.dir, "claude");
      writeFileSync(
        claude,
        `#!/bin/sh\nexport FAKE_PIDFILE='${pidFile}' FAKE_RECORD='${record}'\nexec '${process.execPath}' '${FAKE}' '${FIX}' "$@"\n`,
      );
      chmodSync(claude, 0o755);
      const rig = await appRig({
        settings: { "provider.kind": "harness", "provider.harnessPath": claude },
      });
      let pid = 0;
      try {
        const r = await rig.api("POST", "/provider/warm", {});
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ warming: true });
        expect(await until(() => existsSync(pidFile))).toBe(true);
        pid = Number(readFileSync(pidFile, "utf8"));
        expect(alive(pid)).toBe(true);
        // The box asks again while it has focus: the same harness is kept, none is added.
        const again = await rig.api("POST", "/provider/warm", {});
        expect(again.body).toEqual({ warming: true });
        await Bun.sleep(200);
        expect(Number(readFileSync(pidFile, "utf8"))).toBe(pid);
        // Nothing reached it: no question was asked.
        expect(existsSync(record)).toBe(false);
      } finally {
        await rig.close();
      }
      expect(await until(() => !alive(pid))).toBe(true);
      // It ended with nothing on its stdin.
      if (existsSync(record)) expect(JSON.parse(readFileSync(record, "utf8")).stdin).toBe("");
      t.cleanup();
    },
    20_000,
  );

  test.skipIf(process.platform === "win32")(
    "provider.harnessSafeMode: off by default, so Claude Code runs as the user set it up; on, it gets --safe-mode (a POSIX shell stand-in; skipped on Windows)",
    async () => {
      expect(SETTINGS["provider.harnessSafeMode"].default).toBe(false);
      const argvOf = async (settings: Record<string, unknown>) => {
        const t = tempDir();
        const argvFile = join(t.dir, "argv.json");
        const claude = join(t.dir, "claude");
        writeFileSync(
          claude,
          `#!/bin/sh\nexport FAKE_ARGVFILE='${argvFile}'\nexec '${process.execPath}' '${FAKE}' '${FIX}' "$@"\n`,
        );
        chmodSync(claude, 0o755);
        // Discovery knows the version, so the version gate is not what decides.
        const rig = await appRig({
          settings: { "provider.kind": "harness", ...settings },
          discover: async () => ({
            claude: { kind: "claude", path: claude, version: "2.1.281" },
            codex: null,
          }),
        });
        try {
          let r = await rig.api("POST", "/provider/warm", {});
          // Discovery runs in the background: the first warm may find it still looking.
          for (let i = 0; i < 50 && r.body.warming !== true; i++) {
            await Bun.sleep(50);
            r = await rig.api("POST", "/provider/warm", {});
          }
          expect(r.body).toEqual({ warming: true });
          expect(await until(() => existsSync(argvFile))).toBe(true);
          return JSON.parse(readFileSync(argvFile, "utf8")) as string[];
        } finally {
          await rig.close();
          t.cleanup();
        }
      };
      expect(await argvOf({})).not.toContain("--safe-mode");
      expect(await argvOf({ "provider.harnessSafeMode": true })).toContain("--safe-mode");
    },
    20_000,
  );

  test("with session reuse on, nothing starts early", async () => {
    const rig = await appRig({
      settings: {
        "provider.kind": "harness",
        "provider.harnessPath": "/nonexistent/claude",
        "provider.harnessResume": true,
      },
    });
    try {
      const r = await rig.api("POST", "/provider/warm", {});
      expect(r.body.warming).toBe(false);
      expect(r.body.reason).toContain("session reuse is on");
    } finally {
      await rig.close();
    }
  });
});
