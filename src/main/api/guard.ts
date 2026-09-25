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
 *    64 KB. (Unknown body fields are refused by each route's body spec.) A route that takes an
 *    upload wants `multipart/form-data` instead, up to `server.max_upload_mb` (SV-D3).
 *
 * An `open` route (`/healthz`, `GET /v1/server`) needs no token; the other rules still hold. The
 * caller's scope is checked against the route's access before the body rules (`access.ts`).
 *
 * No CORS header is ever sent, and the app binds 127.0.0.1 only (`server.ts`). Server mode uses
 * `serverGuard` instead: per-key auth, a `Host` rule for a proxy, and browsers allowed (SV-D2).
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
import { APP_IDENTITY, allows, type Identity, type RouteMeta } from "./access.ts";

export const TOKEN_FILE = "token";
export const MAX_BODY_BYTES = 64 * 1024;
const BROWSER_HEADERS = ["origin", "sec-fetch-site", "sec-fetch-mode"] as const;

export interface GuardContext {
  /** The port the server listens on. */
  port: number;
  /** The bearer token. */
  token: string;
  /** The route asked for; an unknown path is checked as `admin` (`ADMIN_ROUTE`). */
  route: RouteMeta;
  /** The largest body an upload route takes, bytes (`server.max_upload_mb`). */
  maxUploadBytes: number;
  /** Where the request came from (`sourceAddress`), for the audit of a refusal. */
  source: string;
}

/** A refusal, or who is calling: null on an `open` route reached with no key. */
export type GuardResult = { refused: Response } | { identity: Identity | null };

export type Guard = (req: Request, ctx: GuardContext) => GuardResult;

function refuse(status: number, error: string, message: string): { refused: Response } {
  return { refused: Response.json({ error, message }, { status }) };
}

function unauthorized(): { refused: Response } {
  return {
    refused: new Response(
      JSON.stringify({ error: "unauthorized", message: "a valid bearer token is required" }),
      {
        status: 401,
        headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
      },
    ),
  };
}

/** Constant-time comparison of two strings of any length. */
export function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

function bearerOf(req: Request): string | null {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  return m ? (m[1] as string) : null;
}

/**
 * SV-K3: the caller's scope reaches the route (`allows`), checked before the body rules, so a
 * `jobs` key learns it has no business on an admin route whatever it sends.
 */
function scopeRule(
  req: Request,
  identity: Identity | null,
  ctx: GuardContext,
): { refused: Response } | null {
  if (allows(identity, ctx.route.access)) return null;
  return refuse(
    403,
    "forbidden",
    `this key's scope does not reach ${req.method} ${new URL(req.url).pathname}; it needs ${ctx.route.access}`,
  );
}

/**
 * Rule 4, with the one exception of SV-D3: a route that takes an upload wants
 * `multipart/form-data` and takes up to `maxUploadBytes`; every other route wants JSON and 64 KB.
 */
function bodyRule(req: Request, ctx: GuardContext): { refused: Response } | null {
  if (req.method !== "GET" && req.method !== "HEAD") {
    const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (ctx.route.upload) {
      if (type !== "multipart/form-data") {
        return refuse(
          415,
          "multipart_required",
          "an upload needs Content-Type: multipart/form-data",
        );
      }
    } else if (type !== "application/json") {
      return refuse(
        415,
        "json_required",
        "requests that change something need Content-Type: application/json",
      );
    }
  }
  // A declared size over the limit is refused before a byte of the body is read; a body that is
  // chunked, or lies about its size, is cut off at the same limit by `readBody`.
  const cap = ctx.route.upload ? ctx.maxUploadBytes : MAX_BODY_BYTES;
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > cap) {
    return refuse(413, "body_too_large", `bodies are capped at ${cap} bytes`);
  }
  return null;
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
  let identity: Identity | null = null;
  if (ctx.route.access !== "open") {
    const given = bearerOf(req);
    if (given === null || !tokenMatches(given, ctx.token)) return unauthorized();
    identity = APP_IDENTITY;
  }
  return scopeRule(req, identity, ctx) ?? bodyRule(req, ctx) ?? { identity };
};

