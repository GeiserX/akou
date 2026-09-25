/**
 * Spawning a capture helper and speaking to it (docs/DESIGN.md sections 1.3 and 2.4).
 *
 * `ChildCaptureSession` owns one child process: it pumps stdout into a dialect decoder, parses
 * stderr lines into messages and keeps every line in the part's capture log, and stops the child
 * within a budget. A helper that hangs in teardown (a stale permission once blocked Core Audio
 * teardown forever) is killed when the budget is spent, and nothing the app does ever waits on the
 * child without a deadline (TRAPS T0.9).
 *
 * `AkouCaptureEngine` runs `akou-capture run …` and speaks `akou-capture/1`. Its command prefix is
 * configurable, which is how the tests run `scripts/fake-helper.ts` in its place.
 */

import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type CaptureEngine,
  type CaptureHandlers,
  type CaptureSession,
  type CaptureStartOptions,
  type Clock,
  type ExitInfo,
  realClock,
  SpawnError,
  type StopOutcome,
  withDeadline,
} from "./engine.ts";
import {
  type HelperCommand,
  LineSplitter,
  PacketDecoder,
  PROTOCOL,
  parseStderrLine,
} from "./protocol.ts";

/** After a kill, how long we wait for the exit to be reported before giving up on it. */
export const KILL_GRACE_MS = 1000;
/** After exit, how long the pipes may take to drain before the exit is reported anyway. */
const DRAIN_GRACE_MS = 500;

/** How one kind of child turns its stdout into packets and how it is asked to stop. */
export interface Dialect {
  readonly name: string;
  /** Called for every stdout read. Throws `ProtocolError` on bad framing. */
  stdout(chunk: Uint8Array): void;
  /** Asks the child to stop. */
  requestStop(child: ChildControl): void;
  /** stdout ended; flush anything held. */
  end?(): void;
}

export interface ChildControl {
  send(line: string): void;
  closeStdin(): void;
  signal(sig: NodeJS.Signals): void;
}

export interface ChildSpawnOptions {
  argv: string[];
  env?: Record<string, string | undefined>;
  logPath?: string;
  clock?: Clock;
}

export class ChildCaptureSession implements CaptureSession, ChildControl {
  readonly pid: number | undefined;
  readonly dialect: string;
  readonly exited: Promise<ExitInfo>;
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly clock: Clock;
  private readonly d: Dialect;
  private readonly handlers: CaptureHandlers;
  private logFd = -1;
  private stdinOpen = true;
  private killedByUs = false;
  private protocolError: string | undefined;
  private stoppedMsg: ExitInfo["stopped"];
  private exitInfo: ExitInfo | null = null;

