/**
 * The vocabulary files (docs/DESIGN.md sections 3 and 5.4; REQUIREMENTS V1): one user-owned word
 * list, kept as plain YAML the user can read line by line and diff in git.
 *
 * | Scope     | Path                                          |
 * |-----------|-----------------------------------------------|
 * | global    | `<config>/vocabulary.yaml`                    |
 * | workspace | `<config>/vocabulary/<workspace>.yaml`        |
 * | extra     | any path in the workspace's `vocabulary.files` |
 *
 * `<config>` is `~/.config/akou` on macOS and Linux and `%APPDATA%\akou` on Windows. On the same
 * term (compared folded), a workspace entry wins over a global one and an extra file wins over
 * both.
 *
 * The format, version 1:
 *
 * ```yaml
 * # akou vocabulary, version 1
 * version: 1
 * entries:
 *   - term: "Kubernetes"
 *     heard: ["kubernetis", "cubernetes"]
 *     source: "user"
 *     confirmed: true
 *     added_at: "2026-09-23"
 *     decode: 5            # optional: true, false (read-time only) or a boost 1 to 5; biases
 *                          # decoding only with `asr.parakeet.decoding` beam
 *     note: "optional free text"
 * rejected: ["words the skill must not propose again"]
 * ```
 *
 * Files are parsed with Bun's built-in YAML parser, so there is no new dependency. akou writes
 * them with its own serializer that quotes every string, so a term such as `No`, `On` or `true`
 * can never come back as a boolean. akou never grows a file on its own: only the user's adds and
 * the proposals the user approved are written.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { FileVocabEntry } from "../../core/log/fold.ts";
import { tokenize } from "../../core/vocab/correct.ts";

export const VOCAB_VERSION = 1;
/** Per-entry boosts are capped here; the global boost is a constant, not a setting. */
export const MAX_ENTRY_BOOST = 5;
export const MAX_TERM_LENGTH = 100;
/**
 * Size limits. Every heard form is matched against every line on each render, so a file is
 * bounded: the bytes read, the entries, the heard forms per entry and their length (a heard form
 * is at most as long as a term), and a note. Anything over a limit is an error, never a silent cut.
 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ENTRIES = 10_000;
export const MAX_HEARD = 50;
export const MAX_NOTE_LENGTH = 1000;

export type Decode = boolean | number;
export type VocabScope = "global" | "workspace" | "extra";

export interface VocabEntry {
  term: string;
  /** Ways the recognizer has misheard the term. Empty means it is matched fuzzily. */
  heard: string[];
  /** Where the entry came from: `user`, `correction`, `calendar`, `call:<id>`, `docs:<path>`, ... */
  source: string;
  /** Unconfirmed entries are listed for review and do nothing else. */
  confirmed: boolean;
  /** `YYYY-MM-DD`. */
  added_at: string;
  decode?: Decode;
  note?: string;
}

export interface VocabFile {
  version: number;
  entries: VocabEntry[];
  /** Terms the user rejected, so they are not proposed again. */
  rejected: string[];
}

export interface VocabIssue {
  /** Index of the entry in the file, when the issue is about one entry. */
  entry?: number;
  message: string;
}

export interface ParsedVocab {
  file: VocabFile;
  /** Problems that made akou skip an entry, or the whole file. */
  errors: VocabIssue[];
  /** Problems that did not stop the entry from loading. */
  warnings: VocabIssue[];
}

