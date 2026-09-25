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
 * This module imports only `net.ts`, which imports nothing of akou's: the guard needs it, and the
 * guard is loaded before `http.ts`. The helpers that answer with an HTTP error are in `caller.ts`.
 */

import { isNonPublicHost } from "./net.ts";

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

/** What a route that says nothing gets (`Router.add`). */
export const ADMIN_ROUTE: RouteMeta = { access: "admin" };

/**
 * What a path that is no route (or a method it does not take) is checked as: any key, so a
 * request with none is 401 before any 404, and a valid key then gets the 404 or 405 it earned,
 * not a 403 that says the typo needs admin.
 */
export const UNKNOWN_ROUTE: RouteMeta = { access: "jobs" };

export interface Identity {
  /** The key id, or `app` for the app's token, or `session` for an admin login. */
  id: string;
  name: string;
  scopes: readonly Scope[];
  /** Epoch ms, for a key. */
  created_at?: number;
  /** The hosts a callback URL may name (SV-K4); `*` is any public host. */
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
 * SV-K4: may this identity name `url` as its callback? The URL's host must be on the key's list
 * by name, or the list holds `*` and the host is not a loopback, private, link-local or
 * unique-local literal (`isNonPublicHost`): those are reached only when a key lists them. A name
 * that resolves into those blocks is SV-E7's to refuse, at delivery time after DNS.
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
  if (identity.callbackHosts.some((h) => h.toLowerCase() === host)) return true;
  return identity.callbackHosts.includes("*") && !isNonPublicHost(host);
}
