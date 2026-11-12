/**
 * The real `akou` entry point writes its whole answer into a pipe whose reader is slow
 * (`akou jobs list --json | (sleep 1; jq)`), on stdout and on stderr, before it exits
 * (docs/TRAPS.md akou-3vx.1). A pipe holds about 64 KiB; an exit before the rest is written cut
 * every long answer there, with exit code 0.
 *
 * The answer comes from a fake akou server named by `AKOU_URL`, so no app runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
/** The slow reader: waits, then writes all of its stdin to the file named first. */
let reader = "";

beforeAll(() => {
  t = tempDir("akou-piped-");
  reader = join(t.dir, "reader.ts");
  writeFileSync(
    reader,
    "const [got, ms] = process.argv.slice(2);\nawait Bun.sleep(Number(ms));\nawait Bun.write(got, await Bun.stdin.text());\n",
  );
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
 * starts reading after `delayMs`, through an OS pipe made by the system shell (sh, or cmd on
 * Windows). `Bun.spawn` with `stdout: "pipe"` reads the child as it writes, so it never shows the
 * cut. Bun's own shell (`$`) is not used: on Windows its `2>&1 | reader` never finished, however
 * the CLI wrote its stderr.
 */
async function slowReader(argv: string[], delayMs: number, o: { stderr?: boolean } = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.AKOU_URL = `http://127.0.0.1:${server.port}`;
  env.AKOU_API_KEY = KEY;
  delete env.AKOU_API_KEY_FILE;
  const got = join(t.dir, `got-${++runs}.txt`);
  const bun = process.execPath;
  const q = (words: string[]) => words.map((w) => `"${w}"`).join(" ");
  const line = `${q([bun, CLI, ...argv])}${o.stderr ? " 2>&1" : ""} | ${q([bun, reader, got, String(delayMs)])}`;
  await new Promise<void>((resolve, reject) => {
    const p = spawn(line, { shell: true, env, stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", () => resolve());
  });
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
