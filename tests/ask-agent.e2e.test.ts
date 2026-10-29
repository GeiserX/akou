/**
 * A question typed in the ask box reaches the agent following the call (docs/DESIGN.md sections
 * 5.3 and 5.5), end to end: a headless app with the fake helper and a fake provider, a fake agent
 * long-polling `GET /calls/{id}/events?types=ask` as `akou events -f --type ask --client` does,
 * the user's question asked through the window's bridge (`by: "user"`), and the agent's answer
 * posted to `POST /calls/{id}/asks/{ask}/answer`. No test runs a real harness.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { sseFrames } from "../src/core/net/sse.ts";
import { HarnessProvider } from "../src/main/llm/harness.ts";
import {
  type CompleteRequest,
  type CompleteResult,
  type Provider,
  ProviderError,
  type ProviderId,
} from "../src/main/llm/provider.ts";
import { Bridge } from "../src/main/window/bridge.ts";
import { PageServer } from "../src/main/window/page-server.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;
const FIX = join(import.meta.dir, "fixtures", "harness");
const FAKE_HARNESS = join(import.meta.dir, "fixtures", "fake-harness.ts");

/** The app's provider, switchable per test: an answer, nothing (`none`), a slow run, a harness. */
class SwitchProvider implements Provider {
  none = false;
  inner: Provider | null = null;
  delayMs = 0;
  readonly requests: CompleteRequest[] = [];
  aborted = 0;
  get id(): ProviderId {
    return this.none ? "none" : "harness";
  }
  async available() {
    if (this.none) {
      return {
        ok: false as const,
        kind: "missing" as const,
        reason: "no provider is configured (provider.kind is none); akou shows excerpts only",
      };
    }
    return this.inner ? this.inner.available() : { ok: true as const, detail: "fake" };
  }
  async complete(
    req: CompleteRequest,
    onToken: (t: string) => void,
    signal: AbortSignal,
  ): Promise<CompleteResult> {
    this.requests.push(req);
    if (this.inner) return this.inner.complete(req, onToken, signal);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          this.aborted++;
          resolve();
        });
      });
      if (signal.aborted) throw new ProviderError("cancelled", "cancelled");
    }
    onToken("from the provider");
    return { text: "from the provider", model: "fake/1.0" };
  }
}

const provider = new SwitchProvider();
let rig: AppRig;
let wavDir: { dir: string; cleanup: () => void };
let id: string;
let lineId: string;

function writeSpeech(dir: string): string {
  const mic = concat(silence(0.3), speak(["hello", "world"]), silence(2.2));
  const call = concat(silence(1.1), speak(["deploy", "to", "hetzner"], { voice: 2 }), silence(0.6));
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
  const path = join(dir, "speech.wav");
  writeFileSync(path, stereoWav(pad(mic), pad(call)));
  return path;
}

async function events(): Promise<LogEvent[]> {
  return (await rig.api("GET", `/calls/${id}/events`)).body.events;
}

async function setWait(seconds: number): Promise<void> {
  const r = await rig.api("PATCH", "/config", { "ask.agentWaitSeconds": seconds });
  expect(r.status).toBe(200);
}

/** POSTs an answer as an agent named `client`. */
function answerAs(client: string, ask: string, text: string) {
  return rig.api("POST", `/calls/${id}/asks/${ask}/answer`, { text }, { "x-akou-client": client });
}

interface Frame {
  event: string;
  // biome-ignore lint/suspicious/noExplicitAny: the frames' JSON, read by the assertions.
  data: any;
  ms: number;
}

/** The user's question, through the window's bridge as the ask box sends it (`by: "user"`). */
async function userAsk(question: string): Promise<Frame[]> {
  const frames: Frame[] = [];
  const t0 = performance.now();
  const push = (event: string) => (data: unknown) =>
    frames.push({ event, data, ms: performance.now() - t0 });
  await new Bridge(rig.app).ask(id, question, {
    excerpts: push("excerpts"),
    routed: push("routed"),
    token: (t) => push("token")({ t }),
    answer: push("answer"),
    error: push("error"),
  });
  return frames;
}

/**
 * A fake agent: long-polls the call's `ask` events as `akou events -f --type ask --client NAME`
 * does, and hands each user ask to `onAsk`. `stop` ends it.
 */
