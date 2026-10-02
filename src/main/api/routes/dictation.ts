/**
 * Dictation on the local API (docs/ux/DICTATION.md DC-G1), app mode only: a server has no keyboard
 * to type into (DC-X9).
 *
 * - `POST /dictations`: one clip (multipart `file`, a 16 kHz WAV, or anything ffmpeg reads) through
 *   the dictation path with no key and no insert, so a program can transcribe a clip the way a
 *   spoken dictation is: `{id, text, raw, language, words, engine, model, ms, state}`.
 * - `GET /dictations`, `GET /dictations/{id}`: the dictation log, newest first.
 * - `GET /dictations/{id}/audio`: a spoken dictation's kept audio, a 16 kHz WAV (DC-H2).
 * - `POST /dictations/{id}/retry {engine, language?}`: that audio decoded again with another engine,
 *   or forced into another language, answered beside the dictation, which is not changed.
 * - `POST /dictations/{id}/insert {text?, fix?}`: the draft box opened on it in the desktop
 *   window, where the user reads it and presses Enter; the API never pastes by itself (DC-N9).
 * - `DELETE /dictations/{id}`, `DELETE /dictations`: one dictation, or all, deleted with their
 *   audio; the log keeps a tombstone each and nothing else of them (DC-H2).
 * - `GET /dictation`: whether dictation is on, the session's state, the engine, the remote's
 *   standing and the grants the helper reports.
 * - `POST /dictation/start|stop|cancel`: the live session, as the tray and `akou dictate start`
 *   drive it (a latched session, as if the key were tapped).
 * - `GET /dictation/remote-test`: DC-R4's Test of `dictation.remote.url` with the key.
 * - `GET /dictation/stream`: Server-Sent Events (DC-G2), the call stream's contract (PG-S1): every
 *   dictation event after a cursor, each once, then each new one; and the mic's `level` during a
 *   session, which is never written anywhere.
 */

import type { DictationItem } from "../../../core/dictation/events.ts";
import { testRemote } from "../../dictation/remote.ts";
import type { ControlAction, DictationFollow, DictationService } from "../../dictation/service.ts";
import { readUploadAudio } from "../../server/audio.ts";
import { HttpError, json, type RouteContext, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { KEEPALIVE_MS, lastEventId } from "./follow.ts";
import { fileField, formOf, languageOf, textField } from "./jobs.ts";

/** The longest clip taken, seconds: `dictation.maxMinutes` at its top. */
export const MAX_CLIP_SECONDS = 60 * 60;
/** The engines a clip can name; `auto` is `dictation.engine`. */
const ENGINES = ["auto", "fast", "best", "live", "remote"];
const FIELDS = new Set(["file", "engine", "language"]);
/**
 * A retry's or a started session's `language`: auto, or a BCP-47 tag, as `language` on
 * dictations.create.
 */
const RETRY_LANGUAGE = /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;

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
    app_name: it.target?.name || null,
    seconds: it.seconds,
    text: it.text,
    raw: it.raw,
    language: it.language,
    words: it.words,
    engine: it.engine,
    model: it.model,
    ms: it.ms,
    ...(it.fallback_from ? { fallback_from: it.fallback_from } : {}),
    ...(it.language_forced !== null ? { language_forced: it.language_forced } : {}),
    ...(it.echo_retry ? { echo_retry: true } : {}),
    ...(it.error ? { error: it.error } : {}),
    ...(it.learn ? { learn: it.learn } : {}),
  };
}

