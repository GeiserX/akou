/**
 * Starting, listing, reading and controlling calls (docs/DESIGN.md sections 1.5 and 6.2).
 *
 * `POST /calls` answers `201` only once the helper reports `capturing`, which is before any model
 * loads; `409 already_recording {call, already_recording}`, `403 permission`, `503 capture_failed
 * {stage}` otherwise. With `attach`, a call already recording answers `200 {attached: true}` with
 * that call, so an agent's start is idempotent and it follows the call instead of stopping.
 * The live controls refuse `last` with 400; `restart` and a rename accept it. `PATCH /calls/{id}`
 * renames a call at any time, live or saved, with a `call.renamed` event, and moves a finished one
 * to another workspace with `call.moved`. `DELETE /calls/{id}` moves a finished call to the trash
 * and `POST /calls/{id}/restore` brings it back (PROGRAMMABILITY PG-A4).
 */

import { formatWall } from "../../../core/log/clock.ts";
import { FINAL_MODELS, finalChoiceValue, isFinalChoice } from "../../asr/final-model.ts";
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
import { parseCallMode } from "../../capture/call-mode.ts";
import { validateTerm } from "../../vocab/files.ts";
import { type ErrorCode, errorsOf } from "../errors.ts";
import { HttpError, json, outcome, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import {
  CALL_ID,
  CALL_REF_ERRORS,
  callOf,
  LIVE_REF_ERRORS,
  resolveRef,
  WRITE_ERRORS,
} from "./common.ts";

/**
 * Where an indexer's page starts (PG-A6): after a `cursor` (`<updatedAt>.<id>`), else after
 * `updatedAfter` (milliseconds or an ISO date), else null for the plain list.
 */
function changedSince(
  cursor: string | null,
  updatedAfter: string | null,
): { t: number; id: string } | null {
  if (cursor !== null) {
    const m = /^(\d{1,16})\.(\S{1,64})$/.exec(cursor);
    if (!m) throw new HttpError(400, "bad_param", "cursor is not one akou gave");
    return { t: Number(m[1]), id: m[2] as string };
  }
  if (updatedAfter === null) return null;
  const t = /^\d{1,16}$/.test(updatedAfter) ? Number(updatedAfter) : Date.parse(updatedAfter);
  if (!Number.isFinite(t)) {
    throw new HttpError(400, "bad_param", "updatedAfter is milliseconds or an ISO 8601 date");
  }
  // From this time on: every call id (a ULID, digits and capitals) sorts after "0".
  return { t, id: "0" };
}

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
      // The recognizer of the last pass, and while one runs, how far it is.
      model: v.final.model ?? null,
      progress: app.finalProgress?.(c.id) ?? null,
    },
    cursor: v.lastSeq,
    now,
  };
}

/** The longest title a rename takes. */
const MAX_TITLE = 200;

/**
 * A new title: one line, trimmed; empty, too long, or holding a control character (ESC, NUL), which
 * the CLI would print raw on a terminal, is refused with 422 and changes nothing.
 */
