/**
 * The speech models' first-run download (docs/DESIGN.md section 3: "first run offers one explicit
 * download"). The models are never bundled; the window's download card and `akou models pull` are
 * the two ways to fetch them.
 *
 * - `GET /models`: `{state: missing|downloading|ready|failed, dir, bytes, total, file?, error?}`.
 * - `POST /models/pull`: starts the download of every missing file, each checked against its
 *   pinned SHA-256, and answers at once: `202` with the state while it runs, `200` when the models
 *   are already there. Progress is `GET /models`.
 *
 * Until the models are there, `POST /calls` answers `503 models_missing`.
 */

import { json, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";

export function modelRoutes(r: Router<ApiApp>): void {
  r.add("GET", "/models", (c) => json(200, c.app.models()));
  r.add("POST", "/models/pull", (c) => {
    const s = c.app.pullModels();
    return json(s.state === "ready" ? 200 : 202, s);
  });
}
