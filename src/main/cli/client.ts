/**
 * The thin client of the local API that the CLI and the MCP server share (docs/DESIGN.md sections
 * 1.5, 6.1 and 6.3).
 *
 * It finds the app through `runtime.json` (pid, port, version) and the token file, both in the
 * config folder, and sends every request to `127.0.0.1` with the bearer token. If nothing answers,
 * it launches the app headless (`AKOU_HEADLESS=1`, never an argument) and waits up to the launch
 * budget, 3 s, for the API to answer. It never reads a call folder.
 *
 * Loopback requests never go through a proxy (DESIGN 6.3 rule 6): `NO_PROXY` is extended with the
 * loopback names for this process and for the app it launches.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../../core/log/writer.ts";
import { TOKEN_FILE } from "../api/guard.ts";
import { RUNTIME_FILE } from "../app-info.ts";
import { resolvePaths } from "../config/schema.ts";

/** Exit codes (DESIGN 6.1). */
export const EXIT = {
  ok: 0,
  notLive: 3,
  usage: 64,
  badTerm: 65,
  unavailable: 69,
  software: 70,
  alreadyRecording: 75,
  permission: 77,
} as const;

/** The design's wait for a cold app: `201` within 3 s of `akou start`. */
export const LAUNCH_BUDGET_MS = 3000;

const LOOPBACK = ["127.0.0.1", "localhost"];

/** `NO_PROXY` with the loopback names added (both spellings are read by different runtimes). */
export function withNoProxy(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const have = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const merged = [...new Set([...have, ...LOOPBACK])].join(",");
  return { ...env, NO_PROXY: merged, no_proxy: merged };
}

// This process's own fetch reads the variables at request time.
Object.assign(process.env, withNoProxy(process.env));

export interface Runtime {
  pid: number;
  port: number;
  version: string;
}

export interface ApiResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: API bodies are read field by field by each command.
  body: any;
  text: string;
  contentType: string;
}

/** The app is not running and was not (or could not be) launched. */
export class Unreachable extends Error {
  override name = "Unreachable";
}

export interface ClientOptions {
  env: Record<string, string | undefined>;
  /** Sent as `X-Akou-Client`, so writes carry `by: agent:<client>`. */
  client: string;
  /**
   * The program that starts the app headless. By default this Bun on `src/main/index.ts`; null
   * never launches.
   */
  launch?: readonly string[] | null;
  launchBudgetMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Launch the app if it is not running. Default true. */
  launch?: boolean;
  /** Overrides `ClientOptions.client` for this request (the MCP client's own name). */
  client?: string;
  timeoutMs?: number;
  /** Aborts the request (Ctrl-C during `tail -f`). */
  signal?: AbortSignal;
}

export const DEFAULT_LAUNCH = [process.execPath, join(import.meta.dir, "..", "index.ts")];

export class ApiClient {
  readonly configDir: string;
  private readonly launchCmd: readonly string[] | null;
  private readonly budget: number;
  private launching: Promise<Runtime> | null = null;

  constructor(readonly o: ClientOptions) {
    this.configDir = resolvePaths(o.env).configDir;
    this.launchCmd = o.launch === undefined ? DEFAULT_LAUNCH : o.launch;
    this.budget = o.launchBudgetMs ?? LAUNCH_BUDGET_MS;
  }

  /** `runtime.json` of a running app, or null (no file, bad file, or its pid is gone). */
  runtime(): Runtime | null {
    try {
      const rt = JSON.parse(readFileSync(join(this.configDir, RUNTIME_FILE), "utf8")) as Runtime;
      if (typeof rt.port !== "number" || !processAlive(rt.pid)) return null;
      return rt;
    } catch {
      return null;
    }
  }

  private token(): string {
    try {
      return readFileSync(join(this.configDir, TOKEN_FILE), "utf8").trim();
    } catch {
      return "";
    }
  }

