/**
 * The app itself (docs/DESIGN.md section 6.2): status, settings, templates, sharing and quit.
 *
 * `GET /status` always answers 200. `PATCH /config` validates through the settings registry, the
 * same way a hand-edited file is validated (TRAPS T4.9). Sharing is M4 and answers 501 on changes.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { patchConfig, SETTING_KEYS, SETTINGS, type SettingSpec } from "../../config/schema.ts";
import { HttpError, json, type Router, readBody } from "../http.ts";
import type { ApiApp } from "../server.ts";

export function settingsRoutes(r: Router<ApiApp>): void {
  r.add("GET", "/status", (c) => json(200, c.app.status()));

  r.add("GET", "/config", (c) => {
    const cfg = c.app.config();
    return json(200, {
      file: cfg.paths.configFile,
      settings: cfg.settings,
      set: cfg.file,
      issues: cfg.issues,
      schema: Object.fromEntries(
        SETTING_KEYS.map((k) => {
          const s: SettingSpec = SETTINGS[k];
          return [k, { type: s.type, min: s.min, max: s.max, env: s.env, doc: s.doc }];
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
      settings: next.settings,
      set: next.file,
      issues: next.issues,
      note: "capture, speech and API settings take effect at the next start of akou",
    });
  });

  r.add("GET", "/templates", (c) => {
    const dir = join(c.app.configDir, "templates");
    const names = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => f.slice(0, -3))
          .sort()
      : [];
    return json(200, { dir, templates: names });
  });

  r.add("GET", "/share", () => json(200, { active: false, shares: [] }));
  for (const method of ["POST", "DELETE"]) {
    r.add(method, "/share", async (c) => {
      await readBody(c.req, {
        "call?": "string",
        "bind?": "string",
        "notes?": "boolean",
        "expires?": "string",
      });
      throw new HttpError(501, "not_implemented", "sharing is not built yet (M4)");
    });
  }

  r.add("POST", "/quit", async (c) => {
    await readBody(c.req, {});
    c.app.quit();
    return json(202, { ok: true, quitting: true });
  });
}
