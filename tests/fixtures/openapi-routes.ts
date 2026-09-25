/**
 * A route table shaped like the server-mode routes of docs/ux/SERVER.md (jobs, events, keys and
 * the OpenAI endpoint), for the tests of the OpenAPI generation and the Executor round trip while
 * those routes are not built. Each route answers 501; only its `RouteDoc` matters here.
 */

import { json, type RouteDoc, type Router } from "../../src/main/api/http.ts";
import type { ApiApp } from "../../src/main/api/server.ts";

export const FIXTURE_ROUTES: { method: string; path: string; doc: RouteDoc }[] = [
  {
    method: "POST",
    path: "/jobs",
    doc: {
      id: "jobs.create",
      doc: "Submit an audio file for transcription. Answers at once with a job id.",
      access: "jobs",
      modes: ["app", "server"],
      body: { multipart: { file: "file", "preset?": "string", "keywords[]?": "string[]" } },
      ok: 202,
    },
  },
  {
    method: "GET",
    path: "/jobs/:id",
    doc: {
      id: "jobs.get",
      doc: "One job and its state. `wait` holds the request until the job ends, up to 60 s.",
      access: "jobs",
      modes: ["app", "server"],
      params: { id: "The job id." },
      query: { wait: { type: "integer", min: 0, max: 60, default: 0, doc: "Seconds to wait." } },
      ok: 200,
    },
  },
  {
    method: "GET",
    path: "/events",
    doc: {
      id: "events.list",
      doc: "The key's job outcomes after a cursor, oldest first.",
      access: "jobs",
      modes: ["server"],
      ok: 200,
    },
  },
  {
    method: "GET",
    path: "/keys/me",
    doc: {
      id: "keys.me",
      doc: "The calling key: its id, name and scopes.",
      access: "jobs",
      modes: ["app", "server"],
      ok: 200,
    },
  },
  {
    method: "POST",
    path: "/keys",
    doc: {
      id: "keys.create",
      doc: "Create a key for a program.",
      access: "admin",
      modes: ["server"],
      body: { name: "string" },
      ok: 201,
    },
  },
  {
    method: "POST",
    path: "/audio/transcriptions",
    doc: {
      id: "openai.transcribe",
      doc: "The OpenAI transcription endpoint: a file in, its transcript out.",
      access: "jobs",
      modes: ["server"],
      door: "compat",
      body: { multipart: { file: "file", "model?": "string" } },
      ok: 200,
    },
  },
];

/** Adds the fixture routes to a table, each answering 501. */
export function addFixtureRoutes(r: Router<ApiApp>): Router<ApiApp> {
  for (const f of FIXTURE_ROUTES) {
    r.add(f.method, f.path, f.doc, () =>
      json(501, { error: "not_built", message: `${f.doc.id} is a test fixture` }),
    );
  }
  return r;
}
