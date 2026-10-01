/**
 * The models on disk (docs/ux/SERVER.md section 12): which model a job runs, the download of a
 * model a job or a person asks for, the deletion of models nobody has used for
 * `server.models_unused_days`, and each model's row on the Models page. Server mode and the
 * desktop app both run one store; only server mode has jobs.
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
 *   except the ones the caller protects (the default's set, what jobs, the worker or the recognizer
 *   need) and the ones downloading. Each deletion is one `model.evicted` log line.
 * - **One model at a time** (SV-M6, SV-U6): `list` (state, last use, deletion date, the scores of
 *   `asr/model-scores.ts`, this machine's measured speed from `speed.json`), `pull` and `delete`.
 * - **Imports** (`POST /models/import`): a model being copied from a folder reads as downloading,
 *   with its bytes so far, the sweep leaves it, and Cancel stops its copy.
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
import { FORMULAS, type Measure, type NotMeasured, score, scoresOf } from "../asr/model-scores.ts";
import { MODEL_TEXT } from "../asr/model-text.ts";
import {
  type CatalogEntry,
  DownloadRefused,
  downloadModels,
  importModels,
  type ModelSpecEntry,
  modelFile,
  NEMOTRON,
} from "../asr/models.ts";
import { PRESET_NAMES, PRESETS } from "./presets.ts";

export const USAGE_FILE = "usage.json";
/** This machine's measured speed per model: the real-time factors of its last runs. */
export const SPEED_FILE = "speed.json";
/** How many runs per model `speed.json` keeps; the page shows their median. */
export const SPEED_RUNS = 20;
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
  /**
   * What a recognizer runs on besides its own files: the llama-server build for Qwen. Fetched,
   * kept and swept with it.
   */
  requires?(recognizer: string): readonly string[];
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
  /** Aborts the try in flight when a person cancels the download. */
  abort: AbortController;
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

/** Writes the ledger atomically. */
function writeUsage(dir: string, l: Record<string, number>): void {
  writeJson(
    dir,
    USAGE_FILE,
    Object.fromEntries(Object.entries(l).map(([id, t]) => [id, new Date(t).toISOString()])),
  );
}

