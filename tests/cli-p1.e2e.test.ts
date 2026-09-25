/**
 * CLI rules checked end to end against a headless app (docs/ux/CLI.md): probes that never launch
 * the app (CLI-23), one way to name a call (CLI-03), secrets only from stdin (CLI-06), the OS
 * grants in `doctor` (CLI-38), and no header making a request the user's (CLI-24).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/core/log/writer.ts";
import type { ModelSpecEntry } from "../src/main/asr/models.ts";
import { runCli } from "../src/main/cli/cli.ts";
import { EXIT } from "../src/main/cli/client.ts";
import type { Grant, GrantChecker } from "../src/main/cli/context.ts";
import { type AppRig, appRig, FAKE_HELPER, writeSettings } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cliChild, rigCli } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";
import { shellOn } from "./shell-helpers.ts";

const LONG = 60_000;

describe("[CLI-23] Probes never launch the app", () => {
  test(
    "with the app down and a fresh AKOU_HOME, no probe launches it; `akou tail` does",
    async () => {
      const t = tempDir();
      writeSettings(t.dir, {
        "api.port": 0,
        "capture.helper": [process.execPath, FAKE_HELPER],
        "provider.kind": "none",
      });
      // The real entry point with its real launcher: nothing here stops a launch but the rule.
      const env = { ...process.env, AKOU_HOME: t.dir, AKOU_HEADLESS: undefined };
      const config = join(t.dir, ".config", "akou");
      const runtime = join(config, "runtime.json");
      // The launcher opens app.log before it spawns the app, so its absence means no launch.
      const launched = () => existsSync(join(config, "app.log")) || existsSync(runtime);
      let pid = 0;
      try {
        for (const argv of [
          ["status"],
          ["status", "--json"],
          ["help"],
          [],
          ["help", "tail"],
          ["tail", "--help"],
          ["--version"],
          ["-v"],
          ["completion", "zsh"],
          ["config", "path"],
          ["token", "path"],
        ]) {
          const r = await cliChild(env, argv);
          expect([argv, typeof r.code, launched()]).toEqual([argv, "number", false]);
        }
        // Positive control: a command that needs the app launches it in the same setup.
        const tail = await cliChild(env, ["tail"]);
        expect(tail.code).toBe(EXIT.notLive);
        expect(launched()).toBe(true);
        pid = JSON.parse(readFileSync(runtime, "utf8")).pid;
        expect(processAlive(pid)).toBe(true);
        expect((await cliChild(env, ["quit"])).code).toBe(0);
      } finally {
        if (pid && processAlive(pid)) process.kill(pid, "SIGTERM");
        t.cleanup();
      }
    },
    LONG,
  );
});

describe("with a running app", () => {
  let rig: AppRig;
  let run: ReturnType<typeof rigCli>;
  let id: string;

  beforeAll(async () => {
    rig = await appRig();
    run = rigCli(rig);
    id = await rig.startCall({ title: "Named", withoutModels: true });
    const w0 = Date.now() - 30_000;
    await rig.app.write(id, {
      type: "seg",
      id: "l900001",
      rev: 1,
      layer: "live",
      part: 1,
      ch: "call",
      spk: "c2",
      a0: 1,
      a1: 2,
      w0,
      w1: w0 + 900,
      text: "the release moves to thursday",
      model: "fake",
    } as never);
    await rig.api("POST", "/calls/live/stop");
  }, LONG);
  afterAll(() => rig.close());

  describe("[CLI-03] One way to name a call in every command", () => {
    test("`akou show -c X` and `akou show X` print the same bytes", async () => {
      for (const x of [id, "last"]) {
        const word = await run(["show", x]);
        const flag = await run(["show", "-c", x]);
        expect(word.code).toBe(0);
        expect(word.out).toContain("the release moves to thursday");
        expect([x, flag.code, flag.out, flag.err]).toEqual([x, word.code, word.out, word.err]);
        expect((await run(["show", "--call", x])).out).toBe(word.out);
      }
      // Positive control: a different call prints different bytes, so the comparison can fail.
      const other = await rig.startCall({ title: "Other", withoutModels: true });
      await rig.api("POST", "/calls/live/stop");
      expect((await run(["show", "-c", other])).out).not.toBe((await run(["show", id])).out);
    });
  });

  describe("[CLI-06] Secrets are read from stdin, never from the command line", () => {
    const file = () => join(rig.home, ".config", "akou", "config.json");
    const stored = () => JSON.parse(readFileSync(file(), "utf8"))["provider.apiKey"];

    test("`printf 'sk-test' | akou config set provider.apiKey -` stores it; show prints (set)", async () => {
      const env = { ...process.env, ...rig.env };
      const set = await cliChild(env, ["config", "set", "provider.apiKey", "-"], {
        stdin: "sk-test",
      });
      expect(set.code).toBe(0);
      expect(set.out).not.toContain("sk-test");
      expect(stored()).toBe("sk-test");
      const show = await cliChild(env, ["config", "show"]);
      expect(show.out).toContain('provider.apiKey = "(set)"');
      expect(show.out).not.toContain("sk-test");
      // `echo` adds a newline, which is the shell's, not the key's.
      await cliChild(env, ["config", "set", "provider.apiKey", "-"], { stdin: "sk-echo\n" });
      expect(stored()).toBe("sk-echo");
      // Any key reads stdin with `-`, not only secrets.
      const threads = await cliChild(env, ["config", "set", "asr.threads", "-"], { stdin: "3" });
      expect(threads.code).toBe(0);
      expect(threads.out).toContain("asr.threads = 3");
      expect((await run(["config", "unset", "asr.threads"])).code).toBe(0);
    });

    test("`akou config set provider.apiKey sk-test` exits 64, stores nothing, and shows the stdin form", async () => {
      expect((await run(["config", "unset", "provider.apiKey"])).code).toBe(0);
      const before = readFileSync(file(), "utf8");
      const r = await run(["config", "set", "provider.apiKey", "sk-test"]);
      expect(r.code).toBe(EXIT.usage);
      expect(readFileSync(file(), "utf8")).toBe(before);
      expect(stored()).toBeUndefined();
      const lines = r.err.split("\n");
      expect(lines.length).toBe(2);
      expect(lines[1]).toBe(`  try: printf '%s' "$VALUE" | akou config set provider.apiKey -`);
      expect(r.err).not.toContain("sk-test");
      // With --json the same, as the error body plus its hint.
      const j = await run(["config", "set", "webhook.secret", "hush", "--json"]);
      expect(j.code).toBe(EXIT.usage);
      expect(j.json.hint).toBe(`printf '%s' "$VALUE" | akou config set webhook.secret -`);
      expect(JSON.stringify(j.json)).not.toContain("hush");
      // Positive control: a key that is not secret is still taken from the command line.
      expect((await run(["config", "set", "asr.threads", "3"])).code).toBe(0);
      expect((await run(["config", "unset", "asr.threads"])).code).toBe(0);
    });
  });

  describe("[CLI-38] doctor --grant checks and requests the OS grants", () => {
    const tiny = new TextEncoder().encode("not a real model\n");
    const tinyModel: ModelSpecEntry = {
      id: "tiny",
      job: "test",
      licence: "none",
      source: "generated",
      files: [
        {
          name: "tiny.bin",
          url: "http://127.0.0.1:9/tiny.bin",
          sha256: createHash("sha256").update(tiny).digest("hex"),
          size: tiny.length,
        },
      ],
    };

    /** A grant checker that reports what it is told and records every request. */
    function fakeGrants(states: Record<string, Grant["state"]>) {
      const requested: string[] = [];
      const checker: GrantChecker = {
        check: async () =>
          Object.entries(states).map(([name, state]) => ({ name, state, detail: "fake" })),
        request: async (name) => {
          requested.push(name);
          return "requested";
        },
      };
      return { requested, checker };
    }

    async function doctor(argv: string[], grants: GrantChecker, tty: boolean) {
      const out: string[] = [];
      const code = await runCli(
        ["doctor", ...argv],
        { env: { ...process.env, ...rig.env }, out: (t) => out.push(t), err: () => {}, tty },
        { launch: null, models: [tinyModel], grants },
      );
      return { code, out: out.join("\n") };
    }

    beforeAll(() => {
      const dir = join(rig.home, ".local", "share", "akou", "models", "tiny");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "tiny.bin"), tiny);
    });

    test("with the microphone missing, --grant requests it once and reports `mic: requested`", async () => {
      const g = fakeGrants({ mic: "missing", "system audio": "granted" });
      const r = await doctor(["--grant"], g.checker, true);
      expect(g.requested).toEqual(["mic"]);
      expect(r.out).toMatch(/^warn {2}mic: requested/m);
      expect(r.out).toMatch(/^ok {4}system audio: granted/m);
    });

    test("with both granted it requests nothing and exits 0", async () => {
      const g = fakeGrants({ mic: "granted", "system audio": "granted" });
      const r = await doctor(["--grant"], g.checker, true);
      expect(g.requested).toEqual([]);
      expect(r.code).toBe(0);
    });

    test("--json lists each grant and its state", async () => {
      const g = fakeGrants({ mic: "missing", "system audio": "granted", accessibility: "unknown" });
      const r = await doctor(["--grant", "--json"], g.checker, true);
      const body = JSON.parse(r.out);
      expect(body.grants.map((x: Grant) => [x.name, x.state])).toEqual([
        ["mic", "requested"],
        ["system audio", "granted"],
        ["accessibility", "unknown"],
      ]);
      const plain = JSON.parse((await doctor(["--json"], g.checker, true)).out);
      expect(plain.grants.map((x: Grant) => [x.name, x.state])).toEqual([
        ["mic", "missing"],
        ["system audio", "granted"],
        ["accessibility", "unknown"],
      ]);
    });

    test("--grant asks for one grant per run, since each settings pane replaces the one before", async () => {
      const states: Record<string, Grant["state"]> = {
        mic: "missing",
        "system audio": "missing",
        accessibility: "unknown",
      };
      const g = fakeGrants(states);
      const first = await doctor(["--grant"], g.checker, true);
      expect(g.requested).toEqual(["mic"]);
      expect(first.out).toMatch(/^warn {2}mic: requested/m);
      expect(first.out).toMatch(/^fail {2}system audio: missing; run `akou doctor --grant` again/m);
      // The next run asks for the next one.
      states.mic = "granted";
      await doctor(["--grant"], g.checker, true);
      expect(g.requested).toEqual(["mic", "system audio"]);
    });

    test("positive controls: plain doctor and --grant without a terminal ask nothing, and a missing grant fails", async () => {
      const g = fakeGrants({ mic: "missing", "system audio": "granted" });
      const plain = await doctor([], g.checker, true);
      const piped = await doctor(["--grant"], g.checker, false);
      expect(g.requested).toEqual([]);
      for (const r of [plain, piped]) {
        expect(r.code).toBe(EXIT.unavailable);
        expect(r.out).toMatch(/^fail {2}mic: missing; run `akou doctor --grant` in a terminal/m);
      }
      expect(piped.out).toContain("--grant asks only on a terminal");
    });
  });

  describe("[CLI-24] no header makes a request the user's", () => {
    test("X-Akou-Client: user, in any case, writes as an agent; `cli` and odd names keep theirs", async () => {
      const live = await rig.startCall({ title: "Authors", withoutModels: true });
      try {
        const clients = {
          typed: "user",
          shouted: "USER",
          title: "User",
          scripted: "cli",
          odd: "User!",
        };
        for (const [text, client] of Object.entries(clients)) {
          const r = await rig.api(
            "POST",
            `/calls/${live}/notes`,
            { text },
            { "x-akou-client": client },
          );
          expect(r.status).toBe(201);
        }
        const notes = (await rig.api("GET", `/calls/${live}/events`)).body.events
          .filter((e: { type: string }) => e.type === "note")
          .map((e: { text: string; by: string }) => [e.text, e.by]);
        expect(notes).toEqual([
          ["typed", "agent:user"],
          ["shouted", "agent:user"],
          ["title", "agent:user"],
          ["scripted", "agent:cli"],
          ["odd", "agent:api"],
        ]);
      } finally {
        await rig.api("POST", "/calls/live/stop");
      }
    });
  });
});