function fakeAgent(client: string, onAsk: (ask: { id: string; q: string }) => void) {
  const ac = new AbortController();
  let cursor = 0;
  const seen = new Set<string>();
  const loop = (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(
          `http://127.0.0.1:${rig.port}/v1/calls/${id}/events?types=ask&wait=5&after=${cursor}`,
          {
            headers: { authorization: `Bearer ${rig.token}`, "x-akou-client": client },
            signal: ac.signal,
          },
        );
        const b = (await res.json()) as { events: LogEvent[]; cursor: number };
        cursor = b.cursor;
        for (const e of b.events) {
          if (e.type === "ask" && e.by === "user" && !seen.has(e.id)) {
            seen.add(e.id);
            onAsk({ id: e.id, q: e.q });
          }
        }
      } catch {}
    }
  })();
  return {
    ready: () =>
      until(
        async () => ((await rig.api("GET", `/calls/${id}`)).body.listening ?? []).includes(client),
        5000,
        `${client} to be listening`,
      ),
    stop: async () => {
      ac.abort();
      await loop;
    },
  };
}

beforeAll(async () => {
  wavDir = tempDir();
  rig = await appRig({ helperArgs: ["--wav", writeSpeech(wavDir.dir)], provider });
  id = await rig.startCall({ title: "Daily standup" });
  await until(
    async () =>
      (await rig.api("GET", `/calls/${id}/transcript`)).body.lines.some(
        (l: { ch: string }) => l.ch === "call",
      ),
    10_000,
    "a call-channel line",
  );
  const lines = (await rig.api("GET", `/calls/${id}/transcript`)).body.lines;
  lineId = lines.find((x: { ch: string }) => x.ch === "call").id;
}, LONG);

afterAll(async () => {
  await rig?.close();
  wavDir?.cleanup();
});

// First in the file: an agent that stops its watch still counts for the 35 s grace (listeners.ts),
// so the case with nobody listening runs before any agent has watched this call.
describe("[decision] Waiting for an agent that has left: nobody watching", () => {
  test(
    "no agent listening: the provider runs at once, and `routed` says no agent follows the call",
    async () => {
      await setWait(10);
      expect((await rig.api("GET", `/calls/${id}`)).body.listening).toEqual([]);
      const frames = await userAsk("deploy?");
      expect(frames.some((f) => f.event === "routed" && f.data.to === "agent")).toBe(false);
      expect(frames.find((f) => f.event === "routed")?.data).toEqual({
        to: "provider",
        why: "no agent is following this call",
      });
      expect(frames.at(-1)?.data).toMatchObject({ answered: true, model: "fake/1.0" });
      expect(frames.at(-1)?.ms).toBeLessThan(5000);
    },
    LONG,
  );
});

describe("[decision] A question typed in the ask box never reaches the agent following the call", () => {
  test(
    "with an agent long-polling `ask`, the user's question goes to it, and its answer fills the box with `by` and citations; the provider is never run",
    async () => {
      await setWait(10);
      const before = provider.requests.length;
      const agent = fakeAgent("test-agent", (a) => {
        void answerAs("test-agent", a.id, `Deploy to Hetzner, at #${lineId} (and #l999999).`);
      });
      try {
        await agent.ready();
        const st = await rig.api("GET", "/status");
        expect(st.body.live.listening).toEqual(["test-agent"]);
        const frames = await userAsk("what about deploy?");
        expect(frames.map((f) => f.event)).toEqual(["excerpts", "routed", "answer"]);
        expect(frames[1]?.data).toMatchObject({
          to: "agent",
          clients: ["test-agent"],
          waitSeconds: 10,
        });
        expect(frames[2]?.data).toMatchObject({
          answered: true,
          kind: "answer",
          by: "agent:test-agent",
          cites: [lineId],
        });
        expect(provider.requests.length).toBe(before);
        const ans = (await events()).filter(
          (e) => e.type === "answer" && e.ask === frames[2]?.data.ask,
        );
        expect(ans).toHaveLength(1);
        expect(ans[0]).toMatchObject({
          by: "agent:test-agent",
          cites: [lineId],
          pack: { mode: "agent" },
        });
      } finally {
        await agent.stop();
      }
    },
    LONG,
  );
});

