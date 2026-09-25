/**
 * The CLI on a real terminal (docs/ux/CLI.md sections 8 and 11): the real `akou` entry point under
 * a pseudo-terminal against a headless app, every byte read raw.
 *
 * - CLI-20: colour on a terminal only, and never colour alone.
 * - CLI-24: `akou watch`, the live call in a terminal.
 *
 * Bun's pseudo-terminal is POSIX only, so the terminal cases skip on Windows; the piped halves
 * run everywhere.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CompleteRequest, CompleteResult, Provider } from "../src/main/llm/provider.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cliChild } from "./cli-helpers.ts";
import { ptyAkou } from "./pty-helpers.ts";

const LONG = 60_000;
const NO_PTY = process.platform === "win32";
const ESC = "\x1b";

/** Writes one committed live line through the call's one writer, as the live pass would. */
function seg(rig: AppRig, call: string, n: number, ch: "mic" | "call", spk: string, text: string) {
  const w0 = Date.now() - 60_000 + n * 1000;
  return rig.app.write(call, {
    type: "seg",
    id: `l9${String(n).padStart(5, "0")}`,
    rev: 1,
    layer: "live",
    part: 1,
    ch,
    spk,
    a0: n,
    a1: n + 0.9,
    w0,
    w1: w0 + 900,
    text,
    model: "fake",
  } as never);
}

/** The speaker label of each `HH:MM:SS NAME: text` row, with the colour code around it. */
function speakerColours(out: string): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  const e = "\\x1b";
  const row = new RegExp(`\\d\\d:\\d\\d:\\d\\d ${e}\\[(\\d+)m([^${e}]+)${e}\\[0m: `, "g");
  for (const m of out.matchAll(row)) {
    const name = m[2] as string;
    seen.set(name, (seen.get(name) ?? new Set()).add(m[1] as string));
  }
  return seen;
}

describe("[CLI-20] Colour on a terminal only, and never colour alone", () => {
  let rig: AppRig;
  let id: string;
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    rig = await appRig();
    env = { ...process.env, ...rig.env, NO_COLOR: undefined };
    id = await rig.startCall({ title: "Colours", withoutModels: true });
    await seg(rig, id, 1, "mic", "you", "can we move the release");
    await seg(rig, id, 2, "call", "c2", "thursday works");
    await seg(rig, id, 3, "call", "c3", "I can take the migration");
    await seg(rig, id, 4, "call", "c2", "then thursday it is");
    await seg(rig, id, 5, "mic", "you", "great");
    await seg(rig, id, 6, "call", "c3", "done by tomorrow");
  }, LONG);
  afterAll(() => rig.close());

  test.skipIf(NO_PTY)(
    "on a terminal, tail colours each speaker, one colour per speaker across lines (not on Windows: no pty)",
    async () => {
      const t = ptyAkou(env, ["tail", "-c", id]);
      expect(await t.exited).toBe(0);
      const colours = speakerColours(t.bytes());
      expect([...colours.keys()].sort()).toEqual(["Ana", "Speaker 2", "Speaker 3"]);
      for (const [name, codes] of colours) expect([name, codes.size]).toEqual([name, 1]);
      const distinct = new Set([...colours.values()].map((s) => [...s][0]));
      expect(distinct.size).toBe(3);
      // The words are all there, colour or not.
      expect(t.bytes()).toContain("then thursday it is");
    },
    LONG,
  );

  test.skipIf(NO_PTY)(
    "NO_COLOR, TERM=dumb and --format md turn it off on a terminal (not on Windows: no pty)",
    async () => {
      for (const extra of [{ NO_COLOR: "1" }, { TERM: "dumb" }]) {
        const t = ptyAkou({ ...env, ...extra }, ["tail", "-c", id]);
        expect(await t.exited).toBe(0);
        expect(t.bytes()).toContain("then thursday it is");
        expect([extra, t.bytes().includes(ESC)]).toEqual([extra, false]);
      }
      // An empty NO_COLOR is unset, as no-color.org says: colour stays on.
      const empty = ptyAkou({ ...env, NO_COLOR: "" }, ["tail", "-c", id]);
      expect(await empty.exited).toBe(0);
      expect(empty.bytes()).toContain(ESC);
    },
    LONG,
  );

  test("piped, tail has no escape byte", async () => {
    const r = await cliChild(env, ["tail", "-c", id]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("then thursday it is");
    expect(r.out.includes(ESC)).toBe(false);
  });

  test.skipIf(NO_PTY)(
    "status on a terminal shows a dead channel in red and with the word dead (not on Windows: no pty)",
    async () => {
      const dead = await appRig({ helperArgs: ["--call-dead-at", "0.3"] });
      try {
        await dead.startCall({ title: "Dead side", withoutModels: true });
        await until(
          async () =>
            ((await dead.api("GET", "/status")).body.live?.health ?? []).some(
              (h: { ch: string; state: string }) => h.ch === "call" && h.state === "dead",
            ),
          15_000,
          "the call side to be dead",
        );
        const denv = { ...process.env, ...dead.env, NO_COLOR: undefined };
        const t = ptyAkou(denv, ["status"]);
        expect(await t.exited).toBe(0);
        expect(t.bytes()).toContain("call: \x1b[31mdead\x1b[0m");
        // Positive control of the other half: piped, the word stays and the colour goes.
        const piped = await cliChild(denv, ["status"]);
        expect(piped.out).toMatch(/^ {2}call: dead/m);
        expect(piped.out.includes(ESC)).toBe(false);
      } finally {
        await dead.close();
      }
    },
    LONG,
  );
});

