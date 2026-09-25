/**
 * `akou watch` (docs/ux/CLI.md section 11, CLI-24): the live call in a terminal, built only from
 * what already exists.
 *
 * - Committed lines, answers and health changes print above the prompt and stay in scrollback. The
 *   one line redrawn is the in-progress line just above the prompt, with a carriage return and an
 *   erase-line, never a newline; a line gets its newline when it commits. No alternate screen and
 *   no layout library, so it works in any terminal, in tmux and over SSH.
 * - Plain text asks the watched call (`akou ask`); a line that starts with `/` runs that CLI
 *   command with `-c` set to the watched call, in this process, as the CLI (`by: agent:cli`), the
 *   same as that command typed in a shell: the API cannot tell a person from an agent holding the
 *   same token, so only the window writes as the user.
 * - It never stops the recording on the way out: Ctrl-C clears the line, Ctrl-C on an empty line,
 *   Ctrl-D or `/quit` exit 0. `/stop` asks first, and Enter answers no.
 * - Only on a terminal: piped, it exits 64 and names `akou tail -f`.
 */

import { formatWall } from "../../../core/log/clock.ts";
import { readSse } from "../../llm/provider.ts";
import { EXIT, exitFor } from "../client.ts";
import { dim, healthWord, paint, SpeakerColors } from "../color.ts";
import {
  api,
  type Body,
  type Command,
  callFlag,
  describeError,
  enc,
  finish,
  type Io,
  localZone,
  wall,
} from "../context.ts";
import { lineText } from "./follow.ts";

/** The CLI commands a `/` line may run, each bound to the watched call. */
export const WATCH_COMMANDS = [
  "note",
  "remember",
  "name",
  "mute",
  "unmute",
  "pause",
  "resume",
  "search",
  "stop",
] as const;

const NEEDS_TERMINAL =
  "akou watch needs a terminal; `akou tail -f` prints the same lines to a pipe";
const PROMPT = "ask> ";
/** Committed lines shown on opening a call, before following it. */
const BACKLOG = 20;

/** Log events after which the rendered transcript may have new or changed lines. */
const LINE_EVENTS = new Set(["seg", "speaker.name", "speaker.merge", "speaker.unmerge"]);

/**
 * The terminal's bottom two rows: the in-progress line and the prompt. Each stays inside one row,
 * counted in columns (a wide character takes two), so a redraw that erases one row erases all of
 * it: a question longer than the row scrolls within it, keeping its end in view.
 */
export class Screen {
  partial = "";
  input = "";
  prompt = PROMPT;
  constructor(
    private readonly write: (t: string) => void,
    private readonly columns: () => number,
  ) {}

  /** The prompt row: the prompt, then as much of the end of the input as fits. */
  private inputRow(): string {
    const room = this.columns() - Bun.stringWidth(this.prompt);
    return `${this.prompt}${fit(this.input, room)}`;
  }

  private bottom(): string {
    return `\x1b[2K${this.partial}\r\n\x1b[2K${this.inputRow()}`;
  }

  /** Draws both rows from the start of an empty line. */
  open(): void {
    this.write(this.bottom());
  }

  /** Clears both rows; the cursor ends at the start of the in-progress row. */
  clear(): void {
    this.write("\r\x1b[2K\x1b[1A\x1b[2K\r");
  }

  /** Prints text above the two rows, where it stays in scrollback. */
  above(text: string): void {
    this.clear();
    this.write(`${text.replace(/\r?\n/g, "\r\n")}\r\n`);
    this.write(this.bottom());
  }

  /** Redraws the in-progress row in place: carriage return and erase-line, never a newline. */
  redrawPartial(text: string): void {
    if (text === this.partial) return;
    this.partial = text;
    this.write(`\r\x1b[1A\x1b[2K${text}\r\x1b[1B\x1b[2K${this.inputRow()}`);
  }

  redrawInput(): void {
    this.write(`\r\x1b[2K${this.inputRow()}`);
  }

