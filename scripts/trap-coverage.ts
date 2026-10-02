/**
 * Every reached trap has a test that ran and asserted (docs/TESTING.md TS-6, AGENTS.md: "every
 * trap gets a test named after its id").
 *
 *   bun scripts/trap-coverage.ts <junit.xml>... [--traps docs/TRAPS.md]
 *
 * Reads the traps in docs/TRAPS.md whose milestone is reached, and the JUnit files `bun test
 * --reporter=junit` wrote for the run. A trap passes when a test case whose name or describe
 * carries one of its ids in brackets (`[T4.31]`, `[T1.9, T4.19]`) ran, passed and made at least
 * one assertion (the `assertions` attribute Bun writes per test case). It fails when no such test
 * ran, when every one was skipped, or when every one asserted nothing.
 *
 * With no such test, a trap is listed instead of failing when TRAPS.md marks its test
 * `Test (release checklist):`, `Test (on hardware):`, `Test (nightly):` or
 * `Test (not written yet):`, when it has no id a test can carry (`[spike]`, `[decision]`), when
 * its test lives outside the Bun suites (ELSEWHERE, with the reason), or when its milestone is not
 * reached. Only test ids settle a trap: a test named `[spike] x` settles no `[spike]` trap.
 * This proves a test exists, runs and asserts something; review and positive controls prove it is
 * right.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Milestones whose traps must have a test now ([ROADMAP.md](../docs/ROADMAP.md)). A trap with no milestone is always due. */
export const REACHED = new Set(["M0", "M1"]);

/** Trap ids whose test is not a Bun test case, with where it is. */
export const ELSEWHERE: Record<string, string> = {
  "T0.27": "a grep test in the capture crate (cargo test, native/akou-capture/src/lib.rs)",
  "T0.28": "property tests in the capture crate (cargo test, native/akou-capture/src/convert.rs)",
  "T4.21":
    "resampler and aligner tests in the capture crate (cargo test, native/akou-capture/src/resample.rs and aligner.rs)",
};

/** How TRAPS.md says a trap's test is not a Bun test: `Test (nightly): ...`. */
const MARKED = /\bTest \((release checklist|on hardware|nightly|not written yet)\):/;

export interface Trap {
  title: string;
  ids: string[];
  milestone: string | null;
  /** The entry's text after the title, where it says how it is tested. */
  text: string;
}

export interface Case {
  name: string;
  ids: Set<string>;
  skipped: boolean;
  failed: boolean;
  assertions: number;
}

export type Verdict =
  | { trap: Trap; status: "ok"; by: string }
  | { trap: Trap; status: "missing" | "skipped" | "no-assertions" }
  | { trap: Trap; status: "listed"; why: string };

/** A test id a test name can carry: `T4.31`, `F2.50`, `I0.14`, `DK-T1`, `akou-5an.100`. */
const TEST_ID = /^(?:[TFI]\d+\.\d+|[A-Z]{2,3}-[A-Z]*\d+[a-z]?|akou-[a-z0-9]+(?:\.\d+)+)$/;

/** The trap entries before "Kept from closed traps": `- **title** [ids] (Mn). text`. */
export function trapsOf(md: string): Trap[] {
  const out: Trap[] = [];
  const end = md.indexOf("\n## Kept from closed traps");
  for (const line of (end < 0 ? md : md.slice(0, end)).split("\n")) {
    const m = /^- \*\*(.+?)\*\* \[([^\]]+)\](?: \((M\d+)\))?\.?\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({
      title: m[1] as string,
      ids: (m[2] as string).split(",").map((s) => s.trim()),
      milestone: m[3] ?? null,
      text: m[4] ?? "",
    });
  }
  return out;
}

/** The bracketed ids in a test's name and describe: `[T1.9, T4.19] x` gives T1.9 and T4.19. */
export function idsIn(name: string): Set<string> {
  const ids = new Set<string>();
  for (const m of name.matchAll(/\[([^\]]+)\]/g))
    for (const id of (m[1] as string).split(/[\s,/]+/)) if (id) ids.add(id);
  return ids;
}

