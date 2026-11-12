/**
 * DK-M8, TRAPS "A slow answer reported as a software bug": a local app that answers `/healthz` but
 * not the request itself within its deadline (a long `dictations retry`, a loaded machine). The
 * client names the request and says the app is slow, as a `Hung`: exit 69, and never "akou is not
 * running" from `status` or `quit`, which read a plain `Unreachable` that way. A write may still
 * land, so its message says to look first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../src/main/cli/args.ts";
import { COMMANDS } from "../src/main/cli/cli.ts";
import { ApiClient, Hung, type RequestOptions, Unreachable } from "../src/main/cli/client.ts";
import type { Command, Ctx } from "../src/main/cli/context.ts";
import { tempDir } from "./helpers.ts";

let server: ReturnType<typeof Bun.serve>;
let t: { dir: string; cleanup(): void };
let env: Record<string, string | undefined>;

/** A home whose `runtime.json` names `port` and this test process as the app's live pid. */
function homeFor(dir: string, port: number) {
  const cfg = join(dir, ".config", "akou");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "runtime.json"), JSON.stringify({ pid: process.pid, port }));
}

beforeAll(() => {
  t = tempDir("akou-slow-");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // `/healthz` answers, so the app is not hung; every other route takes 5 s.
    fetch: async (req) => {
      if (new URL(req.url).pathname === "/healthz") return new Response("ok");
      await Bun.sleep(5000);
      return Response.json({ ok: true });
    },
  });
  env = { AKOU_HOME: t.dir };
  homeFor(t.dir, server.port as number);
});

afterAll(() => {
  server.stop(true);
  t.cleanup();
});

const client = () => new ApiClient({ env, client: "cli", launch: null });
const caught = (p: Promise<unknown>): Promise<Error | null> =>
  p.then(
    () => null,
    (e) => e as Error,
  );

describe("[DK-M8] A slow answer reported as a software bug", () => {
  test("a read is a Hung that names the method, the path and the deadline", async () => {
    const err = await caught(client().request("GET", "/status", { timeoutMs: 200 }));
    expect(err).toBeInstanceOf(Hung);
    expect(err?.message).toBe("akou took longer than 0.2 s to answer GET /status");
  });

  test("a write says it may still finish", async () => {
    const err = await caught(
      client().request("POST", "/dictations/d1/retry", { timeoutMs: 200, body: {} }),
    );
    expect(err).toBeInstanceOf(Hung);
    expect(err?.message).toContain("POST /dictations/d1/retry");
    expect(err?.message).toContain("it may still finish: check akou status");
  });

  test("a stream is the same", async () => {
    const err = await caught(client().stream("GET", "/events", { timeoutMs: 200 }));
    expect(err).toBeInstanceOf(Hung);
    expect(err?.message).toContain("GET /events");
  });

  test("`status` and `quit` pass it on, never saying akou is not running", async () => {
    // Their own deadline is 60 s; a client that shortens every deadline stands in.
    class Short extends ApiClient {
      override request(method: string, path: string, o: RequestOptions = {}) {
        return super.request(method, path, { ...o, timeoutMs: 200 });
      }
    }
    for (const name of ["status", "quit"]) {
      const cmd = COMMANDS.find((c) => c.name === name) as Command;
      const said: string[] = [];
      const ctx: Ctx = {
        io: { env, out: (x) => said.push(x), err: (x) => said.push(x) },
        json: false,
        client: new Short({ env, client: "cli", launch: null }),
        version: "0",
      };
      const err = await caught(cmd.run(ctx, parseArgs([], cmd.flags ?? {})));
      // runCli answers any `Unreachable` with its message and exit 69.
      expect([name, err instanceof Hung]).toEqual([name, true]);
      expect(err?.message).toStartWith("akou took longer than 0.2 s to answer");
      expect(said.join("\n")).not.toContain("not running");
    }
  });

  test("positive control: a refused connection is still not a Hung, so `status` says not running", async () => {
    const dead = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const port = dead.port as number;
    dead.stop(true);
    const home = tempDir("akou-dead-");
    try {
      homeFor(home.dir, port);
      const c = new ApiClient({ env: { AKOU_HOME: home.dir }, client: "cli", launch: null });
      const err = await caught(c.request("GET", "/status", { timeoutMs: 200, launch: false }));
      expect(err).toBeInstanceOf(Unreachable);
      expect(err).not.toBeInstanceOf(Hung);
    } finally {
      home.cleanup();
    }
  });
});
