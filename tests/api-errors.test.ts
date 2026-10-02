/**
 * PG-A7 (docs/ux/PROGRAMMABILITY.md section 3): every route answers its refusals in one shape,
 * `{error: <code>, message, ...details}`, and the OpenAPI file lists every code.
 *
 * - The committed file: every documented refusal (a 4xx or 5xx response) is the one error shape
 *   and names its codes, each one listed in `components.schemas.ErrorCode`.
 * - The list is complete: every code the source answers is in `ERROR_CODES`, and every listed code
 *   is documented by some operation (or answered before routing).
 * - Each route declares the refusals its own handler throws.
 *
 * Every check has a positive control that breaks it.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPENAPI_FILE } from "../scripts/openapi.ts";
import { ERROR_CODES, errorsOf, UNROUTED_ERRORS } from "../src/main/api/errors.ts";
import type { RouteEntry } from "../src/main/api/http.ts";
import {
  buildOpenApi,
  errorProblems,
  type OpenApiDoc,
  operations,
  resolveResponse,
  sharedErrors,
} from "../src/main/api/openapi.ts";
import { buildRootRouter, buildRouter } from "../src/main/api/server.ts";
import { APP_VERSION } from "../src/main/app-info.ts";

const ROOT = join(import.meta.dir, "..");
const committed = (): OpenApiDoc => JSON.parse(readFileSync(OPENAPI_FILE, "utf8"));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

type Refusal = {
  content?: Record<
    string,
    { schema?: { allOf?: { properties?: { error?: { enum?: string[] } } }[] } }
  >;
};

/** The codes a documented refusal names. */
function codesOf(r: unknown): string[] {
  const parts = (r as Refusal | undefined)?.content?.["application/json"]?.schema?.allOf ?? [];
  return parts.flatMap((p) => p.properties?.error?.enum ?? []);
}

/** Every `status code` pair the file documents as a refusal. */
function documented(doc: OpenApiDoc): Set<string> {
  const out = new Set<string>();
  for (const { op } of operations(doc)) {
    for (const [status, r] of Object.entries(op.responses)) {
      if (!/^[45]\d\d$/.test(status)) continue;
      for (const c of codesOf(resolveResponse(doc, r))) out.add(`${status} ${c}`);
    }
  }
  return out;
}

describe("[PG-A7] every documented error response carries a documented error code", () => {
  test("the committed file: every 4xx and 5xx response is the one shape and names listed codes", () => {
    const doc = committed();
    expect(errorProblems(doc)).toEqual([]);
    // Not vacuous: the file documents refusals on every operation, hundreds in all.
    const ops = operations(doc);
    expect(ops.length).toBeGreaterThan(50);
    for (const { op } of ops) {
      expect(Object.keys(op.responses).some((s) => /^[45]\d\d$/.test(s))).toBe(true);
    }
    expect(documented(doc).size).toBeGreaterThan(30);
    const code = doc.components.schemas.ErrorCode as { oneOf: { const: string }[] };
    const listed = code.oneOf.map((o) => o.const);
    expect(listed).toEqual(Object.keys(ERROR_CODES));
  });

  test("positive controls: an unlisted code, a refusal with no code, or another shape is reported", () => {
    const broken = (mutate: (d: OpenApiDoc) => void) => {
      const d = clone(committed());
      mutate(d);
      return errorProblems(d);
    };
    const responses = (d: OpenApiDoc): Record<string, unknown> => {
      const get = d.paths["/v1/calls/{id}"]?.get as unknown as {
        responses: Record<string, unknown>;
      };
      return get.responses;
    };
    const refusal = (schema: unknown) => ({
      description: "Not found",
      content: { "application/json": { schema } },
    });
    const shape = { $ref: "#/components/schemas/Error" };
    const codes = (...c: string[]) => ({ properties: { error: { enum: c } } });
    expect(broken(() => {})).toEqual([]);
    // An inline refusal is checked as a shared one is.
    expect(
      broken((d) => {
        responses(d)["404"] = refusal({ allOf: [shape, codes("not_found")] });
      }),
    ).toEqual([]);
    expect(
      broken((d) => {
        responses(d)["404"] = refusal({ allOf: [shape, codes("not_found", "no_such_code")] });
      }),
    ).toEqual(['GET /v1/calls/{id} 404: error code "no_such_code" is not listed']);
    expect(
      broken((d) => {
        responses(d)["404"] = refusal({ allOf: [shape] });
      }),
    ).toEqual(["GET /v1/calls/{id} 404: names no error code"]);
    expect(
      broken((d) => {
        responses(d)["404"] = refusal({ type: "object", ...codes("not_found") });
      }),
    ).toEqual(["GET /v1/calls/{id} 404: not the one error shape"]);
    expect(
      broken((d) => {
        responses(d)["404"] = { $ref: "#/components/responses/nothing" };
      }),
    ).toEqual(['GET /v1/calls/{id} 404: "#/components/responses/nothing" is not in the file']);
    // A shared refusal with an unlisted code is reported on every operation that uses it.
    const shared = broken((d) => {
      const r = resolveResponse(d, responses(d)["404"] as Record<string, unknown>) as {
        content: Record<
          string,
          { schema: { allOf: { properties?: { error: { enum: string[] } } }[] } }
        >;
      };
      const json = r.content["application/json"] as (typeof r.content)[string];
      json.schema.allOf[1]?.properties?.error.enum.push("no_such_code");
    });
    expect(shared).toContain('GET /v1/calls/{id} 404: error code "no_such_code" is not listed');
    expect(shared.length).toBeGreaterThan(1);
    expect(
      broken((d) => {
        delete d.components.schemas.ErrorCode;
      }),
    ).toContain("components.schemas.ErrorCode lists no code");
  });

  test("every listed code is documented by some operation, or answered before any route matches", () => {
    const doc = committed();
    const used = new Set([...documented(doc)].map((k) => k.split(" ")[1]));
    for (const c of UNROUTED_ERRORS) used.add(c);
    expect(Object.keys(ERROR_CODES).filter((c) => !used.has(c))).toEqual([]);
    // Positive control: a code no route declares is caught.
    const extra = [...Object.keys(ERROR_CODES), "listed_but_unused"];
    expect(extra.filter((c) => !used.has(c))).toEqual(["listed_but_unused"]);
  });
});

