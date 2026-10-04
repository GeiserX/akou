/**
 * `akou events` (docs/ux/PROGRAMMABILITY.md PG-S3): a call's log events as JSON lines, one object
 * per line, on a terminal or a pipe, with or without `--json`; `--type` filtered on the server
 * (PG-S2); `-f` follows until the call ends; it never launches the app, and exits 69 without one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/main/cli/cli.ts";
import { EXIT } from "../src/main/cli/client.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { CLI, cli } from "./cli-helpers.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

const SAVED = "01J8Z6Q4M2VX0K7B3D4E5EVENTS";
/** Enough segments that their lines overflow a pipe's buffer: a reader that stops early closes it. */
const SEGS = 2000;
const HEALTH_AFTER = new Set([10, 1000, 1500]);

/** A saved call of `SEGS` segments with three `health` events among them, then its end. */
function seed(home: string): number {
  const b = new LogBuilder();
  b.created({ id: SAVED, title: "Events" });
  b.partStarted(1, T0);
  for (let i = 1; i <= SEGS; i++) {
    b.seg({ id: `l${String(i).padStart(6, "0")}`, w0: T0 + i * 1000, text: `line ${i}` });
    if (HEALTH_AFTER.has(i)) {
      b.add({
        type: "health",
        part: 1,
        ch: "call",
        state: i === 1500 ? "ok" : "silent",
        silentFor: 5,
        rebuilds: 0,
        detail: "",
      });
    }
  }
  b.partEnded(1, "stop", SEGS + 2);
  b.add({ type: "call.ended", reason: "stop" });
  const dir = join(home, "Recordings", "akou", "work", "2026-09-23_153612_events");
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    `${b.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  return b.events.length;
}

let home: { dir: string; cleanup: () => void };
let rig: AppRig;
let total: number;

beforeAll(async () => {
  home = tempDir("akou-events-");
  total = seed(home.dir);
  rig = await appRig({ home: home.dir });
});

afterAll(async () => {
  await rig?.close();
  home?.cleanup();
});

const env = () => ({ ...process.env, ...rig.env });
const lines = (out: string) => out.split("\n").filter((l) => l !== "");

describe("[PG-S3] akou events", () => {
  test("prints every event as one JSON object per line, on a terminal too, with or without --json", async () => {
    for (const argv of [
      ["events", "-c", SAVED],
      ["events", "-c", SAVED, "--json"],
    ]) {
      const out: string[] = [];
      const code = await runCli(
        argv,
        { env: env(), out: (t) => out.push(t), err: () => {}, tty: true },
        { launch: null },
      );
      expect(code).toBe(EXIT.ok);
      const ls = lines(out.join("\n"));
      expect(ls.length).toBe(total);
      const parsed = ls.map((l) => JSON.parse(l));
      expect(parsed.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    }
  });

  test("--type health prints only the health events; --since starts after a cursor", async () => {
    const r = await cli(env(), ["events", "-c", SAVED, "--type", "health"]);
    expect(r.code).toBe(EXIT.ok);
    const got = lines(r.out).map((l) => JSON.parse(l));
    expect(got.map((e) => e.type)).toEqual(["health", "health", "health"]);
    const since = await cli(env(), [
      "events",
      "-c",
      SAVED,
      "--type",
      "health",
      "--since",
      String(got[0].seq),
    ]);
    expect(lines(since.out).map((l) => JSON.parse(l).seq)).toEqual([got[1].seq, got[2].seq]);
    // Positive control: an unknown type is refused, not matched by nothing.
    const bad = await cli(env(), ["events", "-c", SAVED, "--type", "helth"]);
    expect(bad.code).toBe(EXIT.usage);
  });

  test("-f follows until the call ends, printing only the types asked for", async () => {
    const r = await cli(env(), ["events", "-c", SAVED, "-f", "--type", "health"]);
    expect(r.code).toBe(EXIT.ok);
    // `call.ended` stops it, though it was not asked for and is not printed.
    expect(lines(r.out).map((l) => JSON.parse(l).type)).toEqual(["health", "health", "health"]);
  });

  test("with the app down it exits 69 and launches nothing", async () => {
    const empty = tempDir("akou-events-down-");
    try {
      const r = await cli({ ...process.env, AKOU_HOME: empty.dir, AKOU_HEADLESS: "1" }, ["events"]);
      expect(r.code).toBe(EXIT.unavailable);
      expect(r.out).toBe("");
    } finally {
      empty.cleanup();
    }
  });

  test.skipIf(process.platform === "win32")(
    "piped into head -3 it prints 3 lines and exits 0 (POSIX pipe; skipped on Windows)",
    async () => {
      const p = Bun.spawn(
        [
          "bash",
          "-c",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
          '"$AKOU_BUN" "$AKOU_CLI" events -c "$AKOU_CALL" | head -3; echo "akou=${PIPESTATUS[0]}" >&2',
        ],
        {
          env: { ...env(), AKOU_BUN: process.execPath, AKOU_CLI: CLI, AKOU_CALL: SAVED },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(lines(out).length).toBe(3);
      for (const l of lines(out)) JSON.parse(l);
      expect(err).toContain("akou=0");
      // The closed pipe ends akou quietly: no broken-pipe error printed on the way out.
      expect(err).not.toContain("EPIPE");
    },
    30_000,
  );
});
