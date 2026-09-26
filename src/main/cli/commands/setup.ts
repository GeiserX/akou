/**
 * Setup commands (docs/DESIGN.md section 6.1): `config`, `token`, `models`, `share`, and the ones
 * whose machinery is not built yet (`devices`, `apps`, `self-update`), which say
 * so and exit 69 rather than pretend.
 *
 * `token` and `models` work without the app: they touch only akou's own config and models folders.
 * `token path` prints where the token is, never the token.
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { rotateToken } from "../../api/guard.ts";
import type { DiarizerKind } from "../../asr/engine.ts";
import {
  DownloadRefused,
  downloadModels,
  MODELS,
  type ModelSpecEntry,
  modelFile,
  modelsFor,
  pruneRetiredModels,
  sha256File,
  verifyModels,
} from "../../asr/models.ts";
import { isPreset, PRESET_NAMES, presetModels } from "../../asr/presets.ts";
import { isSettingKey, loadConfig, SETTINGS, type SettingSpec } from "../../config/schema.ts";
import { str } from "../args.ts";
import { EXIT } from "../client.ts";
import { api, type Body, type Command, type Ctx, callFlag, finish, notBuilt } from "../context.ts";
import { usage } from "./calls.ts";

/** A value from the command line: JSON when it parses (`8476`, `true`, `["a"]`), else a string. */
export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const config: Command = {
  name: "config",
  summary: "Show, set or unset a setting (validated by the settings registry)",
  usage:
    "akou config show | akou config set KEY VALUE | akou config set KEY - (the value on stdin; required for secrets) | akou config unset KEY   [--json]",
  examples: [
    "akou config show",
    "akou config set asr.threads 4",
    "printf '%s' \"$KEY\" | akou config set provider.apiKey -",
    "akou config unset asr.threads",
  ],
  run: async (ctx, p) => {
    const [sub, key, ...rest] = p.positional;
    if (sub === "show") {
      const r = await api(ctx, "GET", "/config");
      return finish(ctx, r, (b) => {
        const out = Object.entries(b.schema as Record<string, Body>).map(([k, s]) => {
          const set = Object.hasOwn(b.set, k) ? "" : "  (default)";
          return `${k} = ${JSON.stringify(b.settings[k])}${set}\n    ${s.doc}`;
        });
        for (const i of b.issues ?? []) out.push(`refused: ${i.message}`);
        return [`# ${b.file}`, ...out].join("\n");
      });
    }
    if (sub === "set") {
      if (!key || rest.length === 0) return usage(ctx, "config set needs a key and a value");
      const secret = isSettingKey(key) && (SETTINGS[key] as SettingSpec).secret === true;
      const fromStdin = rest.length === 1 && rest[0] === "-";
      if (secret && !fromStdin) {
        // A secret on the command line lands in shell history and in `ps` (CLI-06).
        return refuseSecretArg(ctx, key);
      }
      let value: unknown;
      if (fromStdin) {
        // Typed at a terminal, the read waits for the end of input: say so, or it looks hung.
        if (ctx.io.keys) {
          const end = process.platform === "win32" ? "Ctrl-Z then Enter" : "Ctrl-D";
          ctx.io.err(`akou: reading the value from stdin; end it with ${end}`);
        }
        // One trailing newline is the shell's (`echo`), not the value's.
        const raw = (await (ctx.io.readStdin?.() ?? Promise.resolve(""))).replace(/\r?\n$/, "");
        if (raw === "") return usage(ctx, `config set ${key} - read nothing from stdin`);
        value = secret ? raw : parseValue(raw);
      } else {
        value = parseValue(rest.join(" "));
      }
      const r = await api(ctx, "PATCH", "/config", { body: { [key]: value } });
      return finish(ctx, r, (b) => `${key} = ${JSON.stringify(b.settings[key])}\n${b.note}`);
    }
    if (sub === "unset") {
      if (!key || rest.length > 0) return usage(ctx, "config unset needs one key");
      const r = await api(ctx, "PATCH", "/config", { body: { [key]: null } });
      return finish(ctx, r, (b) => `${key} = ${JSON.stringify(b.settings[key])} (default)`);
    }
    return usage(ctx, "config needs show, set or unset");
  },
};

