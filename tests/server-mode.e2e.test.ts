/**
 * Server mode's front door (docs/ux/SERVER.md sections 2 to 4, docs/research/service-interface.md
 * SI-3): the switch, the bind, the Host rule, the keys and their scopes, the anonymous routes, and
 * the upload exception to the 64 KB JSON rule. Every rule has a positive control: the same request
 * where the rule does not hold, or the app mode that keeps DESIGN 6.3 as it was.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APP_IDENTITY, callbackAllowed } from "../src/main/api/access.ts";
import { requireCallbackAllowed } from "../src/main/api/caller.ts";
import { HttpError, json } from "../src/main/api/http.ts";
import { KeyError, KeyStore } from "../src/main/api/keys.ts";
import { inCidr, isLoopback, parseCidr, sourceAddress } from "../src/main/api/net.ts";
import { type ApiApp, startApiServer } from "../src/main/api/server.ts";
import type { ModelSpecEntry } from "../src/main/asr/models.ts";
import { loadConfig } from "../src/main/config/schema.ts";
import { apiBind, StartRefused, startApp } from "../src/main/index.ts";
import { type AppRig, appRig, rawRequest, writeSettings } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { tempDir } from "./helpers.ts";

const SERVER = { "server.enabled": true, "api.bind": "127.0.0.1" };

let app: AppRig;
let server: AppRig;
let proxied: AppRig;

/** Runs `akou keys …` against a rig's home, as a person on the box would. */
function keysCli(rig: AppRig, args: string[]) {
  return cli({ ...process.env, ...rig.env }, ["keys", ...args, "--json"]);
}

async function newKey(
  rig: AppRig,
  name: string,
  more: string[] = [],
): Promise<{ id: string; key: string; secret: string }> {
  const r = await keysCli(rig, ["create", "--name", name, ...more]);
  expect(r.code).toBe(0);
  return r.json;
}

function get(rig: AppRig, path: string, headers: Record<string, string> = {}, host?: string) {
  return rawRequest(rig.port, { method: "GET", path, headers, host });
}

beforeAll(async () => {
  app = await appRig();
  server = await appRig({ settings: SERVER });
  proxied = await appRig({ settings: { ...SERVER, "server.behind_proxy": true } });
});

afterAll(async () => {
  await app?.close();
  await server?.close();
  await proxied?.close();
});

describe("SV-D2: loopback by default, network by choice", () => {
  test("a key through a proxy with Host: akou.example is accepted, and so is a browser Origin", async () => {
    const k = await newKey(proxied, "archive");
    const auth = { authorization: `Bearer ${k.key}` };
    const plain = await get(proxied, "/v1/keys/me", auth, "akou.example");
    expect(plain.status).toBe(200);
    expect(JSON.parse(plain.body).name).toBe("archive");
    const browser = await get(
      proxied,
      "/v1/keys/me",
      { ...auth, origin: "https://akou.example", "sec-fetch-site": "same-origin" },
      "akou.example",
    );
    expect(browser.status).toBe(200);
    // The key still matters: the same request with no key is 401.
    expect((await get(proxied, "/v1/keys/me", {}, "akou.example")).status).toBe(401);
  });

  test("positive control: app mode keeps DESIGN 6.3, a foreign Host and an Origin are 403", async () => {
    const auth = { authorization: `Bearer ${app.token}` };
    expect((await get(app, "/v1/status", auth)).status).toBe(200);
    const host = await get(app, "/v1/status", auth, "akou.example");
    expect(host.status).toBe(403);
    expect(JSON.parse(host.body).error).toBe("bad_host");
    const origin = await get(app, "/v1/status", { ...auth, origin: "https://akou.example" });
    expect(origin.status).toBe(403);
    expect(JSON.parse(origin.body).error).toBe("browser_request");
  });

  test("server mode with no proxy and no public host takes a loopback Host only", async () => {
    const k = await newKey(server, "local");
    const auth = { authorization: `Bearer ${k.key}` };
    expect((await get(server, "/v1/keys/me", auth)).status).toBe(200);
    const foreign = await get(server, "/v1/keys/me", auth, "akou.example");
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).error).toBe("bad_host");
  });

  test("with server.public_host set, that Host and loopback are accepted, and no other", async () => {
    const rig = await appRig({
      settings: { ...SERVER, "server.behind_proxy": true, "server.public_host": "akou.example" },
    });
    try {
      const k = await newKey(rig, "pub");
      const auth = { authorization: `Bearer ${k.key}` };
      expect((await get(rig, "/v1/keys/me", auth, "akou.example")).status).toBe(200);
      expect((await get(rig, "/v1/keys/me", auth, "AKOU.example:443")).status).toBe(200);
      expect((await get(rig, "/v1/keys/me", auth)).status).toBe(200);
      const other = await get(rig, "/v1/keys/me", auth, "rebound.example");
      expect(other.status).toBe(403);
    } finally {
      await rig.close();
    }
  });
});

