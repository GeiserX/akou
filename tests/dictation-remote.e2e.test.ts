/**
 * Dictation through a remote akou (docs/ux/DICTATION.md section 7.2): the client of DC-R1 against a
 * real server-mode rig with a dictation lane, and against a loopback fake remote that records what
 * it was sent; the URL rule with a fake resolver; the timeout that grows with the audio (DC-R3);
 * and the Test of DC-R4. Every request goes through a fake network that records its destination,
 * so a test sees that nothing left for any other host.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  REMOTE_TIMEOUT_SECONDS,
  RemoteDictationError,
  remoteBase,
  remoteKeywords,
  remoteTimeoutMs,
  testRemote,
  transcribeRemote,
  vetRemote,
} from "../src/main/dictation/remote.ts";
import type { AppOptions } from "../src/main/index.ts";
import type { Resolver } from "../src/main/server/webhooks.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
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
  o: { delayMs?: number; status?: number; server?: unknown } = {},
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
      return Response.json({ language: "en", duration: 2, text: "hello from the fake", words: [] });
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
      engine: "auto",
      accelerator: "cpu",
      biasing: "no biasing",
      interactive: true,
      warning: null,
    });
    expect(t.summary).toMatch(/^ok, auto on cpu, no biasing, \d+ ms$/);
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