// ---------------------------------------------------------------------------
// The source

/** The `.ts` files under a folder, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * The error codes a source text answers: the code of a refusal built with `HttpError`, `fail`,
 * the guard's `refuse` or `ModelRefused` (both sides of a `cond ? "a" : "b"` code), a `code:` or
 * `error:` field, or the fallback of `err.code ?? "x"`.
 */
export function codesIn(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /(?:new HttpError|new ModelRefused|\bfail|\brefuse)\(\s*[^,()]*?,\s*(?:[^,"]*\?\s*)?"([a-z_]+)"(?:\s*:\s*"([a-z_]+)")?/g,
    /\bcode:\s*"([a-z_]+)"/g,
    /\berror:\s*"([a-z_]+)"/g,
    /\.code\s*\?\?\s*"([a-z_]+)"/g,
    /new DecodeError\([^)]*"([a-z_]+)"\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      for (const c of m.slice(1)) if (c) out.add(c);
    }
  }
  return [...out].sort();
}

/**
 * The app's side of the API: everything under `src/main` but the window (its own page server and
 * in-process bridge), the CLI (a client) and the MCP server (another protocol).
 */
const API_SOURCES = () =>
  sources(join(ROOT, "src", "main")).filter(
    (p) => !/[\\/]src[\\/]main[\\/](window|cli|mcp)[\\/]/.test(p),
  );

describe("[PG-A7] the list holds every code the source answers", () => {
  test("every code in the app's source is in ERROR_CODES", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const p of API_SOURCES()) {
      for (const c of codesIn(readFileSync(p, "utf8"))) {
        seen++;
        if (!(c in ERROR_CODES)) missing.push(`${p.slice(ROOT.length + 1)}: ${c}`);
      }
    }
    expect(missing).toEqual([]);
    expect(seen).toBeGreaterThan(100);
  });

  test("positive control: the scan finds each kind of refusal, a new code among them", () => {
    const text = [
      'throw new HttpError(409, "brand_new_code", "x");',
      'return fail(404, "no_calls", "x");',
      'throw new HttpError(\n  missing ? 503 : 500,\n  missing ? "models_missing" : "transcription_failed",\n);',
      'return json(503, {\n  error: "provider_unavailable",\n});',
      '{ ok: false, code: "dictation_off", message: "x" }',
      'error: { code: e.code ?? "remote_refused", message }',
      'throw new ModelRefused(422, "unknown_model", "x");',
    ].join("\n");
    expect(codesIn(text)).toEqual([
      "brand_new_code",
      "dictation_off",
      "models_missing",
      "no_calls",
      "provider_unavailable",
      "remote_refused",
      "transcription_failed",
      "unknown_model",
    ]);
    expect(codesIn(text).filter((c) => !(c in ERROR_CODES))).toEqual(["brand_new_code"]);
  });
});

/**
 * Each `.add(` of a route file, with the route ids it adds (a loop's `` `calls.${name}` `` names
 * every id under `calls.` that the file does not add by name) and the refusals its handler builds
 * with a literal status.
 */
