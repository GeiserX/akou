/**
 * `akou transcribe FILE` (docs/ux/SERVER.md SV-D1): a file job from the command line. It uploads
 * the file to `POST /v1/jobs` of the akou it talks to, waits for the job to end, and prints the
 * transcript, so transcribing a file is the same job whichever door asks for it.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { bool, str } from "../args.ts";
import { EXIT } from "../client.ts";
import { api, type Body, type Command, finish } from "../context.ts";
import { usage } from "./calls.ts";

const PRESETS = ["lite", "fast", "best", "fusion", "auto"];

export const transcribeCommand: Command = {
  name: "transcribe",
  summary: "Transcribe an audio file as a server job and print the transcript",
  usage: `akou transcribe FILE [--preset ${PRESETS.join("|")}] [--language L] [--diarize]   [--json]`,
  flags: {
    preset: { type: "string", value: "P", desc: `${PRESETS.join(", ")} (default auto)` },
    language: { type: "string", value: "L", desc: "a BCP-47 tag such as en or es-ES, or auto" },
    diarize: { type: "boolean", desc: "label the speakers" },
  },
  examples: ["akou transcribe voice-note.ogg", "akou transcribe call.m4a --language es --diarize"],
  run: async (ctx, p) => {
    const [file, ...rest] = p.positional;
    if (!file || rest.length > 0) return usage(ctx, "transcribe needs one FILE");
    const preset = str(p, "preset");
    if (preset !== undefined && !PRESETS.includes(preset)) {
      return usage(ctx, `--preset is one of ${PRESETS.join(", ")}`);
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
    if (preset) form.append("preset", preset);
    const language = str(p, "language");
    if (language) form.append("language", language);
    if (bool(p, "diarize")) form.append("diarize", "true");
    // The desktop app has no job routes; `GET /v1/server` says so before any upload.
    const server = await api(ctx, "GET", "/server");
    if (server.body?.capabilities?.jobs !== true) {
      const message =
        "file jobs need akou in server mode (the server.enabled setting); the akou this command reached has none";
      if (ctx.json) ctx.io.out(JSON.stringify({ error: "not_server", message }));
      else ctx.io.err(`akou: ${message}`);
      return EXIT.unavailable;
    }
    const sent = await api(ctx, "POST", "/jobs", { form, timeoutMs: 600_000 });
    if (sent.status !== 202 && sent.status !== 200) return finish(ctx, sent, () => "");
    const id = sent.body.id as string;
    // The transcript printed is the only copy the caller asked for: the job is deleted once it is
    // out, and on Ctrl-C, which also cancels a job still queued or running (SV-J6).
    try {
      let job = { ...sent, status: 200 };
      while (job.status === 200 && ["queued", "running"].includes(job.body?.status)) {
        job = await api(ctx, "GET", `/jobs/${id}`, {
          query: { wait: 60 },
          timeoutMs: 90_000,
          signal: ctx.io.signal,
        });
      }
      if (job.status !== 200) return finish(ctx, job, () => "");
      if (job.body.status !== "done") {
        const e = job.body.error as { code?: string; message?: string } | undefined;
        const message = `the job ${job.body.status}${e?.message ? `: ${e.message}` : ""}`;
        if (ctx.json)
          ctx.io.out(JSON.stringify({ error: e?.code ?? job.body.status, message, id }));
        else ctx.io.err(`akou: ${message} (${id})`);
        return EXIT.software;
      }
      const result = await api(ctx, "GET", `/jobs/${id}/result`, { signal: ctx.io.signal });
      // No speech prints nothing on stdout, so a pipe never saves a placeholder as the transcript.
      if (!ctx.json && result.status === 200 && !result.body?.text) {
        ctx.io.err("akou: no speech in the file");
        return EXIT.ok;
      }
      return finish(ctx, result, (b: Body) => b.text as string);
    } catch (err) {
      // Ctrl-C: the job is cancelled below, and the exit is the shell's for SIGINT.
      if (ctx.io.signal?.aborted) return 130;
      throw err;
    } finally {
      await api(ctx, "DELETE", `/jobs/${id}`, { launch: false }).catch(() => {});
    }
  },
};
