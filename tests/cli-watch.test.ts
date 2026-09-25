/**
 * `akou watch` (docs/ux/CLI.md section 11, CLI-24) without a terminal or an app: the two bottom
 * rows against a column counter, and the command against a fake API client and a fake keyboard.
 * The pty test in `cli-terminal.e2e.test.ts` covers the whole command on a real terminal.
 */

import { describe, expect, test } from "bun:test";
import type { ApiClient, ApiResponse } from "../src/main/cli/client.ts";
import { EXIT } from "../src/main/cli/client.ts";
import { fitRow, Screen, watch } from "../src/main/cli/commands/watch.ts";
import type { Ctx, Io, Keys } from "../src/main/cli/context.ts";

/** An escape sequence such as `ESC[2K` or `ESC[1A`: it moves no column. */
const CSI = new RegExp(`^${"\x1b"}\\[[0-9;]*[A-Za-z]`);

/** The widest column the cursor reaches on any row: a row wraps once it passes the width. */
function maxColumn(bytes: string): number {
  let col = 0;
  let max = 0;
  for (let i = 0; i < bytes.length; ) {
    if (bytes[i] === "\x1b") {
      const m = CSI.exec(bytes.slice(i));
      i += m ? m[0].length : 1;
      continue;
    }
    const ch = String.fromCodePoint(bytes.codePointAt(i) as number);
    i += ch.length;
    if (ch === "\r") col = 0;
    else if (ch !== "\n") {
      col += Bun.stringWidth(ch);
      max = Math.max(max, col);
    }
  }
  return max;
}

function screenOn(columns: number) {
  let bytes = "";
  const screen = new Screen(
    (t) => {
      bytes += t;
    },
    () => columns,
  );
  return { screen, bytes: () => bytes };
}

describe("[CLI-24] watch's two bottom rows stay one row each", () => {
  test("the column counter can fail: 50 characters reach column 50", () => {
    expect(maxColumn(`\x1b[2K${"x".repeat(50)}\r\n`)).toBe(50);
    expect(maxColumn("会議")).toBe(4);
  });

  test("a question longer than the row scrolls within it and keeps its end in view", () => {
    const { screen, bytes } = screenOn(40);
    screen.open();
    const question = "what did we decide about the release and who takes the migration now";
    for (const ch of question) screen.type(ch);
    expect(screen.input).toBe(question);
    expect(maxColumn(bytes())).toBeLessThanOrEqual(39);
    expect(bytes().endsWith("the migration now")).toBe(true);
    // Deleting brings the start back into view.
    for (let i = 0; i < question.length - 10; i++) screen.backspace();
    expect(bytes().endsWith(`ask> ${question.slice(0, 10)}`)).toBe(true);
  });

  test("wide characters count as two columns, in the question and in the in-progress line", () => {
    const { screen, bytes } = screenOn(40);
    screen.open();
    for (const ch of "会議の議題はリリースの日程と移行の担当者です".repeat(2)) screen.type(ch);
    // watch fits the in-progress line to the terminal's columns before it draws it.
    screen.redrawPartial(
      fitRow(`14:32 Speaker 2  ${"来週の木曜日にリリースします".repeat(3)}`, 40),
    );
    expect(maxColumn(bytes())).toBeLessThanOrEqual(39);
  });

  test("positive control: a short question is echoed one key at a time, not redrawn", () => {
    const { screen, bytes } = screenOn(40);
    screen.open();
    const before = bytes().length;
    screen.type("h");
    screen.type("i");
    expect(bytes().slice(before)).toBe("hi");
  });
});

const CALL = {
  id: "c1",
  title: "Sync",
  workspace: "work",
  live: true,
  health: [],
  startedAt: Date.now(),
  tz: "UTC",
};

function res(status: number, body: unknown): ApiResponse {
  return { status, body, text: JSON.stringify(body), contentType: "application/json" };
}

/** A keyboard that types `chunks` and then, with `end`, closes like a terminal that went away. */
function fakeKeys(chunks: string[], end: boolean): Keys & { closed: boolean } {
  let wake: (() => void) | null = null;
  const k = {
    closed: false,
    columns: () => 80,
    close: () => {
      k.closed = true;
      wake?.();
    },
    read: async function* () {
      for (const c of chunks) {
        await Bun.sleep(20);
        if (k.closed) return;
        yield c;
      }
      if (end) return;
      while (!k.closed) await new Promise<void>((r) => (wake = r));
    },
  };
  return k;
}

