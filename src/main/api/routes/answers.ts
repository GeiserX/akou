/**
 * The agent following a call answers a question typed in the ask box (docs/DESIGN.md section 5.5):
 *
 * - `POST /calls/{id}/asks/{ask}/answer {text, model?}`: writes an `answer` event for that ask
 *   with `by: agent:<client>`, its citations resolved against the call's lines (one that names no
 *   line of the call is dropped). 404 for an ask the call does not have, 409 `already_answered`
 *   when this author already answered it, so each answer is written once per author. The reply
 *   says what else answered it (`others`): akou's provider, another agent, or only the excerpts.
 */

import type { Answer } from "../../../core/log/events.ts";
import { AGENT_ANSWER_MAX, citesIn } from "../../query/agent-answer.ts";
import { errorsOf } from "../errors.ts";
import { HttpError, json, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";
import { CALL_ID, CALL_REF_ERRORS, callId, WRITE_ERRORS } from "./common.ts";

export function answerRoutes(r: Router<ApiApp>): void {
  r.add(
    "POST",
    "/calls/:id/asks/:ask/answer",
    {
      id: "calls.answer",
      doc: "Answer a question the user typed in the ask box, as the agent following the call: the answer is written as an `answer` event with `by: agent:<client>` and shows in the ask box under the agent's name. Cite lines as `[HH:MM Name]` or `#l000031`; a citation that names no line of the call is dropped. 409 `already_answered` when you already answered this ask. `others` says what else answered it: akou's provider (`model`), another agent, or only the matching excerpts (`excerpts`).",
      access: "admin",
      modes: ["app"],
      params: { id: CALL_ID, ask: "The ask's id, `q0007`, from its `ask` event." },
      body: { text: "string", "model?": "string" },
      ok: 200,
      errors: errorsOf(CALL_REF_ERRORS, WRITE_ERRORS, {
        400: ["bad_field"],
        404: ["no_ask"],
        409: ["already_answered"],
      }),
    },
    async (c) => {
      const b = await c.body<{ text: string; model?: string }>();
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (text === "") throw new HttpError(400, "bad_field", "text is empty");
      if (text.length > AGENT_ANSWER_MAX) {
        throw new HttpError(400, "bad_field", `text is over ${AGENT_ANSWER_MAX} characters`);
      }
      if (b.model !== undefined && (typeof b.model !== "string" || b.model.length > 200)) {
        throw new HttpError(400, "bad_field", "model must be a string of at most 200 characters");
      }
      // Only an agent answers here: the user's own window asks, it never answers itself.
      if (!c.by.startsWith("agent:")) {
        throw new HttpError(400, "bad_field", "only an agent answers a question this way");
      }
      const id = callId(c, { allowLast: true });
      const askId = c.params.ask as string;
      const by = c.by;
      const ev = (await c.app.write(id, (call) => {
        const view = call.view;
        const qa = view.qa().find((x) => x.ask.id === askId);
        if (!qa) throw new HttpError(404, "no_ask", `the call has no ask ${askId}`);
        if (qa.answers.some((a) => a.by === by)) {
          throw new HttpError(409, "already_answered", `${by} already answered ${askId}`);
        }
        const tz = view.call?.tz ?? "UTC";
        return {
          type: "answer",
          ask: askId,
          text,
          cites: citesIn(text, view.lines("best"), tz, view),
          model: b.model?.trim() || by.replace(/^agent:/, ""),
          pack: { mode: "agent", tokens: 0 },
          by,
        };
      })) as Answer & { seq: number };
      const qa = (await c.app.call(id)).view.qa().find((x) => x.ask.id === askId);
      const others: { by: string; model: string; kind: "model" | "excerpts" }[] = (
        qa?.answers ?? []
      )
        .filter((a) => a.seq !== ev.seq)
        .map((a) => ({ by: a.by ?? "akou", model: a.model, kind: "model" }));
      if (others.length === 0 && c.app.listeners?.fallback(id, askId)) {
        others.push({ by: "akou", model: "", kind: "excerpts" });
      }
      return json(200, {
        call: id,
        answer: { ask: askId, by, cites: ev.cites, seq: ev.seq },
        others,
      });
    },
  );
}
