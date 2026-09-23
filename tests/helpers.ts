import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventDraft, LogEvent, Seg } from "../src/core/log/events.ts";

/** 2026-09-23 20:36:12 UTC, 15:36:12 in America/Chicago. */
export const T0 = Date.UTC(2026, 8, 23, 20, 36, 12);
export const TZ = "America/Chicago";

/** Builds a valid log in memory: seq is assigned in order, t advances by 1 ms per event. */
export class LogBuilder {
  readonly events: LogEvent[] = [];
  private t = T0;

  add(draft: EventDraft, at?: number): LogEvent {
    if (at !== undefined) this.t = at;
    else this.t += 1;
    const e = { seq: this.events.length + 1, t: this.t, ...draft } as LogEvent;
    this.events.push(e);
    return e;
  }

  created(extra: Partial<Extract<EventDraft, { type: "call.created" }>> = {}): LogEvent {
    return this.add({
      type: "call.created",
      id: "01J8Z6Q4M2VX0K7B3D4E5F6G7H",
      schema: 1,
      workspace: "work",
      title: "Weekly sync",
      tz: TZ,
      user: "Ana",
      akou: "0.1.0",
      ...extra,
    });
  }

  partStarted(part: number, wallStart: number, monoStart = 1_000_000 + part * 10_000): LogEvent {
    return this.add({
      type: "part.started",
      part,
      file: `audio/part-${String(part).padStart(3, "0")}.opus`,
      wallStart,
      monoStart,
      mic: "Built-in Microphone",
      call: { mode: "system", exclude: ["akou Graphics and Media"] },
      capture: "akou-capture 0.1.0",
    });
  }

  partEnded(
    part: number,
    reason: Extract<EventDraft, { type: "part.ended" }>["reason"],
    fileSeconds = 60,
  ): LogEvent {
    return this.add({ type: "part.ended", part, reason, fileSeconds });
  }

  seg(s: Partial<Omit<Seg, "seq" | "t" | "type">> & { id: string; text: string | null }): LogEvent {
    const w0 = s.w0 ?? T0;
    return this.add({
      type: "seg",
      rev: 1,
      layer: s.id.startsWith("f") ? "final" : "live",
      part: 1,
      ch: "call",
      spk: "c1",
      a0: 0,
      a1: 1,
      w1: w0 + 1000,
      model: "parakeet-tdt-0.6b-v3-int8",
      ...s,
      w0,
    });
  }
}

export function tempDir(prefix = "akou-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A tiny English dictionary for the read-time rules. */
export const DICTIONARY = new Set([
  "the",
  "we",
  "should",
  "move",
  "build",
  "to",
  "new",
  "box",
  "vessel",
  "cluster",
  "deploy",
  "on",
  "is",
  "a",
  "and",
  "said",
  "that",
  "call",
  "marry",
  "mary",
  "linear",
  "clouds",
  "carry",
  "cable",
  "ira",
  "container",
  "containers",
  "running",
  "harbour",
  "sale",
  "for",
  "sell",
  "cuber",
]);

export const isDictionaryWord = (w: string): boolean => DICTIONARY.has(w);

export function jsonl(events: readonly unknown[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join("");
}
