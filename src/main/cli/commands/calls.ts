/**
 * Starting, controlling and listing calls, and the app itself (docs/DESIGN.md sections 1.5 and 6.1):
 * `start`, `stop`, `pause`, `resume`, `mute`, `unmute`, `restart`, `status`, `open`, `calls` and
 * `calls rename`, `workspaces` and `workspace add`, `show`, `finalize`, `enhance`, `templates`, `quit`. The hand-off commands are in `handoff.ts`.
 */

import { processAlive } from "../../../core/log/writer.ts";
import { finalText } from "../../asr/final-text.ts";
import { shortModelName } from "../../asr/model-text.ts";
import { REVIEW_EVERY_MAX, REVIEW_EVERY_MIN } from "../../asr/upgrade.ts";
import { bool, int, list, str } from "../args.ts";
import { EXIT, Hung, StoppedHung, Unreachable } from "../client.ts";
import { healthWord } from "../color.ts";
import {
  api,
  type Body,
  type Command,
  type Ctx,
  callFlag,
  enc,
  finish,
  objectCall,
  ref,
  wall,
} from "../context.ts";
import { processTable, recordingBelow, stopAll, stopList } from "../heal.ts";

const start: Command = {
  name: "start",
  summary: "Start a call; answers once audio is being written",
  usage:
    "akou start [-w WORKSPACE] [-t TITLE…] [--template T] [--call system|app:ID|none] [--mic ID|none] [--vocab TERM,…] [--live MODEL] [--review MODEL] [--review-every S] [--without-models] [--attach] [--json]",
  flags: {
    workspace: { type: "string", short: "w", value: "WS", desc: "the workspace the call goes in" },
    title: { type: "string", short: "t", value: "TITLE", desc: "the call's title" },
    template: { type: "string", value: "T", desc: "the notes template for this call" },
    // Not `-c`: on `start` this is the call side's audio source, not a call to name.
    call: {
      type: "string",
      value: "SRC",
      desc: "what the call side records: system (default), app:ID or none",
    },
    mic: { type: "string", value: "ID", desc: "the microphone: a device id or none" },
    vocab: { type: "string", value: "A,B", desc: "words for this call only, comma-separated" },
    live: {
      type: "string",
      value: "MODEL",
      desc: "the live model for this call only: auto, a model id from `akou models list`, nemotron or parakeet (default: asr.live); upgrade, the old spelling, is nemotron with --review qwen",
    },
    review: {
      type: "string",
      value: "MODEL",
      desc: "the second pass for this call only: none, a model id, qwen or parakeet (default: asr.review.model)",
    },
    "review-every": {
      type: "string",
      value: "S",
      desc: "how often the second pass reviews, seconds, 30 to 600 (default: asr.review.everySeconds)",
    },
    // Audio only, before `akou models pull` has run: nothing is transcribed live.
    "without-models": {
      type: "boolean",
      desc: "record audio now and transcribe later, before the models are downloaded",
    },
    // Scripts keep exit 75 for "already recording"; an agent attaches and follows that call.
    attach: {
      type: "boolean",
      desc: "if a call is already recording, answer with that call (exit 0) instead of exit 75",
    },
  },
  examples: [
    'akou start -w work -t "Weekly sync" --vocab Kubernetes,Terraform',
    "akou start --live nemotron",
    "akou start --live nemotron --review qwen --review-every 120",
    "akou start --attach --json",
  ],
  run: async (ctx, p) => {
    // `-t Weekly sync` and `-t "Weekly sync"` both work: loose words after the flags join the title.
    const title = [str(p, "title"), ...p.positional].filter((x) => x !== undefined).join(" ");
    const r = await api(ctx, "POST", "/calls", {
      body: {
        workspace: str(p, "workspace"),
        title: title === "" ? undefined : title,
        template: str(p, "template"),
        call: str(p, "call"),
        mic: str(p, "mic"),
        vocab: list(p, "vocab"),
        withoutModels: bool(p, "without-models") || undefined,
        live: str(p, "live"),
        review: str(p, "review"),
        reviewEvery: int(p, "review-every", REVIEW_EVERY_MIN, REVIEW_EVERY_MAX),
        attach: bool(p, "attach") || undefined,
      },
    });
    return finish(ctx, r, (b) =>
      b.attached
        ? `Already recording ${b.call}, "${b.title}" in ${b.workspace} since ${wall(b.startedAt)}${b.state === "paused" ? ", paused now" : ""}: following it\nfolder: ${b.folder}`
        : `Recording ${b.call} (audio after ${b.firstAudioMs} ms)\nfolder: ${b.folder}`,
    );
  },
};

