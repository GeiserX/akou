/**
 * Re-enhance after the final layer (docs/DESIGN.md section 5.2, ROADMAP M2): notes a provider wrote
 * from the live layer are written again when the final layer lands, unless a person or an agent
 * wrote them or the provider is the harness, in which case the window offers a button. The rule is
 * unit-tested here; the automatic run end to end is in the second half, with a fake provider.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import type { CompleteRequest, CompleteResult, Provider } from "../src/main/llm/provider.ts";
import { reEnhanceState } from "../src/main/notes/enhance.ts";
import { type AppRig, appRig, FAKE_MODELS } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";

function withNotes(by: string, model: string, final: "before" | "after" | "none"): LogBuilder {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  b.seg({ id: "l000001", text: "we move the build", w0: T0 + 1000 });
  const notes = () =>
    b.add({
      type: "enhanced",
      rev: 1,
      template: "standup",
      file: "enhanced/001-standup.md",
      coversSeq: 3,
      by,
      model,
      cites: ["l000001"],
    });
  if (final !== "before") notes();
  if (final !== "none") {
    b.add({ type: "final.started", pid: 1 });
    b.add({ type: "final.done", parts: [1], skipped: [] });
  }
  if (final === "before") notes();
  return b;
}

describe("reEnhanceState", () => {
  test("notes a provider wrote before the final layer are re-enhanced on their own, with their template", () => {
    const v = fold(withNotes("user", "fake/1.0", "after").events);
    expect(reEnhanceState(v, "openai-compatible")).toMatchObject({
      due: true,
      auto: true,
      template: "standup",
    });
  });

  test("notes written by hand, or a harness provider, get the button instead", () => {
    const hand = fold(withNotes("agent:claude-code", "agent:claude-code", "after").events);
    expect(reEnhanceState(hand, "anthropic")).toMatchObject({ due: true, auto: false });
    const harness = fold(withNotes("user", "claude-code/2.1.281", "after").events);
    expect(reEnhanceState(harness, "harness")).toMatchObject({
      due: true,
      auto: false,
      reason: "the harness runs only when you ask",
    });
  });

  test("nothing is due before the final layer, or once the notes were written from it", () => {
    expect(reEnhanceState(fold(withNotes("user", "m", "none").events), "anthropic").due).toBe(
      false,
    );
    expect(reEnhanceState(fold(withNotes("user", "m", "before").events), "anthropic").due).toBe(
      false,
    );
    const empty = new LogBuilder();
    empty.created();
    expect(reEnhanceState(fold(empty.events), "anthropic").due).toBe(false);
  });
});

class NotesProvider implements Provider {
  readonly id = "openai-compatible" as const;
  readonly prompts: string[] = [];
  async available() {
    return { ok: true as const, detail: "fake" };
  }
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.prompts.push(req.prompt);
    const id = /#([lf]\d{6,}) [^\n]*great/.exec(req.prompt)?.[1] ?? "l000000";
    return { text: `## Summary\n- they said ok great [#${id}]`, model: "fake/1.0" };
  }
}

describe("the automatic re-enhance, end to end", () => {
  const provider = new NotesProvider();
  let rig: AppRig;
  let wavDir: { dir: string; cleanup: () => void };

  beforeAll(async () => {
    wavDir = tempDir();
    const mic = concat(silence(0.3), speak(["hello", "world"]), silence(2));
    const call = concat(silence(1.2), speak(["ok", "great"], { voice: 2 }), silence(0.8));
    const n = Math.max(mic.length, call.length);
    const pad = (x: Float32Array) => concat(x, new Float32Array(n - x.length));
    const wav = join(wavDir.dir, "speech.wav");
    writeFileSync(wav, stereoWav(pad(mic), pad(call)));
    rig = await appRig({
      helperArgs: ["--wav", wav],
      provider,
      finalAudio: ({ parts }) => ({
        kind: "module",
        path: FAKE_MODELS,
        options: {
          parts: Object.fromEntries(
            parts.map((p) => [
              p,
              {
                mic: concat(silence(0.3), speak(["hello", "world"]), silence(1)),
                call: concat(silence(1.5), speak(["ok", "great"], { voice: 2 }), silence(0.5)),
              },
            ]),
          ),
        },
      }),
    });
  });

  afterAll(async () => {
    await rig?.close();
    wavDir?.cleanup();
  });

  test("notes enhanced during the call are written again from the final layer when it lands", async () => {
    const id = await rig.startCall({ title: "Daily standup" });
    await until(
      async () =>
        (await rig.api("GET", `/calls/${id}/transcript`)).body.lines.some((l: { text: string }) =>
          l.text.includes("great"),
        ),
      10_000,
      "a line",
    );
    const soFar = await rig.api("POST", `/calls/${id}/enhance`, { template: "standup" });
    expect(soFar.status).toBe(200);
    expect(soFar.body.cites[0]).toStartWith("l");
    expect((await rig.api("POST", `/calls/${id}/stop`)).status).toBe(200);
    await until(
      async () => {
        const events: LogEvent[] = (await rig.api("GET", `/calls/${id}/events`)).body.events;
        return events.some((e) => e.type === "enhanced" && e.rev === 2);
      },
      15_000,
      "the re-enhancement",
    );
    const events: LogEvent[] = (await rig.api("GET", `/calls/${id}/events`)).body.events;
    const done = events.find((e) => e.type === "final.done") as LogEvent;
    const again = events.find((e) => e.type === "enhanced" && e.rev === 2) as LogEvent & {
      template: string;
      by: string;
      cites: string[];
    };
    expect(again.seq).toBeGreaterThan(done.seq);
    expect(again).toMatchObject({ template: "standup", by: "app" });
    // Written from the final layer: it cites a final line.
    expect(again.cites[0]).toStartWith("f");
    const got = await rig.api("GET", `/calls/${id}/enhanced`);
    expect(got.body.enhanced.rev).toBe(2);
    expect(got.body.reEnhance).toMatchObject({ due: false });
    // Once: nothing else is written after it.
    await Bun.sleep(300);
    const after: LogEvent[] = (await rig.api("GET", `/calls/${id}/events`)).body.events;
    expect(after.filter((e) => e.type === "enhanced")).toHaveLength(2);
  }, 30_000);
});
