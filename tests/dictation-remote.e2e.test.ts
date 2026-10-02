/**
 * Dictation through a remote akou (docs/ux/DICTATION.md section 7.2): the client of DC-R1 against a
 * real server-mode rig with a dictation lane, and against a loopback fake remote that records what
 * it was sent; the URL rule with a fake resolver; the timeout that grows with the audio (DC-R3);
 * the Test of DC-R4; and the audio streamed during the hold (DC-R6), over a link the test slows
 * down. Every request goes through a fake network that records its destination, so a test sees that
 * nothing left for any other host.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Packet } from "../src/main/capture/protocol.ts";
import type { AppToHelper } from "../src/main/dictation/protocol.ts";
import {
  type LocalEngine,
  REMOTE_DOWN_AFTER,
  REMOTE_MESSAGE_CHARS,
  REMOTE_TIMEOUT_SECONDS,
  RemoteDictationError,
  RemoteEngine,
  type RemoteSettings,
  RemoteUpload,
  remoteBase,
  remoteFallback,
  remoteKeywords,
  remoteTimeoutMs,
  testRemote,
  transcribeRemote,
  vetRemote,
} from "../src/main/dictation/remote.ts";
import { type DictationEngine, DictationSession } from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import type { AppOptions } from "../src/main/index.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import type { Resolver } from "../src/main/server/webhooks.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";
import { newKey, SERVER } from "./server-helpers.ts";

setDefaultTimeout(30_000);

/** A dictation buffer the fake recognizer reads as "hello world". */
const HELLO = concat(silence(0.4), speak(["hello", "world"]), silence(1));

/** A network that records every request's destination and body, then sends it on. */
function network() {
  const sent: { url: string; host: string | null; form: FormData | null; auth: string | null }[] =
    [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    sent.push({
      url,
      host: h.get("host"),
      form: init?.body instanceof FormData ? init.body : null,
      auth: h.get("authorization"),
    });
    return fetch(input, init);
  }) as typeof fetch;
  return { fetch: f, sent };
}

/** A resolver whose answers the test sets; it throws when asked about any other name. */
function resolver(table: Record<string, string[]>): Resolver & { asked: string[] } {
  const asked: string[] = [];
  const fn = (async (host: string) => {
    asked.push(host);
    const a = table[host];
    if (!a) throw new Error(`the test resolver has no ${host}`);
    return a.map((address) => ({ address }));
  }) as Resolver & { asked: string[] };
  fn.asked = asked;
  return fn;
}

async function refused(p: Promise<unknown>): Promise<RemoteDictationError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RemoteDictationError) return err;
    throw err;
  }
  throw new Error("expected a RemoteDictationError");
}

// ---------------------------------------------------------------------------
// The URL rule

