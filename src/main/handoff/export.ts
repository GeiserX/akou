/**
 * The export folder (docs/DESIGN.md section 8.2, item 1): a finished call leaves as one Markdown
 * file with frontmatter, plus a sibling `attachments/<name>/` holding a copy of the event log and
 * the audio (a link, a copy, or nothing).
 *
 *   <export.dir>/<workspace>/2026-09-23 1536 Weekly sync.md
 *   <export.dir>/<workspace>/attachments/2026-09-23 1536 Weekly sync/events.jsonl
 *   <export.dir>/<workspace>/attachments/2026-09-23 1536 Weekly sync/part-001.opus
 *
 * Rules:
 *
 * - **Idempotent.** The file is rendered with the revision last written; when that is what is on
 *   disk, nothing is written and no `export.done` is due. Otherwise the revision goes up by one.
 * - **Found by `akou_id`.** A re-export looks for the file by the id in its frontmatter, so a file
 *   the user renamed is still found.
 * - **Never over the user's edits.** A file whose SHA-256 is not one akou wrote (every `export.done`
 *   records it) was edited, so the new version goes beside it as `… (akou update).md`.
 * - **Atomic.** Every file is written to a temporary name and renamed into place.
 * - **Names safe on Windows.** No `<>:"/\|?*` or control characters, no trailing dot or space, and
 *   a bounded length.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatLocalDate, formatWall } from "../../core/log/clock.ts";
import type { EventDraft } from "../../core/log/events.ts";
import type { CallView, Line } from "../../core/log/fold.ts";
import { EVENTS_FILE } from "../../core/log/writer.ts";
import { CITATION } from "../notes/cite-check.ts";

export type AudioMode = "link" | "copy" | "none";

/** What the frontmatter says about a call, and what a hook or the webhook gets as `call`. */
export interface CallMeta {
  akou_id: string;
  title: string;
  /** ISO 8601 local time with the offset: `2026-09-23T15:36:12-05:00`. */
  start: string;
  end: string;
  duration_min: number;
  workspace: string;
  participants: string[];
  /** Only when a model reported them. */
  languages?: string[];
  template?: string;
  transcript_layer: "final" | "live" | "mixed";
  source: string;
  shared: boolean;
  tz: string;
}

// ---------------------------------------------------------------------------
// Times

function offsetOf(w: number, tz: string): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(new Date(w))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
  if (!m) return "+00:00";
  return `${m[1]}${(m[2] as string).padStart(2, "0")}:${m[3] ?? "00"}`;
}

/** `2026-09-23T15:36:12-05:00`: local wall-clock time in the call's zone, with its offset. */
export function isoLocal(w: number, tz: string): string {
  return `${formatLocalDate(w, tz)}T${formatWall(w, tz, { seconds: true })}${offsetOf(w, tz)}`;
}

/** When the call's audio ended: the latest part end on its clock, or the latest line. */
export function callEnd(view: CallView): number {
  let end = 0;
  for (const p of view.parts()) {
    end = Math.max(end, p.ended ? p.clock.wallFromAudio(p.ended.fileSeconds) : p.wallStart);
  }
  for (const l of view.lines("best")) end = Math.max(end, l.w1);
  return end || (view.call?.t ?? 0);
}

export function callStart(view: CallView): number {
  const first = view.parts()[0];
  return first ? first.wallStart : (view.call?.t ?? 0);
}

// ---------------------------------------------------------------------------
// Names

const WINDOWS_FORBIDDEN = /[<>:"/\\|?*]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
const CONTROL = /[\u0000-\u001f\u007f]/g;
export const MAX_TITLE_CHARS = 80;

/** A title as a file-name part that is valid on Windows, macOS and Linux. */
export function safeFileTitle(title: string): string {
  let s = title
    .normalize("NFC")
    .replace(CONTROL, " ")
    .replace(WINDOWS_FORBIDDEN, "-")
    .replace(/\s+/g, " ")
    .trim();
  if ([...s].length > MAX_TITLE_CHARS) s = [...s].slice(0, MAX_TITLE_CHARS).join("");
  // Windows drops a trailing dot or space, so two names could collide on it.
  s = s
    .replace(/-{2,}/g, "-")
    .replace(/[. -]+$/g, "")
    .replace(/^[. -]+/g, "");
  return s || "Call";
}

/** `2026-09-23 1536 Weekly sync`, from the local start time, so a late call files under its day. */
export function exportBaseName(view: CallView): string {
  const tz = view.call?.tz ?? "UTC";
  const start = callStart(view);
  const hhmm = formatWall(start, tz, { seconds: false }).replace(":", "");
  return `${formatLocalDate(start, tz)} ${hhmm} ${safeFileTitle(view.call?.title ?? "")}`;
}

// ---------------------------------------------------------------------------
// Rendering

/** Speakers in order of first appearance, merged and named; your side marked as you. */
export function participants(view: CallView): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of view.lines("best")) {
    if (seen.has(l.spk)) continue;
    seen.add(l.spk);
    out.push(l.ch === "mic" ? `${l.speaker} (you)` : l.speaker);
  }
  return out;
}

