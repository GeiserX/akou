/**
 * The speech models' first-run download (docs/DESIGN.md section 3: "first run offers one explicit
 * download"), and one model at a time for the Models page and the CLI (docs/ux/SERVER.md SV-M6,
 * SV-U6), the same in the app and in server mode. The models are never bundled; the window's
 * download card, the Models page and `akou models pull` fetch them.
 *
 * - `GET /models`: `{state: missing|downloading|ready|failed, dir, bytes, total, file?, error?}`,
 *   and `models`: every catalog model with its kind, languages, state, size, last use, the date the
 *   sweep deletes it, whether it is the default's or in use, its accuracy and speed scores with the
 *   numbers behind them, this machine's measured speed, and the setting that makes it the default;
 *   in the app, `live`: the live setups (`asr.live`, live-setups.ts) with their bars and models,
 *   the one the next call runs and the one the live call runs, and `advice`: why a model does not
 *   suit this machine or the call's languages.
 * - `POST /models/pull`: starts the download of every missing file, each checked against its
 *   pinned SHA-256, and answers at once: `202` with the state while it runs, `200` when the models
 *   are already there. Progress is `GET /models`. `{"model": id}` fetches that one model under the
 *   size cap and the free-space check (SV-M2).
 * - `POST /models/cancel`: `{"model": id}` stops that model's download; the partial file stays, so
 *   the next pull resumes. 404 when it is not downloading.
 * - `DELETE /models/{id}`: deletes one model under the sweep's rules; 409 `model_in_use` for the
 *   default's set or a model in use.
 * - `POST /models/import`: `{"dir": path}` copies every catalog file whose SHA-256 matches from that
 *   folder on this machine, as `akou models import DIR` does.
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
      doc: "The speech models on disk: `missing`, `downloading` with bytes so far, `ready` or `failed`. `models` lists every catalog model with its kind (`speech`, `speakers`, `helper`), languages, state, size, last use, the date the sweep will delete it, whether it is the default's or in use, its accuracy and speed scores (0 to 100, with the measured number, its source and the formula, or `not_measured` with the reason), this machine's measured real-time factor, and the setting that makes it the default. In the app, `live` lists the live setups (`asr.live`): each with its accuracy, latency, cores and memory bars, the models it needs and their state, whether the next call runs it (`selected`) and whether the live call does (`running`), and why one is unavailable; and `live.advice`, one plain line by model id for a model that does not suit this machine or the call's languages (a live model that does not hear one of them, Qwen with no GPU or too little memory), whether or not it is downloaded. Advice only: the model can still be downloaded and chosen.",
      access: "admin",
      modes: ["app", "server"],
      ok: 200,
    },
    (c) => {
      const live = c.app.liveModels?.() ?? null;
      return json(200, {
        ...c.app.models(),
        models: c.app.modelRows?.() ?? [],
        ...(live ? { live } : {}),
      });
    },
  );
  r.add(
    "POST",
    "/models/pull",
    {
      id: "models.pull",
      doc: "Download every missing model file, each checked against its pinned SHA-256. Answers at once: 202 while the download runs, 200 when the models are already there. Follow it with models.get. `model` fetches that one catalog model, under `server.models_max_gb` and the free-space check.",
      access: "admin",
      modes: ["app", "server"],
      body: { "model?": "string" },
      ok: 202,
    },
    async (c) => {
      const b = await c.body<{ model?: unknown }>();
      if (b.model !== undefined) {
        if (typeof b.model !== "string" || b.model.trim() === "") {
          throw new HttpError(422, "bad_field", "model is a model id", { field: "model" });
        }
        const pull = c.app.pullModel;
        if (!pull) throw new HttpError(404, "not_found", "this akou pulls no single model");
        const id = b.model.trim();
        const m = answer(() => pull.call(c.app, id));
        return json(m.state === "ready" ? 200 : 202, m);
      }
      const s = c.app.pullModels();
      return json(s.state === "ready" ? 200 : 202, s);
    },
  );
  r.add(
    "POST",
    "/models/cancel",
    {
      id: "models.cancel",
      doc: "Stop one model's download, started by models.pull or by a job that waits on it. The files already verified and the partial file stay, so the next pull resumes; a job waiting on the model fails. 404 when the model is not downloading.",
      access: "admin",
      modes: ["app", "server"],
      body: { model: "string" },
      ok: 200,
    },
    async (c) => {
      const b = await c.body<{ model?: unknown }>();
      if (typeof b.model !== "string" || b.model.trim() === "") {
        throw new HttpError(422, "bad_field", "model is a model id", { field: "model" });
      }
      const id = b.model.trim();
      if (!c.app.cancelModel?.(id, caller(c).id)) {
        throw new HttpError(404, "not_found", `${id} is not downloading`, { model: id });
      }
      return json(200, { model: id, cancelled: true });
    },
  );
  r.add(
    "POST",
    "/models/import",
    {
      id: "models.import",
      doc: "Copy the speech models from a folder on this machine, for one that cannot download: every catalog file whose SHA-256 matches, from `<dir>/<model>/<file>` or `<dir>/<file>`, as `akou models import DIR` does. Answers the files copied and the files still missing. 404 when the folder does not exist.",
      access: "admin",
      modes: ["app", "server"],
      body: { dir: "string" },
      ok: 200,
    },
    async (c) => {
      const b = await c.body<{ dir?: unknown }>();
      if (typeof b.dir !== "string" || b.dir.trim() === "") {
        throw new HttpError(422, "bad_field", "dir is a folder on this machine", { field: "dir" });
      }
      const imp = c.app.importModels;
      if (!imp) throw new HttpError(404, "not_found", "this akou imports no models");
      return json(200, await imp.call(c.app, b.dir.trim()));
    },
  );
  r.add(
    "DELETE",
    "/models/:id",
    {
      id: "models.delete",
      doc: "Delete one model from disk, under the sweep's rules: 409 `model_in_use` for the default model's set, a model in use (a queued or running job, a worker, the recognizer), or one downloading. A job or a pull that later names it downloads it again.",
      access: "admin",
      modes: ["app", "server"],
      params: { id: "The model id, from models.get." },
      ok: 200,
    },
    (c) => {
      const del = c.app.deleteModel;
      if (!del) throw new HttpError(404, "not_found", "this akou deletes no single model");
      const id = c.params.id as string;
      return json(
        200,
        answer(() => del.call(c.app, id, caller(c).id)),
      );
    },
  );
}
