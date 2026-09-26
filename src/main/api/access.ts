/**
 * What a route may be called with (docs/ux/SERVER.md section 4): one access level per route, set
 * in the route's `RouteDoc` in the one route table, and checked in one place (the guard, fed by
 * `startApiServer`) before any handler runs.
 *
 * - `open`: no key at all (`GET /v1/openapi.json`; `/healthz` and `GET /v1/server` once built).
 * - `jobs`: any key. A `jobs` key reads and writes its own jobs, events and results, and
 *   `GET /v1/keys/me` (SV-K3).
 * - `admin`: an `admin` key, the app's own token, or an admin session. Every call route is
 *   `admin`: a `jobs` key has no business with calls, settings or quit.
 *
 * This module imports nothing: the guard needs it, and the guard is loaded before `http.ts`.
 */

export const SCOPES = ["jobs", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** Who may call a route: anyone, any key, or admin only. */
export type Access = "open" | Scope;

/**
 * What the guard needs to know about a route. A route's `RouteDoc` extends it, so the route table
 * is the one place a route's access is written. Whether a route takes an upload (SV-D3) is not a
 * second flag: its body spec says so (`isMultipart`).
 */
export interface RouteMeta {
  access: Access;
}

/** What an unknown path is checked as: closed. */
export const ADMIN_ROUTE: RouteMeta = { access: "admin" };
