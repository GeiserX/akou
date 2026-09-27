/**
 * Dictation on the local API (docs/ux/DICTATION.md DC-G1), app mode only: a server has no keyboard
 * to type into (DC-X9).
 *
 * - `POST /dictations`: one clip (multipart `file`, a 16 kHz WAV, or anything ffmpeg reads) through
 *   the dictation path with no key and no insert, so a program can transcribe a clip the way a
 *   spoken dictation is: `{id, text, raw, language, words, engine, model, ms, state}`.
 * - `GET /dictations`, `GET /dictations/{id}`: the dictation log, newest first.
 * - `DELETE /dictations/{id}`, `DELETE /dictations`: one dictation, or all, deleted; the log keeps
 *   a tombstone each and nothing else of them (DC-H2).
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
const ENGINES = ["auto", "fast", "best", "remote"];
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
    ...(it.language_forced !== null ? { language_forced: it.language_forced } : {}),
    ...(it.echo_retry ? { echo_retry: true } : {}),
    ...(it.error ? { error: it.error } : {}),
  };
}

export function dictationRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/dictations",
    {
      id: "dictations.create",
      doc: "Transcribe one clip through the dictation path: the dictation engine, the dictation log, no key and nothing inserted anywhere. `file` is a 16 kHz WAV or any format ffmpeg reads; `engine` is auto (`dictation.engine`), fast, best (Qwen3-ASR, falling back to fast when it fails or is missing), or remote (the akou at `dictation.remote.url`); `language` a BCP-47 tag or auto (`dictation.language`): best and a remote akou are forced into it, and the fast engine (Parakeet) ignores it, since it detects the language itself, so `language_forced` says whether it was used. Answers the dictation with its text, the detected language, per-word times and confidences where the engine gives them, the decode time, and `fallback_from` when another engine decoded it.",
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
      doc: "The dictation log, newest first: each dictation's state, the app it went to, its text, engine and timings. `q` keeps those whose text holds it (any case), `since` those started from that time on; `cursor` is the last id of the page before. A deleted dictation is not listed.",
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
    },
    (c) => {
      const it = service(c).log.item(c.params.id as string);
      if (!it) throw new HttpError(404, "not_found", `no dictation ${c.params.id}`);
      return json(200, dictationBody(it));
    },
  );
  r.add(
    "DELETE",
    "/dictations/:id",
    {
      id: "dictations.delete",
      doc: "Delete one dictation: its text, words and events are gone from the dictation log, which keeps only a tombstone with its id.",
      access: "admin",
      modes: ["app"],
      params: { id: "The dictation id, from dictations.list." },
      ok: 200,
    },
    (c) => {
      const id = c.params.id as string;
      const d = service(c);
      if (!d.log.item(id)) throw new HttpError(404, "not_found", `no dictation ${id}`);
      d.log.forget([id]);
      return json(200, { id, deleted: true });
    },
  );
  r.add(
    "DELETE",
    "/dictations",
    {
      id: "dictations.clear",
      doc: 'Delete every dictation, as the page\'s "Delete all dictations now": the dictation log keeps a tombstone for each and nothing else. Answers how many were deleted.',
      access: "admin",
      modes: ["app"],
      ok: 200,
    },
    (c) => {
      const d = service(c);
      const gone = d.log.forget(d.log.items().map((it) => it.id));
      return json(200, { deleted: gone.length });
    },
  );
  r.add(
    "GET",
    "/dictation",
    {
      id: "dictation.status",
      doc: 'Dictation now: `enabled` (`dictation.enabled`), the session\'s `state` (off, starting, idle, listening, transcribing, inserting), the `engine` a press decodes on (null with no model) and the `verdict` saying why on this machine ("best on metal", "downloading best, using fast"), whether it is `loading` its model (a press then is kept and decoded once it is ready), the remote\'s `fallback` and standing while `dictation.engine` is remote, the `grants` the helper reports (mic and accessibility: granted, denied or not-needed), its key `backend`, and whether it can hold Escape and Enter during a session (`swallow_keys`).',
      access: "admin",
      modes: ["app"],
      ok: 200,
    },
    (c) => {
      const st = service(c).status();
      const r = st.remote;
      return json(200, {
        enabled: c.app.config().settings["dictation.enabled"] === true,
        state: st.state,
        engine: st.engine,
        verdict: st.verdict,
        loading: st.loading,
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
        grants: st.grants,
        backend: st.backend,
        swallow_keys: st.swallow_keys,
      });
    },
  );
  const CONTROL: Record<ControlAction, string> = {
    start:
      "Start a latched dictation, as a tap of the dictation key: it listens until `dictation/stop`, a tap of the key, Escape, or silence. The text goes where the keyboard is when it ends. Answers once the helper is listening.",
    stop: "End the dictation that is listening: its audio is transcribed and inserted where it began, as a tap of the key would.",
    cancel:
      "Cancel the dictation that is listening: nothing is transcribed or inserted, and history keeps it as cancelled.",
  };
  for (const action of ["start", "stop", "cancel"] as const) {
    r.add(
      "POST",
      `/dictation/${action}`,
      { id: `dictation.${action}`, doc: CONTROL[action], access: "admin", modes: ["app"], ok: 200 },
      async (c) => {
        const res = await service(c).control(action);
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
      doc: "The dictation log as server-sent events: every event after the cursor (`event`, its `seq` as the id), then each new one as it is written, and the mic's `level` (`{rms}`, 20 a second) while a dictation listens, which is never stored. A reconnecting client sends `Last-Event-ID` and resumes after it; a deleted dictation shows only its tombstone.",
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
        else send(`event: level\ndata: ${JSON.stringify({ rms: m.rms })}\n\n`);
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
