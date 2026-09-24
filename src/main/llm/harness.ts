/**
 * The harness provider (docs/DESIGN.md section 5.3): the coding agent the user already pays for,
 * Claude Code or Codex, run locally on an explicit request, with akou's small context on stdin.
 *
 * - **Discovery.** An app bundle gets a minimal `PATH`, so a harness is looked up on `PATH` first
 *   and then through the user's login shell (`$SHELL -lc 'command -v …'`), or `where` on Windows
 *   (TRAPS "Harness not found from an app bundle"). The user can pin a path. Each one found is
 *   asked for its version.
 * - **Invocation.** Claude Code: `claude -p --output-format stream-json --verbose
 *   --include-partial-messages --tools "" --strict-mcp-config --no-session-persistence
 *   --system-prompt SYSTEM`, the prompt on stdin. Codex: `codex exec --json --sandbox read-only
 *   --skip-git-repo-check --ephemeral -` (the trailing `-` reads the prompt from stdin). Both run in
 *   a fresh empty scratch folder, so no project instructions load, with no tools (Claude Code) or a
 *   read-only sandbox (Codex). `--strict-mcp-config` with no MCP config keeps the user's MCP
 *   servers out: measured on one tiny prompt, it cut the context Claude Code sent from about 17k
 *   tokens to about 3k.
 * - **Parsing.** Both print one JSON object per line. Claude Code streams `text_delta`s inside
 *   `stream_event`s and ends with a `result`; Codex reports `item.*` events whose `agent_message`
 *   text grows, and ends with `turn.completed` or `turn.failed`. The parsers are tested on
 *   sanitized recordings of the real programs (`tests/fixtures/harness/`).
 * - **Session reuse** (`provider.harnessResume`, off by default). A request with a `session` runs
 *   Claude Code with `--session-id ID` the first time and `--resume ID` after, instead of
 *   `--no-session-persistence`, in one scratch folder per session (Claude Code files a session
 *   under the folder it ran in), so a follow-up question sends only what is new. Codex runs every
 *   request fresh. The token cost of each run is read from Claude Code's `result` event.
 * - **Failures.** A usage limit (Claude Code's `rate_limit_event` with `status: rejected`, an API
 *   status 429, or limit wording), a login problem (status 401, "log in", "sign in", refresh token)
 *   and a missing program are told apart from exit codes, the JSON and stderr. stderr never reaches
 *   the user raw; it only feeds the classification.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  type Availability,
  type CompleteRequest,
  type CompleteResult,
  type Provider,
  ProviderError,
  readLines,
  type Usage,
} from "./provider.ts";

export type HarnessKind = "claude" | "codex";

/** How the harness names itself in provenance: `claude-code/2.1.281`, `codex/0.151.0`. */
export const HARNESS_LABEL: Record<HarnessKind, string> = { claude: "claude-code", codex: "codex" };

/** Codex's `exec --json` event format (`thread.started`, `item.*`) is checked from this version. */
export const CODEX_MIN_JSON = "0.44.0";

export interface HarnessInfo {
  kind: HarnessKind;
  path: string;
  version: string | null;
}

export type Discovery = Record<HarnessKind, HarnessInfo | null>;

// ---------------------------------------------------------------------------
// Discovery

