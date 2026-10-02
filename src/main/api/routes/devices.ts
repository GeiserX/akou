/**
 * The capture devices (docs/ux/PROGRAMMABILITY.md PG-A8), from the capture helper's own query.
 *
 * - `GET /devices`: `{backend, inputs, outputs}`, each device `{id, name, default}`, the ids that
 *   `POST /calls` takes as `mic` and `dictation.mic` names. A helper that refuses answers `503`
 *   with its reason (`file-only` under `AKOU_CAPTURE_FILE_ONLY=1`), never an empty list.
 */

import { HttpError, json, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";

export function deviceRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/devices",
    {
      id: "devices.list",
      doc: "The microphones and outputs the OS lists, from the capture helper, read without opening a stream or asking for a permission: `{backend, inputs, outputs}`, each device `{id, name, default}`. An input's `id` is what `POST /calls` takes as `mic` and `dictation.mic` names. A helper that cannot list them answers `503` with its reason (`file-only` when `AKOU_CAPTURE_FILE_ONLY=1`, `no_helper` when it is not installed), never an empty list.",
      access: "admin",
      modes: ["app"],
      ok: 200,
    },
    async (c) => {
      const r = c.app.devices
        ? await c.app.devices()
        : { ok: false as const, code: "no_helper", message: "this akou has no capture helper" };
      if (!r.ok) throw new HttpError(503, r.code, r.message);
      return json(200, r.list);
    },
  );
}