/** Refuses a secret given as an argument: exit 64, nothing stored, and the stdin form to use. */
function refuseSecretArg(ctx: Ctx, key: string): number {
  const message = `${key} is a secret, so akou never takes it from the command line, where shell history and ps would keep it; if that was a real key, rotate it`;
  const hint = `printf '%s' "$VALUE" | akou config set ${key} -`;
  if (ctx.json) ctx.io.out(JSON.stringify({ error: "usage", message, hint }));
  else ctx.io.err(`akou: ${message}\n  try: ${hint}`);
  return EXIT.usage;
}

const token: Command = {
  name: "token",
  summary: "Where the API token is, or rotate it (the running app follows at once)",
  usage: "akou token path | akou token rotate   [--json]",
  examples: ["akou token path", "akou token rotate"],
  run: async (ctx, p) => {
    const sub = p.positional[0];
    if (sub === "path") {
      const path = ctx.client.tokenPath();
      ctx.io.out(ctx.json ? JSON.stringify({ path }) : path);
      return EXIT.ok;
    }
    if (sub === "rotate") {
      rotateToken(ctx.client.configDir);
      const path = ctx.client.tokenPath();
      if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, path }));
      else
        ctx.io.out(`Rotated the token in ${path}; clients read the new one on their next request`);
      return EXIT.ok;
    }
    return usage(ctx, "token needs path or rotate");
  },
};

/** The models this machine needs for its `asr.diarizer` (or the registry a test gives). */
function registry(ctx: Ctx): readonly ModelSpecEntry[] {
  return ctx.models ?? modelsFor(loadConfig(ctx.io.env).settings["asr.diarizer"] as DiarizerKind);
}

function modelsDir(ctx: Ctx): string {
  return loadConfig(ctx.io.env).settings["asr.modelsDir"];
}

/** Quick state of each file (presence and size); `akou doctor` also checks the SHA-256. */
function quickState(dir: string, m: ModelSpecEntry): string {
  let ok = 0;
  for (const f of m.files) {
    const path = modelFile(dir, m.id, f.name);
    if (existsSync(path) && statSync(path).size === f.size) ok++;
  }
  return ok === m.files.length
    ? "present"
    : ok === 0
      ? "missing"
      : `incomplete (${ok}/${m.files.length})`;
}

/**
 * `models import DIR`: copies every file whose SHA-256 matches from `DIR/<model>/<file>` or
 * `DIR/<file>`, for machines that cannot download.
 */
async function importModels(
  ctx: Ctx,
  from: string,
): Promise<{ copied: string[]; missing: string[] }> {
  const dir = modelsDir(ctx);
  const copied: string[] = [];
  const missing: string[] = [];
  for (const m of registry(ctx)) {
    for (const f of m.files) {
      const target = modelFile(dir, m.id, f.name);
      const source = [join(from, m.id, f.name), join(from, f.name)].find(
        (s) => existsSync(s) && statSync(s).size === f.size,
      );
      if (!source || (await sha256File(source)) !== f.sha256) {
        // A file already there counts only at its full size, as `models list` reads it.
        if (!existsSync(target) || statSync(target).size !== f.size) {
          missing.push(`${m.id}/${f.name}`);
        }
        continue;
      }
      mkdirSync(join(dir, m.id), { recursive: true });
      const tmp = `${target}.import`;
      copyFileSync(source, tmp);
      renameSync(tmp, target);
      copied.push(`${m.id}/${f.name}`);
    }
  }
  return { copied, missing };
}

/**
 * What `models pull` fetches: with no name, every model this machine's settings need; with a preset
 * (`fast`) or a model id, exactly those, from the whole registry. A preset with no engine yet, or
 * a name that is neither, is an answer with no download.
 */
