/**
 * `akou wait [CALL] --for final.done|enhanced|exported [--timeout 30m]` (PG-S5 in
 * docs/ux/PROGRAMMABILITY.md section 4): blocks until a call reaches a stage after it ends, so a
 * script can run `akou stop`, then `akou wait --for final.done`, then `akou show last`, each only
 * when the one before succeeded.
 *
 * It reads the call's log and follows it by long poll, the same stream `akou tail -f` uses, so it
 * never polls call folders and sees a stage the moment its event is written. The stage is reached
 * when its event is in the log and nothing since has made it stale: `final.done` (a later
 * `final.started` or a new part means the pass runs again, so it waits for that one), `enhanced`
 * or `export.done` (a later `final.done` or a new part changes the transcript they were made
 * from, so it waits for the next). Exit codes:
 *
 *   0 the stage is reached (at once if it already was) · 69 the final pass cannot run on this call
 *   (`final.failed {step: unavailable}`: no readable audio or no models) · 70 it failed:
 *   `final.failed`, or a call that never recorded (`call.failed`) · 124 the timeout passed first,
 *   like `timeout(1)`
 *
 * `enhanced` and `exported` have no failure event: notes are written when someone asks for them
 * or the provider re-enhances, and the export needs `export.dir`. Waiting for one that never comes
 * ends at the timeout.
 */

import type { Parsed } from "../args.ts";
import { duration, str } from "../args.ts";
import { EXIT } from "../client.ts";
import { api, type Body, type Command, type Ctx, enc, finish } from "../context.ts";
import { usage } from "./calls.ts";

export const WAIT_STAGES = ["final.done", "enhanced", "exported"] as const;
export type WaitStage = (typeof WAIT_STAGES)[number];

/** The default wait: long enough for the final pass on an hour-long call. */
export const WAIT_TIMEOUT_S = 30 * 60;
/** The API's longest long poll. */
const POLL_S = 25;
/** What Ctrl-C returns, as a shell reports a process ended by SIGINT. */
const INTERRUPTED = 130;

export type StageState = { state: "pending" } | { state: "done" | "failed"; event: Body };

/** Where a stage stands after `events`, given where it stood before them. */
export function stageAfter(
  stage: WaitStage,
  before: StageState,
  events: readonly Body[],
): StageState {
  let s = before;
  for (const e of events) {
    if (e.type === "call.failed") s = { state: "failed", event: e };
    // New audio makes every stage stale.
    else if (e.type === "part.started") s = { state: "pending" };
    else if (stage === "final.done") {
      if (e.type === "final.started") s = { state: "pending" };
      else if (e.type === "final.done") s = { state: "done", event: e };
      else if (e.type === "final.failed") s = { state: "failed", event: e };
    } else if (e.type === "final.done") s = { state: "pending" };
    else if (stage === "enhanced" && e.type === "enhanced") s = { state: "done", event: e };
    else if (stage === "exported" && e.type === "export.done") s = { state: "done", event: e };
  }
  return s;
}

function failure(e: Body): string {
  if (e.type === "final.failed" && e.step === "unavailable") return `no final pass: ${e.error}`;
  if (e.type === "final.failed") return `the final pass failed at ${e.step}: ${e.error}`;
  if (e.type === "call.failed") return `the call never recorded (${e.stage}: ${e.error})`;
  return e.type;
}

async function run(ctx: Ctx, p: Parsed): Promise<number> {
  const stage = str(p, "for");
  if (stage === undefined) return usage(ctx, "wait needs --for final.done, enhanced or exported");
  if (!(WAIT_STAGES as readonly string[]).includes(stage)) {
    return usage(ctx, `--for is one of ${WAIT_STAGES.join(", ")}`);
  }
  const timeoutS = duration(p, "timeout") ?? WAIT_TIMEOUT_S;
  const deadline = Date.now() + timeoutS * 1000;
  const ref = p.positional[0] ?? "last";
  const head = await api(ctx, "GET", `/calls/${enc(ref)}`);
  if (head.status !== 200) return finish(ctx, head, () => "");
  const id = head.body.id as string;

  const report = (state: string, code: number, line: string, event?: Body): number => {
    if (ctx.json)
      ctx.io.out(JSON.stringify({ call: id, stage, state, ...(event ? { event } : {}) }));
    else if (code === EXIT.ok) ctx.io.out(line);
    else ctx.io.err(`akou wait: ${line}`);
    return code;
  };

  let s: StageState = { state: "pending" };
  let cursor = 0;
  let wait = 0;
  while (true) {
    if (ctx.io.signal?.aborted) return INTERRUPTED;
    const r = await api(ctx, "GET", `/calls/${enc(id)}/events`, {
      query: { after: cursor, wait },
      timeoutMs: (wait + 15) * 1000,
      signal: ctx.io.signal,
    }).catch((err) => {
      if (ctx.io.signal?.aborted) return null;
      throw err;
    });
    if (r === null) return INTERRUPTED;
    if (r.status !== 200) return finish(ctx, r, () => "");
    s = stageAfter(stage as WaitStage, s, r.body.events);
    cursor = r.body.cursor;
    if (s.state === "done") return report("done", EXIT.ok, `${id}: ${stage}`, s.event);
    if (s.state === "failed") {
      const code = s.event.step === "unavailable" ? EXIT.unavailable : EXIT.software;
      return report("failed", code, failure(s.event), s.event);
    }
    const left = Math.ceil((deadline - Date.now()) / 1000);
    if (left <= 0) {
      return report(
        "timeout",
        EXIT.timeout,
        `no ${stage} for ${id} within ${str(p, "timeout") ?? "30m"}`,
      );
    }
    wait = Math.min(POLL_S, left);
  }
}

export const waitCommand: Command = {
  name: "wait",
  summary:
    "Block until a call reaches final.done, enhanced or exported (69 unavailable, 70 failed, 124 timeout)",
  usage: "akou wait [CALL] --for final.done|enhanced|exported [--timeout 30m] [--json]",
  flags: { for: { type: "string" }, timeout: { type: "string" } },
  run,
};
