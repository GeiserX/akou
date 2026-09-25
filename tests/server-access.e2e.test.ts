/**
 * SV-K3, scopes over every route, and SV-D3, the upload exception to the 64 KB JSON rule.
 *
 * The scope test walks every route the server has (the table the OpenAPI file is generated from)
 * with a `jobs` key, an `admin` key, a revoked key and no key, and asserts each answer against the
 * table below. A route with no row fails the test, so a new route cannot ship without saying who
 * may call it. A request that passes the guard must not change anything, so every route but a GET
 * is sent with a wrong Content-Type: getting past the scope check then shows as 415, before any
 * handler runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import type { Access } from "../src/main/api/access.ts";
import { json } from "../src/main/api/http.ts";
import { type ApiApp, type ApiServer, startApiServer } from "../src/main/api/server.ts";
import { type AppRig, appRig, rawRequest } from "./api-helpers.ts";
import { cli } from "./cli-helpers.ts";

/** Who may call each route. Adding a route means adding its row here. */
const TABLE: Record<string, Access> = {
  "GET /healthz": "open",
  "GET /v1/server": "open",
  "GET /v1/keys/me": "jobs",
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
  "GET /v1/calls/:id": "admin",
  "POST /v1/calls/:id/stop": "admin",
  "POST /v1/calls/:id/pause": "admin",
  "POST /v1/calls/:id/resume": "admin",
  "POST /v1/calls/:id/mute": "admin",
  "POST /v1/calls/:id/unmute": "admin",
  "POST /v1/calls/:id/restart": "admin",
  "GET /v1/calls/:id/events": "admin",
  "GET /v1/calls/:id/stream": "admin",
  "GET /v1/calls/:id/transcript": "admin",
  "POST /v1/calls/:id/context": "admin",
  "GET /v1/calls/:id/search": "admin",
  "POST /v1/calls/:id/ask": "admin",
  "POST /v1/calls/:id/speakers": "admin",
  "POST /v1/calls/:id/speakers/merge": "admin",
  "POST /v1/calls/:id/speakers/unmerge": "admin",
  "GET /v1/calls/:id/notes": "admin",
  "POST /v1/calls/:id/notes": "admin",
  "PATCH /v1/calls/:id/notes/:nid": "admin",
  "DELETE /v1/calls/:id/notes/:nid": "admin",
  "POST /v1/calls/:id/remember": "admin",
  "DELETE /v1/calls/:id/remember/:rid": "admin",
  "GET /v1/calls/:id/memo": "admin",
  "PUT /v1/calls/:id/memo": "admin",
  "GET /v1/calls/:id/vocab": "admin",
  "POST /v1/calls/:id/vocab": "admin",
  "DELETE /v1/calls/:id/vocab/:vid": "admin",
  "POST /v1/calls/:id/vocab/pass": "admin",
  "GET /v1/vocab": "admin",
  "POST /v1/vocab": "admin",
  "DELETE /v1/vocab/:term": "admin",
  "POST /v1/vocab/approve": "admin",
  "POST /v1/vocab/reject": "admin",
  "POST /v1/vocab/import": "admin",
  "POST /v1/vocab/suggest": "admin",
  "POST /v1/vocab/check": "admin",
  "POST /v1/calls/:id/finalize": "admin",
  "POST /v1/calls/:id/enhance": "admin",
  "GET /v1/calls/:id/enhance/context": "admin",
  "PUT /v1/calls/:id/enhanced": "admin",
  "GET /v1/calls/:id/enhanced": "admin",
  "GET /v1/calls/:id/audio/:part": "admin",
  "POST /v1/calls/:id/export": "admin",
  "POST /v1/calls/:id/hooks": "admin",
  "POST /v1/import/hark-viewer": "admin",
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
    expect(drift([...routes, "POST /v1/jobs"]).missing).toEqual(["POST /v1/jobs"]);
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

function uploadServer(maxUploadBytes?: number): ApiServer {
  return startApiServer({
    app: { version: "0.0.0-test" } as unknown as ApiApp,
    port: 0,
    token: () => TOKEN,
    maxUploadBytes,
    // The job route's shape (SV-J1): an upload, for any key. It counts what arrives.
    routes: (r) =>
      r.add(
        "POST",
        "/jobs",
        async (c) => {
          let bytes = 0;
          for await (const chunk of c.req.body ?? []) bytes += chunk.byteLength;
          return json(202, { bytes });
        },
        { access: "jobs", upload: true },
      ),
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

/** Headers declaring a body, then at most 2 MiB of it: the answer comes from the headers. */
function declare(
  port: number,
  path: string,
  headers: Record<string, string>,
  length: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port });
    let buf = "";
    sock.on("connect", () => {
      const lines = [
        `POST ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: close",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        `Content-Length: ${length}`,
        "",
        "",
      ];
      sock.write(lines.join("\r\n"));
      // The whole of a small body; 2 MiB of a large one, past the server's drain cap, so the
      // refusal is sent at once rather than after the drain's 2 s wait for bytes that never come.
      sock.write("x".repeat(Math.min(length, 2 * MB)));
    });
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) {
        sock.destroy();
        resolve(Number(m[1]));
      }
    });
    sock.on("error", reject);
  });
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
      expect(await declare(s.port, "/v1/jobs", auth, 3 * MB)).toBe(413);
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
