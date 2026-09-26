/**
 * SV-K7: keys over HTTP, admin only. `GET /v1/keys` lists, `POST /v1/keys` creates and answers the
 * key and its webhook secret once, `DELETE /v1/keys/{id}` revokes. The routes use the same
 * `keys.json` the CLI of SV-K2 edits, so a key made in either place works in the other.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
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

  test("a jobs key gets 403 on all three routes", async () => {
    expect((await asKey(server, jobs.key, "GET", "/keys")).status).toBe(403);
    expect((await asKey(server, jobs.key, "POST", "/keys", { name: "x" })).status).toBe(403);
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

  test("the desktop app has no keys routes", async () => {
    expect((await app.api("GET", "/keys")).status).toBe(404);
    expect((await app.api("POST", "/keys", { name: "x" })).status).toBe(404);
  });
});
