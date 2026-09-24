/**
 * `akou import hark-viewer DIR…` (docs/DESIGN.md section 6.1, REQUIREMENTS I2.10 to I2.12): turns a
 * predecessor call folder into an akou call folder with an event log, every part included.
 *
 * The predecessor's folder, as hark-viewer's `server.py` and `postprocess.py` write it:
 *
 *   meta.json               {started: epoch s, workspace, title, id, parts?: [{n, audio,
 *                           transcript, started}]}. A call never restarted has no `parts`; its one
 *                           part is `audio.opus` + `transcript.json`.
 *   audio.opus              part 1; later parts are `audio.partN.opus`. Stereo: mic left, call right.
 *   transcript.json         hark's live lines, JSON Lines `{start, end, text, speaker?}` in seconds on
 *                           the part's own clock; later parts `transcript.partN.json`. Speakers are
 *                           `You` (the mic), `Speaker N` (live diarization) or `Others`.
 *   transcript.speakers.json the same lines as `transcript.json` with better speakers, written by the
 *                           offline relabel; used in its place while it is the newer file.
 *   transcript.final.json   hark's accurate pass over every part, on the CALL's clock, speakers
 *                           `Microphone` and `Others`.
 *   postprocess.json        the state of that pass: `steps.final.{state, skipped_spans, warning}`
 *                           and `steps.languages.languages.present`.
 *
 * What it becomes: `part.started` / `part.ended` per part with the part's wall-clock anchor, live
 * `seg` lines, and, when the accurate pass finished, final `seg` lines with `final.part.done` per part
 * and `final.done`. Speakers: the mic is `you`; `Speaker N` becomes a cluster of its own per part
 * (hark numbered speakers afresh in every part, so two parts' `Speaker 1` are not known to be one
 * person; `akou name --merge` joins them); `Others` is the unknown call speaker `c?`. A final line on
 * the call side takes the live speaker it overlaps most. Every event's `t` is the time it describes,
 * so the imported call sorts among the others by when it happened.
 *
 * The call id is derived from the source (its hark id, start and folder name), so importing the same
 * folder twice is refused instead of making a second copy. Audio is copied (a clone on file systems
 * that have them). A failed import removes the folder it created.
 */

