/**
 * The generated CLI reference (docs/ux/CLI.md CLI-31): the committed `docs/cli.md` is exactly what
 * the command registry and the parity table generate. CI runs this file, so a flag, a command or a
 * parity row changed without regenerating fails the build. Parity gaps themselves are TS-13's test
 * (`tests/contracts/parity.test.ts`), not this one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CLI_REFERENCE_FILE,
  cliReferenceDrifted,
  renderCliReference,
} from "../scripts/cli-reference.ts";
import { COMMANDS } from "../src/main/cli/cli.ts";
import { commandHelp } from "../src/main/cli/help.ts";
import { PARITY } from "./contracts/parity.ts";

const committed = () => readFileSync(CLI_REFERENCE_FILE, "utf8");

describe("CLI-31: docs/cli.md is generated and kept in sync", () => {
  test("the committed page is exactly what the registry generates", () => {
    expect(cliReferenceDrifted(committed())).toBe(false);
  });

  test("every command's help page is on it, as `akou help COMMAND` prints it", () => {
    const page = committed();
    for (const c of COMMANDS)
      expect(page).toContain(`## ${c.name}\n\n\`\`\`text\n${commandHelp(c)}\n`);
  });

  test("positive control: a flag added to a command without regenerating is drift", () => {
    const [first, ...rest] = COMMANDS;
    if (!first) throw new Error("the registry is empty");
    const added = {
      ...first,
      flags: {
        ...first.flags,
        "drift-probe": { type: "boolean" as const, desc: "a flag nobody regenerated" },
      },
    };
    expect(cliReferenceDrifted(committed(), renderCliReference([added, ...rest]))).toBe(true);
  });

  test("positive control: a parity row changed without regenerating is drift", () => {
    const [first, ...rest] = PARITY;
    if (!first) throw new Error("the parity table is empty");
    const changed = { ...first, mcp: { none: "a reason nobody regenerated" } };
    expect(cliReferenceDrifted(committed(), renderCliReference(COMMANDS, [changed, ...rest]))).toBe(
      true,
    );
  });

  test("line endings alone are not drift", () => {
    expect(cliReferenceDrifted(committed().replace(/\n/g, "\r\n"))).toBe(false);
  });
});