/** Writes a JSON file in `dir` atomically: a private temporary file renamed over it. */
function writeJson(dir: string, name: string, value: unknown): void {
  if (!existsSync(dir)) return;
  const path = join(dir, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
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

/** `speed.json` in `dir`: `{model id: [real-time factor, ...]}`, newest last. */
export function readSpeed(dir: string): Record<string, number[]> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SPEED_FILE), "utf8")) as Record<string, unknown>;
    const out: Record<string, number[]> = {};
    for (const [id, v] of Object.entries(raw)) {
      if (!Array.isArray(v)) continue;
      const runs = v.filter((x): x is number => typeof x === "number" && x > 0 && x < 1e6);
      if (runs.length > 0) out[id] = runs;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Records one finished run of `id` on this machine: `audioS` seconds of audio in `wallS` seconds.
 * The last `SPEED_RUNS` are kept. A run with no audio says nothing about speed and is dropped.
 */
export function recordRun(dir: string, id: string, audioS: number, wallS: number): void {
  if (!(audioS > 0) || !(wallS > 0)) return;
  const all = readSpeed(dir);
  const runs = [...(all[id] ?? []), Number((wallS / audioS).toPrecision(4))];
  all[id] = runs.slice(-SPEED_RUNS);
  writeJson(dir, SPEED_FILE, all);
}

/** The median real-time factor of this machine's recorded runs of `id`, or null for none. */
export function measuredSpeed(
  speed: Record<string, number[]>,
  id: string,
): { rtf: number; runs: number } | null {
  const runs = [...(speed[id] ?? [])].sort((a, b) => a - b);
  if (runs.length === 0) return null;
  const mid = runs.length >> 1;
  const rtf =
    runs.length % 2 === 1
      ? (runs[mid] as number)
      : ((runs[mid - 1] as number) + (runs[mid] as number)) / 2;
  return { rtf: Number(rtf.toPrecision(3)), runs: runs.length };
}

// ---------------------------------------------------------------------------
// One catalog model as the Models page and `GET /models` show it (SV-M6, SV-U6)

/** What a model is for: speech recognition, speaker labels, or a helper (VAD, a runtime). */
export type ModelKind = "speech" | "speakers" | "helper";

const SPEAKER_MODELS: ReadonlySet<string> = new Set([
  NEMOTRON,
  "pyannote-segmentation-3.0",
  "titanet-small",
]);

export function kindOf(m: ModelSpecEntry): ModelKind {
  const serves = (m as Partial<CatalogEntry>).serves;
  if (serves) {
    if (serves.includes("final") || serves.includes("live")) return "speech";
    if (serves.includes("diarizer") || serves.includes("embedder")) return "speakers";
    return "helper";
  }
  if (SPEAKER_MODELS.has(m.id)) return "speakers";
  return isRecognizer(m) ? "speech" : "helper";
}

/** A score as the page draws it: the 0 to 100 bar and the number behind it, or why there is none. */
export type ScoreView =
  | {
      score: number;
      metric: Measure["metric"];
      value: number;
      what: string;
      /** The test set in plain words, for an accuracy figure: `read speech`, `meetings`. */
      set?: string;
      source: string;
      formula: string;
    }
  | { score: null; not_measured: string };

/** The host and repository a file URL is published in: `huggingface.co/org/repo`. */
export function publishedAt(url: string): string {
  try {
    const u = new URL(url);
    return [
      u.host,
      ...u.pathname
        .split("/")
        .filter((x) => x !== "")
        .slice(0, 2),
    ].join("/");
  } catch {
    return url;
  }
}

export function scoreView(m: Measure | NotMeasured | undefined): ScoreView {
  if (!m) return { score: null, not_measured: "no measurement recorded for this model" };
  if ("notMeasured" in m) return { score: null, not_measured: m.notMeasured };
  return {
    score: score(m),
    metric: m.metric,
    value: Math.round(m.value * 100) / 100,
    what: m.what,
    ...(m.set ? { set: m.set } : {}),
    source: m.source,
    formula: FORMULAS[m.metric],
  };
}

export interface ModelView {
  id: string;
  kind: ModelKind;
  /** What it does, from the catalog. */
  job: string;
  /** Its name where a person picks it, or null for a model with none (a helper). */
  name: string | null;
  /** A shorter name for the Record row's button, or null for none. */
  short: string | null;
  /** One plain line per slot it can fill (`live`, `review`), from the catalog. */
  lines: { live?: string; review?: string };
  /** ISO 639-1 codes it hears, `any` for a model that hears no words, null when unknown. */
  languages: "any" | readonly string[] | null;
  /** It transcribes while the call runs, not only after. */
  streaming: boolean;
  /** It transcribes after the call (the final pass or a job); false for a live-only model. */
  after_call: boolean;
  /** Where its files are downloaded from: host and repository, for example `huggingface.co/org/repo`. */
  from: string[];
  state: "ready" | "downloading" | "missing";
  bytes: number;
  size: number;
  last_used_at: string | null;
  /** When the sweep deletes it; null when it is kept or not on disk. */
  evicts_at: string | null;
  default: boolean;
  in_use: boolean;
  accuracy: ScoreView;
  speed: ScoreView;
  /** This machine's median real-time factor from its finished runs, or null for none. */
  measured: { rtf: number; runs: number } | null;
  /** The setting that makes it the default, or null when no setting chooses it. */
  set_default: { key: string; value: string } | null;
}

/** How old a copy's temporary file must be before a store that starts deletes it. */
export const STALE_COPY_MS = 60_000;

/** A model being copied from a folder (`POST /models/import`). */
interface Copy {
  /** Bytes so far per file name. */
  bytes: Map<string, number>;
  abort: AbortController;
}

/** The models the sweep and a delete must not touch: the default's set and what is in use. */
export interface Held {
  defaults: ReadonlySet<string>;
  inUse: ReadonlySet<string>;
}

export class ModelStore {
  private readonly now: () => number;
  private readonly downloads = new Map<string, Download>();
  private readonly copies = new Map<string, Copy>();
  /** The import running, if any: a second one waits for it, so one copy owns each model. */
  private importing: Promise<unknown> = Promise.resolve();
  private readonly watchers = new Set<(e: DownloadEnd) => void>();
  private closed = false;

  constructor(private readonly o: ModelStoreOptions) {
    this.now = o.now ?? Date.now;
    this.clearStaleCopies();
  }

  /**
   * Deletes the temporary files of copies from a folder that never finished: akou quit or crashed
   * in the middle of one. Each copy writes `<file>.<random>.import`, so nothing else would ever
   * delete them. A file written in the last minute may belong to a copy still running in another
   * process (`akou models import`), so it stays.
   */
  private clearStaleCopies(): void {
    const dir = this.o.dir();
    const before = Date.now() - STALE_COPY_MS;
    try {
      for (const id of readdirSync(dir)) {
        const at = join(dir, id);
        if (!statSync(at).isDirectory()) continue;
        for (const f of readdirSync(at)) {
          if (!f.endsWith(".import")) continue;
          const path = join(at, f);
          if (statSync(path).mtimeMs < before) rmSync(path, { force: true });
        }
      }
    } catch {
      // No models folder yet, or one that cannot be read: nothing to clear.
    }
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

  /**
   * The model ids a job on `recognizer` loads: it, the runtime it runs on, and the helpers the
   * machine needs.
   */
  needs(recognizer: string): string[] {
    const machine = this.o.machine();
    if (machine === null) return [];
    const out = machine.filter((m) => m.id === recognizer || !isRecognizer(m)).map((m) => m.id);
    if (!out.includes(recognizer) && this.entry(recognizer)) out.unshift(recognizer);
    for (const id of this.o.requires?.(recognizer) ?? []) {
      if (!out.includes(id) && this.entry(id)) out.splice(1, 0, id);
    }
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
      n += f.size - (d?.bytes.get(f.name) ?? this.copies.get(m.id)?.bytes.get(f.name) ?? 0);
    }
    return n;
  }

  /**
   * Whether the models can be had (SV-M1, SV-M2): present, downloading, or allowed to start. A
   * refusal is 409 `preset_unavailable`, the code the archive keeps a row queued on.
   */
  admit(ids: readonly string[], o: { explicit?: boolean } = {}): void {
    const miss = this.missing(ids);
    if (miss.length === 0) return;
    const first = miss[0] as string;
    // `server.auto_download` is about what a client's job may fetch; a person pressing Download
    // (the Models page, `POST /models/pull`) is asking on purpose. The size and disk limits hold.
    if (!o.explicit && !this.o.autoDownload()) {
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
      const d: Download = {
        entry,
        bytes: new Map(),
        tries: 0,
        timer: null,
        abort: new AbortController(),
      };
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
        signal: d.abort.signal,
      });
    } catch (err) {
      if (this.closed || d.abort.signal.aborted) return;
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
    if (this.closed || d.abort.signal.aborted) return;
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

  /**
   * Stops one model's download on purpose (the Models page's Cancel, `POST /models/cancel`): the
   * try in flight is aborted and a retry waiting is dropped. The files already verified and the
   * partial file stay, so a later pull resumes. A job waiting on the model fails, as it does when a
   * download gives up. False when the model is not downloading.
   */
  cancel(id: string, by: string): boolean {
    const c = this.copies.get(id);
    if (c) {
      c.abort.abort();
      this.o.log("info", `model.import ${id} cancelled key ${by}`);
      return true;
    }
    const d = this.downloads.get(id);
    if (!d) return false;
    d.abort.abort();
    if (d.timer) clearTimeout(d.timer);
    this.downloads.delete(id);
    this.o.log("info", `model.download ${id} cancelled key ${by}`);
    this.announce({ model: id, ok: false, error: "the download was cancelled" });
    return true;
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
        if (now - last < days * DAY_MS || protect.has(id) || this.busy(id)) continue;
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
    return this.busy(id) ? "downloading" : "missing";
  }

  /** Downloading, or being copied from a folder. */
  private busy(id: string): boolean {
    return this.downloads.has(id) || this.copies.has(id);
  }

  /**
   * Copies the files of `catalog` from a folder on this machine (`POST /models/import`), one model
   * at a time: while a model is copied it reads as downloading with its bytes so far, as a
   * download does, and `cancel` stops its copy, which leaves its files missing. Imports run one
   * after the other.
   */
  import(
    from: string,
    catalog: readonly ModelSpecEntry[] = this.o.catalog(),
  ): Promise<{ copied: string[]; missing: string[] }> {
    const run = this.importing.then(() => this.copyAll(from, catalog));
    this.importing = run.catch(() => {});
    return run;
  }

  private async copyAll(
    from: string,
    catalog: readonly ModelSpecEntry[],
  ): Promise<{ copied: string[]; missing: string[] }> {
    const dir = this.o.dir();
    const copied: string[] = [];
    const missing: string[] = [];
    for (const m of catalog) {
      // akou is quitting: the copies stop, and the next start clears what they left.
      if (this.closed) break;
      const c: Copy = { bytes: new Map(), abort: new AbortController() };
      this.copies.set(m.id, c);
      try {
        // Cancelled, it still answers the files it copied before.
        const r = await importModels(from, dir, [m], {
          onProgress: (p) => c.bytes.set(p.name, p.bytes),
          signal: c.abort.signal,
        });
        copied.push(...r.copied);
        missing.push(...r.missing);
      } finally {
        this.copies.delete(m.id);
      }
    }
    return { copied, missing };
  }

  /** Bytes of the model on disk or fetched so far, and the catalog's total. */
  size(id: string): { bytes: number; size: number } {
    const w = this.waiting([id]);
    if (w) return { bytes: w.bytes, size: w.total };
    const m = this.entry(id);
    const size = m ? m.files.reduce((n, f) => n + f.size, 0) : 0;
    return { bytes: size, size };
  }

  /** Records one finished run of `id` here, for the page's measured speed. */
  recordRun(id: string, audioS: number, wallS: number): void {
    recordRun(this.o.dir(), id, audioS, wallS);
  }

  /**
   * Every catalog model as the Models page shows it. `held` is the caller's: the default's set
   * and what jobs, workers or the recognizer need. `setDefault` names the setting that makes a
   * model the default in this mode, or null.
   */
  list(
    held: Held,
    setDefault: (m: ModelSpecEntry) => { key: string; value: string } | null,
  ): ModelView[] {
    const ledger = this.ledger();
    const speed = readSpeed(this.o.dir());
    const days = this.o.unusedDays();
    const iso = (t: number | undefined) => (t === undefined ? null : new Date(t).toISOString());
    return this.o.catalog().map((m) => {
      const state = this.state(m.id);
      const last = state === "ready" ? ledger[m.id] : undefined;
      const kept = held.defaults.has(m.id) || held.inUse.has(m.id);
      const c = m as Partial<CatalogEntry>;
      const scores = scoresOf(m);
      return {
        id: m.id,
        kind: kindOf(m),
        job: m.job,
        // A catalog of its own (a test's, a registry's) keeps akou's words for a model it knows.
        name: c.name ?? MODEL_TEXT[m.id]?.name ?? null,
        short: c.short ?? MODEL_TEXT[m.id]?.short ?? null,
        lines: { ...(c.lines ?? MODEL_TEXT[m.id]?.lines ?? {}) },
        languages: c.languages ?? null,
        streaming: c.serves?.includes("live") ?? false,
        after_call: c.serves ? c.serves.includes("final") : true,
        from: [...new Set(m.files.map((f) => publishedAt(f.url)))],
        state,
        ...this.size(m.id),
        last_used_at: iso(last),
        evicts_at: last === undefined || kept || days === 0 ? null : iso(last + days * DAY_MS),
        default: held.defaults.has(m.id),
        in_use: held.inUse.has(m.id),
        accuracy: scoreView(scores?.accuracy),
        speed: scoreView(scores?.speed),
        measured: measuredSpeed(speed, m.id),
        set_default: setDefault(m),
      };
    });
  }

  /**
   * Fetches one catalog model on purpose (`POST /models/pull {model}`): the size cap and the free
   * space hold, `server.auto_download` does not, since a person asked.
   */
  pull(id: string): void {
    if (!this.entry(id)) {
      throw new ModelRefused(422, "unknown_model", `no model ${id} in the catalog`, {
        field: "model",
        model: id,
      });
    }
    this.admit([id], { explicit: true });
    this.fetch([id]);
  }

  /**
   * Deletes one model under the sweep's rules (SV-M6): never the default's set, one in use, or one
   * downloading. Logged as `model.deleted` with who asked.
   */
  delete(id: string, held: Held, by: string): { id: string; deleted: true; bytes: number } {
    if (!this.entry(id) || this.state(id) === "missing") {
      throw new ModelRefused(404, "not_found", `no model ${id} on disk`, { model: id });
    }
    if (held.defaults.has(id) || held.inUse.has(id)) {
      const isDefault = held.defaults.has(id);
      throw new ModelRefused(
        409,
        "model_in_use",
        isDefault
          ? `${id} is part of the default model's set; choose another default first`
          : `${id} is in use: a job, a worker or the recognizer needs it`,
        { model: id, default: isDefault },
      );
    }
    const bytes = this.remove(id);
    this.o.log("info", `model.deleted ${id} key ${by} bytes_freed ${bytes}`);
    return { id, deleted: true, bytes };
  }

  /** Deletes one model's folder and its ledger entry; the caller has checked it is free. */
  remove(id: string): number {
    // A copy from a folder too: deleting its folder would fail the copy's last step.
    if (this.busy(id)) {
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
    for (const c of this.copies.values()) c.abort.abort();
    this.watchers.clear();
  }
}
