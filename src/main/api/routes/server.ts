/**
 * The routes a client of server mode starts from (docs/ux/SERVER.md SV-P4, SV-K1, and
 * docs/research/service-interface.md SI-3). They answer in both modes.
 *
 * - `GET /healthz`, no key: `{ok, version, models_ready, queue_depth, queue}`, 200 when the API
 *   answers, 503 while the models load: while the files download, and while the recognizer loads
 *   them. `models_ready` is true only once the recognizer is ready. Docker's `HEALTHCHECK` calls it.
 *   `queue` is the job queue's settings, depth, throughput and ETA (SV-Q4), in both modes.
 * - `GET /v1/server`, no key: what this akou is and can do, and a link to the OpenAPI file (SV-C4),
 *   so a client tells akou from a plain OpenAI-compatible server and lists the presets before
 *   offering them. A capability is true only once its route exists, so the flags follow the code;
 *   a client ignores flags it does not know.
 *   `retain_days` is `server.retain_days` (SV-K1b), so a client knows when a job's result is gone.
 *   `default_diarize` is `server.default_diarize`, what a job that sends no `diarize` gets.
 *   The `auto` preset names what it resolves to (`resolves_to`) and is available when that is.
 *   `gpu` and `accelerator` are `asr.accelerator` as detected at start and confirmed by the
 *   llama-server build (akou-5an.94), so a client or an operator sees which GPU runs, or why none.
 *   `auto` is what a job that names no model runs here and why (SV-R2), null in the desktop app.
 *   `queue` is the same object `/healthz` carries, so a client paces a backlog by it (SV-Q4).
 *   `dictation` is the reserved lane for dictation (DICTATION.md DC-R2): `slots`, `engine` and
 *   `served_last_hour`, null in the desktop app; `capabilities.interactive` is true while it has a
 *   slot, so a dictating client knows its requests will not wait behind the queue.
 * - `GET /v1/keys/me`, any key: the calling key's `{id, name, scopes, created_at}`; the app's token
 *   answers as `{id: "app", name: "app", scopes: ["admin"]}`. Executor's health check calls it.
 */

