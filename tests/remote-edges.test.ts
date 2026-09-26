/**
 * The edges of a remote target (docs/research/service-interface.md SI-1) and of the CLI's signals:
 *
 * - a remote that accepts the connection and never answers is `Unreachable` (exit 69) naming
 *   `AKOU_URL`, like one that refuses it; a broken connection is `Unreachable` for a read only,
 *   since a write may have landed;
 * - SIGTERM ends a command that is waiting on the network at once: only `akou serve` handles it;
 * - `akou quit` never stops a remote server, and `akou doctor` reports the remote it talks to;
 * - `akou jobs list` against the desktop app says jobs are a server's;
 * - the refusal of a secret flag names the command that was typed, and `AKOU_API_KEY_FILE` may
 *   start with `~/`.
 *
 * The one non-loopback address used (TEST-NET-1) is added to NO_PROXY for this file, since Bun
 * reads the proxy variables once at start; the message that names a proxy reads the client's env.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { parseArgs } from "../src/main/cli/args.ts";
import { ApiClient, EXIT, remoteTarget, TargetError, Unreachable } from "../src/main/cli/client.ts";
import { wall } from "../src/main/cli/context.ts";
import { CLI, cli } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const FAR = "192.0.2.1";
const savedNoProxy = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

/** Accepts every connection and never answers: a remote that is up at TCP and hung above it. */
let silent: Server;
const held: Socket[] = [];
/** Accepts every connection and closes it at once, before any answer. */
let dropper: Server;
/** A fake akou: records each request, answers `/v1/server`, 404 elsewhere. */
let fake: ReturnType<typeof Bun.serve>;
const fakeSeen: string[] = [];
let home: { dir: string; cleanup(): void };

function listen(s: Server): Promise<void> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r()));
}
const portOf = (s: Server) => (s.address() as { port: number }).port;

beforeAll(async () => {
  const list = [process.env.NO_PROXY ?? process.env.no_proxy, FAR].filter(Boolean).join(",");
  process.env.NO_PROXY = list;
  process.env.no_proxy = list;
  silent = createServer((sock) => {
    held.push(sock);
  });
  dropper = createServer((sock) => {
    sock.destroy();
  });
  await Promise.all([listen(silent), listen(dropper)]);
  fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      fakeSeen.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/v1/server") {
        return Response.json({ name: "akou", version: "9.8.7", mode: "server" });
      }
      return Response.json({ error: "not_found", message: url.pathname }, { status: 404 });
    },
  });
  home = tempDir();
});

