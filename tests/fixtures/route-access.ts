/**
 * The one table of who may call each operation of the OpenAPI file (docs/ux/SERVER.md SV-K3 and
 * SV-T5), keyed `METHOD /v1/path` as the file writes paths. `open` needs no key, `jobs` a key with
 * the `jobs` scope (or more), `admin` only an `admin` key or the app's token. Written by hand, never
 * read from the routes: `tests/scopes.test.ts` holds the file to it, and
 * `tests/server-access.e2e.test.ts` walks every row with real keys. Adding a route means adding its
 * row here.
 */

import type { Access } from "../../src/main/api/access.ts";

export const ACCESS: Readonly<Record<string, Access>> = {
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
