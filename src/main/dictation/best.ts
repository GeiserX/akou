/**
 * The `best` dictation engine (docs/ux/DICTATION.md DC-E2): Qwen3-ASR on a llama-server kept warm
 * for dictation, with an exit to `fast` like the remote's (DC-R3).
 *
 * - **Warm.** `warm()` starts the server when `dictation.engine` resolves to `best` and dictation
 *   is on, so the first press does not pay a cold start; it stays up until `stop()`, or until
 *   `asr.qwenIdleMinutes` pass with no dictation (0: never). A dictation while it is starting keeps
 *   its audio and is decoded once health answers.
 * - **One request per dictation**, greedy, with no context: learned words reach the recognizer
 *   only through DC-L7's measured gate, which is not built.
 * - **The exit.** A request that fails (the server died, ran out of memory, never got healthy) or
 *   takes longer than `dictation.localTimeoutSeconds` plus 0.2 s per second of audio is decoded
 *   with `fast`; the item records `fallback_from: best` and the pill says `best failed, used fast`.
 *   The timeout starts once the server is healthy, so a first dictation that waited for the load is
 *   not cut short by it.
 * - **Language (DC-E4).** A forced tag goes to Qwen as its language prefix; on `auto` the answer is
 *   bounded by the dictation's languages (`dictation.languages`, else `asr.languages`).
 * - **One Metal engine at a time.** The server gives way to a Metal llama-server already running (a
 *   call's final pass) instead of stopping it: the dictation falls back to `fast` meanwhile.
 */

import type { LlamaEngineSpec } from "../asr/engine.ts";
import { ASR_RATE } from "../asr/engine.ts";
import { createLlamaServer, type LlamaServer } from "../asr/llama-server.ts";
import { QwenEngine } from "../asr/qwen.ts";
import type { Clock } from "../capture/engine.ts";
import type { DictationEngine, EngineDecoded } from "./session.ts";

/** What each second of audio adds to a local `best` dictation's timeout. */
export const BEST_SECONDS_PER_AUDIO_SECOND = 0.2;

/** The server `BestEngine` runs: `LlamaServer`'s surface it uses. */
export type BestServer = Pick<LlamaServer, "url" | "restart" | "stop" | "pid">;

export interface BestSettings {
  /** `dictation.localTimeoutSeconds`. */
  timeoutSeconds: number;
  /** `asr.qwenIdleMinutes`; 0 keeps the server up. */
  idleMinutes: number;
  /** The languages an `auto` dictation may choose among; empty for any. */
  languages: readonly string[];
}

export interface BestEngineOptions {
  /** Qwen's llama-server as the settings name it now, or null when it cannot run here. */
  spec(): LlamaEngineSpec | null;
  /** The engine a failed `best` falls back to, or null when none is loaded. */
  fast(): DictationEngine | null;
  settings(): BestSettings;
  /** Whether the server stays up between dictations (dictation is on); else it stops after each. */
  keepWarm?(): boolean;
  clock: Pick<Clock, "setTimeout" | "clearTimeout">;
  /** Makes the server; the supervised llama-server by default. */
  server?(spec: LlamaEngineSpec): BestServer;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
}

/** A `best` decode that did not finish within its budget. */
class BestTimeout extends Error {
  override name = "BestTimeout";
}

export class BestEngine implements DictationEngine {
  readonly name = "best";
  private server: BestServer | null = null;
  /** The spec the running server was made from: a changed one makes a new server. */
  private made = "";
  private idle: unknown = null;
  private busy = 0;
  private starting = false;

  constructor(private readonly o: BestEngineOptions) {}

  /** Whether the server is loading its model now (the pill's `loading model`). */
  loading(): boolean {
    return this.starting;
  }

  /** The running server's process id, or null while none runs. */
  pid(): number | null {
    return this.server?.pid() ?? null;
  }

  /** Starts the server now, so the next dictation finds it warm. A failure is only logged. */
  warm(): void {
    let server: BestServer;
    try {
      server = this.ensure();
    } catch (err) {
      this.o.onLog?.("warn", `dictation best: ${(err as Error).message}`);
      return;
    }
    void this.health(server).then(
      () => this.armIdle(),
      (err: Error) => this.o.onLog?.("warn", `dictation best did not start: ${err.message}`),
    );
  }

