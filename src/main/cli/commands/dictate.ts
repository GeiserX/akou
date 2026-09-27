/**
 * Dictation on the CLI (docs/ux/DICTATION.md DC-G3).
 *
 * - `akou dictate FILE`: one clip through the dictation path of the running app,
 *   `POST /v1/dictations`, and its text printed. Nothing is typed anywhere. The compiled CLI carries
 *   no engine, so the app does the decoding.
 * - `akou dictate start|stop|toggle|cancel`: the live session, for a Wayland compositor's key
 *   binding or a script: a latched session, as if the dictation key were tapped. They never launch
 *   the app (exit 69 when it is not running), and exit 78 while `dictation.enabled` is off.
 * - `akou dictate --remote-test`: DC-R4's Test of `dictation.remote.url`.
 * - `akou dictations list|show|delete`: the dictation history; `akou dictations retry ID --engine E`
 *   decodes a spoken dictation's kept audio again and prints the new text, leaving the dictation
 *   as it was.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { bool, duration, int, str } from "../args.ts";
import { EXIT, Unreachable } from "../client.ts";
import { api, type Body, type Command, type Ctx, finish, wall } from "../context.ts";
import { usage } from "./calls.ts";

const ENGINES = ["auto", "fast", "best", "remote"];
const SESSION = ["start", "stop", "toggle", "cancel"];

/** A session command, which never launches the app: a key binding must not open akou by itself. */
async function session(ctx: Ctx, word: string): Promise<number> {
  try {
    let action = word;
    if (word === "toggle") {
      const st = await api(ctx, "GET", "/dictation", { launch: false });
      if (st.status !== 200) return finish(ctx, st, () => "");
      action = st.body?.state === "listening" ? "stop" : "start";
    }
    const r = await api(ctx, "POST", `/dictation/${action}`, { launch: false });
    if (r.body?.error === "dictation_off") {
      const message =
        "dictation is off: turn on dictation.enabled (akou config set dictation.enabled true)";
      if (ctx.json) ctx.io.out(JSON.stringify({ error: "dictation_off", message }));
      else ctx.io.err(`akou: ${message}`);
      return EXIT.config;
    }
    return finish(ctx, r, (b: Body) => `dictation ${b.state}`);
  } catch (err) {
    if (!(err instanceof Unreachable)) throw err;
    const message = "akou is not running (`akou open` starts it)";
    if (ctx.json) ctx.io.out(JSON.stringify({ error: "not_running", message }));
    else ctx.io.err(`akou: ${message}`);
    return EXIT.unavailable;
  }
}

async function remoteTest(ctx: Ctx): Promise<number> {
  const r = await api(ctx, "GET", "/dictation/remote-test");
  const code = finish(ctx, r, (b: Body) => b.summary as string);
  // A remote that refuses or is down answers 200 with `ok: false`: the test ran, the remote failed.
  return code === EXIT.ok && r.body?.ok === false ? EXIT.unavailable : code;
}

export const dictateCommand: Command = {
  name: "dictate",
  summary: "Transcribe a clip through the dictation path, or start and stop a dictation",
  usage: `akou dictate FILE [--engine ${ENGINES.join("|")}] [--language L]   [--json]
       akou dictate start|stop|toggle|cancel   [--json]
       akou dictate --remote-test   [--json]`,
  flags: {
    engine: { type: "string", value: "E", desc: `${ENGINES.join(", ")} (default auto)` },
    language: {
      type: "string",
      value: "L",
      desc: "a BCP-47 tag such as en or es-ES, or auto; the fast engine detects it itself",
    },
    "remote-test": {
      type: "boolean",
      desc: "test dictation.remote.url with its key: mode, engine, accelerator, round trip",
    },
  },
  examples: [
    "akou dictate note.wav",
    "akou dictate note.wav --json",
    "akou dictate toggle",
    "akou dictate --remote-test",
  ],
  run: async (ctx, p) => {
    const [first, ...rest] = p.positional;
    if (bool(p, "remote-test")) {
      if (first !== undefined) return usage(ctx, "--remote-test takes no FILE");
      return remoteTest(ctx);
    }
    if (first !== undefined && SESSION.includes(first)) {
      if (rest.length > 0) return usage(ctx, `dictate ${first} takes nothing more`);
      return session(ctx, first);
    }
    const file = first;
    if (!file || rest.length > 0)
      return usage(ctx, "dictate needs one FILE, or start, stop, toggle or cancel");
    const engine = str(p, "engine");
    if (engine !== undefined && !ENGINES.includes(engine)) {
      return usage(ctx, `--engine is one of ${ENGINES.join(", ")}`);
    }
    let bytes: Uint8Array;
    try {
      if (!statSync(file).isFile()) return usage(ctx, `${file} is not a file`);
      bytes = readFileSync(file);
    } catch (err) {
      return usage(ctx, `cannot read ${file}: ${(err as Error).message}`);
    }
    const form = new FormData();
    form.append("file", new Blob([bytes]), basename(file));
    if (engine) form.append("engine", engine);
    const language = str(p, "language");
    if (language) form.append("language", language);
    const r = await api(ctx, "POST", "/dictations", { form, timeoutMs: 600_000 });
    // No speech prints nothing on stdout, so a pipe never saves a placeholder as the text.
    if (!ctx.json && r.status === 200 && !r.body?.text) {
      ctx.io.err("akou: no speech in the clip");
      return EXIT.ok;
    }
    return finish(ctx, r, (b: Body) => b.text as string);
  },
};

