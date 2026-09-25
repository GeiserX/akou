/**
 * The routes a client of server mode starts from (docs/ux/SERVER.md SV-P4, SV-K1, and
 * docs/research/service-interface.md SI-3). They answer in both modes.
 *
 * - `GET /healthz`, no key: `{ok, version, models_ready, queue_depth}`, 200 when the API answers,
 *   503 while the models load: while the files download, and while the recognizer loads them.
 *   `models_ready` is true only once the recognizer is ready. Docker's `HEALTHCHECK` calls it.
 * - `GET /v1/server`, no key: what this akou is and can do, so a client tells akou from a plain
 *   OpenAI-compatible server and lists the presets before offering them. A capability is true only
 *   once its route exists, so the flags follow the code; a client ignores flags it does not know.
 * - `GET /v1/keys/me`, any key: the calling key's `{id, name, scopes, created_at}`; the app's token
 *   answers as `{id: "app", name: "app", scopes: ["admin"]}`. Executor's health check calls it.
 */

import { RECOGNIZER } from "../../asr/models.ts";
import { PRESETS } from "../../server/presets.ts";
import { caller } from "../caller.ts";
import { json, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";

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
    (c) => {
      const { loading, ready } = modelState(c.app);
      return json(loading ? 503 : 200, {
        ok: !loading,
        version: c.app.version,
        models_ready: ready,
        queue_depth: c.app.queueDepth?.() ?? 0,
      });
    },
    { access: "open" },
  );
}

export function serverRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/server",
    (c) => {
      const { ready } = modelState(c.app);
      const has = (method: string, path: string) =>
        r.list().some((x) => x.method === method && x.path === path);
      return json(200, {
        name: "akou",
        version: c.app.version,
        mode: c.app.mode ?? "app",
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
        capabilities: {
          jobs: has("POST", "/jobs"),
          // Signed deliveries per key (SV-E2) come with the job route's `callback_url`.
          webhooks: has("POST", "/jobs"),
          events: has("GET", "/events"),
          openai: has("POST", "/audio/transcriptions"),
          wyoming: false,
          bazarr: false,
        },
      });
    },
    { access: "open" },
  );

  r.add(
    "GET",
    "/keys/me",
    (c) => {
      const me = caller(c);
      return json(200, {
        id: me.id,
        name: me.name,
        scopes: me.scopes,
        ...(me.created_at !== undefined ? { created_at: me.created_at } : {}),
      });
    },
    { access: "jobs" },
  );
}
