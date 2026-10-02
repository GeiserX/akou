/**
 * The settings reference in docs/configuration.md is generated from the registry and checked for
 * drift (docs/TESTING.md TS-9, TRAPS [T1.39]), with the positive control that a key added without
 * regenerating the page fails the check.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKER, PAGE, render } from "../scripts/settings-doc.ts";
import { pillDefault, SETTINGS, type SettingSpec } from "../src/main/config/schema.ts";
import { tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const page = () => readFileSync(PAGE, "utf8").replaceAll("\r\n", "\n");
const check = (path: string) =>
  Bun.spawnSync([process.execPath, "scripts/settings-doc.ts", "--check", path], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

describe("[T1.39, T1.40, T1.41, T3.42] Docs drift from code: the settings tables", () => {
  test("the committed page is exactly what the registry generates, on every OS", () => {
    expect(page()).toBe(render(page()));
    const r = check(PAGE);
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });

  test("every registry key has a row, and machine defaults are written as on macOS", () => {
    const text = page().split(MARKER)[1] ?? "";
    for (const key of Object.keys(SETTINGS)) expect(text).toContain(`| \`${key}\``);
    expect(text).toContain('| `recordings.root` | `"~/Recordings/akou"`');
    expect(text).toContain('`"~/Library/Application Support/akou/models"`');
    expect(text).toContain(`| \`dictation.pill\` | \`"${pillDefault("darwin")}"\``);
    expect(pillDefault("linux")).toBe("off");
  });

  test("positive control: a key added without regenerating the page fails the check", () => {
    const extra: Record<string, SettingSpec> = {
      ...(SETTINGS as Record<string, SettingSpec>),
      "notes.scratch": { type: "boolean", default: false, doc: "A key nobody documented." },
    };
    expect(render(page(), extra)).not.toBe(page());
    const t = tempDir();
    const copy = join(t.dir, "configuration.md");
    // The page with one generated row gone: what a hand edit, or a key added later, leaves.
    writeFileSync(copy, page().replace(/^\| `asr\.threads`.*\n/m, ""));
    const r = check(copy);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("differs from the settings registry");
    expect(r.stderr.toString()).toContain("`asr.threads`");
    t.cleanup();
  });
});