describe("[CLI-24] a start or share sent as `user` is still announced (PRINCIPLES 10)", () => {
  test(
    "with the window in front, X-Akou-Client: user on POST /calls and POST /share notifies; the window's own start does not",
    async () => {
      const rig = await appRig({ settings: { "share.bind": "127.0.0.1", "share.port": 0 } });
      const { shell, f, bridge } = await shellOn(rig);
      try {
        shell.show();
        // Positive control: the window's own start, with the window in front, is silent.
        expect((await bridge.json("POST", "/calls", {})).status).toBe(201);
        await Bun.sleep(300);
        expect(f.notices).toEqual([]);
        expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);

        const user = { "x-akou-client": "user" };
        expect((await rig.api("POST", "/calls", {}, user)).status).toBe(201);
        await until(() => f.notices.length >= 1, 5000, "the start notice");
        expect((await rig.api("POST", "/share", {}, { "x-akou-client": "User" })).status).toBe(201);
        await until(() => f.notices.length >= 2, 5000, "the share notice");
        expect(f.notices).toEqual([
          { title: "Recording started", body: "Started by an agent" },
          { title: "This call is shared live", body: "Stop it from the akou window." },
        ]);
      } finally {
        await rig.api("DELETE", "/share", {});
        await rig.api("POST", "/calls/live/stop");
        await shell.close();
        await rig.close();
      }
    },
    LONG,
  );
});
