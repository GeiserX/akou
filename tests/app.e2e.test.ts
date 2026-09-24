/**
 * The app's lifecycle (docs/DESIGN.md sections 1.4, 1.5 and 4.5): single instance, runtime.json,
 * the one quit path, and headless mode from the environment. The last test runs the real entry
 * point, `bun src/main/index.ts`, as a child process with the fake helper.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AlreadyRunningError, APP_LOCK, startApp } from "../src/main/index.ts";
import { appRig, FAKE_HELPER, writeSettings } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;
const SRC = join(import.meta.dir, "..", "src");

describe("single instance", () => {
  test("a second app on the same config folder refuses and names the first", async () => {
    const rig = await appRig();
    let err: unknown;
    try {
      await startApp({ env: rig.env, models: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AlreadyRunningError);
    expect((err as AlreadyRunningError).pid).toBe(process.pid);
    expect((err as AlreadyRunningError).runtime?.port).toBe(rig.port);
    // The refused start left the running app alone.
    expect((await rig.api("GET", "/status")).status).toBe(200);
    await rig.close();
  });

  test("a lock left by a dead process is taken over", async () => {
    const t = tempDir();
    writeSettings(t.dir, { "api.port": 0 });
    // A pid that is certainly not running.
    writeFileSync(join(t.dir, ".config", "akou", APP_LOCK), "2147483646\n");
    const app = await startApp({ env: { AKOU_HOME: t.dir }, models: null, onLog: () => {} });
    expect(readFileSync(join(t.dir, ".config", "akou", APP_LOCK), "utf8").trim()).toBe(
      String(process.pid),
    );
    await app.quit();
    t.cleanup();
  });
});

describe("[T2.51] Quit untested / [spike] Signals swallowed by the shell", () => {
  test(
    "POST /quit mid-recording stops the helper, ends the log, removes runtime.json and the lock",
    async () => {
      const rig = await appRig();
      const id = await rig.startCall();
      const folder = (await rig.api("GET", `/calls/${id}`)).body.folder as string;
      const r = await rig.api("POST", "/quit");
      expect(r.status).toBe(202);
      await rig.app.closed;
      const lines = readFileSync(join(folder, "events.jsonl"), "utf8").trim().split("\n");
      const types = lines.map((l) => JSON.parse(l).type);
      expect(types.slice(-2)).toEqual(["part.ended", "call.ended"]);
      expect(JSON.parse(lines.at(-2) as string).reason).toBe("stop");
      expect(existsSync(rig.app.runtimeFile)).toBe(false);
      expect(existsSync(join(rig.app.configDir, APP_LOCK))).toBe(false);
      expect(existsSync(join(folder, ".akou.lock"))).toBe(false);
      // The port is closed.
      await expect(fetch(`http://127.0.0.1:${rig.port}/v1/status`)).rejects.toThrow();
      // And the app can start again on the same folder.
      const again = await startApp({ env: rig.env, models: null, onLog: () => {} });
      expect(again.server?.port).toBeGreaterThan(0);
      await again.quit();
      await rig.close();
    },
    LONG,
  );
});

describe("the final pass without readable audio", () => {
  test(
    "finalize answers 501 with the reason, and nothing is written to the log",
    async () => {
      const rig = await appRig();
      const id = await rig.startCall();
      await rig.api("POST", "/calls/live/stop");
      const before = (await rig.api("GET", `/calls/${id}/events`)).body.cursor;
      const r = await rig.api("POST", `/calls/${id}/finalize`);
      expect(r.status).toBe(501);
      expect(r.body).toMatchObject({ error: "final_unavailable", call: id });
      expect(r.body.message).toContain("Opus decoding is not built");
      expect((await rig.api("GET", `/calls/${id}/events`)).body.cursor).toBe(before);
      await rig.close();
    },
    LONG,
  );
});

describe("[spike] Command-line arguments dropped by the launcher", () => {
  test("no code reads process.argv for mode selection; headless comes from AKOU_HEADLESS", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && readFileSync(p, "utf8").includes("process.argv"))
          hits.push(p);
      }
    };
    walk(SRC);
    expect(hits).toEqual([]);
    expect(readFileSync(join(SRC, "main", "index.ts"), "utf8")).toContain("AKOU_HEADLESS");
  });

  test(
    "the entry point runs headless as a child: listens, answers, starts a call, quits cleanly",
    async () => {
      const t = tempDir();
      writeSettings(t.dir, {
        "api.port": 0,
        "capture.helper": [process.execPath, FAKE_HELPER],
      });
      const proc = Bun.spawn([process.execPath, join(SRC, "main", "index.ts")], {
        env: { ...process.env, AKOU_HOME: t.dir, AKOU_HEADLESS: "1", NO_PROXY: "127.0.0.1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const rtPath = join(t.dir, ".config", "akou", "runtime.json");
      await until(() => existsSync(rtPath), 10_000, "runtime.json");
      const rt = JSON.parse(readFileSync(rtPath, "utf8"));
      expect(rt).toMatchObject({ pid: proc.pid, headless: true });
      const token = readFileSync(join(t.dir, ".config", "akou", "token"), "utf8").trim();
      const call = (method: string, path: string) =>
        fetch(`http://127.0.0.1:${rt.port}/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(method === "GET" ? {} : { "content-type": "application/json" }),
          },
          body: method === "GET" ? undefined : "{}",
        });
      const status = (await (await call("GET", "/status")).json()) as { asr: { state: string } };
      // No models in this home: the recognizer says why, and capture still works.
      expect(status.asr.state).toBe("unavailable");
      expect((await call("POST", "/calls")).status).toBe(201);
      expect((await call("POST", "/quit")).status).toBe(202);
      expect(await proc.exited).toBe(0);
      expect(existsSync(rtPath)).toBe(false);
      t.cleanup();
    },
    LONG,
  );
});
