/**
 * Starting, listing, reading and controlling calls (docs/DESIGN.md sections 1.5 and 6.2).
 *
 * `POST /calls` answers `201` only once the helper reports `capturing`, which is before any model
 * loads; `409 already_recording {call, already_recording}`, `403 permission`, `503 capture_failed
 * {stage}` otherwise. With `attach`, a call already recording answers `200 {attached: true}` with
 * that call, so an agent's start is idempotent and it follows the call instead of stopping.
 * The live controls refuse `last` with 400; `restart` and a rename accept it. `PATCH /calls/{id}`
 * renames a call at any time, live or saved, with a `call.renamed` event.
 */

import { formatWall } from "../../../core/log/clock.ts";
import {
  isLiveCallSetting,
  isReviewModel,
  LIVE_SETTINGS,
  REVIEW_EVERY_MAX,
  REVIEW_EVERY_MIN,
  REVIEW_MODELS,
} from "../../asr/live-setups.ts";
import type { CallController } from "../../call/call.ts";
import { LIVE_CONTROLS } from "../../call/manager.ts";
import { validateTerm } from "../../vocab/files.ts";
import { HttpError, json, outcome, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { CALL_ID, callOf, resolveRef } from "./common.ts";

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

/** The longest title a rename takes. */
const MAX_TITLE = 200;

/** A new title: one line, trimmed; empty or too long is refused with 422 and changes nothing. */
export function checkTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title === "") {
    throw new HttpError(422, "bad_field", "the title is empty", { field: "title" });
  }
  if (title.length > MAX_TITLE) {
    throw new HttpError(422, "bad_field", `the title is over ${MAX_TITLE} characters`, {
      field: "title",
    });
  }
  return title;
}

const CONTROL_DOCS: Record<(typeof LIVE_CONTROLS)[number], string> = {
  stop: "Stop recording the live call. The final pass runs after it on its own.",
  pause: "Pause the live call: nothing is recorded until resume.",
  resume: "Resume a paused call.",
  mute: "Mute the microphone channel of the live call; the call channel keeps recording.",
  unmute: "Unmute the microphone channel.",
};

