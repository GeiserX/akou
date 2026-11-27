/**
 * What the user forgot or renamed, kept beside the voices file in `voices.yaml.tombstones`, so a
 * name given before the forget or the rename never teaches back what it removed [VO-12].
 *
 * - **One line per tombstone**, JSON: `{kind: "forget", all: true, at}`, `{kind: "forget", name?,
 *   call?, at}` or `{kind: "rename", from, to, at}`. `at` is the wall time (ms) when the user asked
 *   for it. Names and call ids only, never a voiceprint. Mode 0600; each write goes to a temporary
 *   file that is renamed over the old one, so a crash leaves the old list or the new one.
 * - **Older and newer are by wall time**: a name event's `t` against the tombstone's `at`. A call's
 *   log position says nothing across calls, and a forget spans calls. A name given in the same
 *   millisecond as the forget counts as older, so the forget wins.
 * - **A name older than a forget that covers it** (all, its call, its name, or its name in its
 *   call) teaches nothing. A name older than a rename teaches under the new name. A newer name, of
 *   any author, lifts every tombstone before it; only a teaching name then teaches (`learn.ts`).
 * - **Kept while a call may need it**: a tombstone leaves only when every call akou keeps was
 *   created after it, since only such a call can hold a name older than it.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export type Tombstone =
  | { kind: "forget"; all?: true; name?: string; call?: string; at: number }
  | { kind: "rename"; from: string; to: string; at: number };

const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** A line of the file as a tombstone, or null when it is not one. */
function parse(line: string): Tombstone | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || typeof v.at !== "number" || !Number.isFinite(v.at))
    return null;
  if (v.kind === "rename") {
    return str(v.from) && str(v.to) ? { kind: "rename", from: v.from, to: v.to, at: v.at } : null;
  }
  if (v.kind !== "forget") return null;
  if (v.all === true) return { kind: "forget", all: true, at: v.at };
  const name = str(v.name) ? v.name : undefined;
  const call = str(v.call) ? v.call : undefined;
  if (name === undefined && call === undefined) return null;
  return {
    kind: "forget",
    ...(name !== undefined ? { name } : {}),
    ...(call !== undefined ? { call } : {}),
    at: v.at,
  };
}

export class VoiceTombstones {
  readonly file: string;
  /** Oldest first. */
  private list: Tombstone[] = [];

  constructor(
    voicesFile: string,
    private readonly log: (level: "info" | "warn", msg: string) => void,
  ) {
    this.file = `${voicesFile}.tombstones`;
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {}
    let bad = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const t = parse(line);
      if (t) this.list.push(t);
      else bad++;
    }
    this.list.sort((a, b) => a.at - b.at);
    // The log takes counts only: a line may quote a name.
    if (bad > 0) this.log("warn", `voices: ${bad} unreadable line(s) in the tombstones file`);
  }

  /** Every tombstone, oldest first. */
  all(): readonly Tombstone[] {
    return this.list;
  }

  add(t: Tombstone): void {
    this.list.push(t);
    this.list.sort((a, b) => a.at - b.at);
    this.save();
  }

  /**
   * The name a teaching name given at `t` in `call` teaches now: itself, the name a later rename
   * gave it, or null once a later forget covers it.
   */
  teaches(name: string, call: string, t: number): string | null {
    let n = name.trim();
    for (const x of this.list) {
      if (t > x.at) continue;
      if (x.kind === "rename") {
        if (x.from === n) n = x.to;
        continue;
      }
      if (x.all) return null;
      if (x.call !== undefined && x.call !== call) continue;
      if (x.name !== undefined && x.name !== n) continue;
      return null;
    }
    return n;
  }

  /**
   * Drops the tombstones no call akou keeps can need: those older than `oldest`, when the oldest
   * call akou keeps was created (Infinity with none). Answers how many left.
   */
  prune(oldest: number): number {
    const kept = this.list.filter((x) => x.at >= oldest);
    const n = this.list.length - kept.length;
    if (n > 0) {
      this.list = kept;
      this.save();
    }
    return n;
  }

  private save(): void {
    try {
      if (this.list.length === 0) {
        rmSync(this.file, { force: true });
        return;
      }
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, this.list.map((x) => `${JSON.stringify(x)}\n`).join(""), {
        mode: 0o600,
      });
      renameSync(tmp, this.file);
    } catch {
      this.log("warn", "voices: the tombstones file could not be written");
    }
  }
}
