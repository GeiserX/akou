/**
 * An akou server hands jobs to other akou servers on the network (docs/ux/SERVER.md section 14,
 * akou-5an.96), end to end through two real servers in this process: the primary a client talks
 * to, and a worker it forwards to. The client sees only the primary: its job id, its event feed,
 * its signed webhook, its own metadata. A worker that stops leaves the job queued, never failed, and
 * the job finishes when the worker returns. The worker's key never reaches a client.
 *
 * The primary has no recognizer on disk and `server.auto_download` off, so it cannot run `fast`
 * itself; the worker has one. A fake worker, a plain HTTP server speaking the job API, stands in
 * for a remote that offers `best`, which no real akou builds yet.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startReceiver, tamperedRefused } from "../scripts/server-roundtrip.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { checkRemotes, parseRemote } from "../src/main/server/remotes.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav, RATE } from "./fixtures/audio.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const PROBE_MS = 100;

function clip(words: string[], seconds: number): Uint8Array {
  const speech = concat(silence(0.4), speak(words));
  return monoWav(concat(speech, silence(Math.max(0, seconds - speech.length / RATE))));
}
const NOTE = clip(["hello", "world"], 3);

// biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
type Body = any;

let reg: ModelRegistry;
let catalog: ModelSpecEntry[];

beforeAll(() => {
  reg = modelRegistry();
  catalog = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
  ];
});
afterAll(() => reg.stop());

function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const p = s.port as number;
  s.stop(true);
  return p;
}

interface Server extends AppRig {
  key: string;
  secret: string;
  dir: string;
}

/** A server with a `jobs` key; `installed` models in its folder, or none. */
async function server(o: {
  home?: string;
  port?: number;
  installed: boolean;
  settings?: Record<string, unknown>;
  decode?: (p: string, s: AbortSignal) => Promise<Float32Array>;
  keyName?: string;
}): Promise<Server> {
  const t = o.home ? { dir: o.home } : tempDir("akou-remote-");
  const models = join(t.dir, "models");
  mkdirSync(models, { recursive: true });
  if (o.installed) for (const m of catalog) reg.install(models, m);
  const rig = await appRig({
    home: t.dir,
    modelRegistry: catalog,
    settings: {
      "server.enabled": true,
      "api.bind": "127.0.0.1",
      "asr.modelsDir": models,
      "server.auto_download": false,
      ...(o.port ? { "api.port": o.port } : {}),
      ...o.settings,
    },
    jobs: {
      modelStore: { retryMs: [5, 5, 5], freeBytes: () => 1e12 },
      remoteProbeMs: PROBE_MS,
      ...(o.decode ? { decode: o.decode } : {}),
    },
  });
  let key = "";
  let secret = "";
  if (o.keyName !== undefined) {
    const r = await cli({ ...process.env, ...rig.env }, [
      "keys",
      "create",
      "--name",
      o.keyName,
      "--scope",
      "jobs",
      "--callback-host",
      "127.0.0.1",
      "--json",
    ]);
    expect(r.code).toBe(0);
    key = r.json.key;
    secret = r.json.secret;
  }
  return { ...rig, key, secret, dir: t.dir };
}

async function submit(
  s: Server,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Body; text: string }> {
  const form = new FormData();
  form.append("file", new Blob([NOTE], { type: "audio/wav" }), "note.wav");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`http://127.0.0.1:${s.port}/v1/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.key}`, ...headers },
    body: form,
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

async function get(
  s: Server,
  path: string,
  key = s.key,
): Promise<{ status: number; body: Body; text: string }> {
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  let body: Body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text };
}

/** The worker's key file, named in the primary's `server.remotes`. */
function keyFile(dir: string, key: string): string {
  const f = join(dir, "worker.key");
  writeFileSync(f, `${key}\n`, { mode: 0o600 });
  return f;
}

