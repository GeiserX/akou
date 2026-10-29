/**
 * The agent following a call answers the ask box (docs/DESIGN.md section 5.5): a question the
 * user typed is an `ask` event, which the agent's `akou events -f --type ask` watch prints in its
 * own conversation; the agent answers there and posts the same answer back with `akou_answer`,
 * `akou answer` or `POST /calls/{id}/asks/{ask}/answer`, which writes an `answer` event with
 * `by: agent:<client>`. The ask box waits a short time for it (`ask.agentWaitSeconds`) before
 * akou's own provider runs, and shows a later one under its own label.
 */

import { formatWall } from "../../core/log/clock.ts";
import type { Answer, LogEvent } from "../../core/log/events.ts";
import type { CallView, Line } from "../../core/log/fold.ts";

/** The longest answer an agent may post, characters. */
export const AGENT_ANSWER_MAX = 4000;

/** How long a user's ask counts as waiting for an agent in `akou_status` `unanswered`. */
export const UNANSWERED_MS = 10 * 60_000;

/**
 * The segment ids a text cites: `#l000031` written out, and `[15:41 Ben]` matched to `lines` of
 * that minute and speaker. Only ids of this call are kept, so an invented citation is dropped
 * (TRAPS "Hallucinated citation in enhanced notes").
 */
export function citesIn(
  text: string,
  lines: readonly Line[],
  tz: string,
  view: CallView,
): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/#([lf]\d{6,})\b/g)) {
    const id = m[1] as string;
    if (view.resolve(id)) out.add(id);
  }
  for (const m of text.matchAll(/\[(\d{1,2}:\d{2})(?::\d{2})?\s+([^\]]+?)\]/g)) {
    const hhmm = (m[1] as string).padStart(5, "0");
    const who = (m[2] as string).trim().toLowerCase();
    for (const l of lines) {
      if (formatWall(l.w0, tz, { seconds: false }) !== hhmm) continue;
      if (l.speaker.toLowerCase() === who || l.speaker.toLowerCase().startsWith(who)) out.add(l.id);
    }
  }
  return [...out];
}

/** An agent's answer to `ask`: an `answer` event whose `by` is `agent:*`. */
export function isAgentAnswer(e: LogEvent, ask: string): e is Answer & LogEvent {
  return (
    e.type === "answer" && e.ask === ask && typeof e.by === "string" && e.by.startsWith("agent:")
  );
}

/** `agent:claude-code` as the window and the CLI name it: `claude-code`. */
export function clientName(by: string): string {
  return by.replace(/^agent:/, "");
}

/** What `akou_status` lists for an agent with no push route: the user's asks no agent answered. */
export function unansweredAsks(
  view: CallView,
  now: number,
): { ask: string; q: string; t: number }[] {
  return view
    .qa()
    .filter(
      (x) =>
        x.ask.by === "user" &&
        now - x.ask.t <= UNANSWERED_MS &&
        !x.answers.some((a) => a.by?.startsWith("agent:")),
    )
    .map((x) => ({ ask: x.ask.id, q: x.ask.q, t: x.ask.t }));
}

/** How the ask box reaches the agents following the call, built by the route for one question. */
export interface AgentRoute {
  /** The clients listening now (`listeners.ts`). */
  listening: string[];
  /** How long to wait for one of them, ms; 0 never waits. */
  waitMs: number;
  /**
   * Starts watching for an agent's answer to `ask`. `answer` resolves with the first one (also
   * one already in the log), and never rejects; `stop` ends the watch.
   */
  watch(ask: string): { answer: Promise<Answer>; stop(): void };
}

/** An `AgentRoute` over the app's live feed of one call. */
export function agentRoute(o: {
  listening: string[];
  waitMs: number;
  subscribe: (fn: (e: LogEvent) => void) => () => void;
  view: () => CallView;
}): AgentRoute {
  return {
    listening: o.listening,
    waitMs: o.waitMs,
    watch(ask) {
      let unsubscribe = () => {};
      const answer = new Promise<Answer>((resolve) => {
        unsubscribe = o.subscribe((e) => {
          if (isAgentAnswer(e, ask)) resolve(e);
        });
        const had = o
          .view()
          .qa()
          .find((x) => x.ask.id === ask)
          ?.answers.find((a) => a.by?.startsWith("agent:"));
        if (had) resolve(had);
      });
      return { answer, stop: () => unsubscribe() };
    },
  };
}