export function transcriptLayer(view: CallView): CallMeta["transcript_layer"] {
  const parts = view.parts();
  const done = parts.filter((p) => p.finalDone).length;
  if (parts.length > 0 && done === parts.length) return "final";
  return done === 0 ? "live" : "mixed";
}

export function callMeta(view: CallView, version: string): CallMeta {
  const c = view.call;
  const tz = c?.tz ?? "UTC";
  const start = callStart(view);
  const end = Math.max(start, callEnd(view));
  const languages = view.final.done?.languages ?? [];
  return {
    akou_id: c?.id ?? "",
    title: c?.title ?? "",
    start: isoLocal(start, tz),
    end: isoLocal(end, tz),
    duration_min: Math.round((end - start) / 60_000),
    workspace: c?.workspace ?? "",
    participants: participants(view),
    ...(languages.length > 0 ? { languages: [...languages] } : {}),
    ...(c?.template ? { template: c.template } : {}),
    transcript_layer: transcriptLayer(view),
    source: `akou ${version}`,
    shared: view.share.active || view.share.started !== undefined,
    tz,
  };
}

const PLAIN = /^[\p{L}\p{N}][\p{L}\p{N} _.,'()/+&@-]*$/u;
const YAML_WORDS = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

/** A YAML scalar: plain when that is unambiguous, else a JSON string (valid YAML). */
export function yamlScalar(v: string | number | boolean): string {
  if (typeof v !== "string") return String(v);
  const flowSafe = PLAIN.test(v) && !v.includes(",") && !v.endsWith(" ");
  if (flowSafe && !YAML_WORDS.test(v) && !/^[\d.+-]+$/.test(v) && !v.includes(": ")) return v;
  return JSON.stringify(v);
}

function yamlList(items: readonly string[]): string {
  return `[${items.map(yamlScalar).join(", ")}]`;
}

export function frontmatter(meta: CallMeta, audio: readonly string[], rev: number): string {
  const rows: [string, string][] = [
    ["akou_id", meta.akou_id],
    ["title", yamlScalar(meta.title)],
    ["start", meta.start],
    ["end", meta.end],
    ["duration_min", String(meta.duration_min)],
    ["workspace", yamlScalar(meta.workspace)],
    ["participants", yamlList(meta.participants)],
  ];
  if (meta.languages) rows.push(["languages", yamlList(meta.languages)]);
  if (meta.template) rows.push(["template", yamlScalar(meta.template)]);
  rows.push(
    ["transcript_layer", meta.transcript_layer],
    ["audio", yamlList(audio)],
    ["source", yamlScalar(meta.source)],
    ["shared", String(meta.shared)],
    ["akou_rev", String(rev)],
  );
  return `---\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`;
}

/** A transcript line that would otherwise read as a heading, quote or list item is escaped. */
function mdText(text: string): string {
  return text.replace(/^(\s*)([#>*+-]|\d+[.)])(?=\s|$)/, "$1\\$2");
}

/** The transcript: a speaker and wall time on each change of speaker, and at least every minute. */
export function renderTranscript(lines: readonly Line[], tz: string): string {
  const out: string[] = [];
  let spk: string | null = null;
  let since = 0;
  for (const l of lines) {
    if (l.spk !== spk || l.w0 - since > 60_000) {
      if (out.length > 0) out.push("");
      out.push(`**${l.speaker}** · ${formatWall(l.w0, tz)}`);
      spk = l.spk;
      since = l.w0;
    }
    out.push(mdText(l.annotated));
  }
  return out.join("\n");
}

/**
 * The export's `## Transcript` section. The window's "Copy transcript so far" (WINDOW W12.2) copies
 * exactly this, through `GET /calls/{id}/transcript?format=export`.
 */
export function renderTranscriptSection(lines: readonly Line[], tz: string): string {
  return [
    "## Transcript",
    `_Times are ${tz}._`,
    "",
    renderTranscript(lines, tz) || "_No transcript lines._",
  ].join("\n");
}

/** A bracketed group of citations, as the model writes them: `[#l000031 #l000045]`. */
const BRACKETED = /\[\s*(#[lf]\d{6,}(?:\s+#[lf]\d{6,})*)\s*\]/g;

/**
 * Enhanced notes for a person's knowledge base: headings one level down, under `## Notes`, and
 * each segment citation as the wall time and speaker it points at. A `#l000031` would otherwise be
 * a tag in Obsidian and mean nothing to a reader. The user's own lines are left exactly as stored.
 */
export function renderEnhanced(markdown: string, view: CallView, tz: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => {
      if (/_\(your note, [^)]*\)_\s*$/.test(line)) return line;
      const demoted = /^#{1,5} /.test(line) ? `#${line}` : line;
      const cite = (all: string, id: string) => {
        const l = view.resolve(id);
        return l ? `[${formatWall(l.w0, tz)} ${l.speaker}]` : all;
      };
      // `[#l000031 #l000045]` becomes `[15:41:07 Ben] [15:42:10 Ana]`, never `[[..]]`, which
      // Obsidian would read as a link to a note; a bare `#l000031` is replaced on its own.
      return demoted
        .replace(BRACKETED, (_all, ids: string) =>
          ids
            .trim()
            .split(/\s+/)
            .map((p) => cite(p, p.slice(1)))
            .join(" "),
        )
        .replace(new RegExp(CITATION.source, "g"), cite);
    })
    .join("\n");
}

export function renderNotes(view: CallView, tz: string): string {
  return view
    .notes()
    .map((n) => {
      const who = n.author === "agent" ? ` _(agent: ${n.client ?? n.by.slice(6)})_` : "";
      return `- ${formatWall(n.w, tz)} ${n.text}${who}`;
    })
    .join("\n");
}

export interface RenderInput {
  view: CallView;
  version: string;
  /** Enhanced notes body, or null. */
  enhanced: string | null;
  /** Audio paths relative to the Markdown file. */
  audio: readonly string[];
  rev: number;
}

export function renderExport(o: RenderInput): string {
  const meta = callMeta(o.view, o.version);
  const tz = meta.tz;
  const notes = renderNotes(o.view, tz);
  const sections = [
    "## Notes",
    o.enhanced ? renderEnhanced(o.enhanced, o.view, tz) : "_Not enhanced yet._",
    "",
    "## Your raw notes",
    notes || "_No notes._",
    "",
    renderTranscriptSection(o.view.lines("best"), tz),
  ];
  return `${frontmatter(meta, o.audio, o.rev)}${sections.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Files

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, data, { flag: "wx" });
  try {
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

function copyAtomic(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = join(dirname(dst), `.${basename(dst)}.${randomBytes(6).toString("hex")}.tmp`);
  // A clone where the file system has them (APFS, Btrfs), a plain copy elsewhere.
  copyFileSync(src, tmp, constants.COPYFILE_FICLONE);
  try {
    renameSync(tmp, dst);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

/** The `akou_id` in a Markdown file's frontmatter, reading only its head. */
export function frontmatterId(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = new Uint8Array(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = new TextDecoder().decode(buf.subarray(0, n));
    if (!head.startsWith("---")) return null;
    const m = /^akou_id:\s*"?([0-9A-Z]{26})"?\s*$/m.exec(head.split(/\n---/)[0] ?? "");
    return m ? (m[1] as string) : null;
  } finally {
    closeSync(fd);
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `name.md` → `name (akou update).md`, `name (akou update 2).md`, … */
function updateName(path: string, n: number): string {
  const stem = basename(path, ".md").replace(/ \(akou update(?: \d+)?\)$/, "");
  return join(dirname(path), `${stem} (akou update${n > 1 ? ` ${n}` : ""}).md`);
}

export interface ExportOptions {
  view: CallView;
  /** The call folder. */
  dir: string;
  /** `export.dir`, or the folder `--to` names. */
  root: string;
  audio: AudioMode;
  version: string;
  /** Warnings (a link that fell back to a copy). */
  onWarn?(msg: string): void;
}

export interface ExportResult {
  path: string;
  sha256: string;
  /** False when the file already said exactly this. */
  written: boolean;
  /** Written beside a file the user edited. */
  update: boolean;
  rev: number;
  attachments: string;
  /** The `export.done` to append when something was written. */
  draft: EventDraft | null;
}

/** The Markdown file this call exports to, and whether it is beside an edited one. */
function pickTarget(
  folder: string,
  base: string,
  id: string,
  ours: ReadonlySet<string>,
): { path: string; update: boolean } {
  const found: string[] = [];
  const main = join(folder, `${base}.md`);
  if (existsSync(folder)) {
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".md")) continue;
      const p = join(folder, name);
      if (frontmatterId(p) === id) found.push(p);
    }
  }
  const isOurs = (p: string) => {
    const t = readText(p);
    return t !== null && ours.has(sha256(t));
  };
  const unedited = found.filter(isOurs);
  if (unedited.length > 0) {
    const plain = unedited.find((p) => !/ \(akou update(?: \d+)?\)\.md$/.test(p));
    return { path: plain ?? (unedited[0] as string), update: plain === undefined };
  }
  if (found.length > 0) {
    // Every copy was edited by the user: the new version goes beside the main one.
    const first = found.find((p) => !/ \(akou update(?: \d+)?\)\.md$/.test(p)) ?? found[0];
    for (let n = 1; n < 100; n++) {
      const p = updateName(first as string, n);
      if (!existsSync(p)) return { path: p, update: true };
    }
    throw new Error(`too many "(akou update)" files beside ${first}`);
  }
  // A file of the same name that is not this call's is never touched.
  for (let n = 1; n < 100; n++) {
    const p = n === 1 ? main : join(folder, `${base} (${n}).md`);
    if (!existsSync(p)) return { path: p, update: false };
  }
  throw new Error(`no free name for ${base}.md in ${folder}`);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Puts one audio part into the attachments folder: a symlink, a copy, or (link failing) a copy. */
function placeAudio(src: string, dst: string, mode: AudioMode, warn: (m: string) => void): void {
  if (mode === "link") {
    if (exists(dst)) return;
    try {
      symlinkSync(src, dst);
      return;
    } catch (err) {
      warn(`cannot link ${basename(dst)} (${(err as Error).message}); copied it instead`);
    }
  }
  if (exists(dst) && statSync(dst).size === statSync(src).size) return;
  copyAtomic(src, dst);
}

/** Exports one call. Writes nothing when the export already says exactly this. */
export function exportCall(o: ExportOptions): ExportResult {
  const view = o.view;
  const c = view.call;
  if (!c) throw new Error("the call has no call.created");
  const warn = o.onWarn ?? (() => {});
  const folder = join(o.root, c.workspace);
  const base = exportBaseName(view);
  const attachments = join(folder, "attachments", base);
  const known = view.handoff().exports;
  const ours = new Set(known.map((e) => e.sha256));
  const target = pickTarget(folder, base, c.id, ours);

  // Attachments: the log, then the audio parts that exist.
  mkdirSync(attachments, { recursive: true });
  const audio: string[] = [];
  if (o.audio !== "none") {
    for (const p of view.parts()) {
      const src = join(o.dir, p.file);
      if (!existsSync(src)) continue;
      const name = basename(p.file);
      placeAudio(src, join(attachments, name), o.audio, warn);
      audio.push(`attachments/${base}/${name}`);
    }
  }
  const latest = view.latestEnhanced();
  const enhanced = latest ? readText(join(o.dir, latest.file)) : null;
  const render = (rev: number) => renderExport({ view, version: o.version, enhanced, audio, rev });
  const current = readText(target.path);
  // The revision this file was last written with; exports to other folders count elsewhere.
  const onDisk = current ? /^akou_rev:\s*(\d+)\s*$/m.exec(current.split(/\n---/)[0] ?? "") : null;
  const lastRev = onDisk ? Number(onDisk[1]) : known.length;
  const same = render(lastRev);
  let written = false;
  let text = same;
  let rev = lastRev;
  if (current !== same) {
    rev = lastRev + 1;
    text = render(rev);
    writeAtomic(target.path, text);
    written = true;
  }
  // The log copy last, so it holds everything up to this export.
  const log = join(o.dir, EVENTS_FILE);
  if (existsSync(log)) copyAtomic(log, join(attachments, EVENTS_FILE));
  const digest = sha256(text);
  return {
    path: target.path,
    sha256: digest,
    written,
    update: target.update,
    rev,
    attachments,
    draft: written ? { type: "export.done", path: target.path, sha256: digest } : null,
  };
}