function routeChunks(text: string): { ids: (string | RegExp)[]; refusals: string[] }[] {
  const starts = [...text.matchAll(/\.add\(\s*"(?:GET|POST|PUT|PATCH|DELETE)"/g)].map(
    (m) => m.index as number,
  );
  const named = [...text.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1] as string);
  return starts.map((s, i) => {
    const chunk = text.slice(s, starts[i + 1] ?? text.length);
    const id = /\bid:\s*(?:"([^"]+)"|`([^`$]*)\$\{)/.exec(chunk);
    const prefix = id?.[2];
    const ids: (string | RegExp)[] = id?.[1]
      ? [id[1]]
      : prefix
        ? [
            new RegExp(
              `^(?!(?:${named.map((n) => n.replace(/\./g, "\\.")).join("|")})$)${prefix.replace(/\./g, "\\.")}`,
            ),
          ]
        : [];
    const refusals = new Set<string>();
    for (const m of chunk.matchAll(/new HttpError\(\s*(\d{3}),\s*"([a-z_]+)"/g)) {
      refusals.add(`${m[1]} ${m[2]}`);
    }
    for (const m of chunk.matchAll(/json\(\s*(\d{3}),\s*\{\s*error:\s*"([a-z_]+)"/g)) {
      refusals.add(`${m[1]} ${m[2]}`);
    }
    return { ids, refusals: [...refusals] };
  });
}

/** What a route's file documents: its own declared refusals and the shared ones, as `status code`. */
function declared(e: RouteEntry): Set<string> {
  const all = errorsOf(sharedErrors(e.method, e.doc), e.doc.errors);
  const out = new Set<string>();
  for (const [s, codes] of Object.entries(all)) for (const c of codes ?? []) out.add(`${s} ${c}`);
  return out;
}

/** The refusals a route file's handlers build that their routes do not declare. */
function undeclared(text: string, entries: RouteEntry[]): string[] {
  const out: string[] = [];
  for (const { ids, refusals } of routeChunks(text)) {
    const routes = entries.filter((e) =>
      ids.some((id) => (typeof id === "string" ? e.doc.id === id : id.test(e.doc.id))),
    );
    if (routes.length === 0) {
      out.push(`a route with no id the table knows (${ids.join(", ")})`);
      continue;
    }
    for (const r of routes) {
      const d = declared(r);
      for (const x of refusals) if (!d.has(x)) out.push(`${r.doc.id}: ${x}`);
    }
  }
  return out;
}

describe("[PG-A7] each route declares the refusals its handler builds", () => {
  const ROUTES = join(ROOT, "src", "main", "api", "routes");

  test("every literal refusal of a route file's handlers is in its route's documented codes", () => {
    const entries = [...buildRouter().entries(), ...buildRootRouter().entries()];
    const problems: string[] = [];
    let chunks = 0;
    for (const name of readdirSync(ROUTES)) {
      const text = readFileSync(join(ROUTES, name), "utf8");
      chunks += routeChunks(text).length;
      problems.push(...undeclared(text, entries).map((p) => `${name}: ${p}`));
    }
    expect(problems).toEqual([]);
    expect(chunks).toBeGreaterThan(60);
  });

  test("positive control: a route whose declared refusals lose one is reported", () => {
    const text = readFileSync(join(ROUTES, "jobs.ts"), "utf8");
    const entries = buildRouter().entries();
    expect(undeclared(text, entries)).toEqual([]);
    const without = entries.map((e) =>
      e.doc.id === "jobs.result" ? { ...e, doc: { ...e.doc, errors: { 404: ["not_found"] } } } : e,
    ) as RouteEntry[];
    expect(undeclared(text, without)).toEqual(["jobs.result: 409 not_done"]);
  });

  test("the file renders a route's declared and shared refusals by status", () => {
    const entries = buildRouter().entries();
    const doc = buildOpenApi(entries, { version: APP_VERSION });
    const result = doc.paths["/v1/jobs/{id}/result"]?.get?.responses ?? {};
    expect(Object.keys(result).sort()).toEqual([
      "200",
      "401",
      "403",
      "404",
      "409",
      "413",
      "500",
      "default",
    ]);
    const codes = (s: string) =>
      codesOf(resolveResponse(doc, result[s] as Record<string, unknown>));
    expect(codes("409")).toEqual(["not_done"]);
    expect(codes("401")).toEqual(["unauthorized"]);
    expect(codes("403")).toEqual(["bad_host", "browser_request", "forbidden"]);
    // A JSON body's parsing refusals come with the body, and an anonymous route has no 401.
    const rename = doc.paths["/v1/calls/{id}"]?.patch?.responses ?? {};
    expect(Object.keys(rename)).toContain("415");
    expect(JSON.stringify(rename["400"])).toContain("unknown_field");
    const spec = doc.paths["/v1/openapi.json"]?.get?.responses ?? {};
    expect(spec["401"]).toBeUndefined();
  });
});
