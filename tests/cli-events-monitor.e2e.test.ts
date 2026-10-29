/**
 * The agent's monitor (docs/ux/PROGRAMMABILITY.md PG-K3, PG-S4, PG-Z4):
 * `akou events -f --type health,share.started,share.stopped --mention` against a live headless
 * call. An hour of speech prints nothing; a dead capture prints at once; the user's name said on
 * the call channel prints one `mention` row with its time and speaker. No transcript text is ever
 * printed, and a positive control proves the leak check catches text when a filter lets it through.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mentions, nameWords } from "../src/core/mention.ts";
import { runCli } from "../src/main/cli/cli.ts";
import { EXIT } from "../src/main/cli/client.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";

const MONITOR = ["events", "-f", "--type", "health,share.started,share.stopped", "--mention"];
/** Every fake line carries this word, so any transcript text in the output is found. */
const MARK = "quokka";
/** An hour of speech, one committed line every 5 s of wall time. */
const LINES = 720;

let rig: AppRig;
let id: string;
const texts: string[] = [];

/** Writes one committed live line through the call's one writer, as the live pass would. */
function seg(n: number, ch: "mic" | "call", text: string, w0: number) {
  texts.push(text);
  return rig.app.write(id, {
    type: "seg",
    id: `l8${String(n).padStart(5, "0")}`,
    rev: 1,
    layer: "live",
    part: 1,
    ch,
    spk: ch === "mic" ? "you" : "c1",
    a0: n * 5,
    a1: n * 5 + 4,
    w0,
    w1: w0 + 4000,
    text,
    model: "fake",
  } as never);
}

/** The output lines that hold transcript text or a `seg` event: what the monitor must never print. */
function leaks(out: readonly string[]): string[] {
  return out.filter((l) => l.includes(MARK) || texts.some((t) => l.includes(t)) || /"seg"/.test(l));
}

/** Runs the CLI in this process until `stop` aborts it; each printed line with when it came. */
function run(argv: string[]) {
  const ctl = new AbortController();
  const out: { at: number; line: string }[] = [];
  const done = runCli(
    [...argv, "-c", id],
    {
      env: { ...process.env, ...rig.env },
      out: (t) => {
        for (const line of t.split("\n"))
          if (line !== "") out.push({ at: performance.now(), line });
      },
      err: () => {},
      signal: ctl.signal,
    },
    { launch: null },
  );
  return { out, done, stop: () => ctl.abort() };
}

beforeAll(async () => {
  // The user's name; the rig's own default is "Ana".
  rig = await appRig({ settings: { "user.name": "Ana García" } });
  id = await rig.startCall({ title: "Monitor", withoutModels: true });
}, 30_000);

afterAll(async () => {
  await rig?.close();
});

describe("[PG-S4] the mention match", () => {
  test("any word of the name, whole, ignoring case and accents", () => {
    const w = nameWords("Ana García");
    expect(w).toEqual(["ana", "garcia"]);
    expect(mentions("Can ana take it?", w)).toBe(true);
    expect(mentions("ask GARCIA", w)).toBe(true);
    expect(mentions("Anabel will", w)).toBe(false);
    expect(mentions("anything", nameWords(""))).toBe(false);
    // Particles are not the name: they are in most Spanish lines.
    const particles = nameWords("María de la Fuente");
    expect(particles).toEqual(["maria", "fuente"]);
    expect(mentions("vamos de la casa", particles)).toBe(false);
    expect(mentions("fuente", particles)).toBe(true);
  });
});