const SOURCE = /^(user|correction|calendar|(call|docs|repo|export|web|agent|import):\S.*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KEYS = new Set(["term", "heard", "source", "confirmed", "added_at", "decode", "note"]);
const FILE_KEYS = new Set(["version", "entries", "rejected"]);

export function emptyVocab(): VocabFile {
  return { version: VOCAB_VERSION, entries: [], rejected: [] };
}

/** The folded key two entries are the same term under. */
export function termKey(term: string): string {
  return tokenize(term)
    .map((t) => t.folded)
    .join(" ");
}

/**
 * Why a term cannot be a vocabulary entry, or null when it can. The CLI exits 65 on a refusal.
 */
export function validateTerm(term: unknown): string | null {
  if (typeof term !== "string") {
    return "a term must be a quoted string (an unquoted `No`, `On` or `true` reads as a boolean)";
  }
  if (term.trim() === "") return "a term cannot be empty";
  if (term !== term.trim()) return "a term cannot start or end with spaces";
  if (/[\r\n\t]/.test(term)) return "a term is one line";
  if ([...term].length > MAX_TERM_LENGTH) return `a term is at most ${MAX_TERM_LENGTH} characters`;
  if (termKey(term) === "") return "a term needs at least one letter or digit";
  return null;
}

function validDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkEntry(raw: unknown, i: number, errors: VocabIssue[], warnings: VocabIssue[]) {
  const fail = (message: string) => {
    errors.push({ entry: i, message });
    return null;
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("an entry must be a mapping");
  }
  const e = raw as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) return fail(`unknown field "${k}"`);
  const termError = validateTerm(e.term);
  if (termError) return fail(termError);
  const term = e.term as string;
  let heard: string[] = [];
  if (e.heard !== undefined && e.heard !== null) {
    if (!Array.isArray(e.heard) || e.heard.some((h) => typeof h !== "string")) {
      return fail(`"heard" must be a list of quoted strings (term "${term}")`);
    }
    if (e.heard.length > MAX_HEARD) {
      return fail(`at most ${MAX_HEARD} heard forms per entry (term "${term}")`);
    }
    if ((e.heard as string[]).some((h) => [...h].length > MAX_TERM_LENGTH)) {
      return fail(`a heard form is at most ${MAX_TERM_LENGTH} characters (term "${term}")`);
    }
    heard = (e.heard as string[]).map((h) => h.trim()).filter((h) => h !== "");
    const key = termKey(term);
    const same = heard.filter((h) => termKey(h) === key);
    if (same.length > 0) {
      warnings.push({ entry: i, message: `heard form equal to the term ignored: "${same[0]}"` });
      heard = heard.filter((h) => termKey(h) !== key);
    }
  }
  if (typeof e.source !== "string" || !SOURCE.test(e.source)) {
    return fail(`"source" must be user, correction, calendar or kind:detail (term "${term}")`);
  }
  if (typeof e.confirmed !== "boolean")
    return fail(`"confirmed" must be true or false (term "${term}")`);
  if (typeof e.added_at !== "string" || !validDate(e.added_at)) {
    return fail(`"added_at" must be a quoted date, "YYYY-MM-DD" (term "${term}")`);
  }
  const entry: VocabEntry = {
    term,
    heard,
    source: e.source,
    confirmed: e.confirmed,
    added_at: e.added_at,
  };
  if (e.decode !== undefined) {
    const d = e.decode;
    const ok =
      typeof d === "boolean" ||
      (typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= MAX_ENTRY_BOOST);
    if (!ok)
      return fail(
        `"decode" must be true, false or a whole boost 1 to ${MAX_ENTRY_BOOST} (term "${term}")`,
      );
    entry.decode = d as Decode;
  }
  if (e.note !== undefined) {
    if (typeof e.note !== "string") return fail(`"note" must be a quoted string (term "${term}")`);
    if ([...e.note].length > MAX_NOTE_LENGTH) {
      return fail(`a note is at most ${MAX_NOTE_LENGTH} characters (term "${term}")`);
    }
    entry.note = e.note;
  }
  return entry;
}

