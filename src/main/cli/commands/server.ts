/**
 * Server-mode commands (docs/ux/SERVER.md SV-K2, SV-U1): `keys` and `admin`. Like `token`, they
 * work without the app: they edit akou's own config folder, and the running server reads the
 * files again when they change, so a key created here works at once and a revoked one gets 401
 * on its next request.
 *
 * `akou admin set-password` reads the password from standard input, never from an argument, so it
 * stays out of the shell history and the process list (CLI-06).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { SCOPES, type Scope } from "../../api/access.ts";
import { writePrivateFile } from "../../api/guard.ts";
import { KeyError, KeyStore } from "../../api/keys.ts";
import { resolvePaths, validateSetting } from "../../config/schema.ts";
import { repeated, str } from "../args.ts";
import { EXIT } from "../client.ts";
import { type Command, type Ctx, wall } from "../context.ts";
import { usage } from "./calls.ts";

function store(ctx: Ctx): KeyStore {
  return new KeyStore(resolvePaths(ctx.io.env).configDir);
}

function refused(ctx: Ctx, code: string, message: string, exit: number): number {
  if (ctx.json) ctx.io.out(JSON.stringify({ error: code, message }));
  else ctx.io.err(`akou: ${message}`);
  return exit;
}

const keys: Command = {
  name: "keys",
  summary: "Create, list or revoke the API keys of server mode (no app needed)",
  usage:
    "akou keys create --name NAME [--scope jobs|admin] [--callback-host HOST ...] | akou keys list | akou keys revoke ID   [--json]",
  flags: {
    name: { type: "string" },
    scope: { type: "string" },
    "callback-host": { type: "string", repeat: true },
  },
  run: async (ctx, p) => {
    const [sub, id, ...rest] = p.positional;
    if (sub === "create") {
      const name = str(p, "name");
      if (!name || id !== undefined) return usage(ctx, "keys create needs --name and nothing else");
      const scope = str(p, "scope") ?? "jobs";
      if (!(SCOPES as readonly string[]).includes(scope)) {
        return usage(ctx, `--scope is one of ${SCOPES.join(", ")}`);
      }
      try {
        const k = store(ctx).create({
          name,
          scope: scope as Scope,
          callbackHosts: repeated(p, "callback-host"),
        });
        if (ctx.json) ctx.io.out(JSON.stringify(k));
        else {
          const hosts = k.callback_hosts.length > 0 ? k.callback_hosts.join(", ") : "none";
          ctx.io.out(
            [
              `created ${k.id} "${k.name}" (${k.scopes.join(", ")}); callback hosts: ${hosts}`,
              "Both are shown this once and never again; store them now.",
              `API key:        ${k.key}`,
              `webhook secret: ${k.secret}`,
            ].join("\n"),
          );
        }
        return EXIT.ok;
      } catch (err) {
        if (err instanceof KeyError) return refused(ctx, "bad_key", err.message, EXIT.usage);
        throw err;
      }
    }
    if (sub === "list") {
      if (id !== undefined) return usage(ctx, "keys list takes no argument");
      const all = store(ctx).list();
      if (ctx.json) ctx.io.out(JSON.stringify({ keys: all }));
      else if (all.length === 0) ctx.io.out("no keys; `akou keys create --name NAME` makes one");
      else {
        for (const k of all) {
          const used = k.last_used_at === null ? "never used" : `last used ${wall(k.last_used_at)}`;
          ctx.io.out(
            `${k.id}  ${k.name}  ${k.scopes.join(",")}  created ${wall(k.created_at)}  ${used}`,
          );
        }
      }
      return EXIT.ok;
    }
    if (sub === "revoke") {
      if (!id || rest.length > 0) return usage(ctx, "keys revoke needs one key id");
      if (!store(ctx).revoke(id)) {
        return refused(ctx, "not_found", `no key ${id}; \`akou keys list\` shows them`, EXIT.usage);
      }
      if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, revoked: id }));
      else ctx.io.out(`revoked ${id}`);
      return EXIT.ok;
    }
    return usage(ctx, "keys needs create, list or revoke");
  },
};

/** The shortest admin password accepted. */
export const MIN_PASSWORD = 12;

const admin: Command = {
  name: "admin",
  summary: "Set the web UI's admin password in server mode, read from standard input",
  usage: "akou admin set-password < password-file   [--json]",
  run: async (ctx, p) => {
    const [sub, ...rest] = p.positional;
    if (sub !== "set-password" || rest.length > 0) {
      return usage(ctx, "admin needs set-password, with the password on standard input");
    }
    const input = (await ctx.io.stdin?.()) ?? "";
    const password = input.replace(/\r?\n$/, "");
    if (password.length < MIN_PASSWORD || password.includes("\n")) {
      return refused(
        ctx,
        "bad_password",
        `the password is one line of at least ${MIN_PASSWORD} characters on standard input`,
        EXIT.usage,
      );
    }
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const v = validateSetting("server.admin_password_hash", hash);
    if (!v.ok) return refused(ctx, "bad_password", v.error, EXIT.software);
    const paths = resolvePaths(ctx.io.env);
    let file: Record<string, unknown> = {};
    if (existsSync(paths.configFile)) {
      try {
        const parsed = JSON.parse(readFileSync(paths.configFile, "utf8")) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          file = parsed as Record<string, unknown>;
        } else throw new Error("not an object");
      } catch {
        return refused(
          ctx,
          "bad_config",
          `${paths.configFile} is not a JSON object; fix it first`,
          EXIT.software,
        );
      }
    }
    file["server.admin_password_hash"] = hash;
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
    writePrivateFile(paths.configFile, `${JSON.stringify(file, null, 2)}\n`, true);
    if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, file: paths.configFile }));
    else ctx.io.out(`admin password set in ${paths.configFile}; it works at the next login`);
    return EXIT.ok;
  },
};

export const serverCommands: readonly Command[] = [keys, admin];
