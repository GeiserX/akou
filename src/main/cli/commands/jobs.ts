/**
 * `akou jobs list` (docs/ux/SERVER.md SV-J8, docs/research/service-interface.md SI-1): the file
 * jobs the key can see, newest first as the server lists them. A thin client of `GET /v1/jobs`, so
 * with `AKOU_URL` set it lists a remote server's jobs with the key from the environment.
 */

import { str } from "../args.ts";
import { EXIT } from "../client.ts";
import { api, type Body, type Command, finish } from "../context.ts";
import { usage } from "./calls.ts";

const STATES = ["queued", "running", "done", "failed", "cancelled"];

export const jobsCommand: Command = {
  name: "jobs",
  summary: "The server's transcription jobs your key can see",
  usage: `akou jobs list [--status ${STATES.join("|")}]   [--json]`,
  flags: { status: { type: "string" } },
  run: async (ctx, p) => {
    const [sub, ...rest] = p.positional;
    if (sub !== "list" || rest.length > 0) return usage(ctx, "jobs needs list");
    const status = str(p, "status");
    if (status !== undefined && !STATES.includes(status)) {
      return usage(ctx, `--status is one of ${STATES.join(", ")}`);
    }
    const r = await api(ctx, "GET", "/jobs", { query: { status } });
    // The desktop app has no job routes: that is not a usage error, it is the wrong kind of akou.
    if (r.status === 404 && !ctx.io.env.AKOU_URL?.trim()) {
      const message =
        "jobs exist only on an akou server, and the akou on this machine is the desktop app; run `akou serve`, or set AKOU_URL to a server";
      if (ctx.json) ctx.io.out(JSON.stringify({ error: "not_server", message }));
      else ctx.io.err(`akou: ${message}`);
      return EXIT.unavailable;
    }
    return finish(ctx, r, (b) => {
      const jobs = (b?.jobs ?? []) as Body[];
      if (jobs.length === 0) return "No jobs";
      return jobs
        .map((j) => [j.id, j.status, j.created_at ?? ""].filter((x) => x !== "").join("  "))
        .join("\n");
    });
  },
};
