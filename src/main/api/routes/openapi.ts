/**
 * `GET /v1/openapi.json` (docs/research/service-interface.md SI-2): the OpenAPI file generated
 * from this very route table, served with no key, because Executor fetches a spec added by URL
 * with no credentials. The file holds no secrets. The served copy lists only the running mode's
 * routes, names akou's address in `servers[0]`, and with `?scope=jobs` lists only what a `jobs`
 * key can call.
 */

import type { Scope } from "../access.ts";
import { json, type Router } from "../http.ts";
import { buildOpenApi, servedOpenApi, serverUrlFor } from "../openapi.ts";
import type { ApiApp } from "../server.ts";

/** The views `?scope=` names. An `admin` key calls everything, so its view is the unscoped one. */
const VIEWS = ["jobs"] as const satisfies readonly Scope[];

export function openapiRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/openapi.json",
    {
      id: "openapi.get",
      doc: "This API's OpenAPI 3.1 description, for the running mode. Needs no key. `scope=jobs` lists only the operations a `jobs` key can call, with no compatibility route.",
      access: "open",
      modes: ["app", "server"],
      door: "spec",
      query: {
        scope: {
          type: "string",
          values: VIEWS,
          doc: "`jobs`: only what a key with the `jobs` scope can call.",
        },
      },
      ok: 200,
    },
    (c) => {
      const scope = c.query.raw("scope");
      if (scope !== null && !(VIEWS as readonly string[]).includes(scope)) {
        return json(400, {
          error: "bad_param",
          message: `scope must be one of ${VIEWS.join(", ")}`,
          param: "scope",
        });
      }
      const settings = c.app.config().settings as Record<string, unknown>;
      const full = buildOpenApi(r.entries(), { version: c.app.version });
      return json(
        200,
        servedOpenApi(full, {
          mode: c.app.mode?.() ?? "app",
          scope: (scope ?? undefined) as Scope | undefined,
          serverUrl: serverUrlFor(settings["server.public_host"], c.req),
        }),
      );
    },
  );
}
