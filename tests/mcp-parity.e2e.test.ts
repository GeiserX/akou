/**
 * The doors catching up with each other (docs/ux/PROGRAMMABILITY.md): `POST /calls` and
 * `akou_start` no longer hand out an `akou://` link that opens nothing (PG-U1); a template can be
 * read before notes are written, over the API, the CLI and MCP, the user's own file winning
 * (PG-F3); and the MCP tools that match the CLI (PG-M4), against a headless app with the fake
 * helper, or a stand-in API where the real one would build the window or run the final pass.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOpenApi } from "../src/main/api/openapi.ts";
import { buildRouter } from "../src/main/api/server.ts";
import { ApiClient, type RequestOptions } from "../src/main/cli/client.ts";
import { BUNDLED_TEMPLATES_DIR } from "../src/main/notes/templates.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { fakeApi, mcpClient } from "./mcp-helpers.ts";

const LONG = 30_000;
const SECRET = "sk-test-not-a-real-key-0123456789";
const STANDUP = `---
name: standup
match: ["standup", "daily"]
---
## Each person
Done, next and blocked, one bullet each.
`;

let rig: AppRig;
let run: ReturnType<typeof rigCli>;

beforeAll(async () => {
  rig = await appRig({ settings: { "provider.apiKey": SECRET } });
  run = rigCli(rig);
});

afterAll(async () => {
  await rig?.close();
});

const mcp = () =>
  mcpClient(new ApiClient({ env: { ...process.env, ...rig.env }, client: "mcp", launch: null }));

async function stopAll(): Promise<void> {
  if ((await rig.api("GET", "/calls/live")).status === 200) {
    await rig.api("POST", "/calls/live/stop");
  }
}

describe("[PG-U1] no akou:// link from a start", () => {
  test(
    "POST /calls keeps the url key, null, and no field holds an akou:// value; attach too",
    async () => {
      await stopAll();
      const r = await rig.api("POST", "/calls", { workspace: "work", title: "Sync" });
      expect(r.status).toBe(201);
      expect(Object.hasOwn(r.body, "url")).toBe(true);
      expect(r.body.url).toBeNull();
      expect(r.text).not.toContain("akou://");
      const again = await rig.api("POST", "/calls", { attach: true });
      expect(again.status).toBe(200);
      expect(again.body.attached).toBe(true);
      expect(Object.hasOwn(again.body, "url")).toBe(true);
      expect(again.body.url).toBeNull();
      expect(again.text).not.toContain("akou://");
      await stopAll();
    },
    LONG,
  );

  test(
    "akou_start's text and structured result carry no akou:// value",
    async () => {
      await stopAll();
      const c = await mcp();
      try {
        const r = await c.call("akou_start", { workspace: "work", title: "Sync" });
        expect(r.isError).toBe(false);
        expect(r.text).not.toContain("akou://");
        expect(JSON.stringify(r.structured)).not.toContain("akou://");
        expect(r.structured.url).toBeNull();
      } finally {
        await c.close();
        await stopAll();
      }
    },
    LONG,
  );

  test("akou_start passes no akou:// link on, even from an app that still answers one", async () => {
    const old = fakeApi(() => ({ call: "c1", folder: "/rec/c1", part: 1, url: "akou://call/c1" }));
    const c = await mcpClient(old);
    try {
      const r = await c.call("akou_start", {});
      expect(r.text).not.toContain("akou://");
      expect(r.structured.url).toBeNull();
    } finally {
      await c.close();
    }
  });

  test("the OpenAPI file types url as a nullable string", () => {
    const doc = buildOpenApi(buildRouter().entries(), { version: "0.0.0" }) as {
      paths: Record<string, Record<string, { responses: Record<string, Json> }>>;
    };
    const start = doc.paths["/v1/calls"]?.post?.responses ?? {};
    for (const status of ["201", "200"]) {
      const schema = start[status]?.content?.["application/json"]?.schema;
      expect([status, schema?.properties?.url?.type]).toEqual([status, ["string", "null"]]);
      expect(schema?.required).toContain("url");
    }
  });
});

// biome-ignore lint/suspicious/noExplicitAny: OpenAPI objects are inspected field by field.
type Json = any;

describe("[PG-F3] a template can be read before notes are written", () => {
  const userDir = () => join(rig.app.configDir, "templates");

  test("GET /templates/:name answers the shipped file, then the user's own that replaces it", async () => {
    const shipped = readFileSync(join(BUNDLED_TEMPLATES_DIR, "standup.md"), "utf8");
    const before = await rig.api("GET", "/templates/standup");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ name: "standup", bundled: true, text: shipped });
    mkdirSync(userDir(), { recursive: true });
    writeFileSync(join(userDir(), "standup.md"), STANDUP);
    try {
      const after = await rig.api("GET", "/templates/standup");
      expect(after.body).toMatchObject({
        name: "standup",
        bundled: false,
        sections: ["Each person"],
        match: ["standup", "daily"],
        text: STANDUP,
        path: join(userDir(), "standup.md"),
      });
      const none = await rig.api("GET", "/templates/nope");
      expect([none.status, none.body.error]).toEqual([404, "not_found"]);
    } finally {
      writeFileSync(join(userDir(), "standup.md"), shipped);
    }
  });

  test("akou templates show standup prints the file the app would use, the user's override included", async () => {
    mkdirSync(userDir(), { recursive: true });
    writeFileSync(join(userDir(), "standup.md"), STANDUP);
    const show = await run(["templates", "show", "standup"]);
    expect([show.code, show.out]).toEqual([0, STANDUP.replace(/\n$/, "")]);
    const list = await run(["templates", "list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("standup  (yours)  match: standup, daily");
    expect(list.out).toContain("\ngeneral\n");
    expect((await run(["templates", "show", "nope"])).code).toBe(64);
    expect((await run(["templates"])).code).toBe(64);
    const c = await mcp();
    try {
      const r = await c.call("akou_template_get", { name: "standup" });
      expect(r.text).toBe(STANDUP);
      expect(r.structured).toEqual({
        name: "standup",
        bundled: false,
        sections: ["Each person"],
        text: STANDUP,
      });
      const listed = await c.call("akou_template_list");
      const names = listed.structured.templates.map((t: { name: string }) => t.name);
      expect(names).toEqual(["customer-call", "general", "interview", "one-on-one", "standup"]);
    } finally {
      await c.close();
    }
  });
});

describe("[PG-M4] MCP matches the CLI", () => {
  test(
    "akou_edit_note and akou_delete_note change the live call's notepad",
    async () => {
      await stopAll();
      await rig.startCall();
      const c = await mcp();
      try {
        const added = await rig.api("POST", "/calls/live/notes", { text: "ship on Friday" });
        const nid = added.body.note.id as string;
        const edit = await c.call("akou_edit_note", { id: nid, text: "ship on Thursday" });
        expect(edit.isError).toBe(false);
        expect(edit.structured).toEqual({ id: nid, rev: expect.any(Number) });
        const read = async () =>
          ((await rig.api("GET", "/calls/live/notes")).body.notes as { id: string; text: string }[])
            .filter((n) => n.id === nid)
            .map((n) => n.text);
        expect(await read()).toEqual(["ship on Thursday"]);
        const del = await c.call("akou_delete_note", { id: nid });
        expect([del.isError, del.structured]).toEqual([false, { id: nid }]);
        expect(await read()).toEqual([]);
      } finally {
        await c.close();
        await stopAll();
      }
    },
    LONG,
  );

  test("akou_config_get reads settings with secrets redacted, and nothing writes them", async () => {
    const c = await mcp();
    try {
      const all = await c.call("akou_config_get");
      expect(all.isError).toBe(false);
      expect(all.structured.settings["user.name"]).toBe("Ana");
      expect(all.structured.settings["provider.apiKey"]).toBe("(set)");
      expect(all.text).not.toContain(SECRET);
      const one = await c.call("akou_config_get", { key: "user.name" });
      expect(one.structured).toEqual({ key: "user.name", value: "Ana" });
      const bad = await c.call("akou_config_get", { key: "no.such" });
      expect(bad.isError).toBe(true);
      // Settings stay read-only over MCP (PROGRAMMABILITY.md section 1).
      const listed = (await c.client.listTools()).tools;
      expect(listed.map((t) => t.name).filter((n) => /config_(set|unset|patch)/.test(n))).toEqual(
        [],
      );
      // akou_share_on takes no bind: where a link listens is a setting, which no tool changes.
      const on = listed.find((t) => t.name === "akou_share_on");
      expect(Object.keys(on?.inputSchema.properties ?? {}).sort()).toEqual([
        "call",
        "expires",
        "notes",
      ]);
    } finally {
      await c.close();
    }
  });

  test("akou_share_status reads the app's links", async () => {
    const c = await mcp();
    try {
      const r = await c.call("akou_share_status");
      expect([r.isError, r.structured.active]).toEqual([false, false]);
    } finally {
      await c.close();
    }
  });

  test("each new tool sends the request its CLI command sends", async () => {
    const seen: string[] = [];
    const api = fakeApi((method: string, path: string, o: RequestOptions) => {
      seen.push(`${method} ${path} ${JSON.stringify(o.body ?? null)}`);
      if (path === "/calls") return { call: "c1", folder: "/rec/c1", part: 1, url: null };
      if (path.endsWith("/finalize")) return { call: "c1", model: "qwen" };
      return { ok: true };
    });
    const c = await mcpClient(api);
    try {
      await c.call("akou_start", { mic: "none", withoutModels: true });
      await c.call("akou_finalize", { force: true, model: "qwen" });
      await c.call("akou_share_on", { call: "last", notes: true, expires: "2h" });
      await c.call("akou_share_off", {});
      await c.call("akou_share_off", { call: "last" });
      await c.call("akou_open_window", { call: "last" });
      await c.call("akou_open_window", {});
    } finally {
      await c.close();
    }
    expect(seen.filter((s) => !s.startsWith("GET /status"))).toEqual([
      'POST /calls {"mic":"none","withoutModels":true,"attach":true}',
      'POST /calls/last/finalize {"force":true,"model":"qwen"}',
      'POST /share {"call":"last","notes":true,"expires":"2h"}',
      "DELETE /share null",
      'DELETE /share {"call":"last"}',
      'POST /window {"call":"last"}',
      "POST /window {}",
    ]);
  });
});
