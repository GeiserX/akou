/**
 * The CLI end to end (docs/DESIGN.md section 6.1): every command against a headless app that
 * captures from `scripts/fake-helper.ts` and transcribes with the fake recognizer, over the real
 * API with the real token. Exit codes follow the design: 0, 3, 64, 65, 69, 70, 75, 77.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openGuard } from "../src/main/api/guard.ts";
import type { ModelSpecEntry } from "../src/main/asr/models.ts";
import { EXIT, exitFor } from "../src/main/cli/client.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cli, rigCli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;
let rig: AppRig;
let run: ReturnType<typeof rigCli>;
let wavDir: { dir: string; cleanup: () => void };

/** Mic: "hello world"; call: "deploy to hetzner", which the fake engine hears as "hetzna". */
function writeSpeech(dir: string): string {
  const mic = concat(silence(0.3), speak(["hello", "world"]), silence(2.2));
  const call = concat(silence(1.1), speak(["deploy", "to", "hetzner"], { voice: 2 }), silence(0.6));
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
  const path = join(dir, "speech.wav");
  writeFileSync(path, stereoWav(pad(mic), pad(call)));
  return path;
}

beforeAll(async () => {
  wavDir = tempDir();
  rig = await appRig({ helperArgs: ["--wav", writeSpeech(wavDir.dir)] });
  run = rigCli(rig);
});

afterAll(async () => {
  await rig?.close();
  wavDir?.cleanup();
});

async function stopAll(): Promise<void> {
  const r = await rig.api("GET", "/calls/live");
  if (r.status === 200) await rig.api("POST", "/calls/live/stop");
}

async function waitForCallLine(id: string): Promise<void> {
  await until(
    async () =>
      (await rig.api("GET", `/calls/${id}/transcript`)).body.lines.some(
        (l: { ch: string }) => l.ch === "call",
      ),
    10_000,
    "a call-channel line",
  );
}

