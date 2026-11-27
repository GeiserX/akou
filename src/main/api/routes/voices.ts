/**
 * Voices across calls from the API (docs/DESIGN.md section 6.2): list the people akou knows by
 * voice, rename one, forget one, what one call taught, or everyone, and refuse a name akou found
 * by voice on a speaker of a call.
 *
 * - App mode only: server mode keeps no voices and has none of these routes [VO-8].
 * - Only the user on this computer: the window and the app's own token. An `ak_` key, even an
 *   admin one on the network listener, gets 403 `local_only` [VO-8].
 * - With `voices.enabled` off, every route answers 409 `voices_off`; the file stays as it is.
 * - Never a voiceprint: a person is a name, the calls that taught them, seconds of speech and the
 *   last time heard.
 *
 * A refusal is a `speaker.voice {status: "refused"}` event on the call, by the caller, for the
 * name akou shows by voice on that speaker. Confirming is naming the speaker with that same name
 * (`POST /calls/{id}/speakers`), one event.
 */

import { cleanName, MAX_NAME_LENGTH, type VoiceStore, VoicesError } from "../../voices/store.ts";
import { isLocalUser } from "../caller.ts";
import { errorsOf, type RouteErrors } from "../errors.ts";
import { HttpError, json, type RouteContext, type RouteDoc, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { CALL_ID, callId, LIVE_REF_ERRORS, WRITE_ERRORS } from "./common.ts";

/** What every route of this file refuses before it does anything. */
const DOOR_ERRORS: RouteErrors = { 403: ["local_only"], 409: ["voices_off"] };

/** A route of this file: app mode, admin, and the door's refusals. */
function doc(d: Omit<RouteDoc, "access" | "modes">): RouteDoc {
  return { access: "admin", modes: ["app"], ...d, errors: errorsOf(DOOR_ERRORS, d.errors) };
}

/**
 * The voices file when the caller may use it: 409 `voices_off` in server mode or with the setting
 * off, 403 `local_only` for anyone but the user on this computer.
 */
function door(c: RouteContext<ApiApp>): VoiceStore {
  const off = () =>
    new HttpError(409, "voices_off", "voice recognition is off (voices.enabled)", {
      setting: "voices.enabled",
    });
  if ((c.app.mode?.() ?? "app") !== "app") throw off();
  if (!isLocalUser(c)) {
    throw new HttpError(
      403,
      "local_only",
      "voices are reached only from this computer: the window or the akou CLI",
    );
  }
  const store = c.app.voiceStore?.() ?? null;
  if (!store || c.app.config().settings["voices.enabled"] !== true) throw off();
  return store;
}

/** A store edit, with a file akou cannot read answered as 409 `voices_file_invalid`. */
async function edit<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof VoicesError) throw new HttpError(409, "voices_file_invalid", err.message);
    throw err;
  }
}

/** A person's name from the body, or 400 `bad_field`. */
function nameField(v: unknown, field: string): string {
  const n = cleanName(v);
  if (n === null) {
    throw new HttpError(
      400,
      "bad_field",
      `${field} is a name of 1 to ${MAX_NAME_LENGTH} characters, not blank`,
      { field },
    );
  }
  return n;
}

const SPEAKER = /^c\d{1,4}$/;

/** Seconds as shown: one decimal. */
const secs = (s: number): number => Math.round(s * 10) / 10;

