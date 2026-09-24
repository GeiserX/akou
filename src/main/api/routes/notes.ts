/**
 * Speakers, the notepad, agent memory and the memo (docs/DESIGN.md sections 5.1, 5.4, 5.5 and
 * 6.2). Every write is an event through the call's one writer; agent-authored notes and names carry
 * `by: agent:<client>` (TRAPS "Agent-authored notes indistinguishable from the user's"). A write on
 * a finished call reopens its log for the one event; `last` is refused on writes. Notepad lines
 * are built by `notes/notepad.ts`: an edit is `rev + 1`, a delete a `note.del`.
 */

import type { EventDraft } from "../../../core/log/events.ts";
import { NoteError, noteDeleteDraft, noteDraft, noteEditDraft } from "../../notes/notepad.ts";
import { memoDraft } from "../../query/memo.ts";
import { HttpError, json, type Router, readBody } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { callId, callOf, nextItemId } from "./common.ts";

const SPEAKER = /^(you|[cs]\d{1,4})$/;
const MAX_TEXT = 4000;

function checkSpeaker(spk: string): void {
  if (!SPEAKER.test(spk)) {
    throw new HttpError(400, "bad_speaker", `"${spk}" is not a speaker id (you, c2, ...)`);
  }
}

/** A notepad draft, with its refusals as HTTP errors. */
function notes(build: () => EventDraft): EventDraft {
  try {
    return build();
  } catch (err) {
    if (err instanceof NoteError) {
      throw new HttpError(err.code === "not_found" ? 404 : 400, err.code, err.message);
    }
    throw err;
  }
}

function checkText(text: string, what = "text"): string {
  const t = text.trim();
  if (t === "") throw new HttpError(400, "bad_field", `${what} is empty`);
  if (t.length > MAX_TEXT)
    throw new HttpError(400, "bad_field", `${what} is over ${MAX_TEXT} characters`);
  return t;
}

export function notesRoutes(r: Router<ApiApp>): void {
  r.add("POST", "/calls/:id/speakers", async (c) => {
    const b = await readBody<{ spk: string; name: string }>(c.req, {
      spk: "string",
      name: "string",
    });
    checkSpeaker(b.spk);
    const name = checkText(b.name, "name");
    if (name.length > 100) throw new HttpError(400, "bad_field", "name is over 100 characters");
    const id = callId(c);
    const e = await c.app.write(id, { type: "speaker.name", spk: b.spk, name, by: c.by });
    return json(200, { ok: true, call: id, spk: b.spk, name, seq: e.seq });
  });

  r.add("POST", "/calls/:id/speakers/merge", async (c) => {
    const b = await readBody<{ from: string; into: string }>(c.req, {
      from: "string",
      into: "string",
    });
    checkSpeaker(b.from);
    checkSpeaker(b.into);
    if (b.from === b.into)
      throw new HttpError(400, "bad_field", "a speaker cannot merge into itself");
    const id = callId(c);
    const e = await c.app.write(id, { type: "speaker.merge", from: b.from, into: b.into });
    return json(200, { ok: true, call: id, from: b.from, into: b.into, seq: e.seq });
  });

  r.add("POST", "/calls/:id/speakers/unmerge", async (c) => {
    const b = await readBody<{ spk: string; into?: string }>(c.req, {
      spk: "string",
      "into?": "string",
    });
    checkSpeaker(b.spk);
    const id = callId(c);
    const e = await c.app.write(id, (call) => {
      const into = b.into ?? call.view.roster().find((s) => s.spk === b.spk)?.mergedInto;
      if (!into) throw new HttpError(409, "not_merged", `${b.spk} is not merged into anyone`);
      return { type: "speaker.unmerge", from: b.spk, into };
    });
    return json(200, { ok: true, call: id, unmerge: e });
  });

  r.add("GET", "/calls/:id/notes", async (c) => {
    const call = await callOf(c);
    return json(200, { call: call.id, notes: call.view.notes() });
  });

  r.add("POST", "/calls/:id/notes", async (c) => {
    const b = await readBody<{ text: string; w?: number; afterSeq?: number }>(c.req, {
      text: "string",
      "w?": "integer",
      "afterSeq?": "integer",
    });
    const now = c.app.now();
    // The window sends the time of the first keystroke and the last line visible then: never in
    // the future, never before the call.
    if (b.w !== undefined && (b.w > now + 1000 || b.w < now - 24 * 3_600_000)) {
      throw new HttpError(400, "bad_field", "w must be the time the line was begun, before now");
    }
    if (b.afterSeq !== undefined && b.afterSeq < 0) {
      throw new HttpError(400, "bad_field", "afterSeq must be a log position");
    }
    const id = callId(c);
    const e = await c.app.write(id, (call) =>
      notes(() =>
        noteDraft(call.view, {
          text: b.text,
          by: c.by,
          now,
          w: b.w === undefined ? undefined : Math.min(b.w, now),
          afterSeq: b.afterSeq,
        }),
      ),
    );
    return json(201, { ok: true, call: id, note: e });
  });

  r.add("PATCH", "/calls/:id/notes/:nid", async (c) => {
    const b = await readBody<{ text: string }>(c.req, { text: "string" });
    const id = callId(c);
    const e = await c.app.write(id, (call) =>
      notes(() => noteEditDraft(call.view, c.params.nid as string, b.text, c.by)),
    );
    return json(200, { ok: true, call: id, note: e });
  });

  r.add("DELETE", "/calls/:id/notes/:nid", async (c) => {
    await readBody(c.req, {});
    const id = callId(c);
    const e = await c.app.write(id, (call) =>
      notes(() => noteDeleteDraft(call.view, c.params.nid as string, c.by)),
    );
    return json(200, { ok: true, call: id, deleted: e });
  });

  r.add("POST", "/calls/:id/remember", async (c) => {
    const b = await readBody<{ text: string }>(c.req, { text: "string" });
    const text = checkText(b.text);
    const id = callId(c);
    const e = await c.app.write(id, (call) => ({
      type: "remember",
      id: nextItemId("r", call.view.lastSeq),
      rev: 1,
      text,
      by: c.by,
    }));
    return json(201, { ok: true, call: id, remember: e });
  });

  r.add("DELETE", "/calls/:id/remember/:rid", async (c) => {
    await readBody(c.req, {});
    const id = callId(c);
    const e = await c.app.write(id, (call) => {
      const item = call.view.remembered().find((x) => x.id === c.params.rid);
      if (!item) throw new HttpError(404, "not_found", `no remembered line ${c.params.rid}`);
      return { type: "remember", id: item.id, rev: item.rev + 1, text: null, by: c.by };
    });
    return json(200, { ok: true, call: id, remember: e });
  });

  r.add("GET", "/calls/:id/memo", async (c) => {
    const call = await callOf(c);
    const m = call.view.memo;
    return json(200, {
      call: call.id,
      memo: m
        ? { body: m.body, rev: m.rev, coversSeq: m.coversSeq, by: m.by, model: m.model }
        : null,
      cursor: call.view.lastSeq,
    });
  });

  r.add("PUT", "/calls/:id/memo", async (c) => {
    const b = await readBody<{ text: string; coversSeq: number }>(c.req, {
      text: "string",
      coversSeq: "integer",
    });
    const id = callId(c);
    const e = await c.app.write(id, (call) => {
      const d = memoDraft(call.view, { text: b.text, coversSeq: b.coversSeq, by: c.by });
      if (!d.ok) throw new HttpError(400, "bad_memo", d.error);
      return d.draft;
    });
    return json(200, { ok: true, call: id, memo: e });
  });
}
