/**
 * "Install Command-Line Tool…" in the akou menu (docs/ux/DESKTOP.md DK-M6, DESIGN 6.1): links the
 * `akou` binary the app carries beside its main process into `/usr/local/bin`, which every new
 * macOS terminal has on its PATH (`/etc/paths`). A link, not a copy, so an app update updates the
 * command too.
 *
 * - The password is asked only when the folder needs it: a writable `/usr/local/bin` gets the link
 *   directly; otherwise (the folder is root's, or missing on a clean Apple silicon Mac) macOS asks
 *   through `osascript ... with administrator privileges`.
 * - A second run finds the link already pointing at this app and says so.
 * - Something else already called `akou` there (a copy from the release tarball, another tool's
 *   link, Homebrew's on an Intel Mac) is left alone: the menu says what is in the way. A dangling
 *   link, or one into another copy of the app, is replaced.
 * - An app run from its disk image (`/Volumes/…`) or from a translocated copy (a quarantined app
 *   opened where it was downloaded) installs nothing: that path vanishes at eject, quit or reboot,
 *   and the link would dangle.
 */

import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, posix } from "node:path";

/** The folder the link goes into. */
export const CLI_DIR = "/usr/local/bin";
/** The binary's name beside the bundled main process (`electrobun.config.ts`). */
export const CLI_NAME = "akou";
/** Where the app carries it: beside the bundled main process (in a checkout, nothing is there). */
export const BUNDLED_CLI = join(import.meta.dir, CLI_NAME);
/** How the path of any copy of the app's binary ends: a link to one is ours to repoint. */
const APP_CLI_TAIL = `.app/Contents/Resources/app/bun/${CLI_NAME}`;

export type InstallOutcome =
  | { state: "installed"; path: string }
  | { state: "already"; path: string }
  | { state: "missing" }
  | { state: "not-in-place" }
  | { state: "in-the-way"; path: string }
  | { state: "refused" }
  | { state: "failed"; error: string };

/** The file operations the install needs; `nodeOps` is the real one. */
export interface InstallOps {
  exists(path: string): boolean;
  /** What a link points at, or null when `path` is not a link (or is not there). */
  readlink(path: string): string | null;
  /** The folder exists and this process may create a file in it. */
  writable(dir: string): boolean;
  /** Replaces `dst` (absent, or a link) with a link to `src`. */
  link(src: string, dst: string): void;
  /** The same, as root, after macOS asks for a password. False when the user cancelled; throws when the link failed. */
  linkAsAdmin(src: string, dst: string): Promise<boolean>;
}

export async function installCli(
  source: string,
  ops: InstallOps,
  dir: string = CLI_DIR,
): Promise<InstallOutcome> {
  if (!ops.exists(source)) return { state: "missing" };
  if (source.startsWith("/Volumes/") || source.includes("/AppTranslocation/"))
    return { state: "not-in-place" };
  // macOS paths: POSIX joins, so the tests read the same on a Windows runner.
  const path = posix.join(dir, CLI_NAME);
  const current = ops.readlink(path);
  if (current === source) return { state: "already", path };
  // A regular file is someone else's, and so is a live link to anything but a copy of this app.
  if (current === null ? ops.exists(path) : !ours(current, dir, ops))
    return { state: "in-the-way", path };
  try {
    if (ops.writable(dir)) ops.link(source, path);
    else if (!(await ops.linkAsAdmin(source, path))) return { state: "refused" };
  } catch (err) {
    return { state: "failed", error: (err as Error).message };
  }
  return ops.readlink(path) === source
    ? { state: "installed", path }
    : { state: "failed", error: `${path} does not point at ${source}` };
}

/** A link target this app may replace: one that is gone, or any copy of the app's binary. */
function ours(target: string, dir: string, ops: InstallOps): boolean {
  const abs = posix.resolve(dir, target);
  return !ops.exists(abs) || abs.endsWith(APP_CLI_TAIL);
}

/** What the menu shows for an outcome: a title and one line. */
export function installMessage(o: InstallOutcome): { title: string; detail: string } {
  switch (o.state) {
    case "installed":
      return {
        title: "The akou command is installed.",
        detail: `${o.path} now runs this app's akou. Open a new terminal and run akou --version.`,
      };
    case "already":
      return {
        title: "The akou command is already installed.",
        detail: `${o.path} already runs this app's akou.`,
      };
    case "missing":
      return {
        title: "This build has no command-line tool.",
        detail:
          "Only the released app carries it. Install the command line from its release archive (docs/install.md).",
      };
    case "not-in-place":
      return {
        title: "akou is not running from Applications.",
        detail:
          "Move akou to Applications, open it from there, then choose Install Command-Line Tool… again.",
      };
    case "in-the-way":
      return {
        title: "Another akou is in the way.",
        detail: `${o.path} is not this app's. Remove it, then choose Install Command-Line Tool… again.`,
      };
    case "refused":
      return { title: "Nothing was installed.", detail: "The password was not given." };
    case "failed":
      return { title: "The akou command could not be installed.", detail: o.error };
  }
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The AppleScript that makes the link as root: a shell command in an AppleScript string. */
export function adminScript(src: string, dst: string): string {
  const dir = dst.slice(0, dst.lastIndexOf("/")) || "/";
  const cmd = `/bin/mkdir -p ${shQuote(dir)} && /bin/ln -sfn ${shQuote(src)} ${shQuote(dst)}`;
  const asString = `"${cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `do shell script ${asString} with administrator privileges`;
}

export const nodeOps: InstallOps = {
  // Only ENOENT is absence. A path it cannot look at (EACCES) may hold another command, and the
  // password path's `ln -sfn` would replace it.
  exists: (p) => {
    try {
      lstatSync(p);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ENOENT";
    }
  },
  readlink: (p) => {
    try {
      return readlinkSync(p);
    } catch {
      return null;
    }
  },
  writable: (dir) => {
    try {
      accessSync(dir, constants.W_OK);
      return existsSync(dir);
    } catch {
      return false;
    }
  },
  link: (src, dst) => {
    try {
      if (lstatSync(dst).isSymbolicLink()) unlinkSync(dst);
    } catch {}
    symlinkSync(src, dst);
  },
  // Asynchronous: the password dialog must not stall the main process, which carries the capture.
  linkAsAdmin: async (src, dst) => {
    const p = Bun.spawn(["/usr/bin/osascript", "-e", adminScript(src, dst)], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    return adminLinked(code, stderr);
  },
};

/**
 * osascript's answer to the admin script: true when the link was made, false when the user
 * cancelled the password prompt (AppleScript error -128). Anything else is a failed install, so it
 * throws with osascript's message rather than reading as "the password was not given".
 */
export function adminLinked(code: number, stderr: string): boolean {
  if (code === 0) return true;
  if (/\(-128\)\s*$/.test(stderr)) return false;
  throw new Error(stderr.trim() || `osascript exited ${code}`);
}
