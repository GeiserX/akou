/**
 * The app itself (docs/DESIGN.md section 6.2): status, settings, templates, sharing, the window and
 * quit.
 *
 * `GET /status` always answers 200. `PATCH /config` validates through the settings registry, the
 * same way a hand-edited file is validated (TRAPS T4.9). `POST /share` starts a read-only live link
 * to a call (default `live`), `DELETE /share` stops it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSettingKey,
  patchConfig,
  redactSettings,
  SETTING_KEYS,
  SETTINGS,
  type SettingKey,
  type SettingSpec,
} from "../../config/schema.ts";
import { STORED_SECRETS } from "../../config/secrets.ts";
import { fillPreset, type Preset, usesSpeaker } from "../../notes/presets.ts";
import { errorsOf } from "../errors.ts";
import { HttpError, json, OPEN_BODY, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { CALL_REF_ERRORS, resolveRef } from "./common.ts";

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
      doc: "Every setting: its value, the values set in the config file, problems found in the file, and the schema of each key. Secrets are redacted; one saved in the macOS Keychain says `keychain: true`.",
      access: "admin",
      modes: ["app", "server"],
      ok: 200,
    },
    (c) => {
      const cfg = c.app.config();
      const keychain = c.app.secretStore?.() === "keychain";
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
                // With apiWritable false: the desktop window may still set it.
                ...(s.windowWritable ? { windowWritable: true } : {}),
                // Saved in the macOS Keychain, never in the file.
                ...(keychain && (STORED_SECRETS as readonly string[]).includes(k)
                  ? { keychain: true }
                  : {}),
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
      errors: { 400: ["bad_setting"], 500: ["keychain"] },
    },
    async (c) => {
      const body = await c.body<Record<string, unknown>>();
      const cfg = c.app.config();
      // The window's bridge runs in process with no identity; every HTTP request has one.
      const inProcess = c.identity === undefined;
      const keep = Object.keys(body).filter(
        (k): k is SettingKey =>
          isSettingKey(k) && (SETTINGS[k] as SettingSpec).apiWritable === false,
      );
      // Made from the file as the save before it left it: saves run one at a time.
      const change = (current: typeof cfg.file) => {
        const res = patchConfig(current, body, cfg.paths, { inProcess });
        if (!res.ok)
          throw new HttpError(400, "bad_setting", res.errors.join("; "), { errors: res.errors });
        return res.file;
      };
      const next = await c.app.saveConfig(change, { keep: inProcess ? keep : [] });
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
    "/presets",
    {
      id: "presets.list",
      doc: "The ask presets: the shipped ones and the user's own files, in menu order, read from the folder on every request. Without `call`, each `question` is the file's body with `{speaker}`, `{user}` and `{title}` unfilled, and `usesSpeaker` says which ask about one speaker. With `call`, they are filled in for that call: `{user}` from `user.name`, `{title}` from its title, and a preset that names `{speaker}` once per named speaker, or for `speaker` alone. A preset is a question for one call: ask it with `POST /calls/{id}/ask`.",
      access: "admin",
      modes: ["app"],
      query: {
        call: {
          type: "string",
          doc: "Fill the presets in for this call: `live`, `last` or an id.",
        },
        speaker: {
          type: "string",
          doc: "With `call`: fill `{speaker}` with this name instead of each named speaker.",
        },
      },
      ok: 200,
    },
    async (c) => {
      const all = c.app.presets();
      const dir = join(c.app.configDir, "presets");
      const ref = c.query.raw("call");
      if (ref === null) {
        return json(200, {
          dir,
          presets: all.map((p) => ({
            name: p.name,
            label: p.label,
            order: p.order,
            question: p.question,
            usesSpeaker: usesSpeaker(p),
            bundled: p.bundled,
          })),
        });
      }
      // Outside `/calls`, so the server did not wait for recovery to index the calls: wait here.
      await c.app.manager.init();
      const view = (await c.app.call(resolveRef(c.app, ref, { allowLast: true }))).view;
      const one = c.query.raw("speaker")?.trim();
      const speakers = one
        ? [one]
        : view
            .roster()
            .filter((s) => s.spk !== "you" && !s.mergedInto && s.name)
            .map((s) => s.label);
      const base = { user: c.app.config().settings["user.name"], title: view.call?.title ?? "" };
      const filled = (p: Preset, speaker?: string) => {
        const v = { ...base, speaker };
        return {
          name: p.name,
          label: fillPreset(p.label, v),
          order: p.order,
          question: fillPreset(p.question, v),
          usesSpeaker: speaker !== undefined,
          ...(speaker !== undefined ? { speaker } : {}),
          bundled: p.bundled,
        };
      };
      return json(200, {
        dir,
        call: view.call?.id ?? null,
        presets: all.flatMap((p) =>
          usesSpeaker(p) ? speakers.map((s) => filled(p, s)) : [filled(p)],
        ),
      });
    },
  );

  r.add(
    "GET",
    "/templates/:name",
    {
      id: "templates.get",
      doc: "One note template as the enhanced notes would use it: the user's own file when one of that name replaces the shipped one. `text` is the whole file, frontmatter included; `path` is where it was read from.",
      access: "admin",
      modes: ["app"],
      params: { name: "The template's name (`standup`), as `GET /templates` lists it." },
      ok: 200,
      errors: { 404: ["not_found"] },
    },
    (c) => {
      const t = c.app.templates().find((x) => x.name === c.params.name);
      if (!t) throw new HttpError(404, "not_found", `no template "${c.params.name}"`);
      let text: string;
      try {
        text = readFileSync(t.source, "utf8");
      } catch {
        throw new HttpError(404, "not_found", `template "${t.name}" is gone from ${t.source}`);
      }
      return json(200, {
        name: t.name,
        match: t.match,
        sections: t.sections.map((s) => s.heading),
        bundled: t.bundled,
        path: t.source,
        text,
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
      errors: errorsOf(CALL_REF_ERRORS, {
        400: ["bad_bind", "bad_expires"],
        409: ["no_lan", "no_tailnet", "share_port"],
        503: ["quitting"],
      }),
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
      errors: CALL_REF_ERRORS,
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
      doc: "Show the window, on a call if one is named, opening it if the app runs headless. With no desktop shell (the Linux tarball, a source checkout) the answer is the address of the window in a browser, with a one-time code.",
      access: "admin",
      modes: ["app"],
      body: { "call?": "string" },
      ok: 200,
      errors: errorsOf(CALL_REF_ERRORS, { 503: ["quitting"] }),
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