export function dictationRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/dictations",
    {
      id: "dictations.create",
      doc: "Transcribe one clip through the dictation path: the dictation engine, the dictation log, no key and nothing inserted anywhere. `file` is a 16 kHz WAV or any format ffmpeg reads; `engine` is auto (`dictation.engine`), fast, best (Qwen3-ASR, falling back to fast when it fails or is missing), live (the streaming model's words, falling back to fast when none is downloaded), or remote (the akou at `dictation.remote.url`); `language` a BCP-47 tag or auto (`dictation.language`): best and a remote akou are forced into it, and the fast engine (Parakeet) ignores it, since it detects the language itself, so `language_forced` says whether it was used. Answers the dictation with its text, the detected language, per-word times and confidences where the engine gives them, the decode time, and `fallback_from` when another engine decoded it.",
      access: "admin",
      modes: ["app"],
      body: { multipart: { file: "file", "engine?": "string", "language?": "string" } },
      ok: 200,
      errors: {
        400: ["unknown_field"],
        404: ["not_found"],
        422: ["bad_field", "decode_failed", "missing_field", "too_long"],
        500: ["transcription_failed"],
        503: ["models_missing"],
      },
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
      doc: "The dictation log, newest first: each dictation's state, the app it went to (`app`, its id, and `app_name`, its name as people know it where the OS gives one, else null), its text, engine and timings. `q` keeps those whose text holds it (any case), `since` those started from that time on; `cursor` is the last id of the page before. A deleted dictation is not listed.",
      access: "admin",
      modes: ["app"],
      query: {
        q: { type: "string", doc: "Keep dictations whose text holds this, in any case." },
        since: {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          doc: "Keep dictations started at or after this time, epoch milliseconds.",
        },
        cursor: { type: "string", doc: "The `next_cursor` of the page before." },
        limit: { type: "integer", min: 1, max: 500, default: 100, doc: "Dictations per page." },
      },
      ok: 200,
      errors: { 400: ["bad_param"], 404: ["not_found"] },
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
      const since = c.query.int("since");
      if (since !== undefined) items = items.filter((it) => it.at >= since);
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
      errors: { 404: ["not_found"] },
    },
    (c) => {
      const it = service(c).log.item(c.params.id as string);
      if (!it) throw new HttpError(404, "not_found", `no dictation ${c.params.id}`);
      return json(200, dictationBody(it));
    },
  );
  r.add(
    "GET",
    "/dictations/:id/audio",
    {
      id: "dictations.audio",
      doc: "A spoken dictation's audio as mono Ogg Opus (a 16 kHz WAV, `audio/wav`, for one kept before akou kept Opus), kept for Retry and the learning check while `dictation.retainDays` keeps the dictation. None for a clip sent to dictations.create (akou keeps no copy of an upload), a password field, or with `dictation.keepAudio` off once its offer to learn is closed: then `no_audio`.",
      access: "admin",
      modes: ["app"],
      params: { id: "The dictation id, from dictations.list." },
      ok: 200,
      errors: { 404: ["no_audio", "not_found"] },
      type: "audio",
    },
    async (c) => {
      const id = c.params.id as string;
      const d = service(c);
      if (!d.log.item(id)) throw new HttpError(404, "not_found", `no dictation ${id}`);
      const kept = await d.audio.file(id);
      if (!kept) throw new HttpError(404, "no_audio", `dictation ${id} has no audio kept`, { id });
      const file = Bun.file(kept.path);
      return new Response(file, {
        headers: {
          "content-type": kept.type,
          "content-length": String(file.size),
          "cache-control": "no-store",
        },
      });
    },
  );
  r.add(
    "POST",
    "/dictations/:id/retry",
    {
      id: "dictations.retry",
      doc: "Decode a dictation's kept audio again with `engine` (auto, fast, best, live or remote, as in dictations.create), through the same silence guard, vocabulary and text rules as a new dictation. `language` (a BCP-47 tag, or auto for `dictation.language`) forces the decode into it on best and a remote akou, as the draft box's language chip does; fast detects the language itself. Answers the new reading (`text`, `raw`, `language`, `words`, `engine`, `model`, `ms`, `fallback_from` when another engine decoded it) beside the dictation, which is not changed; `text` is empty when no speech is heard. `no_audio` when the dictation has none kept.",
      access: "admin",
      modes: ["app"],
      params: { id: "The dictation id, from dictations.list." },
      body: { engine: "string", "language?": "string" },
      ok: 200,
      errors: {
        404: ["no_audio", "not_found"],
        422: ["bad_field"],
        500: ["transcription_failed"],
        503: ["models_missing"],
      },
    },
    async (c) => {
      const id = c.params.id as string;
      const d = service(c);
      const b = await c.body<{ engine: string; language?: string }>();
      const engine = b.engine.trim();
      const language = b.language?.trim() || "auto";
      if (!RETRY_LANGUAGE.test(language)) {
        throw new HttpError(422, "bad_field", "language is a BCP-47 tag, or auto", {
          field: "language",
        });
      }
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
      c.timeout?.(0);
      const r = await d.retry(id, {
        ...(engine === "auto" ? {} : { engine }),
        ...(language === "auto" ? {} : { language }),
      });
      if (r.ok) return json(200, r.answer);
      const status = {
        not_found: 404,
        no_audio: 404,
        models_missing: 503,
        transcription_failed: 500,
      };
      throw new HttpError(status[r.code], r.code, r.message, { id });
    },
  );
  r.add(
    "POST",
    "/dictations/:id/insert",
    {
      id: "dictations.insert",
      doc: "Open the draft box on a dictation in the desktop window, taking the keyboard: the user reads it, edits it, and Enter inserts it into the app and field captured when it began (Ctrl+Enter, Cmd+Enter on macOS, also presses `dictation.sendKey`). Nothing is pasted by this call. `text` shows another reading (a retry's) in place of the logged one; `fix: true` opens it for teaching only, where Enter offers to learn the words the user fixed and inserts nothing. `no_draft_box` with dictation off, `no_text` for a dictation with no text, `no_target` for a clip sent to dictations.create unless `fix` is set.",
      access: "admin",
      modes: ["app"],
      params: { id: "The dictation id, from dictations.list." },
      body: { "text?": "string", "fix?": "boolean" },
      ok: 200,
      errors: { 404: ["not_found"], 409: ["no_draft_box", "no_target", "no_text"] },
    },
    async (c) => {
      const id = c.params.id as string;
      const d = service(c);
      const b = await c.body<{ text?: string; fix?: boolean }>();
      const r = d.draft.open(id, {
        focus: true,
        ...(b.fix === true ? { fix: true } : {}),
        ...(b.text !== undefined ? { text: b.text } : {}),
      });
      if (r.ok) return json(200, { id, opened: true, fix: b.fix === true });
      throw new HttpError(r.code === "not_found" ? 404 : 409, r.code, r.message, { id });
    },
  );
  r.add(
    "DELETE",
    "/dictations/:id",
    {
      id: "dictations.delete",
      doc: "Delete one dictation: its text, words and events are gone from the dictation log, which keeps only a tombstone with its id, and its audio is deleted.",
      access: "admin",
      modes: ["app"],
      params: { id: "The dictation id, from dictations.list." },
      ok: 200,
      errors: { 404: ["not_found"] },
    },
    (c) => {
      const id = c.params.id as string;
      const d = service(c);
      if (!d.log.item(id)) throw new HttpError(404, "not_found", `no dictation ${id}`);
      d.forget([id]);
      return json(200, { id, deleted: true });
    },
  );
  r.add(
    "DELETE",
    "/dictations",
    {
      id: "dictations.clear",
      doc: 'Delete every dictation, as the page\'s "Delete all dictations now": the dictation log keeps a tombstone for each and nothing else, and no audio is left. Answers how many were deleted.',
      access: "admin",
      modes: ["app"],
      ok: 200,
      errors: { 404: ["not_found"] },
    },
    (c) => {
      const d = service(c);
      const gone = d.forget(d.log.items().map((it) => it.id));
      // Audio a crash left with no dictation goes too.
      d.sweep();
      return json(200, { deleted: gone.length });
    },
  );
  r.add(
    "GET",
    "/dictation",
    {
      id: "dictation.status",
      doc: 'Dictation now: `enabled` (`dictation.enabled`), the session\'s `state` (off, starting, idle, listening, transcribing, inserting), the `engine` a press decodes on (null with no model) and the `verdict` saying why on this machine ("best on metal", "downloading best, using fast"), whether it is `loading` its model (a press then is kept and decoded once it is ready), what a dictation inserts now as `final` (`dictation.final` as it resolves here: parakeet, live or qwen; remote; null with no model) and the streaming model the words while you speak come from as `live` (null: Parakeet, refreshed twice a second), the remote\'s `fallback` and standing while `dictation.engine` is remote, the `grants` the helper reports (mic and accessibility: granted, denied, not-asked or not-needed; read by a probe of the helper while dictation is off), the grants the running helper `lost` since it started (on macOS a revoked Accessibility grant leaves the dictation key doing nothing until it is given again, and the helper makes its key tap again by itself once it is), its key `backend`, and whether it can hold Escape and Enter during a session (`swallow_keys`).',
      access: "admin",
      modes: ["app"],
      ok: 200,
      errors: { 404: ["not_found"] },
    },
    async (c) => {
      const svc = service(c);
      const st = svc.status();
      // While dictation is off no helper runs, so a probe reads them: the switch knows what the
      // setup must ask for before it starts one (DC-U2, DC-N3).
      const grants = await svc.grants();
      const r = st.remote;
      return json(200, {
        enabled: c.app.config().settings["dictation.enabled"] === true,
        state: st.state,
        engine: st.engine,
        verdict: st.verdict,
        loading: st.loading,
        final: st.final,
        live: st.live,
        fallback: r?.fallback ?? null,
        remote: r
          ? {
              url: r.url,
              down: r.health?.down ?? false,
              failures: r.health?.failures ?? 0,
              error: r.health?.error ?? null,
              probing: r.health?.probing ?? false,
            }
          : null,
        grants,
        // Read after `grants()`, which may have started the helper again for a grant now back.
        lost: svc.status().lost,
        backend: st.backend,
        swallow_keys: st.swallow_keys,
      });
    },
  );
  const CONTROL: Record<ControlAction, string> = {
    start:
      "Start a latched dictation, as a tap of the dictation key: it listens until `dictation/stop`, a tap of the key, Escape, or silence. The text goes where the keyboard is when it ends. `language` (a BCP-47 tag, or auto for `dictation.language`) forces this dictation into it on best and a remote akou, as a click on the pill's language chip does; fast detects the language itself. Answers once the helper is listening.",
    stop: "End the dictation that is listening: its audio is transcribed and inserted where it began, as a tap of the key would.",
    cancel:
      "Cancel the dictation that is listening: nothing is transcribed or inserted, and history keeps it as cancelled.",
  };
  for (const action of ["start", "stop", "cancel"] as const) {
    r.add(
      "POST",
      `/dictation/${action}`,
      {
        id: `dictation.${action}`,
        doc: CONTROL[action],
        access: "admin",
        modes: ["app"],
        ...(action === "start" ? { body: { "language?": "string" } } : {}),
        ok: 200,
        errors: {
          404: ["not_found"],
          409: ["dictation_busy", "dictation_off", "not_dictating"],
          422: ["bad_field"],
          503: ["dictation_starting"],
        },
      },
      async (c) => {
        let language = "auto";
        if (action === "start") {
          const b = await c.body<{ language?: string }>();
          language = b.language?.trim() || "auto";
          if (!RETRY_LANGUAGE.test(language)) {
            throw new HttpError(422, "bad_field", "language is a BCP-47 tag, or auto", {
              field: "language",
            });
          }
        }
        const res = await service(c).control(
          action,
          undefined,
          language === "auto" ? {} : { language },
        );
        if (!res.ok) {
          const status = res.code === "dictation_starting" ? 503 : 409;
          throw new HttpError(status, res.code, res.message);
        }
        return json(200, { state: res.state });
      },
    );
  }
  r.add(
    "GET",
    "/dictation/remote-test",
    {
      id: "dictation.remoteTest",
      doc: "The Test of `dictation.remote.url` (DC-R4): `GET /v1/server` on the remote with `dictation.remote.key`, answering whether it works, its mode, the engine a dictation runs there, its accelerator, whether it biases, whether it has a dictation lane, the round trip and one summary line. A remote that refuses or is down is a result with `ok: false`, not an error; the key is never in it.",
      access: "admin",
      modes: ["app"],
      ok: 200,
      errors: { 404: ["not_found"], 409: ["no_remote"] },
    },
    async (c) => {
      service(c);
      const s = c.app.config().settings;
      if (s["dictation.remote.url"].trim() === "") {
        throw new HttpError(
          409,
          "no_remote",
          "dictation.remote.url is empty: set the akou to test",
        );
      }
      c.timeout?.(0);
      return json(
        200,
        await testRemote({
          url: s["dictation.remote.url"],
          key: s["dictation.remote.key"],
          glossary: s["dictation.glossary"] === "on" ? [] : null,
          timeoutSeconds: s["dictation.remote.timeoutSeconds"],
        }),
      );
    },
  );
  r.add(
    "GET",
    "/dictation/stream",
    {
      id: "dictation.stream",
      doc: "The dictation log as server-sent events: every event after the cursor (`event`, its `seq` as the id), then each new one as it is written, and the mic's `level` (`{rms}`, 20 a second) while a dictation listens or the Dictation page's meter is on, which is never stored. A reconnecting client sends `Last-Event-ID` and resumes after it; a deleted dictation shows only its tombstone.",
      access: "admin",
      modes: ["app"],
      query: {
        after: {
          type: "integer",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          default: 0,
          doc: "The log cursor: only events after this `seq`.",
        },
      },
      ok: 200,
      errors: { 404: ["not_found"] },
      type: "sse",
    },
    (c) => {
      const d = service(c);
      c.timeout?.(0);
      const after = Math.max(c.query.int("after") as number, lastEventId(c.req));
      return sseDictation(d, after, c.req.signal);
    },
  );
}