async function remoteState(p: Server, want: string): Promise<void> {
  await until(
    async () => (await get(p, "/v1/server")).body?.remotes?.[0]?.state === want,
    10_000,
    `the primary to see its remote ${want}`,
  );
}

test("[SV-X1] a server.remotes entry is <url> <key file> [names], and a bad one is refused", () => {
  expect(parseRemote("http://mini.lan:8476/ /data/mini.key")).toEqual({
    url: "http://mini.lan:8476",
    keyFile: "/data/mini.key",
    takes: [],
  });
  expect(parseRemote("https://mini.example ~/mini.key best,fusion")).toEqual({
    url: "https://mini.example",
    keyFile: "~/mini.key",
    takes: ["best", "fusion"],
  });
  expect(parseRemote("https://mini.example /k *")).toMatchObject({ takes: ["*"] });
  expect(parseRemote("mini.lan:8476 /k")).toBeString();
  expect(parseRemote("https://mini.example")).toBeString();
  expect(parseRemote("https://u:p@mini.example /k")).toBeString();
  expect(parseRemote("https://mini.example?x=1 /k")).toBeString();
  expect(parseRemote("https://mini.example relative.key")).toBeString();
  expect(parseRemote("https://mini.example /k ../etc")).toBeString();
  expect(checkRemotes(["http://a /k", "http://a/ /j"])).toContain("twice");
  expect(checkRemotes(["http://a /k", "http://b /k fast"])).toBeNull();
});

