/**
 * `akou jobs list` (docs/ux/SERVER.md SV-J8, docs/research/service-interface.md SI-1): the file
 * jobs, newest first as akou lists them: every job of the desktop app on this machine (`akou
 * transcribe` keeps them there), or, with `AKOU_URL` set, the jobs a remote server's key can see.
 * A thin client of `GET /v1/jobs`.
 */

import { str } from "../args.ts";
import { EXIT } from "../client.ts";
import { api, type Body, type Command, finish, wall } from "../context.ts";
import { usage } from "./calls.ts";

const STATES = ["queued", "running", "done", "failed", "cancelled"];

/** akou's ISO time as local date and wall-clock time, as `akou calls` shows a call's. */
function when(iso: unknown): string {
  const ms = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? "" : `${new Date(ms).toLocaleDateString("en-CA")} ${wall(ms)}`;
}

export const jobsCommand: Command = {
  name: "jobs",
  summary: "The file transcription jobs on this akou, or those your key sees on a server",
  usage: `akou jobs list [--status ${STATES.join("|")}]   [--json]`,
  flags: {
    status: {
      type: "string",
      value: "STATE",
      desc: `only the jobs in this state: ${STATES.join(", ")}`,
    },
  },
  examples: ["akou jobs list", "akou jobs list --status failed --json"],
  run: async (ctx, p) => {
    const [sub, ...rest] = p.positional;
    if (sub !== "list" || rest.length > 0) return usage(ctx, "jobs needs list");
    const status = str(p, "status");
    if (status !== undefined && !STATES.includes(status)) {
      return usage(ctx, `--status is one of ${STATES.join(", ")}`);
    }
    const r = await api(ctx, "GET", "/jobs", { query: { status } });
    // An akou with no job routes (one older than file jobs in the desktop app): not a usage error.
    if (r.status === 404 && !ctx.io.env.AKOU_URL?.trim()) {
      const message =
        "the akou on this machine takes no file jobs: update it, or set AKOU_URL to an akou server";
      if (ctx.json) ctx.io.out(JSON.stringify({ error: "no_jobs", message }));
      else ctx.io.err(`akou: ${message}`);
      return EXIT.unavailable;
    }
    return finish(ctx, r, (b) => {
      const jobs = (b?.jobs ?? []) as Body[];
      if (jobs.length === 0) return "No jobs";
      return jobs
        .map((j) =>
          [j.id, j.status, when(j.created_at), typeof j.title === "string" ? j.title : ""]
            .filter((x) => x !== "")
            .join("  "),
        )
        .join("\n");
    });
  },
};
