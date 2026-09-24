/**
 * The hand-off and the import end to end (docs/DESIGN.md sections 6.1, 6.2 and 8.2): a headless app
 * with the fake helper, an export folder, two hooks and a webhook to a local receiver. A call ends;
 * the export, the hooks and the webhook follow on their own, each recorded in the log, and the app
 * answers while a slow hook runs. Then the CLI: export again, `--to`, `hooks run`, and
 * `import hark-viewer` followed by `context` over the imported call.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { rigCli } from "./cli-helpers.ts";
import { writeHarkViewerCall } from "./fixtures/hark-viewer.ts";
import { tempDir } from "./helpers.ts";

const LONG = 40_000;
const BUN = process.execPath;

let rig: AppRig;
let work: { dir: string; cleanup: () => void };
let receiver: ReturnType<typeof Bun.serve>;
const deliveries: { event: string | null; sig: string | null; body: string }[] = [];
let exportDir: string;
let hookOut: string;
let run: ReturnType<typeof rigCli>;

beforeAll(async () => {
  work = tempDir("akou-handoff-");
  exportDir = join(work.dir, "export");
  hookOut = join(work.dir, "hook-input.json");
  const scripts = join(work.dir, "scripts");
  mkdirSync(scripts);
  writeFileSync(
    join(scripts, "record.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      "const input = await Bun.stdin.text();",
      "writeFileSync(process.argv[2], JSON.stringify({ input: JSON.parse(input), stage: process.env.AKOU_STAGE }));",
    ].join("\n"),
  );
  writeFileSync(join(scripts, "slow.ts"), "await Bun.sleep(20_000);\n");
  receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      deliveries.push({
        event: req.headers.get("x-akou-event"),
        sig: req.headers.get("x-akou-signature"),
        body: await req.text(),
      });
      return new Response("ok");
    },
  });
  rig = await appRig({
    settings: {
      "export.dir": exportDir,
      "export.audio": "copy",
      hooks: [
        {
          stage: "call.ended",
          command: [BUN, join(scripts, "record.ts"), hookOut],
          name: "record",
        },
        {
          stage: "call.ended",
          command: [BUN, join(scripts, "slow.ts")],
          timeoutSec: 2,
          name: "slow",
        },
      ],
      "webhook.url": `http://127.0.0.1:${receiver.port}/in`,
      "webhook.secret": "s3cret",
    },
  });
  run = rigCli(rig);
});

afterAll(async () => {
  await rig?.close();
  receiver?.stop(true);
  work?.cleanup();
});

async function events(id: string): Promise<LogEvent[]> {
  return (await rig.api("GET", `/calls/${id}/events?after=0`)).body.events as LogEvent[];
}

describe("the hand-off after a call ends (DESIGN 8.2)", () => {
  let id: string;

  test(
    "export, hooks and a signed webhook follow the end on their own; the app keeps answering",
    async () => {
      id = await rig.startCall({ workspace: "work", title: "Handoff sync" });
      await Bun.sleep(300);
      expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
      // The export and the first hook are quick; the slow hook runs next.
      await until(() => existsSync(hookOut), 10_000, "the record hook to run");
      const t0 = performance.now();
      expect((await rig.api("GET", "/status")).status).toBe(200);
      expect(performance.now() - t0).toBeLessThan(1000);

      const got = JSON.parse(readFileSync(hookOut, "utf8"));
      expect(got.stage).toBe("call.ended");
      expect(got.input).toMatchObject({ version: 1, stage: "call.ended", call: { akou_id: id } });
      const md = got.input.paths.exportMd as string;
      expect(md.startsWith(join(exportDir, "work"))).toBe(true);
      expect(md).toEndWith(" Handoff sync.md");
      const text = readFileSync(md, "utf8");
      expect(text).toContain(`akou_id: ${id}`);
      expect(text).toContain("## Transcript");

      await until(
        async () => (await events(id)).some((e) => e.type === "webhook.done"),
        15_000,
        "webhook.done",
      );
      const log = await events(id);
      expect(log.filter((e) => e.type === "export.done")).toHaveLength(1);
      const hooks = log.filter((e) => e.type === "hook.done");
      expect(hooks.map((h) => [h.name, h.exit])).toEqual([
        ["record", 0],
        ["slow", 124],
      ]);
      const wh = log.find((e) => e.type === "webhook.done");
      expect(wh).toMatchObject({
        url: `http://127.0.0.1:${receiver.port}/…`,
        status: 200,
        attempts: 1,
      });
      const d = deliveries.find((x) => x.event === "call.ended");
      expect(d?.sig).toBe(
        `sha256=${createHmac("sha256", "s3cret")
          .update(d?.body ?? "")
          .digest("hex")}`,
      );
      expect(JSON.parse(d?.body ?? "{}").paths.exportMd).toBe(md);
      const folder = (await rig.api("GET", `/calls/${id}`)).body.folder as string;
      expect(readFileSync(join(folder, "logs", "hooks.log"), "utf8")).toContain("hook=slow");
    },
    LONG,
  );

  test(
    "export again: up to date; a note after the end re-exports on its own",
    async () => {
      const again = await rig.api("POST", `/calls/${id}/export`);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ written: false, rev: 1, call: id });
      expect(again.body).not.toHaveProperty("draft");
      expect(
        (await rig.api("POST", `/calls/${id}/notes`, { text: "follow up with finance" })).status,
      ).toBe(201);
      await until(
        () => readFileSync(again.body.path, "utf8").includes("follow up with finance"),
        10_000,
        "the re-export",
      );
      expect(readFileSync(again.body.path, "utf8")).toContain("akou_rev: 2");
    },
    LONG,
  );

  test(
    "the CLI: export --to a folder, hooks run, and a live call refused",
    async () => {
      const to = join(work.dir, "elsewhere");
      const exp = await run(["export", id, "--to", to, "--json"]);
      expect(exp.code).toBe(0);
      expect(exp.json.path.startsWith(join(to, "work"))).toBe(true);
      expect(existsSync(join(exp.json.attachments, "part-001.opus"))).toBe(true);

      const human = await run(["export", id, "--to", to]);
      expect(human.out).toStartWith("Already up to date: ");

      const hooks = await run(["hooks", "run", id, "--stage", "call.ended", "--json"]);
      expect(hooks.code).toBe(0);
      expect(hooks.json.runs.map((r: { name: string }) => r.name)).toEqual(["record", "slow"]);
      expect((await run(["hooks", "run", id, "--stage", "nope"])).code).toBe(64);

      const live = await rig.startCall({ workspace: "work", title: "Still going" });
      const r = await rig.api("POST", "/calls/live/export");
      expect([r.status, r.body.error]).toEqual([409, "not_ended"]);
      expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
      expect(live).toBeString();
    },
    LONG,
  );
});

describe("akou import hark-viewer (DESIGN 6.1)", () => {
  test(
    "a predecessor folder becomes a call that context answers over; importing it twice is refused",
    async () => {
      const src = writeHarkViewerCall(join(work.dir, "calls", "team"));
      const r = await run(["import", "hark-viewer", src, "--json"]);
      expect(r.code).toBe(0);
      expect(r.json.imported).toHaveLength(1);
      const call = r.json.imported[0];
      expect(call).toMatchObject({ parts: 2, segments: { live: 7, final: 5 }, speakers: 6 });

      const ctx = await run([
        "context",
        "who tests the codename zephyr",
        "--call",
        call.call,
        "--json",
      ]);
      expect(ctx.code).toBe(0);
      expect(ctx.json).toMatchObject({ call: call.call, state: "ENDED" });
      expect(ctx.json.pack).toContain("Zephyr");

      const human = await run(["import", "hark-viewer", src]);
      expect(human.code).toBe(64);
      expect(human.err).toContain("already imported");
    },
    LONG,
  );
});
