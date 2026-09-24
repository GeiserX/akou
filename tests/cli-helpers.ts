/**
 * Test support for the CLI: runs `runCli` in-process against a rig's app (same `AKOU_HOME`), with
 * stdout and stderr captured, or the real entry point as a child process.
 */

import { join } from "node:path";
import { type CliOptions, runCli } from "../src/main/cli/cli.ts";
import type { AppRig } from "./api-helpers.ts";

export const CLI = join(import.meta.dir, "..", "src", "main", "cli", "cli.ts");

export interface CliRun {
  code: number;
  out: string;
  err: string;
  // biome-ignore lint/suspicious/noExplicitAny: parsed --json output is inspected field by field.
  json: any;
}

export async function cli(
  env: Record<string, string | undefined>,
  argv: string[],
  o: CliOptions & { signal?: AbortSignal } = {},
): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    argv,
    { env, out: (t) => out.push(t), err: (t) => err.push(t), signal: o.signal },
    { launch: null, ...o },
  );
  const text = out.join("\n");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { code, out: text, err: err.join("\n"), json };
}

/** The CLI against a rig, never launching another app. */
export function rigCli(rig: AppRig) {
  return (argv: string[], o: CliOptions & { signal?: AbortSignal } = {}) =>
    cli({ ...process.env, ...rig.env }, argv, o);
}

/** The real `akou` entry point as a child process. */
export async function cliChild(
  env: Record<string, string | undefined>,
  argv: string[],
): Promise<{ code: number; out: string; err: string; ms: number }> {
  const t0 = performance.now();
  const clean = Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    env: clean,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err, ms: performance.now() - t0 };
}