const unxml = (v: string): string =>
  v
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Every test case of a JUnit file. */
export function casesOf(xml: string): Case[] {
  const out: Case[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1] ?? "";
    const attr = (n: string) => {
      const v = new RegExp(`\\b${n}="([^"]*)"`).exec(attrs)?.[1];
      return v === undefined ? undefined : unxml(v);
    };
    const name = `${attr("classname") ?? ""} > ${attr("name") ?? ""}`;
    const body = m[3] ?? "";
    out.push({
      name: `${attr("file") ?? ""}: ${name}`,
      ids: idsIn(name),
      skipped: /<skipped\b/.test(body),
      failed: /<(failure|error)\b/.test(body),
      assertions: Number(attr("assertions") ?? "0"),
    });
  }
  return out;
}

/** Why a trap is listed rather than checked, or null when it must have a test that ran. */
export function listedWhy(t: Trap): string | null {
  if (t.milestone !== null && !REACHED.has(t.milestone))
    return `milestone ${t.milestone} is not reached yet`;
  const marked = MARKED.exec(t.text)?.[1];
  if (marked) return `TRAPS.md marks its test "${marked}"`;
  const ids = t.ids.filter((id) => TEST_ID.test(id));
  if (ids.length === 0) return `no id a test can be named after (${t.ids.join(", ")})`;
  const away = ids.find((id) => ELSEWHERE[id]);
  if (away) return ELSEWHERE[away] as string;
  return null;
}

/**
 * A named test that ran and asserted settles a trap whatever its text says. Without one, a trap
 * that is listed (`listedWhy`) is reported as such, and any other trap fails.
 */
export function judge(traps: Trap[], cases: Case[]): Verdict[] {
  return traps.map((trap): Verdict => {
    const ids = trap.ids.filter((id) => TEST_ID.test(id));
    const named = cases.filter((c) => ids.some((id) => c.ids.has(id)));
    const ran = named.filter((c) => !c.skipped && !c.failed);
    const asserted = ran.find((c) => c.assertions > 0);
    if (asserted) return { trap, status: "ok", by: asserted.name };
    const why = listedWhy(trap);
    if (why) return { trap, status: "listed", why };
    if (named.length === 0) return { trap, status: "missing" };
    if (ran.length === 0) return { trap, status: "skipped" };
    return { trap, status: "no-assertions" };
  });
}

const label = (t: Trap) => `[${t.ids.join(", ")}] ${t.title}`;

export function report(verdicts: Verdict[]): { lines: string[]; failed: number } {
  const lines: string[] = [];
  let failed = 0;
  for (const v of verdicts) {
    if (v.status === "ok") lines.push(`ok      ${label(v.trap)}`);
    else if (v.status === "listed") lines.push(`listed  ${label(v.trap)}: ${v.why}`);
    else {
      failed++;
      const what = {
        missing: "no test with its id in the name ran",
        skipped: "every test with its id was skipped or failed",
        "no-assertions": "every test with its id made zero assertions",
      }[v.status];
      lines.push(`FAIL    ${label(v.trap)}: ${what}`);
    }
  }
  return { lines, failed };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--traps");
  const trapsPath =
    at >= 0 ? (args[at + 1] as string) : join(import.meta.dir, "..", "docs", "TRAPS.md");
  const files = at < 0 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  if (files.length === 0) {
    console.error("usage: bun scripts/trap-coverage.ts <junit.xml>... [--traps docs/TRAPS.md]");
    process.exit(64);
  }
  const cases: Case[] = [];
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`trap-coverage: ${f} is missing`);
      process.exit(1);
    }
    cases.push(...casesOf(readFileSync(f, "utf8")));
  }
  const { lines, failed } = report(judge(trapsOf(readFileSync(trapsPath, "utf8")), cases));
  for (const l of lines) console.log(`trap-coverage: ${l}`);
  if (failed > 0) {
    console.error(
      `trap-coverage: ${failed} reached trap${failed === 1 ? "" : "s"} without a test that ran and asserted. Name the test after the trap id, or mark its test in TRAPS.md as \`Test (release checklist):\`, \`(on hardware)\`, \`(nightly)\` or \`(not written yet)\``,
    );
    process.exit(1);
  }
}
