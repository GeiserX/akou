/**
 * The free-space floor of uploads, end to end through a real server: an upload is refused with
 * 507 `insufficient_storage` when the volume of the upload folder is under 1 GB free, before the
 * body is read and while it arrives, and leaves no file behind. The clients that upload (`akou
 * transcribe`, the MCP server's `akou_transcribe`) read the 507 as a refusal with its reason, never
 * as a server that is down. The forwarding primary and the dictation remote are in
 * remote-dispatch.e2e.test.ts and dictation-remote.e2e.test.ts.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiClient, EXIT } from "../src/main/cli/client.ts";
import { FREE_MARGIN_BYTES } from "../src/main/server/model-store.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";
import { mcpClient } from "./mcp-helpers.ts";

setDefaultTimeout(30_000);

const NOTE = monoWav(concat(silence(0.4), speak(["hello", "world"]), silence(1)));

let rig: AppRig;
let key: string;
/** What the free-space probe reports; each test sets it. */
let free: (dir: string) => number = () => 1e12;
const box = tempDir("akou-upload-floor-");

beforeAll(async () => {
  rig = await appRig({
    settings: { "server.enabled": true, "api.bind": "127.0.0.1" },
    jobs: { modelStore: { freeBytes: (dir) => free(dir) } },
  });
  const r = await cli({ ...process.env, ...rig.env }, [
    "keys",
    "create",
    "--name",
    "floor",
    "--scope",
    "jobs",
    "--json",
  ]);
  expect(r.code).toBe(0);
  key = r.json.key;
});

afterAll(async () => {
  await rig?.close();
  box.cleanup();
});

/** The spool files left in the job queue's upload folder. */
function spooled(): string[] {
  const dir = join(rig.app.configDir, "jobs", "audio");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".upload")) : [];
}

async function post(path: string, file: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new Blob([file], { type: "audio/wav" }), "note.wav");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
}

describe("[DSK-F1] an upload keeps 1 GB free on the server's volume", () => {
  test("under the floor, a job upload is refused with 507 and leaves no file", async () => {
    free = () => FREE_MARGIN_BYTES - 1;
    const r = await post("/jobs", NOTE);
    expect(r.status).toBe(507);
    expect(r.body).toMatchObject({
      error: "insufficient_storage",
      free_bytes: FREE_MARGIN_BYTES - 1,
      floor_bytes: FREE_MARGIN_BYTES,
    });
    expect(r.body.message).toContain("bytes free");
    expect(spooled()).toEqual([]);
    // The OpenAI-compatible door reads its upload the same way.
    const o = await post("/audio/transcriptions", NOTE);
    expect([o.status, o.body?.error]).toEqual([507, "insufficient_storage"]);
    expect(spooled()).toEqual([]);
  });

  test("a volume that falls under the floor mid-upload cuts it, and the client reads the 507", async () => {
    let looks = 0;
    // Room at the first look, before the body; none at the next, 16 MB into the file.
    free = () => (++looks <= 1 ? 1e12 : FREE_MARGIN_BYTES - 1);
    const big = new Uint8Array(40 * 1024 * 1024);
    big.set(NOTE);
    const r = await post("/jobs", big);
    expect([r.status, r.body?.error]).toEqual([507, "insufficient_storage"]);
    expect(looks).toBe(2);
    expect(spooled()).toEqual([]);
  });

  test("positive control: with room on the volume, the same upload is accepted", async () => {
    free = () => FREE_MARGIN_BYTES;
    const r = await post("/jobs", NOTE);
    expect(r.status).toBe(202);
    expect(typeof r.body?.id).toBe("string");
  });
});

describe("[DSK-F2] the clients read a 507 as a refusal, never as a server that is down", () => {
  const note = join(box.dir, "note.wav");
  const env = () => ({
    ...process.env,
    AKOU_HOME: box.dir,
    AKOU_URL: `http://127.0.0.1:${rig.port}`,
    AKOU_API_KEY: key,
  });

  test("akou transcribe prints the server's reason and exits 70, not 69 unavailable", async () => {
    writeFileSync(note, NOTE);
    free = () => FREE_MARGIN_BYTES - 1;
    const r = await cli(env(), ["transcribe", note]);
    expect(r.code).toBe(EXIT.software);
    expect(r.code).not.toBe(EXIT.unavailable);
    expect(r.out).toBe("");
    expect(r.err).toContain("bytes free");
    const j = await cli(env(), ["transcribe", note, "--json"]);
    expect(j.json).toMatchObject({ error: "insufficient_storage" });
    // Positive control: with room, the same command prints the transcript.
    free = () => 1e12;
    const ok = await cli(env(), ["transcribe", note]);
    expect(ok.code).toBe(EXIT.ok);
    expect(ok.out).toContain("hello");
  });

  test("akou_transcribe answers a tool error naming insufficient_storage", async () => {
    writeFileSync(note, NOTE);
    free = () => FREE_MARGIN_BYTES - 1;
    const c = await mcpClient(
      new ApiClient({ env: env(), client: "mcp", launch: null }),
      "claude-code",
      "server",
    );
    try {
      const r = await c.call("akou_transcribe", { path: note, wait: 0 });
      expect(r.isError).toBe(true);
      expect(r.text).toStartWith("insufficient_storage: ");
      expect(r.text).toContain("bytes free");
      // Positive control: with room, the same call submits the job.
      free = () => 1e12;
      expect((await c.call("akou_transcribe", { path: note, wait: 0 })).isError).toBe(false);
    } finally {
      await c.close();
    }
  });
});
