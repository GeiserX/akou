/**
 * DC-N10: no test may show a permission dialog. The fake helper (scripts/fake-helper.ts
 * `dictate`) stands in for `akou-capture dictate` in the app's tests, and it fails any run where
 * the app asks it for a prompting grant call: a line with `"prompt": true`, at any depth, ends it
 * with `warn prompting-grant` and exit 70. The same line without the flag is an ordinary command
 * (the positive control), so the check is what fails the run, not the line's shape.
 */

import { describe, expect, test } from "bun:test";
import { EXIT } from "../src/main/capture/protocol.ts";
import { FAKE_HELPER } from "./api-helpers.ts";

/** Runs the fake helper, sends `lines` once `ready` came, closes stdin; returns code and stderr. */
async function run(lines: string[]): Promise<{ code: number; stderr: string }> {
  const p = Bun.spawn([process.execPath, FAKE_HELPER, "dictate"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const reader = p.stderr.getReader();
  const dec = new TextDecoder();
  let stderr = "";
  while (!stderr.includes('"type":"ready"')) {
    const { value, done } = await reader.read();
    if (done) break;
    stderr += dec.decode(value, { stream: true });
  }
  for (const l of lines) p.stdin.write(`${l}\n`);
  await p.stdin.flush();
  p.stdin.end();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    stderr += dec.decode(value, { stream: true });
  }
  return { code: await p.exited, stderr };
}

const REBIND = {
  type: "rebind",
  hotkey: "RightCommand",
  draft: "",
  fixLast: "",
  pasteLast: "",
  activation: "hold-or-toggle",
};

describe("DC-N10: the fake helper fails a prompting grant call", () => {
  test("a line asking for a prompt ends the run with prompting-grant and exit 70", async () => {
    const r = await run([JSON.stringify({ ...REBIND, prompt: true })]);
    expect(r.code).toBe(EXIT.software);
    expect(r.stderr).toContain('"code":"prompting-grant"');
    expect(r.stderr).not.toContain('"type":"stopped"');
  });

  test("the flag nested in a command fails it too", async () => {
    const r = await run([JSON.stringify({ type: "warm", mode: "auto", grant: { prompt: true } })]);
    expect(r.code).toBe(EXIT.software);
    expect(r.stderr).toContain('"code":"prompting-grant"');
  });

  test("positive control: the same line without the flag is answered and the run stops cleanly", async () => {
    const r = await run([JSON.stringify(REBIND), JSON.stringify({ ...REBIND, prompt: false })]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.stderr).toContain('"type":"rebound"');
    expect(r.stderr).not.toContain("prompting-grant");
    expect(r.stderr).toContain('"type":"stopped"');
  });
});
