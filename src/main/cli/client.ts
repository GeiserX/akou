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
 *
 * A remote akou (docs/research/service-interface.md SI-1): with `AKOU_URL` set, every request goes to
 * that base URL (`https://akou.example` gets `/v1/...` appended) with `Authorization: Bearer` and
 * the key from `AKOU_API_KEY`, or from the file `AKOU_API_KEY_FILE` names. The key is never an
 * argument (the parser refuses `--key`). Then `runtime.json` is never read and the app is never
 * launched: a remote that does not answer is `Unreachable`, exit 69.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { processAlive } from "../../core/log/writer.ts";
import { TOKEN_FILE } from "../api/guard.ts";
import { RUNTIME_FILE } from "../app-info.ts";
import { APP_LOG } from "../app-log.ts";
import { resolvePaths } from "../config/schema.ts";
import {
  ANSWER_MS,
  HANGS_DIR,
  HEAL_BUDGET_MS,
  HUNG_MS,
  probe,
  processTable,
  type Recording,
  recordingBelow,
  sampleHung,
  seconds,
  stopAll,
  stopList,
} from "./heal.ts";

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
  /** EX_CONFIG: the settings forbid what was asked, as `akou serve` with a bind they refuse. */
  config: 78,
  /** `akou wait` ran out of time, as `timeout(1)` reports it. */
  timeout: 124,
  /** Ctrl-C ended a one-shot command, as a shell reports a process ended by SIGINT. */
  interrupted: 130,
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

/** The app takes the connection and never answers, and was not restarted (DK-M8). */
export class Hung extends Unreachable {
  override name = "Hung";
}

/** A hung app was stopped for a request that never launches one (`akou quit`, DK-M8). */
export class StoppedHung extends Hung {
  override name = "StoppedHung";
}

/** What a program the CLI launches prints, in the config folder. */
export const LAUNCH_LOG = "launch.log";
/**
 * At this size `launch.log` becomes `launch.log.1`, replacing the older one, checked at each
 * launch only: once the CLI exits, nothing of akou's stands between the launched program and the
 * file. It stays small because the app logs to `app.log` and echoes nothing to a stderr that is
 * not a terminal, so `launch.log` holds only what is printed before the app can log (a start that
 * fails) or instead of it (a crash).
 */
export const LAUNCH_LOG_MAX_BYTES = 1024 * 1024;

/** Moves `file` to `file.1` once it reaches `max` bytes. Never throws. */
export function rotate(file: string, max: number): void {
  try {
    if (statSync(file).size >= max) renameSync(file, `${file}.1`);
  } catch {}
}

/** A probe answered this recently: the next request goes straight out. */
const FRESH_MS = 5000;

/** The remote target is set up wrong: an `AKOU_URL` that is not a URL (64), a key file (77). */
export class TargetError extends Error {
  override name = "TargetError";
  constructor(
    message: string,
    readonly exit: number,
  ) {
    super(message);
  }
}

/** Where a remote target's requests go and the key they carry, or null for the local app. */
export interface RemoteTarget {
  /** The base URL as given, without a trailing slash. */
  base: string;
  key: string;
}