describe("[SV-X2, SV-X3, SV-X4] a job the primary cannot run runs on a worker; the client sees only the primary", () => {
  let worker: Server;
  let primary: Server;
  let workerHome: string;
  let workerPort: number;
  let workerKey: string;
  let gate: { open: () => void; wait: Promise<void> };
  const newGate = () => {
    let open = () => {};
    const wait = new Promise<void>((r) => {
      open = r;
    });
    return { open, wait };
  };

  beforeAll(async () => {
    gate = newGate();
    gate.open();
    workerHome = tempDir("akou-worker-").dir;
    workerPort = freePort();
    worker = await server({
      home: workerHome,
      port: workerPort,
      installed: true,
      keyName: "primary",
      decode: async (p, s) => {
        await gate.wait;
        return readUploadAudio(p, { signal: s, maxSamples: Number.MAX_SAFE_INTEGER });
      },
    });
    workerKey = worker.key;
    const pdir = tempDir("akou-primary-").dir;
    primary = await server({
      home: pdir,
      installed: false,
      keyName: "archive",
      settings: {
        "server.remotes": [`http://127.0.0.1:${workerPort} ${keyFile(pdir, workerKey)}`],
      },
    });
    await remoteState(primary, "up");
  });
  afterAll(async () => {
    await primary.close();
    await worker.close();
  });

  test("GET /v1/server on the primary lists the worker, fast as available, and never the key", async () => {
    const s = await get(primary, "/v1/server");
    expect(s.body.remotes).toEqual([
      expect.objectContaining({
        url: `http://127.0.0.1:${workerPort}`,
        state: "up",
        presets: expect.arrayContaining(["fast"]),
      }),
    ]);
    expect(s.body.presets.find((p: Body) => p.name === "fast").available).toBe(true);
    expect(s.text).not.toContain(workerKey);
    expect(s.text).not.toContain("worker.key");
  });

  test("the job runs on the worker and comes back under the primary's id, feed, metadata and webhook", async () => {
    const receiver = startReceiver({ secret: primary.secret });
    try {
      const r = await submit(primary, {
        preset: "fast",
        language: "en",
        metadata: '{"content_hash": "abc"}',
        callback_url: `http://127.0.0.1:${receiver.port}/api/transcriptions/callback`,
      });
      expect([r.status, r.text]).toEqual([202, r.text]);
      const id = r.body.id as string;
      const done = await get(primary, `/v1/jobs/${id}?wait=30`);
      expect(done.body).toMatchObject({ id, status: "done", metadata: { content_hash: "abc" } });
      const result = await get(primary, `/v1/jobs/${id}/result`);
      expect(result.body).toMatchObject({
        job_id: id,
        status: "done",
        text: "hello world",
        metadata: { content_hash: "abc" },
      });
      expect(result.body.engine.models[0]).toBe(RECOGNIZER);

      // It ran on the worker: one job there, under the primary's key, sent with no metadata.
      const there = await get(worker, "/v1/jobs", worker.token);
      expect(there.body.jobs).toHaveLength(1);
      expect(there.body.jobs[0]).toMatchObject({ status: "done", metadata: null });
      expect(there.body.jobs[0].id).not.toBe(id);

      const feed = await get(primary, "/v1/events?after=0");
      expect(feed.body.events.map((e: Body) => [e.type, e.job_id])).toEqual([
        ["transcription.completed", id],
      ]);
      expect(feed.body.events[0].data).toMatchObject({ job_id: id, text: "hello world" });

      await until(() => receiver.deliveries.length === 1, 10_000, "the primary's webhook");
      const d = receiver.deliveries[0] as NonNullable<(typeof receiver.deliveries)[0]>;
      expect(d.body).toMatchObject({
        type: "transcription.completed",
        data: { job_id: id, metadata: { content_hash: "abc" }, text: "hello world" },
      });
      // Signed with the primary key's secret: the receiver verified it, and refuses a tampered copy.
      expect(await tamperedRefused(receiver, d)).toBe(true);

      // The worker's key is in none of it, nor in the settings an admin reads, nor in the log.
      const config = await get(primary, "/v1/config", primary.token);
      expect(config.status).toBe(200);
      const seen = [
        r.text,
        done.text,
        result.text,
        feed.text,
        d.raw,
        config.text,
        JSON.stringify(primary.logs),
      ];
      const leaks = (texts: string[]) => texts.some((t) => t.includes(workerKey));
      expect(leaks(seen)).toBe(false);
      // Positive control: the same check finds the key where it is put.
      expect(leaks([...seen, `Bearer ${workerKey}`])).toBe(true);
    } finally {
      receiver.stop();
    }
  });

  test("a worker that stops leaves the job queued, not failed; it finishes when the worker returns", async () => {
    gate = newGate();
    const r = await submit(primary, { preset: "fast", language: "en" });
    expect(r.status).toBe(202);
    const id = r.body.id as string;
    // Running on the worker, held in its decode.
    await until(
      async () =>
        (await get(worker, "/v1/jobs?status=running", worker.token)).body?.jobs?.length === 1,
      10_000,
      "the job to run on the worker",
    );
    expect((await get(primary, `/v1/jobs/${id}`)).body.status).toBe("running");

    await worker.app.quit();
    await until(
      async () => (await get(primary, `/v1/jobs/${id}`)).body.status === "queued",
      10_000,
      "the primary's job to go back to queued",
    );
    await remoteState(primary, "down");
    // Still queued a while later: a worker that is down never fails the job.
    await Bun.sleep(PROBE_MS * 5);
    expect((await get(primary, `/v1/jobs/${id}`)).body.status).toBe("queued");

    // The worker returns, on the same address with the same job store.
    gate.open();
    worker = await server({ home: workerHome, port: workerPort, installed: true });
    worker.key = workerKey;
    const done = await get(primary, `/v1/jobs/${id}?wait=30`);
    expect(done.body).toMatchObject({ id, status: "done" });
    expect((await get(primary, `/v1/jobs/${id}/result`)).body).toMatchObject({
      job_id: id,
      text: "hello world",
    });
    // One job on the worker for it, not two: the upload was sent with the job's id as its key.
    const there = await get(worker, "/v1/jobs", worker.token);
    expect(there.body.jobs).toHaveLength(2);
  });
});