import { fusionChoice } from "../../asr/fusion.ts";
import { RECOGNIZER } from "../../asr/models.ts";
import type { QueueStats } from "../../server/jobs.ts";
import { hardwareChoice, type ModelChoice } from "../../server/model-store.ts";
import { PRESET_NAMES, PRESETS } from "../../server/presets.ts";
import { caller } from "../caller.ts";
import { json, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { BOUND_LANGUAGES } from "./jobs.ts";

/** The job queue's numbers (SV-Q4), or null where there is no queue. */
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
      doc: "Whether akou answers and its speech models are ready. Needs no key. 200 when ready or with no models to load, 503 while the models download or load. `queue` is the job queue's settings, depth, throughput and ETA, in both modes.",
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
      doc: "What this akou is and can do: its version and mode, the presets and whether each is available (`auto` carries `resolves_to`, the preset it runs now or the recognizer `server.default_model` names, and is available when that is), each with its `engines` in priority order, its speaker model (`diarizer`) and how it joins its engines (`fusion`: `rover-conf` for the `fusion` preset, as `asr.fusion` sets it, null for one engine), `auto`: the preset and recognizer a job that names no model runs here and why (`preset`, `model`, `reason`; null where file jobs are off), the engines, the GPU the large speech model runs on (`gpu`, and `accelerator` with the setting, the build, the device, whether llama-server confirmed it, and why), which capabilities (jobs, events, the OpenAI route) exist, the remote akou servers jobs are sent to (`remotes`: url, state and the presets each offers, never a key), `retain_days`, the days akou keeps a job and its result, counted from the job's creation, before it deletes them (`server.retain_days`), `default_diarize`, whether a job that sends no `diarize` gets speaker labels (`server.default_diarize`; a request's `diarize` always wins), `queue`: `concurrency`, the limits `max` and `max_per_key` (0 for none), `depth`, `queued`, `running`, `jobs_last_hour`, `audio_seconds_last_hour`, `mean_job_seconds` and `eta_seconds`, so a client paces a backlog, and `dictation`: the lane `interactive=true` requests run in, with its `slots` (`server.dictation_slots`), `engine` (the preset or recognizer `server.dictation_engine` resolves to, so `auto` shows what it picks) and `served_last_hour` (`capabilities.interactive` is true while it has a slot). `bound_languages`: the ISO codes a job's `languages[]` may name (`capabilities.languages_bound`). Needs no key.",
      access: "open",
      modes: ["app", "server"],
      ok: 200,
    },
    (c) => {
      const { ready } = modelState(c.app);
      // The engines first: planning Qwen's llama-server can correct the accelerator it reports.
      const engines = c.app.engines?.() ?? [{ id: RECOGNIZER, provider: "cpu", installed: ready }];
      const accel = c.app.accelerator?.() ?? null;
      const has = (method: string, path: string) =>
        r.list().some((x) => x.method === method && x.path === path);
      // Section 14: a preset a remote offers is available here too, since a job for it runs there.
      const jobs = c.app.jobs?.();
      const remotes = jobs?.remotes;
      // The desktop app dictates through its own engine, not a lane of the job queue.
      const dictation = c.app.mode?.() === "server" ? (jobs?.dictationStats() ?? null) : null;
      const offered = (name: string): boolean => {
        const p = PRESETS.find((x) => x.name === name);
        return !!p?.built && (c.app.presetAvailable?.(p.name) ?? ready);
      };
      // SV-K1: `auto` runs what a request naming nothing runs (SERVER.md 12.1), so it is available
      // when that is, and says what it is; null when `server.default_model` refuses every job.
      let auto: ModelChoice | { model: string; preset: string } | null = hardwareChoice();
      if (jobs) {
        try {
          auto = jobs.choose({});
        } catch {
          auto = null;
        }
      }
      const autoAvailable =
        auto !== null &&
        ((PRESET_NAMES as readonly string[]).includes(auto.preset)
          ? offered(auto.preset)
          : (jobs?.obtainable(auto.model) ?? false));
      return json(200, {
        name: "akou",
        version: c.app.version,
        mode: c.app.mode?.() ?? "app",
        // SV-R1: each preset's engines, speaker model and how it joins its engines; `fusion`'s as
        // the settings make it (`asr.final.engines`, `asr.fusion`).
        presets: PRESETS.map((p) => {
          const fused = p.name === "fusion" ? fusionChoice(c.app.config().settings) : null;
          return {
            name: p.name,
            available:
              (p.name === "auto" ? autoAvailable : offered(p.name)) ||
              (remotes?.offered([p.name]) ?? false),
            engines: fused ? fused.engines : p.engines,
            diarizer: p.diarizer,
            fusion: fused ? fused.fuser : p.fusion,
            hardware: p.hardware,
            speed: p.speed,
            // The preset `auto` runs now, or the recognizer id when `server.default_model` names one.
            ...(p.name === "auto"
              ? { resolves_to: auto && (auto.preset === "custom" ? auto.model : auto.preset) }
              : {}),
          };
        }),
        // SV-R2: what a job with no opinion runs here now, and why; null where file jobs are off.
        auto: jobs ? (c.app.autoChoice?.() ?? null) : null,
        // Where each recognizer runs: `provider` is `cpu`, or the GPU API llama-server uses for
        // Qwen (`metal`, `vulkan`, `cuda`, `sycl`, `rocm`), or `custom` for an own llama-server
        // (`asr.llamaServer`).
        engines,
        // The GPU llama-server runs on, null on the CPU; `accelerator` says which build, what it
        // runs on, whether the build itself confirmed it, and why.
        gpu: accel?.gpu ?? null,
        accelerator: accel
          ? {
              setting: accel.setting,
              active: accel.active,
              device: accel.device,
              verified: accel.verified,
              available: accel.available,
              reason: accel.reason,
            }
          : null,
        // The remote akou servers jobs are sent to, and what each offers: never a key.
        remotes: remotes?.view() ?? [],
        // SV-K1b: how long a job's result and events stay, counted from its creation, so a client knows when they go.
        retain_days: c.app.config().settings["server.retain_days"],
        // `server.default_diarize`: whether a job that sends no `diarize` gets speaker labels.
        default_diarize: c.app.config().settings["server.default_diarize"],
        // SV-Q4: the queue's settings, depth, throughput and ETA, in both modes.
        queue: queueOf(c.app),
        // DC-R2: the lane dictations run in; null in the desktop app.
        dictation,
        capabilities: {
          // In both modes: the desktop app takes file jobs with its one token (SV-J1).
          jobs: has("POST", "/jobs"),
          // Signed deliveries per key (SV-E2) come with the job route's `callback_url`, and only a
          // key has a secret to sign with: none in the desktop app, which has no key routes.
          webhooks: has("POST", "/jobs") && has("POST", "/keys"),
          events: has("GET", "/events"),
          openai: has("POST", "/audio/transcriptions"),
          // DC-R2: `interactive=true` takes the dictation lane only while it has a slot.
          interactive: has("POST", "/audio/transcriptions") && (dictation?.slots ?? 0) > 0,
          // A job's `languages[]` bounds its `auto` language (`bound_languages` are the codes).
          languages_bound: has("POST", "/jobs"),
          wyoming: false,
          bazarr: false,
        },
        // The ISO codes a job's `languages[]` may name: the ones the language-choosing engine has.
        bound_languages: has("POST", "/jobs") ? BOUND_LANGUAGES : [],
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