describe("SV-P5: the bind address and the source address", () => {
  test("starting with api.bind=0.0.0.0 and server.behind_proxy=false exits naming both keys", async () => {
    const t = tempDir("akou-bind-");
    try {
      writeSettings(t.dir, { "server.enabled": true, "api.bind": "0.0.0.0", "api.port": 0 });
      const env = { AKOU_HOME: t.dir, AKOU_HEADLESS: "1" };
      let refused: unknown = null;
      await startApp({ env, models: null }).catch((e) => {
        refused = e;
      });
      expect(refused).toBeInstanceOf(StartRefused);
      expect((refused as Error).message).toContain("api.bind");
      expect((refused as Error).message).toContain("server.behind_proxy");

      // The real entry point: a non-zero exit with the same message, and no lock left behind.
      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dir, "..", "src", "main", "index.ts")],
        { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
      );
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(78);
      expect(err).toContain("api.bind");
      expect(err).toContain("server.behind_proxy");
    } finally {
      t.cleanup();
    }
  });

  test("positive control: behind a proxy the same bind is allowed; server mode defaults to 0.0.0.0", () => {
    const t = tempDir("akou-bind-");
    try {
      const at = (settings: Record<string, unknown>) => {
        writeSettings(t.dir, settings);
        return apiBind(loadConfig({ AKOU_HOME: t.dir }).settings);
      };
      expect(at({ "server.enabled": true, "server.behind_proxy": true })).toBe("0.0.0.0");
      expect(at({ "server.enabled": true, "server.behind_proxy": true, "api.bind": "::" })).toBe(
        "::",
      );
      expect(() => at({ "server.enabled": true })).toThrow(StartRefused);
      // The app keeps 127.0.0.1 whatever api.bind says.
      expect(at({ "api.bind": "0.0.0.0" })).toBe("127.0.0.1");
      // AKOU_SERVER is the switch, as the image sets it.
      writeSettings(t.dir, { "server.behind_proxy": true });
      expect(apiBind(loadConfig({ AKOU_HOME: t.dir, AKOU_SERVER: "1" }).settings)).toBe("0.0.0.0");
    } finally {
      t.cleanup();
    }
  });

  test("a bind the CLI on this box cannot reach at 127.0.0.1 is refused at start", () => {
    const t = tempDir("akou-bind-");
    try {
      const at = (bind: string) => {
        writeSettings(t.dir, {
          "server.enabled": true,
          "server.behind_proxy": true,
          "api.bind": bind,
        });
        return apiBind(loadConfig({ AKOU_HOME: t.dir }).settings);
      };
      for (const bind of ["192.168.1.5", "::1", "127.0.0.2", "localhost"]) {
        let err: unknown = null;
        try {
          at(bind);
        } catch (e) {
          err = e;
        }
        expect([bind, err instanceof StartRefused]).toEqual([bind, true]);
        expect((err as Error).message).toContain("127.0.0.1, 0.0.0.0 or ::");
      }
      // Positive control: the three binds the local CLI reaches.
      expect(["127.0.0.1", "0.0.0.0", "::"].map(at)).toEqual(["127.0.0.1", "0.0.0.0", "::"]);
    } finally {
      t.cleanup();
    }
  });

  test("a forged X-Forwarded-For from a peer outside server.trusted_proxies is audited under the peer", async () => {
    const forged = { authorization: "Bearer ak_wrong", "x-forwarded-for": "203.0.113.9" };
    const r = await get(server, "/v1/keys/me", forged);
    expect(r.status).toBe(401);
    const line = server.logs.find((l) => l.msg.startsWith("key.refused ak_wron"));
    expect(line?.msg).toContain("from 127.0.0.1 ");
    expect(line?.msg).not.toContain("203.0.113.9");

    // Positive control: with loopback trusted as the proxy, the header names the source.
    const trusting = await appRig({
      settings: { ...SERVER, "server.trusted_proxies": ["127.0.0.0/8"] },
    });
    try {
      await get(trusting, "/v1/keys/me", forged);
      const seen = trusting.logs.find((l) => l.msg.startsWith("key.refused ak_wron"));
      expect(seen?.msg).toContain("from 203.0.113.9 ");
    } finally {
      await trusting.close();
    }
  });

  test("key.refused names only an ak_ key's first bytes, and a request with no key is not logged", async () => {
    const lines = () => server.logs.filter((l) => l.msg.startsWith("key.refused"));
    const before = lines().length;
    const r = await get(server, "/v1/keys/me", { authorization: "Bearer sk-live-secret-value" });
    expect(r.status).toBe(401);
    const foreign = lines().slice(before);
    expect(foreign.length).toBe(1);
    expect(foreign[0]?.msg).toContain("(not an akou key)");
    expect(foreign[0]?.msg).not.toContain("sk-");
    // No key at all, many times: nothing is written per request.
    for (let i = 0; i < 5; i++) expect((await get(server, "/v1/status")).status).toBe(401);
    expect(lines().length).toBe(before + 1);
    // Positive control: an ak_ key that is wrong is logged by its prefix.
    await get(server, "/v1/keys/me", { authorization: "Bearer ak_nothere" });
    expect(lines().at(-1)?.msg).toStartWith("key.refused ak_noth");
  });

  test("X-Forwarded-For is read from the right, past trusted hops only", () => {
    const trusted = ["10.0.0.0/8", "fd00::/8"].map((c) => parseCidr(c)).filter((c) => c !== null);
    expect(sourceAddress("192.0.2.1", "203.0.113.9", trusted)).toBe("192.0.2.1");
    expect(sourceAddress("10.0.0.2", "203.0.113.9", trusted)).toBe("203.0.113.9");
    // A client that prepends its own entry gains nothing: the rightmost untrusted hop wins.
    expect(sourceAddress("10.0.0.2", "1.1.1.1, 203.0.113.9, 10.0.0.7", trusted)).toBe(
      "203.0.113.9",
    );
    expect(sourceAddress("fd00::5", "2001:db8::1", trusted)).toBe("2001:db8::1");
    expect(sourceAddress("::ffff:10.1.2.3", "203.0.113.9", trusted)).toBe("203.0.113.9");
    expect(sourceAddress("10.0.0.2", "garbage", trusted)).toBe("10.0.0.2");
  });

  test("CIDR blocks and loopback", () => {
    const net = parseCidr("192.168.10.0/24");
    expect(net).not.toBeNull();
    expect(inCidr("192.168.10.77", net as NonNullable<typeof net>)).toBe(true);
    expect(inCidr("192.168.11.1", net as NonNullable<typeof net>)).toBe(false);
    for (const bad of ["300.1.1.1/8", "10.0.0.0/33", "fd00::/129", "host.lan", "1.2.3.4/8/9"]) {
      expect(parseCidr(bad)).toBeNull();
    }
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.2")).toBe(false);
  });

  test("a trusted proxy list that is not addresses is refused like any bad setting", () => {
    const t = tempDir("akou-bind-");
    try {
      writeSettings(t.dir, { "server.trusted_proxies": ["10.0.0.0/8", "proxy.lan"] });
      const cfg = loadConfig({ AKOU_HOME: t.dir });
      expect(cfg.settings["server.trusted_proxies"]).toEqual([]);
      expect(cfg.issues.map((i) => i.message).join()).toContain("proxy.lan is not an address");
    } finally {
      t.cleanup();
    }
  });
});

