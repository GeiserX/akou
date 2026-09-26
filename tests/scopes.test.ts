/**
 * Keys and scopes over every route (docs/ux/SERVER.md SV-T5): one table says who may call each
 * operation of the OpenAPI file, and a walk sends every operation with each credential and checks
 * the answer against the table. A route added without a row fails, and so does a route whose
 * declared access disagrees with its row.
 *
 * The credentials are the ones akou has today: no key, a key akou does not know (what a revoked
 * key gets), and the app's token, which holds the `admin` scope. The `jobs` column is checked
 * against the served `?scope=jobs` view; walking it with a real `jobs` key waits for the keys of
 * SV-K2 and the scope rule of SV-K3.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { OPENAPI_FILE } from "../scripts/openapi.ts";
import type { Access } from "../src/main/api/access.ts";
import { type Guard, guard } from "../src/main/api/guard.ts";
import { HttpError } from "../src/main/api/http.ts";
import {
  buildOpenApi,
  type OpenApiDoc,
  operations,
  servedOpenApi,
} from "../src/main/api/openapi.ts";
import { type ApiApp, buildRouter, startApiServer } from "../src/main/api/server.ts";
import { APP_VERSION } from "../src/main/app-info.ts";
import { CONTROL_ROUTE } from "./fixtures/openapi-routes.ts";

process.env.NO_PROXY = "127.0.0.1,localhost";

/**
 * Who may call each operation: `open` needs no key, `jobs` a key with the `jobs` scope (or more),
 * `admin` only an `admin` key or the app's token. Written by hand, never read from the routes.
 */
const TABLE: Record<string, Access> = {
  "GET /v1/status": "admin",
  "GET /v1/config": "admin",
  "PATCH /v1/config": "admin",
  "GET /v1/templates": "admin",
  "GET /v1/share": "admin",
  "POST /v1/share": "admin",
  "DELETE /v1/share": "admin",
  "POST /v1/window": "admin",
  "POST /v1/quit": "admin",
  "GET /v1/models": "admin",
  "POST /v1/models/pull": "admin",
  "POST /v1/calls": "admin",
  "GET /v1/calls": "admin",
  "GET /v1/calls/{id}": "admin",
  "POST /v1/calls/{id}/stop": "admin",
  "POST /v1/calls/{id}/pause": "admin",
  "POST /v1/calls/{id}/resume": "admin",
  "POST /v1/calls/{id}/mute": "admin",
  "POST /v1/calls/{id}/unmute": "admin",
  "POST /v1/calls/{id}/restart": "admin",
  "GET /v1/calls/{id}/events": "admin",
  "GET /v1/calls/{id}/stream": "admin",
  "GET /v1/calls/{id}/transcript": "admin",
  "POST /v1/calls/{id}/context": "admin",
  "GET /v1/calls/{id}/search": "admin",
  "POST /v1/calls/{id}/ask": "admin",
  "POST /v1/calls/{id}/speakers": "admin",
  "POST /v1/calls/{id}/speakers/merge": "admin",
  "POST /v1/calls/{id}/speakers/unmerge": "admin",
  "GET /v1/calls/{id}/notes": "admin",
  "POST /v1/calls/{id}/notes": "admin",
  "PATCH /v1/calls/{id}/notes/{nid}": "admin",
  "DELETE /v1/calls/{id}/notes/{nid}": "admin",
  "POST /v1/calls/{id}/remember": "admin",
  "DELETE /v1/calls/{id}/remember/{rid}": "admin",
  "GET /v1/calls/{id}/memo": "admin",
  "PUT /v1/calls/{id}/memo": "admin",
  "GET /v1/calls/{id}/vocab": "admin",
  "POST /v1/calls/{id}/vocab": "admin",
  "DELETE /v1/calls/{id}/vocab/{vid}": "admin",
  "POST /v1/calls/{id}/vocab/pass": "admin",
  "GET /v1/vocab": "admin",
  "POST /v1/vocab": "admin",
  "DELETE /v1/vocab/{term}": "admin",
  "POST /v1/vocab/approve": "admin",
  "POST /v1/vocab/reject": "admin",
  "POST /v1/vocab/import": "admin",
  "POST /v1/vocab/suggest": "admin",
  "POST /v1/vocab/check": "admin",
  "POST /v1/calls/{id}/finalize": "admin",
  "POST /v1/calls/{id}/enhance": "admin",
  "GET /v1/calls/{id}/enhance/context": "admin",
  "PUT /v1/calls/{id}/enhanced": "admin",
  "GET /v1/calls/{id}/enhanced": "admin",
  "GET /v1/calls/{id}/audio/{part}": "admin",
  "POST /v1/calls/{id}/export": "admin",
  "POST /v1/calls/{id}/hooks": "admin",
  "POST /v1/import/hark-viewer": "admin",
  "GET /v1/openapi.json": "open",
  // Anonymous, like `/healthz` outside `/v1` (service-interface.md SI-2, SERVER.md SV-K1).
  "GET /v1/server": "open",
  // Any key, and the app's token (SI-3).
  "GET /v1/keys/me": "jobs",
  // Server mode's jobs, events and the OpenAI door: any key, each seeing its own (SV-K3).
  "POST /v1/jobs": "jobs",
  "GET /v1/jobs": "jobs",
  "GET /v1/jobs/{id}": "jobs",
  "GET /v1/jobs/{id}/result": "jobs",
  "DELETE /v1/jobs/{id}": "jobs",
  "GET /v1/events": "jobs",
  "POST /v1/audio/transcriptions": "jobs",
};

