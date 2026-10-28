import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EventDraft } from "../src/core/log/events.ts";
import { EVENTS_FILE } from "../src/core/log/writer.ts";
import { finalizeCall, JobWorker } from "../src/main/asr/finalize-worker.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { LogBuilder, T0, watchTerminations } from "./helpers.ts";

// A Bun Worker that is terminated, or that dies of an uncaught error, never runs the native
// finalizers: the models it held stay in the process until it exits. Every way a Worker holding
// models goes must have it free them first. The model set here is the fake one, with a `release`
// that leaves a file behind, so the host can see it ran (in the Worker, on another thread) and
// whether it ran before the terminate. `nativeLoad` wraps its recognizer load as sherpa's is.

const FAKE = join(import.meta.dir, "fixtures", "asr-fake.ts");
const GUARD = join(import.meta.dir, "..", "src", "main", "asr", "native-guard.ts");
let dir = "";
let spy = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "akou-retire-"));
  spy = join(dir, "spy-models.ts");
  writeFileSync(
    spy,
    `import { writeFileSync } from "node:fs";
import { createModels as fake } from ${JSON.stringify(FAKE)};
import { nativeLoad } from ${JSON.stringify(GUARD)};
export function createModels(options, model) {
  const m = fake(options, model);
  const release = m.release.bind(m);
  m.release = async () => {
    writeFileSync(options.marker, "released");
    await release();
  };
  const prepare = m.prepare.bind(m);
  m.prepare = (list) => nativeLoad(() => prepare(list));
  return m;
}
`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Every `terminate` of this test's Workers, with whether the model set had been released by then. */
let marker = "";
const watch = watchTerminations(() => existsSync(marker));
const { terminated } = watch;
beforeAll(watch.install);
afterAll(watch.restore);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  watch.reset();
});

function spec(name: string, options: Record<string, unknown> = {}) {
  marker = join(dir, `${name}.released`);
  return {
    kind: "module" as const,
    path: spy,
    model: "fake-parakeet",
    options: { marker, ...options },
  };
}

const clip = () => concat(silence(0.3), speak(["deploy", "today"]), silence(0.5));

/** Runs `body` in a plain `bun` child with `SPEC`, `terminated`, `clip`, `until` and `out`. */
async function child(
  s: ReturnType<typeof spec>,
  body: string,
): Promise<{ terminated?: { released: boolean }[]; text?: string }> {
  const script = join(dir, `${basename(s.options.marker)}.child.ts`);
  // File URLs, so a Windows path is a valid module specifier.
  const url = (path: string) => JSON.stringify(pathToFileURL(path).href);
  const src = (f: string) => url(join(import.meta.dir, "..", "src", "main", "asr", f));
  writeFileSync(
    script,
    `import { existsSync } from "node:fs";
import { JobWorker } from ${src("finalize-worker.ts")};
import { LiveAsr } from ${src("live-worker.ts")};
import { concat, silence, speak } from ${url(join(import.meta.dir, "fixtures", "asr-fake.ts"))};
const SPEC = ${JSON.stringify(s)};
const terminated = [];
const terminate = Worker.prototype.terminate;
Worker.prototype.terminate = function () {
  terminated.push({ released: existsSync(SPEC.options.marker) });
  return terminate.call(this);
};
const clip = () => concat(silence(0.3), speak(["deploy", "today"]), silence(0.5));
async function until(cond, ms) {
  const end = performance.now() + ms;
  while (!cond() && performance.now() < end) await Bun.sleep(10);
}
const out = {};
${body}
console.log(JSON.stringify(out));
process.exit(0);
`,
  );
  // A child that hangs (a job sent to a dead Worker never answers) is killed with its test.
  const p = Bun.spawn([process.execPath, script], {
    stdout: "pipe",
    stderr: "inherit",
    timeout: 15_000,
  });
  const text = await new Response(p.stdout).text();
  await p.exited;
  return JSON.parse(text.trim().split("\n").at(-1) ?? "{}");
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond() && performance.now() < end) await Bun.sleep(10);
}