function control(name: "stop" | "pause" | "resume" | "mute" | "unmute", summary: string): Command {
  return {
    name,
    summary,
    usage: `akou ${name} [-c CALL] [--json]`,
    // Controls act on the live call; the API refuses `last`, so none lands on a finished call.
    flags: { call: callFlag("live") },
    examples: [`akou ${name}`],
    run: async (ctx, p) => {
      const r = await api(ctx, "POST", `/calls/${ref(p)}/${name}`);
      return finish(ctx, r, (b) => `${b.call}: ${b.state}`);
    },
  };
}

const restart: Command = {
  name: "restart",
  summary: "Start a new part in the same call, make before break",
  usage: "akou restart [--force] [-c CALL] [--json]",
  flags: {
    force: { type: "boolean", desc: "restart even when the capture looks healthy" },
    call: callFlag("last"),
  },
  examples: ["akou restart"],
  run: async (ctx, p) => {
    const r = await api(ctx, "POST", `/calls/${ref(p, "last")}/restart`, {
      body: { force: bool(p, "force") || undefined },
    });
    return finish(ctx, r, (b) => `${b.call}: recording part ${b.part}`);
  },
};

function statusText(s: Body, color = false): string {
  const out: string[] = [];
  const a = s.app ?? {};
  out.push(`akou ${a.version}, pid ${a.pid}, port ${a.port}${a.headless ? ", headless" : ""}`);
  const live = s.live;
  if (live) {
    out.push(
      `Live: "${live.title}" in ${live.workspace}, ${live.state}${live.muted ? ", muted" : ""}, ${live.parts} part${live.parts === 1 ? "" : "s"}, recognizer lag ${live.lag} s${live.setup ? `, live model ${live.setup}${live.engine ? ` (${live.engine})` : ""}${live.review ? `, second pass ${live.review.model} every ${live.review.everySeconds} s` : ""}` : ""} (${live.call})`,
    );
    for (const h of live.health ?? []) {
      out.push(`  ${h.ch}: ${healthWord(color, h.state)}${h.detail ? ` (${h.detail})` : ""}`);
    }
  } else {
    out.push("Live: nothing is recording");
    if (s.last) {
      out.push(`Last: "${s.last.title}", ${s.last.state}, ended ${wall(s.last.endedAt)}`);
    }
  }
  out.push(...finalLines(s));
  const asr = s.asr ?? {};
  out.push(`Speech: ${asr.state}${asr.reason ? ` (${asr.reason})` : ""}`);
  const pr = s.provider ?? {};
  out.push(`Provider: ${pr.state}${pr.reason ? ` (${pr.reason})` : ""}`);
  out.push(`Share: ${s.share?.active ? "on" : "off"}`);
  for (const i of s.config?.issues ?? []) out.push(`Setting refused: ${i.message}`);
  return out.join("\n");
}

/** A pass that ended longer ago than this is no news: `akou status` leaves it out. */
export const FINAL_NEWS_MS = 60 * 60_000;

/**
 * The `Final:` lines: the last call's pass while it runs, when it failed, or when it ended within
 * the last hour; and a pass running on another call (`finals`), named by its call.
 */
