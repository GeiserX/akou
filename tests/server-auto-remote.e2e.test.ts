/**
 * `GET /v1/server`'s `auto` preset next to a remote (#470, docs/ux/SERVER.md section 14). A job
 * that names no model runs what `auto` resolves to on this server, and that is what a remote is
 * sent, so `auto` is available here when a remote offers that preset, never because the remote's
 * own `auto` (which resolves on the remote) is available.
 *
 * Both ways the two disagree, on a server with an engine and on one without (#436):
 * - here `auto` is `best`, the remote offers `fast` and its own `auto`: not available, and a job
 *   with no model is refused;
 * - here `auto` is `fast`, the remote offers `fast` but not its own `auto`: available, and a job
 *   with no model is accepted and sent to it.
 * Each case checks the flag against what the job route does with the same job, so the two agree.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { type ModelSpecEntry, NEMOTRON, RECOGNIZER } from "../src/main/asr/models.ts";
import { NO_ENGINE_REASON } from "../src/main/cli/commands/serve.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { type ModelRegistry, modelRegistry } from "./fixtures/model-registry.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(60_000);

const PROBE_MS = 100;
const FAKE_KEY = "ak_fakeremotekey0123456789";
const NOTE = monoWav(concat(silence(0.4), speak(["hello", "world"]), silence(1)));

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

/** A remote speaking the job API that lists `fast`, and its own `auto` as `remoteAuto` says. */
function fakeRemote(remoteAuto: boolean) {
  let posts = 0;
  const srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/v1/server")
        return Response.json({
          name: "akou",
          version: "9.9.9",
          mode: "server",
          presets: [
            { name: "fast", available: true },
            { name: "best", available: false },
            { name: "auto", available: remoteAuto, resolves_to: "fast" },
          ],
          engines: [{ id: RECOGNIZER, installed: true }],
          capabilities: { jobs: true, events: true, webhooks: true },
        });
      if (u.pathname === "/v1/keys/me") return Response.json({ id: "k1", scopes: ["jobs"] });
      if (u.pathname === "/v1/jobs" && req.method === "POST") {
        await req.formData();
        posts++;
        return Response.json({ id: `job_HELD${posts}`, status: "queued" }, { status: 202 });
      }
      if (u.pathname.startsWith("/v1/jobs/job_HELD")) {
        if (req.method === "DELETE") return Response.json({ ok: true });
        await Bun.sleep(200);
        return Response.json({ id: u.pathname.split("/").pop(), status: "running" });
      }
      return Response.json({ error: "not_found", message: "no" }, { status: 404 });
    },
  });
  return { srv, posts: () => posts };
}

interface Primary extends AppRig {
  key: string;
}

/** A server whose `server.default_model` is `defaultModel`, forwarding to `remotePort`. */
async function primary(o: {
  noEngine: boolean;
  defaultModel: "fast" | "best";
  remotePort: number;
}): Promise<Primary> {
  const t = tempDir("akou-auto-remote-");
  const models = join(t.dir, "models");
  mkdirSync(models, { recursive: true });
  // With `best` the default, `fast` is on disk and Qwen is not; with `fast`, nothing is. Either way
  // the default cannot run here, and `server.auto_download` off means it cannot be fetched.
  if (o.defaultModel === "best") for (const m of catalog) reg.install(models, m);
  const keyFile = join(t.dir, "remote.key");
  writeFileSync(keyFile, `${FAKE_KEY}\n`, { mode: 0o600 });
  const rig = await appRig({
    home: t.dir,
    modelRegistry: [...catalog, reg.entry(QWEN_ASR, ["q.gguf"])],
    settings: {
      "server.enabled": true,
      "api.bind": "127.0.0.1",
      "asr.modelsDir": models,
      "server.auto_download": false,
      "server.default_model": o.defaultModel,
      "server.remotes": [`http://127.0.0.1:${o.remotePort} ${keyFile}`],
    },
    jobs: {
      modelStore: { retryMs: [5, 5, 5], freeBytes: () => 1e12 },
      remoteProbeMs: PROBE_MS,
    },
    ...(o.noEngine ? { noEngine: NO_ENGINE_REASON } : {}),
  });
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
  return { ...rig, key: r.json.key };
}

async function serverInfo(p: Primary): Promise<Body> {
  return (await (await fetch(`http://127.0.0.1:${p.port}/v1/server`)).json()) as Body;
}

async function submit(p: Primary): Promise<number> {
  const form = new FormData();
  form.append("file", new Blob([NOTE], { type: "audio/wav" }), "note.wav");
  const res = await fetch(`http://127.0.0.1:${p.port}/v1/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${p.key}` },
    body: form,
  });
  await res.body?.cancel();
  return res.status;
}

for (const noEngine of [false, true]) {
  const kind = noEngine ? "a server with no engine" : "a server with an engine";
  describe(`[#470] ${kind}: auto is available by what it resolves to here, not by the remote's auto`, () => {
    test("auto is best here, the remote offers fast and its own auto: auto is not available, and a job with no model is refused", async () => {
      const remote = fakeRemote(true);
      const p = await primary({
        noEngine,
        defaultModel: "best",
        remotePort: remote.srv.port as number,
      });
      try {
        await until(
          async () => (await serverInfo(p)).remotes?.[0]?.state === "up",
          10_000,
          "the primary to see its remote up",
        );
        const s = await serverInfo(p);
        const preset = (n: string) => s.presets.find((x: Body) => x.name === n);
        // The remote's fast is listed here, so the probe was read.
        expect(preset("fast").available).toBe(true);
        expect(preset("auto")).toMatchObject({ resolves_to: "best", available: false });
        expect(await submit(p)).not.toBe(202);
        expect(remote.posts()).toBe(0);
      } finally {
        await p.close();
        remote.srv.stop(true);
      }
    });

    test("auto is fast here, the remote offers fast but not its own auto: auto is available, and a job with no model goes to the remote", async () => {
      const remote = fakeRemote(false);
      const p = await primary({
        noEngine,
        defaultModel: "fast",
        remotePort: remote.srv.port as number,
      });
      try {
        await until(
          async () => (await serverInfo(p)).remotes?.[0]?.state === "up",
          10_000,
          "the primary to see its remote up",
        );
        const s = await serverInfo(p);
        expect(s.presets.find((x: Body) => x.name === "auto")).toMatchObject({
          resolves_to: "fast",
          available: true,
        });
        // Another akou's probe is offered only what this server runs itself (#436).
        const probe = (await (
          await fetch(`http://127.0.0.1:${p.port}/v1/server`, {
            headers: { "akou-forwarded": "1" },
          })
        ).json()) as Body;
        expect(probe.presets.find((x: Body) => x.name === "auto").available).toBe(false);
        expect(await submit(p)).toBe(202);
        await until(async () => remote.posts() === 1, 10_000, "the job to reach the remote");
      } finally {
        await p.close();
        remote.srv.stop(true);
      }
    });
  });
}
