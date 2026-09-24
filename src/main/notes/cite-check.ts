/**
 * The citation check for enhanced notes (docs/DESIGN.md section 5.2, TRAPS "Hallucinated citation
 * in enhanced notes"). Every added bullet must cite at least one segment id (`[#l000031]`), and a
 * deterministic check drops any bullet that:
 *
 * - cites nothing;
 * - cites an id that is not a segment of this call, or is retracted, or was logged after the span
 *   the notes cover (`maxSeq`), so it cannot be what the model read;
 * - shares no content word with the lines it cites.
 *
 * One fake id taints the whole bullet, even next to a real one: a model that invented a citation
 * cannot be trusted on that line. The check applies to every provider, the harness included, and
 * to notes an agent writes itself. A line that is one of the user's own notepad lines, word for
 * word, is kept as the user's and needs no citation. Headings and blank lines pass through.
 */

import type { CallView, Line } from "../../core/log/fold.ts";
import { tokenize } from "../../core/vocab/correct.ts";
import { STOPWORDS } from "../query/bm25.ts";

/** A segment id as a citation: `#l000031`, `#f000031`. */
export const CITATION = /#([lf]\d{6,})\b/g;

const STOP: ReadonlySet<string> = new Set(Object.values(STOPWORDS).flatMap((s) => [...s]));

export interface CiteCheckOptions {
  view: CallView;
  /** The last log `seq` the notes cover; a cited segment logged after it is out of range. */
  maxSeq?: number;
  /** The user's own notepad lines, kept word for word. */
  userLines?: readonly string[];
}

export interface DroppedLine {
  text: string;
  reason: string;
}

export interface CiteCheckResult {
  /** The Markdown with every failing line removed. */
  markdown: string;
  /** Every id cited by a kept line, in first-seen order. */
  cites: string[];
  /** Kept lines that carry a citation. */
  kept: number;
  /** Kept lines that are the user's own. */
  userKept: number;
  dropped: DroppedLine[];
}

/** The ids a text cites, in order, each once. */
export function citedIds(text: string): string[] {
  return [...new Set([...text.matchAll(CITATION)].map((m) => m[1] as string))];
}

/** Content words: folded, no stopwords, at least 3 characters unless a number. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text.replace(CITATION, " "))) {
    if (STOP.has(t.folded)) continue;
    if (t.folded.length < 3 && !/^\d+$/.test(t.folded)) continue;
    out.add(t.folded);
  }
  return out;
}

/** A line with its list marker and surrounding space removed: `- [ ] Ben: x` becomes `Ben: x`. */
export function stripMarker(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]?\]\s+/, "")
    .trim();
}

function lineWords(l: Line): Set<string> {
  const out = contentWords(l.text);
  for (const w of contentWords(l.raw ?? "")) out.add(w);
  return out;
}

export function citeCheck(markdown: string, o: CiteCheckOptions): CiteCheckResult {
  const user = new Set((o.userLines ?? []).map((l) => stripMarker(l)));
  const kept: string[] = [];
  const dropped: DroppedLine[] = [];
  const cites: string[] = [];
  let withCites = 0;
  let userKept = 0;
  for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bare = stripMarker(line);
    if (bare === "" || /^#{1,6}\s/.test(line.trim())) {
      kept.push(line);
      continue;
    }
    if (user.has(bare)) {
      kept.push(line);
      userKept++;
      continue;
    }
    const ids = citedIds(line);
    if (ids.length === 0) {
      dropped.push({ text: line, reason: "cites no segment" });
      continue;
    }
    const cited: Line[] = [];
    let bad: string | null = null;
    for (const id of ids) {
      const l = o.view.resolve(id);
      if (!l || l.retracted) {
        bad = `cites #${id}, which is not a line of this call`;
        break;
      }
      if (o.maxSeq !== undefined && l.seq > o.maxSeq) {
        bad = `cites #${id}, which is after the span these notes cover`;
        break;
      }
      cited.push(l);
    }
    if (bad) {
      dropped.push({ text: line, reason: bad });
      continue;
    }
    const words = contentWords(bare);
    const shared = cited.some((l) => [...lineWords(l)].some((w) => words.has(w)));
    if (!shared) {
      dropped.push({ text: line, reason: "shares no word with the lines it cites" });
      continue;
    }
    kept.push(line);
    withCites++;
    for (const id of ids) if (!cites.includes(id)) cites.push(id);
  }
  // A section left with nothing under it keeps its heading; runs of blank lines collapse.
  const out = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown: out, cites, kept: withCites, userKept, dropped };
}