export function finalLines(s: Body): string[] {
  const out: string[] = [];
  const f = s.last?.final;
  const now = Number(s.app?.startedAt ?? 0) + Number(s.app?.uptimeMs ?? 0);
  if (
    f &&
    (f.state === "running" ||
      f.state === "failed" ||
      (f.state === "done" && f.endedAt !== null && now - f.endedAt <= FINAL_NEWS_MS))
  ) {
    const warning = f.state === "done" && f.warning ? `; ${f.warning}` : "";
    out.push(`Final: ${finalText(f)}${warning}`);
  }
  for (const r of (s.finals ?? []) as Body[]) {
    if (r.call === s.last?.call) continue;
    out.push(`Final of ${r.call}: ${finalText({ state: "running", ...r })}`);
  }
  return out;
}

const status: Command = {
  name: "status",
  summary: "The app, the live call, health, recognizer lag, models, provider, sharing",
  usage: "akou status [--json]",
  examples: ["akou status", "akou status --json"],
  run: async (ctx) => {
    let r: Awaited<ReturnType<typeof api>>;
    try {
      // A probe never launches the app.
      r = await api(ctx, "GET", "/status", { launch: false });
    } catch (err) {
      // A hung app is not "not running": the CLI's own message says what it found (DK-M8).
      if (!(err instanceof Unreachable) || err instanceof Hung) throw err;
      if (ctx.json) ctx.io.out(JSON.stringify({ running: false }));
      else ctx.io.err("akou is not running (`akou open` starts it and shows the window)");
      return EXIT.unavailable;
    }
    return finish(ctx, r, (b) => statusText(b, ctx.color));
  },
};

const open: Command = {
  name: "open",
  summary: "Show the window on a call; headless, print the address of the window in a browser",
  usage: "akou open [CALL | -c CALL] [--json]",
  flags: { call: callFlag("the window's own choice") },
  examples: ["akou open", "akou open last"],
  run: async (ctx, p) => {
    const call = objectCall(p, p.positional[0]);
    const r = await api(ctx, "POST", "/window", { body: call ? { call } : {} });
    // The address carries a one-time code that works once, for one minute: open it, do not keep it.
    return finish(ctx, r, (b) =>
      b.url
        ? `Open this in a browser within a minute (it works once):\n${b.url}`
        : "The window is open.",
    );
  },
};

function minutes(from: number, to: number | null): string {
  if (to === null) return "live";
  return `${Math.max(0, Math.round((to - from) / 60_000))} min`;
}

const calls: Command = {
  name: "calls",
  summary: "List calls by date, title and duration (no content search), or rename one",
  usage:
    "akou calls [-w WORKSPACE] [--limit N] [--failed] [--json] | akou calls rename CALL TITLE… [--json]",
  flags: {
    workspace: { type: "string", short: "w", value: "WS", desc: "only calls in this workspace" },
    limit: { type: "string", value: "N", desc: "at most N calls, newest first" },
    failed: { type: "boolean", desc: "only calls whose capture or final pass failed" },
    call: callFlag("none; name one"),
  },
  examples: ["akou calls -w work --limit 5", "akou calls rename last Weekly sync"],
  run: async (ctx, p) => {
    const [sub, ...rest] = p.positional;
    if (sub === "rename") {
      // The call is `-c CALL` or the first word; every word after it is the title.
      const call = str(p, "call") ?? rest.shift();
      const title = rest.join(" ").trim();
      if (!call || title === "") {
        return usage(ctx, "calls rename needs a call and a title: calls rename last Weekly sync");
      }
      if (str(p, "workspace") !== undefined) {
        return usage(ctx, "calls rename changes the title only; -w does not move a call");
      }
      const r = await api(ctx, "PATCH", `/calls/${enc(call)}`, { body: { title } });
      return finish(ctx, r, (b) => `${b.call} is now "${b.title}"`);
    }
    if (sub !== undefined) return usage(ctx, `calls has no ${sub}; try: calls rename CALL TITLE`);
    if (str(p, "call") !== undefined) {
      return usage(ctx, "-c names the call to rename: calls rename -c CALL TITLE");
    }
    const r = await api(ctx, "GET", "/calls", {
      query: {
        workspace: str(p, "workspace"),
        limit: int(p, "limit", 1, 1000),
        failed: bool(p, "failed") || undefined,
      },
    });
    return finish(ctx, r, (b) =>
      (b.calls as Body[]).length === 0
        ? "No calls."
        : (b.calls as Body[])
            .map(
              (c) =>
                `${new Date(c.createdAt).toLocaleDateString("en-CA")} ${wall(c.createdAt)}  ${minutes(c.createdAt, c.endedAt).padEnd(7)} ${c.workspace}  ${c.title}  (${c.state})  ${c.id}`,
            )
            .join("\n"),
    );
  },
};

