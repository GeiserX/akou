/**
 * Setup commands (docs/DESIGN.md section 6.1): `config`, `token`, `models`, `share`, and the ones
 * whose machinery is not built yet (`devices`, `apps`, `self-update`), which say
 * so and exit 69 rather than pretend.
 *
 * `token` and `models` work without the app: they touch only akou's own config and models folders.
 * `token path` prints where the token is, never the token.
 */

import { existsSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { rotateToken } from "../../api/guard.ts";
import { type AcceleratorSetting, detectAccelerator, hostProbe } from "../../asr/accelerator.ts";
import { type LiveSetupContext, liveView } from "../../asr/live-setups.ts";
import { llamaRuntime } from "../../asr/llama-server.ts";
import { score as scoreOf, scoresOf } from "../../asr/model-scores.ts";
import { chosenModelsHere } from "../../asr/model-set.ts";
import {
  type CatalogEntry,
  DownloadRefused,
  downloadModels,
  hostPlatform,
  importModels as importModelFiles,
  MODELS,
  type ModelSpecEntry,
  modelFile,
  modelsFor,
  pruneRetiredModels,
  verifyModels,
} from "../../asr/models.ts";
import { isPreset, PRESET_NAMES, presetModels } from "../../asr/presets.ts";
import { isSettingKey, loadConfig, SETTINGS, type SettingSpec } from "../../config/schema.ts";
import { autoChoice, touchUsage } from "../../server/model-store.ts";
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

/**
 * The models this machine needs: the helpers for its `asr.diarizer` and the speech models its
 * chosen setups use (model-set.ts), so Parakeet only when one uses it (or the registry a test gives).
 */
function registry(ctx: Ctx): readonly ModelSpecEntry[] {
  if (ctx.models) return ctx.models;
  const settings = loadConfig(ctx.io.env).settings;
  return modelsFor(
    settings,
    hostPlatform(),
    MODELS,
    chosenModelsHere(settings, MODELS, hostPlatform(), ctx.io.env),
  );
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
 * `models import DIR` (models.ts `importModels`), into this machine's models folder. A long copy
 * says how far it is on stderr, one line per tenth of each file; `--json` prints nothing until done.
 */
function importModels(ctx: Ctx, from: string): Promise<{ copied: string[]; missing: string[] }> {
  const said = new Map<string, number>();
  return importModelFiles(from, modelsDir(ctx), registry(ctx), {
    onProgress: (p) => {
      if (ctx.json || p.total === 0) return;
      const key = `${p.model}/${p.name}`;
      const tenth = Math.floor((10 * p.bytes) / p.total);
      if (tenth === 0 || tenth <= (said.get(key) ?? 0)) return;
      said.set(key, tenth);
      ctx.io.err(`Copying ${key}: ${tenth * 10}%`);
    },
  });
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
    const reg = registry(ctx);
    // The build `akou serve` runs here (akou-5an.94): none in an image, else the GPU detection finds.
    const settings = loadConfig(ctx.io.env).settings;
    const detected = detectAccelerator(
      settings["asr.accelerator"] as AcceleratorSetting,
      hostProbe(ctx.io.env),
    );
    const runtime = llamaRuntime(settings, hostPlatform(), all as readonly CatalogEntry[], {
      image: ctx.io.env.AKOU_LLAMA_SERVER,
      detected,
    });
    // `auto` pulls what a job that names no model would run here (SV-R2, `autoChoice`).
    const dir = settings["asr.modelsDir"];
    const preset =
      name === "auto"
        ? autoChoice({
            present: (id) => all.some((m) => m.id === id && quickState(dir, m) === "present"),
            catalog: all.map((m) => m.id),
            runtime,
            machine: { gpu: detected.gpu !== null, memoryGb: totalmem() / 1024 ** 3 },
          }).preset
        : name;
    const p = presetModels(
      preset,
      reg.map((m) => m.id),
      runtime,
    );
    if ("unavailable" in p) {
      return {
        exit: EXIT.unavailable,
        message: `the ${name} preset has no engine in this version: ${p.unavailable}; \`akou models pull fast\` gets the one that exists`,
      };
    }
    // `best` names on-demand entries (Qwen, a llama-server build) that the machine's list leaves out.
    return {
      ids: [...p.models],
      registry: preset === "best" ? all : reg,
      preset: name,
      named: name,
    };
  }
  if (all.some((m) => m.id === name)) return { ids: [name], registry: all, named: name };
  return {
    exit: EXIT.usage,
    message: `no preset or model is called "${name}": the presets are ${PRESET_NAMES.join(", ")}, and \`akou models list\` names the models`,
  };
}

/**
 * The live models (`asr.live`) and the second pass (`asr.review.*`) as this machine would run
 * them: each model's bars, the models it needs and their state, and what the next call runs. No
 * app is asked, so no call is running.
 */
function liveRows(ctx: Ctx, dir: string) {
  const settings = loadConfig(ctx.io.env).settings;
  const all = ctx.models ?? MODELS;
  const detected = detectAccelerator(
    settings["asr.accelerator"] as AcceleratorSetting,
    hostProbe(ctx.io.env),
  );
  const state = (id: string) => {
    const m = all.find((x) => x.id === id);
    return m && quickState(dir, m) === "present" ? "ready" : "missing";
  };
  const c: LiveSetupContext = {
    setting: settings["asr.live"],
    engine: settings["asr.live.engine"],
    languages: settings["asr.languages"],
    review: settings["asr.review.model"],
    everySeconds: settings["asr.review.everySeconds"],
    present: (id) => state(id) === "ready",
    runtime: llamaRuntime(settings, hostPlatform(), all as readonly CatalogEntry[], {
      image: ctx.io.env.AKOU_LLAMA_SERVER,
      detected,
    }),
  };
  return liveView(c, null, state);
}

/** A model's 0 to 100 score for one side, or null when nobody measured it (model-scores.ts). */
function scoreFor(m: ModelSpecEntry, side: "accuracy" | "speed"): number | null {
  const s = scoresOf(m)?.[side];
  return s && !("notMeasured" in s) ? scoreOf(s) : null;
}

const models: Command = {
  name: "models",
  summary: "The speech models: list, pull (download, checksummed), delete, or import from a folder",
  usage:
    "akou models list | akou models pull [PRESET|MODEL] | akou models delete MODEL | akou models import DIR   [--json]\n" +
    "  PRESET is lite, fast, best, fusion or auto; MODEL is an id from `akou models list`.\n" +
    "  list, pull and import need no app running: an image build or an entrypoint pulls before the\n" +
    "  server starts. delete asks the running akou, which refuses the default model and one in use.",
  examples: [
    "akou models list",
    "akou models pull fast",
    "akou models pull",
    "akou models delete qwen3-asr-1.7b",
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
        accuracy: scoreFor(m, "accuracy"),
        speed: scoreFor(m, "speed"),
      }));
      const live = liveRows(ctx, dir);
      if (ctx.json) ctx.io.out(JSON.stringify({ dir, models: rows, live }));
      else {
        ctx.io.out(`# ${dir}`);
        const shown = (n: number | null) => (n === null ? "-" : String(n));
        for (const r of rows) {
          ctx.io.out(
            `${r.id}  ${r.state}  ${(r.bytes / 1e6).toFixed(0)} MB  accuracy ${shown(r.accuracy)}  speed ${shown(r.speed)}  ${r.licence}  (${r.job})`,
          );
        }
        const next = live.setups.find((l) => l.id === live.next);
        const review = live.review.next;
        ctx.io.out(
          `# live models (asr.live ${live.setting}; the next call runs ${next?.title ?? live.next}${review ? `, with ${live.review.choices.find((r) => r.id === review.model)?.title ?? review.model}'s second pass every ${review.everySeconds} s` : ""}${live.note ? `: ${live.note}` : ""})`,
        );
        for (const l of live.setups) {
          const bars = (["accuracy", "latency", "cores", "memory"] as const)
            .map((side) => `${side} ${shown(l[side].score)}`)
            .join("  ");
          const missing = l.models.filter((m) => m.state !== "ready").map((m) => m.id);
          const where = l.unavailable
            ? `unavailable: ${l.unavailable}`
            : missing.length > 0
              ? `needs ${missing.join(", ")}`
              : "ready";
          ctx.io.out(`${l.id}${l.selected ? " *" : ""}  ${l.title}  ${bars}  ${where}`);
        }
        ctx.io.out(
          `# second pass (asr.review.model ${live.review.setting}, every ${live.review.everySeconds} s)`,
        );
        for (const r of live.review.choices) {
          const missing = r.models.filter((m) => m.state !== "ready").map((m) => m.id);
          const where =
            missing.length > 0
              ? `needs ${missing.join(", ")}`
              : r.blocked
                ? `off: ${r.blocked}`
                : "ready";
          ctx.io.out(
            `${r.id}${live.review.next?.model === r.id ? " *" : ""}  ${r.title}  ${where}`,
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
        // A pulled model counts as used, so a server's sweep does not delete it at once (SV-M4).
        touchUsage(dir, plan.ids);
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
    if (sub === "delete") {
      if (!arg) return usage(ctx, "models delete needs a model id from `akou models list`");
      const r = await api(ctx, "DELETE", `/models/${encodeURIComponent(arg)}`);
      return finish(ctx, r, (b) => {
        const n = Number(b.bytes);
        const size = n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.ceil(n / 1e3)} KB`;
        return `Deleted ${b.id}: ${size} freed`;
      });
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
    return usage(ctx, "models needs list, pull, delete or import");
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

/** One device line: `* id  Name`, the default marked. */
function deviceLine(d: Body): string {
  return `${d.default ? "*" : " "} ${d.id}  ${d.name}`;
}

/** One app line: `id  Name  pid N`; macOS names an app by its bundle id, printed once. */
function appLine(a: Body): string {
  const name = String(a.name).toLowerCase() === String(a.id).toLowerCase() ? "" : `  ${a.name}`;
  return `  ${a.id}${name}  pid ${a.pid}`;
}

const devices: Command = {
  name: "devices",
  summary: "Microphones and outputs, with the ids --mic takes",
  usage: "akou devices [--json]",
  flags: {},
  examples: ["akou devices", "akou devices --json"],
  run: async (ctx, p) => {
    if (p.positional.length > 0) return usage(ctx, "devices takes no words");
    const r = await api(ctx, "GET", "/devices");
    return finish(ctx, r, (b) =>
      [
        "Microphones (* is the default; start --mic ID):",
        ...((b.inputs as Body[]).length ? (b.inputs as Body[]).map(deviceLine) : ["  none"]),
        "Outputs:",
        ...((b.outputs as Body[]).length ? (b.outputs as Body[]).map(deviceLine) : ["  none"]),
      ].join("\n"),
    );
  },
};

const apps: Command = {
  name: "apps",
  summary: "Apps with audio, with the ids --call app:ID takes",
  usage: "akou apps [--json]",
  flags: {},
  examples: ["akou apps", "akou apps --json"],
  run: async (ctx, p) => {
    if (p.positional.length > 0) return usage(ctx, "apps takes no words");
    const r = await api(ctx, "GET", "/apps");
    return finish(ctx, r, (b) =>
      (b.apps as Body[]).length === 0
        ? "No app has audio open."
        : ["Apps with audio (start --call app:ID):", ...(b.apps as Body[]).map(appLine)].join("\n"),
    );
  },
};

export const setupCommands: Command[] = [
  config,
  token,
  models,
  share,
  devices,
  apps,
  unbuilt(
    "self-update",
    "Update the Linux CLI tarball",
    "akou self-update",
    "self-update exists only in the Linux CLI tarball (M4), which is not built yet",
  ),
];