  constructor(
    opts: ChildSpawnOptions,
    handlers: CaptureHandlers,
    makeDialect: (s: ChildCaptureSession) => Dialect,
  ) {
    this.clock = opts.clock ?? realClock;
    this.handlers = handlers;
    try {
      this.proc = Bun.spawn(opts.argv, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
      });
    } catch (err) {
      throw new SpawnError(`cannot start ${opts.argv[0]}: ${(err as Error).message}`);
    }
    this.pid = this.proc.pid;
    if (opts.logPath) {
      try {
        this.logFd = openSync(opts.logPath, "a");
      } catch {
        this.logFd = -1;
      }
    }
    this.d = makeDialect(this);
    this.dialect = this.d.name;
    const out = this.pumpStdout();
    const err = this.pumpStderr();
    this.exited = this.watchExit(out, err);
  }

  /** Emits a packet or message from a dialect. Handler errors never reach the pumps. */
  emitPacket: CaptureHandlers["packet"] = (p) => {
    try {
      this.handlers.packet(p);
    } catch (err) {
      console.error("capture packet handler failed", err);
    }
  };

  emitMessage: CaptureHandlers["message"] = (m) => {
    if (m.type === "stopped") this.stoppedMsg = { fileSeconds: m.file_seconds, reason: m.reason };
    try {
      this.handlers.message(m);
    } catch (err) {
      console.error("capture message handler failed", err);
    }
  };

  log(line: string): void {
    if (this.logFd < 0) return;
    try {
      writeSync(this.logFd, `${line}\n`);
    } catch {
      // The capture log is diagnostics; a full disk must not stop capture.
    }
  }

  private async pumpStdout(): Promise<void> {
    try {
      for await (const chunk of this.proc.stdout) {
        if (this.protocolError) continue;
        try {
          this.d.stdout(chunk);
        } catch (err) {
          this.protocolError = (err as Error).message;
          this.log(`akou: protocol error: ${this.protocolError}; killing the helper`);
          this.kill();
        }
      }
      this.d.end?.();
    } catch {
      // The pipe broke because the child died; the exit watcher reports it.
    }
  }

  private async pumpStderr(): Promise<void> {
    const lines = new LineSplitter();
    const handle = (line: string) => {
      this.log(line);
      const parsed = parseStderrLine(line);
      if (parsed.kind === "msg") this.emitMessage(parsed.msg);
    };
    try {
      for await (const chunk of this.proc.stderr) for (const l of lines.push(chunk)) handle(l);
      for (const l of lines.flush()) handle(l);
    } catch {
      // As above.
    }
  }

  private async watchExit(out: Promise<void>, err: Promise<void>): Promise<ExitInfo> {
    await this.proc.exited;
    // Let the pipes drain so a `stopped` line written just before exit is seen, but never wait on
    // a pipe a grandchild may still hold open.
    await withDeadline(this.clock, Promise.all([out, err]), DRAIN_GRACE_MS);
    this.stdinOpen = false;
    const info: ExitInfo = {
      code: this.proc.exitCode,
      signal: this.proc.signalCode ?? null,
      killedByUs: this.killedByUs,
      stopped: this.stoppedMsg,
      protocolError: this.protocolError,
    };
    this.exitInfo = info;
    if (this.logFd >= 0) {
      this.log(
        `akou: helper exited code=${info.code} signal=${info.signal} killed=${info.killedByUs}`,
      );
      try {
        closeSync(this.logFd);
      } catch {}
      this.logFd = -1;
    }
    try {
      this.handlers.exit(info);
    } catch (e) {
      console.error("capture exit handler failed", e);
    }
    return info;
  }

  send(cmd: HelperCommand | string): void {
    if (!this.stdinOpen || this.exitInfo) return;
    try {
      this.proc.stdin.write(`${cmd}\n`);
      this.proc.stdin.flush();
    } catch {
      this.stdinOpen = false;
    }
  }

  closeStdin(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    try {
      this.proc.stdin.end();
    } catch {
      // Already closed by the child's exit.
    }
  }

  signal(sig: NodeJS.Signals): void {
    if (this.exitInfo) return;
    try {
      this.proc.kill(sig);
    } catch {
      // Gone already.
    }
  }

  kill(): void {
    if (this.exitInfo) return;
    this.killedByUs = true;
    this.signal("SIGKILL");
  }

  async stop(budgetMs: number): Promise<StopOutcome> {
    const t0 = this.clock.now();
    if (this.exitInfo) return { killed: false, exit: this.exitInfo, ms: 0 };
    this.d.requestStop(this);
    const first = await withDeadline(this.clock, this.exited, budgetMs);
    if (first.ok) return { killed: false, exit: first.value, ms: this.clock.now() - t0 };
    this.log(`akou: helper did not stop within ${budgetMs} ms; killing it`);
    this.kill();
    const second = await withDeadline(this.clock, this.exited, KILL_GRACE_MS);
    return { killed: true, exit: second.ok ? second.value : null, ms: this.clock.now() - t0 };
  }
}