const workspaces: Command = {
  name: "workspaces",
  summary: "List the workspaces, empty ones included, with how many calls each holds",
  usage: "akou workspaces [--json]",
  flags: {},
  examples: ["akou workspaces"],
  run: async (ctx, p) => {
    if (p.positional.length > 0)
      return usage(ctx, "workspaces takes no words; add one with: workspace add NAME");
    const r = await api(ctx, "GET", "/workspaces");
    return finish(ctx, r, (b) =>
      (b.workspaces as Body[]).length === 0
        ? "No workspaces."
        : (b.workspaces as Body[])
            .map((w) => `${w.name}  ${w.calls} call${w.calls === 1 ? "" : "s"}`)
            .join("\n"),
    );
  },
};

const workspace: Command = {
  name: "workspace",
  summary: "Add a workspace, so it exists before its first call",
  usage: "akou workspace add NAME [--json]",
  flags: {},
  examples: ["akou workspace add Personal"],
  run: async (ctx, p) => {
    const [sub, name, ...more] = p.positional;
    if (sub !== "add" || !name || more.length > 0) {
      return usage(ctx, "workspace needs add and one name: workspace add Personal");
    }
    const r = await api(ctx, "POST", "/workspaces", { body: { name } });
    return finish(ctx, r, (b) =>
      b.created ? `Added workspace ${b.workspace}` : `Workspace ${b.workspace} already exists`,
    );
  },
};

const show: Command = {
  name: "show",
  summary: "One call's transcript",
  usage: "akou show CALL | -c CALL [--layer best|live|final] [--format md|json|txt] [--json]",
  flags: {
    call: callFlag("none; name one"),
    layer: { type: "string", value: "L", desc: "best (default), live or final" },
    format: { type: "string", value: "F", desc: "md (default), txt or json" },
  },
  examples: ["akou show last --format txt", "akou show -c last"],
  run: async (ctx, p) => {
    const call = objectCall(p, p.positional[0]);
    if (!call) return usage(ctx, "show needs a call id (or `last`)");
    const format = ctx.json ? "json" : (str(p, "format") ?? "md");
    const r = await api(ctx, "GET", `/calls/${enc(call)}/transcript`, {
      query: { layer: str(p, "layer"), format },
    });
    if (r.status === 200 && format !== "json") {
      ctx.io.out(r.text.replace(/\n$/, ""));
      return EXIT.ok;
    }
    return finish(ctx, r, (b) => JSON.stringify(b, null, 2));
  },
};

const finalize: Command = {
  name: "finalize",
  summary: "Run the accurate final pass on an ended call",
  usage: "akou finalize [CALL | -c CALL] [--force] [--model qwen|parakeet] [--json]",
  flags: {
    call: callFlag("last"),
    force: { type: "boolean", desc: "run it again on a call that already has a final layer" },
    model: {
      type: "string",
      value: "MODEL",
      desc: "the model for this run only: qwen or parakeet (default: asr.final.model)",
    },
  },
  examples: ["akou finalize last --force", "akou finalize last --force --model qwen"],
  run: async (ctx, p) => {
    const call = objectCall(p, p.positional[0]) ?? "last";
    const r = await api(ctx, "POST", `/calls/${enc(call)}/finalize`, {
      body: { force: bool(p, "force") || undefined, model: str(p, "model") },
    });
    return finish(
      ctx,
      r,
      (b) => `Final pass started for ${b.call}${b.model ? ` on ${shortModelName(b.model)}` : ""}`,
    );
  },
};

