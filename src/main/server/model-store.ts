/**
 * Server mode's models on demand (docs/ux/SERVER.md section 12): which model a job runs, the
 * download of a model a job needs and the disk does not have, and the deletion of models nobody
 * has used for `server.models_unused_days`.
 *
 * - **Which model** (SV-S1): the request's `model`, then its `preset` when it is not `auto`, then
 *   `server.default_model`, then the hardware's choice (`fast` until SV-R2). `auto` anywhere means
 *   "no opinion". Only a recognizer of the catalog or a built preset can be named; a client can never
 *   name a URL.
 * - **Downloads** (SV-M1 to SV-M3): one download per model id however many jobs wait on it, every
 *   file checked against its pinned SHA-256 (`downloadModels`), retried after 1, 5 and 15 minutes,
 *   then given up. Before one starts, the models folder must stay under `server.models_max_gb` and
 *   the volume must keep the download plus 1 GB free.
 * - **The ledger** (SV-M4): `usage.json` in the models folder, `{model id: last used}`, written
 *   atomically. A catalog model on disk with no entry is dated at the first sweep that sees it.
 * - **The sweep** (SV-M5): each catalog model whose last use is older than the setting is deleted,
 *   except the ones the caller protects (the default's set, what jobs and the worker need) and the
 *   ones downloading. Each deletion is one `model.evicted` log line.
 *
 * This file is server code on purpose: `asr/models.ts` stays the catalog and the downloader.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DownloadRefused,
  downloadModels,
  type ModelSpecEntry,
  modelFile,
  NEMOTRON,
} from "../asr/models.ts";
import { PRESET_NAMES, PRESETS } from "./presets.ts";

export const USAGE_FILE = "usage.json";
export const DAY_MS = 86_400_000;
/** The waits before the second, third and fourth try of a failed download. */
export const DOWNLOAD_RETRY_MS: readonly number[] = [60_000, 300_000, 900_000];
/** `server.models_max_gb` counts in 10^9 bytes. */
export const GB = 1e9;
/** A download must leave this much free on the volume. */
export const FREE_MARGIN_BYTES = 1e9;

/** The catalog's models that are not recognizers, when an entry does not say what it serves. */
const HELPER_MODELS: ReadonlySet<string> = new Set([
  "silero-vad",
  NEMOTRON,
  "pyannote-segmentation-3.0",
  "titanet-small",
]);

/** A recognizer: an entry that serves the final pass, or, with no `serves`, no helper model. */
export function isRecognizer(m: ModelSpecEntry): boolean {
  const serves = (m as { serves?: readonly string[] }).serves;
  return serves ? serves.includes("final") : !HELPER_MODELS.has(m.id);
}

// ---------------------------------------------------------------------------
// Which model a job runs (SV-S1)

export type ModelSource = "request" | "server_default" | "hardware";

export interface ModelChoice {
  /** The recognizer id the job runs. */
  model: string;
  /** The preset that chose it, or `custom` for an engine id no built preset lists. */
  preset: string;
  source: ModelSource;
}