/** The `akou-capture/1` dialect: framed float packets on stdout, `stop` on stdin. */
export function akouCaptureDialect(s: ChildCaptureSession): Dialect {
  const decoder = new PacketDecoder();
  return {
    name: PROTOCOL,
    stdout(chunk) {
      for (const p of decoder.push(chunk)) s.emitPacket(p);
    },
    requestStop(child) {
      child.send("stop");
      child.closeStdin();
    },
  };
}

export interface HelperEngineOptions {
  /** Program and leading arguments, e.g. `["akou-capture"]`. */
  command: string[];
  /** Extra arguments per part (tests use this to pass fault switches to the fake helper). */
  extraArgs?: (opts: CaptureStartOptions) => string[];
  env?: Record<string, string | undefined>;
  clock?: Clock;
}

/** The helper's file name on this OS. */
export const HELPER_NAME = process.platform === "win32" ? "akou-capture.exe" : "akou-capture";

export interface HelperLocation {
  /** Program and leading arguments. */
  command: string[];
  /** `config`: `capture.helper`; `bundled`: beside the app's main module; `path`: looked up on PATH. */
  source: "config" | "bundled" | "path";
}

/**
 * Where the capture helper is. `capture.helper` from config.json wins when it is set, because it is
 * an explicit choice (the tests point it at the fake helper, a developer at a local build). Then the
 * helper bundled beside the app's main module: the release bundles this module into
 * `Contents/Resources/app/bun/index.js` and copies `native/akou-capture` into the same folder
 * (`electrobun.config.ts`), where the Workers, the pages and the templates also sit. Not beside
 * `process.execPath`: that is `Contents/MacOS/bun`, where the release puts no helper. Then
 * `akou-capture` on PATH, which the spawn resolves. From source and from the compiled CLI (whose
 * module folder is `/$bunfs/root`) there is no bundled helper. `name` finds the diarization
 * helper (`akou-diarize`, `asr.diarizeHelper`) by the same rule.
 */
export function locateHelper(
  configured: readonly string[],
  o: { dir?: string; exists?: (path: string) => boolean; name?: string } = {},
): HelperLocation {
  if (configured.length > 0) return { command: [...configured], source: "config" };
  const name = o.name ?? HELPER_NAME;
  const bundled = join(o.dir ?? import.meta.dir, name);
  if ((o.exists ?? existsSync)(bundled)) return { command: [bundled], source: "bundled" };
  return { command: [name], source: "path" };
}

export interface HelperFound extends HelperLocation {
  /** The program's absolute path when it is there, else null. */
  found: string | null;
}

/**
 * `locateHelper`, and whether its program is there: an absolute path must exist, a bare name is
 * looked up with `which` (PATH by default, which is what the spawn does).
 */
export function findHelper(
  configured: readonly string[],
  which: (name: string) => string | null = (name) => Bun.which(name),
  o: { dir?: string; exists?: (path: string) => boolean; name?: string } = {},
): HelperFound {
  const loc = locateHelper(configured, o);
  const program = loc.command[0] as string;
  const found = isAbsolute(program)
    ? (o.exists ?? existsSync)(program)
      ? program
      : null
    : which(program);
  return { ...loc, found };
}

/** Launch arguments for `akou-capture run` (DESIGN 2.4). */
export function helperArgs(opts: CaptureStartOptions): string[] {
  const args = ["run", "--out", opts.out, "--mic", opts.mic, "--call", opts.call];
  if (opts.excludeResponsible) args.push("--exclude-responsible", opts.excludeResponsible);
  return args;
}

export class AkouCaptureEngine implements CaptureEngine {
  readonly name = "akou-capture";
  constructor(private readonly o: HelperEngineOptions) {}

  start(opts: CaptureStartOptions, handlers: CaptureHandlers): CaptureSession {
    const argv = [...this.o.command, ...helperArgs(opts), ...(this.o.extraArgs?.(opts) ?? [])];
    return new ChildCaptureSession(
      { argv, env: this.o.env, logPath: opts.logPath, clock: this.o.clock },
      handlers,
      akouCaptureDialect,
    );
  }
}