/** `AKOU_URL` and its key (SI-1), read when a request is made, or null when `AKOU_URL` is unset. */
export function remoteTarget(env: Record<string, string | undefined>): RemoteTarget | null {
  const raw = env.AKOU_URL?.trim();
  if (!raw) return null;
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {}
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new TargetError(
      `AKOU_URL must be an http or https URL, like https://akou.example; it is ${JSON.stringify(raw)}`,
      EXIT.usage,
    );
  }
  // The API path is appended to AKOU_URL, so a query or a fragment would swallow it. The
  // serialized URL keeps an empty `?` or `#` that `search` and `hash` report as "".
  if (/[?#]/.test(url.href)) {
    throw new TargetError(
      `AKOU_URL must not carry a query or a fragment, like https://akou.example/prefix; it is ${JSON.stringify(raw)}`,
      EXIT.usage,
    );
  }
  // akou never uses basic auth, and every message names the base URL: a password there would be
  // printed back. The URL is not echoed here for the same reason.
  if (url.username || url.password) {
    throw new TargetError(
      "AKOU_URL must not carry a user name or password; the key goes in AKOU_API_KEY, or in a file named by AKOU_API_KEY_FILE",
      EXIT.usage,
    );
  }
  const base = raw.replace(/\/+$/, "");
  // A blank AKOU_API_KEY (`-e AKOU_API_KEY=` in a compose file) falls through to the key file.
  const inline = env.AKOU_API_KEY?.trim();
  if (inline) return { base, key: inline };
  const given = env.AKOU_API_KEY_FILE;
  if (!given) return { base, key: "" };
  // `docker -e` and a systemd unit pass `~/...` as written; no shell expands it there.
  const file = /^~[\\/]/.test(given)
    ? join(env.HOME ?? env.USERPROFILE ?? homedir(), given.slice(2))
    : given;
  try {
    return { base, key: readFileSync(file, "utf8").trim() };
  } catch (err) {
    throw new TargetError(
      `cannot read the key in AKOU_API_KEY_FILE (${file}): ${(err as Error).message}`,
      EXIT.permission,
    );
  }
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
  /** Restart a hung app even for a request that only reads (`--restart`, DK-M8). */
  restart?: boolean;
  /** One line for the user, on stderr: what the client did on its own (a restart). */
  note?: (line: string) => void;
  /** How long the app has to answer before it counts as hung (tests shorten it). */
  answerMs?: number;
}

export interface RequestOptions {
  body?: unknown;
  /** A multipart body instead of JSON: an upload route (`akou transcribe`). */
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined>;
  /** Launch the app if it is not running. Default true. */
  launch?: boolean;
  /** Overrides `ClientOptions.client` for this request (the MCP client's own name). */
  client?: string;
  timeoutMs?: number;
  /** Aborts the request (Ctrl-C during `tail -f`). */
  signal?: AbortSignal;
}

/** Inside a program built by `bun build --compile`, whose modules live in Bun's virtual folder. */
export function isCompiled(dir: string = import.meta.dir): boolean {
  return dir.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(dir);
}

/**
 * How the CLI starts a cold app headless:
 *
 * - From source: this Bun on `src/main/index.ts`.
 * - The compiled CLI on macOS: the installed `akou.app` through LaunchServices (`open`), so the app,
 *   not the terminal, is the process macOS asks for the microphone and system-audio grants.
 *   `--env` is how `open` passes `AKOU_HEADLESS`.
 * - The compiled CLI anywhere else, or with no app installed: null, it never launches.
 */
export function defaultLaunch(
  o: {
    dir?: string;
    execPath?: string;
    platform?: string;
    home?: string;
    exists?: (path: string) => boolean;
  } = {},
): readonly string[] | null {
  const dir = o.dir ?? import.meta.dir;
  if (!isCompiled(dir)) return [o.execPath ?? process.execPath, join(dir, "..", "index.ts")];
  if ((o.platform ?? process.platform) !== "darwin") return null;
  const exists = o.exists ?? existsSync;
  for (const app of [
    "/Applications/akou.app",
    join(o.home ?? homedir(), "Applications", "akou.app"),
  ]) {
    if (exists(app)) return ["/usr/bin/open", "-g", "-j", "-a", app, "--env", "AKOU_HEADLESS=1"];
  }
  return null;
}

export const DEFAULT_LAUNCH = defaultLaunch();

export class ApiClient {
  readonly configDir: string;
  private readonly launchCmd: readonly string[] | null;
  private readonly budget: number;
  private launching: Promise<Runtime> | null = null;
  /** When the app last answered a probe (`performance.now()`), so a burst of requests probes once. */
  private answeredAt = Number.NEGATIVE_INFINITY;
  /** The recovery of a hung app under way, which concurrent requests share (DK-M8). */
  private healing: Promise<Runtime> | null = null;
  /** What the client did on its own since the last `takeNotes` (a restart), for the MCP answer. */
  private notes: string[] = [];

  constructor(readonly o: ClientOptions) {
    this.configDir = resolvePaths(o.env).configDir;
    this.launchCmd = o.launch === undefined ? DEFAULT_LAUNCH : o.launch;
    this.budget = o.launchBudgetMs ?? LAUNCH_BUDGET_MS;
  }

