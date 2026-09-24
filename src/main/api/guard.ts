/**
 * The security of the local API (docs/DESIGN.md section 6.3), in one function that runs before any
 * route. hark's remote-control agent accepted a cross-origin `POST /stop` from any web page; every
 * rule here has a test in `tests/security.e2e.test.ts`, and each test has a positive control that
 * runs the same attack with the guard replaced by `openGuard` and sees it succeed.
 *
 * The order matters: the browser checks come first, so a cross-site page is refused with 403 whether
 * or not it guessed the token.
 *
 * 1. `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
 * 2. Any `Origin`, `Sec-Fetch-Site` or `Sec-Fetch-Mode` header is refused: our clients never send
 *    them, and browsers always do on a cross-origin request.
 * 3. `Authorization: Bearer <token>` on every request, GETs included, compared in constant time.
 * 4. Every method but GET and HEAD needs `Content-Type: application/json`; bodies are capped at
 *    64 KB. (Unknown body fields are refused by each route's body spec.)
 *
 * No CORS header is ever sent, and the server binds 127.0.0.1 only (`server.ts`).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TOKEN_FILE = "token";
export const MAX_BODY_BYTES = 64 * 1024;
const BROWSER_HEADERS = ["origin", "sec-fetch-site", "sec-fetch-mode"] as const;

export interface GuardContext {
  /** The port the server listens on. */
  port: number;
  /** The bearer token. */
  token: string;
}

/** Answers a refused request, or null to let it through. */
export type Guard = (req: Request, ctx: GuardContext) => Response | null;

