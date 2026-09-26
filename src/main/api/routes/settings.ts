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
import { HttpError, json, OPEN_BODY, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { resolveRef } from "./common.ts";

export function settingsRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/status",
    {
      id: "app.status",
      doc: "What akou is doing now: the app, the live call if there is one with its state and health, and the last call.",
      access: "admin",
      modes: ["app"],
      ok: 200,
    },
    async (c) => json(200, await c.app.status()),
  );

  r.add(
    "GET",
    "/config",
    {
      id: "config.get",
      doc: "Every setting: its value, the values set in the config file, problems found in the file, and the schema of each key. Secrets are redacted.",
      access: "admin",
      modes: ["app", "server"],
      ok: 200,
    },
    (c) => {
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
              {
                type: s.type,
                min: s.min,
                max: s.max,
                values: s.values,
                env: s.env,
                secret: s.secret,
                // File only when false: it names a program akou runs or where transcripts are sent.
                apiWritable: s.apiWritable !== false,
                doc: s.doc,
              },
            ];
          }),
        ),
      });
    },
  );

  r.add(
    "PATCH",
    "/config",
    {
      id: "config.update",
      doc: "Change settings: a JSON object of dotted keys to new values, `null` to unset one. Every value is checked against the settings registry; one bad key refuses the whole change.",
      access: "admin",
      modes: ["app", "server"],
      body: OPEN_BODY,
      ok: 200,
    },
    async (c) => {
      const body = await c.body<Record<string, unknown>>();
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
    },
  );

  r.add(
    "GET",
    "/templates",
    {
      id: "templates.list",
      doc: "The note templates the enhanced notes can use: the shipped ones and the user's own, with the sections of each.",
      access: "admin",
      modes: ["app"],
      ok: 200,
    },
    (c) => {
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
    },
  );

  r.add(
    "GET",
    "/share",
    {
      id: "share.get",
      doc: "The read-only live links that are on, one per shared call.",
      access: "admin",
      modes: ["app"],
      ok: 200,
    },
    (c) => {
      const shares = c.app.shares();
      return json(200, { active: shares.length > 0, shares });
    },
  );

  r.add(
    "POST",
    "/share",
    {
      id: "share.start",
      doc: "Start a read-only live link to a call (default `live`). `bind` is `tailnet`, `lan` or an IPv4 address; `notes` also shares the notepad; `expires` is a duration such as `2h`.",
      access: "admin",
      modes: ["app"],
      body: { "call?": "string", "bind?": "string", "notes?": "boolean", "expires?": "string" },
      ok: 201,
    },
    async (c) => {
      const b = await c.body<{ call?: string; bind?: string; notes?: boolean; expires?: string }>();
      const call = resolveRef(c.app, b.call ?? "live", { allowLast: true });
      const share = await c.app.startShare(call, { ...b, by: c.by });
      return json(201, share);
    },
  );

  r.add(
    "DELETE",
    "/share",
    {
      id: "share.stop",
      doc: "Stop the live link of one call, or every link when no call is named.",
      access: "admin",
      modes: ["app"],
      body: { "call?": "string" },
      ok: 200,
    },
    async (c) => {
      const b = await c.body<{ call?: string }>();
      const call =
        b.call === undefined ? undefined : resolveRef(c.app, b.call, { allowLast: true });
      const stopped = await c.app.stopShare(call);
      return json(200, { ok: true, stopped });
    },
  );

  r.add(
    "POST",
    "/window",
    {
      id: "window.open",
      doc: "Show the window, on a call if one is named. With no window (headless) the answer is the address of the window in a browser, with a one-time code.",
      access: "admin",
      modes: ["app"],
      body: { "call?": "string" },
      ok: 200,
    },
    async (c) => {
      const b = await c.body<{ call?: string }>();
      const call =
        b.call === undefined ? undefined : resolveRef(c.app, b.call, { allowLast: true });
      return json(200, await c.app.openWindow(call));
    },
  );

  r.add(
    "POST",
    "/quit",
    {
      id: "app.quit",
      doc: "Quit akou cleanly, after the answer is sent. A live call is stopped first.",
      access: "admin",
      modes: ["app"],
      body: {},
      ok: 202,
    },
    async (c) => {
      await c.body();
      c.app.quit();
      return json(202, { ok: true, quitting: true });
    },
  );
}