describe("[#466] a test counts only the terminates of its own Workers", () => {
  test("a Worker made before the test and terminated during it is not counted; one made in it is", async () => {
    const blank = () => URL.createObjectURL(new Blob([""], { type: "application/javascript" }));
    const left = new Worker(blank());
    watch.reset();
    left.terminate();
    expect(terminated).toEqual([]);
    // Positive control: the same terminate of a Worker made after the reset is counted.
    const own = new Worker(blank());
    own.terminate();
    expect(terminated).toEqual([{ released: false }]);
  });
});

describe("a Worker that goes some other way still frees its models first", () => {
  test("a job Worker cancelled inside its model load frees what it loaded once the load returns", async () => {
    const w = new JobWorker(spec("cancel-in-load", { loadMs: 1500 }), undefined, 400);
    cleanups.push(() => w.cancel());
    const run = w.run({ samples: clip(), diarize: false, decode: null });
    await until(() => w.loading(), 3000);
    expect(w.loading()).toBe(true);
    w.cancel("the job was deleted");
    await expect(run).rejects.toThrow("the job was deleted");
    // Past `releaseMs` and still loading: never terminated there (#408), nor right after the load
    // with the model it just loaded.
    await Bun.sleep(600);
    expect(terminated).toHaveLength(0);
    await until(() => terminated.length > 0, 8000);
    expect(terminated).toEqual([{ released: true }]);
  }, 15_000);

  // Bun's test runner takes a Worker's uncaught errors for itself (the Worker's own
  // `uncaughtException` handler never runs there), so these two run in a plain `bun` child, as the
  // app does.
  test("a job Worker with an uncaught error fails its job and frees its models before it goes", async () => {
    const r = await child(
      spec("job-crash", { crashOnceFile: join(dir, "job-crashed"), slowMs: 300 }),
      `const w = new JobWorker(SPEC, undefined, 5000);
      // The crash comes after the decode answers, so the job may still end well; either way the
      // Worker goes, with its models freed.
      await w.run({ samples: clip(), diarize: false, decode: null }).catch(() => {});
      await until(() => terminated.length > 0, 8000);
      out.terminated = [...terminated];
      // The next job starts a fresh Worker.
      const r = await w.run({ samples: clip(), diarize: false, decode: null });
      out.text = r.segments.map((s) => s.text).join(" ");
      w.cancel();`,
    );
    expect(r.terminated).toEqual([{ released: true }]);
    expect(r.text).toBe("deploy today");
  }, 20_000);

  test("a live Worker with an uncaught error is replaced, and frees its models before it goes", async () => {
    const r = await child(
      spec("live-crash", { crashOnceFile: join(dir, "live-crashed") }),
      `const asr = new LiveAsr({ models: SPEC }, () => undefined);
      await asr.ready;
      await asr.decode(clip()).catch(() => {});
      await until(() => terminated.length > 0, 8000);
      out.terminated = [...terminated];
      // The replacement decodes as before.
      out.text = (await asr.decode(clip())).text;
      await asr.close();`,
    );
    expect(r.terminated).toEqual([{ released: true }]);
    expect(r.text).toBe("deploy today");
  }, 20_000);

  test("a final pass past its budget stops at its next piece and frees its models before it goes", async () => {
    const call = join(dir, "call");
    mkdirSync(call, { recursive: true });
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    b.partEnded(1, "stop", 12);
    b.add({ type: "call.ended", reason: "stop" });
    writeFileSync(join(call, EVENTS_FILE), b.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    const words = ["hello", "world", "deploy", "today", "new", "box"];
    const mic = concat(...words.flatMap((w) => [silence(1), speak([w])]), silence(1));
    const recorded: EventDraft[] = [];
    const out = await finalizeCall(
      {
        dir: call,
        record: (d) => {
          recorded.push(d);
          return null;
        },
        holdWriter: () => () => {},
      },
      {
        models: spec("final-timeout", { slowMs: 500 }),
        audio: {
          kind: "module",
          path: FAKE,
          options: { parts: { 1: { mic, call: silence(mic.length / 16_000) } } },
        },
        budgetMs: 1200,
      },
    );
    expect(out.ok).toBe(false);
    expect(recorded.filter((d) => d.type === "final.failed")).toMatchObject([{ step: "timeout" }]);
    await until(() => terminated.length > 0, 8000);
    expect(terminated).toEqual([{ released: true }]);
  }, 15_000);
});
