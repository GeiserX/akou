/**
 * A server with no speech engine (#436) next to other akou servers (docs/ux/SERVER.md section 14).
 *
 * As a remote: a primary that lists it in `server.remotes` must never send it work, even with the
 * recognizer's files on its disk, so its `GET /v1/server` (the probe a primary reads) offers no
 * engine and no job capability. As a front end: with `server.remotes` of its own it takes jobs and
 * forwards every one, since it can run none itself, and its `/healthz` is ready while a remote is up.
 *
 * Each check has its positive control: the same server with the engine is offered, and the same
 * front end with no remote refuses the job with `no_engine`.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { NO_ENGINE_REASON } from "../src/main/cli/commands/serve.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
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
const open: AppRig[] = [];

beforeAll(() => {
  reg = modelRegistry();
  catalog = [
    reg.entry(RECOGNIZER, ["a.onnx"]),
    reg.entry("silero-vad", ["vad.onnx"]),
    reg.entry(NEMOTRON, ["diar.onnx"]),
  ];
});
afterAll(async () => {
  for (const r of open.splice(0).reverse()) await r.close();
  reg.stop();
});

function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const p = s.port as number;
  s.stop(true);
  return p;
}

interface Server extends AppRig {
  key: string;
  dir: string;
}

/** A server with a `jobs` key; the recognizer's files on disk when `installed`. */
async function server(o: {
  installed: boolean;
  noEngine?: boolean;
  port?: number;
  remotes?: string[];
}): Promise<Server> {
  const t = tempDir("akou-noengine-");
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
      ...(o.remotes ? { "server.remotes": o.remotes } : {}),
    },
    jobs: {
      modelStore: { retryMs: [5, 5, 5], freeBytes: () => 1e12 },
      remoteProbeMs: PROBE_MS,
      decode: (p, s) => readUploadAudio(p, { signal: s, maxSamples: Number.MAX_SAFE_INTEGER }),
    },
    ...(o.noEngine ? { noEngine: NO_ENGINE_REASON } : {}),
  });
  open.push(rig);
  const r = await cli({ ...process.env, ...rig.env }, [
    "keys",
    "create",
    "--name",
    "client",
    "--scope",
    "jobs",
    "--json",
  ]);
  expect(r.code).toBe(0);
  return { ...rig, key: r.json.key, dir: t.dir };
}

async function get(s: Server, path: string): Promise<{ status: number; body: Body }> {
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    headers: { authorization: `Bearer ${s.key}` },
  });
  return { status: res.status, body: await res.json() };
}

async function submit(s: Server, fields: Record<string, string>) {
  const form = new FormData();
  form.append("file", new Blob([NOTE], { type: "audio/wav" }), "note.wav");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`http://127.0.0.1:${s.port}/v1/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.key}` },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

/** `server.remotes` entry for `s`, with its key in a file under `dir`. */
function entry(dir: string, s: Server, port: number): string {
  const f = join(dir, `remote-${port}.key`);
  writeFileSync(f, `${s.key}\n`, { mode: 0o600 });
  return `http://127.0.0.1:${port} ${f}`;
}

async function remoteState(p: Server, want: string): Promise<Body> {
  let last: Body = null;
  await until(
    async () => {
      last = (await get(p, "/v1/server")).body?.remotes?.[0];
      return last?.state === want;
    },
    10_000,
    `the primary to see its remote ${want}`,
  );
  return last;
}

describe("[#436] a no-engine server as a remote is offered nothing", () => {
  test("its /v1/server lists no installed engine and no job capability, though the files are on disk", async () => {
    const none = await server({ installed: true, noEngine: true });
    const s = (await get(none, "/v1/server")).body;
    expect(s.engines.every((e: Body) => e.installed === false)).toBe(true);
    expect(s.presets.filter((p: Body) => p.available).map((p: Body) => p.name)).toEqual([]);
    expect(s.capabilities).toMatchObject({
      jobs: false,
      openai: false,
      interactive: false,
      live: false,
      translate: false,
    });
    // Positive control: the same files with the engine are installed and take jobs.
    const engine = await server({ installed: true });
    const e = (await get(engine, "/v1/server")).body;
    expect(e.engines.find((x: Body) => x.id === RECOGNIZER).installed).toBe(true);
    expect(e.capabilities.jobs).toBe(true);
  });

  test("a primary that lists it sees it down and offering nothing; the same server with the engine is up", async () => {
    const port = freePort();
    const none = await server({ installed: true, noEngine: true, port });
    const pdir = tempDir("akou-primary-").dir;
    const primary = await server({ installed: false, remotes: [entry(pdir, none, port)] });
    const r = await remoteState(primary, "down");
    expect(r.presets).toEqual([]);
    expect(
      (await get(primary, "/v1/server")).body.presets.find((p: Body) => p.name === "fast")
        .available,
    ).toBe(false);
    // Positive control: a server with the engine in the same place is up and offers fast.
    const port2 = freePort();
    const engine = await server({ installed: true, port: port2 });
    const pdir2 = tempDir("akou-primary-").dir;
    const primary2 = await server({ installed: false, remotes: [entry(pdir2, engine, port2)] });
    const up = await remoteState(primary2, "up");
    expect(up.presets).toContain("fast");
  });
});

describe("[#436] a no-engine server with remotes forwards every job", () => {
  test("a job runs on the remote and comes back done; with no remote it is refused with no_engine", async () => {
    const port = freePort();
    const worker = await server({ installed: true, port });
    const fdir = tempDir("akou-front-").dir;
    const front = await server({
      installed: false,
      noEngine: true,
      remotes: [entry(fdir, worker, port)],
    });
    await remoteState(front, "up");
    // Ready while a remote is up: it can serve every job through it.
    expect((await fetch(`http://127.0.0.1:${front.port}/healthz`)).status).toBe(200);
    const r = await submit(front, { preset: "fast", language: "en" });
    expect([r.status, r.body]).toEqual([202, r.body]);
    const done = await get(front, `/v1/jobs/${r.body.id}?wait=30`);
    expect(done.body).toMatchObject({ id: r.body.id, status: "done" });
    const result = await get(front, `/v1/jobs/${r.body.id}/result`);
    expect(result.body.text).toBe("hello world");
    // Positive control: the same front end with no remote refuses at once, and is not ready.
    const alone = await server({ installed: false, noEngine: true });
    const refused = await submit(alone, { preset: "fast", language: "en" });
    expect([refused.status, refused.body.error]).toEqual([503, "no_engine"]);
    expect((await fetch(`http://127.0.0.1:${alone.port}/healthz`)).status).toBe(503);
  });
});
