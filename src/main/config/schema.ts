/**
 * The one settings registry (docs/DESIGN.md sections 6.1, 6.2 and 10): every setting akou reads,
 * with its type, its range, its default and, for the few that have one, the environment variable
 * that overrides it. The config file, `akou config set`, `PATCH /v1/config` and the environment all
 * go through `validateSetting`, so a hand-edited file cannot slip a value past a range the CLI would
 * refuse (TRAPS T4.9).
 *
 * The file is `config.json` in the config folder: one JSON object with the dotted keys below.
 *
 *   {"asr.segmentPause": 0.8, "api.port": 8476}
 *
 * A key that is unknown, of the wrong type or out of range is refused with a message and its
 * default is used; the rest of the file still applies. A file that is not JSON is refused whole.
 * There is deliberately no `vocab.boost`: the global boost is the constant 3 (TRAPS "The boost is a
 * slider"), and a file that tries to set one is told so.
 *
 * Environment: only `AKOU_HEADLESS`, `AKOU_MODELS_DIR` and `AKOU_HOME` exist. `AKOU_HOME` is not a
 * setting: it moves the home folder itself (config and recordings), for tests.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultModelsDir } from "../asr/models.ts";
import { defaultConfigDir } from "../vocab/files.ts";

export type SettingType = "integer" | "number" | "boolean" | "string" | "string[]" | "hooks";

/** The stages a hand-off hook or the webhook runs at: the event type names (DESIGN 8.2). */
export const HOOK_STAGES = ["call.ended", "final.done", "enhanced"] as const;
export type HookStage = (typeof HOOK_STAGES)[number];

/**
 * One post-call hook: a command run with the call as JSON on stdin. A string runs through the
 * shell (`/bin/sh -c`, `cmd /c` on Windows); a list is the program and its arguments, no shell.
 */
export interface HookConfig {
  stage: HookStage;
  command: string | readonly string[];
  /** Killed after this long. Default 600. */
  timeoutSec?: number;
  /** Only calls in this workspace. Absent: every workspace. */
  workspace?: string;
  /** The name `hook.done` and the log carry. Default: the command. */
  name?: string;
}

export const HOOK_TIMEOUT_DEFAULT = 600;

export interface SettingSpec {
  type: SettingType;
  /** Inclusive range for numbers, or length range for strings and lists. */
  min?: number;
  max?: number;
  /** A number setting may also take these values outside the range (`api.port` 0). */
  also?: readonly number[];
  /** One of these values, for strings. */
  values?: readonly string[];
  default: SettingValue;
  /** The environment variable that overrides the file. */
  env?: string;
  /**
   * False for settings that name a program akou runs: they are read from the file only, never
   * written over the local API, so the API token cannot become a way to run a chosen command.
   */
  apiWritable?: boolean;
  /** A secret (an API key): never shown by `GET /config`, `config show` or `status`. */
  secret?: boolean;
  doc: string;
}

export type SettingValue = number | boolean | string | readonly string[] | readonly HookConfig[];

const home = homedir();

/**
 * Defaults that depend on the machine are computed from the home folder; `resolveDefaults` redoes
 * them for `AKOU_HOME`.
 */
