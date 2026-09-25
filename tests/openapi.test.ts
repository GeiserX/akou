/**
 * The OpenAPI file (docs/ux/PROGRAMMABILITY.md PG-A2, docs/ux/SERVER.md SV-C4) and its served,
 * Executor-shaped copy (docs/research/service-interface.md SI-2).
 *
 * - The committed `docs/api/openapi.json` is exactly what the route table generates; CI runs this
 *   file, so a route added, removed or changed without regenerating fails the build.
 * - Every route the server serves is in the file, and nothing else is.
 * - The file keeps Executor's rules, and each rule has a positive control that breaks it.
 * - `GET /v1/openapi.json` answers with no key, lists the running mode's routes only, and with
 *   `?scope=jobs` only what a `jobs` key can call.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { controlFailure } from "../scripts/ci/executor-roundtrip.ts";
import { OPENAPI_FILE, openApiDrifted, renderOpenApi } from "../scripts/openapi.ts";
import { SCOPES } from "../src/main/api/access.ts";
import { type Guard, guard } from "../src/main/api/guard.ts";
import { json, type Mode, type RouteEntry, Router } from "../src/main/api/http.ts";
import {
  buildOpenApi,
  type OpenApiDoc,
  openApiPath,
  openApiProblems,
  operations,
  servedOpenApi,
  serverUrlFor,
} from "../src/main/api/openapi.ts";
import { type ApiApp, buildRouter, startApiServer } from "../src/main/api/server.ts";
import { APP_VERSION } from "../src/main/app-info.ts";
import { addFixtureRoutes, FIXTURE_ROUTES } from "./fixtures/openapi-routes.ts";

process.env.NO_PROXY = "127.0.0.1,localhost";

const committedText = () => readFileSync(OPENAPI_FILE, "utf8");
const committed = (): OpenApiDoc => JSON.parse(committedText());
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** `METHOD /v1/path/{param}` for every operation of a file. */
function opKeys(doc: OpenApiDoc): string[] {
  return operations(doc)
    .map((o) => `${o.method.toUpperCase()} ${o.path}`)
    .sort();
}

/** The same keys for a list of routes as a server reports them (`/calls/:id`). */
function routeKeys(routes: { method: string; path: string }[]): string[] {
  return routes.map((r) => `${r.method} ${openApiPath(r.path)}`).sort();
}

/** An app with only what the OpenAPI route reads. */
function stubApp(o: { mode?: Mode; settings?: Record<string, unknown> } = {}): ApiApp {
  return {
    version: APP_VERSION,
    mode: () => o.mode ?? "app",
    config: () => ({ settings: o.settings ?? {} }),
  } as unknown as ApiApp;
}

const TOKEN = "t".repeat(64);