describe("SV-K2: keys", () => {
  test("the printed key authenticates; the file is 0600 and holds its hash, never the key", async () => {
    const r = await keysCli(server, ["create", "--name", "telegram", "--callback-host", "a.lan"]);
    expect(r.code).toBe(0);
    const k = r.json;
    expect(k.key).toMatch(/^ak_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(k.key.slice(3), "base64url").length).toBe(32);
    expect(k.secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(Buffer.from(k.secret.slice(6), "base64").length).toBe(24);

    const me = await get(server, "/v1/keys/me", { authorization: `Bearer ${k.key}` });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ id: k.id, name: "telegram", scopes: ["jobs"] });

    const file = join(server.app.configDir, "keys.json");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(k.key);
    expect(text).not.toContain(k.key.slice(3));
    expect(text).toContain(createHash("sha256").update(k.key).digest("hex"));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    // The human form prints both once, and says so.
    const human = await cli({ ...process.env, ...server.env }, ["keys", "create", "--name", "h"]);
    expect(human.out).toMatch(/API key: +ak_/);
    expect(human.out).toMatch(/webhook secret: +whsec_/);
    expect(human.out).toContain("shown this once");
  });

  test("a revoked key gets 401 on the next request", async () => {
    const k = await newKey(server, "short-lived");
    const auth = { authorization: `Bearer ${k.key}` };
    expect((await get(server, "/v1/keys/me", auth)).status).toBe(200);
    const revoked = await keysCli(server, ["revoke", k.id]);
    expect(revoked.code).toBe(0);
    const after = await get(server, "/v1/keys/me", auth);
    expect(after.status).toBe(401);
    expect(JSON.parse(after.body).error).toBe("unauthorized");
  });

  test("list shows id, name, scopes, created and last used; never a key or a secret", async () => {
    const k = await newKey(server, "listed", ["--scope", "admin"]);
    const before = (await keysCli(server, ["list"])).json.keys.find(
      (x: { id: string }) => x.id === k.id,
    );
    expect(before).toMatchObject({ name: "listed", scopes: ["admin"], last_used_at: null });
    expect(typeof before.created_at).toBe("number");
    await get(server, "/v1/keys/me", { authorization: `Bearer ${k.key}` });
    const r = await keysCli(server, ["list"]);
    const after = r.json.keys.find((x: { id: string }) => x.id === k.id);
    expect(typeof after.last_used_at).toBe("number");
    expect(r.out).not.toContain(k.key);
    expect(r.out).not.toContain(k.secret);
    expect(r.out).not.toContain("sha256");
  });

  test("create refuses a bad scope, a bad host, and a name taken; revoke refuses an unknown id", async () => {
    expect((await keysCli(server, ["create", "--name", "x", "--scope", "root"])).code).toBe(64);
    const host = await keysCli(server, [
      "create",
      "--name",
      "y",
      "--callback-host",
      "https://a.lan/x",
    ]);
    expect(host.code).toBe(64);
    await newKey(server, "twice");
    expect((await keysCli(server, ["create", "--name", "twice"])).code).toBe(64);
    expect((await keysCli(server, ["revoke", "key_00000000"])).code).toBe(64);
  });
});

