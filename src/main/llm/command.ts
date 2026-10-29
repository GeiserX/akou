/**
 * A program the user names answers instead of a built-in provider (`provider.kind` `command`,
 * docs/providers.md): for a wrapper that picks one of several accounts, or any other model that is
 * a command line away. It is plain text in and out, so it takes five lines of shell to write one.
 *
 * - `provider.command` is an argument list, run with no shell: a `;` in a question reaches the
 *   program as text. It is set in the config file only (`apiWritable: false`), because it decides
 *   what runs on this machine.
 * - The prompt goes on stdin, and stdin is then closed. `{system}`, `{question}`, `{call}`,
 *   `{ask}` and `{task}` inside an argument are replaced by their values; with no `{system}`
 *   argument, the system prompt goes at the top of stdin. The environment carries the same values
 *   as AKOU_QUESTION, AKOU_CALL_ID, AKOU_ASK_ID and AKOU_TASK.
 * - Its stdout is the answer. A non-zero exit fails the run, with the last stderr line as the
 *   reason; usage-limit and login messages map to `exhausted` and `auth` by the harness's own
 *   rules, so the window still says why.
 *
 * Not supported: sessions, resume and starting the program early.
 */

import { basename } from "node:path";
import { classifyRun } from "./harness.ts";
import {
  type Availability,
  type CompleteRequest,
  type CompleteResult,
  type Provider,
  ProviderError,
  readLines,
} from "./provider.ts";

const STDERR_KEEP = 16_384;
const KILL_GRACE_MS = 2000;
/** How long the pipes may stay open after the program exits. */
const PIPE_GRACE_MS = 1000;

export interface CommandProviderOptions {
  argv: readonly string[];
  /** The name the window shows; empty: the program's file name. */
  label?: string;
  env?: Record<string, string | undefined>;
}

/** `{name}` in one argument, replaced by its value; anything else stays as written. */
export function fillArgs(
  argv: readonly string[],
  values: Readonly<Record<string, string>>,
): string[] {
  return argv.map((a) =>
    a.replace(/\{(system|question|call|ask|task)\}/g, (_, k: string) => values[k] ?? ""),
  );
}

/** The name of the command in the window: the label, or the program's file name. */
export function commandLabel(argv: readonly string[], label?: string): string {
  if (label && label.trim() !== "") return label.trim();
  const first = argv[0];
  return first ? basename(first) : "the command";
}

export class CommandProvider implements Provider {
  readonly id = "command" as const;
  constructor(private readonly o: CommandProviderOptions) {}

  label(): string {
    return commandLabel(this.o.argv, this.o.label);
  }

  async available(): Promise<Availability> {
    if (this.o.argv.length === 0) {
      return {
        ok: false,
        kind: "missing",
        reason: "provider.command is empty; name the program in the config file",
      };
    }
    return { ok: true, detail: `${this.label()} (${this.o.argv[0]})` };
  }

  async complete(
    req: CompleteRequest,
    onToken: (t: string) => void,
    signal: AbortSignal,
  ): Promise<CompleteResult> {
    const avail = await this.available();
    if (!avail.ok) throw new ProviderError(avail.kind, avail.reason);
    const values = {
      system: req.system,
      question: req.meta?.question ?? "",
      call: req.meta?.call ?? "",
      ask: req.meta?.ask ?? "",
      task: req.meta?.task ?? "other",
    };
    const hasSystem = this.o.argv.some((a) => a.includes("{system}"));
    const argv = fillArgs(this.o.argv, values);
    const env = {
      ...(this.o.env ?? process.env),
      AKOU_QUESTION: values.question,
      AKOU_CALL_ID: values.call,
      AKOU_ASK_ID: values.ask,
      AKOU_TASK: values.task,
    };
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      throw new ProviderError(
        "missing",
        `${this.label()} could not start: ${(err as Error).message}`,
      );
    }
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32") process.kill(-proc.pid, sig);
        else proc.kill(sig);
      } catch {
        try {
          proc.kill(sig);
        } catch {}
      }
    };
    const onAbort = () => {
      kill("SIGTERM");
      // clock: a grace for the user's program to exit before it is killed.
      killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const stdin = proc.stdin as import("bun").FileSink;
      try {
        await stdin.write(hasSystem ? req.prompt : `${req.system}\n\n${req.prompt}`);
        await stdin.end();
      } catch {
        // The program quit before reading its prompt; its exit code says why.
      }
      let stderr = "";
      const errDone = (async () => {
        for await (const line of readLines(proc.stderr as ReadableStream<Uint8Array>)) {
          if (stderr.length < STDERR_KEEP) stderr += `${line}\n`;
        }
      })();
      let text = "";
      const dec = new TextDecoder();
      const outDone = (async () => {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          const t = dec.decode(chunk, { stream: true });
          text += t;
          if (!signal.aborted && t !== "") onToken(t);
        }
        text += dec.decode();
      })();
      // A descendant that inherited the pipes (and left the group) can hold them open after the
      // program is gone; once it has exited, the pipes get a short grace and are then abandoned.
      const code = await proc.exited;
      // clock: a grace for pipes a descendant may hold open.
      const grace = new Promise<void>((r) => setTimeout(r, PIPE_GRACE_MS).unref?.());
      await Promise.race([Promise.all([outDone, errDone]), grace]);
      if (signal.aborted) throw new ProviderError("cancelled", "cancelled");
      if (code !== 0) {
        const last =
          stderr
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "")
            .at(-1) ?? "";
        const typed = classifyRun("claude", code, { text: "", finished: false }, stderr);
        const who = this.label();
        if (typed?.kind === "exhausted" || typed?.kind === "auth") {
          const what =
            typed.kind === "exhausted" ? "reported its usage limit is reached" : "is not logged in";
          throw new ProviderError(typed.kind, `${who} ${what}${last ? ` (${last})` : ""}`);
        }
        throw new ProviderError("other", `${who} exited ${code}: ${last || "no error message"}`);
      }
      if (text.trim() === "") throw new ProviderError("other", `${this.label()} printed no answer`);
      return { text: text.trim(), model: this.label() };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    }
  }
}