afterAll(() => {
  for (const s of held) s.destroy();
  silent.close();
  dropper.close();
  fake.stop(true);
  home.cleanup();
  for (const [k, v] of Object.entries(savedNoProxy)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function env(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...process.env, AKOU_HOME: home.dir };
  for (const k of ["AKOU_URL", "AKOU_API_KEY", "AKOU_API_KEY_FILE"]) delete e[k];
  return { ...e, ...extra };
}

const client = (e: Record<string, string | undefined>) =>
  new ApiClient({ env: e, client: "test", launch: null });

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("the request did not fail");
}

describe("[SI-1] a remote that does not answer", () => {
  test("a remote that accepts and never answers is Unreachable naming AKOU_URL, like a refused one", async () => {
    const base = `http://127.0.0.1:${portOf(silent)}`;
    const hung = await rejection(
      client(env({ AKOU_URL: base })).request("GET", "/jobs", { timeoutMs: 300 }),
    );
    expect(hung).toBeInstanceOf(Unreachable);
    expect(hung.message).toContain(`${base} (AKOU_URL)`);
    // Positive control: a refused port was already Unreachable, and still is.
    const closed = createServer();
    await listen(closed);
    const refusedBase = `http://127.0.0.1:${portOf(closed)}`;
    closed.close();
    const refused = await rejection(
      client(env({ AKOU_URL: refusedBase })).request("GET", "/jobs", { timeoutMs: 300 }),
    );
    expect(refused).toBeInstanceOf(Unreachable);
    expect(refused.message).toContain(`${refusedBase} (AKOU_URL)`);
  });

  test("a connection broken before any answer is Unreachable for a read, and never for a write, which may have landed", async () => {
    const base = `http://127.0.0.1:${portOf(dropper)}`;
    const read = await rejection(client(env({ AKOU_URL: base })).request("GET", "/jobs"));
    expect(read).toBeInstanceOf(Unreachable);
    const write = await rejection(
      client(env({ AKOU_URL: base })).request("POST", "/jobs", { body: {} }),
    );
    expect(write).not.toBeInstanceOf(Unreachable);
  });

  test("with a proxy variable set for the scheme, the message names it; on loopback, which never goes through one, it does not", async () => {
    // TEST-NET-1 never answers; the proxy variable is only in the client's env, so nothing is sent.
    const far = await rejection(
      client(env({ AKOU_URL: `http://${FAR}:8476`, HTTP_PROXY: "http://127.0.0.1:9" })).request(
        "GET",
        "/jobs",
        { timeoutMs: 300 },
      ),
    );
    expect(far).toBeInstanceOf(Unreachable);
    expect(far.message).toContain("HTTP_PROXY");
    // A proxy URL can carry credentials, and this message reaches stderr and `--json`: name only.
    const secret = await rejection(
      client(
        env({ AKOU_URL: `http://${FAR}:8476`, HTTP_PROXY: "http://user:s3cret@127.0.0.1:9" }),
      ).request("GET", "/jobs", { timeoutMs: 300 }),
    );
    expect(secret.message).toContain("HTTP_PROXY");
    expect(secret.message).not.toContain("s3cret");
    expect(secret.message).not.toContain("user:");
    const near = await rejection(
      client(
        env({ AKOU_URL: `http://127.0.0.1:${portOf(silent)}`, HTTP_PROXY: "http://127.0.0.1:9" }),
      ).request("GET", "/jobs", { timeoutMs: 300 }),
    );
    expect(near.message).not.toContain("HTTP_PROXY");
  });
});

describe("SIGTERM", () => {
  test("ends a command that waits on the network at once, not when its request times out", async () => {
    const before = held.length;
    const proc = Bun.spawn([process.execPath, CLI, "jobs", "list"], {
      env: env({ AKOU_URL: `http://127.0.0.1:${portOf(silent)}` }) as Record<string, string>,
      stdout: "ignore",
      stderr: "ignore",
    });
    const deadline = performance.now() + 10_000;
    while (held.length === before && performance.now() < deadline) await Bun.sleep(20);
    // Positive control: the command is connected and waiting, so only the signal can end it now.
    expect(held.length).toBeGreaterThan(before);
    expect(proc.exitCode).toBeNull();
    proc.kill("SIGTERM");
    const ended = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "still running")]);
    if (ended === "still running") proc.kill("SIGKILL");
    expect(ended).not.toBe("still running");
    expect(ended).not.toBe(0);
  }, 20_000);
});

describe("local-only commands with AKOU_URL set", () => {
  test("akou quit refuses and sends nothing: it never stops a remote server", async () => {
    const before = fakeSeen.length;
    const r = await cli(env({ AKOU_URL: `http://127.0.0.1:${fake.port}`, AKOU_API_KEY: "k" }), [
      "quit",
    ]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("AKOU_URL");
    expect(fakeSeen.slice(before)).toEqual([]);
    // Positive control: with AKOU_URL unset and no app, quit still answers as before.
    const local = await cli(env({}), ["quit"]);
    expect([local.code, local.out]).toEqual([EXIT.ok, "akou is not running"]);
  });

  test("akou doctor reports the remote it talks to, and a remote that does not answer fails", async () => {
    const base = `http://127.0.0.1:${fake.port}`;
    const r = await cli(env({ AKOU_URL: base, AKOU_API_KEY: "k", AKOU_NO_DOWNLOAD: "1" }), [
      "doctor",
      "--json",
    ]);
    const api = (
      r.json as { checks: { name: string; state: string; detail: string }[] }
    ).checks.find((c) => c.name === "api");
    expect(api?.state).toBe("ok");
    expect(api?.detail).toContain("9.8.7");
    expect(api?.detail).toContain(`${base} (AKOU_URL)`);
    expect(r.out).not.toContain("akou is not running");

    const closed = createServer();
    await listen(closed);
    const gone = `http://127.0.0.1:${portOf(closed)}`;
    closed.close();
    const down = await cli(env({ AKOU_URL: gone, AKOU_API_KEY: "k", AKOU_NO_DOWNLOAD: "1" }), [
      "doctor",
      "--json",
    ]);
    const downApi = (
      down.json as { checks: { name: string; state: string; detail: string }[] }
    ).checks.find((c) => c.name === "api");
    expect(downApi?.state).toBe("fail");
    expect(downApi?.detail).toContain(`${gone} (AKOU_URL)`);
    expect(down.code).toBe(EXIT.unavailable);
  }, 30_000);
});

describe("akou jobs list against a server", () => {
  test("shows when each job was made as local wall-clock time, never the raw ISO string", async () => {
    const created = "2026-09-25T10:00:00Z";
    const srv = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          jobs: [
            { id: "job_1", status: "done", created_at: created },
            { id: "job_2", status: "queued" },
          ],
        }),
    });
    try {
      const r = await cli(env({ AKOU_URL: `http://127.0.0.1:${srv.port}`, AKOU_API_KEY: "k" }), [
        "jobs",
        "list",
      ]);
      expect(r.code).toBe(EXIT.ok);
      const [first, second] = r.out.split("\n");
      const ms = Date.parse(created);
      expect(first).toBe(`job_1  done  ${new Date(ms).toLocaleDateString("en-CA")} ${wall(ms)}`);
      expect(r.out).not.toContain(created);
      // A job with no time is listed without one, not with "?" or "Invalid Date".
      expect(second).toBe("job_2  queued");
      // Positive control: --json keeps the server's value as it came.
      const j = await cli(env({ AKOU_URL: `http://127.0.0.1:${srv.port}`, AKOU_API_KEY: "k" }), [
        "jobs",
        "list",
        "--json",
      ]);
      expect((j.json as { jobs: { created_at?: string }[] }).jobs[0]?.created_at).toBe(created);
    } finally {
      srv.stop(true);
    }
  });
});