describe("SV-K3: a path that is not a route", () => {
  test("with a valid key it is 404 or 405, never 'needs admin'; with no key it is 401", async () => {
    const k = await newKey(server, "typo");
    const auth = { authorization: `Bearer ${k.key}` };
    const typo = await get(server, "/v1/jbos", auth);
    expect(typo.status).toBe(404);
    expect(JSON.parse(typo.body).error).toBe("not_found");
    const method = await rawRequest(server.port, {
      method: "DELETE",
      path: "/v1/keys/me",
      headers: { ...auth, "content-type": "application/json" },
    });
    expect(method.status).toBe(405);
    // No key: 401 before any 404, so the route table is not probed anonymously.
    expect((await get(server, "/v1/jbos")).status).toBe(401);
    // Positive control: a route that exists and needs admin is still 403 for this key.
    const admin = await get(server, "/v1/status", auth);
    expect(admin.status).toBe(403);
    expect(JSON.parse(admin.body).error).toBe("forbidden");
  });
});

describe("SV-K2: edits to the keys file", () => {
  test("revoke takes an id only: a name, even one shaped like an id, removes nothing", async () => {
    const victim = await newKey(server, "victim");
    const store = new KeyStore(server.app.configDir);
    expect(store.revoke("victim")).toBe(false);
    // A key named like another key's id cannot take that key down with it.
    const shaped = await newKey(server, victim.id);
    expect(store.revoke(victim.id)).toBe(true);
    expect(store.authenticate(victim.key)).toBeNull();
    expect(store.authenticate(shaped.key)?.name).toBe(victim.id);
  });

  test("a create or revoke waits for no one: another edit in progress refuses it, and nothing is lost", async () => {
    const k = await newKey(server, "held");
    const store = new KeyStore(server.app.configDir);
    const lock = join(server.app.configDir, "keys.json.lock");
    // Another live process holds the edit lock (the test runner's parent stands in for it).
    writeFileSync(lock, `${process.ppid} 0123456789abcdef\n`);
    try {
      expect(() => store.revoke(k.id)).toThrow(/another edit of the keys \(pid \d+\) is running/);
      expect(() => store.create({ name: "blocked" })).toThrow(KeyError);
      expect(store.authenticate(k.key)?.id).toBe(k.id);
      expect(store.list().some((x) => x.name === "blocked")).toBe(false);
    } finally {
      rmSync(lock, { force: true });
    }
    // Positive control: with the lock gone, the same edits run, and leave no lock behind.
    expect(store.revoke(k.id)).toBe(true);
    expect(store.create({ name: "blocked" }).name).toBe("blocked");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("SV-K4: callback hosts are an allowlist per key", () => {
  test("a key with --callback-host archive.lan accepts archive.lan and refuses other.lan; '*' accepts both", async () => {
    const one = await newKey(server, "cb-one", ["--callback-host", "archive.lan"]);
    const any = await newKey(server, "cb-any", ["--callback-host", "*"]);
    const none = await newKey(server, "cb-none");
    const store = new KeyStore(server.app.configDir);
    const id = (key: string) => store.authenticate(key) as NonNullable<typeof APP_IDENTITY>;
    expect(callbackAllowed(id(one.key), "https://archive.lan/api/x")).toBe(true);
    expect(callbackAllowed(id(one.key), "https://other.lan/")).toBe(false);
    expect(callbackAllowed(id(any.key), "https://archive.lan/api/x")).toBe(true);
    expect(callbackAllowed(id(any.key), "https://other.lan/")).toBe(true);
    // No host at all: no callback.
    expect(callbackAllowed(id(none.key), "https://archive.lan/")).toBe(false);
    // Only http and https; a host that only looks like the allowed one is another host.
    expect(callbackAllowed(id(one.key), "ftp://archive.lan/")).toBe(false);
    expect(callbackAllowed(id(one.key), "https://archive.lan.evil.example/")).toBe(false);
    let err: unknown = null;
    try {
      requireCallbackAllowed(id(one.key), "https://other.lan/");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).code).toBe("callback_not_allowed");
  });

  test("'*' matches public hosts only: loopback, private and link-local ones must be listed by name", async () => {
    const any = await newKey(server, "cb-wild", ["--callback-host", "*"]);
    const listed = await newKey(server, "cb-listed", [
      "--callback-host",
      "*",
      "--callback-host",
      "10.0.0.5",
      "--callback-host",
      "127.0.0.1",
    ]);
    const store = new KeyStore(server.app.configDir);
    const id = (key: string) => store.authenticate(key) as NonNullable<typeof APP_IDENTITY>;
    const closed = [
      "http://10.0.0.5/x",
      "http://127.0.0.1:8476/v1/calls",
      "http://127.8.9.10/",
      "http://[::1]/",
      "http://[::ffff:10.0.0.5]/",
      "http://[::ffff:127.0.0.1]/",
      "http://169.254.169.254/latest",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.2/",
      "http://100.64.0.1/",
      "http://0.0.0.0:8476/",
      "http://[::]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://localhost/",
      "http://akou.localhost/",
      // Other spellings the URL parser turns into loopback.
      "http://2130706433/",
      "http://0x7f.1/",
    ];
    for (const url of closed) {
      expect([url, callbackAllowed(id(any.key), url)]).toEqual([url, false]);
    }
    // Positive control: public hosts pass the wildcard, including the edges of each block.
    for (const url of [
      "https://archive.example/api/x",
      "http://172.32.0.1/",
      "http://172.15.255.255/",
      "http://8.8.8.8/",
      "http://[2001:db8::1]/",
    ]) {
      expect([url, callbackAllowed(id(any.key), url)]).toEqual([url, true]);
    }
    // Listed by name, a private host is allowed; the one not listed is still refused.
    expect(callbackAllowed(id(listed.key), "http://10.0.0.5/x")).toBe(true);
    expect(callbackAllowed(id(listed.key), "http://127.0.0.1:8080/")).toBe(true);
    expect(callbackAllowed(id(listed.key), "http://10.0.0.6/x")).toBe(false);
  });
});

describe("SI-3: GET /v1/keys/me", () => {
  test("a jobs key gets its name and ['jobs']; a revoked key and no key get 401", async () => {
    const k = await newKey(server, "executor");
    const me = await get(server, "/v1/keys/me", { authorization: `Bearer ${k.key}` });
    expect(me.status).toBe(200);
    const body = JSON.parse(me.body);
    expect(body).toEqual({
      id: k.id,
      name: "executor",
      scopes: ["jobs"],
      created_at: body.created_at,
    });
    expect(typeof body.created_at).toBe("number");
    await keysCli(server, ["revoke", k.id]);
    expect((await get(server, "/v1/keys/me", { authorization: `Bearer ${k.key}` })).status).toBe(
      401,
    );
    expect((await get(server, "/v1/keys/me")).status).toBe(401);
  });

  test("in app mode it answers for the app token as the admin app", async () => {
    const me = await app.api("GET", "/keys/me");
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: "app", name: "app", scopes: ["admin"] });
    expect((await get(app, "/v1/keys/me")).status).toBe(401);
  });
});

describe("SV-K1: GET /v1/server", () => {
  /** The preset names of SERVER.md section 8's table, in order. */
  function docPresets(): string[] {
    const doc = readFileSync(join(import.meta.dir, "..", "docs", "ux", "SERVER.md"), "utf8");
    const section = doc.slice(doc.indexOf("## 8. Presets"), doc.indexOf("## 9."));
    return [...section.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1] as string);
  }

  test("answers with no token in both modes; the presets equal section 8's table", async () => {
    const names = docPresets();
    // The parse itself can fail: it must find the five rows.
    expect(names).toEqual(["lite", "fast", "best", "fusion", "auto"]);
    for (const [rig, mode] of [
      [app, "app"],
      [server, "server"],
    ] as const) {
      const r = await get(rig, "/v1/server");
      expect(r.status).toBe(200);
      const b = JSON.parse(r.body);
      expect(b).toMatchObject({ name: "akou", version: rig.app.version, mode, gpu: null });
      expect(b.presets.map((p: { name: string }) => p.name)).toEqual(names);
      // Only `fast` is built, over the one engine; it is available when its model is there.
      const avail = b.presets.filter((p: { available: boolean }) => p.available);
      expect(avail.map((p: { name: string }) => p.name)).toEqual(["fast"]);
      expect(b.engines.map((e: { id: string }) => e.id)).toEqual(["parakeet-tdt-0.6b-v3-fp32"]);
      expect(Object.keys(b.capabilities).sort()).toEqual(
        ["bazarr", "events", "jobs", "openai", "webhooks", "wyoming"].sort(),
      );
      // Jobs, their feed and their signed deliveries exist in server mode only (SV-J1, SV-E1, SV-E2).
      for (const c of ["jobs", "events", "webhooks"])
        expect(b.capabilities[c]).toBe(mode === "server");
    }
  });

  test("capabilities.jobs turns true with the route itself", async () => {
    const s = startApiServer({
      app: fakeApp(),
      port: 0,
      token: () => "t".repeat(64),
      routes: (r) => r.add("POST", "/jobs", () => json(202, {}), { access: "jobs", upload: true }),
    });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/v1/server`);
      const b = (await r.json()) as { capabilities: { jobs: boolean } };
      expect(b.capabilities.jobs).toBe(true);
    } finally {
      await s.stop();
    }
  });
});

describe("SV-P4: GET /healthz", () => {
  test("curl with no header gets 200 with the four fields, in both modes", async () => {
    for (const rig of [app, server]) {
      // The fake recognizer loads in a moment; until then the answer is 503 (the test below).
      await until(() => rig.app.recognizer() === "ready", 10_000, "recognizer ready");
      const r = await get(rig, "/healthz");
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({
        ok: true,
        version: rig.app.version,
        models_ready: true,
        queue_depth: 0,
      });
    }
  });

  test("while a pull runs it gets 503 with models_ready: false, and 200 once it is done", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const body = new Uint8Array(4096).fill(7);
    const files = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(ctl) {
              ctl.enqueue(body.subarray(0, 1024));
              await held;
              ctl.enqueue(body.subarray(1024));
              ctl.close();
            },
          }),
        ),
    });
    const registry: ModelSpecEntry[] = [
      {
        id: "tiny",
        job: "test",
        licence: "MIT",
        source: "test",
        files: [
          {
            name: "a.onnx",
            url: `http://127.0.0.1:${files.port}/a.onnx`,
            sha256: createHash("sha256").update(body).digest("hex"),
            size: body.byteLength,
          },
        ],
      },
    ];
    const rig = await appRig({ modelRegistry: registry, settings: SERVER });
    try {
      expect((await rig.api("POST", "/models/pull")).status).toBe(202);
      const during = await get(rig, "/healthz");
      expect(during.status).toBe(503);
      expect(JSON.parse(during.body)).toMatchObject({ ok: false, models_ready: false });
      release();
      await until(async () => (await get(rig, "/healthz")).status === 200, 10_000, "healthy");
      expect(JSON.parse((await get(rig, "/healthz")).body).models_ready).toBe(true);
    } finally {
      release();
      await rig.close();
      files.stop(true);
    }
  });
});

