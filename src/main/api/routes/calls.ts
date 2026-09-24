/**
 * Starting, listing, reading and controlling calls (docs/DESIGN.md sections 1.5 and 6.2).
 *
 * `POST /calls` answers `201` only once the helper reports `capturing`, which is before any model
 * loads; `409 already_recording {call}`, `403 permission`, `503 capture_failed {stage}` otherwise.
 * The live controls refuse `last` with 400; `restart` accepts it.
 */

import { formatWall } from "../../../core/log/clock.ts";
import type { CallController } from "../../call/call.ts";
import { LIVE_CONTROLS } from "../../call/manager.ts";
import { validateTerm } from "../../vocab/files.ts";
import { HttpError, intParam, json, outcome, type Router, readBody } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { callOf, resolveRef } from "./common.ts";

/** Header, parts, roster, health and final state of one call. */
export function callDetail(c: CallController, app: ApiApp, now: number) {
  const v = c.view;
  const call = v.call;
  const tz = call?.tz ?? "UTC";
  const s = app.manager.summary(c.id);
  return {
    id: c.id,
    title: call?.title ?? "",
    workspace: call?.workspace ?? "",
    template: call?.template ?? null,
    user: call?.user ?? "",
    tz,
    folder: c.dir,
    state: v.state,
    live: v.live,
    muted: v.muted,
    createdAt: call?.t ?? null,
    startedAt: v.parts()[0]?.wallStart ?? null,
    startedLocal: v.parts()[0] ? formatWall(v.parts()[0]?.wallStart as number, tz) : null,
    endedAt: s?.endedAt ?? null,
    endedReason: v.endedReason,
    failure: v.failure ? { stage: v.failure.stage, error: v.failure.error } : null,
    parts: v.parts().map((p) => ({
      part: p.part,
      file: p.file,
      wallStart: p.wallStart,
      mic: p.mic,
      call: p.call,
      capture: p.capture,
      ended: p.ended ? { reason: p.ended.reason, fileSeconds: p.ended.fileSeconds } : null,
      pauses: p.pauses.length,
      gaps: p.gaps.length,
      finalDone: p.finalDone,
    })),
    roster: v.roster(),
    health: v.health().map((h) => ({
      part: h.part,
      ch: h.ch,
      state: h.state,
      silentFor: h.silentFor,
      rebuilds: h.rebuilds,
      detail: h.detail,
    })),
    lag: v.asrLag ? { part: v.asrLag.part, seconds: v.asrLag.seconds } : null,
    final: {
      state: v.final.state,
      partsDone: v.final.partsDone,
      warning: v.final.done?.warning ?? null,
      error: v.final.failed?.error ?? null,
    },
    cursor: v.lastSeq,
    now,
  };
}

export function callRoutes(r: Router<ApiApp>): void {
  r.add("POST", "/calls", async (c) => {
    const b = await readBody<{
      workspace?: string;
      title?: string;
      template?: string;
      call?: string;
      mic?: string;
      vocab?: string[];
      withoutModels?: boolean;
    }>(c.req, {
      "workspace?": "string",
      "title?": "string",
      "template?": "string",
      "call?": "string",
      "mic?": "string",
      "vocab?": "string[]",
      "withoutModels?": "boolean",
    });
    const vocab = [];
    for (const term of b.vocab ?? []) {
      const bad = validateTerm(term);
      if (bad) throw new HttpError(400, "bad_term", `${JSON.stringify(term)}: ${bad}`, { term });
      vocab.push({ term });
    }
    const res = await c.app.start({
      workspace: b.workspace,
      title: b.title,
      template: b.template,
      call: b.call,
      mic: b.mic,
      vocab,
      by: c.by,
      withoutModels: b.withoutModels,
    });
    if (!res.ok) return outcome(res);
    return json(201, {
      call: res.call,
      folder: res.folder,
      part: res.part,
      firstAudioMs: res.startMs,
      url: `akou://call/${res.call}`,
    });
  });

  r.add("GET", "/calls", (c) => {
    const limit = intParam(c.url, "limit", 50, 1, 1000) as number;
    const workspace = c.url.searchParams.get("workspace");
    const failed = c.url.searchParams.get("failed");
    if (failed !== null && failed !== "" && failed !== "true" && failed !== "false") {
      throw new HttpError(400, "bad_param", "failed must be true or false");
    }
    const all = c.app.manager.calls({ failed: failed === "true" || failed === "" });
    const calls = all
      .filter((s) => workspace === null || s.workspace === workspace)
      .slice(0, limit)
      .map(({ dir, ...s }) => ({ ...s, folder: dir }));
    return json(200, { calls });
  });

  r.add("GET", "/calls/:id", async (c) => {
    const call = await callOf(c);
    return json(200, callDetail(call, c.app, c.app.now()));
  });

  for (const name of LIVE_CONTROLS) {
    r.add("POST", `/calls/:id/${name}`, async (c) => {
      await readBody(c.req, {});
      const id = resolveRef(c.app, c.params.id as string, { allowLast: false });
      const res = await c.app.manager[name](id);
      if (!res.ok) return outcome(res);
      const call = c.app.manager.controller(id);
      return json(200, { ok: true, call: id, state: call?.view.state ?? null });
    });
  }

  r.add("POST", "/calls/:id/restart", async (c) => {
    const b = await readBody<{ force?: boolean }>(c.req, { "force?": "boolean" });
    const id = resolveRef(c.app, c.params.id as string, { allowLast: true });
    const res = await c.app.manager.restart(id, { force: b.force });
    if (!res.ok) return outcome(res);
    return json(200, { ok: true, call: id, part: res.part });
  });
}
