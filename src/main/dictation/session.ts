/**
 * The dictation session on the app's side (docs/ux/DICTATION.md sections 4 and 9): the state
 * machine over what the helper reports. The helper owns the keys and the audio; this owns what a
 * session becomes: the decode, the log, and the text sent back to insert.
 *
 * One session at a time: `ready` → `idle`; `session.started` → `listening` (the audio packets are
 * kept); `session.ended` → `transcribing` (the buffer goes to the engine) → `inserting` (the text
 * goes back as `insert`) → `idle` on `inserted` or `insert.failed`. An `interrupt` (the dictation
 * key was a shortcut, DC-A1) keeps nothing: no event, no audio. A `cancel` keeps the dictation as
 * `cancelled` with no text.
 *
 * Nothing is written for a session until it ends, so an interrupted press leaves no trace.
 */

import type { DictationDraft, Target } from "../../core/dictation/events.ts";
import type { Decoded } from "../asr/live-worker.ts";
import type { Packet } from "../capture/protocol.ts";
import type { AppToHelper, Bindings, EndReason, HelperToApp } from "./protocol.ts";
import { type DictationLog, newDictationId } from "./store.ts";

/** Decodes a dictation's buffer: the live Worker (`fast`) today, `best` and `remote` later. */
export interface DictationEngine {
  /** What the log records as the engine: `fast`, `best`, `remote`. */
  readonly name: string;
  decode(samples: Float32Array, o: { language?: string }): Promise<Decoded>;
}

export type SessionState = "starting" | "idle" | "listening" | "transcribing" | "inserting";

export interface SessionOptions {
  log: DictationLog;
  /** The engine now, or null when none is loaded (the models are missing). */
  engine(): DictationEngine | null;
  send(c: AppToHelper): void;
  bindings(): Bindings;
  now(): number;
  onState?(state: SessionState): void;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
}

interface Listening {
  helperId: string;
  target: Target;
  chunks: Float32Array[];
  samples: number;
  /** Set by `session.ended`: the reason, and the samples the helper says it sent. */
  end: { reason: EndReason; samples: number; timer: ReturnType<typeof setTimeout> } | null;
}

/**
 * How long a session that ended waits for audio still in the stdout pipe, past which it is
 * transcribed with what arrived and the log says so.
 */
export const LATE_AUDIO_MS = 2000;

