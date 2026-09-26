/**
 * SV-K3, scopes over every route, and SV-D3, the upload exception to the 64 KB JSON rule.
 *
 * The scope test (SV-T5) walks every route the server has, which is every operation of the
 * OpenAPI file it serves plus `/healthz`, with a `jobs` key, an `admin` key, a revoked key and no
 * key, and asserts each answer against the one table of `fixtures/route-access.ts`. A route with
 * no row fails the test, so a new route cannot ship without saying who may call it. A request that passes the guard must not change anything, so every route but a GET
 * is sent with a wrong Content-Type: getting past the scope check then shows as 415, before any
 * handler runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { OPENAPI_FILE } from "../scripts/openapi.ts";
import type { Access } from "../src/main/api/access.ts";
import { json } from "../src/main/api/http.ts";
import { type OpenApiDoc, operations } from "../src/main/api/openapi.ts";
import {
  type ApiApp,
  type ApiServer,
  buildRouter,
  startApiServer,
} from "../src/main/api/server.ts";
import { type AppRig, appRig, declare, rawRequest } from "./api-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { FIXTURE_ROUTES } from "./fixtures/openapi-routes.ts";
import { ACCESS } from "./fixtures/route-access.ts";

/**
 * Who may call each route: the one table of `fixtures/route-access.ts`, in the route table's
 * `:param` form, and `/healthz`, which is outside `/v1` and the OpenAPI file.
 */
const TABLE: Record<string, Access> = {
  "GET /healthz": "open",
  ...Object.fromEntries(
    Object.entries(ACCESS).map(([route, access]) => [route.replace(/\{([^}]+)\}/g, ":$1"), access]),
  ),
};

type Caller = "jobs" | "admin" | "revoked" | "none";

/**
 * What each caller gets: `ok` is any answer from past the guard (a route's own 200, 404 or 400,
 * or the 415 of the wrong Content-Type), never 401 or 403.
 */
function expected(access: Access, who: Caller): 401 | 403 | "ok" {
  if (access === "open") return "ok";
  if (who === "revoked" || who === "none") return 401;
  if (access === "admin" && who === "jobs") return 403;
  return "ok";
}

/** Routes with no row, and rows with no route. */
function drift(routes: readonly string[]): { missing: string[]; stale: string[] } {
  return {
    missing: routes.filter((r) => !(r in TABLE)),
    stale: Object.keys(TABLE).filter((r) => !routes.includes(r)),
  };
}

let rig: AppRig;
const keys: Record<Caller, string | null> = { jobs: null, admin: null, revoked: null, none: null };

async function create(name: string, scope: string): Promise<{ id: string; key: string }> {
  const r = await cli({ ...process.env, ...rig.env }, [
    "keys",
    "create",
    "--name",
    name,
    "--scope",
    scope,
    "--json",
  ]);
  expect(r.code).toBe(0);
  return r.json;
}

beforeAll(async () => {
  rig = await appRig({ settings: { "server.enabled": true, "api.bind": "127.0.0.1" } });
  keys.jobs = (await create("scoped-jobs", "jobs")).key;
  keys.admin = (await create("scoped-admin", "admin")).key;
  const gone = await create("scoped-gone", "jobs");
  keys.revoked = gone.key;
  const r = await cli({ ...process.env, ...rig.env }, ["keys", "revoke", gone.id]);
  expect(r.code).toBe(0);
});

afterAll(async () => {
  await rig?.close();
});

