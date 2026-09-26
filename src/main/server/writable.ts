/**
 * SV-P12 (docs/ux/SERVER.md section 12.5): at start in server mode, a data or models folder this
 * process cannot write stops the server with one line naming the folder and the user id, instead
 * of a stack trace at the first write. A folder Docker creates for a bind mount is owned by root,
 * and the image runs as uid 1000.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A folder the server must write refuses this process; the entry point exits 77 (EX_NOPERM). */
export class NotWritable extends Error {
  override name = "NotWritable";
}

const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Creates `dir` if needed and writes and removes one probe file in it. A refusal throws
 * `NotWritable` naming the nearest folder that exists, which is the one to fix: for a missing
 * `/data/.config/akou` under a root-owned `/data`, that is `/data`.
 */
export function requireWritable(dir: string, uid = process.getuid?.()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.akou-write-probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!DENIED.has(code)) throw err;
    let at = dir;
    while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
    const who = uid === undefined ? "this user" : `uid ${uid}`;
    const fix = uid === undefined ? "" : `; on the host, chown ${uid}:${uid} it`;
    throw new NotWritable(`${at} is not writable by ${who} (${code})${fix}`);
  }
}