describe("DC-R1: where dictation audio may go", () => {
  test("the URL checks of server.remotes apply", () => {
    expect(remoteBase("https://akou.example/")).toBe("https://akou.example");
    expect(remoteBase("")).toEqual({ error: "dictation.remote.url is empty" });
    expect(remoteBase("ftp://akou.example")).toMatchObject({
      error: expect.stringContaining("http or https"),
    });
    expect(remoteBase("https://u:p@akou.example")).toMatchObject({
      error: expect.stringContaining("user name or password"),
    });
    expect(remoteBase("https://akou.example/?x=1")).toMatchObject({
      error: expect.stringContaining("query"),
    });
    expect(remoteBase("https://akou.example /x")).toMatchObject({ error: expect.any(String) });
  });

  test("http to a public address is refused with the reason; http to a private one passes", async () => {
    const none = resolver({});
    const e = await refused(vetRemote("http://203.0.113.5", none));
    expect(e.kind).toBe("refused");
    expect(e.message).toContain("203.0.113.5");
    expect(e.message).toContain("https only");
    for (const ok of [
      "http://10.0.0.5",
      "http://127.0.0.1:8080",
      "http://172.20.1.1",
      "http://192.168.1.9",
      "http://100.64.1.2",
      "http://[fd00::5]",
      "http://[::1]:9",
    ]) {
      expect((await vetRemote(ok, none)).address).not.toBeNull();
    }
    // Link-local, the metadata address, and the edges of the shared block stay out.
    for (const bad of [
      "http://169.254.169.254",
      "http://[fe80::1]",
      "http://100.128.0.1",
      "http://172.32.0.1",
    ]) {
      expect((await refused(vetRemote(bad, none))).kind).toBe("refused");
    }
    // An IP literal needs no DNS.
    expect(none.asked).toEqual([]);
  });

  test("https always passes, and is never resolved by akou", async () => {
    const none = resolver({});
    expect(await vetRemote("https://203.0.113.5", none)).toEqual({
      base: "https://203.0.113.5",
      address: null,
    });
    expect(none.asked).toEqual([]);
  });

  test("a name is checked at every request: accepted while private, refused once it resolves to a public address", async () => {
    const table: Record<string, string[]> = { "box.example": ["10.0.0.5"] };
    const dns = resolver(table);
    const rig = await fakeRemote();
    try {
      const net = network();
      const url = `http://box.example:${rig.port}`;
      expect((await vetRemote(url, dns)).address).toBe("10.0.0.5");
      // The name resolves to the fake's own loopback address for the request itself.
      table["box.example"] = ["127.0.0.1"];
      const r = await transcribeRemote({
        url,
        key: "k",
        samples: HELLO,
        fetch: net.fetch,
        resolve: dns,
      });
      expect(r.text).toBe("hello from the fake");
      // The request went to the checked address, naming the host it was asked for.
      expect(net.sent[0]?.url).toBe(`http://127.0.0.1:${rig.port}/v1/audio/transcriptions`);
      expect(net.sent[0]?.host).toBe(`box.example:${rig.port}`);
      table["box.example"] = ["203.0.113.5"];
      const e = await refused(
        transcribeRemote({ url, key: "k", samples: HELLO, fetch: net.fetch, resolve: dns }),
      );
      expect(e.kind).toBe("refused");
      expect(e.message).toContain("box.example resolves to 203.0.113.5");
      // Nothing was sent for the refused request.
      expect(net.sent).toHaveLength(1);
      // One public answer among private ones refuses the lot: the next lookup could pick it.
      table["box.example"] = ["10.0.0.5", "203.0.113.5"];
      expect((await refused(vetRemote(url, dns))).kind).toBe("refused");
    } finally {
      rig.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// A fake remote that records what it was sent

interface Fake {
  port: number;
  /** The multipart fields of each transcription request, files left out. */
  fields: Record<string, string[]>[];
  auth: (string | null)[];
  stop(): void;
}

function fakeRemote(
  o: { delayMs?: number; status?: number; server?: unknown; language?: string } = {},
): Promise<Fake> {
  const fields: Fake["fields"] = [];
  const auth: Fake["auth"] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/server") return Response.json(o.server ?? { name: "akou" });
      if (path === "/v1/keys/me") return Response.json({ id: "k" });
      auth.push(req.headers.get("authorization"));
      const form = await req.formData();
      const f: Record<string, string[]> = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") f[k] = [...(f[k] ?? []), v];
      }
      fields.push(f);
      if (o.delayMs) await Bun.sleep(o.delayMs);
      if (o.status)
        return Response.json({ error: "queue_full", message: "full" }, { status: o.status });
      return Response.json({
        language: o.language ?? "en",
        duration: 2,
        text: "hello from the fake",
        words: [],
      });
    },
  });
  return Promise.resolve({
    port: server.port as number,
    fields,
    auth,
    stop: () => server.stop(true),
  });
}

describe("DC-R1: the request", () => {
  let fake: Fake;
  beforeAll(async () => {
    fake = await fakeRemote();
  });
  afterAll(() => fake.stop());

  test("the fields: interactive, verbose_json, a WAV file, the key as the bearer; no keywords while the glossary is off", async () => {
    const net = network();
    await transcribeRemote({
      url: `http://127.0.0.1:${fake.port}`,
      key: "secret-key-1",
      samples: HELLO,
      fetch: net.fetch,
    });
    const f = fake.fields.at(-1) ?? {};
    expect(f.interactive).toEqual(["true"]);
    expect(f.response_format).toEqual(["verbose_json"]);
    expect(f["keywords[]"]).toBeUndefined();
    expect(f.language).toBeUndefined();
    expect(f.model).toBeUndefined();
    expect(fake.auth.at(-1)).toBe("Bearer secret-key-1");
    const file = net.sent.at(-1)?.form?.get("file") as File;
    const head = new Uint8Array(await file.arrayBuffer()).subarray(0, 44);
    const v = new DataView(head.buffer, head.byteOffset);
    expect(new TextDecoder().decode(head.subarray(0, 4))).toBe("RIFF");
    // PCM, mono, 16 kHz, 16-bit.
    expect([
      v.getUint16(20, true),
      v.getUint16(22, true),
      v.getUint32(24, true),
      v.getUint16(34, true),
    ]).toEqual([1, 1, 16000, 16]);
  });

  test("with the glossary on, its terms go as keywords[], at most 24; a forced language and a named model go too", async () => {
    const terms = Array.from({ length: 30 }, (_, i) => `term${i}`);
    await transcribeRemote({
      url: `http://127.0.0.1:${fake.port}`,
      key: "k",
      samples: HELLO,
      glossary: ["Akou", " Akou ", ...terms],
      language: "es",
      model: "best",
    });
    const f = fake.fields.at(-1) ?? {};
    expect(f["keywords[]"]).toEqual(["Akou", ...terms.slice(0, 23)]);
    expect(f.language).toEqual(["es"]);
    expect(f.model).toEqual(["best"]);
    expect(remoteKeywords(null)).toEqual([]);
  });

  test("a refusal names the remote's code and never the key", async () => {
    const full = await fakeRemote({ status: 429 });
    try {
      const e = await refused(
        transcribeRemote({
          url: `http://127.0.0.1:${full.port}`,
          key: "secret-key-2",
          samples: HELLO,
        }),
      );
      expect(e).toMatchObject({ kind: "status", status: 429, code: "queue_full" });
      expect(JSON.stringify({ ...e, message: e.message })).not.toContain("secret-key-2");
    } finally {
      full.stop();
    }
  });

  test("a remote whose engine names no language (`und`, or `unknown` from an older server) gives no language", async () => {
    for (const language of ["und", "unknown"]) {
      const none = await fakeRemote({ language });
      try {
        const r = await transcribeRemote({
          url: `http://127.0.0.1:${none.port}`,
          key: "k",
          samples: HELLO,
        });
        expect([language, r.language]).toEqual([language, null]);
      } finally {
        none.stop();
      }
    }
  });

  test("an unreachable remote is `unreachable`, with no other host tried", async () => {
    const net = network();
    const dead = await fakeRemote();
    dead.stop();
    const e = await refused(
      transcribeRemote({
        url: `http://127.0.0.1:${dead.port}`,
        key: "k",
        samples: HELLO,
        fetch: net.fetch,
      }),
    );
    expect(e.kind).toBe("unreachable");
    expect(net.sent.map((s) => new URL(s.url).host)).toEqual([`127.0.0.1:${dead.port}`]);
  });
});

describe("DC-R3: the timeout grows with the audio", () => {
  test("6 s plus 0.25 s per second of audio: a 20-minute session gets 306 s", () => {
    expect(REMOTE_TIMEOUT_SECONDS).toBe(6);
    expect(remoteTimeoutMs(6, 1200)).toBe(306_000);
    expect(remoteTimeoutMs(6, 0)).toBe(6000);
  });

  test("a slow answer to a long clip is used; the same wait on a short clip times out", async () => {
    const slow = await fakeRemote({ delayMs: 400 });
    try {
      const url = `http://127.0.0.1:${slow.port}`;
      // 0.1 s budget plus 0.25 s x 4 s of audio = 1.1 s: the 0.4 s answer is used.
      const long = new Float32Array(4 * 16000);
      expect(
        (await transcribeRemote({ url, key: "k", samples: long, timeoutSeconds: 0.1 })).text,
      ).toBe("hello from the fake");
      // 0.1 s plus 0.25 s x 0.5 s = 0.225 s: the same answer comes too late.
      const short = new Float32Array(8000);
      const e = await refused(
        transcribeRemote({ url, key: "k", samples: short, timeoutSeconds: 0.1 }),
      );
      expect(e.kind).toBe("timeout");
    } finally {
      slow.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Against a real server with a dictation lane

describe("DC-R1 and DC-R4 against a server rig", () => {
  let rig: AppRig;
  let key: string;
  let url: string;

  beforeAll(async () => {
    rig = await appRig({
      settings: { ...SERVER },
      jobs: { dictationSlots: () => 1 } as AppOptions["jobs"],
    });
    key = (await newKey(rig, "dictation")).key;
    url = `http://127.0.0.1:${rig.port}`;
  });
  afterAll(async () => {
    await rig?.close();
  });

  test("a dictation returns the rig's transcript with the round trip, and only the rig is contacted", async () => {
    const net = network();
    const r = await transcribeRemote({ url, key, samples: HELLO, fetch: net.fetch });
    expect(r.text).toContain("hello world");
    expect(r.ms).toBeGreaterThan(0);
    expect(r.words).toEqual([]);
    expect(net.sent.map((s) => new URL(s.url).host)).toEqual([`127.0.0.1:${rig.port}`]);
  });

  test("the glossary's terms are accepted by the rig's route", async () => {
    const r = await transcribeRemote({ url, key, samples: HELLO, glossary: ["akou", "Parakeet"] });
    expect(r.keywords).toEqual(["akou", "Parakeet"]);
    expect(r.text).toContain("hello");
  });

  test("a wrong key is refused with 401, and the key is in no message", async () => {
    const e = await refused(transcribeRemote({ url, key: "akou_wrong_key_123", samples: HELLO }));
    expect(e).toMatchObject({ kind: "status", status: 401 });
    expect(e.message).not.toContain("akou_wrong_key_123");
  });

  test("the Test: ok, the engine on the accelerator, no biasing, the round trip", async () => {
    const t = await testRemote({ url, key });
    expect(t).toMatchObject({
      ok: true,
      mode: "server",
      engine: "fast",
      accelerator: "cpu",
      biasing: "no biasing",
      interactive: true,
      warning: null,
    });
    expect(t.summary).toMatch(/^ok, fast on cpu, no biasing, \d+ ms$/);
    expect((await testRemote({ url, key, glossary: ["a", "b"] })).biasing).toBe("2 terms");
  });

  test("the Test with a wrong key shows 401 and never the key", async () => {
    const t = await testRemote({ url, key: "akou_wrong_key_456" });
    expect(t).toMatchObject({ ok: false, status: 401 });
    expect(t.summary).toStartWith("401");
    expect(JSON.stringify(t)).not.toContain("akou_wrong_key_456");
  });
});

describe("DC-R4: a remote without the interactive lane", () => {
  test("an older akou (no capability) shows the queue warning", async () => {
    const old = await fakeRemote({
      server: { name: "akou", mode: "server", capabilities: { jobs: true } },
    });
    try {
      const t = await testRemote({ url: `http://127.0.0.1:${old.port}`, key: "k" });
      expect(t.ok).toBe(true);
      expect(t.warning).toBe("this akou is older; dictation will queue");
      expect(t.summary).toContain("dictation will queue");
    } finally {
      old.stop();
    }
  });

  test("one with the capability but no slots says so", async () => {
    const none = await fakeRemote({
      server: { name: "akou", mode: "server", capabilities: { interactive: false } },
    });
    try {
      const t = await testRemote({ url: `http://127.0.0.1:${none.port}`, key: "k" });
      expect(t.warning).toContain("no dictation slots");
    } finally {
      none.stop();
    }
  });

  test("a public http URL fails the Test before any request", async () => {
    const net = network();
    const t = await testRemote({ url: "http://203.0.113.5", key: "k", fetch: net.fetch });
    expect(t.ok).toBe(false);
    expect(t.error).toContain("https only");
    expect(net.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DC-R3: the fallback

/** A local engine that answers "hello world" and counts its decodes. */
function localEngine(name = "fast"): LocalEngine & { calls: number } {
  const e = {
    name,
    calls: 0,
    async decode() {
      e.calls++;
      return {
        text: "hello world",
        words: [{ w: "hello", s: 0.4, e: 0.7, c: 0.9 }],
        language: "en",
        model: "parakeet-tdt-0.6b-v3",
        ms: 5,
        spans: 1,
      };
    },
  };
  return e;
}

function engine(
  s: Partial<RemoteSettings> & { url: string },
  o: { local?: LocalEngine | null; fetch?: typeof fetch; probeMs?: number; log?: string[] } = {},
): RemoteEngine {
  return new RemoteEngine({
    settings: () => ({ key: "secret-key-3", fallback: "local", ...s }),
    local: () => (o.local === undefined ? localEngine() : o.local),
    fetch: o.fetch,
    probeMs: o.probeMs,
    onLog: (level, msg) => o.log?.push(`${level} ${msg}`),
  });
}

async function stoppedRemote(): Promise<string> {
  const dead = await fakeRemote();
  dead.stop();
  return `http://127.0.0.1:${dead.port}`;
}

describe("DC-R3: the fallback is explicit", () => {
  test("a remote that answers is used: engine remote, the round trip, no fallback, no local decode", async () => {
    const fake = await fakeRemote();
    try {
      const local = localEngine();
      const r = await engine({ url: `http://127.0.0.1:${fake.port}` }, { local }).decode(HELLO);
      expect(r).toMatchObject({ text: "hello from the fake", engine: "remote", notice: null });
      expect(r.fallback_from).toBeUndefined();
      expect(r.round_trip_ms).toBeGreaterThanOrEqual(0);
      expect(r.words).toEqual([]);
      expect(local.calls).toBe(0);
    } finally {
      fake.stop();
    }
  });

  test("with the remote stopped and fallback local, the local engine decodes it and says so; only the remote was contacted", async () => {
    const url = await stoppedRemote();
    const net = network();
    const log: string[] = [];
    const r = await engine({ url }, { fetch: net.fetch, log }).decode(HELLO);
    expect(r).toMatchObject({
      text: "hello world",
      engine: "fast",
      fallback_from: "remote",
      notice: "remote down, used fast",
    });
    expect(r.remote_error).toContain("could not be reached");
    // The local result keeps its word times: only a remote result has none.
    expect(r.words).toHaveLength(1);
    expect(net.sent.map((x) => new URL(x.url).host)).toEqual([new URL(url).host]);
    expect(log.join("\n")).not.toContain("secret-key-3");
  });

  test("an answer other than 2xx falls back too, with the remote's reason", async () => {
    const full = await fakeRemote({ status: 429 });
    try {
      const r = await engine({ url: `http://127.0.0.1:${full.port}` }).decode(HELLO);
      expect(r).toMatchObject({ engine: "fast", fallback_from: "remote" });
      expect(r.remote_error).toContain("429");
    } finally {
      full.stop();
    }
  });

  test("with fallback error nothing is decoded locally, and the error is thrown for the error state", async () => {
    const url = await stoppedRemote();
    const local = localEngine();
    const e = await refused(engine({ url, fallback: "error" }, { local }).decode(HELLO));
    expect(e.kind).toBe("unreachable");
    expect(local.calls).toBe(0);
  });

  test("with no local model, fallback local resolves to error", async () => {
    expect(remoteFallback("local", true)).toBe("local");
    expect(remoteFallback("local", false)).toBe("error");
    expect(remoteFallback("error", true)).toBe("error");
    const url = await stoppedRemote();
    const e = await refused(engine({ url }, { local: null }).decode(HELLO));
    expect(e.kind).toBe("unreachable");
  });

  test("a slow answer to a long clip is used, not fallen back from; the same wait on a short clip falls back", async () => {
    const slow = await fakeRemote({ delayMs: 400 });
    try {
      const url = `http://127.0.0.1:${slow.port}`;
      // The 600 s clip answered after 100 s, scaled: 0.1 s + 0.25 s x 4 s = 1.1 s, answered at 0.4 s.
      const long = await engine({ url, timeoutSeconds: 0.1 }).decode(new Float32Array(4 * 16000));
      expect(long).toMatchObject({ text: "hello from the fake", engine: "remote" });
      const short = await engine({ url, timeoutSeconds: 0.1 }).decode(new Float32Array(8000));
      expect(short).toMatchObject({ engine: "fast", fallback_from: "remote" });
      expect(short.remote_error).toContain("no answer within 225 ms");
    } finally {
      slow.stop();
    }
  });

  test("an http URL that now resolves to a public address falls back locally, and the audio goes nowhere", async () => {
    const net = network();
    const dns = resolver({ "box.example": ["203.0.113.5"] });
    const r = await new RemoteEngine({
      settings: () => ({ url: "http://box.example:8476", key: "k", fallback: "local" }),
      local: () => localEngine(),
      fetch: net.fetch,
      resolve: dns,
    }).decode(HELLO);
    expect(r).toMatchObject({ engine: "fast", fallback_from: "remote" });
    expect(r.remote_error).toContain("203.0.113.5");
    expect(net.sent).toEqual([]);
  });
});

describe("DC-R3: a remote down three dictations in a row is probed", () => {
  /** A remote that answers 503 to everything while `down` is set, and records every request. */
  function flaky() {
    const state = { down: true, requests: [] as string[] };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        state.requests.push(`${req.method} ${path}`);
        if (req.method === "POST") await req.formData();
        if (state.down) return Response.json({ error: "down" }, { status: 503 });
        if (path === "/v1/server") return Response.json({ name: "akou" });
        return Response.json({ language: "en", text: "hello from the fake", words: [] });
      },
    });
    return { state, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  test("three failures in a row mark it down and start the probe; the probe's answer brings it back", async () => {
    const f = flaky();
    const log: string[] = [];
    const e = engine({ url: f.url }, { probeMs: 20, log });
    try {
      for (let i = 1; i < REMOTE_DOWN_AFTER; i++) await e.decode(HELLO);
      expect(e.health()).toMatchObject({ down: false, failures: 2, probing: false });
      await e.decode(HELLO);
      expect(e.health()).toMatchObject({ down: true, failures: 3, probing: true });
      expect(e.health().error).toContain("503");
      // The probe asks GET /v1/server with no key while the remote is down.
      await Bun.sleep(80);
      expect(f.state.requests).toContain("GET /v1/server");
      expect(e.health().down).toBe(true);
      f.state.down = false;
      for (let i = 0; i < 50 && e.health().down; i++) await Bun.sleep(10);
      expect(e.health()).toEqual({ down: false, failures: 0, error: null, probing: false });
      expect(log.some((l) => l.includes("the remote is back"))).toBe(true);
    } finally {
      e.close();
      f.stop();
    }
  });

  test("a refused key is a setting to fix, not a remote that is down: it never starts the probe", async () => {
    const fake = await fakeRemote({ status: 401 });
    const e = engine({ url: `http://127.0.0.1:${fake.port}` }, { probeMs: 20 });
    try {
      for (let i = 0; i < REMOTE_DOWN_AFTER + 1; i++) await e.decode(HELLO);
      expect(e.health()).toMatchObject({ down: false, failures: 0, probing: false });
      expect(e.health().error).toContain("the key was refused");
    } finally {
      e.close();
      fake.stop();
    }
  });

  test("a dictation the remote answers resets the count", async () => {
    const f = flaky();
    const e = engine({ url: f.url }, { probeMs: 60_000 });
    try {
      await e.decode(HELLO);
      await e.decode(HELLO);
      f.state.down = false;
      expect((await e.decode(HELLO)).engine).toBe("remote");
      f.state.down = true;
      await e.decode(HELLO);
      expect(e.health()).toMatchObject({ down: false, failures: 1 });
    } finally {
      e.close();
      f.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// DC-R6: the audio streamed during the hold

/** A remote that records each body as it arrives: bytes so far, whether it ended, its parts. */
function streamRemote(o: { status?: number } = {}) {
  const got = {
    bytes: 0,
    chunked: [] as (string | null)[],
    length: [] as (string | null)[],
    ended: 0,
    broken: 0,
    fields: [] as Record<string, string>[],
    files: [] as Uint8Array[],
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      got.chunked.push(req.headers.get("transfer-encoding"));
      got.length.push(req.headers.get("content-length"));
      const parts: Uint8Array[] = [];
      try {
        const r = (req.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          got.bytes += value.byteLength;
          parts.push(value);
        }
      } catch {
        got.broken++;
        return new Response(null, { status: 499 });
      }
      got.ended++;
      const form = await new Response(Buffer.concat(parts), {
        headers: { "content-type": req.headers.get("content-type") ?? "" },
      })
        .formData()
        .catch(() => new FormData());
      const f: Record<string, string> = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") f[k] = v;
        else got.files.push(new Uint8Array(await v.arrayBuffer()));
      }
      got.fields.push(f);
      if (o.status) return Response.json({ error: "nope", message: "no" }, { status: o.status });
      return Response.json({ language: "en", text: "hello from the stream", words: [] });
    },
  });
  return { got, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** `samples` in packets of `ms` of audio, as the helper sends them. */
function packets(samples: Float32Array, ms = 100): Float32Array[] {
  const n = (16000 * ms) / 1000;
  const out: Float32Array[] = [];
  for (let i = 0; i < samples.length; i += n) out.push(samples.subarray(i, i + n));
  return out;
}

/**
 * The network with an uplink of `bytesPerSecond`: every request body, a form or a stream, leaves
 * no faster than that. A link idle for a moment starts again from now, as a real one does.
 */
function slowLink(bytesPerSecond: number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    let body = init?.body as ReadableStream<Uint8Array> | FormData;
    if (body instanceof FormData) {
      const r = new Response(body);
      headers.set("content-type", r.headers.get("content-type") ?? "");
      body = r.body as ReadableStream<Uint8Array>;
    }
    const src = body.getReader();
    let free = performance.now();
    const throttled = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await src.read();
        if (done) {
          c.close();
          return;
        }
        for (let o = 0; o < value.length; o += 8192) {
          const part = value.subarray(o, o + 8192);
          const now = performance.now();
          // Idle for longer than a timer's slack: the link was free, so it starts again now.
          if (now - free > 30) free = now;
          free += (part.length / bytesPerSecond) * 1000;
          if (free - now > 2) await Bun.sleep(free - now);
          c.enqueue(part);
        }
      },
      cancel: (why) => src.cancel(why),
    });
    return fetch(input, { ...init, headers, body: throttled, duplex: "half" } as RequestInit);
  }) as typeof fetch;
}

describe("DC-R6: the audio goes to the remote during the hold", () => {
  test("the file's bytes reach the remote before release, chunked, with the one-request fields, and the server reads the WAV to its end", async () => {
    const r = streamRemote();
    try {
      const up = new RemoteUpload({ url: r.url, key: "k", glossary: ["akou"], language: "es" });
      const ps = packets(HELLO);
      for (const p of ps.slice(0, -1)) up.push(p);
      for (let i = 0; i < 100 && r.got.bytes < 44 + (HELLO.length - 1600) * 2; i++) {
        await Bun.sleep(10);
      }
      // Before release the remote holds the fields, the WAV header and all but the last packet.
      const before = r.got.bytes;
      expect(before).toBeGreaterThan((HELLO.length - 1600) * 2);
      expect(r.got.ended).toBe(0);
      const res = await up.finish(HELLO);
      expect(res).toMatchObject({ text: "hello from the stream", keywords: ["akou"], words: [] });
      expect(r.got.chunked).toEqual(["chunked"]);
      expect(r.got.length).toEqual([null]);
      expect(r.got.fields[0]).toEqual({
        response_format: "verbose_json",
        interactive: "true",
        language: "es",
        "keywords[]": "akou",
      });
      // The WAV has no length, so the server's reader takes the audio to the end of the file.
      const wav = r.got.files[0] as Uint8Array;
      expect(new DataView(wav.buffer, wav.byteOffset).getUint32(40, true)).toBe(0xffffffff);
      const path = join(tmpdir(), `akou-streamed-${crypto.randomUUID()}.wav`);
      writeFileSync(path, wav);
      try {
        const back = await readUploadAudio(path);
        expect(back.length).toBe(HELLO.length);
        expect(Math.max(...back.map((x, i) => Math.abs(x - (HELLO[i] as number))))).toBeLessThan(
          1e-4,
        );
      } finally {
        rmSync(path, { force: true });
      }
    } finally {
      r.stop();
    }
  });

  test("against the server rig, a streamed dictation returns the rig's transcript; the tail left at release, which holds every word, is sent", async () => {
    const rig = await appRig({
      settings: { ...SERVER },
      jobs: { dictationSlots: () => 1 } as AppOptions["jobs"],
    });
    try {
      const key = (await newKey(rig, "dictation")).key;
      const net = network();
      const local = localEngine();
      const e = engine({ url: `http://127.0.0.1:${rig.port}`, key }, { local, fetch: net.fetch });
      // The words are in the second half, and only the first half is pushed during the hold: the
      // transcript comes from the tail sent at release, or not at all.
      const lead = silence(2);
      const late = concat(lead, speak(["hello", "world"]), silence(0.4));
      const ps = packets(late);
      const half = ps.slice(0, Math.floor(ps.length / 2));
      expect(half.reduce((a, p) => a + p.length, 0)).toBeLessThanOrEqual(lead.length);
      const hold = e.open();
      for (const p of half) hold.push(p);
      const r = await hold.decode(late);
      expect(r.text).toContain("hello world");
      expect(r).toMatchObject({ engine: "remote", notice: null, words: [] });
      expect(local.calls).toBe(0);
      expect(net.sent.map((x) => new URL(x.url).host)).toEqual([`127.0.0.1:${rig.port}`]);
    } finally {
      await rig.close();
    }
  });

  test("over a slow link, a 20 s session's release-to-text is within 200 ms of a 3 s session's; sent in one request at release it is not", async () => {
    const rig = await appRig({
      settings: { ...SERVER },
      jobs: { dictationSlots: () => 1 } as AppOptions["jobs"],
    });
    try {
      const key = (await newKey(rig, "dictation")).key;
      // 800 KB/s up; a session's audio is 32 KB/s, held here at ten times real time (320 KB/s).
      const link = slowLink(800_000);
      const e = engine({ url: `http://127.0.0.1:${rig.port}`, key }, { fetch: link });
      const session = (seconds: number) => concat(HELLO, silence(seconds - HELLO.length / 16000));
      const streamed = async (seconds: number) => {
        const samples = session(seconds);
        const hold = e.open();
        for (const p of packets(samples)) {
          hold.push(p);
          await Bun.sleep(10);
        }
        const t0 = performance.now();
        const r = await hold.decode(samples);
        expect(r).toMatchObject({ engine: "remote" });
        expect(r.text).toContain("hello world");
        return performance.now() - t0;
      };
      const atRelease = async (seconds: number) => {
        const t0 = performance.now();
        const r = await e.decode(session(seconds));
        expect(r).toMatchObject({ engine: "remote" });
        return performance.now() - t0;
      };
      const [s3, s20] = [await streamed(3), await streamed(20)];
      expect(Math.abs(s20 - s3)).toBeLessThan(200);
      // The positive control: the same link makes the one request at release 200 ms slower.
      const [o3, o20] = [await atRelease(3), await atRelease(20)];
      expect(o20 - o3).toBeGreaterThan(200);
    } finally {
      await rig.close();
    }
  });

  test("a stopped remote falls back locally with the buffer; nothing goes to any other host", async () => {
    const url = await stoppedRemote();
    const net = network();
    const hold = engine({ url }, { fetch: net.fetch }).open();
    for (const p of packets(HELLO)) hold.push(p);
    const r = await hold.decode(HELLO);
    expect(r).toMatchObject({ engine: "fast", fallback_from: "remote", text: "hello world" });
    expect(r.remote_error).toContain("could not be reached");
    expect(net.sent.map((x) => new URL(x.url).host)).toEqual([new URL(url).host]);
  });

  test("a key refused during the hold is the remote's refusal: fallback error throws 401, and nothing is sent again", async () => {
    const r = streamRemote({ status: 401 });
    try {
      const net = network();
      const local = localEngine();
      const hold = engine({ url: r.url, fallback: "error" }, { local, fetch: net.fetch }).open();
      for (const p of packets(HELLO)) hold.push(p);
      const e = await refused(hold.decode(HELLO));
      expect(e).toMatchObject({ kind: "status", status: 401 });
      expect(e.message).not.toContain("secret-key-3");
      expect(local.calls).toBe(0);
      expect(net.sent).toHaveLength(1);
    } finally {
      r.stop();
    }
  });

  test("a public http URL is refused at the press, and no byte goes anywhere", async () => {
    const net = network();
    const hold = engine({ url: "http://203.0.113.5" }, { fetch: net.fetch }).open();
    for (const p of packets(HELLO)) hold.push(p);
    const r = await hold.decode(HELLO);
    expect(r).toMatchObject({ engine: "fast", fallback_from: "remote" });
    expect(r.remote_error).toContain("https only");
    expect(net.sent).toEqual([]);
  });

  test("a cancelled session drops the request: the remote sees it broken, never ended", async () => {
    const r = streamRemote();
    try {
      const up = new RemoteUpload({ url: r.url, key: "k" });
      for (const p of packets(HELLO).slice(0, 5)) up.push(p);
      for (let i = 0; i < 100 && r.got.bytes === 0; i++) await Bun.sleep(10);
      expect(r.got.bytes).toBeGreaterThan(0);
      up.cancel();
      for (let i = 0; i < 100 && r.got.broken === 0; i++) await Bun.sleep(10);
      expect(r.got).toMatchObject({ broken: 1, ended: 0 });
      // Cancelled at the press, before the request was even open: nothing is ever sent.
      const early = new RemoteUpload({ url: r.url, key: "k" });
      early.push(HELLO);
      early.cancel();
      await Bun.sleep(100);
      expect(r.got).toMatchObject({ broken: 1, ended: 0 });
      expect(r.got.chunked).toHaveLength(1);
    } finally {
      r.stop();
    }
  });

  test("the timeout runs from release and grows with the audio", async () => {
    const slow = await fakeRemote({ delayMs: 400 });
    try {
      const url = `http://127.0.0.1:${slow.port}`;
      // A hold longer than the whole budget (0.1 s plus 0.25 s x 4 s = 1.1 s): had the timer
      // started at the press, the request would be aborted before the release.
      const holdMs = 1400;
      expect(holdMs).toBeGreaterThan(remoteTimeoutMs(0.1, 4) + 200);
      const long = new RemoteUpload({ url, key: "k", timeoutSeconds: 0.1 });
      long.push(new Float32Array(4 * 16000));
      await Bun.sleep(holdMs);
      expect((await long.finish(new Float32Array(4 * 16000))).text).toBe("hello from the fake");
      // 0.1 s plus 0.25 s x 0.5 s = 0.225 s: the 0.4 s answer comes too late.
      const short = new RemoteUpload({ url, key: "k", timeoutSeconds: 0.1 });
      const e = await refused(short.finish(new Float32Array(8000)));
      expect(e.kind).toBe("timeout");
      expect(e.message).toContain("no answer within 225 ms");
    } finally {
      slow.stop();
    }
  });

  test("once the request has failed, audio pushed during the rest of the hold is dropped, not held in memory", async () => {
    // Refused at the press: nothing is ever sent, so nothing is kept either.
    const refusedUp = new RemoteUpload({ url: "http://203.0.113.5", key: "k" });
    refusedUp.push(new Float32Array(1600));
    await Bun.sleep(20);
    for (const p of packets(silence(20))) refusedUp.push(p);
    expect(refusedUp.pending).toBe(0);
    expect((await refused(refusedUp.finish(silence(20.1)))).kind).toBe("refused");
    // A remote that is down: the request opened, then failed. What it had queued goes too.
    const up = new RemoteUpload({ url: await stoppedRemote(), key: "k" });
    up.push(new Float32Array(1600));
    await Bun.sleep(50);
    for (const p of packets(silence(20))) up.push(p);
    // 20 s of audio is 640 KB; none of it is held once the failure is known.
    expect(up.pending).toBe(0);
    expect((await refused(up.finish(silence(20.1)))).kind).toBe("unreachable");
  });

  test("a hold that is decoded after it was cancelled, or with a shorter buffer, is dropped: no fallback, and the remote's health is untouched", async () => {
    const r = streamRemote();
    try {
      const net = network();
      const local = localEngine();
      const e = engine({ url: r.url }, { local, fetch: net.fetch });
      const cancelled = e.open();
      for (const p of packets(HELLO).slice(0, 5)) cancelled.push(p);
      cancelled.cancel();
      expect(await refused(cancelled.decode(HELLO))).toMatchObject({ kind: "dropped" });
      const shorter = e.open();
      for (const p of packets(HELLO)) shorter.push(p);
      const d = await refused(shorter.decode(HELLO.subarray(0, 1600)));
      expect(d).toMatchObject({ kind: "dropped" });
      expect(d.message).toContain("shorter");
      expect(local.calls).toBe(0);
      expect(e.health()).toMatchObject({ failures: 0, error: null, down: false });
      // Nothing went again: one request per hold.
      expect(net.sent).toHaveLength(2);
    } finally {
      r.stop();
    }
  });

  test("the remote engine is a dictation engine: a remote result carries what the session reads", async () => {
    const fake = await fakeRemote();
    try {
      const e: DictationEngine = engine({ url: `http://127.0.0.1:${fake.port}` });
      expect(e.name).toBe("remote");
      expect(await e.decode(HELLO, {})).toMatchObject({
        text: "hello from the fake",
        words: [],
        spans: 1,
      });
    } finally {
      fake.stop();
    }
  });
});

describe("a remote's own message is bounded before it reaches the pill, the page or the log", () => {
  test("control characters go and the message is cut at REMOTE_MESSAGE_CHARS", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        await req.formData();
        return Response.json(
          { error: "boom\nx", message: `line one\n\u001b[31mred\u0007${"z".repeat(5000)}` },
          { status: 500 },
        );
      },
    });
    try {
      const e = await refused(
        transcribeRemote({ url: `http://127.0.0.1:${server.port}`, key: "k", samples: HELLO }),
      );
      expect(e.code).toBe("boom x");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for them.
      expect(e.message).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(e.message).toContain("line one [31mred");
      expect(e.message.length).toBeLessThan(REMOTE_MESSAGE_CHARS + 120);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// DC-R6 in the session: the request opens at the press and takes each packet of the hold

describe("DC-R6: a spoken session streams to the remote while the key is held", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });
  const TARGET = { app: "a", pid: 1, window: "w", field: "editable" as const };
  const packet = (samples: Float32Array, fileSeconds: number): Packet => ({
    ch: "mic",
    zeroFilled: false,
    captureNs: 0n,
    fileSeconds,
    samples,
  });

  /** A session on `engine`, over a log in a scratch folder, recording what it sends the helper. */
  function session(engine: DictationEngine, o: { speech?: boolean } = {}) {
    const t = tempDir("akou-dict-stream-");
    cleanups.push(t.cleanup);
    const log = new DictationLog(t.dir);
    cleanups.push(() => log.close());
    const sent: AppToHelper[] = [];
    const s = new DictationSession({
      log,
      engine: () => engine,
      send: (c) => sent.push(c),
      bindings: () => ({
        hotkey: "RightCommand",
        draft: "",
        fixLast: "",
        pasteLast: "",
        activation: "hold",
      }),
      now: () => Date.now(),
      ...(o.speech !== undefined ? { speech: async () => o.speech as boolean } : {}),
    });
    const inserted = () => sent.find((c) => c.type === "insert") as { text: string } | undefined;
    return { s, sent, log, inserted };
  }

  /** Plays a hold of `samples` into the session, `pause` ms between packets. */
  async function hold(s: DictationSession, samples: Float32Array, id: string, pause = 0) {
    s.onMessage({ type: "session.started", id, target: TARGET, capture_ns: "0" });
    let at = 0;
    for (const p of packets(samples)) {
      s.onPacket(packet(p, at));
      at += p.length / 16000;
      if (pause) await Bun.sleep(pause);
    }
  }

  async function until(ok: () => boolean, what: string, ms = 5000) {
    for (const t0 = performance.now(); !ok(); await Bun.sleep(5)) {
      if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    }
  }

  test("the audio reaches the remote before release, in one request, and its transcript is inserted", async () => {
    const r = streamRemote();
    cleanups.push(r.stop);
    const net = network();
    const local = localEngine();
    const { s, inserted, log } = session(engine({ url: r.url }, { local, fetch: net.fetch }));
    await hold(s, HELLO, "1");
    await until(() => r.got.bytes > HELLO.length, "the audio of the hold to reach the remote");
    expect(r.got.ended).toBe(0);
    s.onMessage({ type: "session.ended", id: "1", reason: "release" });
    await until(() => inserted() !== undefined, "the insert");
    expect(inserted()?.text).toBe("hello from the stream");
    expect(r.got).toMatchObject({ ended: 1, broken: 0 });
    expect(r.got.chunked).toEqual(["chunked"]);
    expect(net.sent).toHaveLength(1);
    expect(local.calls).toBe(0);
    expect(log.items()[0]).toMatchObject({ engine: "remote", raw: "hello from the stream" });
  });

  test("a cancelled hold drops the request: the remote sees it broken, never ended, and nothing is inserted", async () => {
    const r = streamRemote();
    cleanups.push(r.stop);
    const local = localEngine();
    const { s, sent, log } = session(engine({ url: r.url }, { local }));
    await hold(s, HELLO, "1");
    await until(() => r.got.bytes > 0, "the request to open");
    s.onMessage({ type: "session.ended", id: "1", reason: "cancel" });
    await until(() => r.got.broken === 1, "the request to be dropped");
    await s.settled();
    expect(r.got.ended).toBe(0);
    expect(sent.some((c) => c.type === "insert")).toBe(false);
    expect(local.calls).toBe(0);
    expect(log.items()[0]?.state).toBe("cancelled");
  });

  test("a hold the VAD hears no speech in drops the request, and nothing is inserted", async () => {
    const r = streamRemote();
    cleanups.push(r.stop);
    const { s, sent } = session(engine({ url: r.url }), { speech: false });
    await hold(s, HELLO, "1");
    await until(() => r.got.bytes > 0, "the request to open");
    s.onMessage({ type: "session.ended", id: "1", reason: "release" });
    await until(() => r.got.broken === 1, "the request to be dropped");
    await s.settled();
    expect(r.got.ended).toBe(0);
    expect(sent.some((c) => c.type === "insert")).toBe(false);
  });

  test("against the server rig over a slow link, a 20 s hold's release-to-text is within 200 ms of a 3 s hold's; an engine that cannot stream is not", async () => {
    const rig = await appRig({
      settings: { ...SERVER },
      jobs: { dictationSlots: () => 1 } as AppOptions["jobs"],
    });
    cleanups.push(() => rig.close());
    const key = (await newKey(rig, "dictation")).key;
    // 800 KB/s up; the hold's 32 KB/s of audio is played here at ten times real time.
    const remote = engine(
      { url: `http://127.0.0.1:${rig.port}`, key },
      { fetch: slowLink(800_000) },
    );
    const audio = (seconds: number) => concat(HELLO, silence(seconds - HELLO.length / 16000));
    let n = 0;
    const releaseToText = async (e: DictationEngine, seconds: number) => {
      const { s, inserted } = session(e);
      const id = String(++n);
      await hold(s, audio(seconds), id, 10);
      const t0 = performance.now();
      s.onMessage({ type: "session.ended", id, reason: "release" });
      await until(() => inserted() !== undefined, "the insert", 20_000);
      expect(inserted()?.text).toContain("hello world");
      return performance.now() - t0;
    };
    const [s3, s20] = [await releaseToText(remote, 3), await releaseToText(remote, 20)];
    expect(Math.abs(s20 - s3)).toBeLessThan(200);
    // The positive control: the same engine without `open` sends the whole buffer at release.
    const atRelease: DictationEngine = { name: "remote", decode: (b, o) => remote.decode(b, o) };
    const [o3, o20] = [await releaseToText(atRelease, 3), await releaseToText(atRelease, 20)];
    expect(o20 - o3).toBeGreaterThan(200);
  });
});