class FakeProvider implements Provider {
  readonly id = "harness" as const;
  readonly questions: string[] = [];
  async available() {
    return { ok: true as const, detail: "fake" };
  }
  async complete(req: CompleteRequest, onToken: (t: string) => void): Promise<CompleteResult> {
    this.questions.push(JSON.stringify(req));
    const text = "The release moves to Thursday, if the migration lands tomorrow.";
    onToken(text.slice(0, 20));
    onToken(text.slice(20));
    return { text, model: "fake/1.0" };
  }
}

describe("[CLI-24] Follow and ask a live call in the terminal with akou watch", () => {
  const provider = new FakeProvider();
  let rig: AppRig;
  let id: string;
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    rig = await appRig({ provider });
    env = { ...process.env, ...rig.env, NO_COLOR: undefined };
    // No live pass: every line and the in-progress line are the test's own.
    id = await rig.startCall({ title: "Weekly sync", withoutModels: true });
    await seg(rig, id, 1, "mic", "you", "Can we move the release to Thursday?");
    await seg(rig, id, 2, "call", "c2", "Thursday works if the migration lands tomorrow.");
  }, LONG);
  afterAll(() => rig.close());

  test.skipIf(NO_PTY)(
    "lines in order with wall times, the in-progress line redrawn in place, ask, /note, /stop and Ctrl-D (not on Windows: no pty)",
    async () => {
      const t = ptyAkou(env, ["watch"]);
      try {
        await t.waitFor('Recording "Weekly sync" in work');
        // The committed lines so far, in order, each with its wall time.
        const first = await t.waitFor("Can we move the release to Thursday?");
        const second = await t.waitFor("Thursday works if the migration lands tomorrow.");
        expect(first).toBeLessThan(second);
        expect(t.bytes()).toMatch(/\d\d:\d\d:\d\d \S*Ana\S*: Can we move/);
        await t.waitFor("ask> ");

        // A line committed while watching prints above the prompt.
        await seg(rig, id, 3, "call", "c3", "I can take the migration.");
        await t.waitFor("I can take the migration.");

        // The in-progress line: two renders of one open segment, redrawn in place.
        const view = (await rig.app.call(id)).view;
        const w0 = Date.now();
        view.provisional.update({
          ch: "call",
          part: 1,
          pseq: 1,
          text: "so the",
          w0,
          at: Date.now(),
          spk: "c2",
        });
        const a = await t.waitFor("so the");
        view.provisional.update({
          ch: "call",
          part: 1,
          pseq: 2,
          text: "so the plan is",
          w0,
          at: Date.now(),
          spk: "c2",
        });
        const b = await t.waitFor("so the plan is", 10_000, a + 1);
        const between = t.bytes().slice(a + "so the".length, b);
        expect(between).toContain("\r");
        expect(between).toContain("\x1b[2K");
        expect(between.includes("\n")).toBe(false);
        // It gets its newline only when it commits.
        const w = w0 + 500;
        await rig.app.write(id, {
          type: "seg",
          id: "l900004",
          rev: 1,
          layer: "live",
          part: 1,
          ch: "call",
          spk: "c2",
          a0: 4,
          a1: 5,
          w0,
          w1: w,
          text: "so the plan is final.",
          model: "fake",
        } as never);
        const committed = await t.waitFor("so the plan is final.", 10_000, b);
        expect(t.bytes().slice(a, committed).includes("\n")).toBe(false);
        await until(
          async () => /^so the plan is final\.\r*\n/.test(t.bytes().slice(committed)),
          5000,
          "the committed line's newline",
        );

        // A question streams an answer from the provider.
        const asked = t.bytes().length;
        t.type("what did we decide?\r");
        await t.waitFor(
          "The release moves to Thursday, if the migration lands tomorrow.",
          10_000,
          asked,
        );
        expect(provider.questions.length).toBe(1);

        // `/note` is the CLI's `note`, bound to this call, typed by the user.
        t.type("/note hello\r");
        await until(
          async () =>
            (
              (await rig.api("GET", `/calls/${id}/events`)).body.events as {
                type: string;
                text?: string;
                by?: string;
              }[]
            ).some((e) => e.type === "note" && e.text === "hello" && e.by === "user"),
          10_000,
          "a note by the user",
        );

        // `/stop` asks first; Enter alone is no.
        const stopAt = t.bytes().length;
        t.type("/stop\r");
        await t.waitFor('Stop recording "Weekly sync"? [y/N]', 10_000, stopAt);
        t.type("\r");
        await t.waitFor("still recording", 10_000, stopAt);
        expect((await rig.api("GET", `/calls/${id}`)).body.state).toBe("recording");

        // Ctrl-D leaves, and the recording goes on.
        t.type("\x04");
        expect(await t.exited).toBe(0);
        const status = await cliChild(env, ["status", "--json"]);
        expect(status.code).toBe(0);
        expect(JSON.parse(status.out).live).toMatchObject({ call: id, state: "recording" });
      } finally {
        t.kill();
      }
    },
    LONG,
  );

  test("piped, it exits 64 and names `akou tail -f`", async () => {
    const r = await cliChild(env, ["watch"]);
    expect(r.code).toBe(64);
    expect(r.err).toContain("akou watch needs a terminal");
    expect(r.err).toContain("`akou tail -f`");
    // It refused before asking the app for anything: the call is untouched.
    expect((await rig.api("GET", `/calls/${id}`)).body.state).toBe("recording");
  });
});