function pullPlan(
  ctx: Ctx,
  name: string | undefined,
):
  | { ids: string[]; registry: readonly ModelSpecEntry[]; preset?: string; named?: string }
  | { exit: number; message: string } {
  if (name === undefined) {
    const reg = registry(ctx);
    return { ids: reg.map((m) => m.id), registry: reg };
  }
  const all = ctx.models ?? MODELS;
  if (isPreset(name)) {
    const p = presetModels(name);
    if ("unavailable" in p) {
      return {
        exit: EXIT.unavailable,
        message: `the ${name} preset has no engine in this version: ${p.unavailable}; \`akou models pull fast\` gets the one that exists`,
      };
    }
    return { ids: [...p.models], registry: all, preset: name, named: name };
  }
  if (all.some((m) => m.id === name)) return { ids: [name], registry: all, named: name };
  return {
    exit: EXIT.usage,
    message: `no preset or model is called "${name}": the presets are ${PRESET_NAMES.join(", ")}, and \`akou models list\` names the models`,
  };
}

const models: Command = {
  name: "models",
  summary: "The speech models: list, pull (download, checksummed) or import from a folder",
  usage:
    "akou models list | akou models pull [PRESET|MODEL] | akou models import DIR   [--json]\n" +
    "  PRESET is lite, fast, best, fusion or auto; MODEL is an id from `akou models list`.\n" +
    "  No app needs to run: an image build or an entrypoint pulls before the server starts.",
  examples: [
    "akou models list",
    "akou models pull fast",
    "akou models pull",
    "akou models import /Volumes/usb/akou-models",
  ],
  run: async (ctx, p) => {
    const [sub, arg] = p.positional;
    const dir = modelsDir(ctx);
    if (sub === "list") {
      const rows = registry(ctx).map((m) => ({
        id: m.id,
        job: m.job,
        licence: m.licence,
        bytes: m.files.reduce((n, f) => n + f.size, 0),
        state: quickState(dir, m),
      }));
      if (ctx.json) ctx.io.out(JSON.stringify({ dir, models: rows }));
      else {
        ctx.io.out(`# ${dir}`);
        for (const r of rows) {
          ctx.io.out(
            `${r.id}  ${r.state}  ${(r.bytes / 1e6).toFixed(0)} MB  ${r.licence}  (${r.job})`,
          );
        }
      }
      return EXIT.ok;
    }
    if (sub === "pull") {
      const plan = pullPlan(ctx, arg);
      if ("exit" in plan) {
        const error = plan.exit === EXIT.usage ? "usage" : "preset_unavailable";
        if (ctx.json) ctx.io.out(JSON.stringify({ error, message: plan.message }));
        else ctx.io.err(`akou: ${plan.message}`);
        return plan.exit;
      }
      const shown = new Map<string, number>();
      try {
        const done = await downloadModels(dir, plan.ids, {
          env: ctx.io.env as NodeJS.ProcessEnv,
          registry: plan.registry,
          // One line per file every 10 %, on stderr, so a 2.4 GB file never looks stuck.
          onProgress: (x) => {
            if (ctx.json) return;
            const key = `${x.model}/${x.name}`;
            const pct = x.total > 0 ? Math.floor((10 * x.bytes) / x.total) * 10 : 100;
            if ((shown.get(key) ?? -1) >= pct) return;
            shown.set(key, pct);
            ctx.io.err(
              pct === 100
                ? `${key}: done, checking its SHA-256`
                : `${key}: ${pct} % of ${(x.total / 1e6).toFixed(0)} MB`,
            );
          },
        });
        // Retired folders go only once everything this machine needs is verified, not a subset.
        const retired = arg === undefined ? pruneRetiredModels(dir) : [];
        if (ctx.json) {
          ctx.io.out(
            JSON.stringify({
              ok: true,
              dir,
              files: done.length,
              retired,
              ...(plan.preset ? { preset: plan.preset } : {}),
              models: plan.ids,
            }),
          );
        } else {
          const what = plan.named ? ` for ${plan.named}` : "";
          ctx.io.out(`All ${done.length} model files${what} are in ${dir} and verified`);
          for (const id of retired) ctx.io.out(`Removed ${id}, which this version no longer uses`);
        }
        return EXIT.ok;
      } catch (err) {
        const msg = (err as Error).message;
        if (ctx.json) ctx.io.out(JSON.stringify({ error: "download_failed", message: msg }));
        else ctx.io.err(`akou: ${msg}`);
        return err instanceof DownloadRefused ? EXIT.unavailable : EXIT.software;
      }
    }
    if (sub === "import") {
      if (!arg) return usage(ctx, "models import needs a folder");
      const r = await importModels(ctx, arg);
      // A file already in place counts at its full size, so check every SHA-256 before pruning.
      const verified =
        r.missing.length === 0 &&
        (
          await verifyModels(
            dir,
            registry(ctx).map((m) => m.id),
            registry(ctx),
          )
        ).every((f) => f.state === "ok");
      const retired = verified ? pruneRetiredModels(dir) : [];
      if (ctx.json) ctx.io.out(JSON.stringify({ dir, ...r, retired }));
      else {
        ctx.io.out(`Imported ${r.copied.length} file(s) into ${dir}`);
        if (r.missing.length > 0) ctx.io.err(`Still missing: ${r.missing.join(", ")}`);
        for (const id of retired) ctx.io.out(`Removed ${id}, which this version no longer uses`);
      }
      return r.missing.length > 0 ? EXIT.unavailable : EXIT.ok;
    }
    return usage(ctx, "models needs list, pull or import");
  },
};