describe("[SV-X5] a remote that is down is skipped for the next", () => {
  test("the first remote refuses connections; the job runs on the second", async () => {
    const worker = await server({ installed: true, keyName: "primary" });
    const pdir = tempDir("akou-primary-").dir;
    const kf = keyFile(pdir, worker.key);
    const primary = await server({
      home: pdir,
      installed: false,
      keyName: "archive",
      settings: {
        "server.remotes": [
          `http://127.0.0.1:${freePort()} ${kf}`,
          `http://127.0.0.1:${worker.port} ${kf}`,
        ],
      },
    });
    try {
      await until(
        async () => (await get(primary, "/v1/server")).body?.remotes?.[1]?.state === "up",
        10_000,
        "the second remote up",
      );
      const s = await get(primary, "/v1/server");
      expect(s.body.remotes[0].state).toBe("down");
      const r = await submit(primary, { preset: "fast" });
      expect(r.status).toBe(202);
      expect((await get(primary, `/v1/jobs/${r.body.id}?wait=30`)).body.status).toBe("done");
      expect((await get(worker, "/v1/jobs", worker.token)).body.jobs).toHaveLength(1);
    } finally {
      await primary.close();
      await worker.close();
    }
  });
});

describe("[SV-X6] a job the primary can run stays here, unless its remote entry names it", () => {
  test("no names: local; `fast` named: the worker; the worker down: local again", async () => {
    const worker = await server({ installed: true, keyName: "primary" });
    const run = async (takes: string, port = worker.port): Promise<void> => {
      const pdir = tempDir("akou-primary-").dir;
      const primary = await server({
        home: pdir,
        installed: true,
        keyName: "archive",
        settings: {
          "server.remotes": [
            `http://127.0.0.1:${port} ${keyFile(pdir, worker.key)} ${takes}`.trim(),
          ],
        },
      });
      try {
        if (port === worker.port) await remoteState(primary, "up");
        else await remoteState(primary, "down");
        const r = await submit(primary, { preset: "fast" });
        expect(r.status).toBe(202);
        expect((await get(primary, `/v1/jobs/${r.body.id}?wait=30`)).body.status).toBe("done");
      } finally {
        await primary.close();
      }
    };
    const count = async () => (await get(worker, "/v1/jobs", worker.token)).body.jobs.length;
    try {
      await run("");
      expect(await count()).toBe(0);
      await run("fast");
      expect(await count()).toBe(1);
      await run("fast", freePort());
      expect(await count()).toBe(1);
    } finally {
      await worker.close();
    }
  });
});