export const SETTINGS = {
  "recordings.root": {
    type: "string",
    min: 1,
    default: join(home, "Recordings", "akou"),
    doc: "Folder that holds a subfolder per workspace, each holding one folder per call.",
  },
  "user.name": {
    type: "string",
    max: 100,
    default: "",
    doc: "Your name, written into every call and used for the mic channel's label.",
  },
  "api.port": {
    type: "integer",
    min: 1024,
    max: 65535,
    also: [0],
    default: 8476,
    doc: "Port of the local API on 127.0.0.1. 0 picks a free port; runtime.json has the one in use.",
  },
  "app.headless": {
    type: "boolean",
    default: false,
    env: "AKOU_HEADLESS",
    doc: "Run with no window. Selected by the environment, never by command-line arguments.",
  },
  "capture.helper": {
    type: "string[]",
    default: [],
    apiWritable: false,
    doc: "Command that starts the capture helper, before its own arguments. Empty: the akou-capture bundled with the app, else the one on PATH.",
  },
  "capture.mic": {
    type: "string",
    min: 1,
    default: "default",
    doc: "Microphone: `default`, `none`, or a device id from `akou devices`.",
  },
  "capture.call": {
    type: "string",
    min: 1,
    default: "system",
    doc: "Call audio: `system`, `none`, or `app:<id>[,<id>]`.",
  },
  "capture.warmStartSeconds": {
    type: "number",
    min: 1,
    max: 30,
    default: 3,
    doc: "Wait for the helper to report capturing, after a helper has captured once this run.",
  },
  "capture.coldStartSeconds": {
    type: "number",
    min: 1,
    max: 60,
    default: 10,
    doc: "Wait for the helper to report capturing on the first start of a run.",
  },
  "capture.stopSeconds": {
    type: "number",
    min: 1,
    max: 30,
    default: 5,
    doc: "How long a helper may take to stop before it is killed.",
  },
  "capture.stallSeconds": {
    type: "number",
    min: 2,
    max: 120,
    default: 10,
    doc: "No packet at all for this long means the helper is wedged and is restarted.",
  },
  "capture.deadRestartSeconds": {
    type: "number",
    min: 10,
    max: 600,
    default: 60,
    doc: "A dead call side that lasts this long restarts the helper.",
  },
  "capture.queueSeconds": {
    type: "number",
    min: 10,
    max: 3600,
    default: 600,
    doc: "Audio kept per channel for the recognizer when it falls behind.",
  },
  "asr.modelsDir": {
    type: "string",
    min: 1,
    // The platform's data folder, never AKOU_MODELS_DIR, which applies as an override (`env`).
    default: defaultModelsDir({
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    }),
    env: "AKOU_MODELS_DIR",
    doc: "Folder the speech models are downloaded into and loaded from.",
  },
  "asr.threads": {
    type: "integer",
    min: 1,
    max: 32,
    default: 2,
    doc: "Threads per recognizer.",
  },
  "asr.segmentPause": {
    type: "number",
    min: 0.2,
    max: 5,
    default: 0.7,
    doc: "Silence that closes a live segment, seconds. Must be below `asr.segmentWindow`.",
  },
  "asr.segmentWindow": {
    type: "number",
    min: 2,
    max: 30,
    default: 12,
    doc: "Longest live segment, seconds.",
  },
  "provider.kind": {
    type: "string",
    values: ["harness", "openai-compatible", "anthropic", "none"],
    default: "harness",
    doc: "What answers questions and writes enhanced notes: your own Claude Code or Codex (`harness`), an OpenAI-compatible server, the Anthropic API with your key, or `none` (excerpts only).",
  },
  "provider.harness": {
    type: "string",
    values: ["auto", "claude", "codex"],
    default: "auto",
    doc: "Which harness `harness` runs. `auto`: Claude Code if found, else Codex.",
  },
  "provider.harnessPath": {
    type: "string",
    default: "",
    apiWritable: false,
    doc: "Pin the harness program by absolute path. Empty: look it up on PATH and through the login shell.",
  },
  "provider.baseUrl": {
    type: "string",
    default: "",
    apiWritable: false,
    doc: "Server address for `openai-compatible` (Ollama: `http://127.0.0.1:11434/v1`), or another Anthropic API address. File only: it decides where your key and transcripts are sent.",
  },
  "provider.model": {
    type: "string",
    max: 200,
    default: "",
    doc: "Model id for `openai-compatible` (required) and `anthropic` (empty: the default model).",
  },
  "provider.apiKey": {
    type: "string",
    max: 400,
    default: "",
    secret: true,
    doc: "API key for `openai-compatible` (optional) or `anthropic` (required). Never shown back or logged.",
  },
  "provider.timeoutSeconds": {
    type: "integer",
    min: 10,
    max: 600,
    default: 60,
    doc: "How long an answer may take before akou shows the excerpts instead and says why.",
  },
  "export.dir": {
    type: "string",
    default: "",
    doc: "Folder finished calls are exported into, one subfolder per workspace: Markdown with frontmatter, the event log and the audio. Empty: no export until you set it.",
  },
  "export.audio": {
    type: "string",
    values: ["link", "copy", "none"],
    default: "link",
    doc: "How the export carries the audio: a link to the call's file, a copy, or nothing.",
  },
  hooks: {
    type: "hooks",
    default: [],
    apiWritable: false,
    doc: 'Commands run after a call, each given the call as JSON on stdin: `[{"stage": "call.ended" | "final.done" | "enhanced", "command": "…", "timeoutSec": 600, "workspace": "work"}]`. File only: they are programs akou runs.',
  },
  "webhook.url": {
    type: "string",
    default: "",
    apiWritable: false,
    doc: "Address the call is POSTed to at every hand-off stage, signed with `webhook.secret`. Empty: off. File only: it decides where your transcripts are sent.",
  },
  "webhook.secret": {
    type: "string",
    max: 400,
    default: "",
    secret: true,
    doc: "Secret for the webhook's HMAC-SHA256 signature (`X-Akou-Signature`). The webhook stays off until it is set. Never shown back or logged.",
  },
  "vocab.extraFiles": {
    type: "string[]",
    default: [],
    doc: "Extra vocabulary files layered over the global and workspace files.",
  },
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;

type ValueOf<T extends SettingType> = T extends "integer" | "number"
  ? number
  : T extends "boolean"
    ? boolean
    : T extends "string"
      ? string
      : T extends "hooks"
        ? readonly HookConfig[]
        : readonly string[];

export type Settings = { -readonly [K in SettingKey]: ValueOf<(typeof SETTINGS)[K]["type"]> };

/** Keys refused with a reason of their own, beyond "unknown key". */
const FORBIDDEN: Readonly<Record<string, string>> = {
  "vocab.boost":
    "there is no global boost setting: it is the constant 3; a per-entry boost is set with `akou vocab check --boost`",
};

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export interface SettingIssue {
  key: string;
  source: "file" | "env" | "api";
  message: string;
}

/** Checks one value against its spec. Returns the value to store, or an error message. */
export function validateSetting(
  key: string,
  value: unknown,
): { ok: true; key: SettingKey; value: SettingValue } | { ok: false; error: string } {
  const forbidden = FORBIDDEN[key];
  if (forbidden) return { ok: false, error: `${key}: ${forbidden}` };
  if (!isSettingKey(key)) return { ok: false, error: `${key}: unknown setting` };
  const spec: SettingSpec = SETTINGS[key];
  const range = `${spec.min ?? "-inf"} to ${spec.max ?? "inf"}`;
  switch (spec.type) {
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `${key}: must be a number` };
      }
      if (spec.type === "integer" && !Number.isInteger(value)) {
        return { ok: false, error: `${key}: must be a whole number` };
      }
      if (spec.also?.includes(value)) return { ok: true, key, value };
      if (
        (spec.min !== undefined && value < spec.min) ||
        (spec.max !== undefined && value > spec.max)
      ) {
        return { ok: false, error: `${key}: ${value} is out of range (${range})` };
      }
      return { ok: true, key, value };
    }
    case "boolean":
      if (typeof value !== "boolean") return { ok: false, error: `${key}: must be true or false` };
      return { ok: true, key, value };
    case "string": {
      if (typeof value !== "string") return { ok: false, error: `${key}: must be a string` };
      if (spec.values && !spec.values.includes(value)) {
        return { ok: false, error: `${key}: must be one of ${spec.values.join(", ")}` };
      }
      if (
        (spec.min !== undefined && value.length < spec.min) ||
        (spec.max !== undefined && value.length > spec.max)
      ) {
        return { ok: false, error: `${key}: length must be ${range}` };
      }
      return { ok: true, key, value };
    }
    case "string[]":
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v !== "")) {
        return { ok: false, error: `${key}: must be a list of non-empty strings` };
      }
      return { ok: true, key, value: [...value] };
    case "hooks": {
      const h = validateHooks(value);
      return h.ok ? { ok: true, key, value: h.value } : { ok: false, error: `${key}: ${h.error}` };
    }
  }
}

