/**
 * The MCP tools' own behaviour beyond the tool table: the read-only mode, the job tools' new
 * arguments (`format`, `title`, `task`, `keywords`, paging, delete), the `call` the enhanced
 * notes are saved to, a server target listing no prompt, and three answers that once broke on an
 * empty or partial body (an empty transcript page, a config with no settings, a vocabulary
 * proposal that failed half way). Each test was seen failing once against the code before it.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RequestOptions } from "../src/main/cli/client.ts";
import { fakeApi, mcpClient, sampleApi } from "./mcp-helpers.ts";

const WAV = join(import.meta.dir, "fixtures", "two-voices.wav");

interface Seen {
  method: string;
  path: string;
  o: RequestOptions;
}

/** A fake API that records every request and answers from `answer`. */
function recorder(
  answer: (method: string, path: string, o: RequestOptions) => unknown,
  text?: (method: string, path: string, o: RequestOptions) => string | null,
  status?: (method: string, path: string) => number,
) {
  const seen: Seen[] = [];
  const api = fakeApi(
    (method, path, o) => {
      // The provider check every server makes once at the start is not the tool's request.
      if (path !== "/status") seen.push({ method, path, o });
      return answer(method, path, o);
    },
    text,
    status,
  );
  return { api, seen };
}

describe("read-only mode lists only the tools that change nothing", () => {
  test("every listed tool is read-only, and a write tool cannot be called", async () => {
    const api = sampleApi();
    const ro = await mcpClient(api, "claude-code", undefined, { readOnly: true });
    const rw = await mcpClient(api);
    try {
      const listed = (await ro.client.listTools()).tools;
      expect(listed.length).toBeGreaterThan(5);
      expect(listed.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name)).toEqual(
        [],
      );
      const names = listed.map((t) => t.name);
      expect(names).toContain("akou_read");
      expect(names).toContain("akou_context");
      // Positive control: the same server without the mode lists the writes.
      const all = (await rw.client.listTools()).tools.map((t) => t.name);
      expect(all).toContain("akou_forget");
      expect(all).toContain("akou_start");
      expect(names).not.toContain("akou_forget");
      // A write is not there to call, whatever the client sends.
      const r = await ro.call("akou_forget", { id: "r0001" }).catch((e: Error) => ({
        isError: true,
        text: e.message,
      }));
      expect(r.isError).toBe(true);
      // The instructions say so, so the agent does not promise a write it cannot do.
      expect(ro.client.getInstructions()).toContain("read-only");
    } finally {
      await ro.close();
      await rw.close();
    }
  });
});

describe("the job tools take what the server's API takes", () => {
  test("akou_job_get format text answers the transcript alone, and asks the API for text", async () => {
    const { api, seen } = recorder(
      (_m, path) =>
        path.endsWith("/result")
          ? { words: "json_only" }
          : { id: "job_1", status: "done", title: null, preset: "fast", model: "m" },
      (_m, path) => (path.endsWith("/result") ? "hello from the file" : null),
    );
    const c = await mcpClient(api);
    try {
      const r = await c.call("akou_job_get", { id: "job_1", wait: 0, format: "text" });
      expect(r.isError).toBe(false);
      expect(r.structured.callText).toContain("hello from the file");
      expect(r.structured.callText).not.toContain("json_only");
      const result = seen.find((s) => s.path === "/jobs/job_1/result");
      expect(result?.o.query).toEqual({ format: "text" });
      // Positive control: the default stays JSON, with no format in the query.
      seen.length = 0;
      const json = await c.call("akou_job_get", { id: "job_1", wait: 0 });
      expect(json.structured.callText).toContain("json_only");
      expect(seen.find((s) => s.path === "/jobs/job_1/result")?.o.query).toEqual({});
    } finally {
      await c.close();
    }
  });

  test("akou_job_delete sends DELETE for that job and says what it was", async () => {
    const { api, seen } = recorder((m) =>
      m === "DELETE" ? { id: "job_7", status: "running", deleted: true } : {},
    );
    const c = await mcpClient(api);
    try {
      const r = await c.call("akou_job_delete", { id: "job_7" });
      expect(r.isError).toBe(false);
      expect(seen.map((s) => `${s.method} ${s.path}`)).toContain("DELETE /jobs/job_7");
      expect(r.structured).toEqual({ id: "job_7", status: "running", deleted: true });
    } finally {
      await c.close();
    }
  });

  test("akou_jobs_list passes the search, the page size and the cursor, and gives the cursor back", async () => {
    const { api, seen } = recorder((_m, path) =>
      path === "/jobs"
        ? {
            jobs: [{ id: "job_3", title: "standup", status: "done", extra: "dropped" }],
            cursor: 3,
          }
        : {},
    );
    const c = await mcpClient(api);
    try {
      const r = await c.call("akou_jobs_list", { q: "stand", limit: 5, cursor: 9 });
      expect(r.isError).toBe(false);
      expect(seen.find((s) => s.path === "/jobs")?.o.query).toMatchObject({
        q: "stand",
        limit: 5,
        cursor: 9,
      });
      expect(r.structured.cursor).toBe(3);
      expect(r.structured.jobs[0]).toEqual({
        id: "job_3",
        title: "standup",
        status: "done",
        preset: null,
        model: null,
        created_at: null,
        finished_at: null,
      });
      // The default page is small enough for an agent's context.
      seen.length = 0;
      await c.call("akou_jobs_list", {});
      expect(seen.find((s) => s.path === "/jobs")?.o.query).toMatchObject({ limit: 20 });
    } finally {
      await c.close();
    }
  });

  test("akou_transcribe sends the title, the task and each keyword as form fields", async () => {
    const { api, seen } = recorder(() => ({ id: "job_1", status: "queued" }));
    const c = await mcpClient(api);
    try {
      const r = await c.call("akou_transcribe", {
        path: WAV,
        wait: 0,
        title: "Board meeting",
        task: "translate",
        keywords: ["Hetzner", "akou"],
      });
      expect(r.isError).toBe(false);
      const form = seen.find((s) => s.method === "POST" && s.path === "/jobs")?.o.form as FormData;
      expect(form.get("title")).toBe("Board meeting");
      expect(form.get("task")).toBe("translate");
      expect(form.getAll("keywords[]")).toEqual(["Hetzner", "akou"]);
      // The server's own limits are checked before the upload: 24 keywords at most.
      seen.length = 0;
      const many = await c.call("akou_transcribe", {
        path: WAV,
        wait: 0,
        keywords: Array.from({ length: 25 }, (_, i) => `k${i}`),
      });
      expect(many.isError).toBe(true);
      expect(seen.filter((s) => s.path === "/jobs")).toEqual([]);
    } finally {
      await c.close();
    }
  });
});