export function checkTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title === "") {
    throw new HttpError(422, "bad_field", "the title is empty", { field: "title" });
  }
  if (/\p{Cc}/u.test(title)) {
    throw new HttpError(422, "bad_field", "the title holds a control character", {
      field: "title",
    });
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

/** What each live control refuses besides resolving the call: the call is not in a state for it. */
const CONTROL_REFUSALS: Record<(typeof LIVE_CONTROLS)[number], ErrorCode[]> = {
  stop: ["not_live"],
  pause: ["not_live", "not_recording"],
  resume: ["not_live", "not_paused"],
  mute: ["not_live", "not_recording"],
  unmute: ["not_live", "not_recording"],
};

export function callRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/calls",
    {
      id: "calls.start",
      doc: "Start recording a call. `workspace` and `title` name it; `template` picks the notes template; `call` (`system`, the whole computer; `none`; or `app:<id>[,<id>]`; anything else is refused with 422) and `mic` pick the sources; `vocab` adds words for this call; `withoutModels` records before the speech models are downloaded; `live` sets this call's live model (`auto`, a model id, `parakeet`, `nemotron`) instead of `asr.live`; `review` its second pass (`none`, a model id, `qwen`, `parakeet`) instead of `asr.review.model`, and `reviewEvery` how often it reviews, in seconds, instead of `asr.review.everySeconds`; `final` the model of its final pass (`auto`, a model id, `qwen`, `parakeet`, or `fusion` for the `fusion` preset's engines fused) instead of `asr.final.model`, kept in the call's log so a pass after a restart runs it too. `live` `upgrade`, the old spelling, is `nemotron` with `review` `qwen`. One call at a time: a second start answers 409 with the live call under `already_recording` (id, title, workspace, startedAt, state, and callMode, what it records as its call side). With `attach`, it answers 200 with that call and `attached: true` instead, and starts a call only when none records.",
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
        "final?": "string",
        "attach?": "boolean",
      },
      ok: 201,
      alsoOk: [200],
      reply: {
        type: "object",
        properties: {
          call: { type: "string" },
          folder: { type: "string" },
          part: { type: "integer" },
          url: {
            type: ["string", "null"],
            description:
              "Always null: kept because `/v1` never removes a field. `POST /window {call}` shows the window on the call.",
          },
        },
        required: ["call", "folder", "part", "url"],
      },
      errors: {
        400: ["bad_term", "bad_workspace"],
        403: ["permission"],
        409: ["already_recording", "cancelled"],
        422: ["bad_field"],
        503: ["capture_failed", "models_missing", "quitting"],
      },
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
        final?: unknown;
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
      const scope = b.call === undefined ? null : parseCallMode(b.call);
      if (scope && !scope.ok) {
        throw new HttpError(422, "bad_field", `call ${scope.why}`, { field: "call" });
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
      if (b.final !== undefined && (typeof b.final !== "string" || !isFinalChoice(b.final))) {
        throw new HttpError(
          422,
          "bad_field",
          `final is one of ${FINAL_MODELS.join(", ")}, qwen or parakeet`,
          { field: "final" },
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
        ...(b.final === undefined ? {} : { final: finalChoiceValue(b.final as string) }),
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
          url: null,
        });
      }
      return json(201, {
        call: res.call,
        folder: res.folder,
        part: res.part,
        firstAudioMs: res.startMs,
        // Always null (PG-U1): nothing registers `akou://`, and `/v1` never drops a field. A
        // client that wants the window on this call asks `POST /window {call}`.
        url: null,
      });
    },
  );

  r.add(
    "GET",
    "/calls",
    {
      id: "calls.list",
      doc: "The calls on disk, newest first, by metadata only: id, title, workspace, times and state. Never their content. `updatedAt` is when the call's transcript, notes, names, title, workspace or vocabulary corrections last changed. With `updatedAfter` or `cursor`, the list is for an indexer instead: only the calls changed after that point, oldest change first, with the `cursor` to keep for the next request and `more` when a page was left out.",
      access: "admin",
      modes: ["app"],
      query: {
        limit: { type: "integer", min: 1, max: 1000, default: 50, doc: "At most this many calls." },
        workspace: { type: "string", doc: "Only the calls of this workspace." },
        failed: {
          type: "boolean",
          doc: "List only the calls whose start failed.",
        },
        updatedAfter: {
          type: "string",
          doc: "Only the calls changed after this time: milliseconds since 1970 or an ISO 8601 date.",
        },
        cursor: {
          type: "string",
          doc: "The `cursor` of an earlier answer: only the calls changed since it. Wins over `updatedAfter`.",
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
      const all = c.app.manager
        .calls({ failed: failed === "true" || failed === "" })
        .filter((s) => workspace === null || s.workspace === workspace);
      const out = (list: typeof all) => list.map(({ dir, ...s }) => ({ ...s, folder: dir }));
      const after = changedSince(c.query.raw("cursor"), c.query.raw("updatedAfter"));
      if (after === null) return json(200, { calls: out(all.slice(0, limit)) });
      // Oldest change first, and the id breaks a tie, so a cursor names one place in the order.
      const newer = all
        .filter((s) => s.updatedAt > after.t || (s.updatedAt === after.t && s.id > after.id))
        .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const page = newer.slice(0, limit);
      const last = page.at(-1);
      return json(200, {
        calls: out(page),
        cursor: last ? `${last.updatedAt}.${last.id}` : `${after.t}.${after.id}`,
        more: newer.length > page.length,
      });
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
      errors: CALL_REF_ERRORS,
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
      doc: "Rename a call, live or saved, or move a finished one to another workspace. `title` becomes the name every list, search, header and share shows from now on: a new `call.renamed` event, and an export already written takes the new name. `workspace` moves the call's folder into that workspace's folder and writes `call.moved`; a call that is recording answers 409 `live_call`. Also takes `last`. An empty title answers 422 and the old name stays.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      body: { "title?": "string", "workspace?": "string" },
      ok: 200,
      errors: errorsOf(CALL_REF_ERRORS, WRITE_ERRORS, {
        400: ["bad_workspace"],
        409: ["busy", "folder_taken", "live_call"],
        422: ["bad_field"],
      }),
    },
    async (c) => {
      const b = await c.body<{ title?: string; workspace?: string }>();
      if (b.title === undefined && b.workspace === undefined) {
        throw new HttpError(422, "bad_field", "name a new `title`, a `workspace`, or both");
      }
      const id = resolveRef(c.app, c.params.id as string, { allowLast: true });
      const title = b.title === undefined ? undefined : checkTitle(b.title);
      let moved: { workspace: string; seq: number | null } | null = null;
      if (b.workspace !== undefined) {
        const r = await c.app.moveCall(id, b.workspace, c.by);
        if (!r.ok) return outcome(r);
        moved = { workspace: r.workspace, seq: r.seq };
      }
      let seq = moved?.seq ?? null;
      if (title !== undefined) {
        const e = await c.app.write(id, (call) => ({
          type: "call.renamed",
          rev: call.view.titleRev + 1,
          title,
          by: c.by,
        }));
        seq = e.seq;
      }
      const v = (await c.app.call(id)).view;
      return json(200, {
        ok: true,
        call: id,
        title: v.call?.title ?? title ?? "",
        workspace: v.call?.workspace ?? moved?.workspace ?? "",
        seq,
      });
    },
  );

  r.add(
    "PATCH",
    "/calls/:id/segments/:sid",
    {
      id: "segments.edit",
      doc: "Say who spoke one transcript line: `spk` is a speaker id from the call (`c2`), or a new `c<N>` for a voice the call missed. A new revision of the line, `by` the caller; the text and its raw form stay, and every earlier revision stays in the log. A line from your microphone is always you (422). The words of a line are fixed with `POST /calls/{id}/fix`.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID, sid: "The line's segment id (`l000031`)." },
      body: { spk: "string" },
      ok: 200,
      errors: errorsOf(CALL_REF_ERRORS, WRITE_ERRORS, { 422: ["bad_field", "mic_line"] }),
    },
    async (c) => {
      const b = await c.body<{ spk: string }>();
      const id = resolveRef(c.app, c.params.id as string, { allowLast: true });
      const sid = c.params.sid as string;
      const spk = b.spk.trim();
      const e = await c.app.write(id, (call) => {
        const v = call.view;
        const l = v.visibleIn(sid, "best") ? v.resolve(sid) : null;
        if (!l || l.retracted) throw new HttpError(404, "not_found", `no line ${sid}`);
        if (l.ch === "mic") {
          throw new HttpError(422, "mic_line", "a line from your microphone is always you", {
            line: sid,
          });
        }
        const known = v.roster().some((r) => r.spk === spk && spk !== "you");
        if (!known && !/^c\d{1,4}$/.test(spk)) {
          throw new HttpError(422, "bad_field", `spk "${spk}" is no speaker of this call`, {
            field: "spk",
          });
        }
        return { type: "seg", id: l.id, rev: l.rev + 1, spk, by: c.by };
      });
      const line = (await c.app.call(id)).view.resolve(sid);
      return json(200, {
        ok: true,
        call: id,
        line: sid,
        rev: line?.rev ?? null,
        spk: line?.spk ?? spk,
        speaker: line?.speaker ?? null,
        seq: e.seq,
      });
    },
  );

  r.add(
    "DELETE",
    "/calls/:id",
    {
      id: "calls.delete",
      doc: "Move a finished call to the trash: its folder goes to `.trash/` under the recordings folder, no list shows it, and it is deleted for good after 30 days. A call that is recording answers 409 `live_call`. Exports already written are the user's and stay. `POST /calls/{id}/restore` brings it back.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      ok: 200,
      errors: errorsOf(CALL_REF_ERRORS, { 409: ["busy", "folder_taken", "live_call"] }),
    },
    async (c) => {
      const id = resolveRef(c.app, c.params.id as string, { allowLast: true });
      const r = await c.app.trashCall(id);
      return r.ok ? json(200, { ok: true, call: id, trashed: true }) : outcome(r);
    },
  );

  r.add(
    "POST",
    "/calls/:id/restore",
    {
      id: "calls.restore",
      doc: "Bring a trashed call back to the workspace it was in, exactly as it was. The id is the call's own; `live` and `last` name no trashed call.",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID },
      body: {},
      ok: 200,
      errors: { 404: ["not_found"], 409: ["folder_taken", "not_trashed"] },
    },
    async (c) => {
      await c.body();
      const id = c.params.id as string;
      const r = await c.app.restoreCall(id);
      return r.ok ? json(200, { ok: true, call: id, workspace: r.workspace }) : outcome(r);
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
        errors: errorsOf(LIVE_REF_ERRORS, { 409: CONTROL_REFUSALS[name] }),
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
      errors: errorsOf(CALL_REF_ERRORS, {
        403: ["permission"],
        409: [
          "already_recording",
          "cancelled",
          "locked",
          "not_restartable",
          "restart_in_progress",
          "stale_restart",
        ],
        503: ["capture_failed"],
      }),
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