type Credential = "none" | "unknown" | "admin";
const TOKEN = "a".repeat(64);
const HEADERS: Record<Credential, Record<string, string>> = {
  none: {},
  // A well-formed key akou does not hold: the answer a revoked key gets.
  unknown: { authorization: `Bearer ak_${"b".repeat(43)}` },
  admin: { authorization: `Bearer ${TOKEN}` },
};

/** What the table says a credential gets: refused with 401 or 403, or let through. */
function expected(access: Access, cred: Credential | "jobs"): 401 | 403 | "allowed" {
  if (access === "open" || cred === "admin") return "allowed";
  if (cred === "jobs") return access === "admin" ? 403 : "allowed";
  return 401;
}

const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

/** The operations of a file with no row, and the rows with no operation. */
function rowDrift(doc: OpenApiDoc, table: Record<string, Access>) {
  const ops = operations(doc).map((o) => key(o.method, o.path));
  return {
    noRow: ops.filter((k) => !(k in table)),
    noOperation: Object.keys(table).filter((k) => !ops.includes(k)),
  };
}

/** Rows whose access disagrees with the access the route declares in the file. */
function accessDrift(doc: OpenApiDoc, table: Record<string, Access>): string[] {
  return operations(doc)
    .filter((o) => table[key(o.method, o.path)] !== o.op["x-akou-access"])
    .map(
      (o) =>
        `${key(o.method, o.path)}: table ${table[key(o.method, o.path)]}, file ${o.op["x-akou-access"]}`,
    );
}

/**
 * An app that refuses everything with 418 except what the OpenAPI route reads, so a request that
 * gets past the guard reaches a route and changes nothing: no call starts, nothing quits.
 */
function inertApp(): ApiApp {
  const reached = () => {
    throw new HttpError(418, "reached", "the request reached the app");
  };
  const deep: object = new Proxy(reached, {
    get: (_t, prop) => (prop === "then" ? undefined : deep),
    apply: reached,
  });
  const known: Record<string | symbol, unknown> = {
    version: APP_VERSION,
    mode: () => "app",
    config: () => ({ settings: {} }),
  };
  return new Proxy({} as ApiApp, {
    get: (_t, prop) => (prop in known ? known[prop] : prop === "then" ? undefined : deep),
  });
}

const committed = (): OpenApiDoc => JSON.parse(readFileSync(OPENAPI_FILE, "utf8"));

/**
 * Sends every operation of the file with each credential, through a real server over the inert
 * app, and lists every answer the table disagrees with.
 */