export interface ServerGuardOptions {
  /** `server.public_host`: when set, the one Host accepted besides loopback. */
  publicHost: string;
  /** `server.behind_proxy`: with no public host, any Host is accepted. */
  behindProxy: boolean;
  keys: { authenticate(bearer: string): Identity | null; touch(id: string): void };
  /**
   * A request refused for the key it carried, for the audit (SV-K6): where from, and the key's
   * first bytes when it is an `ak_` key (else ""; a client may send another service's secret). A
   * request with no key is not reported: a scanner would grow the log by a line a request.
   */
  onRefused?(r: { source: string; keyPrefix: string; path: string }): void;
}

/**
 * Rule 3 in server mode (SV-D2): `Host` must be `server.public_host` when it is set, or anything
 * when `server.behind_proxy` is on, or loopback. A loopback Host on akou's port is always accepted:
 * DNS rebinding makes a browser send the attacker's name, never `127.0.0.1`, and the CLI on the
 * same box talks to the server that way.
 */
export function serverHostAllowed(
  host: string | null,
  port: number,
  o: Pick<ServerGuardOptions, "publicHost" | "behindProxy">,
): boolean {
  if (host === null) return false;
  const h = host.trim().toLowerCase();
  if (h === `127.0.0.1:${port}` || h === `localhost:${port}`) return true;
  const pub = o.publicHost.trim().toLowerCase();
  if (pub !== "") {
    if (h === pub) return true;
    // A public host named without a port matches that name on any port the proxy uses.
    return !pub.includes(":") && h.replace(/:\d+$/, "") === pub;
  }
  return o.behindProxy;
}

/**
 * The guard of server mode (docs/ux/SERVER.md SV-D2, SV-K2, SV-K3): per-key auth instead of the
 * one token, the Host rule above, and browser headers allowed, because a browser is a legitimate
 * client of the web UI on the network; the web UI's own door is the admin login (SV-U1). The
 * bearer is the app's token (`admin`, SV-K3) or an `ak_` key. The scope is checked after, in one
 * place, against the route's access (`allows`).
 */
export function serverGuard(o: ServerGuardOptions): Guard {
  return (req, ctx) => {
    if (!serverHostAllowed(req.headers.get("host"), ctx.port, o)) {
      return refuse(403, "bad_host", "Host must be server.public_host, or loopback");
    }
    const given = bearerOf(req);
    let identity: Identity | null = null;
    if (given !== null) {
      if (tokenMatches(given, ctx.token)) identity = APP_IDENTITY;
      else {
        identity = o.keys.authenticate(given);
        if (identity) o.keys.touch(identity.id);
      }
    }
    if (identity === null && ctx.route.access !== "open") {
      if (given !== null) {
        o.onRefused?.({
          source: ctx.source,
          keyPrefix: given.startsWith("ak_") ? given.slice(0, 7) : "",
          path: new URL(req.url).pathname,
        });
      }
      return unauthorized();
    }
    return scopeRule(req, identity, ctx) ?? bodyRule(req, ctx) ?? { identity };
  };
}

/** No checks at all. Only the security tests' positive control uses it; no setting reaches it. */
export const openGuard: Guard = () => ({ identity: APP_IDENTITY });

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
  return writePrivateFile(path, `${token}\n`, replace);
}

/**
 * The token file's atomic, private write for any secret file (the keys file too, SV-K2): `text`
 * lands whole with mode 0600 (or a user-only ACL) from its creation, or not at all. With `replace`
 * false it is created only if absent, and false says another writer won.
 */
export function writePrivateFile(path: string, text: string, replace: boolean): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      // An ACL that could not be set is not the user's alone: no token is written under it.
      if (process.platform === "win32" && !restrictToUser(tmp)) {
        throw new Error(`could not restrict ${tmp} to the current user`);
      }
      writeSync(fd, text);
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
