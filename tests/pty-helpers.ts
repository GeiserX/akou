/**
 * The real `akou` entry point under a pseudo-terminal (Bun's `terminal` spawn option, POSIX only),
 * with every byte it writes kept raw, so a test can read colour codes, carriage returns and
 * erase-line sequences exactly as a terminal receives them.
 */

import { until } from "./capture-helpers.ts";
import { CLI } from "./cli-helpers.ts";

export interface PtyRun {
  /** Everything written to the terminal so far, raw. */
  bytes(): string;
  /** Types into the terminal. */
  type(text: string): void;
  /** Waits until the output holds `text` (after `from`), and returns where it starts. */
  waitFor(text: string, ms?: number, from?: number): Promise<number>;
  exited: Promise<number>;
  kill(): void;
}

/** `akou ARGV` on a terminal of `cols` columns. */
export function ptyAkou(
  env: Record<string, string | undefined>,
  argv: string[],
  o: { cols?: number } = {},
): PtyRun {
  let out = "";
  const decoder = new TextDecoder();
  const clean = Object.fromEntries(
    Object.entries({ TERM: "xterm-256color", ...env }).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  );
  const proc = Bun.spawn([process.execPath, CLI, ...argv], {
    env: clean,
    terminal: {
      cols: o.cols ?? 120,
      rows: 30,
      data: (_t, d) => {
        out += decoder.decode(d, { stream: true });
      },
    },
  });
  return {
    bytes: () => out,
    type: (text) => proc.terminal?.write(text),
    waitFor: async (text, ms = 10_000, from = 0) => {
      await until(async () => out.indexOf(text, from) >= 0, ms, JSON.stringify(text));
      return out.indexOf(text, from);
    },
    exited: proc.exited.then((code) => {
      proc.terminal?.close();
      return code;
    }),
    kill: () => proc.kill(),
  };
}
