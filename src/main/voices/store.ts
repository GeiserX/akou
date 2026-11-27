/**
 * The voices file: `<config>/voices.yaml`, one voiceprint list per person the user named, so akou
 * can name the same voice in a later call. It lives in the config folder, outside
 * `recordings.root` and `export.dir`, so no export or share ever carries it.
 *
 * ```yaml
 * version: 1
 * people:
 *   - name: "Ben Ortiz"
 *     exemplars:
 *       - model: "titanet-small"
 *         dim: 192
 *         vec: "<base64 of dim little-endian float32 values, unit length>"
 *         secs: 214.5
 *         cons: 0.83
 *         call: "<call id>"
 *         spk: "c2"
 *         at: "2026-11-27T10:12:00.000Z"
 * ```
 *
 * - One exemplar per (call, live speaker label): naming the same label again moves it.
 * - Each person keeps the 8 newest exemplars; the file holds at most 150 people and 4 MB. The two
 *   limits agree: 150 people with 8 exemplars of 512 values each come to about 3.6 MB, so the people
 *   limit is the one a user meets, with a plain error, before the size limit.
 * - An exemplar older than 3 years is dropped when the file is read, and the file is rewritten
 *   without it; one that old is never added. There is no setting for this.
 * - `load(model, dim)` returns only exemplars of the running embedder ([VO-3]): a vector of
 *   another model or size is skipped and counted, and stays in the file for that embedder.
 * - A forget rewrites the file without the entry; no tombstone keeps a vector. Forget all deletes
 *   the file. A temporary file left by a write that never finished (the app killed mid-write) is
 *   removed by the next edit and by forget all, so no copy of a forgotten vector stays behind.
 *
 * Every write is atomic (a temporary file renamed over the old one), mode 0600, and runs under a
 * per-file lock, so two edits never lose each other's change. Every string is quoted, so a name
 * such as `No` or `true` never reads back as a boolean. A file akou cannot read is never written
 * over: every edit refuses it, and the user can fix or delete it by hand.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { norm, unit } from "../asr/voiceprint.ts";
import { defaultConfigDir, renameReplacing } from "../vocab/files.ts";

export const VOICES_VERSION = 1;
export const VOICES_FILE = "voices.yaml";
/** The file is refused over this size, before it is read. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Exemplars kept per person: the newest. */
export const MAX_EXEMPLARS = 8;
/** People kept. At `MAX_EXEMPLARS` exemplars of `MAX_DIM` values each, they fit `MAX_FILE_BYTES`. */
export const MAX_PEOPLE = 150;
export const MAX_NAME_LENGTH = 100;
/** The largest embedding size accepted; real speaker embedders give 192 to 512. */
export const MAX_DIM = 512;
/** An exemplar older than this is dropped. */
export const RETENTION_YEARS = 3;

export interface Exemplar {
  /** The embedder's id. */
  model: string;
  /** The embedding's size; `vec.length`. */
  dim: number;
  /** The voiceprint, unit length. */
  vec: Float32Array;
  /** Seconds of speech it came from. */
  secs: number;
  /** How well its lines agreed with each other, 0 to 1. */
  cons: number;
  /** The call it came from. */
  call: string;
  /** The live speaker label in that call (`c2`). */
  spk: string;
  /** When it was taken, ISO 8601. */
  at: string;
}

export interface Person {
  name: string;
  /** Newest first. */
  exemplars: Exemplar[];
}

/** What the store says about one person: never a vector. */
export interface VoiceSummary {
  name: string;
  /** The calls their exemplars came from, newest first. */
  calls: string[];
  /** Seconds of speech over every exemplar. */
  secs: number;
  /** The newest exemplar's time, ISO 8601. */
  lastSeen: string;
}

export interface LoadedVoices {
  /** People with at least one exemplar of the given model and size, and only those exemplars. */
  people: Person[];
  /** Exemplars skipped because their model or size is not the given one. */
  skipped: number;
}

/** The file cannot be read or written as it is; nothing was changed. */
export class VoicesError extends Error {
  override name = "VoicesError";
}

/** `<config>/voices.yaml`. */
export function voicesPath(configDir: string = defaultConfigDir()): string {
  return join(configDir, VOICES_FILE);
}