  private async send(rt: Runtime, method: string, path: string, o: RequestOptions) {
    const url = new URL(`http://127.0.0.1:${rt.port}/v1${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const hasBody = method !== "GET" && method !== "HEAD";
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token()}`,
        "x-akou-client": o.client ?? this.o.client,
        ...(hasBody ? { "content-type": "application/json" } : {}),
      },
      body: hasBody ? JSON.stringify(o.body ?? {}) : undefined,
      signal: o.signal
        ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs ?? 60_000)])
        : AbortSignal.timeout(o.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      body,
      text,
      contentType: res.headers.get("content-type") ?? "",
    };
  }

  /**
   * One API request. A refused connection (the app is gone) launches the app once, when allowed,
   * and retries; a read is retried on a broken connection too, a write never. Throws
   * `Unreachable` when there is no app to talk to.
   */
  async request(method: string, path: string, o: RequestOptions = {}): Promise<ApiResponse> {
    const allowLaunch = o.launch ?? true;
    let rt = this.runtime();
    if (rt) {
      try {
        return await this.send(rt, method, path, o);
      } catch (err) {
        if (!isConnectionError(err, method === "GET" || method === "HEAD")) throw err;
      }
    }
    if (!allowLaunch || !this.launchCmd) {
      throw new Unreachable("akou is not running");
    }
    rt = await this.launch();
    return this.send(rt, method, path, o);
  }

  /** Is an app answering? Never launches one. */
  async running(): Promise<Runtime | null> {
    const rt = this.runtime();
    if (!rt) return null;
    try {
      const r = await this.send(rt, "GET", "/status", { timeoutMs: 2000 });
      return r.status === 200 ? rt : null;
    } catch {
      return null;
    }
  }

  /**
   * Starts the app headless, detached, with its output in `app.log`, and waits for its API. Two
   * clients launching at once are fine: the second app finds the first one's lock and exits.
   */
  launch(): Promise<Runtime> {
    this.launching ??= this.doLaunch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async doLaunch(): Promise<Runtime> {
    const cmd = this.launchCmd;
    if (!cmd || cmd.length === 0) throw new Unreachable("akou is not running");
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(this.configDir, "app.log"), "a", 0o600);
    try {
      const child = spawn(cmd[0] as string, cmd.slice(1), {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...withNoProxy(this.o.env), AKOU_HEADLESS: "1" } as NodeJS.ProcessEnv,
      });
      child.on("error", () => {});
      child.unref();
    } finally {
      closeSync(log);
    }
    const deadline = performance.now() + this.budget;
    while (performance.now() < deadline) {
      const rt = await this.running();
      if (rt) return rt;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Unreachable(
      `akou did not answer within ${this.budget / 1000} s of launching; see ${join(this.configDir, "app.log")}`,
    );
  }

  tokenPath(): string {
    return join(this.configDir, TOKEN_FILE);
  }

  hasToken(): boolean {
    return existsSync(this.tokenPath());
  }
}

/**
 * Is the app gone, so a relaunch and a resend are safe? Only a refused connection proves a request
 * never arrived; a reset or a closed socket may come after the app applied it, so a write
 * (`idempotent` false) is never sent again on one.
 */
function isConnectionError(err: unknown, idempotent: boolean): boolean {
  const e = err as { code?: string; name?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return false;
  if (e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED") return true;
  return (
    idempotent && (e?.code === "ECONNRESET" || /connect|refused|socket/i.test(e?.message ?? ""))
  );
}

/** The exit code for an API answer (DESIGN 6.1). */
export function exitFor(status: number, code?: string): number {
  if (status >= 200 && status < 300) return EXIT.ok;
  if (code === "no_live_call" || code === "not_live" || code === "not_recording") {
    return EXIT.notLive;
  }
  if (code === "already_recording") return EXIT.alreadyRecording;
  if (code === "bad_term") return EXIT.badTerm;
  if (status === 401 || status === 403) return EXIT.permission;
  if (status === 501 || status === 503) return EXIT.unavailable;
  if (code === "final_running" || code === "restart_in_progress" || code === "locked") {
    return EXIT.unavailable;
  }
  if (status >= 400 && status < 500) return EXIT.usage;
  return EXIT.software;
}
