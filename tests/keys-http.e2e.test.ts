/**
 * SV-K7: keys over HTTP, admin only. `GET /v1/keys` lists, `POST /v1/keys` creates and answers the
 * key and its webhook secret once, `PATCH /v1/keys/{id}` replaces its callback hosts,
 * `DELETE /v1/keys/{id}` revokes. The routes use the same `keys.json` the CLI of SV-K2 edits, so a
 * key made in either place works in the other. SV-K6: each edit, and each job, is an audit line in
 * the server's own log.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { KeyStore } from "../src/main/api/keys.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { asKey, clip, type Key, newKey, SERVER, submit } from "./server-helpers.ts";

setDefaultTimeout(30_000);

let server: AppRig;
let app: AppRig;
let admin: Key;
let jobs: Key;

beforeAll(async () => {
  server = await appRig({ settings: SERVER });
  app = await appRig();
  admin = await newKey(server, "ops", "admin");
  // Made with the CLI itself, so the list below proves the routes read the CLI's keys.
  const made = await cli({ ...process.env, ...server.env }, [
    "keys",
    "create",
    "--name",
    "archive",
    "--json",
  ]);
  expect(made.code).toBe(0);
  jobs = made.json;
});

afterAll(async () => {
  await server?.close();
  await app?.close();
});

describe("SV-K7: keys over HTTP", () => {
  test("a key created over POST /v1/keys authenticates a job, and the CLI lists it", async () => {
    const r = await asKey(server, admin.key, "POST", "/keys", {
      name: "viewer",
      scopes: ["jobs"],
      callback_hosts: ["Telegram-Viewer"],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      name: "viewer",
      scopes: ["jobs"],
      callback_hosts: ["telegram-viewer"],
    });
    expect(r.body.id).toMatch(/^key_[0-9a-f]{8}$/);
    expect(r.body.key).toMatch(/^ak_/);
    expect(r.body.secret).toMatch(/^whsec_/);
    expect(typeof r.body.created_at).toBe("number");

    const s = await submit(server, r.body.key, clip(["hello"], 2));
    expect(s.status).toBe(202);

    const listed = await cli({ ...process.env, ...server.env }, ["keys", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(listed.json.keys.map((k: { id: string }) => k.id)).toContain(r.body.id);
  });

  test("GET /v1/keys lists every key, the CLI's too, and never a key, a hash or a secret", async () => {
    const r = await asKey(server, admin.key, "GET", "/keys");
    expect(r.status).toBe(200);
    const byId = new Map(r.body.keys.map((k: { id: string }) => [k.id, k]));
    expect(byId.get(jobs.id)).toEqual({
      id: jobs.id,
      name: "archive",
      scopes: ["jobs"],
      callback_hosts: [],
      created_at: expect.any(Number),
      last_used_at: null,
    });
    expect(byId.has(admin.id)).toBe(true);
    // The admin key has been used by now; its last use is on the list.
    expect(typeof (byId.get(admin.id) as { last_used_at: unknown }).last_used_at).toBe("number");
    for (const k of [admin, jobs]) {
      expect(r.text).not.toContain(k.key);
      expect(r.text).not.toContain(k.secret);
    }
    for (const k of r.body.keys) {
      expect(Object.keys(k).sort()).toEqual([
        "callback_hosts",
        "created_at",
        "id",
        "last_used_at",
        "name",
        "scopes",
      ]);
    }
  });

  test("a jobs key gets 403 on every keys route", async () => {
    expect((await asKey(server, jobs.key, "GET", "/keys")).status).toBe(403);
    expect((await asKey(server, jobs.key, "POST", "/keys", { name: "x" })).status).toBe(403);
    expect(
      (await asKey(server, jobs.key, "PATCH", `/keys/${jobs.id}`, { callback_hosts: ["x"] }))
        .status,
    ).toBe(403);
    expect((await asKey(server, jobs.key, "DELETE", `/keys/${admin.id}`)).status).toBe(403);
    // Positive control: the same calls with the admin key get past the scope check.
    expect((await asKey(server, admin.key, "GET", "/keys")).status).toBe(200);
  });

  test("a key revoked over HTTP gets 401 on its next request, and the CLI no longer lists it", async () => {
    const k = await newKey(server, "short-lived");
    expect((await asKey(server, k.key, "GET", "/keys/me")).status).toBe(200);
    const del = await asKey(server, admin.key, "DELETE", `/keys/${k.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ id: k.id, revoked: true });
    expect((await asKey(server, k.key, "GET", "/keys/me")).status).toBe(401);
    const listed = await cli({ ...process.env, ...server.env }, ["keys", "list", "--json"]);
    expect(listed.json.keys.map((x: { id: string }) => x.id)).not.toContain(k.id);
    // Revoking it again: nothing to revoke.
    const again = await asKey(server, admin.key, "DELETE", `/keys/${k.id}`);
    expect(again.status).toBe(404);
    expect(again.body.error).toBe("not_found");
  });

  test("a bad name, scope or host is 422 naming the field; a taken name is 409", async () => {
    const bad = async (body: Record<string, unknown>, field: string) => {
      const r = await asKey(server, admin.key, "POST", "/keys", body);
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ error: "bad_field", field });
    };
    await bad({ name: "" }, "name");
    await bad({ name: "a/b" }, "name");
    await bad({ name: "x1", scopes: ["root"] }, "scopes");
    await bad({ name: "x2", scopes: [] }, "scopes");
    await bad({ name: "x3", callback_hosts: ["https://viewer/hook"] }, "callback_hosts");
    const taken = await asKey(server, admin.key, "POST", "/keys", { name: "archive" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("key_exists");
    // No scope named: a jobs key, as the CLI makes.
    const plain = await asKey(server, admin.key, "POST", "/keys", { name: "plain" });
    expect(plain.status).toBe(201);
    expect(plain.body.scopes).toEqual(["jobs"]);
    const both = await asKey(server, admin.key, "POST", "/keys", {
      name: "both",
      scopes: ["jobs", "admin"],
    });
    expect(both.body.scopes).toEqual(["admin"]);
  });

  test("PATCH /v1/keys/{id} replaces the callback hosts; the key, its secret and its jobs stay", async () => {
    const k = await newKey(server, "moving", "jobs", ["old-viewer"]);
    const before = await submit(server, k.key, clip(["hello"], 2), {
      callback_url: "http://old-viewer/hook",
    });
    expect(before.status).toBe(202);

    const r = await asKey(server, admin.key, "PATCH", `/keys/${k.id}`, {
      callback_hosts: ["New-Viewer", "archive.lan"],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: k.id,
      name: "moving",
      callback_hosts: ["new-viewer", "archive.lan"],
    });
    expect(r.text).not.toContain(k.secret);

    // The next request uses the new hosts: the new one is allowed, the old one refused.
    const now = await submit(server, k.key, clip(["hello"], 2), {
      callback_url: "http://new-viewer/hook",
    });
    expect(now.status).toBe(202);
    const old = await submit(server, k.key, clip(["hello"], 2), {
      callback_url: "http://old-viewer/hook",
    });
    expect(old.status).toBe(422);
    expect(old.body.error).toBe("callback_not_allowed");
    // The same key still reads its earlier job, and signs with the same secret.
    expect((await asKey(server, k.key, "GET", `/jobs/${before.body.id}`)).status).toBe(200);
    expect(new KeyStore(server.app.configDir).secretOf(k.id)).toBe(k.secret);
    for (const id of [before.body.id, now.body.id]) {
      await asKey(server, k.key, "DELETE", `/jobs/${id}`);
    }

    // An empty list allows no callback; a bad host is 422 naming the field; no such key is 404.
    const none = await asKey(server, admin.key, "PATCH", `/keys/${k.id}`, { callback_hosts: [] });
    expect(none.body.callback_hosts).toEqual([]);
    const bad = await asKey(server, admin.key, "PATCH", `/keys/${k.id}`, {
      callback_hosts: ["https://viewer/hook"],
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ error: "bad_field", field: "callback_hosts" });
    const missing = await asKey(server, admin.key, "PATCH", "/keys/key_00000000", {
      callback_hosts: ["x"],
    });
    expect(missing.status).toBe(404);
  });

  test("akou keys update replaces the hosts in the file, and the running server applies it", async () => {
    const k = await newKey(server, "cli-moved", "jobs", ["old-viewer"]);
    // A first use, so the server has read the key before the CLI changes it.
    expect((await asKey(server, k.key, "GET", "/keys/me")).status).toBe(200);
    const env = { ...process.env, ...server.env };
    const r = await cli(env, ["keys", "update", k.id, "--callback-host", "new-viewer", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ id: k.id, callback_hosts: ["new-viewer"] });
    const s = await submit(server, k.key, clip(["hello"], 2), {
      callback_url: "http://new-viewer/hook",
    });
    expect(s.status).toBe(202);
    await asKey(server, k.key, "DELETE", `/jobs/${s.body.id}`);
    expect(new KeyStore(server.app.configDir).secretOf(k.id)).toBe(k.secret);
    // The server noticed the CLI's edit and audited it.
    expect(
      server.logs.some((l) =>
        l.msg.startsWith(`key.updated ${k.id} callback_hosts [new-viewer] from keys.json`),
      ),
    ).toBe(true);
    // Refusals: no host, an unknown key.
    expect((await cli(env, ["keys", "update", k.id])).code).not.toBe(0);
    expect(
      (await cli(env, ["keys", "update", "key_00000000", "--callback-host", "x"])).code,
    ).not.toBe(0);
  });

  test("the desktop app has no keys routes", async () => {
    expect((await app.api("GET", "/keys")).status).toBe(404);
    expect((await app.api("POST", "/keys", { name: "x" })).status).toBe(404);
  });
});

describe("SV-K6: the audit lines in the server's own log", () => {
  test("a key created, used and revoked over HTTP leaves exactly its lines, and never the text", async () => {
    const made = await asKey(server, admin.key, "POST", "/keys", { name: "audited" });
    expect(made.status).toBe(201);
    const k = made.body as Key;
    const s = await submit(server, k.key, clip(["thanks", "meeting"], 2));
    expect(s.status).toBe(202);
    const done = await asKey(server, k.key, "GET", `/jobs/${s.body.id}?wait=60`);
    expect(done.body.status).toBe("done");
    const result = await asKey(server, k.key, "GET", `/jobs/${s.body.id}/result`);
    // Positive control for the grep below: the transcript does hold the words.
    expect(result.text).toContain("meeting");
    expect((await asKey(server, admin.key, "DELETE", `/keys/${k.id}`)).status).toBe(200);
    expect((await asKey(server, k.key, "GET", "/keys/me")).status).toBe(401);

    const prefix = k.key.slice(0, 7);
    const mine = server.logs
      .map((l) => l.msg)
      .filter((m) => /^(key|job|webhook)\.[a-z]+ /.test(m))
      .filter((m) => m.includes(k.id) || m.includes(prefix));
    expect(mine.map((m) => m.split(" ")[0])).toEqual([
      "key.created",
      "job.created",
      "job.done",
      "key.revoked",
      "key.refused",
    ]);
    // An edit over HTTP names the client's address.
    expect(mine[0]).toMatch(new RegExp(`^key\\.created ${k.id} "audited" scope jobs from \\S+$`));
    expect(mine[0]).not.toMatch(/from (this process|keys\.json)$/);
    expect(mine[1]).toBe(`job.created ${s.body.id} key ${k.id}`);
    expect(mine[3]).toMatch(new RegExp(`^key\\.revoked ${k.id} from \\S+$`));
    expect(mine[3]).not.toMatch(/from (this process|keys\.json)$/);
    expect(mine[4]).toContain(`${prefix}…`);
    for (const m of server.logs.map((l) => l.msg)) {
      expect(m).not.toContain("meeting");
      expect(m).not.toContain(k.key);
      expect(m).not.toContain(k.secret);
    }
  });

  test("a key the CLI makes and revokes is audited by the server as it reads the file", async () => {
    const env = { ...process.env, ...server.env };
    const made = await cli(env, ["keys", "create", "--name", "cli-audited", "--json"]);
    expect(made.code).toBe(0);
    // The server reads the file again on the key's first use.
    expect((await asKey(server, made.json.key, "GET", "/keys/me")).status).toBe(200);
    expect((await cli(env, ["keys", "revoke", made.json.id])).code).toBe(0);
    expect((await asKey(server, made.json.key, "GET", "/keys/me")).status).toBe(401);
    const mine = server.logs.map((l) => l.msg).filter((m) => m.includes(made.json.id));
    expect(mine).toEqual([
      `key.created ${made.json.id} "cli-audited" scope jobs from keys.json`,
      `key.revoked ${made.json.id} from keys.json`,
    ]);
  });
});