const HOOK_FIELDS = new Set(["stage", "command", "timeoutSec", "workspace", "name"]);

/** Checks the `hooks` list: every entry a known stage and a command, nothing else. */
export function validateHooks(
  value: unknown,
): { ok: true; value: HookConfig[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "must be a list of hooks" };
  const out: HookConfig[] = [];
  for (const [i, h] of value.entries()) {
    const at = `hook ${i + 1}`;
    if (typeof h !== "object" || h === null || Array.isArray(h)) {
      return { ok: false, error: `${at} must be an object` };
    }
    const o = h as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !HOOK_FIELDS.has(k));
    if (unknown) return { ok: false, error: `${at}: unknown field "${unknown}"` };
    if (!HOOK_STAGES.includes(o.stage as HookStage)) {
      return { ok: false, error: `${at}: stage must be one of ${HOOK_STAGES.join(", ")}` };
    }
    const cmd = o.command;
    const okCmd =
      (typeof cmd === "string" && cmd.trim() !== "") ||
      (Array.isArray(cmd) &&
        cmd.length > 0 &&
        cmd.every((c) => typeof c === "string") &&
        cmd[0] !== "");
    if (!okCmd) {
      return { ok: false, error: `${at}: command must be a string or a list of strings` };
    }
    const t = o.timeoutSec;
    if (t !== undefined && (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 3600)) {
      return { ok: false, error: `${at}: timeoutSec must be a whole number from 1 to 3600` };
    }
    if (o.workspace !== undefined && typeof o.workspace !== "string") {
      return { ok: false, error: `${at}: workspace must be a string` };
    }
    if (o.name !== undefined && (typeof o.name !== "string" || o.name.trim() === "")) {
      return { ok: false, error: `${at}: name must be a non-empty string` };
    }
    out.push({
      stage: o.stage as HookStage,
      command: Array.isArray(cmd) ? [...(cmd as string[])] : (cmd as string),
      ...(t !== undefined ? { timeoutSec: t as number } : {}),
      ...(o.workspace !== undefined ? { workspace: o.workspace as string } : {}),
      ...(o.name !== undefined ? { name: o.name as string } : {}),
    });
  }
  return { ok: true, value: out };
}