/** One dictation as a line: when, state, engine, where it went, and its text. */
function row(d: Body): string {
  const at = `${new Date(d.at).toLocaleDateString("en-CA")} ${wall(d.at)}`;
  const text = d.text ?? (d.error ? `(${d.error})` : "");
  return [d.id, at, d.state, d.engine, d.app ?? "-", text].join("  ");
}

export const dictationsCommand: Command = {
  name: "dictations",
  summary: "The dictation history: list, show, retry or delete dictations",
  usage: `akou dictations list [--since 24h] [-q TEXT] [--limit N]   [--json]
       akou dictations show ID   [--json]
       akou dictations retry ID --engine ${ENGINES.join("|")}   [--json]
       akou dictations delete ID | --all   [--json]`,
  flags: {
    since: { type: "string", value: "24h", desc: "only dictations from the last 90s, 5m or 1h" },
    search: {
      type: "string",
      short: "q",
      value: "TEXT",
      desc: "only dictations whose text holds TEXT (any case)",
    },
    limit: { type: "string", value: "N", desc: "at most N dictations (default 100)" },
    all: { type: "boolean", desc: "with delete: every dictation" },
    engine: { type: "string", value: "E", desc: `with retry: ${ENGINES.join(", ")}` },
  },
  examples: [
    "akou dictations list",
    "akou dictations list --since 24h --json",
    "akou dictations show d1",
    "akou dictations retry d1 --engine best",
    "akou dictations delete d1",
  ],
  run: async (ctx, p) => {
    const [sub, ...rest] = p.positional;
    if (sub === "list") {
      if (rest.length > 0) return usage(ctx, "dictations list takes no argument");
      const since = duration(p, "since");
      const r = await api(ctx, "GET", "/dictations", {
        query: {
          q: str(p, "search"),
          limit: int(p, "limit", 1, 500),
          since: since === undefined ? undefined : Math.floor(Date.now() - since * 1000),
        },
      });
      return finish(ctx, r, (b: Body) => {
        const items = (b?.items ?? []) as Body[];
        return items.length === 0 ? "No dictations" : items.map(row).join("\n");
      });
    }
    if (sub === "show") {
      const [id, ...more] = rest;
      if (!id || more.length > 0) return usage(ctx, "dictations show needs one ID");
      const r = await api(ctx, "GET", `/dictations/${encodeURIComponent(id)}`);
      return finish(ctx, r, row);
    }
    if (sub === "delete") {
      const all = bool(p, "all");
      const [id, ...more] = rest;
      if (all ? rest.length > 0 : !id || more.length > 0) {
        return usage(ctx, "dictations delete needs one ID, or --all");
      }
      const r = all
        ? await api(ctx, "DELETE", "/dictations")
        : await api(ctx, "DELETE", `/dictations/${encodeURIComponent(id as string)}`);
      return finish(ctx, r, (b: Body) =>
        all ? `${b.deleted} dictations deleted` : `dictation ${b.id} deleted`,
      );
    }
    if (sub === "retry") {
      const [id, ...more] = rest;
      if (!id || more.length > 0) return usage(ctx, "dictations retry needs one ID");
      const engine = str(p, "engine");
      if (engine === undefined || !ENGINES.includes(engine)) {
        return usage(ctx, `dictations retry needs --engine ${ENGINES.join(", ")}`);
      }
      const r = await api(ctx, "POST", `/dictations/${encodeURIComponent(id)}/retry`, {
        body: { engine },
        timeoutMs: 600_000,
      });
      if (!ctx.json && r.status === 200 && !r.body?.text) {
        ctx.io.err("akou: no speech heard on the retry");
        return EXIT.ok;
      }
      return finish(ctx, r, (b: Body) => b.text as string);
    }
    return usage(ctx, "dictations needs list, show, retry or delete");
  },
};
