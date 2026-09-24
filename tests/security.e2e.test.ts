/**
 * The local API's security suite (docs/DESIGN.md section 6.3, TRAPS "API security"), end to end: a
 * headless app capturing from the fake helper, attacked the way a web page or a rebinding DNS name
 * would attack it, with the exact bytes a browser sends.
 *
 * Every refusal has a positive control: the same request against an app whose guard is replaced by
 * `openGuard` must succeed (the predecessor's behaviour), which proves the test can fail and that
 * the guard, not something else, is what refuses.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { ensureToken, openGuard, rotateToken, tokenMatches } from "../src/main/api/guard.ts";
import { type AppRig, appRig, type RawResponse, rawRequest } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;
const EVIL = "https://evil.example";

let guarded: AppRig;
let open: AppRig;

beforeAll(async () => {
  guarded = await appRig();
  open = await appRig({ guard: openGuard });
});

afterAll(async () => {
  await guarded?.close();
  await open?.close();
});

/** A call is recording on the rig; returns its id. */
async function recording(rig: AppRig): Promise<string> {
  const live = await rig.api("GET", "/calls/live");
  if (live.status === 200 && live.body.state === "recording") return live.body.id;
  return rig.startCall();
}

async function stillRecording(rig: AppRig, id: string): Promise<void> {
  const r = await rig.api("GET", "/calls/live");
  expect(r.status).toBe(200);
  expect(r.body.id).toBe(id);
  expect(r.body.state).toBe("recording");
}

async function stopped(rig: AppRig, id: string): Promise<void> {
  const r = await rig.api("GET", `/calls/${id}`);
  expect(r.body.state).toBe("ended");
}

/** An attack on `POST /calls/live/stop`: refused with `status` by the guard, 200 without it. */
async function attackStop(
  build: (rig: AppRig) => Parameters<typeof rawRequest>[1],
  status: number,
): Promise<{ refused: RawResponse; allowed: RawResponse }> {
  const a = await recording(guarded);
  const refused = await rawRequest(guarded.port, build(guarded));
  expect(refused.status).toBe(status);
  await stillRecording(guarded, a);

  // Positive control: the same bytes, the guard compiled out, and the call stops.
  const b = await recording(open);
  const allowed = await rawRequest(open.port, build(open));
  expect(allowed.status).toBe(200);
  await stopped(open, b);
  return { refused, allowed };
}

