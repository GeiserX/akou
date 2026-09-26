/**
 * akou beside Telegram-Archive (docs/ux/SERVER.md SV-T6): the compose example as written. The
 * files are read, never run, here; `scripts/compose-e2e.sh` runs them in the `server` CI job.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const DIR = ["examples", "compose", "telegram-archive"];

/** The one yaml block of SERVER.md section 12.5. */
function docBlock(serverMd: string): string {
  const section = serverMd.slice(serverMd.indexOf("### 12.5"));
  const m = /```yaml\n([\s\S]*?)```/.exec(section);
  return m?.[1] ?? "";
}

/** The `${VAR}` names a compose file interpolates. */
function composeVars(yaml: string): string[] {
  return [...new Set([...yaml.matchAll(/\$\{(\w+)[^}]*\}/g)].map((m) => m[1] as string))].sort();
}

/** The names an env file assigns. */
function envNames(env: string): string[] {
  return [...env.matchAll(/^(\w+)=/gm)].map((m) => m[1] as string).sort();
}

describe("[SV-T6] the compose example beside Telegram-Archive", () => {
  const compose = read(...DIR, "compose.akou.yml");

  test("compose.akou.yml is the block SERVER.md section 12.5 shows, byte for byte", () => {
    const block = docBlock(read("docs", "ux", "SERVER.md"));
    expect(block).toContain("services:");
    expect(compose).toBe(block);
    // Positive control: one changed character is caught.
    expect(compose.replace("8476", "8477")).not.toBe(block);
  });

  test(".env.example names every variable the compose file reads, and nothing else", () => {
    const vars = composeVars(compose);
    expect(vars).toEqual(["AKOU_VERSION", "TRANSCRIPTION_API_KEY", "TRANSCRIPTION_WEBHOOK_SECRET"]);
    expect(envNames(read(...DIR, ".env.example"))).toEqual(vars);
  });

  test("akou is pinned by a version, starts behind the proxy by the environment, and publishes on loopback only", () => {
    expect(compose).not.toMatch(/:latest\b/);
    expect(compose).toContain(`image: drumsergio/akou:${"$"}{AKOU_VERSION}`);
    expect(compose).toContain('AKOU_BEHIND_PROXY: "true"');
    expect(compose).toContain('"127.0.0.1:8476:8476"');
    // The archive keeps a note queued while akou is down, so nothing waits on akou's health.
    expect(compose).not.toContain("condition:");
  });

  test("the round trip pins Telegram-Archive by a full commit", () => {
    const script = read("scripts", "compose-e2e.sh");
    expect(script).toMatch(/TA_REF=\$\{TA_REF:-[0-9a-f]{40}\}/);
  });
});