async function serve(
  o: { mode?: Mode; settings?: Record<string, unknown>; guard?: Guard; fixtures?: boolean } = {},
) {
  const router = buildRouter();
  if (o.fixtures) addFixtureRoutes(router);
  const server = startApiServer({
    app: stubApp(o),
    port: 0,
    token: () => TOKEN,
    guard: o.guard,
    router,
  });
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/v1${path}`, { headers });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body: body as OpenApiDoc };
  };
  return { server, get };
}

describe("[PG-A2] the committed file is generated from the route table", () => {
  test("docs/api/openapi.json is exactly what the route table generates (run `bun run openapi`)", () => {
    expect(openApiDrifted(committedText())).toBe(false);
  });

  test("positive control: a table missing one route, or with one more, fails the check", () => {
    const entries = buildRouter().entries();
    const missing = entries.filter((e) => e.path !== "/calls/:id/memo" || e.method !== "GET");
    expect(missing.length).toBe(entries.length - 1);
    expect(openApiDrifted(committedText(), renderOpenApi(missing))).toBe(true);
    const more: RouteEntry[] = [...entries, FIXTURE_ROUTES[0] as RouteEntry];
    expect(openApiDrifted(committedText(), renderOpenApi(more))).toBe(true);
    // A changed description is a diff too: the file carries the route's doc, not just its path.
    const changed = entries.map((e, i) => (i === 0 ? { ...e, doc: { ...e.doc, doc: "x" } } : e));
    expect(openApiDrifted(committedText(), renderOpenApi(changed))).toBe(true);
  });

  test("line endings aside: a CRLF checkout of the same file is not a diff", () => {
    expect(openApiDrifted(committedText().replace(/\n/g, "\r\n"))).toBe(false);
  });

  test("every route in server.routes() appears in the file, and nothing else does", async () => {
    const { server } = await serve();
    try {
      const served = routeKeys(server.routes());
      expect(served.length).toBeGreaterThan(50);
      expect(opKeys(committed())).toEqual(served);
      // Positive control: a file with an operation the server lacks, or lacking one it has.
      const extra = clone(committed());
      (extra.paths["/v1/phantom"] as unknown) = { get: extra.paths["/v1/status"]?.get };
      expect(opKeys(extra)).not.toEqual(served);
      const less = clone(committed());
      delete less.paths["/v1/status"];
      expect(opKeys(less)).not.toEqual(served);
    } finally {
      await server.stop();
    }
  });

  test("the file lists every declared query parameter and body field of a route", () => {
    const doc = committed();
    const transcript = doc.paths["/v1/calls/{id}/transcript"]?.get;
    const names = (transcript?.parameters ?? []).map((p) => `${p.in}:${p.name}`);
    expect(names).toEqual([
      "path:id",
      "query:layer",
      "query:format",
      "query:since",
      "query:limitTokens",
      "query:from",
      "query:to",
      "query:speaker",
    ]);
    const start = doc.paths["/v1/calls"]?.post?.requestBody as {
      content: Record<string, { schema: { properties: object; additionalProperties: boolean } }>;
    };
    const schema = start.content["application/json"]?.schema;
    expect(Object.keys(schema?.properties ?? {})).toEqual([
      "workspace",
      "title",
      "template",
      "call",
      "mic",
      "vocab",
      "withoutModels",
    ]);
    expect(schema?.additionalProperties).toBe(false);
  });
});

describe("[SV-C4] the file covers the server-mode routes as they are added", () => {
  test("job, event, key and OpenAI routes added to the table fail the check until regenerated, then appear", () => {
    const entries = [...buildRouter().entries(), ...(FIXTURE_ROUTES as RouteEntry[])];
    expect(openApiDrifted(committedText(), renderOpenApi(entries))).toBe(true);
    const doc = buildOpenApi(entries, { version: APP_VERSION });
    for (const p of ["/v1/jobs", "/v1/jobs/{id}", "/v1/events", "/v1/keys/me", "/v1/keys"]) {
      expect(doc.paths[p]).toBeDefined();
    }
    expect(doc.paths["/v1/audio/transcriptions"]?.post?.operationId).toBe("openai.transcribe");
    expect(openApiProblems(doc)).toEqual([]);
  });

  test("a real route the fixture also has wins: the fixture fills only what is missing", async () => {
    // The jobs routes may land before `keys.me`; the file must then describe the real upload.
    const router = buildRouter();
    const real = { ...(FIXTURE_ROUTES[0] as RouteEntry).doc, doc: "The real one." };
    router.add("POST", "/jobs", { ...real, body: { multipart: { audio: "file" } } }, () =>
      json(202, { real: true }),
    );
    const added = addFixtureRoutes(router);
    expect(added).not.toContain("jobs.create");
    expect(added).toContain("keys.me");
    const doc = buildOpenApi(router.entries(), { version: APP_VERSION });
    const op = doc.paths["/v1/jobs"]?.post;
    expect(op?.description).toBe("The real one.");
    expect(JSON.stringify(op?.requestBody)).toContain('"audio"');
    expect(JSON.stringify(op?.requestBody)).not.toContain('"file"');
    // With nothing real in the way, the fixture adds every one of its routes.
    expect(addFixtureRoutes(buildRouter()).length).toBe(FIXTURE_ROUTES.length);
  });

  test("two routes of the same method and path are refused: the second would be served by the first", () => {
    const entries = buildRouter().entries();
    const again = entries[0] as RouteEntry;
    expect(() => buildOpenApi([...entries, again], { version: APP_VERSION })).toThrow(
      `${again.method} ${openApiPath(again.path)} is in the route table twice`,
    );
    expect(() => buildOpenApi(entries, { version: APP_VERSION })).not.toThrow();
  });
});

describe("[SI-2] Executor's rules over the file", () => {
  const fixtureDoc = () =>
    buildOpenApi([...buildRouter().entries(), ...(FIXTURE_ROUTES as RouteEntry[])], {
      version: APP_VERSION,
    });

  test("the committed file keeps every rule", () => {
    const doc = committed();
    expect(openApiProblems(doc)).toEqual([]);
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.components.securitySchemes)).toEqual(["bearerAuth"]);
    for (const { op } of operations(doc)) {
      expect(op["x-akou-modes"].length).toBeGreaterThan(0);
    }
    // The file of the route table holds the file route itself, anonymous and marked as the spec.
    const spec = doc.paths["/v1/openapi.json"]?.get;
    expect(spec?.security).toEqual([]);
    expect(spec?.["x-akou-door"]).toBe("spec");
  });

  test("a multipart file field is `format: binary`, the one form Executor turns into a file argument", () => {
    const doc = fixtureDoc();
    const body = doc.paths["/v1/jobs"]?.post?.requestBody as {
      content: Record<string, { schema: { properties: Record<string, unknown> } }>;
    };
    expect(body.content["multipart/form-data"]?.schema.properties.file).toEqual({
      type: "string",
      format: "binary",
      contentMediaType: "application/octet-stream",
    });
    expect(openApiProblems(doc)).toEqual([]);
  });

  test("positive controls: each broken rule is reported", () => {
    const broken = (mutate: (d: OpenApiDoc) => void) => {
      const d = clone(fixtureDoc());
      mutate(d);
      return openApiProblems(d);
    };
    const status = (d: OpenApiDoc) =>
      d.paths["/v1/status"]?.get as unknown as Record<string, unknown>;
    expect(broken(() => {})).toEqual([]);
    expect(broken((d) => delete status(d).description)).toEqual(["GET /v1/status: no description"]);
    expect(broken((d) => delete status(d).tags)).toContain("GET /v1/status: 0 tags, not one");
    expect(
      broken((d) => {
        status(d).operationId = "getStatus";
      }),
    ).toEqual(['GET /v1/status: operationId "getStatus" is not <tag>.<verb>']);
    expect(
      broken((d) => {
        status(d).operationId = "calls.status";
      }),
    ).toEqual(["GET /v1/status: operationId calls.status is not in its tag app"]);
    expect(
      broken((d) => {
        d.components.securitySchemes.apiKey = { type: "apiKey", in: "header", name: "X-Key" };
      }),
    ).toEqual([
      "2 security schemes; Executor wants exactly one",
      "security scheme apiKey is not http bearer",
    ]);
    expect(
      broken((d) => {
        const body = d.paths["/v1/jobs"]?.post?.requestBody as {
          content: Record<
            string,
            { schema: { properties: Record<string, Record<string, unknown>> } }
          >;
        };
        delete body.content["multipart/form-data"]?.schema.properties.file?.format;
      }),
    ).toEqual(["POST /v1/jobs: multipart file field file is not format: binary"]);
    expect(
      broken((d) => {
        d.openapi = "3.2.0";
      }),
    ).toEqual(['openapi is "3.2.0", not 3.1.0']);
    expect(broken((d) => delete status(d)["x-akou-modes"])).toEqual([
      "GET /v1/status: x-akou-modes undefined is not a list of modes",
    ]);
    expect(
      broken((d) => {
        status(d).operationId = "calls.list";
        status(d).tags = ["calls"];
      }),
    ).toContain("GET /v1/calls: operationId calls.list twice");
  });

  test("x-akou-access is `open` or one of the scopes the keys carry, one vocabulary with access.ts", () => {
    expect(SCOPES).toEqual(["jobs", "admin"]);
    const doc = clone(fixtureDoc());
    expect(openApiProblems(doc)).toEqual([]);
    // Positive control: the old name for a route with no key is not a level any key or guard knows.
    const spec = doc.paths["/v1/openapi.json"]?.get as unknown as Record<string, unknown>;
    spec["x-akou-access"] = "none";
    expect(openApiProblems(doc)).toEqual(['GET /v1/openapi.json: x-akou-access "none"']);
  });

  test("an operation is tagged `openai` exactly when it is a compatibility route", () => {
    const broken = (mutate: (op: Record<string, unknown>) => void) => {
      const d = clone(fixtureDoc());
      mutate(d.paths["/v1/audio/transcriptions"]?.post as unknown as Record<string, unknown>);
      return openApiProblems(d);
    };
    expect(broken(() => {})).toEqual([]);
    // Positive controls, both ways: the OpenAI route that forgets its door would enter the jobs
    // view, and a compatibility route under another tag would hide an ordinary operation.
    expect(broken((op) => delete op["x-akou-door"])).toEqual([
      "POST /v1/audio/transcriptions: tag openai without x-akou-door: compat",
    ]);
    expect(
      broken((op) => {
        op.operationId = "jobs.transcribe";
        op.tags = ["jobs"];
      }),
    ).toEqual(["POST /v1/audio/transcriptions: x-akou-door: compat on tag jobs, not openai"]);
  });

  test("the generator gives a route whose id is not <tag>.<verb> no tag, so the rules catch it", () => {
    const doc = buildOpenApi(
      [
        {
          method: "GET",
          path: "/x",
          doc: { ...(FIXTURE_ROUTES[3] as RouteEntry).doc, id: "whoami" },
        },
      ],
      { version: APP_VERSION },
    );
    expect(openApiProblems(doc)).toEqual([
      "GET /v1/x: 0 tags, not one",
      'GET /v1/x: operationId "whoami" is not <tag>.<verb>',
    ]);
  });
});

describe("[SI-2] the served copy, GET /v1/openapi.json", () => {
  test("with no Authorization header it answers 200; every other route still wants the token", async () => {
    const { server, get } = await serve();
    try {
      const r = await get("/openapi.json");
      expect(r.status).toBe(200);
      expect(r.body.openapi).toBe("3.1.0");
      expect(openApiProblems(r.body)).toEqual([]);
      expect((await get("/status")).status).toBe(401);
      expect((await get("/config")).status).toBe(401);
      // The browser and Host checks still apply to the file.
      expect((await get("/openapi.json", { origin: "https://evil.example" })).status).toBe(403);
    } finally {
      await server.stop();
    }
  });

  test("positive control: a guard that ignores the route's `access: none` refuses the file with 401", async () => {
    const strict: Guard = (req, ctx) => guard(req, { ...ctx, route: { access: "admin" } });
    const { server, get } = await serve({ guard: strict });
    try {
      expect((await get("/openapi.json")).status).toBe(401);
      const ok = await get("/openapi.json", { authorization: `Bearer ${TOKEN}` });
      expect(ok.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test("servers[0] is the request's host, or server.public_host when it is set", async () => {
    const plain = await serve();
    try {
      const r = await plain.get("/openapi.json");
      expect(r.body.servers).toEqual([{ url: `http://127.0.0.1:${plain.server.port}` }]);
    } finally {
      await plain.server.stop();
    }
    const named = await serve({ settings: { "server.public_host": "akou.example" } });
    try {
      const r = await named.get("/openapi.json");
      expect(r.body.servers).toEqual([{ url: "https://akou.example" }]);
    } finally {
      await named.server.stop();
    }
    const withScheme = await serve({ settings: { "server.public_host": "http://akou.lan:8476/" } });
    try {
      expect((await withScheme.get("/openapi.json")).body.servers).toEqual([
        { url: "http://akou.lan:8476" },
      ]);
    } finally {
      await withScheme.server.stop();
    }
  });

  test("with no server.public_host, a Host that is not loopback came through the TLS proxy: https", () => {
    // SV-D2: server mode binds a non-loopback address only behind a proxy that terminates TLS, so
    // the plain `http:` akou itself sees is not what a client must use.
    const at = (host: string) =>
      serverUrlFor("", new Request(`http://${host}/v1/openapi.json`, { headers: { host } }));
    expect(at("akou.example")).toBe("https://akou.example");
    expect(at("akou.lan:8443")).toBe("https://akou.lan:8443");
    // Positive controls: loopback is akou itself, over plain HTTP.
    expect(at("127.0.0.1:8476")).toBe("http://127.0.0.1:8476");
    expect(at("localhost:8476")).toBe("http://localhost:8476");
    expect(at("[::1]:8476")).toBe("http://[::1]:8476");
  });

  test("in app mode the served copy has the call routes; in server mode it has no /calls route", async () => {
    const app = await serve({ mode: "app", fixtures: true });
    try {
      const doc = (await app.get("/openapi.json")).body;
      expect(doc.paths["/v1/calls"]).toBeDefined();
      expect(doc.paths["/v1/events"]).toBeUndefined();
    } finally {
      await app.server.stop();
    }
    const srv = await serve({ mode: "server", fixtures: true });
    try {
      const doc = (await srv.get("/openapi.json")).body;
      expect(Object.keys(doc.paths).filter((p) => p.startsWith("/v1/calls"))).toEqual([]);
      expect(doc.paths["/v1/jobs"]?.post?.operationId).toBe("jobs.create");
      expect(doc.paths["/v1/config"]).toBeDefined();
      for (const { op } of operations(doc)) expect(op["x-akou-modes"]).toContain("server");
      // Tags follow the operations kept: no `calls` tag with no call route.
      expect(doc.tags.map((t) => t.name)).not.toContain("calls");
    } finally {
      await srv.server.stop();
    }
  });

  test("?scope=jobs has no admin operation, no openai operation and not the file itself", async () => {
    const { server, get } = await serve({ mode: "server", fixtures: true });
    try {
      const doc = (await get("/openapi.json?scope=jobs")).body;
      const ids = operations(doc)
        .map((o) => o.op.operationId)
        .sort();
      expect(ids).toEqual(["events.list", "jobs.create", "jobs.get", "keys.me"]);
      for (const { op } of operations(doc)) expect(op["x-akou-access"]).not.toBe("admin");
      expect(openApiProblems(doc)).toEqual([]);
      // Positive control: without the scope the same server lists admin and compat operations.
      const all = operations((await get("/openapi.json")).body).map((o) => o.op.operationId);
      expect(all).toContain("keys.create");
      expect(all).toContain("openai.transcribe");
      expect(all).toContain("config.update");
      expect((await get("/openapi.json?scope=admin")).status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  test("the view filter itself: mode and scope decide, and nothing else is dropped", () => {
    const full = buildOpenApi([...buildRouter().entries(), ...(FIXTURE_ROUTES as RouteEntry[])], {
      version: APP_VERSION,
    });
    const count = (d: OpenApiDoc) => operations(d).length;
    const app = servedOpenApi(full, { mode: "app", serverUrl: "http://x" });
    const server = servedOpenApi(full, { mode: "server", serverUrl: "http://x" });
    const both = operations(full).filter((o) => o.op["x-akou-modes"].length === 2).length;
    expect(count(app) + count(server)).toBe(count(full) + both);
    expect(full.servers).toEqual([{ url: "http://127.0.0.1:8476" }]);
  });
});

describe("[PG-A2] a route reads only the body and query it declares, so the file cannot miss them", () => {
  const call = (r: Router<ApiApp>, path: string, init: RequestInit = {}) => {
    const url = new URL(`http://127.0.0.1/v1${path}`);
    const m = r.match(init.method ?? "GET", url.pathname.slice(3));
    if ("status" in m) throw new Error(`no route ${path}`);
    return m.handler({
      req: new Request(url.href, init),
      url,
      params: m.params,
      app: stubApp(),
      by: "t",
    });
  };
  const base = { access: "admin", modes: ["app"], ok: 200 } as const;

  test("a declared query parameter is read with its range and default", async () => {
    const r = new Router<ApiApp>().add(
      "GET",
      "/n",
      {
        ...base,
        id: "n.get",
        doc: "n",
        query: { k: { type: "integer", min: 1, max: 5, default: 2, doc: "k" } },
      },
      (c) => json(200, { k: c.query.int("k") }),
    );
    expect(await (await call(r, "/n")).json()).toEqual({ k: 2 });
    expect(await (await call(r, "/n?k=4")).json()).toEqual({ k: 4 });
    await expect(async () => call(r, "/n?k=9")).toThrow("k must be a whole number from 1 to 5");
  });

  test("reading an undeclared query parameter or body is an error, not a silent read", async () => {
    const r = new Router<ApiApp>()
      .add("GET", "/q", { ...base, id: "q.get", doc: "q" }, (c) =>
        json(200, { v: c.query.raw("v") }),
      )
      .add("POST", "/b", { ...base, id: "b.post", doc: "b" }, async (c) =>
        json(200, await c.body()),
      );
    await expect(async () => call(r, "/q?v=1")).toThrow(
      'q.get reads the query parameter "v" it does not declare',
    );
    await expect(async () => call(r, "/b", { method: "POST", body: "{}" })).toThrow(
      "b.post reads a body it does not declare",
    );
  });

  test("a declared body refuses a field it does not list, and an open body takes any", async () => {
    const r = new Router<ApiApp>().add(
      "POST",
      "/b",
      { ...base, id: "b.post", doc: "b", body: { "name?": "string" } },
      async (c) => json(200, await c.body()),
    );
    expect((await call(r, "/b", { method: "POST", body: '{"name":"x"}' })).status).toBe(200);
    await expect(async () => call(r, "/b", { method: "POST", body: '{"other":1}' })).toThrow(
      'unknown field "other"',
    );
  });
});

describe("[SI-2] the Executor job's positive control", () => {
  test("only Executor's 401 on the file counts as the control refusing; any other failure fails the job", () => {
    expect(
      controlFailure({ ok: false, error: { message: "Failed to fetch spec: HTTP 401" } }),
    ).toBeNull();
    // Positive controls: a spec that was added, and a failure for any other reason.
    expect(controlFailure({ ok: true })).toBe("the control added a spec that demands a key");
    expect(controlFailure({ ok: false, error: { message: "slug already exists" } })).toBe(
      "the control failed, but not with HTTP 401: slug already exists",
    );
    expect(controlFailure({ ok: false })).toBe("the control failed, but not with HTTP 401: ?");
  });
});