export function voiceRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/voices",
    doc({
      id: "voices.list",
      doc: "The people akou recognises by voice, each with the calls that taught their voice (newest first), the seconds of speech it learned from, and when it last heard them. Never a voiceprint: those stay in voices.yaml on this computer.",
      ok: 200,
      reply: {
        type: "object",
        properties: {
          voices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                calls: { type: "array", items: { type: "string" } },
                secs: { type: "number" },
                lastSeen: { type: "string" },
              },
            },
          },
        },
      },
      errors: { 409: ["voices_file_invalid"] },
    }),
    async (c) => {
      const store = door(c);
      const people = await edit(() => store.list());
      return json(200, {
        voices: people.map((p) => ({
          name: p.name,
          calls: p.calls,
          secs: secs(p.secs),
          lastSeen: p.lastSeen,
        })),
      });
    },
  );

  r.add(
    "POST",
    "/voices/rename",
    doc({
      id: "voices.rename",
      doc: "Rename a person akou recognises by voice, for every later call: `from` is the name now, `to` the new one. Renaming onto a name akou already knows makes the two one person. A name already shown in a call stays as it is there.",
      body: { from: "string", to: "string" },
      ok: 200,
      errors: { 400: ["bad_field"], 404: ["not_found"], 409: ["voices_file_invalid"] },
    }),
    async (c) => {
      const store = door(c);
      const b = await c.body<{ from: string; to: string }>();
      const from = nameField(b.from, "from");
      const to = nameField(b.to, "to");
      if (!(await edit(() => store.rename(from, to)))) {
        throw new HttpError(404, "not_found", "akou knows no voice by that name", { name: from });
      }
      return json(200, { ok: true, from, to });
    },
  );

  r.add(
    "POST",
    "/voices/forget",
    doc({
      id: "voices.forget",
      doc: "Forget voices: `name` forgets that person; `name` with `call` forgets only what that call taught about them; `call` alone forgets what that call taught about anyone; `all: true` forgets everyone and deletes voices.yaml. The voiceprints leave the file at once and nothing keeps a copy. Names already shown in calls stay as they are there.",
      body: { "name?": "string", "call?": "string", "all?": "boolean" },
      ok: 200,
      errors: { 400: ["bad_field"], 404: ["not_found"], 409: ["voices_file_invalid"] },
    }),
    async (c) => {
      const store = door(c);
      const b = await c.body<{ name?: string; call?: string; all?: boolean }>();
      if (b.all === true) {
        if (b.name !== undefined || b.call !== undefined) {
          throw new HttpError(
            400,
            "bad_field",
            "all forgets everyone; send it without name or call",
            {
              field: "all",
            },
          );
        }
        await edit(() => store.forgetAll());
        return json(200, { ok: true, all: true });
      }
      const name = b.name === undefined ? undefined : nameField(b.name, "name");
      const call = b.call === undefined ? undefined : b.call.trim();
      if (call === "") throw new HttpError(400, "bad_field", "call is empty", { field: "call" });
      if (name === undefined && call === undefined) {
        throw new HttpError(400, "bad_field", "name a person, a call, or send all: true", {
          field: "name",
        });
      }
      const gone =
        name === undefined
          ? (await edit(() => store.forgetCall(call as string))) > 0
          : call === undefined
            ? await edit(() => store.forget(name))
            : (await edit(() => store.forgetPersonCall(name, call))) > 0;
      if (!gone) {
        const what =
          name === undefined
            ? "no voice was learned from that call"
            : call === undefined
              ? "akou knows no voice by that name"
              : "that call taught nothing about that voice";
        throw new HttpError(404, "not_found", what, name !== undefined ? { name } : {});
      }
      return json(200, {
        ok: true,
        ...(name !== undefined ? { name } : {}),
        ...(call !== undefined ? { call } : {}),
      });
    },
  );

  r.add(
    "POST",
    "/calls/:id/speakers/refuse",
    doc({
      id: "speakers.refuse",
      doc: "Refuse the name akou found by voice for a speaker of the call (`spk`, such as `c2`): the speaker shows its own label again, and akou does not offer that name for it again in this call. To confirm the name instead, name the speaker with it (`POST /calls/{id}/speakers`).",
      params: { id: CALL_ID },
      body: { spk: "string" },
      ok: 200,
      errors: errorsOf(LIVE_REF_ERRORS, WRITE_ERRORS, {
        400: ["bad_speaker"],
        409: ["no_voice"],
      }),
    }),
    async (c) => {
      door(c);
      const b = await c.body<{ spk: string }>();
      if (!SPEAKER.test(b.spk)) {
        throw new HttpError(
          400,
          "bad_speaker",
          `"${b.spk}" is not a speaker id of the call (c2, ...)`,
        );
      }
      const id = callId(c);
      const e = await c.app.write(id, (call) => {
        const spk = call.view.resolveSpeaker(b.spk);
        const voice = call.view.voiceFor(spk);
        if (!voice) {
          throw new HttpError(409, "no_voice", `${b.spk} has no name found by voice to refuse`, {
            spk: b.spk,
          });
        }
        return { type: "speaker.voice", spk, name: voice.name, status: "refused", by: c.by };
      });
      const name = (e as { name: string }).name;
      return json(200, { ok: true, call: id, spk: b.spk, name, seq: e.seq });
    },
  );
}