/** A vector as base64 of its little-endian float32 bytes. */
export function encodeVec(v: Float32Array): string {
  const b = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i] as number, i * 4);
  return b.toString("base64");
}

/** The vector `encodeVec` wrote, or null when the text is not exactly that for `dim` values. */
export function decodeVec(s: string, dim: number): Float32Array | null {
  const b = Buffer.from(s, "base64");
  if (b.length !== dim * 4 || b.toString("base64") !== s) return null;
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = b.readFloatLE(i * 4);
  return v;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The time before which an exemplar has expired. */
function cutoff(now: number): number {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - RETENTION_YEARS);
  return d.getTime();
}

/** A person's name as kept: trimmed; null when empty or too long. */
export function cleanName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const n = name.trim();
  return n === "" || [...n].length > MAX_NAME_LENGTH ? null : n;
}

/** Why an exemplar is not one akou keeps, or null when it is. */
function badExemplar(e: Exemplar): string | null {
  if (typeof e.model !== "string" || e.model === "") return "model must be a non-empty string";
  if (!Number.isInteger(e.dim) || e.dim < 1 || e.dim > MAX_DIM)
    return `dim must be a whole number from 1 to ${MAX_DIM}`;
  if (!(e.vec instanceof Float32Array) || e.vec.length !== e.dim) return "vec must hold dim values";
  const n = norm(e.vec);
  if (!Number.isFinite(n) || n === 0) return "vec must be finite and not zero";
  if (!Number.isFinite(e.secs) || e.secs < 0) return "secs must be a number of seconds";
  if (!Number.isFinite(e.cons) || e.cons < 0 || e.cons > 1) return "cons must be from 0 to 1";
  if (typeof e.call !== "string" || e.call === "") return "call must be a non-empty string";
  if (typeof e.spk !== "string" || e.spk === "") return "spk must be a non-empty string";
  if (typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at)))
    return "at must be an ISO 8601 time";
  return null;
}

/**
 * The exemplar as it is written: the vector at unit length, seconds to the millisecond and the
 * consistency to six places, so every number is written without an exponent and reads back the
 * same.
 */
function canonical(e: Exemplar): Exemplar {
  return {
    model: e.model,
    dim: e.dim,
    vec: unit(e.vec),
    secs: Math.round(e.secs * 1000) / 1000,
    cons: Math.round(e.cons * 1e6) / 1e6,
    call: e.call,
    spk: e.spk,
    at: e.at,
  };
}