/** A model a request or the server names that cannot run: the status, code and body fields. */
export class ModelRefused extends Error {
  override name = "ModelRefused";
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ResolveOptions {
  catalog: readonly ModelSpecEntry[];
  /** `server.default_model`. */
  defaultModel: string;
  /** The OpenAI door: a name akou does not know (`whisper-1`) is no opinion, not an error. */
  unknownIsAuto?: boolean;
}

/** The hardware's choice for `auto`: `fast` until SV-R2 detects a GPU or a small board. */
export function hardwareChoice(): { model: string; preset: string } {
  const fast = PRESETS.find((p) => p.name === "fast");
  return { model: fast?.engines[0] as string, preset: "fast" };
}

/**
 * What one value names: a preset, a recognizer, or nothing (`auto`, or a name the OpenAI door
 * ignores). Refused: an unbuilt preset or an engine only an unbuilt preset lists (409), any other
 * name (422, or 409 when it is the server's own setting).
 */
function pick(
  value: string | undefined,
  source: ModelSource,
  field: string,
  o: ResolveOptions,
): ModelChoice | null {
  const v = (value ?? "").trim();
  if (v === "" || v === "auto") return null;
  if ((PRESET_NAMES as readonly string[]).includes(v)) {
    const p = PRESETS.find((x) => x.name === v);
    if (!p?.built) {
      throw new ModelRefused(
        409,
        "preset_unavailable",
        `the ${v} preset's engines are not built in this version; use fast or auto`,
        { preset: v },
      );
    }
    return { model: p.engines[0] as string, preset: v, source };
  }
  if (o.catalog.some((m) => m.id === v && isRecognizer(m))) {
    const p = PRESETS.find((x) => x.built && x.engines[0] === v);
    return { model: v, preset: p?.name ?? "custom", source };
  }
  const helper = o.catalog.some((m) => m.id === v);
  const unbuilt = PRESETS.find((p) => !p.built && p.engines.includes(v));
  if (unbuilt && !helper) {
    throw new ModelRefused(
      409,
      "preset_unavailable",
      `${v} belongs to the ${unbuilt.name} preset, whose engines are not built in this version; use fast or auto`,
      { preset: unbuilt.name, model: v },
    );
  }
  if (source === "server_default") {
    throw new ModelRefused(
      409,
      "preset_unavailable",
      `server.default_model is ${v}, which this version's model catalog does not have; set it to auto or a model id from \`akou models list\``,
      { setting: "server.default_model", model: v },
    );
  }
  if (o.unknownIsAuto) return null;
  throw new ModelRefused(
    422,
    "unknown_model",
    `${field} is a preset (${PRESET_NAMES.join(", ")}) or a recognizer id from the model catalog; ${v} is neither`,
    { field, model: v },
  );
}

/** The model a job runs, first match wins (SERVER.md 12.1). */
export function resolveModel(
  ask: { model?: string; preset?: string },
  o: ResolveOptions,
): ModelChoice {
  return (
    pick(ask.model, "request", "model", o) ??
    pick(ask.preset, "request", "preset", o) ??
    pick(o.defaultModel, "server_default", "server.default_model", o) ?? {
      ...hardwareChoice(),
      source: "hardware",
    }
  );
}

// ---------------------------------------------------------------------------
// The store

export interface ModelStoreOptions {
  /** `asr.modelsDir`. */
  dir(): string;
  /**
   * The models this machine's settings need (`modelsFor`), every recognizer of the catalog among
   * them, or null when the recognizer was given on purpose (tests) and no job needs a file.
   */
  machine(): readonly ModelSpecEntry[] | null;
  /** Every model a request may name and the sweep may delete. */
  catalog(): readonly ModelSpecEntry[];
  autoDownload(): boolean;
  maxGb(): number;
  unusedDays(): number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Test seam: the waits between tries. */
  retryMs?: readonly number[];
  /** Test seam: the bytes free on the volume of `dir`. */
  freeBytes?: (dir: string) => number;
  log(level: "info" | "warn" | "error", msg: string): void;
}

/** A job's wait for a model (SV-M1): the model downloading and its bytes so far. */
export interface Waiting {
  model: string;
  bytes: number;
  total: number;
}

export type DownloadEnd = { model: string; ok: true } | { model: string; ok: false; error: string };

export interface Evicted {
  id: string;
  last_used_at: number;
  bytes: number;
}

interface Download {
  entry: ModelSpecEntry;
  /** Bytes so far per file name, for the files not already on disk. */
  bytes: Map<string, number>;
  tries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function freeOf(dir: string): number {
  // A models folder not made yet is on the volume of its nearest existing parent.
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    const s = statfsSync(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    // A volume that cannot say is not refused on a guess.
    return Number.POSITIVE_INFINITY;
  }
}

/** Every byte under `path`. */
function bytesUnder(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const f of readdirSync(path)) n += bytesUnder(join(path, f));
  return n;
}

/** The ledger in `dir`, `{model id: last used, epoch ms}`; an unreadable file is an empty one. */
export function readUsage(dir: string): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, USAGE_FILE), "utf8")) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [id, v] of Object.entries(raw)) {
      const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
      if (Number.isFinite(t)) out[id] = t;
    }
    return out;
  } catch {
    return {};
  }
}

/** Writes the ledger atomically: a private temporary file renamed over it. */
function writeUsage(dir: string, l: Record<string, number>): void {
  if (!existsSync(dir)) return;
  const path = join(dir, USAGE_FILE);
  const text = `${JSON.stringify(
    Object.fromEntries(Object.entries(l).map(([id, t]) => [id, new Date(t).toISOString()])),
    null,
    2,
  )}\n`;
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: "wx" });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

/**
 * Marks models used at `at`: a job on them starts or ends, or `akou models pull` or an on-demand
 * download finishes them (SV-M4).
 */
export function touchUsage(dir: string, ids: readonly string[], at = Date.now()): void {
  if (ids.length === 0) return;
  const l = readUsage(dir);
  for (const id of ids) l[id] = at;
  writeUsage(dir, l);
}

export class ModelStore {
  private readonly now: () => number;
  private readonly downloads = new Map<string, Download>();
  private readonly watchers = new Set<(e: DownloadEnd) => void>();
  private closed = false;

