/**
 * The `read` scope (docs/ux/SERVER.md SV-K3) and the guard of the desktop app's network listener
 * (`network.enabled`), as units: who reaches which route, read from the route table itself, and
 * what the network guard lets through. The same rules over real HTTP, with real keys, are in
 * `tests/network-read.e2e.test.ts` and `tests/server-access.e2e.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { type Access, allows, type Identity, type Scope } from "../src/main/api/access.ts";
import { type GuardContext, networkGuard, serverGuard } from "../src/main/api/guard.ts";
import { scopesOf } from "../src/main/api/keys.ts";
import { buildRouter } from "../src/main/api/server.ts";

/** The history a `read` key reads, as the phone's contract names it. */
const HISTORY = [
  "GET /calls",
  "GET /calls/:id",
  "GET /calls/:id/transcript",
  "GET /calls/:id/enhanced",
  "GET /calls/:id/notes",
  "GET /calls/:id/memo",
  "GET /calls/:id/audio/:part",
  "GET /dictations",
  "GET /dictations/:id",
  "GET /dictations/:id/audio",
  "GET /workspaces",
];

/** The job reads, which a `jobs` key and a `read` key both reach. */
const JOB_READS = ["GET /jobs", "GET /jobs/:id", "GET /jobs/:id/result", "GET /jobs/:id/audio"];

const who = (...scopes: Scope[]): Identity => ({
  id: `key_${scopes.join("")}`,
  name: scopes.join("+"),
  scopes,
  callbackHosts: [],
});

/** Every route of both modes with the access its RouteDoc declares. */
function routes(): { route: string; access: Access }[] {
  return buildRouter()
    .list()
    .map((r) => ({ route: `${r.method} ${r.path}`, access: r.meta.access }));
}

describe("SV-K3: the read scope over the route table", () => {
  test("a read key reaches every history route, every job read and GET /v1/keys/me", () => {
    const table = new Map(routes().map((r) => [r.route, r.access]));
    const read = who("read");
    for (const route of [...HISTORY, ...JOB_READS, "GET /keys/me"]) {
      expect(`${route} ${table.has(route)}`).toBe(`${route} true`);
      expect(`${route} ${allows(read, table.get(route) as Access)}`).toBe(`${route} true`);
    }
  });

  test("a read key reaches nothing else that needs a key: no write, setting, key, model, share or quit", () => {
    const read = who("read");
    const reached = routes()
      .filter((r) => r.access !== "open" && allows(read, r.access))
      .map((r) => r.route)
      .sort();
    expect(reached).toEqual([...HISTORY, ...JOB_READS, "GET /keys/me"].sort());
    // Named on purpose: the routes a phone must never reach with a read key.
    const table = new Map(routes().map((r) => [r.route, r.access]));
    for (const route of [
      "PATCH /config",
      "GET /config",
      "GET /status",
      "POST /quit",
      "GET /keys",
      "POST /keys",
      "DELETE /keys/:id",
      "POST /calls",
      "PATCH /calls/:id",
      "DELETE /calls/:id",
      "POST /calls/:id/notes",
      "PUT /calls/:id/memo",
      "POST /share",
      "POST /window",
      "POST /models/pull",
      "GET /devices",
      "POST /vocab",
      "POST /jobs",
      "PATCH /jobs/:id",
      "DELETE /jobs/:id",
      "GET /events",
    ]) {
      expect(`${route} ${allows(read, table.get(route) as Access)}`).toBe(`${route} false`);
    }
  });

  test("a jobs key reaches no call, dictation or workspace, and keeps its job routes", () => {
    const jobs = who("jobs");
    const table = new Map(routes().map((r) => [r.route, r.access]));
    for (const route of HISTORY) {
      expect(`${route} ${allows(jobs, table.get(route) as Access)}`).toBe(`${route} false`);
    }
    for (const route of [...JOB_READS, "POST /jobs", "DELETE /jobs/:id", "GET /keys/me"]) {
      expect(`${route} ${allows(jobs, table.get(route) as Access)}`).toBe(`${route} true`);
    }
  });

  test("an admin key reaches every route; no key reaches only the open ones", () => {
    for (const { route, access } of routes()) {
      expect(`${route} ${allows(who("admin"), access)}`).toBe(`${route} true`);
      expect(`${route} ${allows(null, access)}`).toBe(`${route} ${access === "open"}`);
    }
  });

  test("a key's scopes: one or several, admin alone when named, nothing unknown", () => {
    expect(scopesOf("read")).toEqual(["read"]);
    expect(scopesOf(["read", "jobs", "read"])).toEqual(["jobs", "read"]);
    expect(scopesOf(["jobs", "admin"])).toEqual(["admin"]);
    expect(() => scopesOf([])).toThrow(/one or more of jobs, read, admin/);
    expect(() => scopesOf(["jobs", "write"])).toThrow(/one or more of/);
  });
});