/** A stream that stays open until watch aborts it. */
function openStream(signal: AbortSignal | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      signal?.addEventListener("abort", () => c.close());
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function watchCtx(o: {
  keys: Keys;
  stream: (signal: AbortSignal | undefined) => Response;
  run?: Ctx["run"];
  color?: boolean;
}) {
  let screen = "";
  const io: Io = {
    env: {},
    out: () => {},
    err: (t) => {
      screen += `${t}\n`;
    },
    write: (t) => {
      screen += t;
    },
    tty: true,
    keys: o.keys,
  };
  const client = {
    request: async (_m: string, path: string) => {
      if (path === "/calls/live") return res(200, CALL);
      if (path === "/calls/c1/transcript") return res(200, { cursor: 0, lines: [] });
      return res(404, { error: "not_found", message: "no such route" });
    },
    stream: async (_m: string, _p: string, r: { signal?: AbortSignal }) => o.stream(r.signal),
  } as unknown as ApiClient;
  const ctx: Ctx = {
    io,
    json: false,
    client,
    version: "0.0.0",
    color: o.color ?? false,
    run: o.run,
  };
  return { ctx, screen: () => screen };
}

describe("[CLI-24] watch leaves when it cannot follow the call", () => {
  test("a stream the app refuses (a rotated token) says why and exits 77", async () => {
    const keys = fakeKeys([], false);
    const { ctx, screen } = watchCtx({
      keys,
      stream: () =>
        new Response(JSON.stringify({ error: "unauthorized", message: "the token is not valid" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    const code = await Promise.race([
      watch.run(ctx, { flags: {}, positional: [] }),
      Bun.sleep(3000).then(() => "still running"),
    ]);
    expect(code).toBe(EXIT.permission);
    expect(screen()).toContain("the token is not valid");
    expect(keys.closed).toBe(true);
  });

  test("positive control: a stream that stays open keeps watch running", async () => {
    const keys = fakeKeys([], false);
    const { ctx } = watchCtx({ keys, stream: openStream });
    const running = watch.run(ctx, { flags: {}, positional: [] });
    expect(await Promise.race([running, Bun.sleep(500).then(() => "still running")])).toBe(
      "still running",
    );
    keys.close();
    expect(await running).toBe(EXIT.ok);
  });
});

describe("[CLI-24] watch waits for a confirmed /stop before it leaves", () => {
  test("the terminal closing while the stop runs: watch returns only after it", async () => {
    let stopped = false;
    const ran: string[][] = [];
    const { ctx } = watchCtx({
      keys: fakeKeys(["/stop\r", "y\r"], true),
      stream: openStream,
      run: async (argv) => {
        ran.push([...argv]);
        await Bun.sleep(300);
        stopped = true;
        return 0;
      },
    });
    const code = await watch.run(ctx, { flags: {}, positional: [] });
    expect(ran).toEqual([["stop", "-c", "c1"]]);
    expect([code, stopped]).toEqual([EXIT.ok, true]);
  });
});

/** A stream that sends `events` as the app's log events, then stays open until watch aborts it. */
function streamOf(events: object[]) {
  return (signal: AbortSignal | undefined): Response => {
    const text = events.map((e) => `event: event\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        signal?.addEventListener("abort", () => c.close());
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

describe("[CLI-20] watch shows a health change in its colour and with its word", () => {
  const t = Date.now();
  const events = [
    { type: "health", ch: "call", state: "dead", t },
    { type: "health", ch: "mic", state: "quiet", t },
  ];

  async function watched(color: boolean): Promise<string> {
    const keys = fakeKeys([], false);
    const { ctx, screen } = watchCtx({ keys, stream: streamOf(events), color });
    const running = watch.run(ctx, { flags: {}, positional: [] });
    const end = performance.now() + 3000;
    while (!screen().includes("mic: ") && performance.now() < end) await Bun.sleep(20);
    keys.close();
    await running;
    return screen();
  }

  test("on a colour terminal, dead is red and quiet is yellow, each with its word", async () => {
    const out = await watched(true);
    expect(out).toContain("call: \x1b[31mdead\x1b[0m");
    expect(out).toContain("mic: \x1b[33mquiet\x1b[0m");
  });

  test("positive control: without colour the words stay and no colour code is left", async () => {
    const out = await watched(false);
    expect(out).toContain("call: dead");
    expect(out).toContain("mic: quiet");
    expect(out.includes("\x1b[31m") || out.includes("\x1b[33m")).toBe(false);
  });
});
