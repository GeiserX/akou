/**
 * The llama-server runtime (docs/research/asr-architecture.md section 2.3, ASR-5): llama.cpp's HTTP
 * server as a child process that runs Qwen3-ASR.
 *
 * - **Which build.** `asr.accelerator` picks one of the pinned builds of `llama-catalog.ts` for this
 *   platform: `auto` is Metal on Apple silicon and the CPU elsewhere (hardware detection is SV-R2);
 *   `vulkan` runs on Intel and AMD GPUs through Mesa, `cuda` on NVIDIA. An accelerator with no
 *   build for the platform falls back to the CPU, and the caller logs why. `asr.llamaServer` names
 *   an own llama-server instead (a SYCL or ROCm build compiled on the host).
 * - **The download is an archive**, verified like every model file, then unpacked once beside
 *   itself into `bin/` (`extractBuild`); a marker file records which archives it came from.
 * - **The supervisor** (`LlamaServer`) starts it on a free loopback port with `--cache-ram 0` (its
 *   default prompt cache grows with every request until the machine runs out of memory), waits for
 *   `GET /health`, and starts it again when it has exited. The engine asks for a restart when a
 *   request finds the connection dropped or gets a 500, which is how a Metal out-of-memory shows.
 * - **One Metal engine at a time.** Two Metal engines together ran out of GPU memory and left a
 *   llama-server that answered 500 until it was restarted. Starting a Metal server stops any other
 *   Metal server this thread started, and, through a pid file in `lockDir`, one another thread or a
 *   crashed akou left running.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, join } from "node:path";
import type { LlamaEngineSpec } from "./engine.ts";
import { llamaBuildId } from "./llama-catalog.ts";
import { type Accelerator, type CatalogEntry, MODELS } from "./models.ts";
import { QwenEngine } from "./qwen.ts";

/** The catalog's build for a platform and accelerator, if llama.cpp publishes one. */
export function llamaBuild(
  platform: string,
  accelerator: string,
  catalog: readonly CatalogEntry[] = MODELS,
): CatalogEntry | undefined {
  return catalog.find((m) => m.id === llamaBuildId(platform, accelerator));
}

/** `asr.accelerator` on this platform: the build that runs, and why it is not the one asked for. */
export function resolveAccelerator(
  setting: string,
  platform: string,
  catalog: readonly CatalogEntry[] = MODELS,
): { accelerator: Accelerator; note?: string } {
  if (setting === "auto") {
    return { accelerator: llamaBuild(platform, "metal", catalog) ? "metal" : "cpu" };
  }
  if (llamaBuild(platform, setting, catalog)) return { accelerator: setting as Accelerator };
  return {
    accelerator: "cpu",
    note: `asr.accelerator is ${setting}, but there is no ${setting} build of llama-server for ${platform}; Qwen runs on the CPU`,
  };
}

/**
 * The llama-server build this machine's settings run Qwen on, or null when `asr.llamaServer` names
 * an own one (or the catalog has no build here).
 */
export function llamaRuntime(
  settings: { readonly "asr.accelerator": string; readonly "asr.llamaServer": readonly string[] },
  platform: string,
  catalog: readonly CatalogEntry[] = MODELS,
): string | null {
  if (settings["asr.llamaServer"].length > 0) return null;
  const { accelerator } = resolveAccelerator(settings["asr.accelerator"], platform, catalog);
  return llamaBuild(platform, accelerator, catalog)?.id ?? null;
}

const MARKER = ".unpacked";

function binaryName(platform: string): string {
  return platform.startsWith("win32") ? "llama-server.exe" : "llama-server";
}