/** Parses an environment value by the setting's type (`1`/`true` and `0`/`false` for booleans). */
function fromEnv(spec: SettingSpec, raw: string): unknown {
  switch (spec.type) {
    case "boolean":
      if (/^(1|true|yes)$/i.test(raw)) return true;
      if (/^(0|false|no|)$/i.test(raw)) return false;
      return raw;
    case "integer":
    case "number":
      return raw.trim() === "" ? raw : Number(raw);
    case "string[]":
      return raw.split(",").filter((s) => s !== "");
    case "string":
    case "hooks":
      return raw;
  }
}

/** Where akou keeps its own files. `AKOU_HOME` moves all of them, for tests. */
export interface Paths {
  home: string;
  configDir: string;
  configFile: string;
}

export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): Paths {
  const akouHome = env.AKOU_HOME;
  const h = akouHome ?? homedir();
  // With AKOU_HOME the config folder is inside it on every OS, never in %APPDATA%.
  const configDir = akouHome
    ? join(akouHome, ".config", "akou")
    : defaultConfigDir(env, platform, h);
  return { home: h, configDir, configFile: join(configDir, "config.json") };
}

/** Defaults, with the machine-dependent ones computed from `home`. */
export function resolveDefaults(paths: Paths): Settings {
  const out = {} as Record<string, SettingValue>;
  for (const k of SETTING_KEYS) {
    const d = SETTINGS[k].default as SettingValue;
    out[k] = Array.isArray(d) ? [...d] : d;
  }
  out["recordings.root"] = join(paths.home, "Recordings", "akou");
  if (paths.home !== homedir()) {
    out["asr.modelsDir"] = join(paths.home, ".local", "share", "akou", "models");
  }
  return out as Settings;
}

export interface LoadedConfig {
  settings: Settings;
  /** What the file set, after validation: what `PATCH /config` edits and writes back. */
  file: Partial<Record<SettingKey, SettingValue>>;
  issues: SettingIssue[];
  paths: Paths;
}

/** Cross-field rules, checked after every key has its value. Returns the keys to reset. */
function crossCheck(s: Settings): { key: SettingKey; message: string }[] {
  const out: { key: SettingKey; message: string }[] = [];
  if (s["asr.segmentPause"] >= s["asr.segmentWindow"]) {
    out.push({
      key: "asr.segmentPause",
      message: `asr.segmentPause (${s["asr.segmentPause"]}) must be below asr.segmentWindow (${s["asr.segmentWindow"]})`,
    });
  }
  return out;
}

