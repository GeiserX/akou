/**
 * First run without the speech models (docs/DESIGN.md section 3: "first run offers one explicit
 * download"): a start is refused with what to do, the window's download card and `akou models pull`
 * fetch every file checked against its pinned SHA-256, and a start works once they are there.
 * The files are tiny and served on loopback; nothing here reaches the network.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSpecEntry } from "../src/main/asr/models.ts";
import { appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";

const FILES: Record<string, Uint8Array> = {
  "/m/a.onnx": new Uint8Array(200_000).map((_, i) => i % 251),
  "/m/tokens.txt": new TextEncoder().encode("a 0\nb 1\n"),
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const body = FILES[new URL(req.url).pathname];
    return body ? new Response(body) : new Response("no", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function registry(o: { badSum?: boolean } = {}): ModelSpecEntry[] {
  return [
    {
      id: "tiny",
      job: "test",
      licence: "MIT",
      source: "test",
      files: Object.entries(FILES).map(([path, body]) => ({
        name: path.split("/").pop() as string,
        url: `http://127.0.0.1:${server.port}${path}`,
        sha256: o.badSum && path.endsWith(".onnx") ? "0".repeat(64) : sha(body),
        size: body.byteLength,
      })),
    },
  ];
}

describe("first run without the speech models", () => {
  test("a start answers 503 models_missing until the download card's pull has fetched every file", async () => {
    const rig = await appRig({ modelRegistry: registry() });
    const total = Object.values(FILES).reduce((n, b) => n + b.byteLength, 0);
    let m = await rig.api("GET", "/models");
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ state: "missing", bytes: 0, total });
    expect((await rig.api("GET", "/status")).body.models.state).toBe("missing");

    const refused = await rig.api("POST", "/calls", {});
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe("models_missing");
    expect(refused.body.message).toContain("akou models pull");

    // The CLI says the same, with the unavailable exit code.
    const run = rigCli(rig);
    const cliStart = await run(["start", "--json"]);
    expect(cliStart.code).toBe(69);
    expect(cliStart.json.error).toBe("models_missing");

    const pull = await rig.api("POST", "/models/pull");
    expect([200, 202]).toContain(pull.status);
    await until(
      async () => (await rig.api("GET", "/models")).body.state === "ready",
      10_000,
      "models ready",
    );
    m = await rig.api("GET", "/models");
    expect(m.body).toMatchObject({ state: "ready", bytes: total, total });
    // The recognizer starts on the new files.
    await until(
      async () => (await rig.api("GET", "/status")).body.asr.state === "ready",
      10_000,
      "the recognizer ready",
    );
    // Pulling again changes nothing.
    expect((await rig.api("POST", "/models/pull")).status).toBe(200);

    const started = await rig.api("POST", "/calls", {});
    expect(started.status).toBe(201);
    await rig.api("POST", "/calls/live/stop");
    await rig.close();
  });

  test("models fetched behind the app's back (the CLI's pull or import) start the recognizer at the next start", async () => {
    const rig = await appRig({ modelRegistry: registry() });
    let st = (await rig.api("GET", "/status")).body;
    expect(st.asr.state).toBe("unavailable");
    expect(st.asr.reason).toContain("akou models pull");

    // `akou models pull` in a terminal writes the files into the same folder.
    const dir = join(st.models.dir, "tiny");
    mkdirSync(dir, { recursive: true });
    for (const [path, body] of Object.entries(FILES)) {
      writeFileSync(join(dir, path.split("/").pop() as string), body);
    }
    const started = await rig.api("POST", "/calls", {});
    expect(started.status).toBe(201);
    st = (await rig.api("GET", "/status")).body;
    expect(st.asr.state).not.toBe("unavailable");
    await until(
      async () => (await rig.api("GET", "/status")).body.asr.state === "ready",
      10_000,
      "the recognizer ready",
    );
    await rig.api("POST", "/calls/live/stop");
    await rig.close();
  });

  test("positive control: a file whose checksum does not match fails the pull, and a start stays refused", async () => {
    const rig = await appRig({ modelRegistry: registry({ badSum: true }) });
    expect((await rig.api("POST", "/models/pull")).status).toBe(202);
    await until(
      async () => (await rig.api("GET", "/models")).body.state === "failed",
      10_000,
      "models failed",
    );
    const m = await rig.api("GET", "/models");
    expect(m.body.error).toContain("SHA-256");
    expect((await rig.api("POST", "/calls", {})).status).toBe(503);
    // Audio only, when asked for it.
    expect((await rig.api("POST", "/calls", { withoutModels: true })).status).toBe(201);
    await rig.api("POST", "/calls/live/stop");
    await rig.close();
  });

  test("a recognizer given on purpose (or none) needs no download", async () => {
    const rig = await appRig({ models: null });
    expect((await rig.api("GET", "/models")).body.state).toBe("ready");
    expect((await rig.api("POST", "/calls", {})).status).toBe(201);
    await rig.api("POST", "/calls/live/stop");
    await rig.close();
  });
});