/**
 * The dictation stream (DC-G2): the backlog after `after`, then live events, each exactly once in
 * `seq` order, since every send reads the log from the last `seq` sent; levels as they come.
 */
function sseDictation(d: DictationService, after: number, signal: AbortSignal): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start: (ctl) => {
      let closed = false;
      let cursor = after;
      const send = (text: string) => {
        if (closed) return;
        try {
          ctl.enqueue(enc.encode(text));
        } catch {
          stop();
        }
      };
      const flush = () => {
        const all = d.log.events();
        let i = all.length;
        while (i > 0 && (all[i - 1]?.seq ?? 0) > cursor) i--;
        for (const e of all.slice(i)) {
          send(`id: ${e.seq}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = e.seq;
        }
      };
      const unfollow = d.follow((m: DictationFollow) => {
        if (m.kind === "event") flush();
        else if (m.kind === "level")
          send(`event: level\ndata: ${JSON.stringify({ rms: m.rms })}\n\n`);
      });
      // clock: a keep-alive comment, so a reader can tell a quiet stream from a dead connection.
      const keepalive = setInterval(() => send(": keep-alive\n\n"), KEEPALIVE_MS);
      const stop = () => {
        if (closed) return;
        closed = true;
        unfollow();
        clearInterval(keepalive);
        signal.removeEventListener("abort", stop);
        try {
          ctl.close();
        } catch {}
      };
      cleanup = stop;
      signal.addEventListener("abort", stop);
      send("retry: 1000\n\n");
      flush();
    },
    cancel: () => cleanup(),
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}
