/**
 * Test support for the app and its local API: a whole app in a temporary `AKOU_HOME`, capturing
 * from `scripts/fake-helper.ts` and transcribing with the fake recognizer, plus a raw HTTP client
 * that sends exactly the bytes a browser (or an attacker) would, Host header included.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { Guard } from "../src/main/api/guard.ts";
import type { ModelSpec } from "../src/main/asr/engine.ts";
import type { FinalAudioSpec } from "../src/main/asr/finalize-worker.ts";
import { type AkouApp, startApp } from "../src/main/index.ts";
import type { Discovery } from "../src/main/llm/harness.ts";
import type { Provider } from "../src/main/llm/provider.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { stereoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

export const FAKE_HELPER = join(import.meta.dir, "..", "scripts", "fake-helper.ts");
export const FAKE_MODELS = join(import.meta.dir, "fixtures", "asr-fake.ts");

// Loopback requests must never go through a proxy (DESIGN 6.3 rule 6).
process.env.NO_PROXY = "127.0.0.1,localhost";

export interface ApiResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test bodies are inspected field by field.
  body: any;
  headers: Headers;
  text: string;
}

export interface AppRig {
  app: AkouApp;
  home: string;
  env: Record<string, string>;
  port: number;
  token: string;
  logs: { level: string; msg: string }[];
  api(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiResult>;
  /** Starts a call and returns its id, failing the test on anything but 201. */
  startCall(body?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export interface RigOptions {
  guard?: Guard;
  /** Extra switches for the fake helper. */
  helperArgs?: string[];
  settings?: Record<string, unknown>;
  models?: ModelSpec | null;
  finalAudio?: (call: { id: string; dir: string; parts: number[] }) => FinalAudioSpec | null;
  home?: string;
  provider?: Provider;
  discover?: (env: Record<string, string | undefined>) => Promise<Discovery>;
}

/** A WAV the fake recognizer reads as words: "hello world" on the mic, "ok great" on the call. */
export function speechWav(dir: string): string {
  const mic = concat(silence(0.4), speak(["hello", "world"]), silence(1.6));
  const call = concat(silence(1.2), speak(["ok", "great"], { voice: 2 }), silence(0.8));
  const n = Math.max(mic.length, call.length);
  const pad = (x: Float32Array) => concat(x, silence((n - x.length) / 16000));
  const path = join(dir, "speech.wav");
  writeFileSync(path, stereoWav(pad(mic), pad(call)));
  return path;
}

export function writeSettings(home: string, settings: Record<string, unknown>): void {
  const dir = join(home, ".config", "akou");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(settings));
}

export async function appRig(o: RigOptions = {}): Promise<AppRig> {
  const t = o.home ? { dir: o.home, cleanup: () => {} } : tempDir("akou-app-");
  const env = { AKOU_HOME: t.dir, AKOU_HEADLESS: "1" };
  writeSettings(t.dir, {
    "api.port": 0,
    "capture.helper": [process.execPath, FAKE_HELPER, ...(o.helperArgs ?? [])],
    "capture.coldStartSeconds": 10,
    "capture.stopSeconds": 3,
    "user.name": "Ana",
    // No test runs the user's real harness; harness tests pass a fake provider or discovery.
    "provider.kind": "none",
    ...o.settings,
  });
  const logs: AppRig["logs"] = [];
  const app = await startApp({
    env,
    models:
      o.models !== undefined
        ? o.models
        : { kind: "module", path: FAKE_MODELS, model: "fake-parakeet", options: {} },
    asrInThread: true,
    finalAudio: o.finalAudio,
    guard: o.guard,
    provider: o.provider,
    discover: o.discover,
    onLog: (level, msg) => logs.push({ level, msg }),
  });
  const port = app.server?.port as number;
  const token = readFileSync(app.tokenPath, "utf8").trim();
  const api: AppRig["api"] = async (method, path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${rig.token}`,
        "x-akou-client": "test",
        ...(method !== "GET" ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed, headers: res.headers, text };
  };
  const rig: AppRig = {
    app,
    home: t.dir,
    env,
    port,
    token,
    logs,
    api,
    startCall: async (body = {}) => {
      const r = await api("POST", "/calls", { workspace: "work", title: "Sync", ...body });
      if (r.status !== 201) throw new Error(`start answered ${r.status}: ${r.text}`);
      return r.body.call as string;
    },
    close: async () => {
      await app.quit();
      t.cleanup();
    },
  };
  return rig;
}

/** Waits until the call is live and has written at least one packet's worth of state. */
export async function waitState(rig: AppRig, id: string, state: string, ms = 5000): Promise<void> {
  await until(
    async () => (await rig.api("GET", `/calls/${id}`)).body?.state === state,
    ms,
    `call ${id} to be ${state}`,
  );
}

// ---------------------------------------------------------------------------
// A raw HTTP/1.1 client: exact request bytes, any Host header.

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function rawRequest(
  port: number,
  o: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: string;
    host?: string;
  },
): Promise<RawResponse> {
  const body = o.body ?? "";
  const lines = [
    `${o.method} ${o.path} HTTP/1.1`,
    `Host: ${o.host ?? `127.0.0.1:${port}`}`,
    "Connection: close",
    ...Object.entries(o.headers).map(([k, v]) => `${k}: ${v}`),
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ];
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r: RawResponse) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    // Resolves as soon as the whole answer is in; a server may keep the connection open.
    const tryParse = (closed: boolean) => {
      const text = buf.toString("latin1");
      const at = text.indexOf("\r\n\r\n");
      if (at < 0) {
        if (closed) finish({ status: 0, headers: {}, body: "" });
        return;
      }
      const [statusLine = "", ...hs] = text.slice(0, at).split("\r\n");
      const headers: Record<string, string> = {};
      for (const h of hs) {
        const i = h.indexOf(":");
        if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
      }
      const rest = buf.subarray(Buffer.byteLength(text.slice(0, at + 4), "latin1"));
      const status = Number(statusLine.split(" ")[1]);
      const len = headers["content-length"];
      if (len !== undefined) {
        if (rest.length >= Number(len)) {
          finish({ status, headers, body: rest.subarray(0, Number(len)).toString("utf8") });
        } else if (closed) finish({ status, headers, body: rest.toString("utf8") });
        return;
      }
      if (headers["transfer-encoding"] === "chunked") {
        if (!rest.toString("latin1").endsWith("0\r\n\r\n") && !closed) return;
        let body = "";
        let r = rest.toString("latin1");
        for (;;) {
          const nl = r.indexOf("\r\n");
          const n = Number.parseInt(r.slice(0, nl), 16);
          if (!(n > 0)) break;
          body += r.slice(nl + 2, nl + 2 + n);
          r = r.slice(nl + 2 + n + 2);
        }
        finish({ status, headers, body: Buffer.from(body, "latin1").toString("utf8") });
        return;
      }
      if (closed || status === 204 || status === 304) {
        finish({ status, headers, body: rest.toString("utf8") });
      }
    };
    sock.on("connect", () => sock.write(lines.join("\r\n")));
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, Buffer.from(d)]);
      tryParse(false);
    });
    sock.on("error", (e) => (done ? undefined : reject(e)));
    sock.on("close", () => tryParse(true));
  });
}
