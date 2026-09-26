/**
 * Dictation in the app (docs/ux/DICTATION.md): the log, the engine, and the helper's `dictate`
 * process with the session over it. `dictation.enabled` is the master switch (DC-A1): off, no
 * helper process runs and no key is taken; on, `akou-capture dictate` is started and bound.
 *
 * `POST /v1/dictations` goes through `transcribeClip`: the same engine and the same log as a
 * spoken dictation, with no helper, no key and no insert.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DictationItem } from "../../core/dictation/events.ts";
import { realClock, withDeadline } from "../capture/engine.ts";
import { LineSplitter, PacketDecoder } from "../capture/protocol.ts";
import { type Bindings, encodeCommand, parseHelperLine } from "./protocol.ts";
import { type DictationEngine, DictationSession, type SessionState } from "./session.ts";
import { DICTATION_DIR, DictationLog, newDictationId } from "./store.ts";

/** How long `stop` waits for the helper to exit before it is killed. */
const STOP_MS = 2000;

export interface DictationServiceOptions {
  /** The config folder: the log is `dictation/events.jsonl` in it. */
  configDir: string;
  engine(): DictationEngine | null;
  now(): number;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
}

export interface DictationStatus {
  enabled: boolean;
  /** `off` with dictation disabled or the helper gone, else the session's state. */
  state: "off" | SessionState;
  engine: string | null;
  grants: { mic: boolean; accessibility: boolean } | null;
  backend: string | null;
}

interface Helper {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  session: DictationSession;
  exited: Promise<void>;
}

export class DictationService {
  readonly log: DictationLog;
  private helper: Helper | null = null;

  /** Where `POST /v1/dictations` spools a clip while it is decoded; emptied at every start. */
  readonly uploadDir: string;

  constructor(private readonly o: DictationServiceOptions) {
    this.log = new DictationLog(join(o.configDir, DICTATION_DIR), o.now);
    this.uploadDir = join(o.configDir, DICTATION_DIR, "uploads");
    // A clip left by a crash mid-decode: akou keeps no copy of an upload.
    rmSync(this.uploadDir, { recursive: true, force: true });
    mkdirSync(this.uploadDir, { recursive: true, mode: 0o700 });
    const r = this.log.report;
    if (r.truncated > 0)
      o.onLog?.("warn", `dictation log: a torn last line was cut (${r.truncated} bytes)`);
    if (r.invalidLines > 0) o.onLog?.("warn", `dictation log: ${r.invalidLines} bad lines skipped`);
  }

  /** The session over the running helper, or null with dictation off. */
  session(): DictationSession | null {
    return this.helper?.session ?? null;
  }

  status(): DictationStatus {
    const s = this.helper?.session;
    return {
      enabled: this.helper !== null,
      state: s ? s.state : "off",
      engine: this.o.engine()?.name ?? null,
      grants: s?.ready?.grants ?? null,
      backend: s?.ready?.backend ?? null,
    };
  }

  /**
   * Starts `argv` (the helper's program and its `dictate` subcommand) and binds the keys once it
   * is ready. A second start while one runs does nothing.
   */
  start(argv: readonly string[], bindings: () => Bindings): void {
    if (this.helper) return;
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      this.o.onLog?.("error", `dictation helper did not start: ${(err as Error).message}`);
      return;
    }
    const session = new DictationSession({
      log: this.log,
      engine: this.o.engine,
      bindings,
      now: this.o.now,
      send: (c) => {
        try {
          proc.stdin.write(encodeCommand(c));
          proc.stdin.flush();
        } catch {
          // The helper is gone; its exit is reported below.
        }
      },
      onLog: this.o.onLog,
    });
    const out = (async () => {
      const dec = new PacketDecoder();
      try {
        for await (const chunk of proc.stdout) for (const p of dec.push(chunk)) session.onPacket(p);
      } catch (err) {
        this.o.onLog?.("error", `dictation helper audio: ${(err as Error).message}`);
        proc.kill("SIGKILL");
      }
    })();
    const err = (async () => {
      const lines = new LineSplitter();
      const handle = (line: string) => {
        const m = parseHelperLine(line);
        if (m.kind === "msg") session.onMessage(m.msg);
        else this.o.onLog?.("info", `dictation helper: ${m.line}`);
      };
      try {
        for await (const chunk of proc.stderr) for (const l of lines.push(chunk)) handle(l);
        for (const l of lines.flush()) handle(l);
      } catch {
        // The pipe broke because the helper died; the exit is reported below.
      }
    })();
    const h: Helper = { proc, session, exited: Promise.resolve() };
    h.exited = (async () => {
      await proc.exited;
      await Promise.all([out, err]);
      session.helperGone();
      if (this.helper === h) {
        this.helper = null;
        this.o.onLog?.("warn", `dictation helper exited (code ${proc.exitCode})`);
      }
    })();
    this.helper = h;
  }

  /** Sends the running helper the keys again (a setting changed, DC-A7). */
  rebind(): void {
    this.helper?.session.rebind();
  }

  /** Stops the helper: `stop`, then a kill if it has not exited within 2 s. */
  async stop(): Promise<void> {
    const h = this.helper;
    if (!h) return;
    this.helper = null;
    try {
      h.proc.stdin.write(encodeCommand({ type: "stop" }));
      h.proc.stdin.end();
    } catch {
      // Already gone.
    }
    const r = await withDeadline(realClock, h.exited, STOP_MS);
    if (!r.ok) {
      h.proc.kill("SIGKILL");
      await h.exited;
    }
  }

  /**
   * One clip through the dictation path with no key and no insert (`POST /v1/dictations`): the
   * same engine and the same log as a spoken dictation.
   */
  async transcribeClip(
    samples: Float32Array,
    o: { by: string; language?: string },
  ): Promise<DictationItem> {
    const engine = this.o.engine();
    const id = newDictationId(this.o.now());
    const seconds = Math.round((samples.length / 16000) * 1000) / 1000;
    this.log.append({
      type: "dictation.started",
      id,
      target: null,
      engine: engine?.name ?? "fast",
      by: o.by,
    });
    this.log.append({ type: "dictation.ended", id, reason: "clip", seconds });
    if (!engine) {
      this.log.append({ type: "dictation.failed", id, error: "no speech model is loaded" });
    } else {
      try {
        const d = await engine.decode(samples, { language: o.language });
        if (d.text === "") this.log.append({ type: "dictation.empty", id });
        else
          this.log.append({
            type: "dictation.text",
            id,
            raw: d.text,
            text: d.text,
            language: d.language,
            words: d.words,
            engine: engine.name,
            model: d.model,
            ms: d.ms,
          });
      } catch (err) {
        this.log.append({ type: "dictation.failed", id, error: (err as Error).message });
      }
    }
    return this.log.item(id) as DictationItem;
  }

  async close(): Promise<void> {
    await this.stop();
    this.log.close();
  }
}
