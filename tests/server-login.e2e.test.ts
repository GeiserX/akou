/**
 * SV-U1, the admin login of server mode (docs/ux/SERVER.md section 9): the web UI is served on
 * the API's own listener behind the proxy, and a session is opened with the admin password
 * (`akou admin set-password`) or an `admin` key. The session lives in the tab's `sessionStorage`,
 * never a cookie; the tab side is the UI suite's (`tests/ui/server-login.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runCli } from "../src/main/cli/cli.ts";
import type { Bridge } from "../src/main/window/bridge.ts";
import type { UiBundle } from "../src/main/window/bundle.ts";
import { LOGIN_FAIL_MS, type MountedPage, PageServer } from "../src/main/window/page-server.ts";
import { type AppRig, appRig, declare, rawRequest } from "./api-helpers.ts";
import { cli } from "./cli-helpers.ts";

const PASSWORD = "correct horse battery staple";
const HOST = "akou.example";

let rig: AppRig;
let adminKey: string;
let jobsKey: string;

async function setPassword(env: Record<string, string | undefined>, password: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    ["admin", "set-password"],
    { env, out: (t) => out.push(t), err: (t) => err.push(t), stdin: async () => `${password}\n` },
    { launch: null },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function session(body: unknown, headers: Record<string, string> = {}) {
  return rawRequest(rig.port, {
    method: "POST",
    path: "/session",
    host: HOST,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  rig = await appRig({
    settings: { "server.enabled": true, "api.bind": "127.0.0.1", "server.behind_proxy": true },
  });
  const env = { ...process.env, ...rig.env };
  expect((await setPassword(env, PASSWORD)).code).toBe(0);
  const mk = async (name: string, scope: string) =>
    (await cli(env, ["keys", "create", "--name", name, "--scope", scope, "--json"])).json.key;
  adminKey = await mk("ui-admin", "admin");
  jobsKey = await mk("ui-jobs", "jobs");
});

afterAll(async () => {
  await rig?.close();
});

describe("SV-U1: the admin login", () => {
  test("the page loads through the proxy's Host and offers a login", async () => {
    const page = await rawRequest(rig.port, { method: "GET", path: "/", host: HOST, headers: {} });
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="login"');
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    const info = await rawRequest(rig.port, {
      method: "GET",
      path: "/session",
      host: HOST,
      headers: {},
    });
    expect(JSON.parse(info.body)).toEqual({ login: true });
  });

  test("a wrong password gets 401 after a 2 s delay; a right one opens a session that reads the app", async () => {
    expect(LOGIN_FAIL_MS).toBe(2_000);
    const t0 = performance.now();
    const wrong = await session({ password: "not the password" });
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.body).error).toBe("bad_login");
    expect(performance.now() - t0).toBeGreaterThanOrEqual(LOGIN_FAIL_MS - 50);

    const right = await session({ password: PASSWORD });
    expect(right.status).toBe(200);
    const s = JSON.parse(right.body).session as string;
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    // No cookie, ever: the session is the page's to keep.
    expect(right.headers["set-cookie"]).toBeUndefined();
    const status = await rawRequest(rig.port, {
      method: "GET",
      path: "/api/v1/status",
      host: HOST,
      headers: { authorization: `Bearer ${s}` },
    });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body).app.version).toBe(rig.app.version);
    // Without the session the same read is refused.
    const none = await rawRequest(rig.port, {
      method: "GET",
      path: "/api/v1/status",
      host: HOST,
      headers: {},
    });
    expect(none.status).toBe(401);
  });

  test("an admin key pasted once opens a session; a jobs key does not", async () => {
    expect((await session({ key: adminKey })).status).toBe(200);
    expect((await session({ key: jobsKey })).status).toBe(401);
  });

  test("the cross-origin refusal is at the login: another site's page cannot log in", async () => {
    const evil = await session({ password: PASSWORD }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const site = await session({ password: PASSWORD }, { "sec-fetch-site": "cross-site" });
    expect(site.status).toBe(403);
    // Positive control: the page's own origin logs in.
    const own = await session(
      { password: PASSWORD },
      { origin: `https://${HOST}`, "sec-fetch-site": "same-origin" },
    );
    expect(own.status).toBe(200);
  });

  test("the page holds bodies to 64 KB on the API's listener: a 2 MB login gets 413", async () => {
    const json = { "content-type": "application/json" };
    expect(await declare(rig.port, "/session", json, 2 * 1024 * 1024)).toBe(413);
    // A body with no length is cut off at the same 64 KB, at the login and behind a session.
    const big = JSON.stringify({ password: "x".repeat(200 * 1024) });
    const chunked = await rawRequest(rig.port, {
      method: "POST",
      path: "/session",
      host: HOST,
      headers: json,
      body: big,
      chunked: true,
    });
    expect(chunked.status).toBe(413);
    const s = JSON.parse((await session({ password: PASSWORD })).body).session as string;
    const api = await rawRequest(rig.port, {
      method: "PATCH",
      path: "/api/v1/config",
      host: HOST,
      headers: { ...json, authorization: `Bearer ${s}` },
      body: JSON.stringify({ "user.name": "x".repeat(200 * 1024) }),
      chunked: true,
    });
    expect(api.status).toBe(413);
    // Positive control: a small body is read, and its bad code is refused as such.
    expect(await declare(rig.port, "/session", json, 20)).toBe(403);
  });

  test("set-password stores a hash, never the password, and refuses a short one", async () => {
    const file = readFileSync(`${rig.app.configDir}/config.json`, "utf8");
    expect(file).not.toContain(PASSWORD);
    expect(JSON.parse(file)["server.admin_password_hash"]).toMatch(/^\$argon2id\$/);
    const short = await setPassword({ ...process.env, ...rig.env }, "short");
    expect(short.code).toBe(64);
    // A save over the API keeps the hash written since the start, and never shows it.
    expect((await rig.api("PATCH", "/config", { "asr.segmentPause": 0.8 })).status).toBe(200);
    const after = JSON.parse(readFileSync(`${rig.app.configDir}/config.json`, "utf8"));
    expect(after["server.admin_password_hash"]).toMatch(/^\$argon2id\$/);
    expect((await rig.api("GET", "/config")).body.settings["server.admin_password_hash"]).toBe(
      "(set)",
    );
    expect((await session({ password: PASSWORD })).status).toBe(200);
  });

  test("positive control: app mode serves no page and no login on the API's port", async () => {
    const app = await appRig();
    try {
      const page = await rawRequest(app.port, { method: "GET", path: "/", headers: {} });
      expect(page.status).toBe(401);
      const login = await rawRequest(app.port, {
        method: "POST",
        path: "/session",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(login.status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

/** A mounted page with no app behind it: only its login is driven. */
function loginPage(o: { failMs: number; login: MountedPage["login"] }): PageServer {
  return new PageServer({
    bridge: {} as Bridge,
    bundle: { get: () => null } as unknown as UiBundle,
    loginFailMs: o.failMs,
    mounted: {
      origin: "http://127.0.0.1:8476",
      hostAllowed: () => true,
      pageAllowed: true,
      login: o.login,
    },
  });
}

