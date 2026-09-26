/**
 * Starting, controlling and listing calls, and the app itself (docs/DESIGN.md sections 1.5 and 6.1):
 * `start`, `stop`, `pause`, `resume`, `mute`, `unmute`, `restart`, `status`, `open`, `calls`,
 * `show`, `finalize`, `enhance`, `quit`. The hand-off commands are in `handoff.ts`.
 */

import { bool, int, list, str } from "../args.ts";
import { EXIT, Unreachable } from "../client.ts";
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

const start: Command = {
  name: "start",
  summary: "Start a call; answers once audio is being written",
  usage:
    "akou start [-w WORKSPACE] [-t TITLE…] [--template T] [--call system|app:ID|none] [--mic ID|none] [--vocab TERM,…] [--without-models] [--json]",
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
    // Audio only, before `akou models pull` has run: nothing is transcribed live.
    "without-models": {
      type: "boolean",
      desc: "record audio now and transcribe later, before the models are downloaded",
    },
  },
  examples: ['akou start -w work -t "Weekly sync" --vocab Kubernetes,Terraform'],
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
      },
    });
    return finish(
      ctx,
      r,
      (b) => `Recording ${b.call} (audio after ${b.firstAudioMs} ms)\nfolder: ${b.folder}`,
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
      `Live: "${live.title}" in ${live.workspace}, ${live.state}${live.muted ? ", muted" : ""}, ${live.parts} part${live.parts === 1 ? "" : "s"}, recognizer lag ${live.lag} s (${live.call})`,
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
  const asr = s.asr ?? {};
  out.push(`Speech: ${asr.state}${asr.reason ? ` (${asr.reason})` : ""}`);
  const pr = s.provider ?? {};
  out.push(`Provider: ${pr.state}${pr.reason ? ` (${pr.reason})` : ""}`);
  out.push(`Share: ${s.share?.active ? "on" : "off"}`);
  for (const i of s.config?.issues ?? []) out.push(`Setting refused: ${i.message}`);
  return out.join("\n");
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
      if (!(err instanceof Unreachable)) throw err;
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
  summary: "List calls by date, title and duration (no content search)",
  usage: "akou calls [-w WORKSPACE] [--limit N] [--failed] [--json]",
  flags: {
    workspace: { type: "string", short: "w", value: "WS", desc: "only calls in this workspace" },
    limit: { type: "string", value: "N", desc: "at most N calls, newest first" },
    failed: { type: "boolean", desc: "only calls whose capture or final pass failed" },
  },
  examples: ["akou calls -w work --limit 5"],
  run: async (ctx, p) => {
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
  usage: "akou finalize [CALL | -c CALL] [--force] [--json]",
  flags: {
    call: callFlag("last"),
    force: { type: "boolean", desc: "run it again on a call that already has a final layer" },
  },
  examples: ["akou finalize last --force"],
  run: async (ctx, p) => {
    const call = objectCall(p, p.positional[0]) ?? "last";
    const r = await api(ctx, "POST", `/calls/${enc(call)}/finalize`, {
      body: { force: bool(p, "force") || undefined },
    });
    return finish(ctx, r, (b) => `Final pass started for ${b.call}`);
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
    let r: Awaited<ReturnType<typeof api>>;
    try {
      r = await api(ctx, "POST", "/quit", { launch: false });
    } catch (err) {
      if (!(err instanceof Unreachable)) throw err;
      if (ctx.json) ctx.io.out(JSON.stringify({ ok: true, running: false }));
      else ctx.io.out("akou is not running");
      return EXIT.ok;
    }
    if (r.status !== 202) return finish(ctx, r, () => "");
    // Returns once the app is gone, so a script can start it again straight after.
    const deadline = performance.now() + 20_000;
    while (ctx.client.runtime() && performance.now() < deadline) {
      await new Promise((res) => setTimeout(res, 50));
    }
    const gone = ctx.client.runtime() === null;
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
  show,
  finalize,
  enhance,
  quit,
];
