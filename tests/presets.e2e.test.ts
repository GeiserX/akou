/**
 * Ask presets as files (docs/ux/PROGRAMMABILITY.md PG-F2), the MCP prompts made from them (PG-M7)
 * and progress while a long MCP call runs (PG-M6). The parser and the shipped files, then a
 * headless app with two saved calls: a file dropped in the folder reaches `GET /presets`,
 * `akou presets list`, `akou ask --preset` and `prompts/list` without a restart, and a preset that
 * asks about "all my calls" is still answered from the one call it was asked of.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { ApiClient } from "../src/main/cli/client.ts";
import { createMcpServer } from "../src/main/mcp/server.ts";
import { fillPreset, listPresets, parsePreset, usesSpeaker } from "../src/main/notes/presets.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { LogBuilder, T0, tempDir } from "./helpers.ts";
import { fakeApi, mcpClient } from "./mcp-helpers.ts";

const A = "01J8Z6Q4M2VX0K7B3D4E5PRESTA";
const B = "01J8Z6Q4M2VX0K7B3D4E5PRESTB";

/** A saved call, written under the recordings root before the app starts. */
function seedSaved(home: string, id: string, title: string, day: string): void {
  const b = new LogBuilder();
  b.created({ id, title });
  b.partStarted(1, T0);
  b.seg({
    id: "l000001",
    ch: "call",
    spk: "c2",
    w0: T0 + 1000,
    text: `the budget moves to ${day}`,
  });
  b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
  b.partEnded(1, "stop", 2);
  b.add({ type: "call.ended", reason: "stop" });
  const dir = join(home, "Recordings", "akou", "work", `2026-09-23_15361${day.length}_${day}`);
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    `${b.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

describe("[PG-F2] the preset files", () => {
  test("the shipped files are the five presets the ask box had, word for word", () => {
    const empty = tempDir();
    try {
      const all = listPresets(empty.dir);
      expect(all.map((p) => p.name)).toEqual([
        "catch-up",
        "my-name",
        "decisions",
        "action-items",
        "speaker",
      ]);
      expect(all.every((p) => p.bundled)).toBe(true);
      const menu = all.map((p) => ({
        label: fillPreset(p.label, { speaker: "Ben" }),
        question: fillPreset(p.question, { speaker: "Ben" }),
      }));
      expect(menu).toEqual([
        { label: "Catch me up", question: "Catch me up: what has been said so far?" },
        { label: "Was my name mentioned?", question: "Was my name mentioned? By whom and when?" },
        { label: "Decisions so far", question: "What decisions have been made so far?" },
        { label: "Action items", question: "What are the action items so far, with owners?" },
        { label: "What did Ben say?", question: "What did Ben say so far?" },
      ]);
      expect(all.map(usesSpeaker)).toEqual([false, false, false, false, true]);
    } finally {
      empty.cleanup();
    }
  });

  test("a user's file adds a preset or replaces a shipped one; order sorts, then the name", () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, "presets"));
      writeFileSync(
        join(t.dir, "presets", "risks.md"),
        "---\nlabel: Risks\norder: 15\n---\nRisks?\n",
      );
      writeFileSync(join(t.dir, "presets", "decisions.md"), "---\nlabel: Decided\n---\nDecided?\n");
      writeFileSync(join(t.dir, "presets", "zz.md"), "No frontmatter, {user}?\n");
      const all = listPresets(t.dir);
      expect(all.map((p) => [p.name, p.label, p.bundled])).toEqual([
        ["catch-up", "Catch me up", true],
        ["risks", "Risks", false],
        ["my-name", "Was my name mentioned?", true],
        ["action-items", "Action items", true],
        ["speaker", "What did {speaker} say?", true],
        ["decisions", "Decided", false],
        ["zz", "zz", false],
      ]);
      expect(
        fillPreset("{user} on {title} with {speaker}, {other}", { user: "Ana", title: "Sync" }),
      ).toBe("Ana on Sync with {speaker}, {other}");
    } finally {
      t.cleanup();
    }
  });

  test("a file that is not a preset is refused, and the others still load", () => {
    expect(() => parsePreset("---\nlabel: x\n---\n", "/p/empty.md")).toThrow("no question");
    expect(() => parsePreset("---\norder: soon\n---\nQ?", "/p/a.md")).toThrow("not a number");
    expect(() => parsePreset("Q?", "/p/Bad Name.md")).toThrow("not a preset name");
    expect(() => parsePreset("---\nlabel: x\nQ?", "/p/open.md")).toThrow("no closing");
    const t = tempDir();
    const errors: string[] = [];
    try {
      mkdirSync(join(t.dir, "presets"));
      writeFileSync(join(t.dir, "presets", "empty.md"), "---\nlabel: x\n---\n");
      expect(listPresets(t.dir, { onError: (m) => errors.push(m) })).toHaveLength(5);
      expect(errors).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });
});

let rig: AppRig;
let run: ReturnType<typeof rigCli>;
let home: { dir: string; cleanup: () => void };
const userDir = () => join(rig.app.configDir, "presets");

beforeAll(async () => {
  home = tempDir("akou-app-");
  seedSaved(home.dir, A, "Weekly sync", "friday");
  seedSaved(home.dir, B, "Budget review", "monday");
  rig = await appRig({ home: home.dir });
  run = rigCli(rig);
});

afterAll(async () => {
  await rig?.close();
  home?.cleanup();
});

describe("[PG-F2] a dropped file reaches every door without a restart", () => {
  test("GET /presets lists it at once; with a call, the fields are filled in for that call", async () => {
    const before = await rig.api("GET", "/presets");
    expect(before.body.presets.map((p: { name: string }) => p.name)).not.toContain("risks");
    mkdirSync(userDir(), { recursive: true });
    writeFileSync(
      join(userDir(), "risks.md"),
      "---\nlabel: Risks for {user}\norder: 35\n---\nWhat risks came up in {title}?\n",
    );
    try {
      // The route reads the folder on every request; a loaded or scanned disk may show a file
      // just written a moment late, so it is polled, with a bound, never slept on.
      let raw: Awaited<ReturnType<typeof rig.api>> | undefined;
      await until(
        async () => {
          raw = await rig.api("GET", "/presets");
          return raw.body.presets.some((p: { name: string }) => p.name === "risks");
        },
        5000,
        "the dropped file listed",
      );
      expect(raw?.body.presets.find((p: { name: string }) => p.name === "risks")).toEqual({
        name: "risks",
        label: "Risks for {user}",
        order: 35,
        question: "What risks came up in {title}?",
        usesSpeaker: false,
        bundled: false,
      });
      const filled = await rig.api("GET", `/presets?call=${A}`);
      expect(filled.body.call).toBe(A);
      expect(
        filled.body.presets.map((p: { label: string; question: string }) => [p.label, p.question]),
      ).toEqual([
        ["Catch me up", "Catch me up: what has been said so far?"],
        ["Was my name mentioned?", "Was my name mentioned? By whom and when?"],
        ["Decisions so far", "What decisions have been made so far?"],
        ["Risks for Ana", "What risks came up in Weekly sync?"],
        ["Action items", "What are the action items so far, with owners?"],
        ["What did Ben say?", "What did Ben say so far?"],
      ]);
      const named = await rig.api("GET", `/presets?call=${A}&speaker=Cleo`);
      expect(named.body.presets.at(-1)).toMatchObject({
        name: "speaker",
        speaker: "Cleo",
        question: "What did Cleo say so far?",
      });
      const list = await run(["presets", "list"]);
      expect(list.code).toBe(0);
      expect(list.out).toContain("risks  Risks for {user}  (yours)");
      expect(list.out).toContain("speaker  What did {speaker} say?\n");
    } finally {
      rmSync(join(userDir(), "risks.md"));
    }
    await until(
      async () =>
        !(await rig.api("GET", "/presets")).body.presets.some(
          (p: { name: string }) => p.name === "risks",
        ),
      5000,
      "the removed file gone from the list",
    );
  });

  test("akou ask --preset asks the file's question of one call, even one about all my calls", async () => {
    mkdirSync(userDir(), { recursive: true });
    writeFileSync(
      join(userDir(), "everything.md"),
      "---\nlabel: Across my calls\n---\nWhat did we decide about the budget across all my calls?\n",
    );
    try {
      const r = await run(["ask", "--preset", "everything", "-c", A, "--json"]);
      // No provider here: the excerpts answer, and they come from call A alone.
      expect(r.json).toMatchObject({ answered: false, kind: "excerpts" });
      expect(r.json.text).toContain("friday");
      expect(r.json.text).not.toContain("monday");
      expect(r.json.context).not.toContain("monday");
      const asks = async (id: string) =>
        (
          (await rig.api("GET", `/calls/${id}/events`)).body.events as {
            type: string;
            q?: string;
          }[]
        )
          .filter((e) => e.type === "ask")
          .map((e) => e.q);
      expect(await asks(A)).toEqual(["What did we decide about the budget across all my calls?"]);
      expect(await asks(B)).toEqual([]);
    } finally {
      rmSync(join(userDir(), "everything.md"));
    }
  });

  test("akou ask --preset: the speaker preset per speaker, and the usage errors", async () => {
    const one = await run(["ask", "--preset", "speaker", "--speaker", "Ben", "-c", B, "--json"]);
    expect(one.json.answered).toBe(false);
    // One named speaker: the preset needs no --speaker.
    expect((await run(["ask", "--preset", "speaker", "-c", B, "--json"])).json.answered).toBe(
      false,
    );
    expect((await run(["ask", "--preset", "nope", "-c", B])).code).toBe(64);
    expect((await run(["ask", "--preset", "decisions", "why?", "-c", B])).code).toBe(64);
    expect((await run(["ask", "--speaker", "Ben", "-c", B, "what?"])).code).toBe(64);
    expect((await run(["presets"])).code).toBe(64);
  });
});

describe("[PG-M7] the presets are MCP prompts", () => {
  const client = () =>
    mcpClient(new ApiClient({ env: { ...process.env, ...rig.env }, client: "mcp", launch: null }));

  test("prompts/list reads the folder on every call: one prompt per preset file", async () => {
    const c = await client();
    try {
      const first = (await c.client.listPrompts()).prompts;
      expect(first.map((p) => p.name)).toEqual([
        "catch-up",
        "my-name",
        "decisions",
        "action-items",
        "speaker",
      ]);
      const speaker = first.find((p) => p.name === "speaker");
      expect(speaker?.title).toBe("What did a speaker say?");
      expect(speaker?.arguments?.find((x) => x.name === "speaker")?.required).toBe(true);
      expect(first.find((p) => p.name === "decisions")?.arguments?.map((x) => x.name)).toEqual([
        "call",
      ]);
      mkdirSync(userDir(), { recursive: true });
      writeFileSync(join(userDir(), "risks.md"), "---\nlabel: Risks\n---\nWhat risks came up?\n");
      try {
        const next = (await c.client.listPrompts()).prompts.map((p) => p.name);
        expect(next).toEqual([...first.map((p) => p.name), "risks"]);
      } finally {
        rmSync(join(userDir(), "risks.md"));
      }
      expect((await c.client.listPrompts()).prompts).toHaveLength(5);
    } finally {
      await c.close();
    }
  });

  test("prompts/get fills a preset in for one call and names only that call", async () => {
    const c = await client();
    try {
      const got = await c.client.getPrompt({
        name: "speaker",
        arguments: { speaker: "Ben", call: A },
      });
      const text = String((got.messages[0]?.content as { text?: string } | undefined)?.text);
      expect(text).toStartWith("What did Ben say so far?");
      expect(text).toContain(`call akou_context with call "${A}"`);
      expect(text).not.toContain(B);
      expect(text.match(/01J8Z6Q4M2VX0K7B3D4E5PREST/g)).toHaveLength(2);
      await expect(c.client.getPrompt({ name: "nope", arguments: { call: A } })).rejects.toThrow(
        "no preset nope",
      );
    } finally {
      await c.close();
    }
  });
});

describe("[PG-M6] a long MCP call reports progress", () => {
  /** A client and server over a linked pair, with every message the client receives counted. */
  async function counted() {
    const api = fakeApi((_m, path) =>
      path.endsWith("/enhance")
        ? { markdown: "- Ship it [#l000001]", rev: 1, template: "general", model: "f", dropped: [] }
        : {},
    );
    const slow = {
      ...api,
      request: async (m: string, path: string, o: object) => {
        if (path.endsWith("/enhance")) await new Promise((r) => setTimeout(r, 5000));
        return api.request(m, path, o);
      },
    } as ApiClient;
    const server = createMcpServer({ client: slow });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(a);
    const progress: string[] = [];
    const orig = a.onmessage;
    a.onmessage = (msg, extra) => {
      const m = msg as { method?: string };
      if (m.method === "notifications/progress") progress.push(JSON.stringify(msg));
      orig?.(msg, extra);
    };
    return { client, progress };
  }

  test("with a progress token, an enhance that takes 5 s sends progress before its result", async () => {
    const { client, progress } = await counted();
    const seen: number[] = [];
    let atResult = -1;
    try {
      const r = await client.callTool(
        { name: "akou_enhance", arguments: {} },
        { onprogress: (p) => seen.push(p.progress), timeout: 20_000 },
      );
      atResult = seen.length;
      expect(r.isError).not.toBe(true);
    } finally {
      await client.close();
    }
    expect(atResult).toBeGreaterThanOrEqual(1);
    expect(progress.length).toBe(atResult);
    // Progress only grows.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1] as number);
  }, 20_000);

  test("positive control: without a progress token, nothing is sent", async () => {
    const { client, progress } = await counted();
    try {
      await client.callTool({ name: "akou_enhance", arguments: {} }, { timeout: 20_000 });
    } finally {
      await client.close();
    }
    expect(progress).toEqual([]);
  }, 20_000);
});