/** Parses a vocabulary file. A bad entry is skipped with an error; the rest still load. */
export function parseVocab(text: string): ParsedVocab {
  const errors: VocabIssue[] = [];
  const warnings: VocabIssue[] = [];
  const file = emptyVocab();
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    errors.push({ message: `the file is too large; the limit is ${MAX_FILE_BYTES} bytes` });
    return { file, errors, warnings };
  }
  if (text.trim() === "") return { file, errors, warnings };
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (err) {
    errors.push({ message: `not valid YAML: ${(err as Error).message}` });
    return { file, errors, warnings };
  }
  if (doc === null || doc === undefined) return { file, errors, warnings };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    errors.push({ message: "the file must be a mapping with version and entries" });
    return { file, errors, warnings };
  }
  const d = doc as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    if (!FILE_KEYS.has(k)) warnings.push({ message: `unknown top-level field "${k}" ignored` });
  }
  if (d.version !== VOCAB_VERSION) {
    errors.push({
      message: `unsupported version ${JSON.stringify(d.version)}; expected ${VOCAB_VERSION}`,
    });
    return { file, errors, warnings };
  }
  const entries = d.entries ?? [];
  if (!Array.isArray(entries)) {
    errors.push({ message: '"entries" must be a list' });
    return { file, errors, warnings };
  }
  if (entries.length > MAX_ENTRIES) {
    errors.push({
      message: `the file has ${entries.length} entries; only the first ${MAX_ENTRIES} entries are read`,
    });
  }
  const seen = new Map<string, number>();
  entries.slice(0, MAX_ENTRIES).forEach((raw, i) => {
    const entry = checkEntry(raw, i, errors, warnings);
    if (!entry) return;
    const key = termKey(entry.term);
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push({ entry: i, message: `"${entry.term}" is already entry ${first}; skipped` });
      return;
    }
    seen.set(key, i);
    file.entries.push(entry);
  });
  if (d.rejected !== undefined && d.rejected !== null) {
    if (!Array.isArray(d.rejected) || d.rejected.some((r) => typeof r !== "string")) {
      errors.push({ message: '"rejected" must be a list of quoted strings' });
    } else if (
      d.rejected.length > MAX_ENTRIES ||
      (d.rejected as string[]).some((r) => [...r].length > MAX_TERM_LENGTH)
    ) {
      errors.push({
        message: `"rejected" is at most ${MAX_ENTRIES} terms of at most ${MAX_TERM_LENGTH} characters`,
      });
    } else {
      file.rejected = d.rejected as string[];
    }
  }
  return { file, errors, warnings };
}

/** A YAML double-quoted scalar. JSON string escapes are valid YAML escapes. */
function q(s: string): string {
  return JSON.stringify(s);
}

/** Writes a vocabulary file. Every string is quoted; the output parses back to the same file. */
export function serializeVocab(file: VocabFile): string {
  const out = [`# akou vocabulary, version ${VOCAB_VERSION}`, `version: ${VOCAB_VERSION}`];
  if (file.entries.length === 0) out.push("entries: []");
  else out.push("entries:");
  for (const e of file.entries) {
    out.push(`  - term: ${q(e.term)}`);
    out.push(`    heard: [${e.heard.map(q).join(", ")}]`);
    out.push(`    source: ${q(e.source)}`);
    out.push(`    confirmed: ${e.confirmed ? "true" : "false"}`);
    out.push(`    added_at: ${q(e.added_at)}`);
    if (e.decode !== undefined) out.push(`    decode: ${String(e.decode)}`);
    if (e.note !== undefined) out.push(`    note: ${q(e.note)}`);
  }
  if (file.rejected.length > 0) out.push(`rejected: [${file.rejected.map(q).join(", ")}]`);
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Files on disk

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface LoadedVocab extends ParsedVocab {
  path: string;
  exists: boolean;
  /** Hash of the bytes read, for `vocab.used`. Empty when the file does not exist. */
  sha256: string;
}

/** Reads a vocabulary file. A missing file is an empty list, not an error. */
export async function readVocabFile(path: string): Promise<LoadedVocab> {
  let text: string;
  try {
    // The size is checked before the bytes are read.
    const size = (await stat(path)).size;
    if (size > MAX_FILE_BYTES) {
      return {
        path,
        exists: true,
        sha256: "",
        file: emptyVocab(),
        errors: [{ message: `the file is too large; the limit is ${MAX_FILE_BYTES} bytes` }],
        warnings: [],
      };
    }
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, sha256: "", file: emptyVocab(), errors: [], warnings: [] };
    }
    throw err;
  }
  return { path, exists: true, sha256: sha256(text), ...parseVocab(text) };
}