function post(page: PageServer, body: unknown): Promise<Response> {
  return page.fetch(
    new Request("http://127.0.0.1:8476/session", {
      method: "POST",
      headers: { host: "127.0.0.1:8476", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { timeout: () => {} },
  );
}

describe("SV-U1: failed logins are one at a time across the process", () => {
  test("5 parallel wrong logins take 5 delays, and never two checks at once", async () => {
    const failMs = 100;
    let running = 0;
    let most = 0;
    const page = loginPage({
      failMs,
      login: async () => {
        running++;
        most = Math.max(most, running);
        await Bun.sleep(5);
        running--;
        return false;
      },
    });
    const t0 = performance.now();
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => post(page, { password: "guess" })),
    );
    const took = performance.now() - t0;
    expect(answers.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(most).toBe(1);
    expect(took).toBeGreaterThanOrEqual(5 * failMs - 10);
  });

  test("positive control: one wrong login takes one delay, and a right one waits for none", async () => {
    const failMs = 100;
    const page = loginPage({ failMs, login: async (c) => c.password === "right" });
    const t0 = performance.now();
    expect((await post(page, { password: "wrong" })).status).toBe(401);
    const one = performance.now() - t0;
    expect(one).toBeGreaterThanOrEqual(failMs - 10);
    expect(one).toBeLessThan(2 * failMs);
    const t1 = performance.now();
    expect((await post(page, { password: "right" })).status).toBe(200);
    expect(performance.now() - t1).toBeLessThan(failMs);
  });
});