describe("[known bug] Cross-origin POST /stop accepted", () => {
  test(
    "a cross-origin fetch from a web page is refused with 403 and the call keeps recording",
    async () => {
      await attackStop(
        () => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Origin: EVIL,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
        403,
      );
    },
    LONG,
  );

  test(
    "a form POST from another origin is refused with 403",
    async () => {
      await attackStop(
        () => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Origin: EVIL,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "navigate",
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }),
        403,
      );
    },
    LONG,
  );

  test(
    "a no-cors fetch is refused with 403",
    async () => {
      await attackStop(
        () => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Origin: EVIL,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "no-cors",
            "Content-Type": "text/plain;charset=UTF-8",
          },
        }),
        403,
      );
    },
    LONG,
  );

  test(
    "Sec-Fetch-Site alone is enough to refuse, even with a valid token",
    async () => {
      await attackStop(
        (rig) => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Authorization: `Bearer ${rig.token}`,
            "Sec-Fetch-Site": "cross-site",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
        403,
      );
    },
    LONG,
  );

  test(
    "an Origin header alone is enough to refuse, even with a valid token",
    async () => {
      await attackStop(
        (rig) => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Authorization: `Bearer ${rig.token}`,
            Origin: "http://127.0.0.1:1",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
        403,
      );
    },
    LONG,
  );

  test("a CORS preflight gets no CORS header back, and no answer carries one", async () => {
    for (const rig of [guarded, open]) {
      const pre = await rawRequest(rig.port, {
        method: "OPTIONS",
        path: "/v1/calls/live/stop",
        headers: {
          Origin: EVIL,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      for (const h of Object.keys(pre.headers)) expect(h.startsWith("access-control-")).toBe(false);
      const ok = await rig.api("GET", "/status");
      for (const [h] of ok.headers) expect(h.startsWith("access-control-")).toBe(false);
    }
    expect(
      (
        await rawRequest(guarded.port, {
          method: "OPTIONS",
          path: "/v1/status",
          headers: { Origin: EVIL },
        })
      ).status,
    ).toBe(403);
  });
});

describe("DNS rebinding: a foreign Host header", () => {
  test(
    "a stop with a valid token but Host evil.example is refused with 403",
    async () => {
      await attackStop(
        (rig) => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          host: `evil.example:${rig.port}`,
          headers: { Authorization: `Bearer ${rig.token}`, "Content-Type": "application/json" },
          body: "{}",
        }),
        403,
      );
    },
    LONG,
  );

  test("reading a transcript through a rebound name is refused; the positive control reads it", async () => {
    const req = (rig: AppRig, host: string) =>
      rawRequest(rig.port, {
        method: "GET",
        path: "/v1/status",
        host,
        headers: { Authorization: `Bearer ${rig.token}` },
      });
    expect((await req(guarded, `evil.example:${guarded.port}`)).status).toBe(403);
    expect((await req(guarded, `127.0.0.1.nip.io:${guarded.port}`)).status).toBe(403);
    // Right name, wrong port: also refused.
    expect((await req(guarded, `127.0.0.1:${guarded.port + 1}`)).status).toBe(403);
    expect((await req(open, `evil.example:${open.port}`)).status).toBe(200);
    // Both loopback names on the right port pass.
    expect((await req(guarded, `127.0.0.1:${guarded.port}`)).status).toBe(200);
    expect((await req(guarded, `localhost:${guarded.port}`)).status).toBe(200);
  });
});

describe("the bearer token", () => {
  const get = (rig: AppRig, auth?: string) =>
    rawRequest(rig.port, {
      method: "GET",
      path: "/v1/calls",
      headers: auth === undefined ? {} : { Authorization: auth },
    });

  test("a missing token is 401 on GETs too; the positive control reads without one", async () => {
    const r = await get(guarded);
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBe("Bearer");
    expect((await get(open)).status).toBe(200);
  });

  test("a wrong token is 401: same length, a prefix, a longer one, another scheme", async () => {
    const t = guarded.token;
    const wrong = [
      `Bearer ${t.slice(0, -1)}${t.endsWith("0") ? "1" : "0"}`,
      `Bearer ${t.slice(0, 32)}`,
      `Bearer ${t}00`,
      `Basic ${Buffer.from(`akou:${t}`).toString("base64")}`,
      `Bearer  ${t}`,
      t,
    ];
    for (const auth of wrong) expect((await get(guarded, auth)).status).toBe(401);
    expect((await get(guarded, `Bearer ${t}`)).status).toBe(200);
    for (const auth of wrong) expect((await get(open, auth)).status).toBe(200);
  });

  test(
    "a stop without the token is 401 and the call keeps recording",
    async () => {
      await attackStop(
        () => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        401,
      );
    },
    LONG,
  );

  test("the comparison is by digest, whatever the lengths", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "[Token file readable by others] the token file is mode 0600, 32 random bytes",
    () => {
      const path = guarded.app.tokenPath;
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(join(guarded.home, ".config", "akou")).mode & 0o077).toBe(0);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a token file others can read is replaced, not trusted; rotation takes effect at once",
    async () => {
      const t = tempDir();
      const first = ensureToken(t.dir);
      expect(first.created).toBe(true);
      expect(ensureToken(t.dir)).toMatchObject({ token: first.token, created: false });
      // Positive control for the check: loosen the mode and the token must change.
      chmodSync(first.path, 0o644);
      const second = ensureToken(t.dir);
      expect(second.created).toBe(true);
      expect(second.token).not.toBe(first.token);
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
      // A garbage file is replaced too.
      writeFileSync(first.path, "not a token\n", { mode: 0o600 });
      expect(ensureToken(t.dir).created).toBe(true);
      t.cleanup();

      // Rotating the running app's token: the old one stops working on the next request.
      const old = guarded.token;
      const next = rotateToken(guarded.app.configDir);
      const r1 = await rawRequest(guarded.port, {
        method: "GET",
        path: "/v1/status",
        headers: { Authorization: `Bearer ${old}` },
      });
      expect(r1.status).toBe(401);
      const r2 = await rawRequest(guarded.port, {
        method: "GET",
        path: "/v1/status",
        headers: { Authorization: `Bearer ${next}` },
      });
      expect(r2.status).toBe(200);
      guarded.token = next;
    },
  );
});

