/**
 * `akou doctor` (docs/DESIGN.md sections 5.3, 6.1 and 6.3): one pass over what a working akou
 * needs, each line `ok`, `warn` or `fail` with what to do. It never launches the app and never
 * opens an audio device.
 *
 * - settings: every refused key in `config.json`;
 * - token: present, mode 0600 or on Windows an ACL for the user alone (created if missing, replaced
 *   if loose);
 * - api: the app answers, and refuses a request that looks like a browser (403) and one without the
 *   token (401), which is the security self-test;
 * - models: every file present, the right size, and its pinned SHA-256;
 * - helper: the capture helper program can be found;
 * - harness: `claude` or `codex` found, first on PATH, then through the login shell the way the
 *   app looks for them;
 * - permissions: what the operating system must grant, as a hint (`--grant` is not built yet).
 *
 * Exit 0 when nothing failed, 69 otherwise. Not here yet: the 3 s capture test the design lists,
 * which needs the real helper.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ensureToken, tokenFileAccess } from "../../api/guard.ts";
import { MODELS, verifyModels } from "../../asr/models.ts";
import { bundledHelper } from "../../capture/helper.ts";
import { loadConfig } from "../../config/schema.ts";
import { findProgram } from "../../llm/harness.ts";
import { bool } from "../args.ts";
import { EXIT } from "../client.ts";
import type { Command, Ctx } from "../context.ts";

export interface Check {
  name: string;
  /** `info` is a hint that cannot be checked from here (the OS grants). */
  state: "ok" | "info" | "warn" | "fail";
  detail: string;
}

export { findProgram };

async function apiChecks(ctx: Ctx): Promise<Check[]> {
  const rt = await ctx.client.running();
  if (!rt) {
    return [
      {
        name: "api",
        state: "warn",
        detail: "akou is not running; `akou start` launches it headless",
      },
    ];
  }
  const out: Check[] = [
    { name: "api", state: "ok", detail: `akou ${rt.version} answers on 127.0.0.1:${rt.port}` },
  ];
  const url = `http://127.0.0.1:${rt.port}/v1/status`;
  const token = ensureToken(ctx.client.configDir).token;
  const asBrowser = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, origin: "http://example.com" },
  });
  const noToken = await fetch(url);
  const ok = asBrowser.status === 403 && noToken.status === 401;
  out.push({
    name: "api security",
    state: ok ? "ok" : "fail",
    detail: ok
      ? "a browser request is refused (403) and a request without the token too (401)"
      : `a browser request answered ${asBrowser.status} and one without the token ${noToken.status}; expected 403 and 401`,
  });
  return out;
}

function permissionHint(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS asks for the microphone and for system audio the first time akou records; both grants belong to the akou app (System Settings, Privacy & Security)";
    case "win32":
      return "Windows needs microphone access for desktop apps (Settings, Privacy, Microphone)";
    default:
      return "Linux needs PipeWire or PulseAudio running for the call audio";
  }
}

export async function doctor(ctx: Ctx, grant: boolean): Promise<Check[]> {
  const env = ctx.io.env;
  const cfg = loadConfig(env);
  const checks: Check[] = [];

  checks.push(
    cfg.issues.length === 0
      ? { name: "settings", state: "ok", detail: cfg.paths.configFile }
      : {
          name: "settings",
          state: "warn",
          detail: cfg.issues.map((i) => i.message).join("; "),
        },
  );

  const t = ensureToken(ctx.client.configDir);
  const access = tokenFileAccess(t.path);
  const who =
    process.platform !== "win32"
      ? `mode ${(statSync(t.path).mode & 0o777).toString(8).padStart(4, "0")}`
      : { private: "acl user-only", loose: "acl readable by others", unknown: "acl not readable" }[
          access
        ];
  checks.push({
    name: "token",
    state: { private: "ok", loose: "fail", unknown: "warn" }[access] as Check["state"],
    detail: `${t.path}, ${who}${t.created ? ", created now" : ""}`,
  });

  checks.push(...(await apiChecks(ctx)));

  const registry = ctx.models ?? MODELS;
  const dir = cfg.settings["asr.modelsDir"];
  const states = await verifyModels(
    dir,
    registry.map((m) => m.id),
    registry,
  );
  const bad = states.filter((s) => s.state !== "ok");
  checks.push(
    bad.length === 0
      ? {
          name: "models",
          state: "ok",
          detail: `${states.length} files present and verified in ${dir}`,
        }
      : {
          name: "models",
          state: "fail",
          detail: `${bad.map((s) => `${s.model}/${s.name} ${s.state === "missing" ? "missing" : s.state === "size" ? "has the wrong size" : "fails its checksum"}`).join("; ")}; run \`akou models pull\``,
        },
  );

  const helper = cfg.settings["capture.helper"];
  const program = helper[0] ?? bundledHelper() ?? "akou-capture";
  const found = isAbsolute(program)
    ? existsSync(program)
      ? program
      : null
    : findProgram(program, env);
  checks.push(
    found
      ? { name: "helper", state: "ok", detail: [found, ...helper.slice(1)].join(" ") }
      : {
          name: "helper",
          state: "fail",
          detail: `the capture helper ${program} was not found${helper.length === 0 ? " (it ships inside the app)" : " (capture.helper in config.json)"}`,
        },
  );

  const harnesses = ["claude", "codex"]
    .map((h) => ({ h, path: findProgram(h, env) }))
    .filter((x) => x.path !== null);
  checks.push(
    harnesses.length > 0
      ? {
          name: "harness",
          state: "ok",
          detail: harnesses.map((x) => `${x.h} at ${x.path}`).join(", "),
        }
      : {
          name: "harness",
          state: "warn",
          detail:
            "neither claude nor codex was found on PATH or through the login shell; agents can still drive akou over MCP",
        },
  );

  checks.push({ name: "permissions", state: "info", detail: permissionHint() });
  if (grant) {
    checks.push({
      name: "grant",
      state: "warn",
      detail: "--grant (prompting for the grants now) is not built yet",
    });
  }
  return checks;
}

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Check models, the helper, the token, the API, permissions and harness discovery",
  usage: "akou doctor [--grant] [--json]",
  flags: { grant: { type: "boolean" } },
  run: async (ctx, p) => {
    const checks = await doctor(ctx, bool(p, "grant"));
    const failed = checks.some((c) => c.state === "fail");
    if (ctx.json) ctx.io.out(JSON.stringify({ ok: !failed, checks }));
    else for (const c of checks) ctx.io.out(`${c.state.padEnd(4)}  ${c.name}: ${c.detail}`);
    return failed ? EXIT.unavailable : EXIT.ok;
  },
};