  constructor(private readonly o: ModelStoreOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Every model a request may name and the sweep may delete. */
  catalog(): readonly ModelSpecEntry[] {
    return this.o.catalog();
  }

  /** `server.models_unused_days`. */
  unusedDays(): number {
    return this.o.unusedDays();
  }

  private entry(id: string): ModelSpecEntry | undefined {
    return this.o.catalog().find((m) => m.id === id);
  }

  /** The model ids a job on `recognizer` loads: it, with the helpers the machine needs. */
  needs(recognizer: string): string[] {
    const machine = this.o.machine();
    if (machine === null) return [];
    const out = machine.filter((m) => m.id === recognizer || !isRecognizer(m)).map((m) => m.id);
    if (!out.includes(recognizer) && this.entry(recognizer)) out.unshift(recognizer);
    return out;
  }

  /** The ids whose files are not all on disk. A file is moved into place only once verified. */
  missing(ids: readonly string[]): string[] {
    const dir = this.o.dir();
    return ids.filter((id) => {
      const m = this.entry(id);
      return !m || m.files.some((f) => !existsSync(modelFile(dir, id, f.name)));
    });
  }

  /** Bytes a model still needs from the network. */
  private remaining(m: ModelSpecEntry): number {
    const dir = this.o.dir();
    const d = this.downloads.get(m.id);
    let n = 0;
    for (const f of m.files) {
      if (existsSync(modelFile(dir, m.id, f.name))) continue;
      n += f.size - (d?.bytes.get(f.name) ?? 0);
    }
    return n;
  }

  /**
   * Whether the models can be had (SV-M1, SV-M2): present, downloading, or allowed to start. A
   * refusal is 409 `preset_unavailable`, the code the archive keeps a row queued on.
   */
  admit(ids: readonly string[]): void {
    const miss = this.missing(ids);
    if (miss.length === 0) return;
    const first = miss[0] as string;
    if (!this.o.autoDownload()) {
      throw new ModelRefused(
        409,
        "preset_unavailable",
        `the ${first} model is not downloaded and server.auto_download is off`,
        { model: first, run: `akou models pull ${first}` },
      );
    }
    const fresh = miss.filter((id) => !this.downloads.has(id));
    if (fresh.length === 0) return;
    let need = 0;
    for (const id of fresh) {
      const m = this.entry(id);
      if (!m)
        throw new ModelRefused(409, "preset_unavailable", `unknown model ${id}`, { model: id });
      need += this.remaining(m);
    }
    const dir = this.o.dir();
    const cap = this.o.maxGb() * GB;
    if (cap > 0) {
      let inFlight = 0;
      for (const d of this.downloads.values()) inFlight += this.remaining(d.entry);
      if (bytesUnder(dir) + inFlight + need > cap) {
        throw new ModelRefused(
          409,
          "preset_unavailable",
          `downloading ${first} (${need} bytes) would take the models folder past server.models_max_gb (${this.o.maxGb()} GB)`,
          { reason: "models_max_gb", model: first, bytes: need },
        );
      }
    }
    const free = (this.o.freeBytes ?? freeOf)(dir);
    if (free < need + FREE_MARGIN_BYTES) {
      throw new ModelRefused(
        409,
        "preset_unavailable",
        `downloading ${first} needs ${need} bytes and 1 GB to spare, and the volume has ${free} bytes free`,
        { reason: "disk_full", model: first, bytes: need },
      );
    }
  }

  /** Starts the download of every missing model not already downloading. */
  fetch(ids: readonly string[]): void {
    for (const id of this.missing(ids)) {
      if (this.downloads.has(id) || this.closed) continue;
      const entry = this.entry(id);
      if (!entry) continue;
      const d: Download = { entry, bytes: new Map(), tries: 0, timer: null };
      this.downloads.set(id, d);
      this.o.log("info", `model.download ${id} started`);
      void this.attempt(d);
    }
  }

  private async attempt(d: Download): Promise<void> {
    const id = d.entry.id;
    d.tries++;
    d.timer = null;
    try {
      await downloadModels(this.o.dir(), [id], {
        registry: [d.entry],
        env: this.o.env,
        fetch: this.o.fetch,
        onProgress: (p) => d.bytes.set(p.name, p.bytes),
      });
    } catch (err) {
      if (this.closed) return;
      const delays = this.o.retryMs ?? DOWNLOAD_RETRY_MS;
      const cause = (err as Error).message;
      if (!(err instanceof DownloadRefused) && d.tries <= delays.length) {
        const wait = delays[d.tries - 1] as number;
        this.o.log(
          "warn",
          `model.download ${id} try ${d.tries} failed: ${cause}; next in ${wait} ms`,
        );
        // clock: the retry schedule of SV-M3, 1, 5 and 15 minutes.
        d.timer = setTimeout(() => void this.attempt(d), wait);
        return;
      }
      this.downloads.delete(id);
      this.o.log("warn", `model.download ${id} failed after ${d.tries} tries: ${cause}`);
      this.announce({ model: id, ok: false, error: cause });
      return;
    }
    if (this.closed) return;
    this.downloads.delete(id);
    this.touch([id]);
    this.o.log("info", `model.download ${id} done`);
    this.announce({ model: id, ok: true });
  }

  private announce(e: DownloadEnd): void {
    for (const fn of [...this.watchers]) fn(e);
  }

  /** Told of every download's end. Returns the unsubscribe function. */
  onEnd(fn: (e: DownloadEnd) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /** The ids downloading now. */
  downloading(): string[] {
    return [...this.downloads.keys()];
  }

  /** The first of the models still missing, with its download's progress, or null when none is. */
  waiting(ids: readonly string[]): Waiting | null {
    const id = this.missing(ids)[0];
    if (id === undefined) return null;
    const m = this.entry(id);
    if (!m) return null;
    const total = m.files.reduce((n, f) => n + f.size, 0);
    return { model: id, bytes: total - this.remaining(m), total };
  }

  // -------------------------------------------------------------------------
  // The ledger (SV-M4)

  /** `{model id: last used, epoch ms}`; a file that cannot be read is an empty ledger. */
  ledger(): Record<string, number> {
    return readUsage(this.o.dir());
  }

  private write(l: Record<string, number>): void {
    writeUsage(this.o.dir(), l);
  }

  /** Marks the models used now (a job starts or ends on them, a download finishes them). */
  touch(ids: readonly string[], at = this.now()): void {
    touchUsage(this.o.dir(), ids, at);
  }

  // -------------------------------------------------------------------------
  // The sweep (SV-M5)

  /**
   * Deletes each catalog model on disk unused for `server.models_unused_days`, except the ones
   * in `protect` and the ones downloading. A model with no entry is dated now and kept.
   */
  sweep(protect: ReadonlySet<string>): Evicted[] {
    // A recognizer given on purpose (tests) needs no file, so nothing here is its to judge.
    if (this.o.machine() === null) return [];
    const dir = this.o.dir();
    const days = this.o.unusedDays();
    const now = this.now();
    const l = this.ledger();
    const onDisk = this.o
      .catalog()
      .map((m) => m.id)
      .filter((id) => existsSync(join(dir, id)));
    let changed = false;
    for (const id of onDisk) {
      if (l[id] === undefined) {
        l[id] = now;
        changed = true;
      }
    }
    const out: Evicted[] = [];
    if (days > 0) {
      for (const id of onDisk) {
        const last = l[id] as number;
        if (now - last < days * DAY_MS || protect.has(id) || this.downloads.has(id)) continue;
        const path = join(dir, id);
        const bytes = bytesUnder(path);
        try {
          rmSync(path, { recursive: true, force: true });
        } catch (err) {
          this.o.log("warn", `model.evict ${id} failed: ${(err as Error).message}`);
          continue;
        }
        delete l[id];
        changed = true;
        out.push({ id, last_used_at: last, bytes });
        this.o.log(
          "info",
          `model.evicted ${id} last_used_at ${new Date(last).toISOString()} bytes_freed ${bytes}`,
        );
      }
    }
    if (changed) this.write(l);
    return out;
  }

  // -------------------------------------------------------------------------
  // One model at a time (SV-M6)

  /** Whether a catalog model is on disk, downloading, or missing. */
  state(id: string): "ready" | "downloading" | "missing" {
    if (this.missing([id]).length === 0) return "ready";
    return this.downloads.has(id) ? "downloading" : "missing";
  }

  /** Bytes of the model on disk or fetched so far, and the catalog's total. */
  size(id: string): { bytes: number; size: number } {
    const w = this.waiting([id]);
    if (w) return { bytes: w.bytes, size: w.total };
    const m = this.entry(id);
    const size = m ? m.files.reduce((n, f) => n + f.size, 0) : 0;
    return { bytes: size, size };
  }

  /** Deletes one model's folder and its ledger entry; the caller has checked it is free. */
  remove(id: string): number {
    if (this.downloads.has(id)) {
      throw new ModelRefused(409, "model_in_use", `${id} is downloading`, { model: id });
    }
    const path = join(this.o.dir(), id);
    const bytes = bytesUnder(path);
    rmSync(path, { recursive: true, force: true });
    const l = this.ledger();
    if (l[id] !== undefined) {
      delete l[id];
      this.write(l);
    }
    return bytes;
  }

  close(): void {
    this.closed = true;
    for (const d of this.downloads.values()) if (d.timer) clearTimeout(d.timer);
    this.downloads.clear();
    this.watchers.clear();
  }
}