describe("[PG-K3] the monitor hears dead capture and mentions, never speech", () => {
  test("an hour of speech prints nothing, a dead capture prints within 2 s, a mention prints its time and speaker", async () => {
    const m = run(MONITOR);
    // Let the follower attach before anything is written.
    await Bun.sleep(300);
    const start = Date.now() - 3_600_000;
    for (let i = 0; i < LINES; i++) {
      // The name said on the mic channel is the user speaking: no mention.
      const mic = i % 2 === 0;
      const text = mic && i % 10 === 0 ? `${MARK} ${i} Ana here` : `${MARK} ${i} on the roadmap`;
      await seg(i, mic ? "mic" : "call", text, start + i * 5000);
    }
    await Bun.sleep(1000);
    expect(m.out.map((o) => o.line)).toEqual([]);

    const t0 = performance.now();
    await rig.app.write(id, {
      type: "health",
      part: 1,
      ch: "call",
      state: "dead",
      silentFor: 12,
      rebuilds: 1,
      detail: "the call tap stopped",
    } as never);
    await until(async () => m.out.length > 0, 2000, "the dead capture to be printed");
    const dead = m.out[0] as { at: number; line: string };
    expect(dead.at - t0).toBeLessThan(2000);
    expect(JSON.parse(dead.line)).toMatchObject({ type: "health", ch: "call", state: "dead" });

    const w0 = Date.now();
    await seg(LINES, "call", `${MARK} can Ana take the migration`, w0);
    await until(async () => m.out.length > 1, 2000, "the mention to be printed");
    const mention = JSON.parse((m.out[1] as { line: string }).line);
    expect(mention).toMatchObject({
      type: "mention",
      call: id,
      line: `l8${String(LINES).padStart(5, "0")}`,
    });
    expect(mention.speaker).toBe("Speaker 1");
    expect(mention.time).toMatch(/^\d\d:\d\d(:\d\d)?$/);
    expect(mention.w0).toBe(w0);
    expect(mention.text).toBeUndefined();

    m.stop();
    expect(await m.done).toBe(EXIT.ok);
    expect(m.out.length).toBe(2);
    expect(leaks(m.out.map((o) => o.line))).toEqual([]);
  }, 60_000);

  test("positive control: a filter that lets seg through fails the leak check", async () => {
    const m = run(["events", "--type", "health,seg", "--mention"]);
    expect(await m.done).toBe(EXIT.ok);
    expect(leaks(m.out.map((o) => o.line)).length).toBeGreaterThan(0);
  });
});

describe("agent.summary_every_minutes: how often a following agent may sum the call up", () => {
  /** `akou ARGV` against the rig: the exit code and what it printed. */
  async function akou(argv: string[], json = false) {
    const out: string[] = [];
    const code = await runCli(
      [...argv, ...(json ? ["--json"] : [])],
      { env: { ...process.env, ...rig.env }, out: (t) => out.push(t), err: () => {} },
      { launch: null },
    );
    return { code, out: out.join("\n") };
  }

  test("config get reads it: 10 by default, 0 turns summaries off, 121 is refused", async () => {
    expect(await akou(["config", "get", "agent.summary_every_minutes"])).toEqual({
      code: EXIT.ok,
      out: "10",
    });
    expect((await akou(["config", "set", "agent.summary_every_minutes", "0"])).code).toBe(EXIT.ok);
    const off = await akou(["config", "get", "agent.summary_every_minutes"], true);
    expect(JSON.parse(off.out)).toEqual({ key: "agent.summary_every_minutes", value: 0 });
    expect((await akou(["config", "set", "agent.summary_every_minutes", "121"])).code).toBe(
      EXIT.usage,
    );
    // A string setting prints bare, for a shell to use as is.
    expect((await akou(["config", "get", "user.name"])).out).toBe("Ana García");
    expect((await akou(["config", "get", "agent.nope"])).code).toBe(EXIT.usage);
  });
});

describe("[decision] A question typed in the ask box never reaches the agent following the call: a watch started again never hands back one already answered", () => {
  test("only the open question is printed from before the watch; a new one prints when it lands; with answer asked for too, both print", async () => {
    const answer = (ask: string) =>
      rig.app.write(id, {
        type: "answer",
        ask,
        text: "Settled.",
        cites: [],
        model: "fake/1.0",
        pack: { mode: "whole-call", tokens: 10 },
      } as never);
    await rig.app.write(id, {
      type: "ask",
      id: "w-old",
      q: "answered before?",
      by: "user",
    } as never);
    await answer("w-old");
    await rig.app.write(id, { type: "ask", id: "w-open", q: "still open?", by: "user" } as never);
    const asks = (out: readonly { line: string }[]) =>
      out
        .map((o) => JSON.parse(o.line))
        .filter((e) => e.type === "ask")
        .map((e) => e.id);

    const m = run(["events", "-f", "--type", "ask"]);
    await until(async () => asks(m.out).includes("w-open"), 5000, "the open question");
    await Bun.sleep(300);
    expect(asks(m.out)).toEqual(["w-open"]);
    await rig.app.write(id, { type: "ask", id: "w-new", q: "and now?", by: "user" } as never);
    await until(async () => asks(m.out).includes("w-new"), 5000, "the new question");
    expect(asks(m.out)).toEqual(["w-open", "w-new"]);
    // Only what was asked for is printed: the answers it read to tell are not.
    expect(m.out.some((o) => JSON.parse(o.line).type === "answer")).toBe(false);
    m.stop();
    await m.done;

    // Positive control: a reader that asks for the answers too gets every question.
    const all = run(["events", "-f", "--type", "ask,answer"]);
    await until(async () => asks(all.out).includes("w-new"), 5000, "every question");
    expect(asks(all.out)).toContain("w-old");
    all.stop();
    await all.done;
  });
});
