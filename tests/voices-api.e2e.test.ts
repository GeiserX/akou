/**
 * The voices doors (docs/DESIGN.md section 6): `GET /voices`, rename, forget and refuse over the
 * API, the CLI and MCP, on a headless app with the fake helper and its voices Host. The thresholds
 * are passed in, so no test depends on the measured values. Every answer carries names and
 * statuses only, never a voiceprint or a long score; only the user on this computer reaches them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { encodeVec } from "../src/main/asr/speakers.ts";
import { ApiClient } from "../src/main/cli/client.ts";
import { lineText } from "../src/main/cli/commands/follow.ts";
import { BY_VOICE } from "../src/main/query/context.ts";
import { shownVoices, voiceLabel } from "../src/main/query/render.ts";
import { LIVE_EMBEDDER } from "../src/main/voices/host.ts";
import { VoiceStore, voicesPath } from "../src/main/voices/store.ts";
import type { VoiceThresholds } from "../src/main/voices/thresholds.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { mcpClient } from "./mcp-helpers.ts";

const LONG = 30_000;
const T: VoiceThresholds = {
  accept: 0.8,
  offer: 0.6,
  margin: 0.1,
  minMatchSec: 10,
  minLearnSec: 10,
  score: "best",
};

/** A unit vector `deg` degrees from the first axis toward the second. */
function at(deg: number): Float32Array {
  const r = (deg * Math.PI) / 180;
  return Float32Array.from([Math.cos(r), Math.sin(r), 0, 0]);
}

const store = (rig: AppRig) => new VoiceStore(voicesPath(rig.app.configDir), { log: () => {} });

const exemplar = (call: string, vec: Float32Array, spk = "c1") => ({
  model: LIVE_EMBEDDER,
  dim: 4,
  vec,
  secs: 60,
  cons: 0.8,
  call,
  spk,
  at: new Date().toISOString(),
});

/**
 * Why a body is not one a voices door may answer: a `vec` field, a string over 100 characters (a
 * voiceprint in base64 is over 1,000), or a score with more than 2 decimals. Empty when it is fine.
 */
function leaks(v: unknown, where = "$"): string[] {
  if (typeof v === "string") return v.length > 100 ? [`${where} is ${v.length} characters`] : [];
  if (typeof v === "number") {
    const k = where.split(".").at(-1);
    return k === "score" && Math.round(v * 100) / 100 !== v ? [`${where} is ${v}`] : [];
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => leaks(x, `${where}[${i}]`));
  if (v && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) =>
      k === "vec" ? [`${where}.vec`] : leaks(x, `${where}.${k}`),
    );
  return [];
}

async function voiceEvents(rig: AppRig, id: string) {
  await rig.app.voices?.idle();
  return (await rig.app.events(id, 0)).filter(
    (e): e is Extract<LogEvent, { type: "speaker.voice" }> => e.type === "speaker.voice",
  );
}

/** A line of `spk`, so the speaker is in the roster, then its centroid as the live worker writes it. */
async function speak(rig: AppRig, id: string, spk: string, n: number, vec: Float32Array) {
  const w = Date.now();
  await rig.app.write(id, {
    type: "seg",
    id: `l${String(n).padStart(6, "0")}`,
    rev: 1,
    layer: "live",
    part: 1,
    ch: "call",
    spk,
    a0: n,
    a1: n + 1,
    w0: w,
    w1: w + 1000,
    text: "we ship on friday",
    lang: "en",
    model: "parakeet-tdt-0.6b-v3-fp32",
  });
  await rig.app.write(id, {
    type: "speaker.centroid",
    spk,
    vec: encodeVec(vec),
    secs: 30,
    cons: 0.8,
  });
  await rig.app.voices?.idle();
}

let rig: AppRig;
let net: string;
let admin: string;
beforeAll(async () => {
  rig = await appRig({
    voiceThresholds: () => T,
    settings: { "network.enabled": true, "network.bind": "127.0.0.1", "network.port": 0 },
  });
  net = rig.app.network?.url as string;
  const k = await cli({ ...process.env, ...rig.env }, [
    "keys",
    "create",
    "--name",
    "laptop",
    "--scope",
    "admin",
    "--json",
  ]);
  expect(k.code).toBe(0);
  admin = k.json.key as string;
}, LONG);
afterAll(async () => {
  await rig?.close();
}, LONG);

