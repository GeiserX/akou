/**
 * Ask presets (docs/ux/PROGRAMMABILITY.md PG-F2): the questions the ask box offers, as Markdown
 * files the user can add to. Five ship with akou (`presets/`); a file of the same name in the
 * config folder's `presets/` replaces the shipped one, and any other file there adds a preset.
 * The folder is read on every request, so a new file shows without a restart.
 *
 * ```markdown
 * ---
 * label: What did {speaker} say?
 * order: 50
 * ---
 * What did {speaker} say so far?
 * ```
 *
 * The file name is the preset's name (`akou ask --preset speaker`). `label` is what the menu
 * shows, `order` where (lowest first, then by name), and the body is the question. `{speaker}`,
 * `{user}` and `{title}` are filled in with a speaker's name, `user.name` and the call's title. A
 * preset that names `{speaker}` is offered once per named speaker. A preset is only a question:
 * it is always asked of one call.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The shipped presets: beside this module, in the source tree and in the app bundle. The `akou`
 * command line is one compiled binary whose own files are not on disk, so `akou mcp` finds them
 * beside the binary instead, where the bundle puts them.
 */
export const BUNDLED_PRESETS_DIR = shippedDir();

function shippedDir(): string {
  const here = join(import.meta.dir, "presets");
  if (existsSync(here)) return here;
  try {
    return join(dirname(realpathSync(process.execPath)), "presets");
  } catch {
    return here;
  }
}

export interface Preset {
  name: string;
  label: string;
  /** Where the menu puts it, lowest first; null sorts after every number. */
  order: number | null;
  /** The body: the question, with its `{…}` fields unfilled. */
  question: string;
  source: string;
  bundled: boolean;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Parses one preset file; the name is the file name. Throws on a file that is not a preset. */
export function parsePreset(text: string, source: string, bundled = false): Preset {
  const name = basename(source, ".md");
  if (!NAME.test(name)) throw new Error(`${source}: "${name}" is not a preset name`);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const meta: Record<string, string> = {};
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (end < 0) throw new Error(`${source}: the frontmatter has no closing ---`);
    for (const l of lines.slice(1, end)) {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l);
      if (m) meta[m[1] as string] = (m[2] as string).trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    i = end + 1;
  }
  const question = lines.slice(i).join("\n").trim();
  if (question === "") throw new Error(`${source}: no question after the frontmatter`);
  const order = meta.order === undefined || meta.order === "" ? null : Number(meta.order);
  if (order !== null && !Number.isFinite(order)) {
    throw new Error(`${source}: order "${meta.order}" is not a number`);
  }
  return { name, label: meta.label || name, order, question, source, bundled };
}

function readDir(dir: string, bundled: boolean, onError?: (msg: string) => void): Preset[] {
  if (!existsSync(dir)) return [];
  const out: Preset[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const path = join(dir, f);
    try {
      out.push(parsePreset(readFileSync(path, "utf8"), path, bundled));
    } catch (err) {
      onError?.((err as Error).message);
    }
  }
  return out;
}

/** Every preset: the shipped ones, replaced or added to by the user's folder, in menu order. */
export function listPresets(
  configDir: string,
  o: { bundledDir?: string; onError?: (msg: string) => void } = {},
): Preset[] {
  const byName = new Map<string, Preset>();
  for (const p of readDir(o.bundledDir ?? BUNDLED_PRESETS_DIR, true, o.onError))
    byName.set(p.name, p);
  for (const p of readDir(join(configDir, "presets"), false, o.onError)) byName.set(p.name, p);
  return [...byName.values()].sort(
    (a, b) =>
      (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name),
  );
}

/** Whether the preset is asked once per speaker. */
export function usesSpeaker(p: Pick<Preset, "label" | "question">): boolean {
  return p.question.includes("{speaker}") || p.label.includes("{speaker}");
}

/** The text with `{speaker}`, `{user}` and `{title}` filled in; other braces stay as written. */
export function fillPreset(
  text: string,
  v: { speaker?: string; user?: string; title?: string },
): string {
  return text.replace(/\{(speaker|user|title)\}/g, (all, k: "speaker" | "user" | "title") =>
    v[k] === undefined ? all : (v[k] as string),
  );
}