/** Applies file values over defaults, then the environment, validating each. */
export function buildSettings(
  paths: Paths,
  fileValues: Record<string, unknown>,
  env: Record<string, string | undefined>,
  source: "file" | "api" = "file",
): LoadedConfig {
  const defaults = resolveDefaults(paths);
  const settings = { ...defaults } as Record<string, SettingValue>;
  const file: Partial<Record<SettingKey, SettingValue>> = {};
  const issues: SettingIssue[] = [];
  for (const [key, value] of Object.entries(fileValues)) {
    const v = validateSetting(key, value);
    if (!v.ok) {
      issues.push({ key, source, message: `${v.error}; using the default` });
      continue;
    }
    settings[v.key] = v.value;
    file[v.key] = v.value;
  }
  for (const key of SETTING_KEYS) {
    const spec: SettingSpec = SETTINGS[key];
    if (!spec.env) continue;
    const raw = env[spec.env];
    if (raw === undefined) continue;
    const v = validateSetting(key, fromEnv(spec, raw));
    if (!v.ok) {
      issues.push({ key, source: "env", message: `${spec.env}: ${v.error}; ignored` });
      continue;
    }
    settings[key] = v.value;
  }
  for (const bad of crossCheck(settings as Settings)) {
    issues.push({ key: bad.key, source, message: `${bad.message}; using the defaults` });
    settings["asr.segmentPause"] = defaults["asr.segmentPause"];
    settings["asr.segmentWindow"] = defaults["asr.segmentWindow"];
    delete file["asr.segmentPause"];
    delete file["asr.segmentWindow"];
  }
  return { settings: settings as Settings, file, issues, paths };
}

/** Reads `config.json` (if any), validates every key, and applies the environment. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): LoadedConfig {
  const paths = resolvePaths(env, platform);
  let values: Record<string, unknown> = {};
  const issues: SettingIssue[] = [];
  if (existsSync(paths.configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(paths.configFile, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        issues.push({
          key: "*",
          source: "file",
          message: "config.json must be a JSON object; using the defaults",
        });
      } else {
        values = parsed as Record<string, unknown>;
      }
    } catch (err) {
      issues.push({
        key: "*",
        source: "file",
        message: `config.json is not valid JSON (${(err as Error).message}); using the defaults`,
      });
    }
  }
  const loaded = buildSettings(paths, values, env);
  loaded.issues.unshift(...issues);
  return loaded;
}

/**
 * Validates a `PATCH /config` body: `{key: value}` to set, `{key: null}` to go back to the default.
 * Returns the new file contents, or every error at once. Settings that name a program are refused.
 */
export function patchConfig(
  current: Partial<Record<SettingKey, SettingValue>>,
  patch: Record<string, unknown>,
  paths: Paths,
): { ok: true; file: Partial<Record<SettingKey, SettingValue>> } | { ok: false; errors: string[] } {
  const next = { ...current };
  const errors: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (isSettingKey(key) && (SETTINGS[key] as SettingSpec).apiWritable === false) {
      errors.push(`${key}: set it in config.json; it is not writable over the API`);
      continue;
    }
    if (value === null) {
      if (!isSettingKey(key)) errors.push(`${key}: unknown setting`);
      else delete next[key];
      continue;
    }
    const v = validateSetting(key, value);
    if (!v.ok) errors.push(v.error);
    else next[v.key] = v.value;
  }
  if (errors.length === 0) {
    const check = buildSettings(paths, next, {}, "api");
    for (const i of check.issues) errors.push(i.message.replace(/; using the defaults?$/, ""));
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, file: next };
}

/** The settings with every secret replaced by `set` or empty: what may be shown or sent back. */
export function redactSettings<T extends Partial<Record<SettingKey, SettingValue>>>(values: T): T {
  const out = { ...values } as Record<string, SettingValue>;
  for (const k of SETTING_KEYS) {
    if ((SETTINGS[k] as SettingSpec).secret && typeof out[k] === "string" && out[k] !== "") {
      out[k] = "(set)";
    }
  }
  return out as T;
}

/** The reference table, generated from the registry. */
export function settingsReference(): string {
  const rows = SETTING_KEYS.map((k) => {
    const s: SettingSpec = SETTINGS[k];
    const range =
      s.type === "integer" || s.type === "number"
        ? `${s.min} to ${s.max}${s.also ? ` or ${s.also.join(", ")}` : ""}`
        : "";
    const d = Array.isArray(s.default)
      ? s.type === "hooks"
        ? "[]"
        : `[${(s.default as readonly string[]).join(", ")}]`
      : String(s.default);
    return `| \`${k}\` | ${s.type} | ${range} | ${k.includes("Dir") || k.includes("root") ? "per OS" : `\`${d}\``} | ${s.env ? `\`${s.env}\`` : ""} | ${s.doc} |`;
  });
  return [
    "| Key | Type | Range | Default | Environment | Meaning |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