/**
 * Writes a vocabulary file atomically (a temporary file renamed over the old one). Refuses a file
 * whose serialized form would not read back identically: one the reader would reject, or one it
 * would read as something else (a heard form equal to the term, a padded form).
 */
export async function writeVocabFile(path: string, file: VocabFile): Promise<string> {
  const text = serializeVocab(file);
  const back = parseVocab(text);
  if (back.errors.length > 0) {
    throw new Error(`refusing to write ${basename(path)}: ${back.errors[0]?.message}`);
  }
  if (serializeVocab(back.file) !== text) {
    const why = back.warnings[0]?.message ?? "it would read back differently";
    throw new Error(`refusing to write ${basename(path)}: ${why}`);
  }
  await mkdir(dirname(path), { recursive: true });
  // One temporary file per write: two writes to one path must not share it.
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, text, { encoding: "utf8", flag: "wx" });
    await renameReplacing(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return sha256(text);
}

/** Error codes Windows gives for a moment while another rename or a reader holds the target. */
const RENAME_BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * `rename` over an existing file. On Windows a replace fails briefly while another write to the
 * same path is replacing it or a reader has it open; that is retried for under a second, as
 * graceful-fs does. Any other error is thrown at once.
 */
export async function renameReplacing(
  from: string,
  to: string,
  op: (from: string, to: string) => Promise<void> = rename,
  tries = 12,
): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await op(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i >= tries - 1 || !RENAME_BUSY.has(code)) throw err;
      await new Promise((r) => setTimeout(r, Math.min(100, 5 * 2 ** i)));
    }
  }
}

/** `~/.config/akou` on macOS and Linux, `%APPDATA%\akou` on Windows. */
export function defaultConfigDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "akou");
  return join(home, ".config", "akou");
}

/**
 * Workspace names become file names; anything that could leave the folder is refused, and so is a
 * Windows device name (`con.yaml` is the console there, whatever follows the first dot).
 */
export function validWorkspace(name: string): boolean {
  return (
    /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(name) &&
    !name.includes("..") &&
    !WINDOWS_DEVICE.test(name)
  );
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i;

export interface VocabPath {
  scope: VocabScope;
  path: string;
}

/** The files that make up a workspace's vocabulary, lowest priority first. */
export function vocabPaths(opts: {
  configDir: string;
  workspace?: string;
  extra?: readonly string[];
}): VocabPath[] {
  const out: VocabPath[] = [{ scope: "global", path: join(opts.configDir, "vocabulary.yaml") }];
  if (opts.workspace !== undefined) {
    if (!validWorkspace(opts.workspace))
      throw new Error(`invalid workspace name "${opts.workspace}"`);
    out.push({
      scope: "workspace",
      path: join(opts.configDir, "vocabulary", `${opts.workspace}.yaml`),
    });
  }
  for (const p of opts.extra ?? []) out.push({ scope: "extra", path: p });
  return out;
}

// ---------------------------------------------------------------------------
// Merging and editing

export interface MergedEntry extends VocabEntry {
  scope: VocabScope;
  file: string;
}

const SCOPE_RANK: Record<VocabScope, number> = { extra: 0, workspace: 1, global: 2 };

/**
 * Merges the files of a workspace. On the same term an extra file wins over the workspace file,
 * which wins over the global file; later extra files win over earlier ones. The result is in
 * priority order: extra, workspace, global, each in file order.
 */
export function mergeVocab(
  layers: readonly { scope: VocabScope; path: string; file: VocabFile }[],
): MergedEntry[] {
  const byKey = new Map<string, MergedEntry & { layer: number }>();
  layers.forEach((layer, li) => {
    for (const e of layer.file.entries) {
      const key = termKey(e.term);
      const cur = byKey.get(key);
      const rank = SCOPE_RANK[layer.scope];
      if (
        cur &&
        (SCOPE_RANK[cur.scope] < rank || (SCOPE_RANK[cur.scope] === rank && cur.layer > li))
      ) {
        continue;
      }
      byKey.set(key, {
        ...e,
        heard: [...e.heard],
        scope: layer.scope,
        file: layer.path,
        layer: li,
      });
    }
  });
  return [...byKey.values()]
    .sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || b.layer - a.layer)
    .map(({ layer: _l, ...e }) => e);
}