describe("exit codes", () => {
  test("every API answer maps to the design's code", () => {
    expect(exitFor(201)).toBe(0);
    expect(exitFor(404, "no_live_call")).toBe(3);
    expect(exitFor(409, "already_recording")).toBe(75);
    expect(exitFor(400, "bad_term")).toBe(65);
    expect(exitFor(400, "unknown_field")).toBe(64);
    expect(exitFor(400, "last_refused")).toBe(64);
    expect(exitFor(404, "not_found")).toBe(64);
    expect(exitFor(401, "unauthorized")).toBe(77);
    expect(exitFor(403, "permission")).toBe(77);
    expect(exitFor(501, "not_implemented")).toBe(69);
    expect(exitFor(503, "capture_failed")).toBe(69);
    expect(exitFor(409, "final_running")).toBe(69);
    expect(exitFor(500, "internal")).toBe(70);
  });

  test("usage errors exit 64 and name the command's usage", async () => {
    const r = await run(["start", "--bogus"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("unknown option --bogus");
    expect(r.err).toContain("usage: akou start");
    expect((await run(["frobnicate"])).code).toBe(EXIT.usage);
    expect((await run(["context"])).code).toBe(EXIT.usage);
    expect((await run(["tail", "--last", "soon"])).code).toBe(EXIT.usage);
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    for (const name of ["start", "tail", "context", "vocab", "doctor", "mcp", "quit"]) {
      expect(help.out).toContain(`  ${name} `);
    }
  });

  test("commands whose machinery is not built say so and exit 69", async () => {
    for (const argv of [["open"], ["devices"], ["apps"], ["hooks", "run", "x"], ["self-update"]]) {
      const r = await run(argv);
      expect(r.code).toBe(EXIT.unavailable);
      expect(r.err).toContain("not built yet");
    }
  });
});

describe("starting and controlling", () => {
  test(
    "[T3.6] start --json answers with the call once audio is written; a second start exits 75",
    async () => {
      await stopAll();
      const t0 = performance.now();
      const r = await run([
        "start",
        "-w",
        "work",
        "-t",
        "Weekly",
        "sync",
        "--vocab",
        "Ben,Ana",
        "--json",
      ]);
      const ms = performance.now() - t0;
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ part: 1, url: `akou://call/${r.json.call}` });
      // The design's target with the app running is 1 s.
      console.log(`akou start (app running): ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThan(1000);
      const detail = await rig.api("GET", `/calls/${r.json.call}`);
      expect(detail.body).toMatchObject({ title: "Weekly sync", workspace: "work" });
      const events = (await rig.api("GET", `/calls/${r.json.call}/events`)).body.events;
      const adds = events.filter((e: { type: string }) => e.type === "vocab.add");
      expect(adds.map((e: { term: string }) => e.term)).toEqual(["Ben", "Ana"]);
      // Written by the CLI, so marked as an agent's.
      expect(adds[0].by).toBe("agent:cli");

      const again = await run(["start", "-t", "Other"]);
      expect(again.code).toBe(EXIT.alreadyRecording);
      expect(again.err).toContain(r.json.call);
    },
    LONG,
  );

  test(
    "pause, resume, mute, unmute and stop; with nothing live they exit 3 and name the last call",
    async () => {
      await stopAll();
      const start = await run(["start", "-t", "Controls"]);
      expect(start.code).toBe(0);
      expect(start.out).toMatch(/^Recording \S+ \(audio after \d+ ms\)\nfolder: /);
      expect((await run(["pause"])).out).toMatch(/: paused$/);
      expect((await run(["resume"])).out).toMatch(/: recording$/);
      expect((await run(["mute", "--json"])).json).toMatchObject({ ok: true });
      expect((await run(["unmute"])).code).toBe(0);
      expect((await run(["stop"])).code).toBe(0);
      const none = await run(["stop"]);
      expect(none.code).toBe(EXIT.notLive);
      expect(none.err).toMatch(
        /nothing is recording; the last call, "Controls", ended at \d\d:\d\d/,
      );
      const json = await run(["pause", "--json"]);
      expect(json.code).toBe(3);
      expect(json.json).toMatchObject({ error: "no_live_call", last: { title: "Controls" } });
      // restart takes the last call: a new part in the same call.
      const re = await run(["restart", "--json"]);
      expect(re.code).toBe(0);
      expect(re.json.part).toBe(2);
      await stopAll();
    },
    LONG,
  );

  test("status: human and --json, and the call list", async () => {
    await stopAll();
    const h = await run(["status"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain(`port ${rig.port}, headless`);
    expect(h.out).toContain("Live: nothing is recording");
    expect(h.out).toMatch(/Last: "[^"]+", ended, ended \d\d:\d\d/);
    const j = await run(["status", "--json"]);
    expect(j.json.app.port).toBe(rig.port);
    const calls = await run(["calls", "--limit", "2"]);
    expect(calls.code).toBe(0);
    expect(calls.out.split("\n").length).toBe(2);
    expect(calls.out).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d {2}\d+ min/);
  });
});

describe("following and questioning", () => {
  let id: string;

  test(
    "tail prints committed lines with wall times; context, search and ask",
    async () => {
      await stopAll();
      id = (await run(["start", "-t", "Deploy", "talk", "--json"])).json.call;
      await waitForCallLine(id);
      const txt = await run(["tail"]);
      expect(txt.code).toBe(0);
      expect(txt.out).toMatch(/^\d\d:\d\d:\d\d Ana: hello world$/m);
      expect(txt.out).toMatch(/^\d\d:\d\d:\d\d \S.*: deploy to hetzna$/m);
      const md = await run(["tail", "--format", "md", "--last", "5m"]);
      expect(md.out).toMatch(/^\*\*\d\d:\d\d:\d\d Ana:\*\* hello world$/m);
      const nd = await run(["tail", "--json"]);
      const rows = nd.out.split("\n").map((l) => JSON.parse(l));
      expect(rows[0]).toMatchObject({ speaker: "Ana", text: "hello world" });

      const ctx = await run(["context", "what", "did", "they", "say", "about", "deploy"]);
      expect(ctx.code).toBe(0);
      expect(ctx.out).toContain("LIVE, recording now");
      expect(ctx.out).toMatch(/\n\ncursor \d+ · LIVE · \d+ tokens$/);
      const cj = await run(["context", "deploy?", "--budget", "2000", "--json"]);
      expect(cj.json).toMatchObject({ call: id, state: "LIVE" });
      expect(cj.json.tokens).toBeLessThanOrEqual(2000);

      const s = await run(["search", "hello"]);
      expect(s.code).toBe(0);
      expect(s.out).toContain("hello world");
      expect(s.out).toMatch(/\d\d:\d\d/);

      const ask = await run(["ask", "what", "now?"]);
      expect(ask.code).toBe(EXIT.unavailable);
      expect(ask.err).toContain("akou context");
    },
    LONG,
  );

  test(
    "tail -f follows the call and returns when it ends",
    async () => {
      const lines: string[] = [];
      const following = cli({ ...process.env, ...rig.env }, ["tail", "-f", "--since", "0"], {
        launch: null,
      }).then((r) => {
        lines.push(r.out);
        return r;
      });
      await new Promise((r) => setTimeout(r, 300));
      await run(["note", "a note to wake the follower"]);
      await run(["stop"]);
      const r = await following;
      expect(r.code).toBe(0);
      expect(r.err).toContain("the call ended");
      expect(r.out).toContain("hello world");
    },
    LONG,
  );

  test(
    "names, notes and memory land on the call, marked as the CLI's",
    async () => {
      await stopAll();
      id = (await run(["start", "-t", "People", "--json"])).json.call;
      await waitForCallLine(id);
      const named = await run(["name", "c2", "Ben", "Carter"]);
      expect(named.code).toBe(0);
      expect(named.out).toBe("c2 is Ben Carter");
      expect((await run(["name", "bob", "Ben"])).code).toBe(EXIT.usage);
      expect((await run(["note", "ship", "friday"])).code).toBe(0);
      const rem = await run(["remember", "Ben owns the deploy", "--json"]);
      expect(rem.code).toBe(0);
      const rid = rem.json.remember.id as string;
      const ctx = await run(["context", "who owns the deploy?"]);
      expect(ctx.out).toContain("Ben Carter");
      expect(ctx.out).toContain("Ben owns the deploy");
      expect((await run(["remember", "--del", rid])).code).toBe(0);
      expect((await run(["context", "who owns the deploy?"])).out).not.toContain(
        "Ben owns the deploy",
      );
      const events = (await rig.api("GET", `/calls/${id}/events`)).body.events;
      const note = events.find((e: { type: string }) => e.type === "note");
      expect(note).toMatchObject({ text: "ship friday", by: "agent:cli" });
      expect(events.find((e: { type: string }) => e.type === "speaker.name").by).toBe("agent:cli");
      const merge = await run(["name", "--merge", "c3", "c2"]);
      expect(merge.code).toBe(0);
      expect((await run(["name", "--unmerge", "c3"])).code).toBe(0);
    },
    LONG,
  );

  test(
    "vocab: a call-scoped add corrects earlier lines at once; a bad term exits 65",
    async () => {
      const add = await run(["vocab", "add", "Hetzner", "--heard", "hetzna", "--call", "live"]);
      expect(add.code).toBe(0);
      const txt = await run(["tail"]);
      expect(txt.out).toContain('deploy to Hetzner (heard: "hetzna")');
      const list = await run(["vocab", "list", "--call", "live"]);
      expect(list.out).toContain("Hetzner (heard: hetzna)  [call, ");
      const bad = await run(["vocab", "add", "x".repeat(300), "--call", "live"]);
      expect(bad.code).toBe(EXIT.badTerm);
      const file = await run(["vocab", "add", "Kubernetes", "-w", "work", "--heard", "kubernetis"]);
      expect(file.code).toBe(0);
      expect(file.out).toContain("work");
      expect((await run(["vocab", "list", "-w", "work"])).out).toContain("Kubernetes");
      expect((await run(["vocab", "remove", "Kubernetes", "-w", "work"])).code).toBe(0);
      expect((await run(["vocab", "check", "Hetzner"])).code).toBe(EXIT.unavailable);
      const imp = join(wavDir.dir, "glossary.txt");
      writeFileSync(imp, "Anika\nVercel\n");
      const imported = await run(["vocab", "import", imp, "-w", "work"]);
      expect(imported.code).toBe(0);
      expect(imported.out).toMatch(/^Imported 2 into /);
      expect((await run(["vocab"])).code).toBe(EXIT.usage);
      await stopAll();
    },
    LONG,
  );

  test("show and finalize take `last`; the final pass reports why it cannot run", async () => {
    const show = await run(["show", "last", "--format", "txt"]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("Times are local");
    expect(show.out).toMatch(/\d\d:\d\d:\d\d Ana: hello world/);
    const fin = await run(["finalize"]);
    expect(fin.code).toBe(EXIT.unavailable);
    expect(fin.err).toContain("Opus decoding is not built");
    expect((await run(["export"])).code).toBe(EXIT.unavailable);
    expect((await run(["enhance"])).code).toBe(EXIT.unavailable);
  });
});

describe("settings and the token", () => {
  test("[T4.9] config set goes through the registry: 99 is refused with 64, a good value sticks", async () => {
    const bad = await run(["config", "set", "asr.segmentPause", "99"]);
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.err).toContain("out of range");
    const ok = await run(["config", "set", "asr.threads", "3"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("asr.threads = 3");
    const show = await run(["config", "show"]);
    expect(show.out).toContain("asr.threads = 3\n");
    expect(show.out).toMatch(/asr\.segmentPause = 0\.7 {2}\(default\)/);
    expect((await run(["config", "unset", "asr.threads"])).code).toBe(0);
    const helper = await run(["config", "set", "capture.helper", '["/bin/sh"]']);
    expect(helper.code).toBe(EXIT.usage);
  });

  test("token path prints where it is, never the token; rotate takes effect at once", async () => {
    const path = await run(["token", "path"]);
    expect(path.out).toBe(join(rig.home, ".config", "akou", "token"));
    expect(path.out).not.toContain(rig.token);
    const before = readFileSync(path.out, "utf8");
    expect((await run(["token", "rotate"])).code).toBe(0);
    const after = readFileSync(path.out, "utf8");
    expect(after).not.toBe(before);
    expect(statSync(path.out).mode & 0o777).toBe(0o600);
    // The CLI reads the new token; a request with the old one is now refused.
    expect((await run(["status"])).code).toBe(0);
    expect((await rig.api("GET", "/status")).status).toBe(401);
    rig.token = after.trim();
  });
});

describe("doctor and models", () => {
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

  test(
    "doctor: missing models fail with the fix; token 0600; API security self-test; harness found",
    async () => {
      const bin = tempDir();
      writeFileSync(join(bin.dir, "claude"), "#!/bin/sh\necho 1.0\n", { mode: 0o755 });
      const env = { ...process.env, ...rig.env, PATH: bin.dir, SHELL: "" };
      const r = await cli(env, ["doctor"]);
      expect(r.code).toBe(EXIT.unavailable);
      expect(r.out).toMatch(/^fail {2}models: .*missing.*run `akou models pull`$/m);
      expect(r.out).toMatch(/^ok {4}token: .*mode 0600/m);
      expect(r.out).toMatch(/^ok {4}api security: a browser request is refused \(403\)/m);
      expect(r.out).toMatch(/^ok {4}helper: /m);
      expect(r.out).toContain(`claude at ${join(bin.dir, "claude")}`);
      const none = await cli({ ...env, PATH: "" }, ["doctor", "--json"]);
      expect(none.json.checks.find((c: { name: string }) => c.name === "harness").state).toBe(
        "warn",
      );
      bin.cleanup();
    },
    LONG,
  );

  test(
    "doctor's security self-test fails against an app whose guard is off (its positive control)",
    async () => {
      const open = await appRig({ guard: openGuard });
      try {
        const r = await cli({ ...process.env, ...open.env }, ["doctor", "--json"]);
        const sec = r.json.checks.find((c: { name: string }) => c.name === "api security");
        expect(sec.state).toBe("fail");
        expect(sec.detail).toContain("answered 200");
      } finally {
        await open.close();
      }
    },
    LONG,
  );

  test("doctor verifies checksums: a good file passes, a same-size wrong file fails", async () => {
    const dir = join(rig.home, ".local", "share", "akou", "models", "tiny");
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, ...rig.env };
    writeFileSync(join(dir, "tiny.bin"), tiny);
    const good = await cli(env, ["doctor", "--json"], { models: [tinyModel] });
    expect(good.json.checks.find((c: { name: string }) => c.name === "models").state).toBe("ok");
    writeFileSync(join(dir, "tiny.bin"), new Uint8Array(tiny.length));
    const bad = await cli(env, ["doctor", "--json"], { models: [tinyModel] });
    const models = bad.json.checks.find((c: { name: string }) => c.name === "models");
    expect(models.state).toBe("fail");
    expect(models.detail).toContain("tiny/tiny.bin fails its checksum");
    expect(bad.code).toBe(EXIT.unavailable);
  });

  test("models list and import; pull is refused under test", async () => {
    const env = { ...process.env, ...rig.env };
    const src = tempDir();
    writeFileSync(join(src.dir, "tiny.bin"), tiny);
    const imp = await cli(env, ["models", "import", src.dir], { models: [tinyModel] });
    expect(imp.code).toBe(0);
    expect(imp.out).toMatch(/^Imported 1 file/);
    const list = await cli(env, ["models", "list", "--json"], { models: [tinyModel] });
    expect(list.json.models[0]).toMatchObject({ id: "tiny", state: "present" });
    const pull = await run(["models", "pull"]);
    expect(pull.code).toBe(EXIT.unavailable);
    expect(pull.err).toContain("downloads are off in tests and CI");
    src.cleanup();
  });
});

describe("without an app", () => {
  test("status and quit never launch one; other commands say it is not running", async () => {
    const t = tempDir();
    const env = { ...process.env, AKOU_HOME: t.dir };
    const s = await cli(env, ["status"]);
    expect(s.code).toBe(EXIT.unavailable);
    expect(s.err).toContain("akou is not running");
    const q = await cli(env, ["quit", "--json"]);
    expect(q.code).toBe(0);
    expect(q.json).toEqual({ ok: true, running: false });
    const c = await cli(env, ["context", "anything"]);
    expect(c.code).toBe(EXIT.unavailable);
    t.cleanup();
  });
});

describe("[T2.51] quit", () => {
  test(
    "akou quit stops the app and returns once it is gone",
    async () => {
      const t = tempDir();
      const other = await appRig({ home: t.dir });
      const r = await rigCli(other)(["quit"]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("akou has quit");
      await other.app.closed;
      t.cleanup();
    },
    LONG,
  );
});