  /** One typed character: echoed while the row has room, else the row is redrawn scrolled. */
  type(ch: string): void {
    this.input += ch;
    const width = Bun.stringWidth(this.prompt) + Bun.stringWidth(this.input);
    if (width < this.columns()) this.write(ch);
    else this.redrawInput();
  }

  backspace(): void {
    this.input = [...this.input].slice(0, -1).join("");
    this.redrawInput();
  }
}

/** Two spaces in front of every line of a command's output, so it reads as an answer. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

/** The words of a `/` line: `/name c2 Platform lead` is `name`, `c2`, `Platform`, `lead`. */
function words(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) =>
    /^(["']).*\1$/.test(w) ? w.slice(1, -1) : w,
  );
}

/**
 * Keeps the end of `text` inside `columns` terminal columns less one, so the cursor never reaches
 * the row's end and wraps; a cut start shows as `…`. A wide character (CJK, most emoji) counts two.
 */
export function fit(text: string, columns: number): string {
  const max = Math.max(10, columns - 1);
  if (Bun.stringWidth(text) <= max) return text;
  const chars = [...text];
  let width = 1; // the `…`
  let start = chars.length;
  while (start > 0 && width + Bun.stringWidth(chars[start - 1] as string) <= max) {
    start -= 1;
    width += Bun.stringWidth(chars[start] as string);
  }
  return `…${chars.slice(start).join("")}`;
}

