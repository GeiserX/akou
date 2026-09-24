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
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
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
 * place, so the file never exists with other permissions or half-written. On Windows the mode is
 * ignored and the file inherits the per-user ACL of the config folder.
 */
function writeTokenFile(path: string, token: string, replace: boolean): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  try {
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

/** Anyone but the owner may read or write it. Windows has no mode bits; its ACL is inherited. */
function isLoose(path: string): boolean {
  if (process.platform === "win32" || !existsSync(path)) return false;
  return (statSync(path).mode & 0o077) !== 0;
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
 * token in memory rather than opening the API.
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
      const s = statSync(this.path);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return "";
    }
  }

  current(): string {
    const stamp = this.fileStamp();
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      const t = readToken(this.path);
      if (t && !isLoose(this.path)) this.token = t;
    }
    return this.token;
  }
}