/** The read-time view of the merged list, as the fold takes it. */
export function toFoldEntries(merged: readonly MergedEntry[]): FileVocabEntry[] {
  return merged.map((e) => ({ term: e.term, heard: e.heard, confirmed: e.confirmed }));
}

/** Adds or replaces the entry with the same term. Returns a new file. */
export function upsertEntry(file: VocabFile, entry: VocabEntry): VocabFile {
  const key = termKey(entry.term);
  const entries = file.entries.filter((e) => termKey(e.term) !== key);
  const at = file.entries.findIndex((e) => termKey(e.term) === key);
  entries.splice(at < 0 ? entries.length : at, 0, entry);
  return { ...file, entries };
}

/** Removes the entry with this term, if any. Returns a new file. */
export function removeEntry(file: VocabFile, term: string): VocabFile {
  const key = termKey(term);
  return { ...file, entries: file.entries.filter((e) => termKey(e.term) !== key) };
}

// ---------------------------------------------------------------------------
// Importing the older formats

export interface ImportResult {
  entries: VocabEntry[];
  skipped: { line: number; text: string; reason: string }[];
}

const CAUTION = /\bcaution\b|\bdo not auto\b/i;

/**
 * Converts the predecessor's list formats: `Canonical <= variant | variant  # comment` lines, and
 * a plain list of one name per line. A line marked `CAUTION` or `do not auto` imports with
 * `decode: false` and no heard forms: the old list said not to apply it automatically. Blank lines
 * and `#` comments are skipped. The user asked for the import, so entries are confirmed.
 */
export function importGlossary(
  text: string,
  opts: { source: string; date: string; confirmed?: boolean },
): ImportResult {
  const entries: VocabEntry[] = [];
  const byKey = new Map<string, VocabEntry>();
  const skipped: ImportResult["skipped"] = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    // A comment is a `#` after whitespace, so a term such as `C#` keeps its `#`.
    const hash = line.search(/\s#/);
    const body = (hash >= 0 ? line.slice(0, hash) : line).trim();
    const comment = hash >= 0 ? line.slice(hash).trim().slice(1).trim() : "";
    const caution = CAUTION.test(line);
    const [left, right] = body.includes("<=") ? body.split("<=", 2) : [body, undefined];
    const term = (left ?? "").trim();
    const err = validateTerm(term);
    if (err) {
      skipped.push({ line: i + 1, text: rawLine, reason: err });
      return;
    }
    const key = termKey(term);
    const heard = caution
      ? []
      : (right ?? "")
          .split("|")
          .map((h) => h.trim())
          .filter((h) => h !== "" && termKey(h) !== key);
    const existing = byKey.get(key);
    if (existing) {
      for (const h of heard) if (!existing.heard.includes(h)) existing.heard.push(h);
      if (caution) {
        existing.decode = false;
        existing.heard = [];
      }
      return;
    }
    const entry: VocabEntry = {
      term,
      heard,
      source: opts.source,
      confirmed: opts.confirmed ?? true,
      added_at: opts.date,
    };
    if (caution) entry.decode = false;
    if (comment && !/^caution$/i.test(comment)) entry.note = comment;
    byKey.set(key, entry);
    entries.push(entry);
  });
  return { entries, skipped };
}
