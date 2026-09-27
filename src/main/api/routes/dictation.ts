/**
 * Dictation on the local API (docs/ux/DICTATION.md DC-G1), app mode only: a server has no keyboard
 * to type into (DC-X9).
 *
 * - `POST /dictations`: one clip (multipart `file`, a 16 kHz WAV, or anything ffmpeg reads) through
 *   the dictation path with no key and no insert, so a program can transcribe a clip the way a
 *   spoken dictation is: `{id, text, raw, language, words, engine, model, ms, state}`.
 * - `GET /dictations`, `GET /dictations/{id}`: the dictation log, newest first.
 */

import type { DictationItem } from "../../../core/dictation/events.ts";
import type { DictationService } from "../../dictation/service.ts";
import { readUploadAudio } from "../../server/audio.ts";
import { HttpError, json, type RouteContext, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { fileField, formOf, languageOf, textField } from "./jobs.ts";

/** The longest clip taken, seconds: `dictation.maxMinutes` at its top. */
export const MAX_CLIP_SECONDS = 60 * 60;
/** The engines a clip can name; `auto` is `dictation.engine`. `best` arrives with DC-E2. */
const ENGINES = ["auto", "fast", "remote"];
const FIELDS = new Set(["file", "engine", "language"]);

function service(c: RouteContext<ApiApp>): DictationService {
  const d = c.app.dictation?.();
  if (!d) throw new HttpError(404, "not_found", "dictation runs in the desktop app only");
  return d;
}

/** A dictation as the doors show it. */
export function dictationBody(it: DictationItem) {
  return {
    id: it.id,
    at: it.at,
    state: it.state,
    by: it.by,
    app: it.target?.app ?? null,
    seconds: it.seconds,
    text: it.text,
    raw: it.raw,
    language: it.language,
    words: it.words,
    engine: it.engine,
    model: it.model,
    ms: it.ms,
    ...(it.fallback_from ? { fallback_from: it.fallback_from } : {}),
    ...(it.error ? { error: it.error } : {}),
  };
}

export function dictationRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/dictations",
    {
      id: "dictations.create",
      doc: "Transcribe one clip through the dictation path: the dictation engine, the dictation log, no key and nothing inserted anywhere. `file` is a 16 kHz WAV or any format ffmpeg reads; `engine` is auto (`dictation.engine`), fast, or remote (the akou at `dictation.remote.url`); `language` a BCP-47 tag or auto: a remote akou gets it, and the fast engine (Parakeet) ignores it, since it detects the language itself. Answers the dictation with its text, the detected language, per-word times and confidences where the engine gives them, and the decode time.",
      access: "admin",
      modes: ["app"],
      body: { multipart: { file: "file", "engine?": "string", "language?": "string" } },
      ok: 200,
    },
    async (c) => {
      const d = service(c);
      const form = await formOf(c, d.uploadDir);
      try {
        for (const k of form.keys()) {
          if (!FIELDS.has(k)) {
            throw new HttpError(400, "unknown_field", `unknown field "${k}"`, { field: k });
          }
        }
        const file = fileField(form);
        const engine = textField(form, "engine")?.trim() || "auto";
        if (!ENGINES.includes(engine)) {
          throw new HttpError(422, "bad_field", `engine is one of ${ENGINES.join(", ")}`, {
            field: "engine",
          });
        }
        if (engine === "remote" && c.app.config().settings["dictation.remote.url"].trim() === "") {
          throw new HttpError(422, "bad_field", "engine remote needs dictation.remote.url", {
            field: "engine",
          });
        }
        const lang = languageOf(form);
        let samples: Float32Array;
        try {
          samples = await readUploadAudio(file.path, {
            signal: c.req.signal,
            maxSamples: MAX_CLIP_SECONDS * 16000,
          });
        } catch (err) {
          const e = err as { code?: string; message: string };
          throw new HttpError(422, e.code ?? "decode_failed", e.message, { field: "file" });
        }
        c.timeout?.(0);
        const it = await d.transcribeClip(samples, {
          by: c.by,
          ...(engine === "auto" ? {} : { engine }),
          ...(lang === "auto" ? {} : { language: lang }),
        });
        if (it.state === "failed") {
          const missing = /no speech model/.test(it.error ?? "");
          throw new HttpError(
            missing ? 503 : 500,
            missing ? "models_missing" : "transcription_failed",
            it.error ?? "the dictation failed",
            { id: it.id },
          );
        }
        return json(200, dictationBody(it));
      } finally {
        // The clip is decoded and gone: akou keeps no copy of an upload.
        await form.discard();
      }
    },
  );
  r.add(
    "GET",
    "/dictations",
    {
      id: "dictations.list",
      doc: "The dictation log, newest first: each dictation's state, the app it went to, its text, engine and timings. `q` keeps those whose text holds it (any case); `cursor` is the last id of the page before.",
      access: "admin",
      modes: ["app"],
      query: {
        q: { type: "string", doc: "Keep dictations whose text holds this, in any case." },
        cursor: { type: "string", doc: "The `next_cursor` of the page before." },
        limit: { type: "integer", min: 1, max: 500, default: 100, doc: "Dictations per page." },
      },
      ok: 200,
    },
    (c) => {
      const d = service(c);
      const q = c.query.raw("q")?.toLowerCase() ?? "";
      const cursor = c.query.raw("cursor");
      const limit = c.query.int("limit") as number;
      let items = d.log.items();
      if (cursor) {
        const at = items.findIndex((it) => it.id === cursor);
        if (at < 0)
          throw new HttpError(400, "bad_param", "cursor names no dictation", { param: "cursor" });
        items = items.slice(at + 1);
      }
      if (q !== "") items = items.filter((it) => (it.text ?? "").toLowerCase().includes(q));
      const page = items.slice(0, limit);
      return json(200, {
        items: page.map(dictationBody),
        next_cursor: items.length > limit ? (page.at(-1)?.id ?? null) : null,
      });
    },
  );
  r.add(
    "GET",
    "/dictations/:id",
    {
      id: "dictations.get",
      doc: "One dictation: its state, the app it went to, the raw and inserted text, the language, per-word times and confidences where the engine gives them, the engine and the decode time.",
      access: "admin",
      modes: ["app"],
      params: { id: "The dictation id, from dictations.list." },
      ok: 200,
    },
    (c) => {
      const it = service(c).log.item(c.params.id as string);
      if (!it) throw new HttpError(404, "not_found", `no dictation ${c.params.id}`);
      return json(200, dictationBody(it));
    },
  );
}