describe("SV-P4: GET /healthz follows the recognizer, not only the files", () => {
  test("503 while the recognizer loads; models_ready only once it is ready", async () => {
    let recognizer: "loading" | "ready" | "unavailable" = "loading";
    const s = startApiServer({
      app: { ...fakeApp(), recognizer: () => recognizer } as ApiApp,
      port: 0,
      token: () => "t".repeat(64),
    });
    const health = async () => {
      const r = await fetch(`http://127.0.0.1:${s.port}/healthz`);
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const installed = async () => {
      const r = await fetch(`http://127.0.0.1:${s.port}/v1/server`);
      return ((await r.json()) as { engines: { installed: boolean }[] }).engines[0]?.installed;
    };
    try {
      // The files are there (`fakeApp`), and the recognizer is still loading them.
      const loading = await health();
      expect(loading.status).toBe(503);
      expect(loading.body).toMatchObject({ ok: false, models_ready: false });
      expect(await installed()).toBe(false);
      // It failed to load: the API answers, but nothing is ready to transcribe.
      recognizer = "unavailable";
      const failed = await health();
      expect(failed.status).toBe(200);
      expect(failed.body).toMatchObject({ ok: true, models_ready: false });
      expect(await installed()).toBe(false);
      // Positive control: loaded, it is healthy and ready.
      recognizer = "ready";
      const ready = await health();
      expect(ready.status).toBe(200);
      expect(ready.body).toMatchObject({ ok: true, models_ready: true });
      expect(await installed()).toBe(true);
    } finally {
      await s.stop();
    }
  });
});

/** An app with nothing behind it: the tests below never reach a handler that needs one. */
function fakeApp(): ApiApp {
  return {
    version: "0.0.0-test",
    models: () => ({ state: "ready", dir: "", bytes: 0, total: 0 }),
  } as unknown as ApiApp;
}