import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { EventDraft, Seg } from "../../core/log/events.ts";
import { LogWriter } from "../../core/log/writer.ts";
import { checkWorkspace, createCallFolder, partFile, ulid } from "../call/folder.ts";
import { opusDurationSeconds } from "../call/recovery.ts";

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/** One line as hark wrote it, seconds. */
export interface HvLine {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface HvPart {
  n: number;
  audio: string;
  transcript: string;
  /** Epoch seconds, or null when the folder does not say. */
  started: number | null;
}

export interface HvFolder {
  dir: string;
  /** Epoch ms of the call's start. */
  startMs: number;
  title: string;
  workspace: string | null;
  harkId: string | null;
  parts: HvPart[];
  /** Live lines per part, on the part's clock. */
  live: Map<number, HvLine[]>;
  /** The accurate pass, on the call's clock, or null when it did not finish. */
  final: HvLine[] | null;
  finalState: { skipped: unknown[]; warning?: string; languages?: string[]; finishedMs?: number };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** JSON Lines of `{start, end, text}`; a torn or odd line is skipped, as hark-viewer skips it. */
export function readLines(path: string): HvLine[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: HvLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let e: unknown;
    try {
      e = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    if (typeof o.text !== "string" || o.text.trim() === "") continue;
    const start = typeof o.start === "number" && Number.isFinite(o.start) ? o.start : null;
    if (start === null) continue;
    const end =
      typeof o.end === "number" && Number.isFinite(o.end) ? Math.max(o.end, start) : start;
    out.push({
      start: Math.max(0, start),
      end: Math.max(0, end),
      text: o.text.trim(),
      ...(typeof o.speaker === "string" ? { speaker: o.speaker } : {}),
    });
  }
  return out;
}

/** `2026-09-21_153038[_slug]` read as local time on this machine, in epoch ms. */
function startFromName(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as number[];
  const t = new Date(y as number, (mo as number) - 1, d, h, mi, s).getTime();
  return Number.isFinite(t) ? t : null;
}

function titleFromName(name: string): string {
  const m = /^\d{4}-\d{2}-\d{2}_\d{6}(?:-\d+)?_(.+)$/.exec(name);
  return m ? (m[1] as string).replace(/[-_]+/g, " ").trim() : "";
}

/** The part's transcript: `transcript.speakers.json` for part 1 while it is the newer file. */
function liveFile(dir: string, part: HvPart): string {
  const live = join(dir, part.transcript);
  if (part.transcript === "transcript.json") {
    const better = join(dir, "transcript.speakers.json");
    if (existsSync(better)) {
      if (!existsSync(live) || statSync(better).mtimeMs >= statSync(live).mtimeMs) return better;
    }
  }
  return live;
}

/** Reads a hark-viewer call folder. Throws `ImportError` when it is not one. */
export function readHarkViewerFolder(dir: string): HvFolder {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ImportError(`${dir} is not a folder`);
  }
  const metaRaw = readJson(join(dir, "meta.json"));
  const meta =
    typeof metaRaw === "object" && metaRaw !== null && !Array.isArray(metaRaw)
      ? (metaRaw as Record<string, unknown>)
      : {};
  const rawParts = Array.isArray(meta.parts)
    ? (meta.parts as unknown[]).filter(
        (p): p is Record<string, unknown> =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as Record<string, unknown>).audio === "string" &&
          typeof (p as Record<string, unknown>).transcript === "string",
      )
    : [];
  const parts: HvPart[] =
    rawParts.length > 0
      ? rawParts.map((p, i) => ({
          n: typeof p.n === "number" && Number.isInteger(p.n) ? p.n : i + 1,
          audio: basename(p.audio as string),
          transcript: basename(p.transcript as string),
          started: typeof p.started === "number" ? p.started : null,
        }))
      : [
          {
            n: 1,
            audio: "audio.opus",
            transcript: "transcript.json",
            started: typeof meta.started === "number" ? meta.started : null,
          },
        ];
  parts.sort((a, b) => a.n - b.n);
  const hasAny = parts.some(
    (p) => existsSync(join(dir, p.audio)) || existsSync(join(dir, p.transcript)),
  );
  if (!hasAny && !existsSync(join(dir, "meta.json"))) {
    throw new ImportError(
      `${dir} is not a hark-viewer call folder (no meta.json, audio or transcript)`,
    );
  }
  let startMs: number | null = typeof meta.started === "number" ? meta.started * 1000 : null;
  startMs ??= parts[0]?.started != null ? (parts[0].started as number) * 1000 : null;
  startMs ??= startFromName(basename(dir));
  if (startMs === null) {
    const audio = join(dir, parts[0]?.audio ?? "audio.opus");
    if (existsSync(audio)) startMs = statSync(audio).birthtimeMs || statSync(audio).mtimeMs;
  }
  if (startMs === null || !Number.isFinite(startMs)) {
    throw new ImportError(`${dir} has no start time (meta.json "started", its name or its audio)`);
  }
  const live = new Map<number, HvLine[]>();
  for (const p of parts) live.set(p.n, readLines(liveFile(dir, p)));

