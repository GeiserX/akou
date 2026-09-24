/**
 * The hand-off and the import from the command line (docs/DESIGN.md sections 6.1 and 8.2):
 * `akou export [CALL] [--to DIR]`, `akou hooks run CALL [--stage S]` and
 * `akou import hark-viewer DIR… [-w WORKSPACE]`.
 */

import { resolve } from "node:path";
import { str } from "../args.ts";
import { api, type Body, type Command, enc, finish } from "../context.ts";
import { usage } from "./calls.ts";

const exportCmd: Command = {
  name: "export",
  summary: "Hand a finished call off to the export folder (Markdown, event log, audio)",
  usage: "akou export [CALL] [--to DIR] [--json]",
  flags: { to: { type: "string" } },
  run: async (ctx, p) => {
    const call = p.positional[0] ?? "last";
    const to = str(p, "to");
    const r = await api(ctx, "POST", `/calls/${enc(call)}/export`, {
      body: { to: to === undefined ? undefined : resolve(to) },
      // Queued behind the call's hand-off hooks, so it may wait as long as `akou hooks run`.
      timeoutMs: 60 * 60_000,
      signal: ctx.io.signal,
    });
    return finish(ctx, r, (b) => {
      const what = !b.written
        ? "Already up to date"
        : b.update
          ? "You edited the export, so the new version is beside it"
          : `Exported (rev ${b.rev})`;
      return `${what}: ${b.path}\nattachments: ${b.attachments}`;
    });
  },
};

const hooks: Command = {
  name: "hooks",
  summary: "Re-run the hand-off hooks of a call",
  usage: "akou hooks run CALL [--stage call.ended|final.done|enhanced] [--json]",
  flags: { stage: { type: "string" } },
  run: async (ctx, p) => {
    const [sub, call, ...rest] = p.positional;
    if (sub !== "run" || !call || rest.length > 0) return usage(ctx, "hooks run needs one call");
    const r = await api(ctx, "POST", `/calls/${enc(call)}/hooks`, {
      body: { stage: str(p, "stage") },
      timeoutMs: 60 * 60_000,
      signal: ctx.io.signal,
    });
    return finish(ctx, r, (b) => {
      const runs = b.runs as Body[];
      if (runs.length === 0) return "No hooks are configured for this call's stages";
      return runs
        .map(
          (x) =>
            `${x.stage} ${x.name}: exit ${x.exit} in ${x.ms} ms${x.timedOut ? " (timed out)" : ""}`,
        )
        .join("\n");
    });
  },
};

const importCmd: Command = {
  name: "import",
  summary: "Convert hark-viewer call folders (every part) into akou calls",
  usage: "akou import hark-viewer DIR… [-w WORKSPACE] [--json]",
  flags: { workspace: { type: "string", short: "w" } },
  run: async (ctx, p) => {
    const [kind, ...dirs] = p.positional;
    if (kind !== "hark-viewer" || dirs.length === 0) {
      return usage(ctx, "import needs `hark-viewer` and at least one folder");
    }
    const r = await api(ctx, "POST", "/import/hark-viewer", {
      body: { dirs: dirs.map((d) => resolve(d)), workspace: str(p, "workspace") },
      timeoutMs: 10 * 60_000,
    });
    return finish(ctx, r, (b) => {
      const out = (b.imported as Body[]).map(
        (x) =>
          `${x.call} ${x.parts} part${x.parts === 1 ? "" : "s"}, ${x.segments.live} live and ${x.segments.final} final lines, ${x.speakers} speakers: ${x.folder}`,
      );
      for (const s of b.skipped as Body[]) out.push(`skipped ${s.source}: ${s.reason}`);
      return out.join("\n");
    });
  },
};

export const handoffCommands: Command[] = [exportCmd, hooks, importCmd];