describe("enhanced notes land on the call they were written for", () => {
  test("akou_enhanced_put with `call` saves to that call, never to whichever is latest", async () => {
    const { api, seen } = recorder((m, path) =>
      path === "/calls/last" ? { id: "c_newer" } : m === "PUT" ? { ok: true } : {},
    );
    const c = await mcpClient(api);
    try {
      const r = await c.call("akou_enhanced_put", {
        call: "c_older",
        markdown: "- shipped [#l000001]",
        coversSeq: 4,
      });
      expect(r.isError).toBe(false);
      expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["PUT /calls/c_older/enhanced"]);
      expect(r.structured.call).toBe("c_older");
      // Positive control: without `call` it still saves to the latest, as before.
      seen.length = 0;
      await c.call("akou_enhanced_put", { markdown: "- x [#l000001]", coversSeq: 4 });
      expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
        "GET /calls/last",
        "PUT /calls/c_newer/enhanced",
      ]);
    } finally {
      await c.close();
    }
  });

  test("akou_enhance_context reads the call it is given", async () => {
    const { api, seen } = recorder(() => ({ call: "c_older", input: "a\nb", coversSeq: 1 }));
    const c = await mcpClient(api);
    try {
      await c.call("akou_enhance_context", { call: "c_older" });
      expect(seen.map((s) => s.path)).toContain("/calls/c_older/enhance/context");
    } finally {
      await c.close();
    }
  });
});

describe("a server target lists no prompt", () => {
  test("prompts/list is empty against a server, and holds the call prompts against an app", async () => {
    const api = sampleApi();
    const server = await mcpClient(api, "claude-code", "server");
    const app = await mcpClient(api, "claude-code", "app");
    try {
      const caps = server.client.getServerCapabilities();
      const listed = caps?.prompts ? (await server.client.listPrompts()).prompts : [];
      expect(listed.map((p) => p.name)).toEqual([]);
      // Positive control: an app serves prompts.
      expect(app.client.getServerCapabilities()?.prompts).toBeDefined();
    } finally {
      await server.close();
      await app.close();
    }
  });
});

describe("answers that once broke on an empty or partial body", () => {
  test("akou_get_call on an empty page answers a page with no cursor, not a crash", async () => {
    const { api } = recorder(() => ({
      call: "c1",
      state: "live",
      lines: [],
      total: 0,
      offset: 0,
      nextOffset: 0,
    }));
    const c = await mcpClient(api);
    try {
      const r = await c.call("akou_get_call", { call: "c1" });
      expect(r.isError).toBe(false);
      expect(r.structured.nextCursor).toBeNull();
    } finally {
      await c.close();
    }
  });

  test("akou_config_get with no settings in the answer lists none, not a crash", async () => {
    const { api } = recorder(() => ({ file: "/x/config.toml" }));
    const c = await mcpClient(api);
    try {
      const r = await c.call("akou_config_get", {});
      expect(r.isError).toBe(false);
      expect(r.structured.settings).toEqual({});
    } finally {
      await c.close();
    }
  });

  test("akou_vocab_propose that fails half way says which terms went in and which were not sent", async () => {
    let n = 0;
    const { api } = recorder(
      (m, path) =>
        m === "POST" && path === "/vocab" ? (n++ === 1 ? { error: "bad_term" } : { ok: true }) : {},
      undefined,
      (m, path) => (m === "POST" && path === "/vocab" ? (n === 2 ? 422 : 201) : 200),
    );
    const c = await mcpClient(api);
    try {
      const r = await c.call("akou_vocab_propose", {
        entries: [{ term: "Hetzner" }, { term: "bad" }, { term: "Kasm" }],
      });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Proposed before it: Hetzner");
      expect(r.text).toContain("Not sent: Kasm");
    } finally {
      await c.close();
    }
  });
});