  async decode(samples: Float32Array, d: { language?: string } = {}): Promise<EngineDecoded> {
    this.busy++;
    this.disarmIdle();
    try {
      return await this.qwen(samples, d.language);
    } catch (err) {
      const fast = this.o.fast();
      if (!fast) throw err;
      this.o.onLog?.("warn", `dictation: best failed (${(err as Error).message}); using fast`);
      const l = await fast.decode(samples, {});
      return { ...l, engine: fast.name, fallback_from: "best", notice: "best failed, used fast" };
    } finally {
      this.busy--;
      this.armIdle();
    }
  }

  /** Stops the server; the next `warm` or dictation starts it again. */
  async stop(): Promise<void> {
    this.disarmIdle();
    const server = this.server;
    this.server = null;
    this.made = "";
    await server?.stop();
  }

  private ensure(): BestServer {
    const spec = this.o.spec();
    if (!spec) throw new Error("Qwen3-ASR cannot run here: its model or llama-server is missing");
    const key = JSON.stringify(spec);
    if (this.server && this.made === key) return this.server;
    const old = this.server;
    if (old) void old.stop();
    this.server =
      this.o.server?.(spec) ??
      createLlamaServer(spec, {
        yieldMetal: true,
        log: (level, msg) => this.o.onLog?.(level, `dictation best: ${msg}`),
      });
    this.made = key;
    return this.server;
  }

  private async health(server: BestServer): Promise<void> {
    this.starting = true;
    try {
      await server.url();
    } finally {
      this.starting = false;
    }
  }

  private async qwen(samples: Float32Array, language: string | undefined): Promise<EngineDecoded> {
    const server = this.ensure();
    const id = (this.o.spec() as LlamaEngineSpec).engine;
    // The load is waited for; the budget is the decode's own.
    await this.health(server);
    const s = this.o.settings();
    const budgetMs =
      (s.timeoutSeconds + (samples.length / ASR_RATE) * BEST_SECONDS_PER_AUDIO_SECOND) * 1000;
    // Once the budget is spent, the request is abandoned: Qwen's own retry must not start the
    // server again behind the fallback's back.
    let abandoned = false;
    const gone = () => Promise.reject(new Error("the dictation fell back to fast"));
    const engine = new QwenEngine({
      id,
      server: {
        url: () => (abandoned ? gone() : server.url()),
        restart: () => (abandoned ? gone() : server.restart()),
      },
      allowed: s.languages,
      timeoutMs: budgetMs,
      log: (level, msg) => this.o.onLog?.(level, `dictation best: ${msg}`),
    });
    let timer: unknown = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = this.o.clock.setTimeout(
        () => reject(new BestTimeout(`no answer within ${Math.round(budgetMs) / 1000} s`)),
        budgetMs,
      );
    });
    try {
      const h = await Promise.race([
        engine.decode({ samples, lang: language ?? "auto", glossary: [] }),
        deadline,
      ]);
      return {
        text: h.text,
        // Qwen gives no word times, so a `best` dictation carries no words, as a remote one.
        words: [],
        language: h.lang ?? null,
        model: id,
        ms: Math.round(h.ms),
        spans: 1,
        engine: "best",
      };
    } catch (err) {
      if (err instanceof BestTimeout) {
        // A server past its budget is stuck, and it takes one request at a time: the next
        // dictation starts a fresh one.
        abandoned = true;
        if (this.server === server) void this.stop();
      }
      throw err;
    } finally {
      this.o.clock.clearTimeout(timer);
    }
  }

  private armIdle(): void {
    this.disarmIdle();
    if (this.busy > 0 || !this.server) return;
    if (this.o.keepWarm && !this.o.keepWarm()) {
      void this.stop();
      return;
    }
    const minutes = this.o.settings().idleMinutes;
    if (minutes <= 0) return;
    this.idle = this.o.clock.setTimeout(() => {
      this.idle = null;
      if (this.busy > 0) return;
      this.o.onLog?.("info", `dictation best: idle for ${minutes} min, its server stopped`);
      void this.stop();
    }, minutes * 60_000);
  }

  private disarmIdle(): void {
    if (this.idle !== null) this.o.clock.clearTimeout(this.idle);
    this.idle = null;
  }
}