describe("text a person reads marks a name found by voice", () => {
  test("`Ben (voice)` for a name, `Speaker 2 (Ben?)` for an offer, a typed name as it is", () => {
    const shown = shownVoices([
      { spk: "c2", name: "Ben", byVoice: true, voice: { name: "Ben", status: "named" } },
      { spk: "c3", voice: { name: "Cy", status: "offered" } },
      // Typed: the voice found before it shows nothing.
      { spk: "c4", name: "Di", voice: { name: "Ed", status: "offered" } },
      { spk: "c5", mergedInto: "c2", voice: { name: "Ben", status: "named" } },
    ]);
    expect([...shown]).toEqual([
      ["c2", { name: "Ben", status: "named" }],
      ["c3", { name: "Cy", status: "offered" }],
    ]);
    expect(voiceLabel("Ben", shown.get("c2"))).toBe("Ben (voice)");
    expect(voiceLabel("Speaker 3", shown.get("c3"))).toBe("Speaker 3 (Cy?)");
    expect(voiceLabel("Di", shown.get("c4"))).toBe("Di");
    const line = { time: "10:12:00", spk: "c3", speaker: "Speaker 3", text: "hi" };
    expect(lineText({ ...line, voice: shown.get("c3") }, "txt")).toBe(
      "10:12:00 Speaker 3 (Cy?): hi",
    );
    // The positive control: the same line with no voice reads as a plain label.
    expect(lineText(line, "txt")).toBe("10:12:00 Speaker 3: hi");
  });
});

