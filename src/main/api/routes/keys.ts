/**
 * Keys over HTTP (docs/ux/SERVER.md SV-K7), admin only, server mode only: the routes the web UI's
 * Keys page (SV-U3) calls. They edit the same `keys.json` as `akou keys` (SV-K2), through the same
 * `KeyStore`, so a key made in either place works in the other.
 *
 * - `GET /v1/keys`: every key's id, name, scopes, callback hosts, creation and last use. Never the
 *   key, its hash or its webhook secret.
 * - `POST /v1/keys {name, scopes?, callback_hosts?}`: 201 with the `ak_` key and the `whsec_`
 *   secret, the only time either is shown.
 * - `DELETE /v1/keys/{id}`: revokes; the key gets 401 on its next request.
 */

import { SCOPES, type Scope } from "../access.ts";
import { HttpError, json, type RouteContext, type Router } from "../http.ts";
import { KeyError, type KeyStore } from "../keys.ts";
import type { ApiApp } from "../server.ts";

const KEY_ROUTE = { access: "admin", modes: ["server"] } as const;

function storeOf(c: RouteContext<ApiApp>): KeyStore {
  const keys = c.app.keys?.();
  if (!keys) throw new HttpError(404, "not_found", "keys exist in server mode only");
  return keys;
}

/** The one scope a new key gets: `admin` includes `jobs`, so a list naming both is `admin`. */
function scopeOf(scopes: readonly string[] | undefined): Scope {
  if (scopes === undefined) return "jobs";
  const unknown = scopes.find((s) => !(SCOPES as readonly string[]).includes(s));
  if (scopes.length === 0 || unknown !== undefined) {
    throw new HttpError(422, "bad_field", `scopes is a list of ${SCOPES.join(", ")}`, {
      field: "scopes",
    });
  }
  return scopes.includes("admin") ? "admin" : "jobs";
}

function refused(err: unknown): never {
  if (!(err instanceof KeyError)) throw err;
  if (err.reason === "exists") throw new HttpError(409, "key_exists", err.message);
  if (err.reason === "busy") throw new HttpError(409, "keys_busy", err.message);
  const field = err.reason === "scope" ? "scopes" : err.reason;
  throw new HttpError(422, "bad_field", err.message, { field });
}

export function keyRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/keys",
    {
      id: "keys.list",
      doc: "Every API key: id, name, scopes, callback hosts, when it was created and last used. Never a key or a webhook secret.",
      ...KEY_ROUTE,
      ok: 200,
    },
    (c) => json(200, { keys: storeOf(c).list() }),
  );

  r.add(
    "POST",
    "/keys",
    {
      id: "keys.create",
      doc: "Create a key for a program. `scopes` is `jobs` (the default) or `admin`; `callback_hosts` are the hosts its callback URLs may name. The answer holds the `ak_` key and the `whsec_` webhook secret, shown this once only.",
      ...KEY_ROUTE,
      body: { name: "string", "scopes?": "string[]", "callback_hosts?": "string[]" },
      ok: 201,
    },
    async (c) => {
      const keys = storeOf(c);
      const b = await c.body<{ name: string; scopes?: string[]; callback_hosts?: string[] }>();
      const scope = scopeOf(b.scopes);
      try {
        return json(201, keys.create({ name: b.name, scope, callbackHosts: b.callback_hosts }));
      } catch (err) {
        refused(err);
      }
    },
  );

  r.add(
    "DELETE",
    "/keys/:id",
    {
      id: "keys.revoke",
      doc: "Revoke a key by its id. It gets 401 on its next request; a web UI session it opened ends.",
      ...KEY_ROUTE,
      params: { id: "The key id, `key_…`." },
      ok: 200,
    },
    (c) => {
      const id = c.params.id as string;
      let gone: boolean;
      try {
        gone = storeOf(c).revoke(id);
      } catch (err) {
        refused(err);
      }
      if (!gone) throw new HttpError(404, "not_found", `no key ${id}`);
      return json(200, { id, revoked: true });
    },
  );
}