function refuse(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

/** Constant-time comparison of two strings of any length. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

export const guard: Guard = (req, ctx) => {
  const host = req.headers.get("host");
  if (host !== `127.0.0.1:${ctx.port}` && host !== `localhost:${ctx.port}`) {
    return refuse(403, "bad_host", "Host must be 127.0.0.1 or localhost on akou's port");
  }
  for (const h of BROWSER_HEADERS) {
    if (req.headers.has(h)) {
      return refuse(403, "browser_request", `requests from a browser are refused (${h})`);
    }
  }
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer (\S+)$/.exec(auth);
  if (!m || !tokenMatches(m[1] as string, ctx.token)) {
    return new Response(
      JSON.stringify({ error: "unauthorized", message: "a valid bearer token is required" }),
      {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
      },
    );
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") {
      return refuse(
        415,
        "json_required",
        "requests that change something need Content-Type: application/json",
      );
    }
  }
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) {
    return refuse(413, "body_too_large", `bodies are capped at ${MAX_BODY_BYTES} bytes`);
  }
  return null;
};

/** No checks at all. Only the security tests' positive control uses it; no setting reaches it. */
export const openGuard: Guard = () => null;

// ---------------------------------------------------------------------------
// The token file

/** A token: 32 random bytes, hex. */
export function newToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Writes the token file atomically with mode 0600 from its creation: the bytes go to a private
 * temporary file created 0600, which is then renamed (or, for a first creation, hard-linked) into
 * place, so the file never exists with other permissions or half-written. Windows ignores the mode,
 * so there the empty temporary file is first restricted to the current user by its ACL, and only
 * then gets the bytes; a rename keeps that ACL.
 */
function writeTokenFile(path: string, token: string, replace: boolean): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      // An ACL that could not be set is not the user's alone: no token is written under it.
      if (process.platform === "win32" && !restrictToUser(tmp)) {
        throw new Error(`could not restrict ${tmp} to the current user`);
      }
      writeSync(fd, `${token}\n`);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    if (replace) {
      renameSync(tmp, path);
      return true;
    }
    try {
      linkSync(tmp, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function readToken(path: string): string | null {
  try {
    const t = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * The API token: read from `<configDir>/token`, or created there. A file with a bad token or loose
 * permissions (anyone but the owner can read it) is replaced, since a token others may have read
 * is not a secret any more.
 */
export function ensureToken(configDir: string): { token: string; path: string; created: boolean } {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = join(configDir, TOKEN_FILE);
  const usable = () => {
    const t = readToken(path);
    return t && !isLoose(path) ? t : null;
  };
  const existing = usable();
  if (existing) return { token: existing, path, created: false };
  const token = newToken();
  if (!existsSync(path)) {
    if (writeTokenFile(path, token, false)) return { token, path, created: true };
    // Another process created it first: use theirs if it is good.
    const raced = usable();
    if (raced) return { token: raced, path, created: false };
  }
  writeTokenFile(path, token, true);
  return { token, path, created: true };
}

/**
 * Who may read the token file: `private` (the owner alone: mode 0600, or on Windows an ACL that
 * allows nobody but the current user, SYSTEM and the administrators), `loose` (anyone else), or
 * `unknown` (Windows, when the ACL could not be read).
 */
export function tokenFileAccess(path: string): "private" | "loose" | "unknown" {
  if (process.platform !== "win32") {
    return (statSync(path).mode & 0o077) === 0 ? "private" : "loose";
  }
  const sid = currentUserSid();
  const sddl = sid ? readSddl(path) : null;
  if (!sid || !sddl) return "unknown";
  return othersAllowed(sddl, sid) ? "loose" : "private";
}

/** Anyone but the owner may read it. An ACL that cannot be read is not proof of that. */
function isLoose(path: string): boolean {
  return existsSync(path) && tokenFileAccess(path) === "loose";
}

/** The config folder holds the token and runtime.json: the owner's alone (0700, or a user-only ACL). */
export function makePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") restrictToUser(dir, true);
  else chmodSync(dir, 0o700);
}

// ---------------------------------------------------------------------------
// Windows ACLs. There are no mode bits: a file is made the user's alone by removing the entries it
// inherits and granting the current user full control, with `icacls` from System32 (never one found
// on PATH). It is checked by reading the ACL back as SDDL, whose SIDs read the same in every locale.

function system32(exe: string, args: string[]): string | null {
  const bin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
  try {
    const r = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
}

let userSid: string | null | undefined;

/** The current user's SID (`whoami /user`), read once. */
function currentUserSid(): string | null {
  if (userSid === undefined) {
    const out = system32("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    userSid = /S-1-[0-9-]+/.exec(out ?? "")?.[0] ?? null;
  }
  return userSid;
}

/** Drops inherited entries and grants only the current user; a folder passes that on to its files. */
function restrictToUser(path: string, folder = false): boolean {
  const sid = currentUserSid();
  if (!sid) return false;
  const grant = `*${sid}:${folder ? "(OI)(CI)F" : "F"}`;
  return system32("icacls.exe", [path, "/inheritance:r", "/grant:r", grant]) !== null;
}

/** The file's DACL as SDDL, via `icacls /save` (which only writes to a file). */
function readSddl(path: string): string | null {
  const out = join(tmpdir(), `akou-acl-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    if (system32("icacls.exe", [path, "/save", out]) === null) return null;
    return sddlOf(readFileSync(out));
  } catch {
    return null;
  } finally {
    rmSync(out, { force: true });
  }
}

/** The SDDL line of an `icacls /save` file: UTF-16 (with or without a BOM), the file name first. */
export function sddlOf(bytes: Uint8Array): string | null {
  const buf = Buffer.from(bytes);
  const wide = buf.length > 1 && (buf[1] === 0 || (buf[0] === 0xff && buf[1] === 0xfe));
  const text = (wide ? buf.toString("utf16le") : buf.toString("utf8")).replace(/^\uFEFF/, "");
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^(O:|G:|D:|S:)/.test(l)) ?? null
  );
}

/**
 * Who may hold an entry besides the user: SYSTEM (`SY`), the Administrators group (`BA`) and the
 * built-in Administrator account (`LA`, RID 500). Each can read every file on the machine through
 * its privileges anyway, so an entry for them lets nobody new in. A file an administrator creates
 * can carry them as explicit entries, which `/inheritance:r` does not remove (GitHub's Windows
 * runners do), and SDDL writes the RID 500 account as `LA` even when it is the current user.
 */
const PRIVILEGED = new Set(["SY", "BA", "LA", "S-1-5-18", "S-1-5-32-544"]);

/**
 * Does the DACL in `sddl` allow anyone but `sid` and the privileged accounts above? Deny entries
 * and inherit-only ones (which do not apply to the file itself) allow nobody; a missing or null
 * DACL allows everyone.
 */
export function othersAllowed(sddl: string, sid: string): boolean {
  // Section markers (`O:`, `G:`, `D:`, `S:`) only ever appear outside the parenthesised entries.
  const top = sddl.replace(/\([^)]*\)/g, (m) => "#".repeat(m.length));
  const at = top.indexOf("D:");
  if (at < 0) return true;
  const sacl = top.indexOf("S:", at);
  const dacl = sddl.slice(at + 2, sacl < 0 ? sddl.length : sacl);
  if (dacl.startsWith("NO_ACCESS_CONTROL")) return true;
  for (const [, ace] of dacl.matchAll(/\(([^)]*)\)/g)) {
    const [type = "", flags = "", , , , who = ""] = (ace as string).split(";");
    if (!["A", "OA", "XA", "ZA"].includes(type)) continue;
    if (flags.includes("IO")) continue;
    const trustee = who.toUpperCase();
    if (trustee !== sid.toUpperCase() && !PRIVILEGED.has(trustee)) return true;
  }
  return false;
}

/** `akou token rotate`: a new token replaces the old one atomically. */
export function rotateToken(configDir: string): string {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const token = newToken();
  writeTokenFile(join(configDir, TOKEN_FILE), token, true);
  return token;
}

/**
 * The token as the running app sees it: re-read when the file changes, so `akou token rotate`
 * takes effect at once without a restart. A file that disappears or goes bad keeps the last good
 * token in memory rather than opening the API. A file that others can now read (a chmod, an ACL
 * change) burns the token it holds: a new one replaces it at once, as `ensureToken` does at start.
 */
export class TokenSource {
  private token: string;
  private stamp: string;

  constructor(
    private readonly path: string,
    initial: string,
  ) {
    this.token = initial;
    this.stamp = this.fileStamp();
  }

  private fileStamp(): string {
    try {
      // ctime and mode: a chmod or an ACL change moves neither mtime nor size.
      const s = statSync(this.path);
      return `${s.mtimeMs}:${s.ctimeMs}:${s.mode}:${s.size}:${s.ino}`;
    } catch {
      return "";
    }
  }

  current(): string {
    const stamp = this.fileStamp();
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      if (isLoose(this.path)) {
        // The new token only works once written; if that fails, nobody holds it: closed, not open.
        this.token = newToken();
        try {
          writeTokenFile(this.path, this.token, true);
        } catch {}
        this.stamp = this.fileStamp();
      } else {
        const t = readToken(this.path);
        if (t) this.token = t;
      }
    }
    return this.token;
  }
}
