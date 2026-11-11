/**
 * The real `akou` entry point writes its whole answer into a pipe whose reader is slow
 * (`akou jobs list --json | (sleep 1; jq)`), on stdout and on stderr, before it exits
 * (docs/TRAPS.md akou-3vx.1). A pipe holds about 64 KiB; an exit before the rest is written cut
 * every long answer there, with exit code 0.
 *
 * The answer comes from a fake akou server named by `AKOU_URL`, so no app runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { CLI } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const KEY = "ak_piped-output-test-key";
/** Well past a pipe's buffer on every OS (64 KiB on macOS and Linux, 4 KiB to 64 KiB on Windows). */
const JOBS = Array.from({ length: 3000 }, (_, i) => ({
  id: `job_${String(i).padStart(6, "0")}`,
  status: "done",
  created_at: "2026-09-25T10:00:00Z",
  title: `A long recording title that makes each row of the answer about a hundred bytes ${i}`,
}));
const LONG_MESSAGE = `the request was refused: ${"x".repeat(300_000)}`;

let server: ReturnType<typeof Bun.serve>;
let t: { dir: string; cleanup(): void };
let runs = 0;

beforeAll(() => {
  t = tempDir("akou-piped-");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.searchParams.get("status") === "failed") {
        return Response.json({ error: "bad_request", message: LONG_MESSAGE }, { status: 400 });
      }
      if (url.searchParams.get("status") === "queued") {
        return Response.json({ jobs: JOBS.slice(0, 1), cursor: null });
      }
      return Response.json({ jobs: JOBS, cursor: null });
    },
  });
});

afterAll(() => {
  server.stop(true);
  t.cleanup();
});

/**
 * Runs the CLI with its stdout (and, with `stderr`, its stderr too) piped into a second process that
 * starts reading after `delayMs`, through an OS pipe as a shell makes one. `Bun.spawn` with
 * `stdout: "pipe"` reads the child as it writes, so it never shows the cut.
 */
async function slowReader(argv: string[], delayMs: number, o: { stderr?: boolean } = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.AKOU_URL = `http://127.0.0.1:${server.port}`;
  env.AKOU_API_KEY = KEY;
  delete env.AKOU_API_KEY_FILE;
  const got = join(t.dir, `got-${++runs}.txt`);
  const reader = `await Bun.sleep(${delayMs}); await Bun.write(${JSON.stringify(got)}, await Bun.stdin.text());`;
  const bun = process.execPath;
  await (o.stderr
    ? $`${bun} ${CLI} ${argv} 2>&1 | ${bun} -e ${reader}`.env(env).nothrow().quiet()
    : $`${bun} ${CLI} ${argv} | ${bun} -e ${reader}`.env(env).nothrow().quiet());
  return readFileSync(got, "utf8");
}

describe("[akou-3vx.1] A long answer reaches a slow reader whole", () => {
  test("stdout: `jobs list --json` of about 300 KB parses whole", async () => {
    const r = await slowReader(["jobs", "list", "--json"], 1000);
    const want = `${JSON.stringify({ jobs: JOBS, cursor: null })}\n`;
    expect(want.length).toBeGreaterThan(200_000);
    expect(r.length).toBe(want.length);
    expect(JSON.parse(r).jobs).toHaveLength(JOBS.length);
  }, 30_000);

  test("stderr: an error message of about 300 KB arrives whole", async () => {
    const r = await slowReader(["jobs", "list", "--status", "failed"], 1000, { stderr: true });
    expect(r.length).toBeGreaterThan(LONG_MESSAGE.length);
    expect(r.includes(LONG_MESSAGE)).toBe(true);
  }, 30_000);

  test("positive control: a short answer through the same pipe arrives, so the rig reads at all", async () => {
    const r = await slowReader(["jobs", "list", "--status", "queued", "--json"], 1000);
    expect(JSON.parse(r).jobs).toHaveLength(1);
  }, 30_000);
});