export class DictationSession {
  state: SessionState = "starting";
  ready: Extract<HelperToApp, { type: "ready" }> | null = null;
  private cur: Listening | null = null;
  /** Dictations waiting for their insert's result, by the helper's session id. */
  private readonly inserts = new Map<string, string>();
  /** Every decode and insert in flight, for tests and a clean stop. */
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly o: SessionOptions) {}

  private set(state: SessionState): void {
    if (state === this.state) return;
    this.state = state;
    this.o.onState?.(state);
  }

  private write(d: DictationDraft): void {
    try {
      this.o.log.append(d);
    } catch (err) {
      this.o.onLog?.("error", `dictation log: ${(err as Error).message}`);
    }
  }

  /** Sends the bindings again, once the helper is ready. */
  rebind(): void {
    if (this.ready) this.o.send({ type: "rebind", ...this.o.bindings() });
  }

  /** Resolves once every decode and insert started so far has settled. */
  settled(): Promise<void> {
    return this.work;
  }

  onMessage(m: HelperToApp): void {
    switch (m.type) {
      case "ready":
        this.ready = m;
        this.set("idle");
        this.o.send({ type: "rebind", ...this.o.bindings() });
        return;
      case "bind.failed":
        this.o.onLog?.("warn", `dictation key ${m.hotkey} not bound: ${m.reason}`);
        return;
      case "session.started":
        this.cur = { helperId: m.id, target: m.target, chunks: [], samples: 0, end: null };
        this.set("listening");
        return;
      case "session.ended": {
        const c = this.cur;
        if (!c || c.helperId !== m.id || c.end) return;
        const timer = setTimeout(() => {
          this.o.onLog?.(
            "warn",
            `dictation: ${c.samples} of ${m.samples} samples arrived; transcribing what did`,
          );
          this.ended(c);
        }, LATE_AUDIO_MS);
        c.end = { reason: m.reason, samples: m.samples, timer };
        if (c.samples >= m.samples) this.ended(c);
        return;
      }
      case "inserted": {
        const id = this.inserts.get(m.id);
        if (!id) return;
        this.inserts.delete(m.id);
        this.write({
          type: "dictation.inserted",
          id,
          method: m.method,
          receipt_ms: m.receipt_ms,
        });
        if (this.inserts.size === 0 && this.state === "inserting") this.set("idle");
        return;
      }
      case "insert.failed": {
        const id = this.inserts.get(m.id);
        if (!id) return;
        this.inserts.delete(m.id);
        this.write({ type: "dictation.failed", id, error: `insert: ${m.reason}` });
        if (this.inserts.size === 0 && this.state === "inserting") this.set("idle");
        return;
      }
      default:
        // level, key, grant.lost, edit, edit.unreadable, secure_input, bound: the pill's and
        // learning's, in later items.
        return;
    }
  }

  /** An `AKP1` packet from the helper's stdout: a session's audio, mic channel. */
  onPacket(p: Packet): void {
    const c = this.cur;
    if (!c || p.ch !== "mic") return;
    c.chunks.push(p.samples);
    c.samples += p.samples.length;
    if (c.end && c.samples >= c.end.samples) this.ended(c);
  }

  /** The helper exited: a session in progress is lost with it, and says so. */
  helperGone(): void {
    const c = this.cur;
    this.cur = null;
    if (c?.end) clearTimeout(c.end.timer);
    if (c) {
      const id = newDictationId(this.o.now());
      this.write({ type: "dictation.started", id, target: c.target, engine: "auto", by: "user" });
      this.write({ type: "dictation.failed", id, error: "the dictation helper stopped" });
    }
    for (const id of this.inserts.values()) {
      this.write({ type: "dictation.failed", id, error: "the dictation helper stopped" });
    }
    this.inserts.clear();
    this.ready = null;
    this.set("starting");
  }

  private ended(c: Listening): void {
    if (this.cur !== c || !c.end) return;
    this.cur = null;
    clearTimeout(c.end.timer);
    const reason = c.end.reason;
    if (reason === "interrupt") {
      this.set("idle");
      return;
    }
    const id = newDictationId(this.o.now());
    const engine = this.o.engine();
    const seconds = Math.round((c.samples / 16000) * 1000) / 1000;
    this.write({
      type: "dictation.started",
      id,
      target: c.target,
      engine: engine?.name ?? "fast",
      by: "user",
    });
    this.write({ type: "dictation.ended", id, reason, seconds });
    if (reason === "cancel") {
      this.write({ type: "dictation.cancelled", id });
      this.set("idle");
      return;
    }
    this.set("transcribing");
    const samples = concat(c.chunks, c.samples);
    this.work = this.work.then(() => this.transcribe(id, c.helperId, c.target, samples, engine));
  }

  private async transcribe(
    id: string,
    helperId: string,
    target: Target,
    samples: Float32Array,
    engine: DictationEngine | null,
  ): Promise<void> {
    if (!engine) {
      this.write({ type: "dictation.failed", id, error: "no speech model is loaded" });
      this.set("idle");
      return;
    }
    let d: Decoded;
    try {
      d = await engine.decode(samples, {});
    } catch (err) {
      this.write({ type: "dictation.failed", id, error: (err as Error).message });
      this.set("idle");
      return;
    }
    if (d.text === "") {
      this.write({ type: "dictation.empty", id });
      this.set("idle");
      return;
    }
    this.write({
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
    this.inserts.set(helperId, id);
    this.set("inserting");
    this.o.send({
      type: "insert",
      id: helperId,
      text: d.text,
      // Nothing is ever pasted or typed into a password field (DC-N8): the clipboard only.
      method: target.field === "secure" ? "clipboard" : "paste",
      send_key: "none",
      target,
    });
  }
}

function concat(chunks: readonly Float32Array[], n: number): Float32Array {
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
