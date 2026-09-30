/**
 * Workspaces (docs/DESIGN.md section 4.1): a workspace is a folder under `recordings.root` that
 * holds its calls. `GET /workspaces` lists them, empty ones included; `POST /workspaces` makes the
 * folder of a new one, so it is there before its first call and after a restart.
 */

import { json, outcome, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";

export function workspaceRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/workspaces",
    {
      id: "workspaces.list",
      doc: "Every workspace, by name, with how many calls it holds: the folders under the recordings folder, empty ones included, and the workspace of every call.",
      access: "admin",
      modes: ["app"],
      ok: 200,
    },
    (c) => json(200, { workspaces: c.app.manager.workspaces() }),
  );

  r.add(
    "POST",
    "/workspaces",
    {
      id: "workspaces.add",
      doc: "Make a workspace's folder, so it exists before its first call. `name` is letters, digits, dot, dash or underscore. Answers `created: true` for a new folder and `created: false` for a workspace that exists already, under its folder's spelling, so adding one twice is safe.",
      access: "admin",
      modes: ["app"],
      body: { name: "string" },
      ok: 200,
    },
    async (c) => {
      const b = await c.body<{ name: string }>();
      const res = c.app.manager.addWorkspace(b.name.trim());
      return outcome(res);
    },
  );
}