export const watch: Command = {
  name: "watch",
  summary: "Follow a call in the terminal and ask it questions as it runs",
  usage: "akou watch [-c CALL]",
  flags: {
    call: callFlag("live, else last"),
    json: {
      type: "boolean",
      desc: "exits 64: watch is for a terminal; `akou tail -f --json` streams JSON",
    },
  },
  examples: ["akou watch", "akou watch -c last"],
  run: async (ctx, p) => {
    const keys = ctx.io.keys;
    const write = ctx.io.write;
    if (!keys || !write || !ctx.io.tty || ctx.json) {
      if (ctx.json) ctx.io.out(JSON.stringify({ error: "usage", message: NEEDS_TERMINAL }));
      else ctx.io.err(`akou: ${NEEDS_TERMINAL}`);
      return EXIT.usage;
    }
    // The call: the one named, else the live one, else the last one, said on stderr.
    const named = typeof p.flags.call === "string" && p.flags.call !== "";
    let r = await api(ctx, "GET", `/calls/${named ? enc(p.flags.call as string) : "live"}`);
    if (!named && r.status === 404 && r.body?.error === "no_live_call" && r.body.last) {
      const last = r.body.last as Body;
      ctx.io.err(`akou: nothing is live; watching "${last.title}", ended at ${wall(last.endedAt)}`);
      r = await api(ctx, "GET", `/calls/${enc(last.id)}`);
    }
    if (r.status !== 200) return finish(ctx, r, () => "");
    const call = r.body as Body;
    const id = call.id as string;
    /** A time of day in the call's zone, as its transcript lines are. */
    const at = (ms: number | null | undefined) =>
      ms === null || ms === undefined ? "?" : formatWall(ms, call.tz ?? localZone());
    const color = ctx.color === true;
    const colors = new SpeakerColors(color);
    /** Speaker id to name, from the committed lines: the in-progress line shows the same names. */
    const names = new Map<string, string>();

    const t = await api(ctx, "GET", `/calls/${id}/transcript`, { query: { format: "json" } });
    if (t.status !== 200) return finish(ctx, t, () => "");
    let lineCursor = t.body.cursor as number;

    const header = (c: Body): string => {
      if (c.live) {
        const health = ((c.health ?? []) as Body[])
          .map((h) => `${h.ch} ${healthWord(color, h.state)}`)
          .join(" · ");
        return `${paint(color, "31", "●")} Recording "${c.title}" in ${c.workspace} since ${at(c.startedAt)}${health ? ` · ${health}` : ""}`;
      }
      return `■ "${c.title}" in ${c.workspace}, ${c.state}, ended at ${at(c.endedAt)}`;
    };
    const out: string[] = [
      header(call),
      dim(
        color,
        "Type a question and Enter to ask the call · /help lists commands · Ctrl-D or /quit leaves; the recording keeps going",
      ),
    ];
    for (const l of (t.body.lines as Body[]).slice(-BACKLOG)) {
      names.set(l.spk, l.speaker);
      out.push(lineText(l, "txt", colors));
    }
    write(`${out.join("\r\n")}\r\n`);

    const screen = new Screen(write, () => keys.columns());
    screen.open();
    /** Output that arrives while a command runs waits until it is done. */
    let busy = null as AbortController | null;
    const held: string[] = [];
    const above = (text: string) => {
      if (busy) held.push(text);
      else screen.above(text);
    };

    let done = false;
    let exitCode: number = EXIT.ok;
    const follow = new AbortController();
    const stopAll = (code: number) => {
      if (done) return;
      done = true;
      exitCode = code;
      busy?.abort();
      follow.abort();
      keys.close();
    };

    // Committed lines, read from the rendered transcript one pull at a time.
    let pulling: Promise<void> = Promise.resolve();
    const pull = () => {
      pulling = pulling.then(async () => {
        if (done) return;
        const r = await api(ctx, "GET", `/calls/${id}/transcript`, {
          query: { format: "json", since: lineCursor },
        }).catch(() => null);
        if (r?.status !== 200) return;
        lineCursor = r.body.cursor;
        for (const l of r.body.lines as Body[]) {
          names.set(l.spk, l.speaker);
          above(lineText(l, "txt", colors));
        }
      });
    };

    let latestPartial: Body[] = [];
    const partialText = (lines: Body[]): string =>
      lines.length === 0
        ? ""
        : dim(
            color,
            fit(
              lines
                .map((x) => {
                  const spk = x.ch === "mic" ? "you" : (x.spk ?? "call");
                  return `${x.time} ${names.get(spk) ?? spk}  ${x.text}`;
                })
                .join("  ·  "),
              keys.columns(),
            ),
          );

    const followed = (async () => {
      try {
        const res = await ctx.client.stream("GET", `/calls/${id}/stream`, {
          query: { after: lineCursor },
          signal: follow.signal,
          // A follow lasts as long as the call; the longest timer a runtime keeps is about 24 days.
          timeoutMs: 2_147_483_647,
        });
        if (!res.ok || !res.body) {
          // Refused (a rotated token answers 401): say why and leave, rather than sit on a
          // transcript that stopped moving.
          const body = (await res.json().catch(() => null)) as Body;
          above(`akou: ${describeError({ status: res.status, body, text: "", contentType: "" })}`);
          stopAll(exitFor(res.status, body?.error));
          return;
        }
        for await (const ev of readSse(res.body)) {
          if (done) break;
          if (ev.event === "partial") {
            latestPartial = JSON.parse(ev.data) as Body[];
            if (!busy) screen.redrawPartial(partialText(latestPartial));
            continue;
          }
          if (ev.event !== "event") continue;
          const e = JSON.parse(ev.data) as Body;
          if (LINE_EVENTS.has(e.type)) pull();
          else if (e.type === "health") {
            const word = healthWord(color, e.state);
            above(
              `${at(e.t)} ${e.state === "ok" ? " " : "!"} ${e.ch}: ${word}${e.detail ? ` (${e.detail})` : ""}`,
            );
          } else if (e.type === "call.ended" || e.type === "call.failed") {
            await pulling;
            above(`${at(e.t)} the call ${e.type === "call.ended" ? "ended" : "failed"}`);
          } else if (e.type === "final.done") {
            above(`${at(e.t)} final transcript ready: akou show ${id}`);
          }
        }
      } catch {
        // The stream ends when watch does, or when the app goes away.
      }
      if (!done) {
        above("akou: lost the app; the recording, if any, is unaffected");
        stopAll(EXIT.unavailable);
      }
    })();

    /** Runs one CLI command in this process, printing its output above the prompt. */
    const runLine = async (argv: string[], stream: boolean): Promise<void> => {
      const ac = new AbortController();
      busy = ac;
      screen.clear();
      let midLine = false;
      const sub: Io = {
        env: ctx.io.env,
        out: (text) => {
          write(`${midLine ? "\r\n" : ""}${indent(text).replace(/\n/g, "\r\n")}\r\n`);
          midLine = false;
        },
        err: (text) => {
          write(`${midLine ? "\r\n" : ""}${indent(text).replace(/\n/g, "\r\n")}\r\n`);
          midLine = false;
        },
        write: stream
          ? (text) => {
              if (!midLine) write("  ");
              const body = text.replace(/\n(?=.)/g, "\r\n  ").replace(/\n$/, "\r\n");
              write(body);
              midLine = !text.endsWith("\n");
            }
          : undefined,
        signal: ac.signal,
        tty: ctx.io.tty,
      };
      try {
        await ctx.run?.(argv, sub);
      } catch (err) {
        sub.err(`akou: ${(err as Error).message}`);
      }
      if (midLine) write("\r\n");
      busy = null;
      if (done) return;
      screen.partial = partialText(latestPartial);
      screen.open();
      for (const h of held.splice(0)) screen.above(h);
    };
    /** The command or question running now, which watch waits for before it leaves. */
    let current: Promise<void> = Promise.resolve();

    const helpText = (): string =>
      [
        "Type a question and Enter to ask the call. Commands, each for this call:",
        ...WATCH_COMMANDS.map((n) => `/${n}`),
        "/help   this list",
        "/quit   leave; the recording keeps going (Ctrl-D does the same)",
      ].join("\n");

    /** A yes-or-no question on the prompt row; Enter alone is no. */
    let confirm: ((answer: string) => Promise<void> | undefined) | null = null;

    const submit = async (line: string): Promise<void> => {
      const text = line.trim();
      if (confirm) {
        const answer = confirm;
        confirm = null;
        screen.prompt = PROMPT;
        // What the answer runs is what watch waits for before it leaves.
        return answer(text);
      }
      if (text === "") return screen.redrawInput();
      screen.above(`${PROMPT}${text}`);
      if (!text.startsWith("/")) return runLine(["ask", text, "-c", id], true);
      const [cmd = "", ...args] = words(text.slice(1));
      if (cmd === "quit") return stopAll(EXIT.ok);
      if (cmd === "help") return screen.above(indent(helpText()));
      if (!(WATCH_COMMANDS as readonly string[]).includes(cmd)) {
        return screen.above(indent(`unknown command /${cmd}; /help lists them`));
      }
      if (cmd === "stop") {
        screen.prompt = `Stop recording "${call.title}"? [y/N] `;
        screen.redrawInput();
        confirm = (answer) => {
          if (/^y(es)?$/i.test(answer)) return runLine(["stop", "-c", id], false);
          screen.above(indent("still recording"));
        };
        return;
      }
      return runLine([cmd, ...args, "-c", id], false);
    };

    // The keyboard, in raw mode: Ctrl-C and Ctrl-D arrive as bytes, not signals.
    try {
      for await (const chunk of keys.read()) {
        if (done) break;
        if (chunk.startsWith("\x1b")) continue; // arrows and other escape sequences
        for (const ch of chunk) {
          if (ch === "\x03") {
            if (busy) busy.abort();
            else if (screen.input !== "") {
              screen.input = "";
              screen.redrawInput();
            } else stopAll(EXIT.ok);
          } else if (ch === "\x04") {
            if (screen.input === "" && !busy) stopAll(EXIT.ok);
          } else if (busy) {
            // Typing waits until the answer or command is done.
          } else if (ch === "\r" || ch === "\n") {
            const line = screen.input;
            screen.input = "";
            // Not awaited: Ctrl-C must still reach a running question to cancel it.
            current = submit(line);
          } else if (ch === "\x7f" || ch === "\b") screen.backspace();
          else if (ch >= " ") screen.type(ch);
          if (done) break;
        }
      }
    } finally {
      stopAll(exitCode);
      await current;
      screen.clear();
      await followed;
    }
    return exitCode;
  },
};
