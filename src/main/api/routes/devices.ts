/**
 * The capture devices and the apps with audio (docs/ux/PROGRAMMABILITY.md PG-A8), from the capture
 * helper's device query (`akou-capture devices`, DESIGN 2.4). `akou devices`, `akou apps`, the
 * window's microphone picker and `akou_devices` read these routes.
 *
 * - `GET /devices`: the inputs and outputs; an input's `id` is what `POST /calls` takes as `mic`.
 * - `GET /apps`: the apps with audio; an app's `id` is what `POST /calls` takes as
 *   `call: "app:<id>"`. Where one app cannot be captured (Linux), 501 `apps_unavailable`.
 *
 * A helper that refuses (`AKOU_CAPTURE_FILE_ONLY=1`, no audio service) or is missing answers
 * 503 `devices_unavailable` with its reason, never an empty list.
 */

import { type CaptureDevices, DevicesRefused } from "../../capture/devices.ts";
import { HttpError, json, type RouteContext, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";

async function devicesOf(c: RouteContext<ApiApp>): Promise<CaptureDevices> {
  const query = c.app.devices;
  if (!query) throw new HttpError(404, "not_found", "this akou captures no devices");
  try {
    return await query.call(c.app);
  } catch (err) {
    if (err instanceof DevicesRefused) {
      throw new HttpError(503, "devices_unavailable", err.message, { helper: err.helperCode });
    }
    throw err;
  }
}

export function deviceRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/devices",
    {
      id: "devices.list",
      doc: "The microphones and outputs the capture helper sees, each with `id`, `name` and `default`. An input's `id` is what calls.start takes as `mic`. Opens no stream and asks for no permission. 503 `devices_unavailable` when the helper cannot list them (file-only mode, no audio service), never an empty list.",
      access: "admin",
      modes: ["app"],
      ok: 200,
      errors: { 404: ["not_found"], 503: ["devices_unavailable"] },
    },
    async (c) => {
      const d = await devicesOf(c);
      return json(200, { backend: d.backend, inputs: d.inputs, outputs: d.outputs });
    },
  );

  r.add(
    "GET",
    "/apps",
    {
      id: "devices.apps",
      doc: 'The apps with audio the capture helper sees, each with `id`, `name` and `pid`. An app\'s `id` is what calls.start takes as `call: "app:<id>"` to record that app alone. 501 `apps_unavailable` where one app cannot be captured (Linux, an older Windows), with the reason; 503 `devices_unavailable` when the helper cannot list at all.',
      access: "admin",
      modes: ["app"],
      ok: 200,
      errors: { 404: ["not_found"], 501: ["apps_unavailable"], 503: ["devices_unavailable"] },
    },
    async (c) => {
      const d = await devicesOf(c);
      if (d.apps === null) {
        throw new HttpError(501, "apps_unavailable", d.appsUnavailable ?? "no app list");
      }
      return json(200, { backend: d.backend, apps: d.apps });
    },
  );
}
