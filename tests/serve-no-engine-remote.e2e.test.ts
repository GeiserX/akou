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
  /** An AKOU_HOME another server used before; a new one otherwise. */
  home?: string;
  autoDownload?: boolean;
}): Promise<Server> {
  const t = o.home ? { dir: o.home } : tempDir("akou-noengine-");
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
      "server.auto_download": o.autoDownload ?? false,
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
    // A second server on the same home names a second key.
    `client-${rig.port}`,
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

describe("[#436] a no-engine front end with the files on its disk is ready only through a remote", () => {
  test("a remote that is up but offers nothing: models_ready false and the job refused; a remote offering fast: true", async () => {
    // The worker has the engine but no files and may not fetch them: up, offering nothing.
    const port = freePort();
    const empty = await server({ installed: false, port });
    const fdir = tempDir("akou-front-").dir;
    // The front end has the files on its own disk (a models pull, or a shared home).
    const front = await server({
      installed: true,
      noEngine: true,
      remotes: [entry(fdir, empty, port)],
    });
    const up = await remoteState(front, "up");
    expect(up.presets).toEqual([]);
    // Not ready by its status code, which is what a load balancer reads: the job below is refused.
    const health = await fetch(`http://127.0.0.1:${front.port}/healthz`);
    const hb = (await health.json()) as Body;
    expect([health.status, hb.ok, hb.models_ready, hb.reason]).toEqual([
      503,
      false,
      false,
      NO_ENGINE_REASON,
    ]);
    const refused = await submit(front, { language: "en" });
    expect([refused.status, refused.body.error]).toEqual([503, "no_engine"]);
    // Positive control: the same front end with a remote that offers fast is ready.
    const port2 = freePort();
    const worker = await server({ installed: true, port: port2 });
    const fdir2 = tempDir("akou-front-").dir;
    const front2 = await server({
      installed: true,
      noEngine: true,
      remotes: [entry(fdir2, worker, port2)],
    });
    await remoteState(front2, "up");
    const ready = await fetch(`http://127.0.0.1:${front2.port}/healthz`);
    expect([ready.status, ((await ready.json()) as Body).models_ready]).toEqual([200, true]);
  });
});

describe("[#469] a no-engine front end stays ready while a local models pull runs", () => {
  test("/healthz is 200 through an up remote while the front end's own files download; a server with the engine is 503 while loading", async () => {
    const release = reg.hold("a.onnx", 16);
    try {
      const port = freePort();
      const worker = await server({ installed: true, port });
      const front = await server({
        installed: false,
        noEngine: true,
        remotes: [entry(tempDir("akou-front-").dir, worker, port)],
      });
      await remoteState(front, "up");
      expect((await front.api("POST", "/models/pull")).status).toBe(202);
      expect((await front.api("GET", "/models")).body.state).toBe("downloading");
      // Files on this disk run nothing here: the remote still takes every job.
      const health = await fetch(`http://127.0.0.1:${front.port}/healthz`);
      const hb = (await health.json()) as Body;
      expect([health.status, hb.ok, hb.models_ready]).toEqual([200, true, true]);
      expect((await front.api("GET", "/models")).body.state).toBe("downloading");
      // Positive control: a server with the engine is not ready while its models download.
      const engine = await server({ installed: false });
      expect((await engine.api("POST", "/models/pull")).status).toBe(202);
      expect((await engine.api("GET", "/models")).body.state).toBe("downloading");
      const busy = await fetch(`http://127.0.0.1:${engine.port}/healthz`);
      const bb = (await busy.json()) as Body;
      expect([busy.status, bb.ok, bb.models_ready]).toEqual([503, false, false]);
    } finally {
      release();
    }
  });
});

/**
 * `worker` behind a proxy whose `GET /v1/server` lists no engine as installed, so it offers its
 * presets only: a remote that lists `best` as available while its Qwen is not downloaded yet.
 */
function presetsOnly(worker: Server): { port: number; stop(): void } {
  const base = `http://127.0.0.1:${worker.port}`;
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers = new Headers();
      for (const h of ["authorization", "content-type", "accept"]) {
        const v = req.headers.get(h);
        if (v) headers.set(h, v);
      }
      const res = await fetch(`${base}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      });
      const type = { "content-type": res.headers.get("content-type") ?? "application/json" };
      if (url.pathname !== "/v1/server") {
        return new Response(await res.arrayBuffer(), { status: res.status, headers: type });
      }
      const body: Body = await res.json();
      for (const e of body.engines ?? []) e.installed = false;
      return Response.json(body, { status: res.status });
    },
  });
  return { port: s.port as number, stop: () => s.stop(true) };
}

describe("[#436] a no-engine front end forwards a job a remote offers by preset name only", () => {
  test("preset=fast to a remote that lists fast but no installed engine comes back done", async () => {
    const worker = await server({ installed: true, port: freePort() });
    const proxy = presetsOnly(worker);
    try {
      const fdir = tempDir("akou-front-").dir;
      const front = await server({
        installed: false,
        noEngine: true,
        remotes: [entry(fdir, worker, proxy.port)],
      });
      const up = await remoteState(front, "up");
      expect(up.presets).toEqual(expect.arrayContaining(["fast"]));
      const r = await submit(front, { preset: "fast", language: "en" });
      expect([r.status, r.body]).toEqual([202, r.body]);
      const done = await get(front, `/v1/jobs/${r.body.id}?wait=30`);
      expect(done.body).toMatchObject({ id: r.body.id, status: "done" });
      expect((await get(front, `/v1/jobs/${r.body.id}/result`)).body.text).toBe("hello world");
    } finally {
      proxy.stop();
    }
  });
});

describe("[#436] a primary pointed at a no-engine front end", () => {
  test("sees it down and runs a job only a remote can run on its next remote; a probe without the header still sees it offer fast", async () => {
    const wport = freePort();
    const worker = await server({ installed: true, port: wport });
    const fport = freePort();
    const fdir = tempDir("akou-front-").dir;
    const front = await server({
      installed: false,
      noEngine: true,
      port: fport,
      remotes: [entry(fdir, worker, wport)],
    });
    await remoteState(front, "up");
    // Positive control: to a client that is not another akou, the front end offers what its
    // remote offers; the header is what makes the difference.
    const plain = (await get(front, "/v1/server")).body;
    expect(plain.capabilities.jobs).toBe(true);
    expect(plain.presets.find((p: Body) => p.name === "fast").available).toBe(true);
    // The front end first, the engine server second: the primary must skip the front end, which
    // refuses every forwarded job.
    const pdir = tempDir("akou-primary-").dir;
    const primary = await server({
      installed: false,
      remotes: [entry(pdir, front, fport), entry(pdir, worker, wport)],
    });
    await until(
      async () => {
        const rs: Body[] = (await get(primary, "/v1/server")).body.remotes;
        return rs[0]?.state === "down" && rs[1]?.state === "up";
      },
      10_000,
      "the primary to see the front end down and the engine server up",
    );
    const r = await submit(primary, { preset: "fast", language: "en" });
    expect([r.status, r.body]).toEqual([202, r.body]);
    const end = await get(primary, `/v1/jobs/${r.body.id}?wait=30`);
    expect(end.body).toMatchObject({ id: r.body.id, status: "done" });
    expect((await get(primary, `/v1/jobs/${r.body.id}/result`)).body.text).toBe("hello world");
  });
});

describe("[#436] a no-engine server never runs a job an earlier server left queued", () => {
  test("a queued job from a server with the engine, on the same home, ends failed with no_engine", async () => {
    const release = reg.hold("a.onnx", 16);
    try {
      // A server with the engine queues a job while its model downloads (held here).
      const first = await server({ installed: false, autoDownload: true });
      const r = await submit(first, { preset: "fast", language: "en" });
      expect([r.status, r.body]).toEqual([202, r.body]);
      expect((await get(first, `/v1/jobs/${r.body.id}`)).body.status).toBe("queued");
      open.splice(open.indexOf(first), 1);
      await first.close();
      // The single-file CLI's server on that home: the job is ended, not run.
      const later = await server({ installed: false, noEngine: true, home: first.dir });
      // The job belongs to the key that sent it, which the home keeps.
      const end = await get({ ...later, key: first.key }, `/v1/jobs/${r.body.id}?wait=10`);
      expect(end.body).toMatchObject({
        id: r.body.id,
        status: "failed",
        error: { code: "no_engine", message: NO_ENGINE_REASON },
      });
    } finally {
      release();
    }
  });
});

describe("[#436] a no-engine front end ends a leftover job no remote offers", () => {
  /** A job a server with the engine queued on a new home while its model downloads (held). */
  async function leftover(): Promise<{ home: string; key: string; id: string }> {
    const first = await server({ installed: false, autoDownload: true });
    const r = await submit(first, { preset: "fast", language: "en" });
    expect([r.status, r.body]).toEqual([202, r.body]);
    expect((await get(first, `/v1/jobs/${r.body.id}`)).body.status).toBe("queued");
    open.splice(open.indexOf(first), 1);
    await first.close();
    return { home: first.dir, key: first.key, id: r.body.id };
  }

  test("once its one remote is probed and offers nothing it ends no_engine; with a remote that offers fast it runs there", async () => {
    const release = reg.hold("a.onnx", 16);
    try {
      const a = await leftover();
      const port = freePort();
      const empty = await server({ installed: false, port });
      const front = await server({
        installed: false,
        noEngine: true,
        home: a.home,
        remotes: [entry(tempDir("akou-front-").dir, empty, port)],
      });
      const end = await get({ ...front, key: a.key }, `/v1/jobs/${a.id}?wait=10`);
      expect(end.body).toMatchObject({
        id: a.id,
        status: "failed",
        error: { code: "no_engine", message: NO_ENGINE_REASON },
      });
      // Positive control: the same leftover with a remote that offers fast comes back done.
      const b = await leftover();
      const port2 = freePort();
      const worker = await server({ installed: true, port: port2 });
      const front2 = await server({
        installed: false,
        noEngine: true,
        home: b.home,
        remotes: [entry(tempDir("akou-front-").dir, worker, port2)],
      });
      const done = await get({ ...front2, key: b.key }, `/v1/jobs/${b.id}?wait=30`);
      expect(done.body).toMatchObject({ id: b.id, status: "done" });
    } finally {
      release();
    }
  });
});

describe("[#436] another akou's probe is offered only what a server runs itself", () => {
  test("a server with the engine but not the files offers its probe nothing its remote offers; a client still sees fast", async () => {
    const wport = freePort();
    const worker = await server({ installed: true, port: wport });
    // The engine, no files and no download: fast is available here only through the worker.
    const mport = freePort();
    const middle = await server({
      installed: false,
      port: mport,
      remotes: [entry(tempDir("akou-middle-").dir, worker, wport)],
    });
    await remoteState(middle, "up");
    const fast = (b: Body) => b.presets.find((p: Body) => p.name === "fast").available;
    // Positive control: a client that is not another akou sees fast, which runs on the worker.
    expect(fast((await get(middle, "/v1/server")).body)).toBe(true);
    const probed = await fetch(`http://127.0.0.1:${mport}/v1/server`, {
      headers: { "akou-forwarded": "1" },
    });
    expect(fast(await probed.json())).toBe(false);
    // A no-engine front end pointed at it is offered nothing, so it refuses the job at once
    // instead of keeping one the middle server refuses (409) forever.
    const front = await server({
      installed: false,
      noEngine: true,
      remotes: [entry(tempDir("akou-front-").dir, middle, mport)],
    });
    const up = await remoteState(front, "up");
    expect(up.presets).toEqual([]);
    const r = await submit(front, { preset: "fast", language: "en" });
    expect([r.status, r.body.error]).toEqual([503, "no_engine"]);
  });
});
