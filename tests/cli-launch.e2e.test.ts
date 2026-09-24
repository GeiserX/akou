/**
 * The real `akou` entry point as a child process (docs/DESIGN.md sections 1.4, 1.5, 6.1 and 6.3):
 * with no app running, `akou start` launches the app headless and answers within the cold budget;
 * `akou quit` stops it; and a proxy in the environment never gets between the CLI and 127.0.0.1.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/core/log/writer.ts";
import { appRig, FAKE_HELPER, writeSettings } from "./api-helpers.ts";
import { cliChild } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const LONG = 60_000;

describe("[T4.11] Login agent does not start mid-session / [T3.6] Minutes to start", () => {
  test(
    "akou start with no app running launches it headless and answers 201 within 3 s; quit stops it",
    async () => {
      const t = tempDir();
      writeSettings(t.dir, {
        "api.port": 0,
        "capture.helper": [process.execPath, FAKE_HELPER],
      });
      const env = { ...process.env, AKOU_HOME: t.dir, AKOU_HEADLESS: undefined };
      const rtPath = join(t.dir, ".config", "akou", "runtime.json");
      expect(existsSync(rtPath)).toBe(false);
      let pid = 0;
      try {
        const start = await cliChild(env, ["start", "-t", "Cold", "--json"]);
        console.log(`akou start (app cold, as a child process): ${start.ms.toFixed(0)} ms`);
        expect(start.code).toBe(0);
        const body = JSON.parse(start.out);
        expect(body.part).toBe(1);
        // The design's cold target is 3 s from the command; the process start of the CLI itself
        // is part of it.
        expect(start.ms).toBeLessThan(3000);
        const rt = JSON.parse(readFileSync(rtPath, "utf8"));
        pid = rt.pid;
        // Headless because the CLI set AKOU_HEADLESS, not by an argument.
        expect(rt.headless).toBe(true);

        const status = await cliChild(env, ["status", "--json"]);
        expect(status.code).toBe(0);
        expect(JSON.parse(status.out).live.call).toBe(body.call);

        const quit = await cliChild(env, ["quit"]);
        expect(quit.code).toBe(0);
        expect(quit.out.trim()).toBe("akou has quit");
        expect(existsSync(rtPath)).toBe(false);
        const log = readFileSync(join(body.folder, "events.jsonl"), "utf8").trim().split("\n");
        expect(log.map((l) => JSON.parse(l).type).slice(-2)).toEqual(["part.ended", "call.ended"]);
      } finally {
        // A failed assertion must not leave the launched app running.
        if (pid && processAlive(pid)) process.kill(pid, "SIGTERM");
        t.cleanup();
      }
    },
    LONG,
  );
});

describe("[F2.7] Proxy on loopback", () => {
  test(
    "the CLI reaches 127.0.0.1 directly with every proxy variable pointing at a dead port",
    async () => {
      const rig = await appRig();
      try {
        const dead = "http://127.0.0.1:9";
        const env = {
          ...process.env,
          ...rig.env,
          HTTP_PROXY: dead,
          http_proxy: dead,
          HTTPS_PROXY: dead,
          https_proxy: dead,
          ALL_PROXY: dead,
          all_proxy: dead,
          NO_PROXY: "",
          no_proxy: "",
        };
        const r = await cliChild(env, ["status", "--json"]);
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out).app.port).toBe(rig.port);
        // No positive control is possible on this runtime: Bun 1.3.12 never sends a loopback
        // request through a proxy, even when `fetch` is given one explicitly (measured). The CLI
        // still adds the loopback names to NO_PROXY for itself and the app it launches, for
        // runtimes that do.
      } finally {
        await rig.close();
      }
    },
    LONG,
  );
});
