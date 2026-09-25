/**
 * A remote target for the CLI and `akou mcp` (docs/research/service-interface.md SI-1): with
 * `AKOU_URL` set, every request goes to that base URL with the key from `AKOU_API_KEY` or the file
 * `AKOU_API_KEY_FILE` names, never from an argument, and the client never reads `runtime.json` and
 * never launches the app.
 *
 * The fake server listens on a non-loopback address of this machine, as a real remote would. A
 * decoy app on loopback, named by a `runtime.json` with a live pid, proves the local file is never
 * read, and a launch command that leaves a marker proves nothing is launched.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { ApiClient, EXIT } from "../src/main/cli/client.ts";
import { cli } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const KEY = "ak_remote-target-test-key";
const outward = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

interface Seen {
  method: string;
  path: string;
  auth: string | null;
}

let remote: ReturnType<typeof Bun.serve> | null = null;
let decoy: ReturnType<typeof Bun.serve>;
const remoteSeen: Seen[] = [];
const decoySeen: Seen[] = [];
let home: { dir: string; cleanup(): void };
let marker: string;
let launch: string[];

function record(into: Seen[]) {
  return (req: Request) => {
    const url = new URL(req.url);
    into.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") });
    if (req.headers.get("authorization") !== `Bearer ${KEY}`) {
      return Response.json({ error: "unauthorized", message: "bad key" }, { status: 401 });
    }
    if (url.pathname === "/v1/jobs") {
      return Response.json({
        jobs: [{ id: "job_1", status: "done", created_at: "2026-09-25T10:00:00Z" }],
        cursor: null,
      });
    }
    return Response.json({ error: "not_found", message: url.pathname }, { status: 404 });
  };
}

beforeAll(() => {
  if (outward) remote = Bun.serve({ hostname: outward, port: 0, fetch: record(remoteSeen) });
  decoy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: record(decoySeen) });
  home = tempDir();
  const configDir = join(home.dir, ".config", "akou");
  mkdirSync(configDir, { recursive: true });
  // A running local app, as far as runtime.json and the token file can tell.
  writeFileSync(
    join(configDir, "runtime.json"),
    JSON.stringify({ pid: process.pid, port: decoy.port, version: "0.1.0" }),
  );
  writeFileSync(join(configDir, "token"), `${KEY}\n`);
  marker = join(home.dir, "launched");
  launch = [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
  ];
});

afterAll(() => {
  remote?.stop(true);
  decoy.stop(true);
  home.cleanup();
});

function env(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = { ...process.env, AKOU_HOME: home.dir };
  for (const k of ["AKOU_URL", "AKOU_API_KEY", "AKOU_API_KEY_FILE"]) delete e[k];
  return { ...e, ...extra };
}

const remoteUrl = () => `http://${outward}:${remote?.port}`;

/**
 * The first check of SI-1, over any client: a jobs list through it reaches the remote with the
 * bearer key, and the local app's runtime.json is never used.
 */
async function reachesRemote(client: ApiClient): Promise<boolean> {
  const before = { remote: remoteSeen.length, decoy: decoySeen.length };
  const r = await client.request("GET", "/jobs");
  const hit = remoteSeen.slice(before.remote);
  return (
    r.status === 200 &&
    hit.length === 1 &&
    hit[0]?.path === "/v1/jobs" &&
    hit[0]?.auth === `Bearer ${KEY}` &&
    decoySeen.length === before.decoy
  );
}

