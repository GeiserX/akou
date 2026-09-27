/**
 * The docs lint of docs/ux/PRINCIPLES.md "How a UX item becomes work" (DC-D3): every item has one
 * id, defined by a `| ID |` row in the one doc that owns its prefix, and the competitor matrix
 * names that id in its Owner column. This fails when an owner id in the matrix does not resolve to
 * a row of its doc, or when two docs define the same id.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCS = join(import.meta.dir, "..", "docs");

/** Each owning prefix and the doc that defines its ids (PRINCIPLES "One id, one owner"). */
export const OWNERS: Record<string, string> = {
  W: "ux/WINDOW.md",
  DK: "ux/DESKTOP.md",
  CLI: "ux/CLI.md",
  PG: "ux/PROGRAMMABILITY.md",
  SV: "ux/SERVER.md",
  DC: "ux/DICTATION.md",
  TS: "TESTING.md",
  CI: "CI-CD.md",
};

const MATRIX = "ux/COMPETITOR-MATRIX.md";

/** An owned id: `W12.2`, `DK-M1`, `CLI-06`, `PG-A7`, `SV-D4`, `DC-A1`, `TS-16b`, `CI-28`. */
const OWNED_ID =
  /\b(?:W\d+\.\d+|(?:DK|PG|SV|DC)-[A-Z]+\d+[a-z]?|CLI-\d+|TS-\d+[a-z]?|CI-\d+[a-z]?)\b/g;

function prefixOf(id: string): string {
  return id.startsWith("W") && !id.includes("-") ? "W" : (id.split("-")[0] as string);
}

/** The cells of a Markdown table row, or null when the line is not one. */
function cells(line: string): string[] | null {
  if (!line.startsWith("|")) return null;
  // `\|` is a pipe inside a cell.
  return line
    .replaceAll("\\|", "\u0000")
    .split("|")
    .slice(1, -1)
    .map((c) => c.replaceAll("\u0000", "|").trim());
}

/** A bold span that holds only ids: `**DK-T1**`, `**DK-N1, DK-N2, DK-N4**`. */
const BOLD_IDS = /\*\*([A-Z][A-Za-z0-9.,\- ]*)\*\*/g;

/**
 * The ids a doc defines: the first cell of a table row when it is one owned id and nothing else,
 * and the bold ids that open a list item. A list item is how a doc parks an id or keeps a moved
 * one resolving ("Moved or merged" in PROGRAMMABILITY), so it counts as the doc's own.
 */
export function definedIds(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const first = cells(line)?.[0];
    if (first !== undefined) {
      const m = first.match(OWNED_ID);
      if (m && m.length === 1 && m[0] === first) out.push(first);
      continue;
    }
    if (!line.startsWith("- **")) continue;
    for (const span of line.matchAll(BOLD_IDS)) {
      const ids = span[1]?.match(OWNED_ID) ?? [];
      if (ids.length > 0 && span[1]?.replace(OWNED_ID, "").replace(/[, ]|and/g, "") === "")
        out.push(...ids);
    }
  }
  return out;
}

/** Every owned id named in the Owner column of the matrix's feature tables. */
export function matrixOwnerIds(text: string): { row: string; id: string }[] {
  const out: { row: string; id: string }[] = [];
  let owner = -1;
  for (const line of text.split("\n")) {
    const c = cells(line);
    if (!c) {
      owner = -1;
      continue;
    }
    if (c[0] === "ID") {
      owner = c.indexOf("Owner");
      continue;
    }
    if (owner < 0 || /^-+$/.test(c[0] ?? "")) continue;
    for (const id of (c[owner] ?? "").match(OWNED_ID) ?? []) out.push({ row: c[0] as string, id });
  }
  return out;
}

export interface LintInput {
  /** Doc path (relative to docs/) to its text. */
  docs: Record<string, string>;
}

/** What the lint finds wrong; empty when the docs agree. */
export function lintDocIds(input: LintInput): string[] {
  const problems: string[] = [];
  const definedIn = new Map<string, string[]>();
  for (const doc of new Set(Object.values(OWNERS))) {
    for (const id of new Set(definedIds(input.docs[doc] ?? ""))) {
      definedIn.set(id, [...(definedIn.get(id) ?? []), doc]);
    }
  }
  for (const [id, docs] of definedIn) {
    if (docs.length > 1) problems.push(`${id} is defined in ${docs.join(" and ")}`);
    else if (docs[0] !== OWNERS[prefixOf(id)])
      problems.push(`${id} is defined in ${docs[0]}, but ${OWNERS[prefixOf(id)]} owns its prefix`);
  }
  for (const { row, id } of matrixOwnerIds(input.docs[MATRIX] ?? "")) {
    const doc = OWNERS[prefixOf(id)];
    if (!definedIn.get(id)?.includes(doc as string))
      problems.push(`matrix row ${row} names ${id}, which ${doc} does not define`);
  }
  return problems;
}

function readTree(): LintInput {
  const docs: Record<string, string> = {};
  for (const doc of [...new Set(Object.values(OWNERS)), MATRIX]) {
    docs[doc] = readFileSync(join(DOCS, doc), "utf8");
  }
  return { docs };
}

describe("docs ids (PRINCIPLES: a lint keeps it honest, DC-D3)", () => {
  const tree = readTree();

  test("every owner id in the matrix resolves, and no id is defined twice", () => {
    // The lint must see the tree it checks, or an empty parse passes by finding nothing.
    expect(matrixOwnerIds(tree.docs[MATRIX] as string).length).toBeGreaterThan(100);
    expect(definedIds(tree.docs["ux/DICTATION.md"] as string)).toContain("DC-D3");
    expect(lintDocIds(tree)).toEqual([]);
  });

  test("positive control: a matrix row pointing at DC-Z99 fails the lint", () => {
    const matrix = `${tree.docs[MATRIX]}\n\n| ID | Feature | Seen in | Owner |\n|---|---|---|---|\n| DCT-99 | A made-up row | Audit | DC-Z99 |\n`;
    expect(lintDocIds({ docs: { ...tree.docs, [MATRIX]: matrix } })).toEqual([
      "matrix row DCT-99 names DC-Z99, which ux/DICTATION.md does not define",
    ]);
  });

  test("positive control: an id defined in two docs fails the lint", () => {
    const server = `${tree.docs["ux/SERVER.md"]}\n\n| Id | Feature |\n|---|---|\n| DC-A1 | a second definition |\n`;
    expect(lintDocIds({ docs: { ...tree.docs, "ux/SERVER.md": server } })).toEqual([
      "DC-A1 is defined in ux/SERVER.md and ux/DICTATION.md",
    ]);
  });
});