async function walk(g?: Guard): Promise<{ wrong: string[]; walked: number }> {
  const server = startApiServer({ app: inertApp(), port: 0, token: () => TOKEN, guard: g });
  const wrong: string[] = [];
  let walked = 0;
  try {
    for (const { method, path } of operations(committed())) {
      const access = TABLE[key(method, path)] as Access;
      const url = `http://127.0.0.1:${server.port}${path.replace(/\{[^}]+\}/g, "x")}`;
      const upper = method.toUpperCase();
      const body = upper === "GET" ? undefined : "{}";
      for (const cred of ["none", "unknown", "admin"] as const) {
        const res = await fetch(url, {
          method: upper,
          headers: { ...HEADERS[cred], ...(body ? { "content-type": "application/json" } : {}) },
          body,
        });
        await res.arrayBuffer();
        walked++;
        const want = expected(access, cred);
        const got = res.status;
        const ok = want === "allowed" ? got !== 401 && got !== 403 : got === want;
        if (!ok) wrong.push(`${key(method, path)} with ${cred}: ${got}, table says ${want}`);
      }
    }
  } finally {
    await server.stop();
  }
  return { wrong, walked };
}

describe("[SV-T5] one table of who may call each route", () => {
  test("every operation in the OpenAPI file has a row, and every row an operation", () => {
    expect(rowDrift(committed(), TABLE)).toEqual({ noRow: [], noOperation: [] });
  });

  test("positive control: a route added without a row fails", () => {
    const doc = buildOpenApi([...buildRouter().entries(), CONTROL_ROUTE], { version: APP_VERSION });
    expect(rowDrift(doc, TABLE)).toEqual({ noRow: ["GET /v1/positive-control"], noOperation: [] });
  });

  test("each row agrees with the access its route declares", () => {
    expect(accessDrift(committed(), TABLE)).toEqual([]);
    // Positive control: a route that opens itself to `jobs` keys disagrees with its row.
    const doc = committed();
    const cfg = doc.paths["/v1/config"]?.patch;
    if (cfg) cfg["x-akou-access"] = "jobs";
    expect(accessDrift(doc, TABLE)).toEqual(["PATCH /v1/config: table admin, file jobs"]);
  });

  test("the jobs column is exactly the served ?scope=jobs view, compatibility routes and the file aside", () => {
    const full = committed();
    for (const mode of ["app", "server"] as const) {
      const view = servedOpenApi(full, { mode, scope: "jobs", serverUrl: "http://x" });
      const inView = operations(view)
        .map((o) => key(o.method, o.path))
        .sort();
      const fromTable = operations(full)
        .filter((o) => o.op["x-akou-modes"].includes(mode) && o.op["x-akou-door"] === undefined)
        .map((o) => key(o.method, o.path))
        .filter((k) => expected(TABLE[k] as Access, "jobs") === "allowed")
        .sort();
      expect(inView).toEqual(fromTable);
    }
  });

  test("walking every operation with no key, an unknown key and the admin token matches the table", async () => {
    const r = await walk();
    expect(r.wrong).toEqual([]);
    expect(r.walked).toBe(Object.keys(TABLE).length * 3);
  });

  test("positive control: the walk reports routes that let a request through without the token", async () => {
    // The guard with every route treated as anonymous.
    const r = await walk((req, ctx) => guard(req, { ...ctx, route: { access: "open" } }));
    expect(r.wrong).toContain("GET /v1/status with none: 418, table says 401");
    expect(r.wrong).toContain("POST /v1/quit with unknown: 418, table says 401");
    // Every closed route is wrong twice (no key, unknown key), except `GET /v1/keys/me`: it needs a
    // caller, so with every route anonymous it answers 401 itself, right for those two and wrong
    // once, for the admin token.
    const open = Object.values(TABLE).filter((a) => a === "open").length;
    expect(r.wrong.length).toBe((Object.keys(TABLE).length - open - 1) * 2 + 1);
    expect(r.wrong).toContain("GET /v1/keys/me with admin: 401, table says allowed");
  });
});