const enhance: Command = {
  name: "enhance",
  summary: "Write enhanced notes with the configured provider (on a live call: so far)",
  usage: "akou enhance [--template T] [-c CALL] [--json]",
  flags: {
    template: { type: "string", value: "T", desc: "the template the notes follow" },
    call: callFlag("last"),
  },
  examples: ["akou enhance --template standup"],
  run: async (ctx, p) => {
    const r = await api(ctx, "POST", `/calls/${ref(p, "last")}/enhance`, {
      body: { template: str(p, "template") },
      // A long call is summarised stretch by stretch before the notes are written.
      timeoutMs: 60 * 60_000,
      signal: ctx.io.signal,
    });
    return finish(ctx, r, (b) => {
      const dropped = (b.dropped as Body[]).length;
      const note = [
        `rev ${b.rev}, template ${b.template ?? ""}`.trim(),
        `by ${b.model}`,
        b.live ? "so far (the call is still live)" : "",
        dropped > 0 ? `${dropped} uncited line${dropped === 1 ? "" : "s"} dropped` : "",
        `saved to ${b.file}`,
      ].filter((x) => x !== "");
      return `${b.markdown}\n\n(${note.join(" · ")})`;
    });
  },
};

const templates: Command = {
  name: "templates",
  summary: "List the note templates, or print one as the enhanced notes would use it",
  usage: "akou templates list | akou templates show NAME   [--json]",
  examples: ["akou templates list", "akou templates show standup"],
  run: async (ctx, p) => {
    const [sub, name, ...rest] = p.positional;
    if (sub === "list" && name === undefined) {
      const r = await api(ctx, "GET", "/templates");
      return finish(ctx, r, (b) =>
        [
          ...(b.details as Body[]).map(
            (t) =>
              `${t.name}${t.bundled ? "" : "  (yours)"}${t.match.length > 0 ? `  match: ${t.match.join(", ")}` : ""}`,
          ),
          `Your own go in ${b.dir}; a file named like a shipped one replaces it.`,
        ].join("\n"),
      );
    }
    if (sub === "show") {
      if (!name || rest.length > 0) return usage(ctx, "templates show needs one name");
      const r = await api(ctx, "GET", `/templates/${enc(name)}`);
      return finish(ctx, r, (b) => String(b.text).replace(/\n$/, ""));
    }
    return usage(ctx, "templates needs list, or show NAME");
  },
};
/** How long `akou quit` waits for the app to finish quitting before it stops it. */
const QUIT_WAIT_MS = 20_000;