  // The accurate pass counts only when it finished.
  const status = readJson(join(dir, "postprocess.json")) as Record<string, unknown> | null;
  const steps = (status?.steps ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const finalStep = steps.final;
  const finalPath = join(dir, "transcript.final.json");
  const finalOk =
    existsSync(finalPath) &&
    (status === null || finalStep === undefined || finalStep.state === "done");
  const langStep = steps.languages;
  const verdict =
    langStep?.state === "done" ? (langStep.languages as Record<string, unknown>) : null;
  const present = Array.isArray(verdict?.present)
    ? (verdict.present as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const finished = typeof status?.finished === "number" ? status.finished * 1000 : undefined;
  return {
    dir,
    startMs,
    title:
      (typeof meta.title === "string" ? meta.title.trim() : "") ||
      titleFromName(basename(dir)) ||
      "Call",
    workspace: typeof meta.workspace === "string" ? meta.workspace : null,
    harkId: typeof meta.id === "string" || typeof meta.id === "number" ? String(meta.id) : null,
    parts,
    live,
    final: finalOk ? readLines(finalPath) : null,
    finalState: {
      skipped: Array.isArray(finalStep?.skipped_spans)
        ? (finalStep.skipped_spans as unknown[])
        : [],
      ...(typeof finalStep?.warning === "string" ? { warning: finalStep.warning } : {}),
      ...(present.length > 0 ? { languages: present } : {}),
      ...(finished !== undefined ? { finishedMs: finished } : {}),
    },
  };
}

/** The call id of an imported folder: its start time, then a hash of where it came from. */
export function importId(hv: HvFolder): string {
  const h = createHash("sha256")
    .update(`hark-viewer\n${hv.harkId ?? ""}\n${hv.startMs}\n${basename(hv.dir)}`)
    .digest();
  return ulid(hv.startMs, () => new Uint8Array(h.subarray(0, 10)));
}

const MIC_LABELS = new Set(["you", "microphone", "mic", "me"]);

export interface ImportOptions {
  /** `recordings.root`. */
  root: string;
  /** Overrides the folder's own workspace. */
  workspace?: string;
  user: string;
  tz: string;
  version: string;
  /** Is a call with this id already known? Then the folder is not imported again. */
  exists?(id: string): boolean;
}

export interface ImportResult {
  source: string;
  call: string;
  folder: string;
  workspace: string;
  parts: number;
  segments: { live: number; final: number };
  /** Distinct speakers in the imported transcript, you included. */
  speakers: number;
  audio: { copied: number; missing: number };
}

interface Built {
  events: { t: number; draft: EventDraft }[];
  live: number;
  final: number;
  speakers: Set<string>;
}

/** The audio's length from its last Ogg granule; null when it cannot be read. */
function durationOf(path: string): number | null {
  try {
    return opusDurationSeconds(path);
  } catch {
    return null;
  }
}

/** The part a call-clock time falls in: the last part that started at or before it. */
function partAt(
  offsets: { n: number; offset: number }[],
  at: number,
): { n: number; offset: number } {
  let pick = offsets[0] as { n: number; offset: number };
  for (const o of offsets) if (o.offset <= at + 0.001) pick = o;
  return pick;
}

function buildEvents(hv: HvFolder, id: string, o: ImportOptions, workspace: string): Built {
  const events: Built["events"] = [];
  const speakers = new Set<string>();
  const add = (t: number, draft: EventDraft) => events.push({ t, draft });
  add(hv.startMs, {
    type: "call.created",
    id,
    schema: 1,
    workspace,
    title: hv.title,
    tz: o.tz,
    user: o.user,
    akou: o.version,
  });
  const offsets = hv.parts.map((p) => ({
    n: p.n,
    offset: p.started !== null ? Math.max(0, p.started * 1000 - hv.startMs) / 1000 : 0,
  }));
  let nextCluster = 0;
  const liveSegs: { part: number; spk: string; a0: number; a1: number }[] = [];
  let liveN = 0;
  let end = hv.startMs;
  for (const [i, p] of hv.parts.entries()) {
    const offset = (offsets[i] as { offset: number }).offset;
    const wallStart = Math.round(hv.startMs + offset * 1000);
    const lines = hv.live.get(p.n) ?? [];
    const audioPath = join(hv.dir, p.audio);
    const fileSeconds = durationOf(audioPath) ?? lines.reduce((m, l) => Math.max(m, l.end), 0);
    add(wallStart, {
      type: "part.started",
      part: i + 1,
      file: partFile(i + 1),
      wallStart,
      monoStart: 0,
      mic: "imported",
      call: { mode: "system" },
      capture: "hark-viewer import",
    });
    // hark numbered live speakers afresh in every part.
    const clusters = new Map<string, string>();
    const clusterOf = (label: string | undefined): { ch: "mic" | "call"; spk: string } => {
      const l = (label ?? "").trim();
      if (MIC_LABELS.has(l.toLowerCase())) return { ch: "mic", spk: "you" };
      if (l === "" || l.toLowerCase() === "others") return { ch: "call", spk: "c?" };
      let spk = clusters.get(l);
      if (!spk) {
        nextCluster += 1;
        spk = `c${nextCluster}`;
        clusters.set(l, spk);
        // A label that is a name, not a number, is kept as the cluster's name.
        if (!/^speaker \d+$/i.test(l))
          add(wallStart, { type: "speaker.name", spk, name: l, by: "app" });
      }
      return { ch: "call", spk };
    };
    for (const l of [...lines].sort((a, b) => a.start - b.start)) {
      const who = clusterOf(l.speaker);
      liveN += 1;
      const w0 = Math.round(wallStart + l.start * 1000);
      const w1 = Math.round(wallStart + l.end * 1000);
      add(w1, {
        type: "seg",
        id: `l${String(liveN).padStart(6, "0")}`,
        rev: 1,
        layer: "live",
        part: i + 1,
        ch: who.ch,
        spk: who.spk,
        a0: l.start,
        a1: l.end,
        w0,
        w1,
        text: l.text,
        model: "hark",
      } as Omit<Seg, "seq" | "t">);
      speakers.add(who.spk);
      liveSegs.push({ part: i + 1, spk: who.spk, a0: l.start, a1: l.end });
    }
    const partEnd = wallStart + fileSeconds * 1000;
    end = Math.max(end, partEnd);
    add(partEnd, { type: "part.ended", part: i + 1, reason: "stop", fileSeconds });
  }
  add(end, { type: "call.ended", reason: "stop" });

  let finalN = 0;
  if (hv.final) {
    const t = Math.max(end, hv.finalState.finishedMs ?? end);
    add(t, { type: "final.started", pid: 0 });
    const byPart = hv.parts.map((p, i) => ({
      n: i + 1,
      offset: (offsets[i] as { offset: number }).offset,
      src: p.n,
    }));
    for (const l of [...hv.final].sort((a, b) => a.start - b.start)) {
      const where = partAt(
        byPart.map((b) => ({ n: b.n, offset: b.offset })),
        l.start,
      );
      const a0 = Math.max(0, l.start - where.offset);
      const a1 = Math.max(a0, l.end - where.offset);
      const mic = MIC_LABELS.has((l.speaker ?? "").trim().toLowerCase());
      let spk = mic ? "you" : "c?";
      if (!mic) {
        // The live call-side speaker this line overlaps most.
        let best = 0;
        for (const s of liveSegs) {
          if (s.part !== where.n || s.spk === "you") continue;
          const overlap = Math.min(a1, s.a1) - Math.max(a0, s.a0);
          if (overlap > best) {
            best = overlap;
            spk = s.spk;
          }
        }
      }
      const wallStart = hv.startMs + where.offset * 1000;
      finalN += 1;
      add(t, {
        type: "seg",
        id: `f${String(finalN).padStart(6, "0")}`,
        rev: 1,
        layer: "final",
        part: where.n,
        ch: mic ? "mic" : "call",
        spk,
        a0,
        a1,
        w0: Math.round(wallStart + a0 * 1000),
        w1: Math.round(wallStart + a1 * 1000),
        text: l.text,
        model: "hark",
      } as Omit<Seg, "seq" | "t">);
      speakers.add(spk);
    }
    for (const b of byPart) add(t, { type: "final.part.done", part: b.n });
    add(t, {
      type: "final.done",
      parts: byPart.map((b) => b.n),
      ...(hv.finalState.languages ? { languages: hv.finalState.languages } : {}),
      skipped: hv.finalState.skipped,
      ...(hv.finalState.warning ? { warning: hv.finalState.warning } : {}),
    });
  }
  return { events, live: liveN, final: finalN, speakers };
}

/** Imports one hark-viewer call folder into `root`. */
export function importHarkViewer(sourceDir: string, o: ImportOptions): ImportResult {
  const hv = readHarkViewerFolder(sourceDir);
  const id = importId(hv);
  if (o.exists?.(id)) throw new ImportError(`${sourceDir} is already imported as call ${id}`);
  const workspace = o.workspace ?? hv.workspace ?? basename(dirname(sourceDir));
  const bad = checkWorkspace(workspace);
  if (bad) throw new ImportError(`${bad}; pass --workspace`);
  const built = buildEvents(hv, id, o, workspace);
  const folder = createCallFolder(o.root, workspace, hv.startMs, o.tz, hv.title);
  try {
    let copied = 0;
    let missing = 0;
    for (const [i, p] of hv.parts.entries()) {
      const src = join(hv.dir, p.audio);
      if (!existsSync(src)) {
        missing++;
        continue;
      }
      copyFileSync(src, join(folder, partFile(i + 1)), constants.COPYFILE_FICLONE);
      copied++;
    }
    let t = 0;
    const writer = LogWriter.open(folder, { now: () => t });
    try {
      for (const e of built.events) {
        // `t` never goes back, whatever order the source's times were in.
        t = Math.max(t, Math.round(e.t));
        writer.append(e.draft);
      }
    } finally {
      writer.close();
    }
    return {
      source: sourceDir,
      call: id,
      folder,
      workspace,
      parts: hv.parts.length,
      segments: { live: built.live, final: built.final },
      speakers: built.speakers.size,
      audio: { copied, missing },
    };
  } catch (err) {
    rmSync(folder, { recursive: true, force: true });
    throw err;
  }
}
