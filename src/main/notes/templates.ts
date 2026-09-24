/**
 * Templates for enhanced notes (docs/DESIGN.md section 5.2): Markdown files with frontmatter. Five
 * ship with akou (`templates/`: general, one-on-one, standup, customer-call, interview); a file of
 * the same name in the config folder's `templates/` replaces the shipped one, and any other file
 * there adds a template.
 *
 * ```markdown
 * ---
 * name: standup
 * match: ["standup", "daily"]
 * ---
 * ## Updates per person
 * One bullet per speaker: done, next, blockers.
 * ```
 *
 * `match` lists title keywords for the automatic choice. Each `##` heading is a section of the
 * notes; the text under it is the instruction for that section and may be empty.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tokenize } from "../../core/vocab/correct.ts";

export const BUNDLED_TEMPLATES_DIR = join(import.meta.dir, "templates");
export const DEFAULT_TEMPLATE = "general";

export interface TemplateSection {
  heading: string;
  instruction: string;
}

export interface Template {
  name: string;
  match: string[];
  sections: TemplateSection[];
  /** The file it came from. */
  source: string;
  bundled: boolean;
  /** The body after the frontmatter, as written. */
  body: string;
}

export class TemplateError extends Error {
  override name = "TemplateError";
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `["a", "b"]`, `[a, b]` or a single word. */
function parseList(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith("[")) return t === "" ? [] : [unquote(t)];
  if (!t.endsWith("]")) throw new TemplateError(`bad list: ${t}`);
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  const out: string[] = [];
  for (const m of inner.matchAll(/\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^,]*?))\s*(?:,|$)/g)) {
    if (m[0] === "") break;
    const v = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : (m[2] ?? m[3] ?? "");
    if (v !== "") out.push(v);
  }
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parses one template file. The name falls back to the file name. */
export function parseTemplate(text: string, source: string, bundled = false): Template {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const meta: Record<string, string> = {};
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (end < 0) throw new TemplateError(`${source}: the frontmatter has no closing ---`);
    for (const l of lines.slice(1, end)) {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l);
      if (m) meta[m[1] as string] = m[2] as string;
    }
    i = end + 1;
  }
  const body = lines.slice(i).join("\n").trim();
  const sections: TemplateSection[] = [];
  let cur: TemplateSection | null = null;
  const text2: string[] = [];
  const flush = () => {
    if (cur) {
      cur.instruction = text2.join("\n").trim();
      sections.push(cur);
    }
    text2.length = 0;
  };
  for (const l of lines.slice(i)) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) {
      flush();
      cur = { heading: h[1] as string, instruction: "" };
    } else if (cur) text2.push(l);
  }
  flush();
  const name = unquote(meta.name ?? "") || basename(source, ".md");
  if (!NAME.test(name)) throw new TemplateError(`${source}: "${name}" is not a template name`);
  if (sections.length === 0) throw new TemplateError(`${source}: no "## " sections`);
  return { name, match: parseList(meta.match ?? ""), sections, source, bundled, body };
}

function readDir(dir: string, bundled: boolean, onError?: (msg: string) => void): Template[] {
  if (!existsSync(dir)) return [];
  const out: Template[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const path = join(dir, f);
    try {
      out.push(parseTemplate(readFileSync(path, "utf8"), path, bundled));
    } catch (err) {
      onError?.((err as Error).message);
    }
  }
  return out;
}

/** Every template: the shipped ones, replaced or added to by the user's folder. */
export function listTemplates(
  configDir: string,
  o: { bundledDir?: string; onError?: (msg: string) => void } = {},
): Template[] {
  const byName = new Map<string, Template>();
  for (const t of readDir(o.bundledDir ?? BUNDLED_TEMPLATES_DIR, true, o.onError)) {
    byName.set(t.name, t);
  }
  for (const t of readDir(join(configDir, "templates"), false, o.onError)) byName.set(t.name, t);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The template for a call: the one asked for, else the call's own (`call.created.template`), else
 * the first whose `match` keyword is in the title, else `general`. An unknown name asked for
 * explicitly is an error; an unknown call template falls through to the title.
 */
export function chooseTemplate(
  templates: readonly Template[],
  o: { explicit?: string; callTemplate?: string; title?: string },
): Template {
  const by = (n: string | undefined) => (n ? templates.find((t) => t.name === n) : undefined);
  if (o.explicit) {
    const t = by(o.explicit);
    if (!t) {
      throw new TemplateError(
        `no template "${o.explicit}"; there are ${templates.map((x) => x.name).join(", ")}`,
      );
    }
    return t;
  }
  const own = by(o.callTemplate);
  if (own) return own;
  const words = (s: string) =>
    tokenize(s)
      .map((x) => x.folded)
      .join(" ");
  const title = ` ${words(o.title ?? "")} `;
  for (const t of templates) {
    for (const k of t.match) {
      const key = words(k);
      if (key !== "" && title.includes(` ${key} `)) return t;
    }
  }
  const general = by(DEFAULT_TEMPLATE) ?? templates[0];
  if (!general) throw new TemplateError("no templates at all");
  return general;
}

/** The template as the model reads it: its sections and each section's instruction. */
export function renderTemplate(t: Template): string {
  return t.sections
    .map((s) => `## ${s.heading}\n${s.instruction || "(no instruction: use judgement)"}`)
    .join("\n");
}
