/**
 * `akou dictate FILE` (docs/ux/DICTATION.md DC-G3): one clip through the dictation path of the
 * running app, `POST /v1/dictations`, and its text printed. Nothing is typed anywhere. The compiled
 * CLI carries no engine, so the app does the decoding.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { str } from "../args.ts";
import { EXIT } from "../client.ts";
import { api, type Body, type Command, finish } from "../context.ts";
import { usage } from "./calls.ts";

const ENGINES = ["auto", "fast"];

export const dictateCommand: Command = {
  name: "dictate",
  summary: "Transcribe a clip through the dictation path of the app and print the text",
  usage: `akou dictate FILE [--engine ${ENGINES.join("|")}] [--language L]   [--json]`,
  flags: {
    engine: { type: "string", value: "E", desc: `${ENGINES.join(", ")} (default auto)` },
    language: { type: "string", value: "L", desc: "a BCP-47 tag such as en or es-ES, or auto" },
  },
  examples: ["akou dictate note.wav", "akou dictate note.wav --json"],
  run: async (ctx, p) => {
    const [file, ...rest] = p.positional;
    if (!file || rest.length > 0) return usage(ctx, "dictate needs one FILE");
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
