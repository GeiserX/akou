/**
 * Resolving `{id}` on every route (docs/DESIGN.md section 6.2, TRAPS T3.14): a call ULID or `live`
 * everywhere; `last` only on GET routes and on the post-call actions `restart`, `finalize`,
 * `export` and `enhance`, so a control or a write can never land on a finished call by accident.
 */

import type { CallController } from "../../call/call.ts";
import { HttpError, type RouteContext, throwOutcome } from "../http.ts";
import type { ApiApp } from "../server.ts";

export interface ResolveOptions {
  /** `last` is accepted (GET routes and the post-call actions). */
  allowLast?: boolean;
}

export function resolveRef(app: ApiApp, ref: string, opts: ResolveOptions = {}): string {
  if (ref === "last" && !opts.allowLast) {
    throw new HttpError(
      400,
      "last_refused",
      "`last` is accepted only on GET routes and on restart, finalize, export and enhance; name the call or use `live`",
    );
  }
  const r = app.manager.resolve(ref, { control: !opts.allowLast });
  if (!r.ok) throwOutcome(r);
  return r.id;
}

/** The call a route is about, from `:id`. GET routes accept `last`. */
export async function callOf(
  c: RouteContext<ApiApp>,
  opts: ResolveOptions = {},
): Promise<CallController> {
  const allowLast = opts.allowLast ?? (c.req.method === "GET" || c.req.method === "HEAD");
  const id = resolveRef(c.app, c.params.id as string, { allowLast });
  return c.app.call(id);
}

export function callId(c: RouteContext<ApiApp>, opts: ResolveOptions = {}): string {
  const allowLast = opts.allowLast ?? (c.req.method === "GET" || c.req.method === "HEAD");
  return resolveRef(c.app, c.params.id as string, { allowLast });
}

/** Next id for an item kind (`n0012`): the seq the event will get, so ids never collide. */
export function nextItemId(prefix: string, lastSeq: number): string {
  return `${prefix}${String(lastSeq + 1).padStart(4, "0")}`;
}