describe("the voices doors", () => {
  test("the voices-door check catches a voiceprint, a long string and a long score", () => {
    expect(leaks({ voices: [{ name: "Ben", calls: ["a"], secs: 60, lastSeen: "x" }] })).toEqual([]);
    // Positive control: what the file itself holds fails.
    expect(leaks({ vec: "AAAA" })).toEqual(["$.vec"]);
    expect(leaks({ v: encodeVec(new Float32Array(192).fill(0.07)) })).toEqual([
      "$.v is 1024 characters",
    ]);
    expect(leaks({ voice: { score: 0.8234 } })).toEqual(["$.voice.score is 0.8234"]);
  });

  test(
    "GET /voices lists names, calls, seconds and last seen; rename and forget edit the file",
    async () => {
      await store(rig).forgetAll();
      await store(rig).upsert("Ben", exemplar("call-a", at(0)));
      await store(rig).upsert("Ben", exemplar("call-b", at(1)));
      await store(rig).upsert("Cy", exemplar("call-b", at(90), "c2"));
      const r = await rig.api("GET", "/voices");
      expect(r.status).toBe(200);
      expect(leaks(r.body)).toEqual([]);
      expect(r.body.voices.map((v: { name: string; calls: string[]; secs: number }) => v)).toEqual([
        expect.objectContaining({ name: "Ben", calls: ["call-b", "call-a"], secs: 120 }),
        expect.objectContaining({ name: "Cy", calls: ["call-b"], secs: 60 }),
      ]);
      expect(Object.keys(r.body.voices[0]).sort()).toEqual(["calls", "lastSeen", "name", "secs"]);

      const renamed = await rig.api("POST", "/voices/rename", { from: "Cy", to: "Cy Ortiz" });
      expect(renamed.body).toEqual({ ok: true, from: "Cy", to: "Cy Ortiz" });
      expect((await rig.api("POST", "/voices/rename", { from: "Nobody", to: "X" })).status).toBe(
        404,
      );
      // What one call taught about Ben, then Cy Ortiz as a whole.
      expect(
        (await rig.api("POST", "/voices/forget", { name: "Ben", call: "call-b" })).status,
      ).toBe(200);
      expect((await rig.api("POST", "/voices/forget", { name: "Cy Ortiz" })).status).toBe(200);
      const left = (await rig.api("GET", "/voices")).body.voices;
      expect(left.map((v: { name: string; calls: string[] }) => [v.name, v.calls])).toEqual([
        ["Ben", ["call-a"]],
      ]);
      expect((await rig.api("POST", "/voices/forget", { all: true, name: "Ben" })).body.error).toBe(
        "bad_field",
      );
      expect((await rig.api("POST", "/voices/forget", {})).body.error).toBe("bad_field");
      expect((await rig.api("POST", "/voices/forget", { all: true })).status).toBe(200);
      expect((await rig.api("GET", "/voices")).body).toEqual({ voices: [] });
    },
    LONG,
  );

  test(
    "[VO-8] an admin ak_ key gets 403 local_only on every voices route; the app's token does not",
    async () => {
      await store(rig).upsert("Ben", exemplar("call-a", at(0)));
      const id = await rig.startCall();
      try {
        const routes: [string, string, unknown][] = [
          ["GET", "/voices", undefined],
          ["POST", "/voices/rename", { from: "Ben", to: "Ben" }],
          ["POST", "/voices/forget", { name: "Nobody" }],
          ["POST", `/calls/${id}/speakers/refuse`, { spk: "c9" }],
        ];
        for (const [method, path, body] of routes) {
          const res = await fetch(`${net}${path}`, {
            method,
            headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          expect([path, res.status, ((await res.json()) as { error: string }).error]).toEqual([
            path,
            403,
            "local_only",
          ]);
          // The positive control: the app's own token reaches the same route.
          const app = await rig.api(method, path, body as Record<string, unknown> | undefined);
          expect([path, app.status === 403]).toEqual([path, false]);
        }
        // The key reaches the rest of the API, so the refusal is the voices routes' own.
        const res = await fetch(`${net}/calls`, { headers: { authorization: `Bearer ${admin}` } });
        expect(res.status).toBe(200);
      } finally {
        await rig.api("POST", "/calls/live/stop");
      }
    },
    LONG,
  );

  test(
    "refuse writes one speaker.voice refused and hides the name; confirming by naming is one event",
    async () => {
      await store(rig).forgetAll();
      await store(rig).upsert("Ben", exemplar("earlier", at(0)));
      await store(rig).upsert("Cy", exemplar("earlier", at(90), "c2"));
      const id = await rig.startCall();
      try {
        await speak(rig, id, "c5", 1, at(2));
        await speak(rig, id, "c6", 2, at(92));
        expect((await voiceEvents(rig, id)).map((e) => [e.spk, e.name, e.status])).toEqual([
          ["c5", "Ben", "named"],
          ["c6", "Cy", "named"],
        ]);
        const before = await rig.api("GET", `/calls/${id}`);
        expect(leaks(before.body.roster)).toEqual([]);
        const c5 = before.body.roster.find((r: { spk: string }) => r.spk === "c5");
        expect(c5).toMatchObject({ label: "Ben", byVoice: true });
        expect(c5.voice).toEqual({ name: "Ben", status: "named" });
        // The positive control: the fold itself keeps the score the route leaves out.
        const call = await rig.app.call(id);
        expect(call.view.voiceFor("c5")).toHaveProperty("score");
        // The text a person reads marks the name as found by voice.
        const txt = await rig.api("GET", `/calls/${id}/transcript?format=txt`);
        expect(txt.text).toContain(" Ben (voice): we ship on friday");
        const line = (await rig.api("GET", `/calls/${id}/transcript`)).body.lines[0];
        expect(line).toMatchObject({
          spk: "c5",
          speaker: "Ben",
          voice: { name: "Ben", status: "named" },
        });
        // The agent's pack says the name is unconfirmed.
        const pack = (await rig.app.query(id)).context("what did Ben say?", {
          now: Date.now(),
        }).text;
        expect(pack).toContain(`c5 = Ben ${BY_VOICE}`);

        const seq = (await rig.app.events(id, 0)).length;
        const refused = await rig.api("POST", `/calls/${id}/speakers/refuse`, { spk: "c5" });
        expect(refused.status).toBe(200);
        expect(refused.body).toMatchObject({ ok: true, spk: "c5", name: "Ben" });
        await rig.app.voices?.idle();
        const added = (await rig.app.events(id, 0)).slice(seq);
        expect(added.map((e) => e.type)).toEqual(["speaker.voice"]);
        expect(added[0]).toMatchObject({ spk: "c5", name: "Ben", status: "refused" });
        const after = (await rig.api("GET", `/calls/${id}`)).body.roster;
        const c5after = after.find((r: { spk: string }) => r.spk === "c5");
        expect(c5after.label).toBe("Speaker 5");
        expect(c5after.voice).toBeUndefined();
        const after2 = (await rig.api("GET", `/calls/${id}/transcript?format=txt`)).text;
        expect(after2).toContain(" Speaker 5: we ship on friday");
        // Nothing left to refuse.
        expect(
          (await rig.api("POST", `/calls/${id}/speakers/refuse`, { spk: "c5" })).body.error,
        ).toBe("no_voice");

        // Confirming Cy is naming c6 with that name: one event, no voice event besides.
        const seq2 = (await rig.app.events(id, 0)).length;
        const named = await rig.api("POST", `/calls/${id}/speakers`, { spk: "c6", name: "Cy" });
        expect(named.status).toBe(200);
        await rig.app.voices?.idle();
        const speakerEvents = (await rig.app.events(id, 0))
          .slice(seq2)
          .filter((e) => e.type.startsWith("speaker."));
        expect(speakerEvents.map((e) => e.type)).toEqual(["speaker.name"]);
        const c6 = (await rig.api("GET", `/calls/${id}`)).body.roster.find(
          (r: { spk: string }) => r.spk === "c6",
        );
        expect(c6.name).toBe("Cy");
        expect(c6.byVoice).toBeUndefined();
      } finally {
        await rig.api("POST", "/calls/live/stop");
      }
    },
    LONG,
  );

  test(
    "the CLI and MCP: list, rename, forget and refuse, never a voiceprint",
    async () => {
      await store(rig).forgetAll();
      await store(rig).upsert("Ben", exemplar("earlier", at(0)));
      await store(rig).upsert("Cy", exemplar("earlier", at(90), "c2"));
      const env = { ...process.env, ...rig.env };
      const list = await cli(env, ["voices", "--json"]);
      expect(list.code).toBe(0);
      expect(leaks(list.json)).toEqual([]);
      expect(list.json.voices.map((v: { name: string }) => v.name)).toEqual(["Ben", "Cy"]);
      const human = await cli(env, ["voices"]);
      expect(human.out).toMatch(/^Ben {2}1 call, 1 min of speech, last heard \d{4}-\d\d-\d\d /);

      const mcp = await mcpClient(
        new ApiClient({ env, client: "mcp", launch: null }),
        "claude-code",
      );
      try {
        // [VO-5] An MCP name does not teach, and the tool says so to the agent.
        const tools = (await mcp.client.listTools()).tools;
        const naming = tools.find((t) => t.name === "akou_name_speaker")?.description ?? "";
        const says = (d: string) =>
          /does not teach akou the voice/.test(d) && /confirms the match/.test(d);
        expect(says(naming)).toBe(true);
        // The positive control: the text as it was says neither.
        expect(says(naming.slice(0, naming.indexOf(" Naming a speaker")))).toBe(false);

        const r = await mcp.call("akou_voices_list", {});
        expect(r.isError).toBe(false);
        expect(leaks(r.structured)).toEqual([]);
        expect(r.structured).toEqual({
          voices: [
            expect.objectContaining({ name: "Ben", calls: 1 }),
            expect.objectContaining({ name: "Cy", calls: 1 }),
          ],
        });

        const id = await rig.startCall();
        try {
          await speak(rig, id, "c5", 1, at(2));
          await speak(rig, id, "c6", 2, at(92));
          const off = await mcp.call("akou_voice_refuse", { speaker: "c5" });
          expect(off.isError).toBe(false);
          const byCli = await cli(env, ["voices", "refuse", "c6"]);
          expect([byCli.code, byCli.out]).toEqual([0, "c6 is not Cy"]);
          const refused = (await voiceEvents(rig, id)).filter((e) => e.status === "refused");
          expect(refused.map((e) => [e.spk, e.name, e.by])).toEqual([
            ["c5", "Ben", "agent:claude-code"],
            ["c6", "Cy", "agent:cli"],
          ]);
          // Nothing is left to refuse: 409 no_voice, a usage exit.
          expect((await cli(env, ["voices", "refuse", "c6"])).code).toBe(64);
        } finally {
          await rig.api("POST", "/calls/live/stop");
        }

        expect((await cli(env, ["voices", "rename", "Ben", "Ben Ortiz"])).code).toBe(0);
        const gone = await mcp.call("akou_voice_forget", { name: "Ben Ortiz" });
        expect(gone.isError).toBe(false);
        expect(
          (await rig.api("GET", "/voices")).body.voices.map((v: { name: string }) => v.name),
        ).toEqual(["Cy"]);
        expect((await cli(env, ["voices", "forget", "Ben Ortiz"])).code).toBe(64);
      } finally {
        await mcp.close();
      }
    },
    LONG,
  );
});

describe("[VO-8] server mode and the switch", () => {
  test(
    "server mode lists no voices routes and refuses them; with voices.enabled off they answer 409 voices_off",
    async () => {
      const server = await appRig({
        settings: { "server.enabled": true, "api.bind": "127.0.0.1" },
        voiceThresholds: () => T,
      });
      const off = await appRig({ settings: { "voices.enabled": false } });
      try {
        const voicePaths = async (x: AppRig) =>
          Object.keys((await x.api("GET", "/openapi.json")).body.paths).filter(
            (p) => p.includes("voices") || p.includes("refuse"),
          );
        expect(await voicePaths(server)).toEqual([]);
        // Reached anyway, a voices route refuses there: server mode keeps no voices.
        const there = await server.api("GET", "/voices");
        expect([there.status, there.body.error]).toEqual([409, "voices_off"]);
        // The positive control: the desktop app serves them.
        expect((await voicePaths(rig)).sort()).toEqual([
          "/v1/calls/{id}/speakers/refuse",
          "/v1/voices",
          "/v1/voices/forget",
          "/v1/voices/rename",
        ]);

        const r = await off.api("GET", "/voices");
        expect([r.status, r.body.error]).toEqual([409, "voices_off"]);
        const c = await cli({ ...process.env, ...off.env }, ["voices"]);
        expect(c.code).toBe(78);
        expect(c.err).toContain("voices.enabled");
        // The positive control: with it on, the same request answers.
        expect((await rig.api("GET", "/voices")).status).toBe(200);
      } finally {
        await server.close();
        await off.close();
      }
    },
    LONG,
  );
});
