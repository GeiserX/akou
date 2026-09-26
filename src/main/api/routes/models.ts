/**
 * The speech models' first-run download (docs/DESIGN.md section 3: "first run offers one explicit
 * download"), and in server mode one model at a time (docs/ux/SERVER.md SV-M6). The models are never
 * bundled; the window's download card and `akou models pull` are the two ways to fetch them.
 *
 * - `GET /models`: `{state: missing|downloading|ready|failed, dir, bytes, total, file?, error?}`; in
 *   server mode also `models: [{id, state, bytes, size, last_used_at, evicts_at, default, in_use}]`,
 *   every catalog model.
 * - `POST /models/pull`: starts the download of every missing file, each checked against its
 *   pinned SHA-256, and answers at once: `202` with the state while it runs, `200` when the models
 *   are already there. Progress is `GET /models`. In server mode `{"model": id}` fetches that one
 *   model under the on-demand limits (SV-M2).
 * - `DELETE /models/{id}` (server mode): deletes one model under the sweep's rules; 409
 *   `model_in_use` for the default's set or a model a job needs.
 *
 * Until the models are there, `POST /calls` answers `503 models_missing`.
 */

import { ModelRefused } from "../../server/model-store.ts";
import { caller } from "../caller.ts";
import { HttpError, json, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";

/** A refusal of the model store, as the API answers it. */
function answer<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ModelRefused)
      throw new HttpError(err.status, err.code, err.message, err.details);
    throw err;
  }
}

export function modelRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/models",
    {
      id: "models.get",
      doc: "The speech models on disk: `missing`, `downloading` with bytes so far, `ready` or `failed`. In server mode, `models` lists every catalog model with its state, size, last use, the date the sweep will delete it, and whether it is the default's or in use.",
      access: "admin",
      modes: ["app", "server"],
      ok: 200,
    },
    (c) => {
      const jobs = c.app.jobs?.();
      return json(200, { ...c.app.models(), ...(jobs ? { models: jobs.modelList() } : {}) });
    },
  );
  r.add(
    "POST",
    "/models/pull",
    {
      id: "models.pull",
      doc: "Download every missing model file, each checked against its pinned SHA-256. Answers at once: 202 while the download runs, 200 when the models are already there. Follow it with models.get. In server mode `model` fetches that one catalog model, under `server.models_max_gb` and the free-space check.",
      access: "admin",
      modes: ["app", "server"],
      body: { "model?": "string" },
      ok: 202,
    },
    async (c) => {
      const b = await c.body<{ model?: unknown }>();
      if (b.model !== undefined) {
        const jobs = c.app.jobs?.();
        if (typeof b.model !== "string" || b.model.trim() === "") {
          throw new HttpError(422, "bad_field", "model is a model id", { field: "model" });
        }
        if (!jobs) {
          throw new HttpError(
            422,
            "bad_field",
            "a single model is pulled in server mode only; run `akou models pull <model>`",
            { field: "model" },
          );
        }
        const id = b.model.trim();
        const m = answer(() => jobs.pullModel(id));
        return json(m.state === "ready" ? 200 : 202, m);
      }
      const s = c.app.pullModels();
      return json(s.state === "ready" ? 200 : 202, s);
    },
  );
  r.add(
    "DELETE",
    "/models/:id",
    {
      id: "models.delete",
      doc: "Delete one model from disk, under the sweep's rules: 409 `model_in_use` for the default model's set, a model a queued or running job needs, or one downloading. A job that later names it downloads it again.",
      access: "admin",
      modes: ["server"],
      params: { id: "The model id, from models.get." },
      ok: 200,
    },
    (c) => {
      const jobs = c.app.jobs?.();
      if (!jobs) throw new HttpError(404, "not_found", "models are deleted in server mode only");
      const id = c.params.id as string;
      return json(
        200,
        answer(() => jobs.deleteModel(id, caller(c).id)),
      );
    },
  );
}