const quit: Command = {
  name: "quit",
  summary: "Stop the app cleanly (the live call is stopped and its log ended first)",
  usage: "akou quit [--json]",
  examples: ["akou quit"],
  run: async (ctx) => {
    // `runtime.json` is never read with a remote target, so the wait below could not see it go.
    if (ctx.io.env.AKOU_URL?.trim()) {
      return usage(
        ctx,
        "akou quit stops the app on this machine, and AKOU_URL points at a server, which it never stops; unset AKOU_URL to quit the local app",
      );
    }
    // Every process that makes up the app, read before it starts to go: the app, the ElectroBun
    // launcher above it and its helpers below (akou-m23).
    // An app in this very process (the tests' rigs) is never waited for as a process, nor are this
    // process's children taken for its helpers.
    const found = ctx.client.runtime();
    const rt = found && found.pid !== process.pid ? found : null;
    const rows = (rt ? await processTable() : []) ?? [];
    // Never this command, nor the processes between it and the app: a harness the app started may
    // be the one running `akou quit`.
    const others = rt ? stopList(rows, rt.pid).filter((p) => p !== rt.pid) : [];
    let r: Awaited<ReturnType<typeof api>>;
    try {
      r = await api(ctx, "POST", "/quit", { launch: false });
    } catch (err) {
      if (err instanceof StoppedHung) {
        // The hung app is gone: that is what quit asked for (DK-M8).
        ctx.io.err(`akou: ${err.message}`);
        if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, running: false }));
        else ctx.io.out("akou has quit");
        return EXIT.ok;
      }
      if (!(err instanceof Unreachable) || err instanceof Hung) throw err;
      if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, running: false }));
      else ctx.io.out("akou is not running");
      return EXIT.ok;
    }
    if (r.status !== 202) return finish(ctx, r, () => "");
    // Returns once every process of the app is gone, so a script can start it again straight
    // after: `runtime.json` goes before the process exits, and the launcher has outlived the app
    // before (akou-m23).
    const deadline = performance.now() + QUIT_WAIT_MS;
    const appAlive = () => ctx.client.runtime() !== null || (!!rt && processAlive(rt.pid));
    while (appAlive() && performance.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    if (appAlive() && rt) {
      // The app answered 202 and has not finished quitting: it is stopped, as the quit promised,
      // unless a call is still recording, which nothing here ever ends.
      const now = await processTable();
      if (now === null) {
        // A list that cannot be read may hide a recording helper: nothing is stopped.
        const how =
          process.platform === "win32"
            ? `end akou (pid ${rt.pid}) in Task Manager`
            : `kill -KILL ${rt.pid} stops it by hand`;
        const why = process.platform === "win32" ? "on Windows" : "ps failed";
        const message = `akou did not finish quitting within ${QUIT_WAIT_MS / 1000} s, and the processes below it could not be listed (${why}), so nothing was stopped; ${how}`;
        if (ctx.json) ctx.io.out(JSON.stringify({ ok: false, running: true, message }));
        else ctx.io.err(`akou: ${message}`);
        return EXIT.software;
      }
      // A recording is a helper whose audio file grows, or one whose file cannot be read (a path
      // `ps` cut at a space). A helper left over from an ended call, its file still, is not one.
      const rec = await recordingBelow(now, rt.pid);
      if (rec && rec.growing !== false) {
        const message = `akou did not finish quitting within ${QUIT_WAIT_MS / 1000} s and a call is still recording (capture helper pid ${rec.pid}), so nothing was stopped; kill -KILL ${rt.pid} stops it by hand, the audio so far stays`;
        if (ctx.json) ctx.io.out(JSON.stringify({ ok: false, running: true, message }));
        else ctx.io.err(`akou: ${message}`);
        return EXIT.software;
      }
      ctx.io.err(`akou: akou did not finish quitting within ${QUIT_WAIT_MS / 1000} s; stopped it`);
      await stopAll([rt.pid]);
    }
    let gone = !appAlive();
    if (gone) {
      // The launcher and the helpers end with the app; any still there a moment later are stopped.
      const settle = performance.now() + 2000;
      while (others.some(processAlive) && performance.now() < settle) {
        await new Promise((res) => setTimeout(res, 50));
      }
      gone = (await stopAll(others.filter(processAlive))).length === 0;
    }
    if (ctx.json) ctx.io.out(JSON.stringify({ ok: gone, running: !gone }));
    else if (gone) ctx.io.out("akou has quit");
    else ctx.io.err("akou: the app is still shutting down");
    return gone ? EXIT.ok : EXIT.software;
  },
};

export function usage(ctx: Ctx, message: string): number {
  if (ctx.json) ctx.io.out(JSON.stringify({ error: "usage", message }));
  else ctx.io.err(`akou: ${message}`);
  return EXIT.usage;
}

export const callCommands: Command[] = [
  start,
  control("stop", "Stop the live call"),
  control("pause", "Pause the live call"),
  control("resume", "Resume the paused call"),
  control("mute", "Mute your microphone in the live call"),
  control("unmute", "Unmute your microphone"),
  restart,
  status,
  open,
  calls,
  workspaces,
  workspace,
  show,
  finalize,
  enhance,
  templates,
  quit,
];