/** Parses the file. Expired exemplars are dropped and counted; anything malformed throws. */
export function parseVoices(text: string, now: number): { people: Person[]; expired: number } {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (err) {
    throw new VoicesError(`not valid YAML: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) return { people: [], expired: 0 };
  if (!isObj(doc)) throw new VoicesError("the file must be a mapping with version and people");
  if (doc.version !== VOICES_VERSION)
    throw new VoicesError(`version must be ${VOICES_VERSION}; akou does not know this file`);
  const raw = doc.people ?? [];
  if (!Array.isArray(raw)) throw new VoicesError('"people" must be a list');
  if (raw.length > MAX_PEOPLE)
    throw new VoicesError(`the file holds ${raw.length} people; the limit is ${MAX_PEOPLE}`);
  const old = cutoff(now);
  const seen = new Set<string>();
  const people: Person[] = [];
  let expired = 0;
  raw.forEach((p, i) => {
    if (!isObj(p)) throw new VoicesError(`person ${i} must be a mapping`);
    const name = cleanName(p.name);
    if (name === null || name !== p.name)
      throw new VoicesError(
        `person ${i}: name must be a trimmed string of 1 to ${MAX_NAME_LENGTH} characters`,
      );
    if (seen.has(name)) throw new VoicesError(`person ${i}: "${name}" is listed twice`);
    seen.add(name);
    const exs = p.exemplars ?? [];
    if (!Array.isArray(exs)) throw new VoicesError(`person ${i}: exemplars must be a list`);
    const exemplars: Exemplar[] = [];
    exs.forEach((x, j) => {
      const where = `person ${i}, exemplar ${j}`;
      if (!isObj(x)) throw new VoicesError(`${where} must be a mapping`);
      const dim = x.dim;
      if (!Number.isInteger(dim) || (dim as number) < 1 || (dim as number) > MAX_DIM)
        throw new VoicesError(`${where}: dim must be a whole number from 1 to ${MAX_DIM}`);
      const vec = typeof x.vec === "string" ? decodeVec(x.vec, dim as number) : null;
      if (!vec) throw new VoicesError(`${where}: vec must be base64 of ${dim} float32 values`);
      const e = { ...x, dim, vec } as unknown as Exemplar;
      const why = badExemplar(e);
      if (why) throw new VoicesError(`${where}: ${why}`);
      if (Date.parse(e.at) < old) {
        expired++;
        return;
      }
      exemplars.push({
        model: e.model,
        dim: e.dim,
        vec: unit(e.vec),
        secs: e.secs,
        cons: e.cons,
        call: e.call,
        spk: e.spk,
        at: e.at,
      });
    });
    people.push({ name, exemplars });
  });
  return { people, expired };
}

/** A YAML double-quoted scalar. JSON string escapes are valid YAML escapes. */
const q = (s: string): string => JSON.stringify(s);

/** Writes the file. Every string is quoted; the output parses back to the same people. */
export function serializeVoices(people: readonly Person[]): string {
  const out = [`# akou voices, version ${VOICES_VERSION}`, `version: ${VOICES_VERSION}`];
  out.push(people.length === 0 ? "people: []" : "people:");
  for (const p of people) {
    out.push(`  - name: ${q(p.name)}`);
    out.push(p.exemplars.length === 0 ? "    exemplars: []" : "    exemplars:");
    for (const e of p.exemplars) {
      out.push(`      - model: ${q(e.model)}`);
      out.push(`        dim: ${e.dim}`);
      out.push(`        vec: ${q(encodeVec(e.vec))}`);
      out.push(`        secs: ${String(e.secs)}`);
      out.push(`        cons: ${String(e.cons)}`);
      out.push(`        call: ${q(e.call)}`);
      out.push(`        spk: ${q(e.spk)}`);
      out.push(`        at: ${q(e.at)}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/** Newest first, the newest `MAX_EXEMPLARS` only. */
function capped(exemplars: readonly Exemplar[]): Exemplar[] {
  return [...exemplars].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_EXEMPLARS);
}

/** Whether a process with this id runs. EPERM means it runs as another user. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Edits of one file run one at a time, in every store open on it. */
const fileLocks = new Map<string, Promise<unknown>>();

function locked<T>(path: string, run: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(path) ?? Promise.resolve();
  const next = prev.then(run);
  const settled = next.catch(() => {});
  fileLocks.set(path, settled);
  settled.then(() => {
    if (fileLocks.get(path) === settled) fileLocks.delete(path);
  });
  return next;
}

/** One edit: the people after it, what to return, and whether the file changes. */
interface Edit<T> {
  people: Person[];
  result: T;
  changed: boolean;
}

export interface VoiceStoreOptions {
  /** Milliseconds since the epoch, for the 3-year expiry. */
  now?: () => number;
  /** Where the counts of skipped and expired exemplars go. Never a name or a vector. */
  log?: (message: string) => void;
}

export class VoiceStore {
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    readonly path: string,
    opts: VoiceStoreOptions = {},
  ) {
    // clock: the default of an injected clock; tests pass their own.
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /**
   * The people with exemplars of this embedder, and only those exemplars ([VO-3]). An exemplar of
   * another model or size is skipped and counted in the log; it stays in the file.
   */
  load(model: string, dim: number): Promise<LoadedVoices> {
    return this.edit((all) => {
      let skipped = 0;
      const people: Person[] = [];
      for (const p of all) {
        const mine = p.exemplars.filter((e) => e.model === model && e.dim === dim);
        skipped += p.exemplars.length - mine.length;
        if (mine.length > 0) people.push({ name: p.name, exemplars: mine });
      }
      if (skipped > 0)
        this.log(
          `${VOICES_FILE}: skipped ${skipped} voiceprint(s) of another embedder than ${model} (${dim} values)`,
        );
      return { people: all, result: { people, skipped }, changed: false };
    });
  }

  /**
   * Keeps `exemplar` under `name`. An exemplar of the same call and speaker label moves here from
   * whoever held it. A person keeps the newest `MAX_EXEMPLARS`.
   */
  upsert(name: string, exemplar: Exemplar): Promise<void> {
    const who = cleanName(name);
    if (who === null)
      return Promise.reject(
        new VoicesError(`a name is 1 to ${MAX_NAME_LENGTH} characters, not blank`),
      );
    const why = badExemplar(exemplar);
    if (why) return Promise.reject(new VoicesError(why));
    if (Date.parse(exemplar.at) < cutoff(this.now()))
      return Promise.reject(
        new VoicesError(`an exemplar older than ${RETENTION_YEARS} years is not kept`),
      );
    const ex = canonical(exemplar);
    return this.edit((all) => {
      const people = all.map((p) => ({
        name: p.name,
        exemplars: p.exemplars.filter((e) => !(e.call === ex.call && e.spk === ex.spk)),
      }));
      const at = people.findIndex((p) => p.name === who);
      if (at < 0) {
        if (people.filter((p) => p.exemplars.length > 0).length >= MAX_PEOPLE)
          throw new VoicesError(`${VOICES_FILE} holds ${MAX_PEOPLE} people, the most it keeps`);
        people.push({ name: who, exemplars: [ex] });
      } else {
        const p = people[at] as Person;
        p.exemplars = capped([ex, ...p.exemplars]);
      }
      return { people, result: undefined, changed: true };
    });
  }

  /** Drops the exemplar of one call's speaker label. False when there was none. */
  removeExemplar(call: string, spk: string): Promise<boolean> {
    return this.edit((all) => {
      let n = 0;
      const people = all.map((p) => {
        const left = p.exemplars.filter((e) => !(e.call === call && e.spk === spk));
        n += p.exemplars.length - left.length;
        return { name: p.name, exemplars: left };
      });
      return { people, result: n > 0, changed: n > 0 };
    });
  }

  /**
   * Renames a person. When `to` is already a person, the two become one, keeping the newest
   * `MAX_EXEMPLARS` of both. False when there is no `from`.
   */
  rename(from: string, to: string): Promise<boolean> {
    const dest = cleanName(to);
    if (dest === null)
      return Promise.reject(
        new VoicesError(`a name is 1 to ${MAX_NAME_LENGTH} characters, not blank`),
      );
    return this.edit((all) => {
      const src = all.find((p) => p.name === from);
      if (!src) return { people: all, result: false, changed: false };
      if (dest === from) return { people: all, result: true, changed: false };
      const target = all.find((p) => p.name === dest);
      const people: Person[] = [];
      for (const p of all) {
        if (p === src) {
          // Joining: the person keeps the place of `to`; else `from`'s place under the new name.
          if (!target) people.push({ name: dest, exemplars: p.exemplars });
        } else if (p === target) {
          people.push({ name: dest, exemplars: capped([...p.exemplars, ...src.exemplars]) });
        } else people.push(p);
      }
      return { people, result: true, changed: true };
    });
  }

  /** Forgets a person: every exemplar of theirs leaves the file. False when there was none. */
  forget(name: string): Promise<boolean> {
    return this.edit((all) => {
      const people = all.filter((p) => p.name !== name);
      const gone = people.length !== all.length;
      return { people, result: gone, changed: gone };
    });
  }

  /** Forgets what one call taught: every exemplar from it. Returns how many left the file. */
  forgetCall(call: string): Promise<number> {
    return this.edit((all) => {
      let n = 0;
      const people = all.map((p) => {
        const left = p.exemplars.filter((e) => e.call !== call);
        n += p.exemplars.length - left.length;
        return { name: p.name, exemplars: left };
      });
      return { people, result: n, changed: n > 0 };
    });
  }

  /** Forgets what one call taught about one person. Returns how many left the file. */
  forgetPersonCall(name: string, call: string): Promise<number> {
    return this.edit((all) => {
      let n = 0;
      const people = all.map((p) => {
        if (p.name !== name) return p;
        const left = p.exemplars.filter((e) => e.call !== call);
        n += p.exemplars.length - left.length;
        return { name: p.name, exemplars: left };
      });
      return { people, result: n, changed: n > 0 };
    });
  }

  /** Forgets everyone: deletes the file. False when there was no file. */
  forgetAll(): Promise<boolean> {
    return locked(this.path, async () => {
      const existed = await stat(this.path).then(
        () => true,
        () => false,
      );
      await rm(this.path, { force: true });
      await this.sweepTemps();
      return existed;
    });
  }

  /** Every person with their calls, seconds and last time seen. Never a vector. */
  list(): Promise<VoiceSummary[]> {
    return this.edit((all) => {
      const result = all
        .filter((p) => p.exemplars.length > 0)
        .map((p) => {
          const exs = [...p.exemplars].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
          const calls: string[] = [];
          for (const e of exs) if (!calls.includes(e.call)) calls.push(e.call);
          return {
            name: p.name,
            calls,
            secs: Math.round(exs.reduce((s, e) => s + e.secs, 0) * 1000) / 1000,
            lastSeen: (exs[0] as Exemplar).at,
          };
        });
      return { people: all, result, changed: false };
    });
  }

  /**
   * Reads the file, runs `fn` on its people and writes the result when it changed or when
   * expired exemplars were dropped, all under the file's lock.
   */
  private edit<T>(fn: (people: Person[]) => Edit<T>): Promise<T> {
    return locked(this.path, async () => {
      await this.sweepTemps();
      const { people, expired } = await this.read();
      if (expired > 0)
        this.log(`${VOICES_FILE}: dropped ${expired} voiceprint(s) over 3 years old`);
      const out = fn(people);
      if (out.changed || expired > 0) await this.write(out.people);
      return out.result;
    });
  }

  /**
   * Removes temporary files of this file left by a write that never finished: the ones of this
   * process (none is in flight under the lock) and of a process that no longer runs. A write in
   * flight in another running akou keeps its file.
   */
  private async sweepTemps(): Promise<void> {
    const dir = dirname(this.path);
    const prefix = `.${basename(this.path)}.`;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.startsWith(prefix) || !n.endsWith(".tmp")) continue;
      const pid = Number(n.slice(prefix.length).split(".")[0]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && running(pid)) continue;
      await rm(join(dir, n), { force: true });
    }
  }

  private async read(): Promise<{ people: Person[]; expired: number }> {
    let text: string;
    try {
      // The size is checked before the bytes are read.
      const size = (await stat(this.path)).size;
      if (size > MAX_FILE_BYTES)
        throw new VoicesError(
          `${VOICES_FILE} is too large; the limit is ${MAX_FILE_BYTES} bytes. Fix or delete it by hand.`,
        );
      text = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { people: [], expired: 0 };
      throw err;
    }
    try {
      return parseVoices(text, this.now());
    } catch (err) {
      if (err instanceof VoicesError)
        throw new VoicesError(`${VOICES_FILE}: ${err.message}. Fix or delete it by hand.`);
      throw err;
    }
  }

  /**
   * Writes the file atomically, mode 0600, without people left with no exemplar. Refuses a file
   * that would not read back the same or that is over the size limit, so akou never writes a file
   * it would then refuse to read.
   */
  private async write(people: readonly Person[]): Promise<void> {
    const kept = people.filter((p) => p.exemplars.length > 0);
    const text = serializeVoices(kept);
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES)
      throw new VoicesError(
        `${VOICES_FILE} would pass ${MAX_FILE_BYTES} bytes; nothing was written`,
      );
    const back = parseVoices(text, this.now());
    if (back.expired > 0 || serializeVoices(back.people) !== text)
      throw new VoicesError(`refusing to write ${VOICES_FILE}: it would read back differently`);
    await mkdir(dirname(this.path), { recursive: true });
    // One temporary file per write: two writes to one path must not share it.
    const tmp = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tmp, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      // The mode is set again, since the umask may only take bits away and not add them, and a
      // mode given at creation is ignored on some file systems.
      await chmod(tmp, 0o600);
      await renameReplacing(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