describe("SV-K3: scopes over every route", () => {
  test("every route has a row in the table, and every row a route", () => {
    const routes = (rig.app.server as ApiServer).routes().map((r) => `${r.method} ${r.path}`);
    expect(routes.length).toBe(Object.keys(TABLE).length);
    expect(drift(routes)).toEqual({ missing: [], stale: [] });
    // Positive control: a route added without a row is caught.
    expect(drift([...routes, "POST /v1/nothing"]).missing).toEqual(["POST /v1/nothing"]);
    expect(drift(routes.filter((r) => r !== "POST /v1/jobs")).stale).toEqual(["POST /v1/jobs"]);
  });

  test("[SV-T5] the walk covers every operation of the OpenAPI file, both modes", () => {
    const file = JSON.parse(readFileSync(OPENAPI_FILE, "utf8")) as OpenApiDoc;
    const ops = operations(file).map(
      (o) => `${o.method.toUpperCase()} ${o.path.replace(/\{([^}]+)\}/g, ":$1")}`,
    );
    expect(ops.length).toBeGreaterThan(60);
    // The file holds every route the server has, and only `/healthz` is outside it.
    expect(drift(ops)).toEqual({ missing: [], stale: ["GET /healthz"] });
    // Positive control: an operation added to the file without a row is caught.
    expect(drift([...ops, "GET /v1/nothing"]).missing).toEqual(["GET /v1/nothing"]);
  });

  test("the routes declare the access the table says", () => {
    for (const r of (rig.app.server as ApiServer).routes()) {
      expect(`${r.method} ${r.path} ${r.meta.access}`).toBe(
        `${r.method} ${r.path} ${TABLE[`${r.method} ${r.path}`]}`,
      );
    }
  });

  for (const who of ["jobs", "admin", "revoked", "none"] as const) {
    test(`a ${who === "none" ? "request with no" : `${who}`} key gets what the table says on every route`, async () => {
      const wrong: string[] = [];
      for (const [route, access] of Object.entries(TABLE)) {
        const [method, pattern] = route.split(" ") as [string, string];
        const path = pattern.replace(/:[a-z]+/g, "x");
        const key = keys[who];
        const r = await rawRequest(rig.port, {
          method,
          path,
          headers: {
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            // Past the guard, a change is refused as 415 before any handler runs.
            ...(method !== "GET" ? { "content-type": "text/plain" } : {}),
          },
          body: method !== "GET" ? "{}" : undefined,
        });
        const want = expected(access, who);
        const got = r.status === 401 || r.status === 403 ? r.status : "ok";
        if (got !== want) wrong.push(`${route}: ${r.status}, want ${want}`);
        if (want === "ok" && method !== "GET" && access !== "open") {
          if (r.status !== 415) wrong.push(`${route}: ${r.status}, want 415 past the guard`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  test("a jobs key that calls PATCH /v1/config gets 403; the app's token keeps admin", async () => {
    const patch = (key: string) =>
      rawRequest(rig.port, {
        method: "PATCH",
        path: "/v1/config",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ "asr.segmentPause": 0.9 }),
      });
    const r = await patch(keys.jobs as string);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toBe("forbidden");
    expect((await rig.api("GET", "/config")).body.settings["asr.segmentPause"]).not.toBe(0.9);
    const app = await patch(rig.token);
    expect(app.status).toBe(200);
    expect(JSON.parse(app.body).settings["asr.segmentPause"]).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// SV-D3

const TOKEN = "t".repeat(64);
const MB = 1024 * 1024;

/** `POST /v1/jobs` as the route table will describe it: a multipart upload, for any key. */
const JOBS_CREATE = (
  FIXTURE_ROUTES.find((f) => f.doc.id === "jobs.create") as (typeof FIXTURE_ROUTES)[number]
).doc;

function uploadServer(maxUploadBytes?: number): ApiServer {
  return startApiServer({
    app: { version: "0.0.0-test" } as unknown as ApiApp,
    port: 0,
    token: () => TOKEN,
    maxUploadBytes,
    // The job route's shape (SV-J1): an upload, for any key. It counts what arrives.
    router: buildRouter("app").add("POST", "/jobs", JOBS_CREATE, async (c) => {
      let bytes = 0;
      for await (const chunk of c.req.body ?? []) bytes += chunk.byteLength;
      return json(202, { bytes });
    }),
  });
}

/** A multipart body of `size` bytes of file, streamed in 1 MiB chunks, never held whole. */
function multipart(size: number): {
  body: ReadableStream<Uint8Array>;
  length: number;
  type: string;
} {
  const boundary = "akouboundary7MA4YWxkTrZu0gW";
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const chunk = new Uint8Array(MB);
  let sent = 0;
  let stage = 0;
  return {
    length: head.byteLength + size + tail.byteLength,
    type: `multipart/form-data; boundary=${boundary}`,
    body: new ReadableStream({
      pull(ctl) {
        if (stage === 0) {
          stage = 1;
          ctl.enqueue(head);
        } else if (sent < size) {
          const n = Math.min(MB, size - sent);
          sent += n;
          ctl.enqueue(n === MB ? chunk : chunk.subarray(0, n));
        } else {
          ctl.enqueue(tail);
          ctl.close();
        }
      },
    }),
  };
}

describe("SV-D3: the 64 KB cap applies to JSON routes only", () => {
  test("a 300 MB upload to POST /v1/jobs succeeds", async () => {
    const s = uploadServer();
    try {
      const size = 300 * MB;
      const m = multipart(size);
      const r = await fetch(`http://127.0.0.1:${s.port}/v1/jobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": m.type,
          "content-length": String(m.length),
        },
        body: m.body,
        duplex: "half",
      } as RequestInit);
      expect(r.status).toBe(202);
      expect(((await r.json()) as { bytes: number }).bytes).toBe(m.length);
    } finally {
      await s.stop();
    }
  }, 60_000);

  test("a 300 MB JSON body to POST /v1/calls still gets 413; a multipart body still gets 415", async () => {
    const s = uploadServer();
    try {
      const auth = { authorization: `Bearer ${TOKEN}` };
      const big = await declare(
        s.port,
        "/v1/calls",
        { ...auth, "content-type": "application/json" },
        300 * MB,
      );
      expect(big).toBe(413);
      const mp = await declare(
        s.port,
        "/v1/calls",
        { ...auth, "content-type": "multipart/form-data; boundary=x" },
        4096,
      );
      expect(mp).toBe(415);
      // The upload route is not a door for JSON, and holds its own cap.
      const jsonUpload = await declare(
        s.port,
        "/v1/jobs",
        { ...auth, "content-type": "application/json" },
        10,
      );
      expect(jsonUpload).toBe(415);
      const over = await declare(
        s.port,
        "/v1/jobs",
        { ...auth, "content-type": "multipart/form-data; boundary=x" },
        513 * MB,
        0,
      );
      expect(over).toBe(413);
    } finally {
      await s.stop();
    }
  });

  test("server.max_upload_mb sets the upload cap", async () => {
    const s = uploadServer(2 * MB);
    try {
      const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "multipart/form-data" };
      expect(await declare(s.port, "/v1/jobs", auth, 3 * MB, 0)).toBe(413);
      const m = multipart(MB);
      const r = await fetch(`http://127.0.0.1:${s.port}/v1/jobs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": m.type },
        body: m.body,
        duplex: "half",
      } as RequestInit);
      expect(r.status).toBe(202);
    } finally {
      await s.stop();
    }
  });
});
