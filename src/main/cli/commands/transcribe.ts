/**
 * `akou transcribe FILE` (docs/ux/SERVER.md SV-D1): a file job from the command line. It uploads
 * the file to `POST /v1/jobs` of the akou it talks to, waits for the job to end, and prints the
 * transcript, so transcribing a file is the same job whichever door asks for it. That akou is the
 * desktop app on this machine, with its one token, or a server named by `AKOU_URL` with a key.
 *
 * On a server the job is deleted once its transcript is printed: the server keeps no copy. The
 * desktop app keeps it, so `akou jobs list` shows it, until `server.retain_days` deletes it. A
 * job cut short (Ctrl-C) is cancelled and deleted on both.
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
  summary: "Transcribe an audio file on this akou, or on a server (AKOU_URL), and print the text",
  usage: `akou transcribe FILE [--preset ${PRESETS.join("|")}] [--language L] [--diarize]   [--json]`,
  flags: {
    preset: { type: "string", value: "P", desc: `${PRESETS.join(", ")} (default auto)` },
    language: { type: "string", value: "L", desc: "a BCP-47 tag such as en or es-ES, or auto" },
    diarize: { type: "boolean", desc: "label the speakers" },
  },
  notes: [
    "The desktop app on this machine transcribes the file itself, with no setting to turn on.",
    "Long audio is cut at its pauses, so a long recording works, up to server.max_audio_minutes",
    "(240). The command waits until the job ends; Ctrl-C cancels it.",
    "The job then stays in `akou jobs list` for server.retain_days.",
    "AKOU_URL sends the file to an akou server instead, with the key in AKOU_API_KEY or in the",
    "file AKOU_API_KEY_FILE names; the server deletes the job once the text is printed.",
    "Exit codes: 0 done (no speech prints nothing), 64 usage, 69 no akou to reach, 70 the job failed.",
  ],
  examples: [
    "akou transcribe voice-note.ogg",
    "akou transcribe call.m4a --preset best --language es --diarize",
    "AKOU_URL=https://akou.example AKOU_API_KEY_FILE=~/.config/akou-key akou transcribe note.ogg",
  ],
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
    // An akou with no job routes (one older than file jobs in the desktop app, or one whose job
    // queue did not start) says so on `GET /v1/server`, before any upload.
    const server = await api(ctx, "GET", "/server");
    if (server.body?.capabilities?.jobs !== true) {
      const message = ctx.io.env.AKOU_URL?.trim()
        ? "the akou at AKOU_URL takes no file jobs"
        : "the akou on this machine takes no file jobs: update it, or set AKOU_URL to an akou server (`akou help transcribe`)";
      if (ctx.json) ctx.io.out(JSON.stringify({ error: "no_jobs", message }));
      else ctx.io.err(`akou: ${message}`);
      return EXIT.unavailable;
    }
    // The desktop app keeps the job for `akou jobs list`; a server keeps no copy once it is out.
    const keep = server.body?.mode === "app";
    const sent = await api(ctx, "POST", "/jobs", { form, timeoutMs: 600_000 });
    if (sent.status !== 202 && sent.status !== 200) return finish(ctx, sent, () => "");
    const id = sent.body.id as string;
    // Whether the job reached its end here: one cut short (Ctrl-C, a lost connection) is cancelled.
    let ended = false;
    // On a server the transcript printed is the only copy the caller asked for: the job is deleted
    // once it is out. Ctrl-C cancels a job still queued or running, in both modes (SV-J6).
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
      ended = true;
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
      if (!keep || !ended) {
        await api(ctx, "DELETE", `/jobs/${id}`, { launch: false }).catch(() => {});
      }
    }
  },
};