export function callRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/calls",
    {
      id: "calls.start",
      doc: "Start recording a call. `workspace` and `title` name it; `template` picks the notes template; `call` and `mic` pick the sources; `vocab` adds words for this call; `withoutModels` records before the speech models are downloaded; `live` sets this call's live model (`auto`, a model id, `parakeet`, `nemotron`) instead of `asr.live`; `review` its second pass (`none`, a model id, `qwen`, `parakeet`) instead of `asr.review.model`, and `reviewEvery` how often it reviews, in seconds, instead of `asr.review.everySeconds`. `live` `upgrade`, the old spelling, is `nemotron` with `review` `qwen`. One call at a time: a second start answers 409 with the live call under `already_recording` (id, title, workspace, startedAt, state). With `attach`, it answers 200 with that call and `attached: true` instead, and starts a call only when none records.",
      access: "admin",
      modes: ["app"],
      body: {
        "workspace?": "string",
        "title?": "string",
        "template?": "string",
        "call?": "string",
        "mic?": "string",
        "vocab?": "string[]",
        "withoutModels?": "boolean",
        "live?": "string",
        "review?": "string",
        "reviewEvery?": "number",
        "attach?": "boolean",
      },
      ok: 201,
      alsoOk: [200],
    },
    async (c) => {
      const b = await c.body<{
        workspace?: string;
        title?: string;
        template?: string;
        call?: string;
        mic?: string;
        vocab?: string[];
        withoutModels?: boolean;
        live?: unknown;
        review?: unknown;
        reviewEvery?: unknown;
        attach?: boolean;
      }>();
      if (b.live !== undefined && (typeof b.live !== "string" || !isLiveCallSetting(b.live))) {
        throw new HttpError(422, "bad_field", `live is one of ${LIVE_SETTINGS.join(", ")}`, {
          field: "live",
        });
      }
      if (b.review !== undefined && (typeof b.review !== "string" || !isReviewModel(b.review))) {
        throw new HttpError(422, "bad_field", `review is one of ${REVIEW_MODELS.join(", ")}`, {
          field: "review",
        });
      }
      const every = b.reviewEvery;
      if (
        every !== undefined &&
        (typeof every !== "number" ||
          !Number.isInteger(every) ||
          every < REVIEW_EVERY_MIN ||
          every > REVIEW_EVERY_MAX)
      ) {
        throw new HttpError(
          422,
          "bad_field",
          `reviewEvery is a whole number of seconds from ${REVIEW_EVERY_MIN} to ${REVIEW_EVERY_MAX}`,
          { field: "reviewEvery" },
        );
      }
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
        live: b.live as string | undefined,
        review: b.review as string | undefined,
        reviewEvery: every as number | undefined,
        attach: b.attach === true,
      });
      if (!res.ok) return outcome(res);
      if (res.attached) {
        const { id, ...brief } = res.attached;
        return json(200, {
          call: id,
          attached: true,
          ...brief,
          part: res.part,
          folder: res.folder,
          url: `akou://call/${id}`,
        });
      }
      return json(201, {
        call: res.call,
        folder: res.folder,
        part: res.part,
        firstAudioMs: res.startMs,
        url: `akou://call/${res.call}`,
      });
    },
  );

  r.add(
    "GET",
    "/calls",
    {
      id: "calls.list",
      doc: "The calls on disk, newest first, by metadata only: id, title, workspace, times and state. Never their content.",
      access: "admin",
      modes: ["app"],
      query: {
        limit: { type: "integer", min: 1, max: 1000, default: 50, doc: "At most this many calls." },
        workspace: { type: "string", doc: "Only the calls of this workspace." },
        failed: {
          type: "boolean",
          doc: "List only the calls whose start failed.",
        },
      },
      ok: 200,
    },
    (c) => {
      const limit = c.query.int("limit") as number;
      const workspace = c.query.raw("workspace");
      const failed = c.query.raw("failed");
      if (failed !== null && failed !== "" && failed !== "true" && failed !== "false") {
        throw new HttpError(400, "bad_param", "failed must be true or false");
      }
      const all = c.app.manager.calls({ failed: failed === "true" || failed === "" });
      const calls = all
        .filter((s) => workspace === null || s.workspace === workspace)
        .slice(0, limit)
        .map(({ dir, ...s }) => ({ ...s, folder: dir }));
      return json(200, { calls });
    },
  );

  r.add(
    "GET",
    "/calls/:id",
    {
      id: "calls.get",
      doc: "One call: its title, workspace, state, parts, speakers, health, the final pass and the log cursor.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      ok: 200,
    },
    async (c) => {
      const call = await callOf(c);
      return json(200, callDetail(call, c.app, c.app.now()));
    },
  );

  r.add(
    "PATCH",
    "/calls/:id",
    {
      id: "calls.rename",
      doc: "Rename a call, live or saved: `title` becomes the name every list, search, header and share shows from now on. The rename is a new `call.renamed` event; the folder keeps the name it was created with. Also takes `last`. An empty title answers 422 and the old name stays.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      body: { title: "string" },
      ok: 200,
    },
    async (c) => {
      const b = await c.body<{ title: string }>();
      const id = resolveRef(c.app, c.params.id as string, { allowLast: true });
      const title = checkTitle(b.title);
      const e = await c.app.write(id, (call) => ({
        type: "call.renamed",
        rev: call.view.titleRev + 1,
        title,
        by: c.by,
      }));
      return json(200, { ok: true, call: id, title, seq: e.seq });
    },
  );

  for (const name of LIVE_CONTROLS) {
    r.add(
      "POST",
      `/calls/:id/${name}`,
      {
        id: `calls.${name}`,
        doc: CONTROL_DOCS[name],
        access: "admin",
        modes: ["app"],
        params: { id: CALL_ID },
        body: {},
        ok: 200,
      },
      async (c) => {
        await c.body();
        const id = resolveRef(c.app, c.params.id as string, { allowLast: false });
        const res = await c.app.manager[name](id);
        if (!res.ok) return outcome(res);
        const call = c.app.manager.controller(id);
        return json(200, { ok: true, call: id, state: call?.view.state ?? null });
      },
    );
  }

  r.add(
    "POST",
    "/calls/:id/restart",
    {
      id: "calls.restart",
      doc: "Start a new part of a call: a live call rebuilds its capture, an ended call records a new part into the same folder and log. An ended call whose last audio is over an hour old needs `force`.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      body: { "force?": "boolean" },
      ok: 200,
    },
    async (c) => {
      const b = await c.body<{ force?: boolean }>();
      const id = resolveRef(c.app, c.params.id as string, { allowLast: true });
      const res = await c.app.manager.restart(id, { force: b.force });
      if (!res.ok) return outcome(res);
      return json(200, { ok: true, call: id, part: res.part });
    },
  );
}