  /**
   * `runtime.json` of a running app, or null (no file, bad file, or its pid is gone). Never read
   * with a remote target: the app on this machine is not the one being talked to.
   */
  runtime(): Runtime | null {
    if (this.o.env.AKOU_URL?.trim()) return null;
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

  private async fetchRaw(
    to: Runtime | RemoteTarget,
    method: string,
    path: string,
    o: RequestOptions,
  ): Promise<Response> {
    const remote = "base" in to;
    const url = new URL(remote ? `${to.base}/v1${path}` : `http://127.0.0.1:${to.port}/v1${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const hasBody = method !== "GET" && method !== "HEAD";
    return fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${remote ? to.key : this.token()}`,
        "x-akou-client": o.client ?? this.o.client,
        ...(hasBody && !o.form ? { "content-type": "application/json" } : {}),
      },
      body: o.form ?? (hasBody ? JSON.stringify(o.body ?? {}) : undefined),
      signal: o.signal
        ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs ?? 60_000)])
        : AbortSignal.timeout(o.timeoutMs ?? 60_000),
    });
  }

  private async send(to: Runtime | RemoteTarget, method: string, path: string, o: RequestOptions) {
    const res = await this.fetchRaw(to, method, path, o);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {}
    // No key was set, so the server's "missing or wrong" cannot say which variable to set. The
    // request still goes out: `/v1/server` and `/healthz` need no key.
    if (res.status === 401 && "base" in to && to.key === "") {
      const b = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const msg = typeof b.message === "string" ? b.message : text.trim() || "HTTP 401";
      body = {
        error: "unauthorized",
        ...b,
        message: `${msg}; no key was set: set AKOU_API_KEY, or AKOU_API_KEY_FILE to a file that holds it`,
      };
    }
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
    const remote = remoteTarget(this.o.env);
    if (remote) {
      const idempotent = method === "GET" || method === "HEAD";
      return this.onRemote(remote, idempotent, o, () => this.send(remote, method, path, o));
    }
    const allowLaunch = o.launch ?? true;
    let rt = this.runtime();
    if (rt) {
      rt = await this.answering(rt, method, allowLaunch);
      try {
        return await this.send(rt, method, path, o);
      } catch (err) {
        if (!isConnectionError(err, method === "GET" || method === "HEAD")) throw err;
      }
    }
    if (!allowLaunch || !this.launchCmd) throw this.notRunning(allowLaunch);
    rt = await this.launch();
    return this.send(rt, method, path, o);
  }

  /**
   * One request whose answer is read as it arrives (Server-Sent Events): the raw response. Launches
   * the app like `request` when nothing answers. The caller reads and closes the body.
   */
  async stream(method: string, path: string, o: RequestOptions = {}): Promise<Response> {
    const remote = remoteTarget(this.o.env);
    if (remote) {
      const idempotent = method === "GET" || method === "HEAD";
      return this.onRemote(remote, idempotent, o, () => this.fetchRaw(remote, method, path, o));
    }
    let rt = this.runtime();
    if (rt) {
      rt = await this.answering(rt, method, o.launch ?? true);
      try {
        return await this.fetchRaw(rt, method, path, o);
      } catch (err) {
        if (!isConnectionError(err, false)) throw err;
      }
    }
    if ((o.launch ?? true) === false || !this.launchCmd) throw this.notRunning(o.launch ?? true);
    rt = await this.launch();
    return this.fetchRaw(rt, method, path, o);
  }

  /**
   * One request to a remote target, never a launch. A refused connection, or one that never
   * answers, is `Unreachable`; a broken connection is too, for a read only: a write may have landed.
   */
  private async onRemote<T>(
    remote: RemoteTarget,
    idempotent: boolean,
    o: RequestOptions,
    go: () => Promise<T>,
  ): Promise<T> {
    try {
      return await go();
    } catch (err) {
      const proxy = proxyNote(remote.base, this.o.env);
      if ((err as Error)?.name === "TimeoutError") {
        const s = Math.round((o.timeoutMs ?? 60_000) / 100) / 10;
        throw new Unreachable(`no answer from ${remote.base} (AKOU_URL) within ${s} s${proxy}`);
      }
      if (isConnectionError(err, idempotent)) {
        throw new Unreachable(`nothing answers at ${remote.base} (AKOU_URL)${proxy}`);
      }
      throw err;
    }
  }

  /** Nothing answers and this client will not launch: say what the user can do. */
  private notRunning(launchAllowed: boolean): Unreachable {
    return new Unreachable(
      launchAllowed && !this.launchCmd
        ? "akou is not running, and this command line cannot start it; open the akou app and try again"
        : "akou is not running",
    );
  }

  /** Is an app answering? Never launches one. */
  async running(timeoutMs = 2000): Promise<Runtime | null> {
    const rt = this.runtime();
    if (!rt) return null;
    try {
      const r = await this.send(rt, "GET", "/status", { timeoutMs: Math.max(1, timeoutMs) });
      return r.status === 200 ? rt : null;
    } catch {
      return null;
    }
  }

  /**
   * Starts the app headless, detached, with its output in `launch.log`, and waits for its API. Two
   * clients launching at once are fine: the second app finds the first one's lock and exits.
   */
  launch(waitMs: number = this.budget): Promise<Runtime> {
    this.launching ??= this.doLaunch(waitMs).finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async doLaunch(waitMs: number): Promise<Runtime> {
    const cmd = this.launchCmd;
    if (!cmd || cmd.length === 0) throw new Unreachable("akou is not running");
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    // What the launched program prints. The app writes its own `app.log` (DK-M8); this file holds
    // what it printed before it could, such as a start that failed.
    const file = join(this.configDir, LAUNCH_LOG);
    rotate(file, LAUNCH_LOG_MAX_BYTES);
    const log = openSync(file, "a", 0o600);
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
    const deadline = performance.now() + waitMs;
    while (performance.now() < deadline) {
      // A probe never runs past the wait: a slow answer is cut at the deadline.
      const rt = await this.running(Math.min(2000, deadline - performance.now()));
      if (rt) return rt;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Unreachable(
      `akou did not answer within ${Math.round(waitMs / 100) / 10} s of launching; see ${join(this.configDir, LAUNCH_LOG)} and ${join(this.configDir, APP_LOG)}`,
    );
  }

  /**
   * DK-M8: the app answers `/healthz` within `answerMs`, or it is hung. A hung app is restarted
   * for a request that changes something (or with `--restart`) when no recording is in progress,
   * and the request goes to the new one; otherwise `Hung` says why nothing was done. A request that
   * never launches the app (`akou quit`) gets `StoppedHung` once the app is stopped, unless
   * `--restart` asked for a new one. A refused connection is left to the caller, which launches
   * the app.
   */
  private async answering(rt: Runtime, method: string, launch: boolean): Promise<Runtime> {
    if (performance.now() - this.answeredAt < FRESH_MS) return rt;
    const t0 = performance.now();
    const answerMs = this.o.answerMs ?? ANSWER_MS;
    const p = await probe(rt.port, answerMs);
    if (p === "answers") this.answeredAt = performance.now();
    if (p !== "silent") return rt;
    const s = Math.round(answerMs / 100) / 10;
    const changes = method !== "GET" && method !== "HEAD";
    if (process.platform === "win32") {
      throw new Hung(
        `akou is not answering: it took the connection and sent nothing back for ${s} s (pid ${rt.pid}); end it in Task Manager and run the command again`,
      );
    }
    if (!changes && this.o.restart !== true) {
      throw new Hung(
        `akou is not answering: it took the connection and sent nothing back for ${s} s (pid ${rt.pid}); nothing was restarted, as this command only reads: run it again with --restart to restart akou`,
      );
    }
    // One recovery per client at a time: the MCP server sends concurrent requests through one
    // client, and each must not sample, stop and relaunch the app again.
    this.healing ??= this.heal(rt, launch, t0).finally(() => {
      this.healing = null;
    });
    return this.healing;
  }

  /** The recovery itself: `answering` runs one at a time per client. */
  private async heal(rt: Runtime, launch: boolean, t0: number): Promise<Runtime> {
    const rows = await processTable();
    // A list that cannot be read may hide a recording helper: nothing is stopped.
    if (rows === null) {
      throw new Hung(
        `akou is not answering, and the processes below it could not be listed (ps failed), so nothing was stopped; kill -KILL ${rt.pid} restarts it by hand, then run the command again`,
      );
    }
    const rec = await recordingBelow(rows, rt.pid);
    if (rec) throw new Hung(recordingMessage(rt.pid, rec));
    await sampleHung(rt.pid, join(this.configDir, HANGS_DIR));
    // A busy app, not a hung one, answers within the watchdog's silence: it is left alone.
    const rest = Math.max(1000, HUNG_MS - (performance.now() - t0));
    if ((await probe(rt.port, rest)) === "answers") {
      this.answeredAt = performance.now();
      return rt;
    }
    const left = await stopAll(stopList(rows, rt.pid));
    if (left.length > 0) {
      throw new Hung(
        `akou is not answering and could not be stopped (pid ${left.join(", ")} is still there); stop it with kill -KILL ${left.join(" ")} and run the command again`,
      );
    }
    if (!launch && this.o.restart !== true) {
      throw new StoppedHung(`akou was not answering; stopped it (${seconds(t0)} s)`);
    }
    if (!this.launchCmd) {
      throw new Hung(
        "akou was not answering, so it was stopped; this command line cannot start it again: open the akou app and run the command again",
      );
    }
    // The launch keeps its own cold budget even past HEAL_BUDGET_MS: the old app is gone by now,
    // and a launch cut short leaves the user with no app at all, which is worse than a few
    // seconds more.
    const next = await this.launch(
      Math.max(this.budget, HEAL_BUDGET_MS - (performance.now() - t0)),
    );
    this.answeredAt = performance.now();
    const line = `akou was not answering; restarted it (${seconds(t0)} s)`;
    this.notes.push(line);
    this.o.note?.(line);
    return next;
  }

  /** The lines of what the client did on its own since the last call (DK-M8), then none. */
  takeNotes(): string[] {
    return this.notes.splice(0);
  }

  tokenPath(): string {
    return join(this.configDir, TOKEN_FILE);
  }

  hasToken(): boolean {
    return existsSync(this.tokenPath());
  }
}

/** What the CLI says when the app is hung and a call is recording: nothing is stopped. */
export function recordingMessage(appPid: number, rec: Recording): string {
  const audio =
    rec.growing === true
      ? "is still writing the audio"
      : rec.growing === false
        ? "is alive, though its audio file did not grow in the last second"
        : "is alive";
  return `akou is not answering while a call is recording (pid ${appPid}); the capture helper (pid ${rec.pid}) ${audio}, so nothing was restarted. To restart akou by hand, which ends this recording and keeps the audio so far: kill -KILL ${appPid}, then run the command again`;
}

/**
 * Is the app gone, so a relaunch and a resend are safe? Only a refused connection proves a request
 * never arrived; a reset or a closed socket may come after the app applied it, so a write
 * (`idempotent` false) is never sent again on one.
 */
/**
 * When a proxy variable covers a remote's scheme, the words that say so: the request went to the
 * proxy, not to `AKOU_URL`, unless `NO_PROXY` names the host. Loopback never goes through one.
 */
function proxyNote(base: string, env: Record<string, string | undefined>): string {
  const url = new URL(base);
  if (LOOPBACK.includes(url.hostname) || url.hostname === "[::1]") return "";
  const names =
    url.protocol === "https:" ? ["HTTPS_PROXY", "https_proxy"] : ["HTTP_PROXY", "http_proxy"];
  const name = names.find((n) => env[n]);
  // The variable's name only: a proxy URL can carry credentials, and this reaches `--json`.
  return name
    ? `; ${name} is set, so the request went through that proxy unless NO_PROXY names the host`
    : "";
}

function isConnectionError(err: unknown, idempotent: boolean): boolean {
  const e = err as { code?: string; name?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return false;
  if (e?.code === "ConnectionRefused" || e?.code === "ECONNREFUSED") return true;
  return (
    idempotent && (e?.code === "ECONNRESET" || /connect|refused|socket/i.test(e?.message ?? ""))
  );
}

/**
 * The exit code for an API answer (DESIGN 6.1). `body` tells a missing call (`not_found` with
 * `call`) from another missing thing (a key, a model, a note), which stays a usage error.
 */
export function exitFor(
  status: number,
  code?: string,
  body?: Record<string, unknown> | null,
): number {
  if (status >= 200 && status < 300) return EXIT.ok;
  if (code === "no_live_call" || code === "not_live" || code === "not_recording") {
    return EXIT.notLive;
  }
  // No call to act on: none at all for `last`, or `-c` names one that does not exist.
  if (code === "no_calls" || (code === "not_found" && typeof body?.call === "string")) {
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