// ---------------------------------------------------------------------------
// The network listener's guard

const TOKEN = "f".repeat(64);
const READ_KEY = `ak_${"r".repeat(43)}`;

function keys() {
  const touched: string[] = [];
  return {
    touched,
    authenticate: (bearer: string): Identity | null =>
      bearer === READ_KEY ? { ...who("read"), id: "key_read" } : null,
    touch: (id: string) => {
      touched.push(id);
    },
  };
}

function ctx(access: Access): GuardContext {
  return {
    port: 8478,
    token: TOKEN,
    route: { access },
    maxUploadBytes: 1024,
    source: "100.64.0.9",
  };
}

const req = (headers: Record<string, string>, method = "GET", path = "/v1/calls") =>
  new Request(`http://100.64.0.1:8478${path}`, { method, headers });

describe("the network listener's guard: keys only", () => {
  test("the app's own token is refused there and audited; the loopback guards take it (positive control)", () => {
    const refused: { keyPrefix: string; path: string; source: string }[] = [];
    const g = networkGuard({ keys: keys(), onRefused: (r) => refused.push(r) });
    const r = g(req({ authorization: `Bearer ${TOKEN}`, host: "100.64.0.1:8478" }), ctx("read"));
    expect("refused" in r && r.refused.status).toBe(401);
    expect(refused).toEqual([{ keyPrefix: "", path: "/v1/calls", source: "100.64.0.9" }]);
    // The same request on server mode's guard is the app: admin.
    const server = serverGuard({ publicHost: "", behindProxy: true, keys: keys() });
    const s = server(req({ authorization: `Bearer ${TOKEN}`, host: "x:1" }), ctx("read"));
    expect("identity" in s && s.identity?.id).toBe("app");
  });

  test("a read key gets through on any Host, and is noted as used", () => {
    const k = keys();
    const g = networkGuard({ keys: k });
    for (const host of ["100.64.0.1:8478", "my-mac.example.ts.net:8478", "evil.example"]) {
      const r = g(req({ authorization: `Bearer ${READ_KEY}`, host }), ctx("read"));
      expect("identity" in r && r.identity?.id).toBe("key_read");
    }
    expect(k.touched).toEqual(["key_read", "key_read", "key_read"]);
  });

  test("the scope rule holds: a read key on an admin route is 403, and an unknown key is 401 and audited", () => {
    const refused: string[] = [];
    const g = networkGuard({ keys: keys(), onRefused: (r) => refused.push(r.keyPrefix) });
    const admin = g(
      req({ authorization: `Bearer ${READ_KEY}`, "content-type": "application/json" }, "PATCH"),
      ctx("admin"),
    );
    expect("refused" in admin && admin.refused.status).toBe(403);
    const unknown = g(req({ authorization: `Bearer ak_${"z".repeat(43)}` }), ctx("read"));
    expect("refused" in unknown && unknown.refused.status).toBe(401);
    expect(refused).toEqual(["ak_zzzz"]);
  });

  test("a browser's request is refused before any key is read", async () => {
    const k = keys();
    const g = networkGuard({ keys: k });
    for (const h of ["origin", "sec-fetch-site", "sec-fetch-mode"]) {
      const r = g(req({ authorization: `Bearer ${READ_KEY}`, [h]: "x" }), ctx("read"));
      expect("refused" in r && r.refused.status).toBe(403);
      if ("refused" in r) {
        expect(((await r.refused.json()) as { error: string }).error).toBe("browser_request");
      }
    }
    expect(k.touched).toEqual([]);
  });

  test("an open route needs no key; a change still needs JSON", () => {
    const g = networkGuard({ keys: keys() });
    const open = g(req({}, "GET", "/v1/server"), ctx("open"));
    expect("identity" in open && open.identity).toBeNull();
    const notJson = g(
      req({ authorization: `Bearer ${READ_KEY}`, "content-type": "text/plain" }, "POST"),
      ctx("read"),
    );
    expect("refused" in notJson && notJson.refused.status).toBe(415);
  });
});
