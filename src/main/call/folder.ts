/**
 * Call folders and ids (docs/DESIGN.md section 4.1).
 *
 * `<root>/<workspace>/<YYYY-MM-DD_HHMMSS>_<slug>/` from the LOCAL start time in the call's zone,
 * created with an exclusive `mkdir`, so a folder name is unique by construction and nothing is
 * ever written into another call's folder. Two calls started in the same second get `-2`, `-3`.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatLocalDate, formatWall } from "../../core/log/clock.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of epoch ms then 80 random bits, Crockford base32, 26 characters. */
export function ulid(now: number, rand: (n: number) => Uint8Array = randomBytes): string {
  let t = Math.floor(now);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = rand(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let r = "";
  for (let i = 0; i < 16; i++) {
    r = CROCKFORD[Number(bits & 31n)] + r;
    bits >>= 5n;
  }
  return time + r;
}

/** `Weekly sync!` → `weekly-sync`. ASCII letters and digits only, at most 40 characters. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "call";
}

/** `2026-09-23_153612_weekly-sync`, from the local time in `tz`. */
export function folderName(startWall: number, tz: string, title: string): string {
  const date = formatLocalDate(startWall, tz);
  const time = formatWall(startWall, tz, { seconds: true }).replaceAll(":", "");
  return `${date}_${time}_${slugify(title)}`;
}

/** A workspace name is one path segment. */
export function checkWorkspace(workspace: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workspace)) {
    return `workspace "${workspace}" must be letters, digits, dot, dash or underscore`;
  }
  return null;
}

/** Creates the call folder with `audio/` and `logs/`. Never reuses an existing folder. */
export function createCallFolder(
  root: string,
  workspace: string,
  startWall: number,
  tz: string,
  title: string,
): string {
  const parent = join(root, workspace);
  mkdirSync(parent, { recursive: true });
  const base = folderName(startWall, tz, title);
  for (let n = 1; n < 1000; n++) {
    const dir = join(parent, n === 1 ? base : `${base}-${n}`);
    try {
      mkdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    mkdirSync(join(dir, "audio"));
    mkdirSync(join(dir, "logs"));
    return dir;
  }
  throw new Error(`could not create a unique folder for ${base}`);
}

export function partFile(part: number): string {
  return `audio/part-${String(part).padStart(3, "0")}.opus`;
}

export function partLog(part: number): string {
  return `logs/capture-part-${String(part).padStart(3, "0")}.log`;
}