describe("[decision] A question typed in the ask box never reaches the agent following the call: the window in a browser", () => {
  test(
    "the headless app's window asks over its page server with its session: the question is the user's and goes to the agent; a plain API client naming itself user does not",
    async () => {
      await setWait(10);
      const before = provider.requests.length;
      const page = new PageServer({ bridge: new Bridge(rig.app), bundle: new Map() });
      const agent = fakeAgent("browser-agent", (a) => {
        void answerAs("browser-agent", a.id, "Deploy to Hetzner.");
      });
      try {
        await agent.ready();
        // The page's own way in, as `src/ui/web.ts` does it: the one-time code for a session.
        const code = /#k=(.+)$/.exec(page.openUrl(id))?.[1];
        const s = await fetch(`${page.origin}/session`, {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          body: JSON.stringify({ code }),
        });
        const { session } = (await s.json()) as { session: string };
        const r = await fetch(`${page.origin}/api/v1/calls/${id}/ask`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${session}`,
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
          },
          body: JSON.stringify({ question: "deploy from the browser?", stream: true }),
        });
        expect(r.status).toBe(200);
        const frames: { event: string; data: unknown }[] = [];
        for await (const f of sseFrames(r.body as ReadableStream<Uint8Array>)) {
          if (f.event !== "comment") frames.push({ event: f.event, data: JSON.parse(f.data) });
        }
        expect(frames.find((f) => f.event === "routed")?.data).toMatchObject({
          to: "agent",
          clients: ["browser-agent"],
        });
        expect(frames.at(-1)?.data).toMatchObject({ answered: true, by: "agent:browser-agent" });
        expect(provider.requests.length).toBe(before);
        const asked = (await events()).filter(
          (e) => e.type === "ask" && e.q === "deploy from the browser?",
        );
        expect(asked.map((e) => (e as { by?: string }).by)).toEqual(["user"]);
        // The control: an API client cannot claim to be the user with a header, so its question
        // is an agent's and never waits for the agent following the call.
        const api = await rig.api(
          "POST",
          `/calls/${id}/ask`,
          { question: "deploy as the user?" },
          { "x-akou-client": "user" },
        );
        expect(api.body).toMatchObject({ answered: true, model: "fake/1.0" });
        const claimed = (await events()).filter(
          (e) => e.type === "ask" && e.q === "deploy as the user?",
        );
        expect(claimed.map((e) => (e as { by?: string }).by)).toEqual(["agent:user"]);
      } finally {
        await agent.stop();
        await page.stop();
      }
    },
    LONG,
  );
});

describe("[decision] Two answers to one question", () => {
  test(
    "provider none, an agent that never answers: excerpts within 300 ms, the line names the agent's route, and its late answer is added",
    async () => {
      await setWait(1);
      provider.none = true;
      const agent = fakeAgent("slow-agent", () => {});
      try {
        await agent.ready();
        const frames = await userAsk("what about deploy?");
        expect(frames[0]?.event).toBe("excerpts");
        expect(frames[0]?.ms).toBeLessThan(300);
        const last = frames.at(-1);
        expect(last?.event).toBe("answer");
        expect(last?.data).toMatchObject({ answered: false, kind: "excerpts" });
        expect(last?.data.agentReason).toBe("slow-agent did not answer within 1 s");
        expect(last?.ms).toBeGreaterThanOrEqual(900);
        // The agent answers late: written, and it learns the box showed only the excerpts.
        const late = await answerAs("slow-agent", last?.data.ask, "Late, but: deploy to Hetzner.");
        expect(late.status).toBe(200);
        expect(late.body.others).toEqual([{ by: "akou", model: "", kind: "excerpts" }]);
        const log = await events();
        expect(
          log.some(
            (e) => e.type === "answer" && e.ask === last?.data.ask && e.by === "agent:slow-agent",
          ),
        ).toBe(true);
      } finally {
        provider.none = false;
        await agent.stop();
      }
    },
    LONG,
  );

  test(
    "a fake claude out of quota and an agent that never answers: both routes are named, with the reset time; a late answer still lands",
    async () => {
      await setWait(1);
      provider.inner = new HarnessProvider({
        target: () => ({
          kind: "claude",
          command: [
            process.execPath,
            FAKE_HARNESS,
            join(FIX, "claude-usage-limit.synthetic.jsonl"),
          ],
          version: "2.1.281",
        }),
        env: { ...process.env, FAKE_EXIT: "1" },
      });
      const agent = fakeAgent("slow-agent-2", () => {});
      try {
        await agent.ready();
        const frames = await userAsk("deploy?");
        const last = frames.at(-1);
        expect(last?.data).toMatchObject({ answered: false, errorKind: "exhausted" });
        expect(last?.data.agentReason).toBe("slow-agent-2 did not answer within 1 s");
        expect(last?.data.reason).toMatch(/usage limit is reached until \d\d:\d\d/);
        expect(frames.find((f) => f.event === "routed" && f.data.to === "provider")?.data.why).toBe(
          "slow-agent-2 did not answer within 1 s",
        );
        const late = await answerAs("slow-agent-2", last?.data.ask, "Deploy to Hetzner.");
        expect(late.status).toBe(200);
      } finally {
        provider.inner = null;
        await agent.stop();
      }
    },
    LONG,
  );

  test(
    "an agent that answers while the provider runs stops that run, and only its answer is shown",
    async () => {
      await setWait(1);
      provider.delayMs = 8000;
      const abortedBefore = provider.aborted;
      let askId = "";
      const agent = fakeAgent("late-agent", (a) => {
        askId = a.id;
      });
      try {
        await agent.ready();
        const asking = userAsk("deploy?");
        // After the wait the provider starts; then the agent answers.
        await until(
          async () => askId !== "" && provider.requests.length > 0,
          5000,
          "the provider to run",
        );
        await Bun.sleep(1200);
        expect((await answerAs("late-agent", askId, "Agent: deploy to Hetzner.")).status).toBe(200);
        const frames = await asking;
        const last = frames.at(-1);
        expect(last?.data).toMatchObject({ answered: true, by: "agent:late-agent" });
        expect(provider.aborted).toBe(abortedBefore + 1);
        const answers = (await events()).filter((e) => e.type === "answer" && e.ask === askId);
        expect(answers.map((e) => (e as { by?: string }).by)).toEqual(["agent:late-agent"]);
      } finally {
        provider.delayMs = 0;
        await agent.stop();
      }
    },
    LONG,
  );

  test("the answer route: 404 for an unknown ask, 409 for the same author twice, two agents both written", async () => {
    const asked = await rig.api("POST", `/calls/${id}/ask`, { question: "who deploys?" });
    const ask = asked.body.ask as string;
    expect((await answerAs("one", "q9999999", "x")).body.error).toBe("no_ask");
    const first = await answerAs("one", ask, "Ben does.");
    expect(first.status).toBe(200);
    expect(first.body.others).toEqual([{ by: "akou", model: "fake/1.0", kind: "model" }]);
    const again = await answerAs("one", ask, "Ben does, again.");
    expect([again.status, again.body.error]).toEqual([409, "already_answered"]);
    expect((await answerAs("two", ask, "Ben.")).status).toBe(200);
    const empty = await answerAs("three", ask, "  ");
    expect([empty.status, empty.body.error]).toEqual([400, "bad_field"]);
  });
});

describe("[decision] An agent waits on its own question", () => {
  test(
    "with a listener present, an agent's `akou ask` goes straight to the provider: no routed event, no wait",
    async () => {
      await setWait(10);
      const before = provider.requests.length;
      const agent = fakeAgent("watcher", () => {});
      try {
        await agent.ready();
        const t0 = performance.now();
        const r = await rig.api("POST", `/calls/${id}/ask`, { question: "deploy?" });
        expect(r.body).toMatchObject({ answered: true, model: "fake/1.0" });
        expect(r.body.by).toBeUndefined();
        expect(performance.now() - t0).toBeLessThan(5000);
        expect(provider.requests.length).toBe(before + 1);
      } finally {
        await agent.stop();
      }
    },
    LONG,
  );
});

describe("[decision] Waiting for an agent that has left", () => {
  test(
    "positive control: `ask.agentWaitSeconds` 0 never waits, with an agent listening",
    async () => {
      await setWait(0);
      const agent = fakeAgent("ignored", () => {});
      try {
        await agent.ready();
        const frames = await userAsk("deploy?");
        expect(frames.some((f) => f.event === "routed" && f.data.to === "agent")).toBe(false);
        expect(frames.at(-1)?.data).toMatchObject({ answered: true, model: "fake/1.0" });
      } finally {
        await setWait(30);
        await agent.stop();
      }
    },
    LONG,
  );
});

// Last in the file: it ends the call every other case asks about.
describe("[decision] Waiting for an agent that has left: the call ended", () => {
  test(
    "an agent whose watch stopped on `call.ended` is not waited for within the grace: the provider answers at once",
    async () => {
      await setWait(10);
      // As `akou events -f --type ask` does: poll `ask` and the call's end, stop after the end,
      // with a poll that returns normally (no hang-up).
      let cursor = 0;
      const watch = (async () => {
        for (;;) {
          const res = await fetch(
            `http://127.0.0.1:${rig.port}/v1/calls/${id}/events?types=ask,call.ended,call.failed&wait=5&after=${cursor}`,
            { headers: { authorization: `Bearer ${rig.token}`, "x-akou-client": "watcher" } },
          );
          const b = (await res.json()) as { events: LogEvent[]; cursor: number };
          cursor = b.cursor;
          if (b.events.some((e) => e.type === "call.ended" || e.type === "call.failed")) return;
        }
      })();
      await until(
        async () =>
          ((await rig.api("GET", `/calls/${id}`)).body.listening ?? []).includes("watcher"),
        5000,
        "watcher to be listening",
      );
      expect((await rig.api("POST", `/calls/${id}/stop`)).status).toBe(200);
      await watch;
      expect((await rig.api("GET", `/calls/${id}`)).body.listening).toEqual([]);
      const frames = await userAsk("catch me up");
      expect(frames.find((f) => f.event === "routed")?.data).toEqual({
        to: "provider",
        why: "no agent is following this call",
      });
      expect(frames.at(-1)?.data).toMatchObject({ answered: true, model: "fake/1.0" });
      expect(frames.at(-1)?.ms).toBeLessThan(5000);
    },
    LONG,
  );
});
