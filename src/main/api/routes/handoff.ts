/**
 * The hand-off and the import (docs/DESIGN.md sections 6.1, 6.2 and 8.2).
 *
 * - `POST /calls/{id}/export {to?}`: exports a finished call into `export.dir`, or into the
 *   absolute folder `to` names. `last` is accepted. Answers the file, whether anything was written,
 *   and whether it went beside a file the user edited.
 * - `POST /calls/{id}/hooks {stage?}`: runs the hooks again (`akou hooks run`), waiting for them.
 *   Without `stage`, every stage the call has reached. The export and the webhook are not re-run.
 * - `POST /import/hark-viewer {dirs[], workspace?}`: predecessor call folders become calls.
 */

import { isAbsolute } from "node:path";
import { HOOK_STAGES, type HookStage } from "../../config/schema.ts";
import { HttpError, json, outcome, type Router, readBody } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { callId } from "./common.ts";

export function handoffRoutes(r: Router<ApiApp>): void {
  r.add("POST", "/calls/:id/export", async (c) => {
    const b = await readBody<{ to?: string }>(c.req, { "to?": "string" });
    if (b.to !== undefined && !isAbsolute(b.to)) {
      throw new HttpError(400, "bad_field", "`to` must be an absolute folder");
    }
    const id = callId(c, { allowLast: true });
    const o = await c.app.exportCall(id, { to: b.to });
    if (!o.ok) return outcome(o);
    const { draft: _draft, ...rest } = o;
    return json(200, { ...rest, call: id });
  });

  r.add("POST", "/calls/:id/hooks", async (c) => {
    const b = await readBody<{ stage?: string }>(c.req, { "stage?": "string" });
    if (b.stage !== undefined && !HOOK_STAGES.includes(b.stage as HookStage)) {
      throw new HttpError(400, "bad_field", `stage must be one of ${HOOK_STAGES.join(", ")}`);
    }
    const id = callId(c);
    // Hooks may take minutes; the answer waits for them.
    c.timeout?.(0);
    const o = await c.app.runHooks(id, b.stage ? [b.stage as HookStage] : undefined);
    return o.ok ? json(200, { ...o, call: id }) : outcome(o);
  });

  r.add("POST", "/import/hark-viewer", async (c) => {
    const b = await readBody<{ dirs: string[]; workspace?: string }>(c.req, {
      dirs: "string[]",
      "workspace?": "string",
    });
    if (b.dirs.length === 0) throw new HttpError(400, "bad_field", "`dirs` is empty");
    const relative = b.dirs.find((d) => !isAbsolute(d));
    if (relative !== undefined) {
      throw new HttpError(400, "bad_field", `"${relative}" is not an absolute folder`);
    }
    c.timeout?.(0);
    const r = await c.app.importHarkViewer(b.dirs, { workspace: b.workspace });
    if (r.imported.length === 0) {
      return json(422, {
        error: "not_imported",
        message: r.skipped.map((s) => `${s.source}: ${s.reason}`).join("; "),
        ...r,
      });
    }
    return json(200, { ok: true, ...r });
  });
}