describe("[SI-1] a remote target for the CLI and akou mcp", () => {
  test.skipIf(!outward)(
    "akou jobs list sends Authorization: Bearer <key> to AKOU_URL on a non-loopback address and exits 0 (skipped when the machine has none)",
    async () => {
      const before = { remote: remoteSeen.length, decoy: decoySeen.length };
      const r = await cli(
        env({ AKOU_URL: remoteUrl(), AKOU_API_KEY: KEY }),
        ["jobs", "list", "--json"],
        {
          launch,
        },
      );
      expect([r.code, r.err]).toEqual([EXIT.ok, ""]);
      expect(r.json.jobs[0].id).toBe("job_1");
      expect(remoteSeen.slice(before.remote)).toEqual([
        { method: "GET", path: "/v1/jobs", auth: `Bearer ${KEY}` },
      ]);
      // runtime.json names a live local app, and it was never asked; nothing was launched.
      expect(decoySeen.length).toBe(before.decoy);
      expect(existsSync(marker)).toBe(false);

      const human = await cli(
        env({ AKOU_URL: `${remoteUrl()}/`, AKOU_API_KEY: KEY }),
        ["jobs", "list"],
        {
          launch,
        },
      );
      expect(human.code).toBe(EXIT.ok);
      expect(human.out).toContain("job_1");
      expect(human.out).toContain("done");
    },
  );

  test.skipIf(!outward)(
    "the key can come from the file AKOU_API_KEY_FILE names (skipped when the machine has none)",
    async () => {
      const t = tempDir();
      const file = join(t.dir, "remote.key");
      writeFileSync(file, `${KEY}\n`, { mode: 0o600 });
      const r = await cli(
        env({ AKOU_URL: remoteUrl(), AKOU_API_KEY_FILE: file }),
        ["jobs", "list"],
        {
          launch,
        },
      );
      expect(r.code).toBe(EXIT.ok);
      expect(remoteSeen.at(-1)?.auth).toBe(`Bearer ${KEY}`);
      // A file that cannot be read is a permission problem, named, and nothing is sent.
      const n = remoteSeen.length;
      const missing = await cli(
        env({ AKOU_URL: remoteUrl(), AKOU_API_KEY_FILE: join(t.dir, "nope.key") }),
        ["jobs", "list"],
        { launch },
      );
      expect(missing.code).toBe(EXIT.permission);
      expect(missing.err).toContain("AKOU_API_KEY_FILE");
      expect(remoteSeen.length).toBe(n);
      t.cleanup();
    },
  );

  test.skipIf(!outward)("a wrong key exits 77 (skipped when the machine has none)", async () => {
    const r = await cli(
      env({ AKOU_URL: remoteUrl(), AKOU_API_KEY: "ak_wrong" }),
      ["jobs", "list"],
      {
        launch,
      },
    );
    expect(r.code).toBe(EXIT.permission);
    expect(remoteSeen.at(-1)?.auth).toBe("Bearer ak_wrong");
    expect(existsSync(marker)).toBe(false);
  });

  test("--key on the command line is refused as a secret, with the environment form to use, and nothing is sent", async () => {
    const before = { remote: remoteSeen.length, decoy: decoySeen.length };
    for (const argv of [
      ["jobs", "list", "--key", "X"],
      ["jobs", "list", "--key=X"],
      ["jobs", "list", "--api-key", "X"],
    ]) {
      const r = await cli(env({ AKOU_URL: "http://192.0.2.1:9", AKOU_API_KEY: KEY }), argv, {
        launch,
      });
      expect(r.code).toBe(EXIT.usage);
      expect(r.err).toContain("a secret on the command line");
      expect(r.err).toContain("AKOU_API_KEY_FILE");
    }
    expect(remoteSeen.length).toBe(before.remote);
    expect(decoySeen.length).toBe(before.decoy);
  });

  test("with AKOU_URL set and nothing answering, it exits 69 naming the URL and never launches the app", async () => {
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const url = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);
    const before = decoySeen.length;
    const r = await cli(env({ AKOU_URL: url, AKOU_API_KEY: KEY }), ["jobs", "list"], { launch });
    expect(r.code).toBe(EXIT.unavailable);
    expect(r.err).toContain(url);
    expect(decoySeen.length).toBe(before);
    expect(existsSync(marker)).toBe(false);
  });

  test("AKOU_URL that is not an http or https URL is refused before anything is sent", async () => {
    const before = decoySeen.length;
    const r = await cli(env({ AKOU_URL: "akou.example", AKOU_API_KEY: KEY }), ["jobs", "list"], {
      launch,
    });
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("AKOU_URL");
    expect(decoySeen.length).toBe(before);
  });

  test.skipIf(!outward)(
    "positive control: a client that ignores AKOU_URL fails the first check (skipped when the machine has none)",
    async () => {
      const e = env({ AKOU_URL: remoteUrl(), AKOU_API_KEY: KEY });
      expect(await reachesRemote(new ApiClient({ env: e, client: "cli", launch: null }))).toBe(
        true,
      );
      // The same environment, with the client blind to AKOU_URL: it talks to the local app.
      const blind = new ApiClient({
        env: { ...e, AKOU_URL: undefined },
        client: "cli",
        launch: null,
      });
      expect(await reachesRemote(blind)).toBe(false);
    },
  );

  test.skipIf(!outward)(
    "streams go to the remote too, and a probe that must not launch still reaches it (skipped when the machine has none)",
    async () => {
      const client = new ApiClient({
        env: env({ AKOU_URL: remoteUrl(), AKOU_API_KEY: KEY }),
        client: "mcp",
        launch,
      });
      const n = remoteSeen.length;
      const res = await client.stream("GET", "/jobs");
      await res.text();
      const probe = await client.request("GET", "/jobs", { launch: false });
      expect(probe.status).toBe(200);
      expect(remoteSeen.slice(n).map((s) => s.auth)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
      expect(client.runtime()).toBeNull();
    },
  );

  test("with AKOU_URL unset the local app is found through runtime.json, as before", async () => {
    const before = decoySeen.length;
    const r = await cli(env({}), ["jobs", "list", "--json"], { launch });
    expect(r.code).toBe(EXIT.ok);
    expect(decoySeen.length).toBe(before + 1);
    expect(decoySeen.at(-1)).toEqual({ method: "GET", path: "/v1/jobs", auth: `Bearer ${KEY}` });
  });
});