/** Finds a program on `PATH`, then through the login shell (`$SHELL -lc 'command -v NAME'`). */
export function findProgram(name: string, env: Record<string, string | undefined>): string | null {
  const direct = Bun.which(name, { PATH: env.PATH ?? "" });
  if (direct) return direct;
  const shell = env.SHELL;
  if (!shell || process.platform === "win32") return null;
  const quoted = `'${name.replace(/'/g, `'\\''`)}'`;
  const r = spawnSync(shell, ["-lc", `command -v -- ${quoted}`], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 3000,
  });
  const path = r.status === 0 ? r.stdout.trim().split("\n").at(-1)?.trim() : "";
  return path && isAbsolute(path) ? path : null;
}

async function run(
  cmd: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ code: number; out: string } | null> {
  try {
    const p = Bun.spawn(cmd, {
      env: env as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    let out = "";
    const dec = new TextDecoder();
    const reader = p.stdout.getReader();
    const read = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        out += dec.decode(value, { stream: true });
      }
    })().catch(() => {});
    const code = await p.exited;
    clearTimeout(timer);
    // A descendant that inherited stdout (a login profile's background job) can hold it open after
    // the program is gone: what arrived within a short grace is the answer.
    const grace = new Promise<void>((r) => setTimeout(r, PIPE_GRACE_MS).unref?.());
    await Promise.race([read, grace]);
    reader.cancel().catch(() => {});
    return { code, out };
  } catch {
    return null;
  }
}

/** The first `x.y.z` in a `--version` answer. */
export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

/** `a` compared with `b`, both `x.y.z`: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Looks for `claude` and `codex`: on `PATH`, then in one login-shell run for both (or `where` on
 * Windows), then asks each for its version. Never throws; a harness not found is null.
 */
export async function discoverHarnesses(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): Promise<Discovery> {
  const names: HarnessKind[] = ["claude", "codex"];
  const paths = new Map<HarnessKind, string>();
  for (const n of names) {
    const p = Bun.which(n, { PATH: env.PATH ?? "" });
    if (p) paths.set(n, p);
  }
  const missing = names.filter((n) => !paths.has(n));
  if (missing.length > 0 && platform === "win32") {
    for (const n of missing) {
      const r = await run(["where", n], env, 3000);
      const p = r?.code === 0 ? r.out.trim().split(/\r?\n/)[0]?.trim() : "";
      if (p && isAbsolute(p)) paths.set(n, p);
    }
  } else if (missing.length > 0 && env.SHELL) {
    const script = missing.map((n) => `printf '%s=%s\\n' ${n} "$(command -v -- ${n})"`).join("; ");
    const r = await run([env.SHELL, "-lc", script], env, 5000);
    for (const line of r?.out.split("\n") ?? []) {
      const m = /^(claude|codex)=(.+)$/.exec(line.trim());
      if (m && isAbsolute(m[2] as string)) paths.set(m[1] as HarnessKind, m[2] as string);
    }
  }
  const out: Discovery = { claude: null, codex: null };
  await Promise.all(
    [...paths].map(async ([kind, path]) => {
      const r = await run([path, "--version"], env, 5000);
      out[kind] = { kind, path, version: r?.code === 0 ? parseVersion(r.out) : null };
    }),
  );
  return out;
}

/** A pinned path's kind, from its name: anything with `codex` in it is Codex. */
export function kindOfPath(path: string): HarnessKind {
  return basename(path).toLowerCase().includes("codex") ? "codex" : "claude";
}

// ---------------------------------------------------------------------------
// Parsing

/** What a finished run said about itself, beyond its text. */
export interface RunReport {
  text: string;
  /** The harness's own version, when it reported one (Claude Code's `init`). */
  version?: string;
  /** The error text the harness reported in its JSON. */
  errorText?: string;
  /** An HTTP status the harness reported for its API call. */
  apiStatus?: number;
  /** A usage limit was reported as reached. */
  limited?: boolean;
  /** Epoch ms the limit lifts, when reported. */
  resetsAt?: number;
  /** The harness said it finished (Claude Code `result`, Codex `turn.completed`). */
  finished: boolean;
  /** Tokens the run spent (Claude Code's `result.usage`). */
  usage?: Usage;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Claude Code's `usage` object (the Messages API's), as a `Usage`. */
export function parseUsage(u: unknown): Usage | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const o = u as Record<string, unknown>;
  return {
    input: num(o.input_tokens),
    cacheCreation: num(o.cache_creation_input_tokens),
    cacheRead: num(o.cache_read_input_tokens),
    output: num(o.output_tokens),
  };
}

export interface StreamParser {
  /** One parsed JSON line in; the text tokens it adds, in order. */
  feed(event: unknown): string[];
  report(): RunReport;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => (b as { text: string }).text)
    .join("");
}

/** Claude Code `-p --output-format stream-json --verbose [--include-partial-messages]`. */
export function claudeParser(): StreamParser {
  const r: RunReport = { text: "", finished: false };
  let streamed = false;
  return {
    feed(e) {
      if (!isObj(e)) return [];
      // Only the top-level conversation; a subagent's events carry a parent tool id.
      if (typeof e.parent_tool_use_id === "string") return [];
      switch (e.type) {
        case "system":
          if (e.subtype === "init" && typeof e.claude_code_version === "string") {
            r.version = e.claude_code_version;
          }
          return [];
        case "stream_event": {
          const ev = e.event;
          if (!isObj(ev) || ev.type !== "content_block_delta" || !isObj(ev.delta)) return [];
          if (ev.delta.type !== "text_delta" || typeof ev.delta.text !== "string") return [];
          streamed = true;
          r.text += ev.delta.text;
          return [ev.delta.text];
        }
        case "assistant": {
          const m = e.message;
          if (!isObj(m)) return [];
          const text = textOf(m.content);
          // An error the harness itself wrote as a message is not an answer.
          if (e.error !== undefined || m.model === "<synthetic>") {
            if (text) r.errorText = text;
            return [];
          }
          // Without partial messages, the whole message is the only token.
          if (streamed || text === "") return [];
          r.text += text;
          return [text];
        }
        case "rate_limit_event": {
          const info = e.rate_limit_info;
          if (isObj(info) && info.status === "rejected") {
            r.limited = true;
            if (typeof info.resetsAt === "number") r.resetsAt = info.resetsAt * 1000;
          }
          return [];
        }
        case "result": {
          r.finished = true;
          r.usage = parseUsage(e.usage) ?? r.usage;
          if (typeof e.api_error_status === "number") r.apiStatus = e.api_error_status;
          if (e.is_error === true) {
            r.errorText = typeof e.result === "string" ? e.result : (r.errorText ?? "error");
            return [];
          }
          // The final text is authoritative; send whatever the stream did not.
          if (typeof e.result === "string" && e.result.startsWith(r.text)) {
            const rest = e.result.slice(r.text.length);
            r.text = e.result;
            return rest ? [rest] : [];
          }
          return [];
        }
        default:
          return [];
      }
    },
    report: () => ({ ...r }),
  };
}

/** Codex `exec --json`: `item.*` events carry the agent's message as it grows. */
export function codexParser(): StreamParser {
  const r: RunReport = { text: "", finished: false };
  const seen = new Map<string, string>();
  const order: string[] = [];
  const assemble = () => order.map((id) => seen.get(id) ?? "").join("\n\n");
  return {
    feed(e) {
      if (!isObj(e)) return [];
      switch (e.type) {
        case "item.started":
        case "item.updated":
        case "item.completed": {
          const item = e.item;
          if (!isObj(item) || item.type !== "agent_message" || typeof item.text !== "string") {
            return [];
          }
          const id = typeof item.id === "string" ? item.id : String(order.length);
          if (!seen.has(id)) {
            order.push(id);
            seen.set(id, "");
          }
          const before = assemble();
          seen.set(id, item.text);
          const after = assemble();
          r.text = after;
          // Codex revises a message only by growing it; anything else is sent once complete.
          return after.startsWith(before) && after.length > before.length
            ? [after.slice(before.length)]
            : [];
        }
        case "error":
          if (typeof e.message === "string") r.errorText = e.message;
          return [];
        case "turn.failed": {
          const err = e.error;
          if (isObj(err) && typeof err.message === "string") r.errorText = err.message;
          else r.errorText ??= "the turn failed";
          r.finished = true;
          return [];
        }
        case "turn.completed":
          r.finished = true;
          // The turn succeeded; an earlier `error` was a transient one (a reconnect notice).
          delete r.errorText;
          return [];
        default:
          return [];
      }
    },
    report: () => ({ ...r }),
  };
}

// ---------------------------------------------------------------------------
// Failures

const LIMIT =
  /usage limit|rate limit|limit reached|hit your (usage )?limit|out of (credits|quota)|quota|too many requests|\b429\b/i;
const AUTH =
  /not logged in|log ?in|sign(ed)? in|unauthori[sz]ed|\b401\b|\b403\b|invalid api key|api key|access token|refresh token|authenticat|oauth|credential/i;

/**
 * Why a harness run failed, or null if it did not. The JSON the harness wrote is read before its
 * stderr, and a limit before a login problem: a limit message may mention signing in to upgrade,
 * while a login failure never mentions a limit.
 */
export function classifyRun(
  kind: HarnessKind,
  exitCode: number,
  report: RunReport,
  stderr: string,
): ProviderError | null {
  const who = kind === "claude" ? "Claude Code" : "Codex";
  const failed = exitCode !== 0 || report.errorText !== undefined;
  if (!failed) return null;
  const said = (report.errorText ?? "").trim();
  const firstLine = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  if (report.limited || report.apiStatus === 429 || LIMIT.test(said)) {
    return new ProviderError(
      "exhausted",
      `${who} reported its usage limit is reached${said ? ` (${said})` : ""}`,
      report.resetsAt,
    );
  }
  if (report.apiStatus === 401 || report.apiStatus === 403 || AUTH.test(said)) {
    return new ProviderError("auth", `${who} is not logged in${said ? ` (${said})` : ""}`);
  }
  if (said === "" && LIMIT.test(stderr)) {
    return new ProviderError("exhausted", `${who} reported its usage limit is reached`);
  }
  if (said === "" && AUTH.test(stderr)) {
    return new ProviderError("auth", `${who} is not logged in (${firstLine(stderr)})`);
  }
  const detail = said || firstLine(stderr) || "no error message";
  return new ProviderError("other", `${who} exited ${exitCode}: ${detail}`);
}

// ---------------------------------------------------------------------------
// The provider

export interface HarnessTarget {
  kind: HarnessKind;
  /** The program and any leading arguments (tests run a fake through Bun). */
  command: string[];
  version: string | null;
}

export interface HarnessProviderOptions {
  /** The harness to run, or why there is none (still looking, not found). */
  target: () => HarnessTarget | { none: string };
  env?: Record<string, string | undefined>;
  onLog?(level: "info" | "warn", msg: string): void;
}

export function harnessArgs(
  kind: HarnessKind,
  system: string,
  session?: CompleteRequest["session"],
): string[] {
  if (kind === "claude") {
    const persistence = !session
      ? ["--no-session-persistence"]
      : session.resume
        ? ["--resume", session.id]
        : ["--session-id", session.id];
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "",
      "--strict-mcp-config",
      ...persistence,
      "--system-prompt",
      system,
    ];
  }
  return ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-"];
}

/** Codex has no system prompt flag; the instructions go first on stdin. */
export function harnessStdin(kind: HarnessKind, req: CompleteRequest): string {
  return kind === "claude" ? req.prompt : `${req.system}\n\n${req.prompt}`;
}

const KILL_GRACE_MS = 2000;
/** How long the pipes may stay open after the harness exits. */
const PIPE_GRACE_MS = 1000;

/** Signals the harness's process group (POSIX) or its whole tree (Windows). */
function killTree(proc: { pid: number; kill(s?: NodeJS.Signals): void }, signal: NodeJS.Signals) {
  try {
    if (process.platform === "win32") {
      Bun.spawn(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } else {
      process.kill(-proc.pid, signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {}
  }
}
const STDERR_KEEP = 16_384;

export class HarnessProvider implements Provider {
  readonly id = "harness" as const;

  constructor(private readonly o: HarnessProviderOptions) {}

  /** Claude Code keeps sessions; Codex runs each request fresh. */
  sessions(): boolean {
    const t = this.o.target();
    return !("none" in t) && t.kind === "claude";
  }

  /** The scratch folder of a session: one per session id, kept between its runs. */
  static sessionDir(id: string): string {
    return join(tmpdir(), `akou-harness-session-${id.replace(/[^A-Za-z0-9-]/g, "")}`);
  }

  /** Forgets a session's scratch folder (the harness keeps its own record of the session). */
  static endSession(id: string): void {
    rmSync(HarnessProvider.sessionDir(id), { recursive: true, force: true });
  }

  /** `claude-code/2.1.281`, or null with no harness. */
  label(): string | null {
    const t = this.o.target();
    if ("none" in t) return null;
    return `${HARNESS_LABEL[t.kind]}${t.version ? `/${t.version}` : ""}`;
  }

  async available(): Promise<Availability> {
    const t = this.o.target();
    if ("none" in t) return { ok: false, kind: "missing", reason: t.none };
    if (t.kind === "codex" && t.version && compareVersions(t.version, CODEX_MIN_JSON) < 0) {
      return {
        ok: false,
        kind: "missing",
        reason: `codex ${t.version} is older than ${CODEX_MIN_JSON}, whose \`exec --json\` output akou reads; update Codex`,
      };
    }
    return { ok: true, detail: `${this.label()} at ${t.command.at(-1)}` };
  }

  async complete(
    req: CompleteRequest,
    onToken: (t: string) => void,
    signal: AbortSignal,
  ): Promise<CompleteResult> {
    const avail = await this.available();
    if (!avail.ok) throw new ProviderError(avail.kind, avail.reason);
    const t = this.o.target() as HarnessTarget;
    const session = t.kind === "claude" ? req.session : undefined;
    let scratch: string;
    if (session) {
      scratch = HarnessProvider.sessionDir(session.id);
      mkdirSync(scratch, { recursive: true });
    } else {
      scratch = mkdtempSync(join(tmpdir(), "akou-harness-"));
    }
    // A session's folder outlives the run: its next question resumes from it.
    const cleanup = () => {
      if (!session) rmSync(scratch, { recursive: true, force: true });
    };
    const parser = t.kind === "claude" ? claudeParser() : codexParser();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([...t.command, ...harnessArgs(t.kind, req.system, session)], {
        cwd: scratch,
        env: (this.o.env ?? process.env) as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // Its own process group, so cancelling reaches anything it started.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      cleanup();
      const code = (err as { code?: string }).code;
      throw new ProviderError(
        code === "ENOENT" ? "missing" : "other",
        code === "ENOENT"
          ? `${t.command[0]} was not found; is ${HARNESS_LABEL[t.kind]} still installed?`
          : `cannot start ${HARNESS_LABEL[t.kind]}: ${(err as Error).message}`,
      );
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      killTree(proc, "SIGTERM");
      killTimer = setTimeout(() => killTree(proc, "SIGKILL"), KILL_GRACE_MS);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const stdin = proc.stdin as import("bun").FileSink;
      try {
        stdin.write(harnessStdin(t.kind, req));
        await stdin.end();
      } catch {
        // The harness quit before reading its prompt; its exit code says why.
      }
      let stderr = "";
      const errDone = (async () => {
        for await (const line of readLines(proc.stderr as ReadableStream<Uint8Array>)) {
          if (stderr.length < STDERR_KEEP) stderr += `${line}\n`;
        }
      })();
      const outDone = (async () => {
        for await (const line of readLines(proc.stdout as ReadableStream<Uint8Array>)) {
          if (line.trim() === "") continue;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          for (const tok of parser.feed(event)) if (!signal.aborted) onToken(tok);
        }
      })();
      // A descendant that inherited the pipes (and left the group) can hold them open after the
      // harness is gone; once it has exited, the pipes get a short grace and are then abandoned.
      const code = await proc.exited;
      const grace = new Promise<void>((r) => setTimeout(r, PIPE_GRACE_MS).unref?.());
      await Promise.race([Promise.all([outDone, errDone]), grace]);
      if (signal.aborted) throw new ProviderError("cancelled", "cancelled");
      const report = parser.report();
      const failure = classifyRun(t.kind, code, report, stderr);
      if (failure) {
        this.o.onLog?.("warn", `harness: ${failure.message}`);
        throw failure;
      }
      if (report.text.trim() === "") {
        throw new ProviderError("other", `${HARNESS_LABEL[t.kind]} finished with no answer`);
      }
      const version = report.version ?? t.version;
      return {
        text: report.text,
        model: `${HARNESS_LABEL[t.kind]}${version ? `/${version}` : ""}`,
        ...(report.usage ? { usage: report.usage } : {}),
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      cleanup();
    }
  }
}

/**
 * The harness to run, from settings and discovery: a pinned path first, then the chosen kind, then
 * in `auto` Claude Code before Codex.
 */
export function pickHarness(
  choice: "auto" | HarnessKind,
  pinned: string,
  found: Discovery | null,
): HarnessTarget | { none: string } {
  if (pinned !== "") {
    const kind = choice === "auto" ? kindOfPath(pinned) : choice;
    const known = found?.[kind];
    return { kind, command: [pinned], version: known?.path === pinned ? known.version : null };
  }
  if (!found) return { none: "still looking for Claude Code and Codex" };
  const order: HarnessKind[] = choice === "auto" ? ["claude", "codex"] : [choice];
  for (const k of order) {
    const h = found[k];
    if (h) return { kind: k, command: [h.path], version: h.version };
  }
  const names = order.map((k) => HARNESS_LABEL[k]).join(" or ");
  return {
    none: `no harness found (${names}) on PATH or through the login shell; install one, pin its path in provider.harnessPath, or choose another provider`,
  };
}