function findFile(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Unpacks a build's archives into `<dir>/bin` once and returns the llama-server path. The marker
 * holds each archive's name, size and modification time; a verified archive replaced by a new one
 * is unpacked again. `tar` reads `.tar.gz` everywhere and `.zip` through Windows' own bsdtar.
 */
export function extractBuild(dir: string, archives: readonly string[], platform: string): string {
  const bin = join(dir, "bin");
  const stamp = JSON.stringify(
    archives.map((a) => {
      const st = statSync(a);
      return [basename(a), st.size, st.mtimeMs];
    }),
  );
  const name = binaryName(platform);
  if (existsSync(join(bin, MARKER)) && readFileSync(join(bin, MARKER), "utf8") === stamp) {
    const found = findFile(bin, name);
    if (found) return found;
  }
  const tmp = join(dir, `bin.${process.pid}.${Date.now()}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    for (const a of archives) {
      const r = spawnSync("tar", ["-xf", a, "-C", tmp], { encoding: "utf8" });
      if (r.status !== 0) {
        throw new Error(`cannot unpack ${basename(a)}: ${(r.stderr || r.error?.message) ?? ""}`);
      }
    }
    if (!findFile(tmp, name)) {
      throw new Error(
        `no ${name.replace(/\.exe$/, "")} in ${archives.map((a) => basename(a)).join(", ")}`,
      );
    }
    writeFileSync(join(tmp, MARKER), stamp);
    rmSync(bin, { recursive: true, force: true });
    renameSync(tmp, bin);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const found = findFile(bin, name) as string;
  if (!platform.startsWith("win32")) chmodSync(found, 0o755);
  return found;
}

export interface LlamaServerOptions {
  /** The program and any arguments of its own, or a function that makes it (unpacking a build). */
  command: readonly string[] | (() => readonly string[]);
  /** The GGUF model and its multimodal projector. */
  model: string;
  mmproj: string;
  accelerator: Accelerator;
  /** CPU threads; llama-server's own default when unset. */
  threads?: number;
  /** Layers on the GPU; default every one on a GPU build and none on a CPU build. */
  gpuLayers?: number;
  /** Where the Metal pid file lives (the build's folder). */
  lockDir?: string;
  /** How long the model may take to load before the start fails. Default 5 minutes. */
  healthTimeoutMs?: number;
  /** Told of every process started (`true`) and ended (`false`), so a host can kill orphans. */
  onChild?(pid: number, alive: boolean): void;
  log?(level: "info" | "warn" | "error", msg: string): void;
}

/** The arguments llama-server starts with: loopback only, no prompt cache, one slot, no web UI. */
export function llamaArgs(
  o: Pick<LlamaServerOptions, "model" | "mmproj" | "accelerator" | "threads" | "gpuLayers"> & {
    command: readonly string[];
  },
  port: number,
): string[] {
  return [
    ...o.command,
    "-m",
    o.model,
    "--mmproj",
    o.mmproj,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--cache-ram",
    "0",
    "-c",
    "4096",
    "-np",
    "1",
    "--no-webui",
    "--offline",
    // Every layer on the GPU when the build has one; a CPU build must not look for one.
    "-ngl",
    String(o.gpuLayers ?? (o.accelerator === "cpu" ? 0 : 999)),
    ...(o.threads ? ["-t", String(o.threads)] : []),
  ];
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    // clock: polling a process we signalled, bounded by `ms`.
    await Bun.sleep(50);
  }
  return !alive(pid);
}

const METAL_PID_FILE = "llama-metal.json";

/** Metal servers this thread runs; a new one stops the others first. */
const metalServers = new Set<LlamaServer>();

export class LlamaServer {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private port = 0;
  private starting: Promise<string> | null = null;
  private ended: Promise<void> | null = null;
  private stderr: string[] = [];
  /** Processes started so far, restarts included. */
  starts = 0;

  constructor(private readonly o: LlamaServerOptions) {}

  pid(): number | null {
    return this.proc?.pid ?? null;
  }

  private base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The server's address once it answers its health check, starting it when it is not running. */
  async url(): Promise<string> {
    if (this.starting) return await this.starting;
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
      return this.base();
    }
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return await this.starting;
  }

  /** Stops the process and starts a fresh one. */
  async restart(): Promise<string> {
    if (this.starting) await this.starting.catch(() => {});
    await this.stop();
    return await this.url();
  }

  private async start(): Promise<string> {
    if (this.o.accelerator === "metal") await this.takeMetal();
    const command = typeof this.o.command === "function" ? this.o.command() : this.o.command;
    this.port = await freePort();
    const args = llamaArgs({ ...this.o, command }, this.port);
    this.stderr = [];
    const proc = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    this.proc = proc;
    this.starts++;
    const pid = proc.pid;
    this.o.onChild?.(pid, true);
    void this.drain(proc.stderr as ReadableStream<Uint8Array>);
    this.ended = proc.exited.then((code) => {
      this.o.onChild?.(pid, false);
      if (this.proc === proc) this.proc = null;
      metalServers.delete(this);
      this.o.log?.("warn", `llama-server ${pid} exited with ${code}`);
    });
    if (this.o.accelerator === "metal") {
      metalServers.add(this);
      if (this.o.lockDir) {
        mkdirSync(this.o.lockDir, { recursive: true });
        writeFileSync(
          join(this.o.lockDir, METAL_PID_FILE),
          JSON.stringify({ pid, port: this.port }),
        );
      }
    }
    const deadline = Date.now() + (this.o.healthTimeoutMs ?? 300_000);
    for (;;) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        await this.ended;
        throw new Error(
          `llama-server exited with ${proc.exitCode ?? proc.signalCode} before it was ready: ${this.stderr.slice(-5).join(" | ")}`,
        );
      }
      try {
        const r = await fetch(`${this.base()}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error(
          `llama-server did not load its model within ${this.o.healthTimeoutMs ?? 300_000} ms`,
        );
      }
      // clock: the health check's poll while the model loads, bounded by the deadline.
      await Bun.sleep(100);
    }
    this.o.log?.("info", `llama-server ${pid} ready on port ${this.port} (${this.o.accelerator})`);
    return this.base();
  }

  /** Keeps the last lines of stderr for the error a failed start reports. */
  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const dec = new TextDecoder();
    let rest = "";
    try {
      for await (const chunk of stream) {
        const lines = (rest + dec.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) this.stderr.push(l.trim());
        if (this.stderr.length > 50) this.stderr.splice(0, this.stderr.length - 50);
      }
    } catch {
      // The process went away.
    }
  }

  /** Stops every other Metal server: this thread's, then one a pid file names. */
  private async takeMetal(): Promise<void> {
    for (const other of [...metalServers]) if (other !== this) await other.stop();
    const dir = this.o.lockDir;
    if (!dir || process.platform === "win32") return;
    const file = join(dir, METAL_PID_FILE);
    let held: { pid?: number; port?: number } = {};
    try {
      held = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return;
    }
    const pid = held.pid;
    if (!pid || pid === this.pid() || !alive(pid)) return;
    // Only a llama-server on the port the file records: a reused pid is someone else's process.
    const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    if (!(r.stdout ?? "").includes(`--port ${held.port}`)) return;
    this.o.log?.("info", `stopping llama-server ${pid}: one Metal engine at a time`);
    process.kill(pid, "SIGTERM");
    if (!(await waitGone(pid, 5000))) process.kill(pid, "SIGKILL");
  }

  /** Stops the process, if one runs. */
  async stop(): Promise<void> {
    const proc = this.proc;
    const ended = this.ended;
    if (!proc) return;
    proc.kill("SIGTERM");
    const gone = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!gone) proc.kill("SIGKILL");
    await ended;
    if (this.o.lockDir && this.o.accelerator === "metal") {
      const file = join(this.o.lockDir, METAL_PID_FILE);
      try {
        if (JSON.parse(readFileSync(file, "utf8")).pid === proc.pid) rmSync(file, { force: true });
      } catch {}
    }
  }
}

/**
 * The engine a `LlamaEngineSpec` names, over its own supervised server. The process starts on the
 * first decode (or `load`) and stops on `unload`.
 */
export function createLlamaEngine(
  spec: LlamaEngineSpec,
  hooks: Pick<LlamaServerOptions, "onChild" | "log"> = {},
): QwenEngine {
  const build = spec.build;
  if (!spec.command && !build) throw new Error(`${spec.engine}: no llama-server to run`);
  const server = new LlamaServer({
    command:
      spec.command ??
      (() => [extractBuild(build?.dir as string, build?.archives ?? [], build?.platform ?? "")]),
    model: spec.model,
    mmproj: spec.mmproj,
    accelerator: spec.accelerator,
    threads: spec.threads,
    gpuLayers: spec.gpuLayers,
    lockDir: build?.dir,
    ...hooks,
  });
  return new QwenEngine({ id: spec.engine, server, allowed: spec.languages, log: hooks.log });
}
