/**
 * The routes a client of server mode starts from (docs/ux/SERVER.md SV-P4, SV-K1, and
 * docs/research/service-interface.md SI-3). They answer in both modes.
 *
 * - `GET /healthz`, no key: `{ok, version, models_ready, queue_depth, queue}`, 200 when the API
 *   answers, 503 while the models load: while the files download, and while the recognizer loads
 *   them. `models_ready` is true only once the recognizer is ready. Docker's `HEALTHCHECK` calls it.
 *   `queue` is the job queue's settings, depth, throughput and ETA (SV-Q4), null in the app.
 * - `GET /v1/server`, no key: what this akou is and can do, and a link to the OpenAPI file (SV-C4),
 *   so a client tells akou from a plain OpenAI-compatible server and lists the presets before
 *   offering them. A capability is true only once its route exists, so the flags follow the code;
 *   a client ignores flags it does not know.
 *   `retain_days` is `server.retain_days` (SV-K1b), so a client knows when a job's result is gone.
 *   `queue` is the same object `/healthz` carries, so a client paces a backlog by it (SV-Q4).
 * - `GET /v1/keys/me`, any key: the calling key's `{id, name, scopes, created_at}`; the app's token
 *   answers as `{id: "app", name: "app", scopes: ["admin"]}`. Executor's health check calls it.
 */

import { RECOGNIZER } from "../../asr/models.ts";
import type { QueueStats } from "../../server/jobs.ts";
import { PRESETS } from "../../server/presets.ts";
import { caller } from "../caller.ts";
import { json, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";

/** The job queue's numbers (SV-Q4), or null where there is no queue (the desktop app). */
function queueOf(app: ApiApp): QueueStats | null {
  return app.jobs?.()?.queueStats() ?? null;
}

/** The models load (files downloading, or the recognizer reading them), and are ready to use. */
function modelState(app: ApiApp): { loading: boolean; ready: boolean } {
  const files = app.models().state;
  const recognizer = app.recognizer?.() ?? "ready";
  return {
    loading: files === "downloading" || recognizer === "loading",
    ready: files === "ready" && recognizer === "ready",
  };
}

export function rootRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/healthz",
    {
      id: "server.health",
      doc: "Whether akou answers and its speech models are ready. Needs no key. 200 when ready or with no models to load, 503 while the models download or load. `queue` is the job queue's settings, depth, throughput and ETA, null in the desktop app.",
      access: "open",
      modes: ["app", "server"],
      ok: 200,
    },
    (c) => {
      const { loading, ready } = modelState(c.app);
      return json(loading ? 503 : 200, {
        ok: !loading,
        version: c.app.version,
        models_ready: ready,
        queue_depth: c.app.queueDepth?.() ?? 0,
        queue: queueOf(c.app),
      });
    },
  );
}

export function serverRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/server",
    {
      id: "server.get",
      doc: "What this akou is and can do: its version and mode, the presets and whether each is available, the engines, which capabilities (jobs, events, the OpenAI route) exist, and `retain_days`, the days akou keeps a job and its result, counted from the job's creation, before it deletes them (`server.retain_days`), and `queue`: `concurrency`, the limits `max` and `max_per_key` (0 for none), `depth`, `queued`, `running`, `jobs_last_hour`, `audio_seconds_last_hour`, `mean_job_seconds` and `eta_seconds`, so a client paces a backlog. Needs no key.",
      access: "open",
      modes: ["app", "server"],
      ok: 200,
    },
    (c) => {
      const { ready } = modelState(c.app);
      const has = (method: string, path: string) =>
        r.list().some((x) => x.method === method && x.path === path);
      return json(200, {
        name: "akou",
        version: c.app.version,
        mode: c.app.mode?.() ?? "app",
        presets: PRESETS.map((p) => ({
          name: p.name,
          available: p.built && ready,
          engines: p.engines,
          hardware: p.hardware,
          speed: p.speed,
        })),
        engines: [{ id: RECOGNIZER, provider: "cpu", installed: ready }],
        // Hardware detection is SV-R2; until then nothing claims a GPU.
        gpu: null,
        // SV-K1b: how long a job's result and events stay, counted from its creation, so a client knows when they go.
        retain_days: c.app.config().settings["server.retain_days"],
        // SV-Q4: the queue's settings, depth, throughput and ETA; null in the desktop app.
        queue: queueOf(c.app),
        capabilities: {
          jobs: has("POST", "/jobs"),
          // Signed deliveries per key (SV-E2) come with the job route's `callback_url`.
          webhooks: has("POST", "/jobs"),
          events: has("GET", "/events"),
          openai: has("POST", "/audio/transcriptions"),
          wyoming: false,
          bazarr: false,
        },
        // SV-C4: where this API's description is, once the route serving it exists.
        links: has("GET", "/openapi.json") ? { openapi: "/v1/openapi.json" } : {},
      });
    },
  );

  r.add(
    "GET",
    "/keys/me",
    {
      id: "keys.me",
      doc: "The calling key: its id, name, scopes and creation time. The app's own token answers as `app` with the `admin` scope. Executor's health check calls it.",
      access: "jobs",
      modes: ["app", "server"],
      ok: 200,
    },
    (c) => {
      const me = caller(c);
      return json(200, {
        id: me.id,
        name: me.name,
        scopes: me.scopes,
        ...(me.created_at !== undefined ? { created_at: me.created_at } : {}),
      });
    },
  );
}