describe("akou jobs list against the desktop app", () => {
  test("says jobs belong to a server, with exit 69, not a usage error", async () => {
    const t = tempDir();
    const configDir = join(t.dir, ".config", "akou");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "runtime.json"),
      JSON.stringify({ pid: process.pid, port: fake.port, version: "0.1.0" }),
    );
    writeFileSync(join(configDir, "token"), "t\n");
    const e = { ...env({}), AKOU_HOME: t.dir };
    const r = await cli(e, ["jobs", "list"]);
    expect(r.code).toBe(EXIT.unavailable);
    expect(r.err).toContain("server");
    expect(r.err).toContain("AKOU_URL");
    // Positive control: the local app was asked, and answered 404.
    expect(fakeSeen.at(-1)).toBe("GET /v1/jobs");
    t.cleanup();
  });
});

describe("secret flags and the key file", () => {
  test("the refusal of --key names the command that was typed, without the secret", async () => {
    const r = await cli(env({}), ["status", "--key", "ak_s3cret", "--json"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("a secret on the command line");
    expect(r.err).toContain("akou status --json");
    expect(r.err).not.toContain("jobs list");
    expect(r.err).not.toContain("ak_s3cret");
    const inline = await cli(env({}), ["tail", "--token=ak_s3cret"]);
    expect(inline.err).toContain("akou tail");
    expect(inline.err).not.toContain("ak_s3cret");
    // A second secret flag after the one that trips is dropped from the `try:` line too.
    const two = await cli(env({}), ["status", "--key", "ak_first", "--token", "ak_second"]);
    expect(two.code).toBe(EXIT.usage);
    expect(two.err).toContain("akou status");
    expect(two.err).not.toContain("ak_first");
    expect(two.err).not.toContain("ak_second");
    expect(two.err).not.toContain("--token");
    const mixed = await cli(env({}), [
      "status",
      "--key=ak_first",
      "--json",
      "--password",
      "ak_third",
    ]);
    expect(mixed.err).toContain("akou status --json");
    expect(mixed.err).not.toContain("ak_first");
    expect(mixed.err).not.toContain("ak_third");
  });

  test("AKOU_API_KEY_FILE may start with ~/, as docker -e and a systemd unit pass it unexpanded", () => {
    const t = tempDir();
    mkdirSync(join(t.dir, ".config", "akou"), { recursive: true });
    writeFileSync(join(t.dir, ".config", "akou", "remote.key"), "ak_from_file\n");
    const target = remoteTarget({
      AKOU_URL: "https://akou.example",
      AKOU_API_KEY_FILE: "~/.config/akou/remote.key",
      HOME: t.dir,
      USERPROFILE: t.dir,
    });
    expect(target?.key).toBe("ak_from_file");
    // Positive control: an absolute path still reads as it did.
    expect(
      remoteTarget({
        AKOU_URL: "https://akou.example",
        AKOU_API_KEY_FILE: join(t.dir, ".config", "akou", "remote.key"),
      })?.key,
    ).toBe("ak_from_file");
    t.cleanup();
  });

  test("AKOU_URL with a query or a fragment is refused, since the API path would land inside it", () => {
    for (const url of ["https://akou.example/x?y=1", "https://akou.example/x#top", "https://h/?"]) {
      expect(() => remoteTarget({ AKOU_URL: url, AKOU_API_KEY: "k" })).toThrow(TargetError);
    }
    // Positive control: a path prefix and a trailing slash are fine.
    expect(remoteTarget({ AKOU_URL: "https://akou.example/x/", AKOU_API_KEY: "k" })?.base).toBe(
      "https://akou.example/x",
    );
  });

  test("AKOU_URL with a user name or password is refused, and the password is never printed", async () => {
    const url = "http://alice:hunter2@127.0.0.1:9";
    for (const u of [url, "http://alice@127.0.0.1:9", "http://:hunter2@127.0.0.1:9"]) {
      const err = (() => {
        try {
          remoteTarget({ AKOU_URL: u, AKOU_API_KEY: "k" });
        } catch (e) {
          return e as TargetError;
        }
        throw new Error(`${u} was accepted`);
      })();
      expect(err).toBeInstanceOf(TargetError);
      expect(err.exit).toBe(EXIT.usage);
      expect(err.message).toContain("AKOU_API_KEY");
      expect(err.message).not.toContain("hunter2");
    }
    for (const argv of [
      ["jobs", "list"],
      ["jobs", "list", "--json"],
    ]) {
      const r = await cli(env({ AKOU_URL: url, AKOU_API_KEY: "k" }), argv);
      expect(r.code).toBe(EXIT.usage);
      expect(`${r.out}\n${r.err}`).not.toContain("hunter2");
    }
    // Positive control: the same address with no user name is taken as given.
    expect(remoteTarget({ AKOU_URL: "http://127.0.0.1:9", AKOU_API_KEY: "k" })?.base).toBe(
      "http://127.0.0.1:9",
    );
  });

  test("a 401 from a remote when no key was set names AKOU_API_KEY and AKOU_API_KEY_FILE", async () => {
    const seen: string[] = [];
    const guard = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const auth = req.headers.get("authorization") ?? "";
        seen.push(auth);
        if (auth !== "Bearer good") {
          return Response.json(
            { error: "unauthorized", message: "the key is missing or wrong" },
            { status: 401 },
          );
        }
        return Response.json({ jobs: [] });
      },
    });
    try {
      const base = `http://127.0.0.1:${guard.port}`;
      const none = await cli(env({ AKOU_URL: base }), ["jobs", "list"]);
      expect(none.code).toBe(EXIT.permission);
      expect(none.err).toContain("the key is missing or wrong");
      expect(none.err).toContain("AKOU_API_KEY_FILE");
      const noneJson = await cli(env({ AKOU_URL: base }), ["jobs", "list", "--json"]);
      expect(noneJson.code).toBe(EXIT.permission);
      expect((noneJson.json as { error: string; message: string }).error).toBe("unauthorized");
      expect((noneJson.json as { message: string }).message).toContain("AKOU_API_KEY_FILE");
      // Positive controls: a wrong key that was sent gets the server's text alone, and the right
      // key gets through; the request still went out with no key, as /v1/server needs none.
      const wrong = await cli(env({ AKOU_URL: base, AKOU_API_KEY: "bad" }), ["jobs", "list"]);
      expect(wrong.code).toBe(EXIT.permission);
      expect(wrong.err).not.toContain("AKOU_API_KEY");
      const good = await cli(env({ AKOU_URL: base, AKOU_API_KEY: "good" }), ["jobs", "list"]);
      expect([good.code, good.out]).toEqual([EXIT.ok, "No jobs"]);
      expect(seen[0]).toBe("Bearer");
    } finally {
      guard.stop(true);
    }
  });

  test("a blank AKOU_API_KEY does not hide the key in AKOU_API_KEY_FILE", () => {
    const t = tempDir();
    const file = join(t.dir, "remote.key");
    writeFileSync(file, "ak_from_file\n");
    const base = { AKOU_URL: "https://akou.example", AKOU_API_KEY_FILE: file };
    expect(remoteTarget({ ...base, AKOU_API_KEY: "  " })?.key).toBe("ak_from_file");
    expect(remoteTarget({ ...base, AKOU_API_KEY: "" })?.key).toBe("ak_from_file");
    // Positive control: a real AKOU_API_KEY still wins over the file.
    expect(remoteTarget({ ...base, AKOU_API_KEY: " ak_inline " })?.key).toBe("ak_inline");
    t.cleanup();
  });

  test("a command cannot declare a secret flag, so the refusal holds on every command", () => {
    expect(() => parseArgs([], { token: { type: "string", desc: "x" } })).toThrow("--token");
    expect(() => parseArgs([], { key: { type: "string", short: "k", desc: "x" } })).toThrow(
      "--key",
    );
    // Positive control: an ordinary flag still parses.
    expect(parseArgs(["--title", "x"], { title: { type: "string", desc: "x" } }).flags.title).toBe(
      "x",
    );
  });
});
