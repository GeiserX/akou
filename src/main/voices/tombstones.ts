/**
 * What the user forgot or renamed, kept beside the voices file in `voices.yaml.tombstones`, so a
 * name given before the forget or the rename never teaches back what it removed [VO-12].
 *
 * - **One line per tombstone**, JSON: `{kind: "forget", all: true, at}`, `{kind: "forget", name?,
 *   call?, at}`, `{kind: "rename", from, to, at}`, or `{kind: "lift", call, seq, at}`. Names and
 *   call ids only, never a voiceprint. Mode 0600; each write goes to a temporary file that is
 *   renamed over the old one (retried on Windows while a reader holds it), so a crash leaves the
 *   old list or the new one. A write that fails changes nothing and throws.
 * - **Older and newer are by wall time**: a name event's `t` against the tombstone's `at`. A call's
 *   log position says nothing across calls, and a forget spans calls. A name given in the same
 *   millisecond as the forget counts as older, so the forget wins.
 * - **A clock that jumps** (`stamp`): `at` is the wall time when the user asked, but never at or
 *   before the newest stamp in the file, so stamps only grow, across restarts too. A name written
 *   while the clock reads at or before the newest stamp (the clock went back, or a stamp came from
 *   a clock that ran ahead) is newer than every stamp so far, since names reach the Host only as
 *   they are written: it gets a `lift`, a stamp of its own that `teaches` uses instead of its `t`.
 * - **A name older than a forget that covers it** (all, its call, its name, or its name in its
 *   call) teaches nothing. A name older than a rename teaches under the new name. A newer name, of
 *   any author, lifts every tombstone before it; only a teaching name then teaches (`learn.ts`).
 * - **Kept while a call may need it**: a tombstone leaves only when every call akou keeps was
 *   created after it, since only such a call can hold a name older than it.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { renameReplacing } from "../vocab/files.ts";

export type Tombstone =
  | { kind: "forget"; all?: true; name?: string; call?: string; at: number }
  | { kind: "rename"; from: string; to: string; at: number }
  | { kind: "lift"; call: string; seq: number; at: number };

/** The tombstones file could not be written: what was asked did not happen. */
export class TombstonesError extends Error {}

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
  if (v.kind === "lift") {
    return str(v.call) && Number.isInteger(v.seq)
      ? { kind: "lift", call: v.call, seq: v.seq as number, at: v.at }
      : null;
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
  /** The newest stamp given: every later stamp is past it. */
  private last = 0;

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
    this.last = this.list.at(-1)?.at ?? 0;
    // The log takes counts only: a line may quote a name.
    if (bad > 0) this.log("warn", `voices: ${bad} unreadable line(s) in the tombstones file`);
    this.sweep();
  }

  /** The time for a new tombstone: `now`, or just past the newest stamp when the clock is behind. */
  stamp(now: number): number {
    this.last = Math.max(now, this.last + 1);
    return this.last;
  }

  /** True when a name written now at `t` needs a lift: some stamp is at or after it. */
  behind(t: number): boolean {
    return t <= this.last;
  }

  /** The stamp a name of `call` at log position `seq` was lifted to, if it was. */
  lifted(call: string, seq: number): number | undefined {
    for (const x of this.list)
      if (x.kind === "lift" && x.call === call && x.seq === seq) return x.at;
    return undefined;
  }

  /** Every tombstone, oldest first. */
  all(): readonly Tombstone[] {
    return this.list;
  }

  /** Keeps `t`; throws `TombstonesError`, with nothing kept, when the file cannot be written. */
  async add(t: Tombstone): Promise<void> {
    const before = this.list;
    this.list = [...before, t].sort((a, b) => a.at - b.at);
    try {
      await this.save();
    } catch (err) {
      this.list = before;
      throw err;
    }
  }

  /**
   * Keeps `t` in memory whatever the file says; false when the file could not be written, so it
   * is lost at the next start.
   */
  async keep(t: Tombstone): Promise<boolean> {
    this.list = [...this.list, t].sort((a, b) => a.at - b.at);
    try {
      await this.save();
      return true;
    } catch {
      return false;
    }
  }

  /** Takes `t` back, after the edit it stood for failed. */
  async remove(t: Tombstone): Promise<void> {
    this.list = this.list.filter((x) => x !== t);
    await this.save();
  }

  /**
   * The name a teaching name given at `t` in `call` teaches now: itself, the name a later rename
   * gave it, or null once a later forget covers it.
   */
  teaches(name: string, call: string, t: number): string | null {
    let n = name.trim();
    for (const x of this.list) {
      if (t > x.at || x.kind === "lift") continue;
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
  async prune(oldest: number): Promise<number> {
    const before = this.list;
    const kept = before.filter((x) => x.at >= oldest);
    const n = before.length - kept.length;
    if (n > 0) {
      this.list = kept;
      try {
        await this.save();
      } catch (err) {
        this.list = before;
        throw err;
      }
    }
    return n;
  }

  /** Writes the list to a temporary file and renames it over the file; throws on failure. */
  private async save(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      if (this.list.length === 0) {
        await rm(this.file, { force: true });
        return;
      }
      await writeFile(tmp, this.list.map((x) => `${JSON.stringify(x)}\n`).join(""), {
        mode: 0o600,
      });
      await renameReplacing(tmp, this.file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      const why = (err as NodeJS.ErrnoException).code;
      throw new TombstonesError(
        `${basename(this.file)} could not be written${why ? ` (${why})` : ""}; nothing was changed`,
      );
    }
  }

  /** Removes temporary files a write of another, no longer running akou left behind. */
  private sweep(): void {
    const prefix = `${basename(this.file)}.`;
    let names: string[] = [];
    try {
      names = readdirSync(dirname(this.file));
    } catch {}
    for (const n of names) {
      if (!n.startsWith(prefix) || !n.endsWith(".tmp")) continue;
      const pid = Number(n.slice(prefix.length, -".tmp".length));
      if (pid === process.pid || (Number.isInteger(pid) && pid > 0 && alive(pid))) continue;
      rmSync(join(dirname(this.file), n), { force: true });
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
