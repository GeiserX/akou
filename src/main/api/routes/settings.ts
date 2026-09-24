/**
 * The app itself (docs/DESIGN.md section 6.2): status, settings, templates, sharing, the window and
 * quit.
 *
 * `GET /status` always answers 200. `PATCH /config` validates through the settings registry, the
 * same way a hand-edited file is validated (TRAPS T4.9). `POST /share` starts a read-only live link
 * to a call (default `live`), `DELETE /share` stops it.
 */

import { join } from "node:path";
import {
  patchConfig,
  redactSettings,
  SETTING_KEYS,
  SETTINGS,
  type SettingSpec,
} from "../../config/schema.ts";
import { HttpError, json, type Router, readBody } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { resolveRef } from "./common.ts";

export function settingsRoutes(r: Router<ApiApp>): void {
  r.add("GET", "/status", async (c) => json(200, await c.app.status()));

  r.add("GET", "/config", (c) => {
    const cfg = c.app.config();
    return json(200, {
      file: cfg.paths.configFile,
      settings: redactSettings(cfg.settings),
      set: redactSettings(cfg.file),
      issues: cfg.issues,
      schema: Object.fromEntries(
        SETTING_KEYS.map((k) => {
          const s: SettingSpec = SETTINGS[k];
          return [
            k,
            { type: s.type, min: s.min, max: s.max, env: s.env, secret: s.secret, doc: s.doc },
          ];
        }),
      ),
    });
  });

  r.add("PATCH", "/config", async (c) => {
    const body = await readBody<Record<string, unknown>>(c.req, {}, { open: true });
    const cfg = c.app.config();
    const res = patchConfig(cfg.file, body, cfg.paths);
    if (!res.ok) {
      throw new HttpError(400, "bad_setting", res.errors.join("; "), { errors: res.errors });
    }
    const next = await c.app.saveConfig(res.file);
    return json(200, {
      ok: true,
      settings: redactSettings(next.settings),
      set: redactSettings(next.file),
      issues: next.issues,
      note: "capture, speech and API settings take effect at the next start of akou",
    });
  });

  r.add("GET", "/templates", (c) => {
    const all = c.app.templates();
    return json(200, {
      dir: join(c.app.configDir, "templates"),
      templates: all.map((t) => t.name),
      details: all.map((t) => ({
        name: t.name,
        match: t.match,
        sections: t.sections.map((s) => s.heading),
        bundled: t.bundled,
      })),
    });
  });

  r.add("GET", "/share", (c) => {
    const shares = c.app.shares();
    return json(200, { active: shares.length > 0, shares });
  });

  r.add("POST", "/share", async (c) => {
    const b = await readBody<{ call?: string; bind?: string; notes?: boolean; expires?: string }>(
      c.req,
      { "call?": "string", "bind?": "string", "notes?": "boolean", "expires?": "string" },
    );
    const call = resolveRef(c.app, b.call ?? "live", { allowLast: true });
    const share = await c.app.startShare(call, b);
    return json(201, share);
  });

  r.add("DELETE", "/share", async (c) => {
    const b = await readBody<{ call?: string }>(c.req, { "call?": "string" });
    const call = b.call === undefined ? undefined : resolveRef(c.app, b.call, { allowLast: true });
    const stopped = await c.app.stopShare(call);
    return json(200, { ok: true, stopped });
  });

  r.add("POST", "/window", async (c) => {
    const b = await readBody<{ call?: string }>(c.req, { "call?": "string" });
    const call = b.call === undefined ? undefined : resolveRef(c.app, b.call, { allowLast: true });
    return json(200, await c.app.openWindow(call));
  });

  r.add("POST", "/quit", async (c) => {
    await readBody(c.req, {});
    c.app.quit();
    return json(202, { ok: true, quitting: true });
  });
}