const share: Command = {
  name: "share",
  summary: "A read-only live link to the call",
  usage:
    "akou share on|off|status [-c CALL] [--bind tailnet|lan|IP] [--notes] [--expires 3h] [--json]",
  flags: {
    call: callFlag("live; `off` without it stops every share"),
    bind: { type: "string", value: "WHERE", desc: "tailnet, lan or an address (default: tailnet)" },
    notes: { type: "boolean", desc: "share the notepad too" },
    expires: { type: "string", value: "3h", desc: "turn the link off after this long" },
  },
  examples: ["akou share on --bind tailnet --expires 3h", "akou share status", "akou share off"],
  run: async (ctx, p) => {
    const sub = p.positional[0];
    if (sub === "status") {
      const r = await api(ctx, "GET", "/share");
      return finish(ctx, r, (b) => (b.active ? JSON.stringify(b, null, 2) : "Sharing is off"));
    }
    if (sub === "on") {
      const r = await api(ctx, "POST", "/share", {
        body: {
          call: str(p, "call"),
          bind: str(p, "bind"),
          notes: p.flags.notes === true ? true : undefined,
          expires: str(p, "expires"),
        },
      });
      return finish(ctx, r, (b) => JSON.stringify(b, null, 2));
    }
    if (sub === "off") {
      const call = str(p, "call");
      const r = await api(ctx, "DELETE", "/share", call ? { body: { call } } : {});
      return finish(ctx, r, () => "Sharing is off");
    }
    return usage(ctx, "share needs on, off or status");
  },
};

function unbuilt(
  name: string,
  summary: string,
  cmdUsage: string,
  why: string,
  flags?: Command["flags"],
): Command {
  return {
    name,
    summary,
    usage: cmdUsage,
    flags,
    examples: [cmdUsage],
    unbuilt: why,
    run: async (ctx) => notBuilt(ctx, why),
  };
}

export const setupCommands: Command[] = [
  config,
  token,
  models,
  share,
  unbuilt(
    "devices",
    "Microphones and outputs",
    "akou devices",
    "listing devices needs the capture helper's device query, which is not built yet",
  ),
  unbuilt(
    "apps",
    "Apps playing audio, for --call app:ID",
    "akou apps",
    "listing apps needs the capture helper's app query, which is not built yet",
  ),
  unbuilt(
    "self-update",
    "Update the Linux CLI tarball",
    "akou self-update",
    "self-update exists only in the Linux CLI tarball (M4), which is not built yet",
  ),
];