describe("[SV-X7] best, which no local engine runs, goes to a remote that offers it", () => {
  const RID = "job_REMOTE1";
  const seen: {
    auth: string | null;
    forwarded: string | null;
    idem: string | null;
    fields: Record<string, string[]>;
  }[] = [];
  let fake: ReturnType<typeof Bun.serve>;
  const FAKE_KEY = "ak_fakeworkerkey0123456789";

  beforeAll(() => {
    fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        const authed = req.headers.get("authorization") === `Bearer ${FAKE_KEY}`;
        if (u.pathname === "/v1/server") {
          return Response.json({
            name: "akou",
            version: "9.9.9",
            mode: "server",
            presets: [
              { name: "fast", available: false },
              { name: "best", available: true },
            ],
            engines: [{ id: "qwen3-asr-1.7b", installed: true }],
            capabilities: { jobs: true, events: true, webhooks: true },
          });
        }
        if (!authed)
          return Response.json({ error: "unauthorized", message: "no" }, { status: 401 });
        if (u.pathname === "/v1/keys/me") return Response.json({ id: "k1", scopes: ["jobs"] });
        if (u.pathname === "/v1/jobs" && req.method === "POST") {
          const form = await req.formData();
          const fields: Record<string, string[]> = {};
          for (const [k, v] of form.entries()) {
            const list = fields[k] ?? [];
            list.push(typeof v === "string" ? v : `<file ${v.size}>`);
            fields[k] = list;
          }
          seen.push({
            auth: req.headers.get("authorization"),
            forwarded: req.headers.get("akou-forwarded"),
            idem: req.headers.get("idempotency-key"),
            fields,
          });
          return Response.json({ id: RID, status: "queued" }, { status: 202 });
        }
        if (u.pathname === `/v1/jobs/${RID}`) return Response.json({ id: RID, status: "done" });
        if (u.pathname === `/v1/jobs/${RID}/result`) {
          return Response.json({
            job_id: RID,
            status: "done",
            text: "hola mundo",
            language: "es",
            language_confidence: null,
            duration_s: 3,
            words: [],
            segments: [
              { s: 0.4, e: 1.2, text: "hola", speaker: "S1" },
              { s: 1.3, e: 2, text: "mundo", speaker: "S2" },
            ],
            engine: {
              name: "akou",
              version: "9.9.9",
              preset: "best",
              models: ["qwen3-asr-1.7b", "silero-vad", NEMOTRON],
            },
            confidence: null,
            metadata: null,
          });
        }
        return Response.json({ error: "not_found", message: "no" }, { status: 404 });
      },
    });
  });
  afterAll(() => fake.stop(true));

  test("the primary accepts best, forwards it with diarize and no metadata, and relays the result", async () => {
    const pdir = tempDir("akou-primary-").dir;
    const primary = await server({
      home: pdir,
      installed: true,
      keyName: "archive",
      settings: { "server.remotes": [`http://127.0.0.1:${fake.port} ${keyFile(pdir, FAKE_KEY)}`] },
    });
    try {
      await remoteState(primary, "up");
      const best = (await get(primary, "/v1/server")).body.presets.find(
        (p: Body) => p.name === "best",
      );
      expect(best.available).toBe(true);
      // A job already forwarded once is never forwarded again: the primary runs it or refuses it.
      const again = await submit(primary, { preset: "best" }, { "akou-forwarded": "1" });
      expect(again.status).toBe(409);
      expect(seen).toHaveLength(0);

      const r = await submit(primary, {
        preset: "best",
        diarize: "true",
        language: "es",
        metadata: '{"chat": 7}',
      });
      expect([r.status, r.text]).toEqual([202, r.text]);
      expect(r.body).toMatchObject({ preset: "best", status: "queued" });
      const id = r.body.id as string;
      expect((await get(primary, `/v1/jobs/${id}?wait=30`)).body.status).toBe("done");
      const result = (await get(primary, `/v1/jobs/${id}/result`)).body;
      expect(result).toMatchObject({
        job_id: id,
        text: "hola mundo",
        metadata: { chat: 7 },
        engine: { preset: "best", models: ["qwen3-asr-1.7b", "silero-vad", NEMOTRON] },
      });
      expect(result.segments.map((s: Body) => s.speaker)).toEqual(["S1", "S2"]);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ auth: `Bearer ${FAKE_KEY}`, forwarded: "1", idem: id });
      expect(seen[0]?.fields).toMatchObject({
        preset: ["best"],
        diarize: ["true"],
        language: ["es"],
      });
      expect(seen[0]?.fields.metadata).toBeUndefined();
      expect(seen[0]?.fields.callback_url).toBeUndefined();
      expect(JSON.stringify(primary.logs)).not.toContain(FAKE_KEY);
    } finally {
      await primary.close();
    }
  });

  test("with no remote ever seen offering best, best is still 409 preset_unavailable", async () => {
    const pdir = tempDir("akou-primary-").dir;
    const primary = await server({
      home: pdir,
      installed: true,
      keyName: "archive",
      settings: {
        "server.remotes": [`http://127.0.0.1:${freePort()} ${keyFile(pdir, FAKE_KEY)}`],
      },
    });
    try {
      await remoteState(primary, "down");
      const r = await submit(primary, { preset: "best" });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe("preset_unavailable");
    } finally {
      await primary.close();
    }
  });
});
