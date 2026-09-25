/**
 * Who is calling and what they may call (docs/ux/SERVER.md section 4): one identity per request,
 * set by the guard, and one access level per route, checked in one place (`startApiServer`) before
 * any handler runs.
 *
 * - `open`: no key at all (`/healthz`, `GET /v1/server`, the admin login).
 * - `jobs`: any key. A `jobs` key reads and writes its own jobs, events and results, and
 *   `GET /v1/keys/me` (SV-K3).
 * - `admin`: an `admin` key, the app's own token, or an admin session. Every route that exists
 *   today is `admin`: a `jobs` key has no business with calls, settings or quit.
 *
 * A route says its level when it is added (`Router.add(..., {access: "jobs"})`); a route that says
 * nothing is `admin`, so a new route is closed until someone opens it on purpose.
 *
 * This module imports nothing: the guard needs it, and the guard is loaded before `http.ts`. The
 * helpers that answer with an HTTP error are in `caller.ts`.
 */

export const SCOPES = ["jobs", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** Who may call a route: anyone, any key, or admin only. */
export type Access = "open" | Scope;

export interface RouteMeta {
  access: Access;
  /**
   * The route takes a multipart upload (SV-D3): exempt from the JSON-only rule and the 64 KB cap,
   * capped at `server.max_upload_mb` instead.
   */
  upload?: boolean;
}

/** What a route that says nothing gets, and what an unknown path is checked as. */
export const ADMIN_ROUTE: RouteMeta = { access: "admin" };

export interface Identity {
  /** The key id, or `app` for the app's token, or `session` for an admin login. */
  id: string;
  name: string;
  scopes: readonly Scope[];
  /** Epoch ms, for a key. */
  created_at?: number;
  /** The hosts a callback URL may name (SV-K4); `*` is any host. */
  callbackHosts: readonly string[];
}

/** The app's own token: `admin`, as it always was (SV-K3). */
export const APP_IDENTITY: Identity = {
  id: "app",
  name: "app",
  scopes: ["admin"],
  callbackHosts: ["*"],
};

/** Does this identity reach a route of this level? `admin` includes `jobs`. */
export function allows(identity: Identity | null, access: Access): boolean {
  if (access === "open") return true;
  if (!identity) return false;
  if (identity.scopes.includes("admin")) return true;
  return access === "jobs" && identity.scopes.includes("jobs");
}

/**
 * SV-K4: may this identity name `url` as its callback? The URL's host must be on the key's list,
 * or the list holds `*`. The address rules of SV-E7 (link-local and metadata addresses) are
 * checked separately, at submit and at delivery, and apply to `*` too.
 */
export function callbackAllowed(identity: Identity, url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "") return false;
  return identity.callbackHosts.some((h) => h === "*" || h.toLowerCase() === host);
}
