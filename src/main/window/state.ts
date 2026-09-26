/**
 * What the desktop shell remembers between runs (docs/ux/DESKTOP.md DK-M4, DK-F1): the main
 * window's frame and the floating indicator's place, in `shell.json` in the config folder. It is
 * not a setting: nobody types it, and a file that is missing, torn or hand-edited into nonsense
 * only means the window opens at its default place.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rect, ShellState } from "./shell.ts";

export const SHELL_STATE_FILE = "shell.json";

function rect(v: unknown): Rect | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const n = (k: string) => typeof r[k] === "number" && Number.isFinite(r[k]);
  if (!(n("x") && n("y") && n("width") && n("height"))) return undefined;
  if ((r.width as number) <= 0 || (r.height as number) <= 0) return undefined;
  return {
    x: r.x as number,
    y: r.y as number,
    width: r.width as number,
    height: r.height as number,
  };
}

/** The shell's state in `dir`: read whole each time, written through a temporary file. */
export function fileState(dir: string): { load(): ShellState; save(s: ShellState): void } {
  const path = join(dir, SHELL_STATE_FILE);
  return {
    load() {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return {};
      }
      const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const out: ShellState = {};
      const w = rect(o.window);
      if (w) out.window = w;
      const i = rect(o.indicator);
      if (i) out.indicator = i;
      return out;
    },
    save(s) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
      renameSync(tmp, path);
    },
  };
}