describe("bodies", () => {
  const post = (rig: AppRig, headers: Record<string, string>, body: string) =>
    rawRequest(rig.port, {
      method: "POST",
      path: "/v1/calls/live/notes",
      headers: { Authorization: `Bearer ${rig.token}`, ...headers },
      body,
    });

  test("a mutation without Content-Type: application/json is 415", async () => {
    await recording(guarded);
    expect((await post(guarded, { "Content-Type": "text/plain" }, '{"text":"x"}')).status).toBe(
      415,
    );
    expect((await post(guarded, {}, '{"text":"x"}')).status).toBe(415);
    expect(
      (await post(guarded, { "Content-Type": "application/json" }, '{"text":"x"}')).status,
    ).toBe(201);
  });

  test("unknown fields are 400, a body over 64 KB is 413", async () => {
    await recording(guarded);
    const j = { "Content-Type": "application/json" };
    const r = await post(guarded, j, '{"text":"x","by":"user"}');
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toMatchObject({ error: "unknown_field", field: "by" });
    const big = JSON.stringify({ text: "x".repeat(70 * 1024) });
    expect((await post(guarded, j, big)).status).toBe(413);
  });
});

describe("the bind address", () => {
  test("the API listens on 127.0.0.1 only and runtime.json names the port", () => {
    expect(guarded.app.server?.hostname).toBe("127.0.0.1");
    const rt = JSON.parse(readFileSync(guarded.app.runtimeFile, "utf8"));
    expect(rt).toMatchObject({ pid: process.pid, port: guarded.port });
    expect(rt.api).toBe(`http://127.0.0.1:${guarded.port}/v1`);
    if (process.platform !== "win32") {
      expect(statSync(guarded.app.runtimeFile).mode & 0o777).toBe(0o600);
    }
  });

  const refusedOn = (host: string, port: number) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      s.setTimeout(2000);
      s.on("connect", () => {
        s.destroy();
        resolve(false);
      });
      s.on("timeout", () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(true));
    });

  const outward = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

  test.skipIf(!outward)(
    "a non-loopback address of this machine is refused (skipped when the machine has none)",
    async () => {
      expect(await refusedOn(outward as string, guarded.port)).toBe(true);
      // Positive control: loopback on the same port connects.
      expect(await refusedOn("127.0.0.1", guarded.port)).toBe(false);
    },
  );

  test("IPv6 loopback is refused: the listener is IPv4 only", async () => {
    expect(await refusedOn("::1", guarded.port)).toBe(true);
  });
});

describe("the guard is the only way in", () => {
  test("no setting reaches the guard: the security suite's positive control is test-only", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "main", "index.ts"), "utf8");
    expect(src).not.toMatch(/openGuard/);
    const server = readFileSync(
      join(import.meta.dir, "..", "src", "main", "api", "server.ts"),
      "utf8",
    );
    expect(server).not.toMatch(/import[^;]*openGuard/);
    expect(existsSync(guarded.app.tokenPath)).toBe(true);
  });
});
