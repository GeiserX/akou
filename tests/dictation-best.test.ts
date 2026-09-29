/**
 * DC-E2 and DC-E4 on the `best` dictation engine: Qwen3-ASR on a llama-server kept warm, with its
 * exit to `fast`, over the fake llama-server of `fixtures/fake-llama-server.ts` (no model, no GPU)
 * and a manual clock for the idle stop and the timeout. The fast engine is a stub that says which
 * engine answered.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlamaEngineSpec } from "../src/main/asr/engine.ts";
import { QWEN_ASR, QWEN_MMPROJ_FILE, QWEN_MODEL_FILE } from "../src/main/asr/llama-catalog.ts";
import { LlamaServer, metalHolder } from "../src/main/asr/llama-server.ts";
import { BestEngine, type BestSettings } from "../src/main/dictation/best.ts";
import {
  dictationLanguages,
  forcesLanguage,
  GPU_BUSY_VERDICT,
  resolveDictationEngine,
} from "../src/main/dictation/engines.ts";
import type { DictationEngine } from "../src/main/dictation/session.ts";
import { ManualClock, until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const FAKE = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const HELLO = concat(silence(0.3), speak(["hello"]), silence(0.3));

const FAST: DictationEngine = {
  name: "fast",
  decode: async () => ({
    text: "from fast",
    words: [],
    language: null,
    model: "fake-parakeet",
    ms: 1,
    spans: 1,
  }),
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Rig {
  best: BestEngine;
  clock: ManualClock;
  /** Every start (`argv`) and request (`body`) the fake saw, across restarts. */
  log(): Record<string, unknown>[];
  starts(): number;
  requests(): { messages: { role: string; content: unknown }[] }[];
  logs: string[];
}

function rig(
  fake: string[] = [],
  o: {
    settings?: Partial<BestSettings>;
    fast?: DictationEngine | null;
    keepWarm?: () => boolean;
    accelerator?: LlamaEngineSpec["accelerator"];
    onLost?: () => void;
  } = {},
): Rig {
  const t = tempDir("akou-dict-best-");
  cleanups.push(t.cleanup);
  const logFile = join(t.dir, "fake.log");
  const clock = new ManualClock();
  const logs: string[] = [];
  const spec: LlamaEngineSpec = {
    kind: "llama-server",
    engine: QWEN_ASR,
    model: join(t.dir, QWEN_MODEL_FILE),
    mmproj: join(t.dir, QWEN_MMPROJ_FILE),
    accelerator: o.accelerator ?? "cpu",
    command: [process.execPath, FAKE, "--fake-log", logFile, ...fake],
  };
  const best = new BestEngine({
    spec: () => spec,
    fast: () => (o.fast === undefined ? FAST : o.fast),
    settings: () => ({ timeoutSeconds: 10, idleMinutes: 0, languages: [], ...o.settings }),
    ...(o.keepWarm ? { keepWarm: o.keepWarm } : {}),
    ...(o.onLost ? { onLost: o.onLost } : {}),
    clock,
    onLog: (level, msg) => logs.push(`${level} ${msg}`),
  });
  cleanups.push(() => best.stop());
  const log = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return {
    best,
    clock,
    log,
    logs,
    starts: () => log().filter((l) => l.argv).length,
    requests: () =>
      log()
        .filter((l) => l.body)
        .map((l) => l.body as { messages: { role: string; content: unknown }[] }),
  };
}

describe("DC-E2: best is kept warm", () => {
  test("the first dictation after warm waits for health; the second starts nothing", async () => {
    const r = rig(["--fake-loading-ms", "400"]);
    r.best.warm();
    await until(() => r.best.loading(), 5000, "the server to start loading");
    const first = await r.best.decode(HELLO);
    expect(first).toMatchObject({ text: "hello", engine: "best", model: QWEN_ASR });
    expect(first.fallback_from).toBeUndefined();
    expect(r.best.loading()).toBe(false);
    const second = await r.best.decode(HELLO);
    expect(second).toMatchObject({ text: "hello", engine: "best" });
    expect(r.starts()).toBe(1);
  });

  test("asr.qwenIdleMinutes 1: at 2 min the server is stopped, and the next dictation starts it", async () => {
    const r = rig([], { settings: { idleMinutes: 1 } });
    await r.best.decode(HELLO);
    const pid = r.best.pid() as number;
    expect(alive(pid)).toBe(true);
    await r.clock.advance(2 * 60_000);
    await until(() => !alive(pid), 10_000, "the idle server to exit");
    expect(r.best.pid()).toBeNull();
    expect((await r.best.decode(HELLO)).text).toBe("hello");
    expect(r.starts()).toBe(2);
  });

  test("positive control: with asr.qwenIdleMinutes 0 the server is still up at 2 min", async () => {
    const r = rig();
    await r.best.decode(HELLO);
    const pid = r.best.pid() as number;
    await r.clock.advance(2 * 60_000);
    expect(alive(pid)).toBe(true);
    await r.best.decode(HELLO);
    expect(r.starts()).toBe(1);
  });

  test("with dictation off (a clip over the API), the server stops after the dictation", async () => {
    const r = rig([], { keepWarm: () => false });
    await r.best.decode(HELLO);
    await until(() => r.best.pid() === null, 10_000, "the server to stop");
  });
});

describe("DC-E2: best falls back to fast", () => {
  test("a server that exits mid-request: the fast text, with fallback_from best", async () => {
    const r = rig(["--fake-die-on", "1"]);
    const d = await r.best.decode(HELLO);
    expect(d).toMatchObject({
      text: "from fast",
      engine: "fast",
      fallback_from: "best",
      notice: "best failed, used fast",
    });
    expect(r.requests().length).toBeGreaterThan(0);
  });

  test("a server that never answers: the same at the timeout, 10 s plus 0.2 s per audio second", async () => {
    const r = rig(["--fake-hang"]);
    let settled = false;
    const p = r.best.decode(HELLO).finally(() => {
      settled = true;
    });
    await until(() => r.requests().length > 0, 10_000, "the request to reach the server");
    const pid = r.best.pid() as number;
    // HELLO is about 1.1 s: its budget is about 10.2 s.
    await r.clock.advance(9_000);
    expect(settled).toBe(false);
    await r.clock.advance(2_000);
    expect(await p).toMatchObject({ text: "from fast", engine: "fast", fallback_from: "best" });
    // The stuck server is stopped, and nothing starts another behind the fallback.
    await until(() => !alive(pid), 10_000, "the stuck server to be stopped");
    await Bun.sleep(300);
    expect(r.starts()).toBe(1);
    expect(r.best.pid()).toBeNull();
  });

  test("the budget grows 0.2 s per audio second: a 20 s dictation still waits at 12 s", async () => {
    const r = rig(["--fake-hang"]);
    let settled = false;
    const long = concat(silence(0.3), speak(["hello"]), silence(18.6));
    const p = r.best.decode(long).finally(() => {
      settled = true;
    });
    await until(() => r.requests().length > 0, 10_000, "the request to reach the server");
    // About 20 s of audio: 10 s plus 4 s. Without the audio's share it would give up at 10 s.
    await r.clock.advance(12_000);
    expect(settled).toBe(false);
    await r.clock.advance(3_000);
    expect(await p).toMatchObject({ engine: "fast", fallback_from: "best" });
  });

  test("Qwen that cannot run here (its model or llama-server missing) falls back too", async () => {
    const none = new BestEngine({
      spec: () => null,
      fast: () => FAST,
      settings: () => ({ timeoutSeconds: 10, idleMinutes: 0, languages: [] }),
      clock: new ManualClock(),
    });
    expect(await none.decode(HELLO)).toMatchObject({ engine: "fast", fallback_from: "best" });
  });

  test("with no fast engine loaded, the failure is the dictation's error", async () => {
    const r = rig(["--fake-die-on", "1"], { fast: null });
    await expect(r.best.decode(HELLO)).rejects.toThrow(/unavailable/);
  });
});

describe("DC-E4: the dictation's language on best", () => {
  test("a forced tag reaches Qwen as its language prefix, and the answer says es", async () => {
    const r = rig();
    const d = await r.best.decode(HELLO, { language: "es" });
    expect(d.language).toBe("es");
    const forced = r.requests().filter((b) => b.messages.at(-1)?.role === "assistant");
    expect(forced.map((b) => b.messages.at(-1)?.content)).toEqual(["language Spanish<asr_text>"]);
  });

  test("auto within the dictation's languages: a Spanish answer among [en, es] stands", async () => {
    const r = rig(["--fake-lang", "Spanish"], { settings: { languages: ["en", "es"] } });
    const d = await r.best.decode(HELLO);
    expect(d.language).toBe("es");
    expect(r.requests().some((b) => b.messages.at(-1)?.role === "assistant")).toBe(false);
  });

  test("positive control: with [en] only, the Spanish answer is replaced by the forced English one", async () => {
    const r = rig(["--fake-lang", "Spanish"], { settings: { languages: ["en"] } });
    const d = await r.best.decode(HELLO);
    expect(d.language).toBe("en");
    expect(r.requests().at(-1)?.messages.at(-1)).toEqual({
      role: "assistant",
      content: "language English<asr_text>",
    });
  });
});

describe("one Metal engine at a time: dictation gives way", () => {
  test("a Metal start with yieldMetal fails while another Metal server runs, and stops nothing", async () => {
    const t = tempDir("akou-dict-metal-");
    cleanups.push(t.cleanup);
    const server = (yieldMetal: boolean) => {
      const s = new LlamaServer({
        command: [process.execPath, FAKE],
        model: join(t.dir, QWEN_MODEL_FILE),
        mmproj: join(t.dir, QWEN_MMPROJ_FILE),
        accelerator: "metal",
        // The fake needs no GPU; the argument list is all `metal` changes.
        gpuLayers: 0,
        yieldMetal,
      });
      cleanups.push(() => s.stop());
      return s;
    };
    const pass = server(false);
    await pass.url();
    const pid = pass.pid() as number;
    await expect(server(true).url()).rejects.toThrow(/another Metal llama-server/);
    expect(alive(pid)).toBe(true);
    // Positive control: without yieldMetal the running one is stopped for the new one.
    await server(false).url();
    await until(() => !alive(pid), 10_000, "the first Metal server to be stopped");
  });

  test("best on Metal while a final pass holds it: fast, with fallback_from best", async () => {
    const t = tempDir("akou-dict-metal-");
    cleanups.push(t.cleanup);
    const pass = new LlamaServer({
      command: [process.execPath, FAKE],
      model: join(t.dir, QWEN_MODEL_FILE),
      mmproj: join(t.dir, QWEN_MMPROJ_FILE),
      accelerator: "metal",
      gpuLayers: 0,
    });
    cleanups.push(() => pass.stop());
    await pass.url();
    const r = rig([], { accelerator: "metal" });
    expect(await r.best.decode(HELLO)).toMatchObject({ engine: "fast", fallback_from: "best" });
    expect(alive(pass.pid() as number)).toBe(true);
  });

  test("metalHolder names the Metal server beside dictation's own, and none once it ends", async () => {
    const t = tempDir("akou-dict-metal-");
    cleanups.push(t.cleanup);
    expect(metalHolder(t.dir, null)).toBeNull();
    const pass = new LlamaServer({
      command: [process.execPath, FAKE],
      model: join(t.dir, QWEN_MODEL_FILE),
      mmproj: join(t.dir, QWEN_MMPROJ_FILE),
      accelerator: "metal",
      gpuLayers: 0,
      lockDir: t.dir,
    });
    cleanups.push(() => pass.stop());
    await pass.url();
    const pid = pass.pid() as number;
    expect(metalHolder(t.dir, null)).toBe(pid);
    // Dictation's own server is never its own holder.
    expect(metalHolder(t.dir, pid)).toBeNull();
    await pass.stop();
    expect(metalHolder(t.dir, null)).toBeNull();
  });

  test("the pid file another thread wrote: a live llama-server on its port holds the GPU, a reused pid does not", async () => {
    const t = tempDir("akou-dict-metal-");
    cleanups.push(t.cleanup);
    // Another thread's final pass: a process of its own, known only through the pid file.
    const port = 47_311;
    const other = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000)", "--", "--port", String(port)],
      { stdout: "ignore", stderr: "ignore" },
    );
    cleanups.push(() => {
      other.kill();
    });
    const file = join(t.dir, "llama-metal.json");
    writeFileSync(file, JSON.stringify({ pid: other.pid, port }));
    // Windows keeps no pid file (one Metal server is a macOS rule).
    const named = process.platform === "win32" ? null : other.pid;
    expect(metalHolder(t.dir, null)).toBe(named);
    writeFileSync(file, JSON.stringify({ pid: other.pid, port: port + 1 }));
    expect(metalHolder(t.dir, null)).toBeNull();
    writeFileSync(file, JSON.stringify({ pid: other.pid, port }));
    other.kill();
    await other.exited;
    expect(metalHolder(t.dir, null)).toBeNull();
  });

  test("the pid file's holder, once ps confirmed it, stands without another ps for a while", async () => {
    const t = tempDir("akou-dict-metal-");
    cleanups.push(t.cleanup);
    const port = 47_313;
    const other = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000)", "--", "--port", String(port)],
      { stdout: "ignore", stderr: "ignore" },
    );
    const path = process.env.PATH;
    cleanups.push(() => {
      process.env.PATH = path;
      other.kill();
    });
    const file = join(t.dir, "llama-metal.json");
    writeFileSync(file, JSON.stringify({ pid: other.pid, port }));
    // Windows keeps no pid file (one Metal server is a macOS rule).
    const named = process.platform === "win32" ? null : other.pid;
    expect(metalHolder(t.dir, null)).toBe(named);
    // A ps that names nothing: only the earlier answer can name it now.
    const bin = join(t.dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = bin;
    expect(metalHolder(t.dir, null)).toBe(named);
    // Positive control: a port it was never confirmed on needs that ps, which names nothing.
    writeFileSync(file, JSON.stringify({ pid: other.pid, port: port + 1 }));
    expect(metalHolder(t.dir, null)).toBeNull();
    process.env.PATH = path;
    // And a holder that ended is none, whatever was confirmed.
    writeFileSync(file, JSON.stringify({ pid: other.pid, port }));
    other.kill();
    await other.exited;
    expect(metalHolder(t.dir, null)).toBeNull();
  });

  test("a warm server a final pass stops is reported lost; one best stops itself is not", async () => {
    let lost = 0;
    const r = rig([], { onLost: () => lost++ });
    await r.best.decode(HELLO);
    const pid = r.best.pid() as number;
    process.kill(pid, "SIGKILL");
    await until(() => lost === 1, 10_000, "the loss reported");
    // Started again by the next dictation, then stopped by best: no loss.
    await r.best.decode(HELLO);
    const again = r.best.pid() as number;
    await r.best.stop();
    await until(() => !alive(again), 10_000, "the server stopped");
    await Bun.sleep(100);
    expect(lost).toBe(1);
  });

  test("a server that dies while it loads is not reported lost, so nothing starts it in a loop", async () => {
    let lost = 0;
    const r = rig(["--fake-loading-ms", "60000"], { onLost: () => lost++ });
    r.best.warm();
    await until(() => r.best.loading() && r.best.pid() !== null, 5000, "the load to begin");
    const pid = r.best.pid() as number;
    process.kill(pid, "SIGKILL");
    await until(() => !r.best.loading(), 10_000, "the failed start");
    await Bun.sleep(100);
    expect(lost).toBe(0);
  });
});

describe("DC-L3: the audio check on best", () => {
  test("the fixed word goes to Qwen as its only context, and the text comes back", async () => {
    const r = rig();
    await r.best.decode(HELLO);
    expect(await r.best.check(HELLO, ["Kubernetes"])).toBe("hello");
    const [dictation, check] = r.requests();
    expect(check?.messages.filter((m) => m.role === "system")).toEqual([
      { role: "system", content: "Kubernetes" },
    ]);
    // Positive control: a dictation's own decode sends no context (its system turn is empty).
    expect(dictation?.messages.some((m) => m.role === "system" && m.content)).toBe(false);
  });

  test("a failed check throws, and never answers with fast's text", async () => {
    const r = rig(["--fake-die-on", "1"]);
    r.best.warm();
    await until(() => r.best.pid() !== null && !r.best.loading(), 10_000, "the warm server");
    await expect(r.best.check(HELLO, ["Kubernetes"])).rejects.toThrow();
    expect(r.requests().length).toBeGreaterThan(0);
  });

  test("a check never starts a server: with none warm it throws and starts nothing", async () => {
    const r = rig();
    await expect(r.best.check(HELLO, ["Kubernetes"])).rejects.toThrow(/no warm Qwen/);
    await Bun.sleep(200);
    expect(r.starts()).toBe(0);
    expect(r.best.pid()).toBeNull();
  });

  test("a check on a changed spec throws instead of loading the new server", async () => {
    const t = tempDir("akou-dict-check-respec-");
    cleanups.push(t.cleanup);
    const logFile = join(t.dir, "fake.log");
    let spec: LlamaEngineSpec = {
      kind: "llama-server",
      engine: QWEN_ASR,
      model: join(t.dir, QWEN_MODEL_FILE),
      mmproj: join(t.dir, QWEN_MMPROJ_FILE),
      accelerator: "cpu",
      command: [process.execPath, FAKE, "--fake-log", logFile],
    };
    const best = new BestEngine({
      spec: () => spec,
      fast: () => FAST,
      settings: () => ({ timeoutSeconds: 10, idleMinutes: 0, languages: [] }),
      clock: new ManualClock(),
    });
    cleanups.push(() => best.stop());
    await best.decode(HELLO);
    const first = best.pid() as number;
    spec = {
      ...spec,
      command: [process.execPath, FAKE, "--fake-log", logFile, "--fake-loading-ms", "10"],
    };
    await expect(best.check(HELLO, ["Kubernetes"])).rejects.toThrow(/no warm Qwen/);
    await Bun.sleep(200);
    const starts = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .filter((l) => (JSON.parse(l) as { argv?: unknown }).argv).length;
    expect(starts).toBe(1);
    expect(best.pid()).toBe(first);
  });

  test("a check past its budget is abandoned, and the warm server stays up for the next dictation", async () => {
    const r = rig(["--fake-hang-context"]);
    await r.best.decode(HELLO);
    const pid = r.best.pid() as number;
    const p = r.best.check(HELLO, ["Kubernetes"]);
    const failed = p.catch((err: Error) => err.message);
    await until(() => r.requests().length === 2, 10_000, "the check to reach the server");
    await r.clock.advance(11_000);
    expect(await failed).toMatch(/no answer within/);
    await Bun.sleep(300);
    expect(r.best.pid()).toBe(pid);
    expect(alive(pid)).toBe(true);
    const next = await r.best.decode(HELLO);
    expect(next).toMatchObject({ text: "hello", engine: "best" });
    expect(r.starts()).toBe(1);
  });

  test("a dictation takes the one slot: its decode abandons a check in flight, and restarts nothing", async () => {
    const r = rig(["--fake-hang-context"]);
    await r.best.decode(HELLO);
    let settled = false;
    const failed = r.best.check(HELLO, ["Kubernetes"]).then(
      () => "answered",
      (err: Error) => err.message,
    );
    void failed.finally(() => {
      settled = true;
    });
    await until(() => r.requests().length === 2, 10_000, "the check to reach the server");
    const d = await r.best.decode(HELLO);
    expect(d).toMatchObject({ text: "hello", engine: "best" });
    expect(d.fallback_from).toBeUndefined();
    // No clock moved: the check gave way to the dictation, it did not time out.
    await until(() => settled, 3000, "the check to give way");
    expect(await failed).toMatch(/given up/);
    expect(r.starts()).toBe(1);
    expect(r.logs.filter((l) => l.includes("restarting it"))).toEqual([]);
  });
});

describe("a changed spec on Metal", () => {
  test("the old server stops before the new one starts, so the new one does not give way to it", async () => {
    const t = tempDir("akou-dict-respec-");
    cleanups.push(t.cleanup);
    let spec: LlamaEngineSpec = {
      kind: "llama-server",
      engine: QWEN_ASR,
      model: join(t.dir, QWEN_MODEL_FILE),
      mmproj: join(t.dir, QWEN_MMPROJ_FILE),
      accelerator: "metal",
      gpuLayers: 0,
      command: [process.execPath, FAKE],
    };
    const best = new BestEngine({
      spec: () => spec,
      fast: () => FAST,
      settings: () => ({ timeoutSeconds: 10, idleMinutes: 0, languages: [] }),
      clock: new ManualClock(),
    });
    cleanups.push(() => best.stop());
    expect(await best.decode(HELLO)).toMatchObject({ engine: "best" });
    const first = best.pid() as number;
    spec = { ...spec, command: [process.execPath, FAKE, "--fake-loading-ms", "10"] };
    const next = await best.decode(HELLO);
    expect(next).toMatchObject({ engine: "best" });
    expect(next.fallback_from).toBeUndefined();
    expect(alive(first)).toBe(false);
    expect(best.pid()).not.toBe(first);
  });
});

describe("DC-E3: which engine a dictation runs", () => {
  test("auto: best on a GPU with Qwen on disk, fast on the CPU", () => {
    expect(
      resolveDictationEngine({ setting: "auto", accelerator: "metal", bestReady: true }),
    ).toMatchObject({ engine: "best", verdict: "best on metal", download: false });
    expect(
      resolveDictationEngine({ setting: "auto", accelerator: "cpu", bestReady: true }),
    ).toMatchObject({ engine: "fast", download: false });
  });

  test("auto on a GPU with Qwen missing is fast, and starts no download by itself", () => {
    expect(
      resolveDictationEngine({ setting: "auto", accelerator: "cuda", bestReady: false }),
    ).toMatchObject({ engine: "fast", download: false, wanted: null });
  });

  test("best forced with Qwen missing: fast, downloading, saying so", () => {
    expect(
      resolveDictationEngine({ setting: "best", accelerator: "cpu", bestReady: false }),
    ).toEqual({
      engine: "fast",
      verdict: "downloading best, using fast",
      download: true,
      wanted: "best",
      yielding: false,
    });
    expect(
      resolveDictationEngine({ setting: "best", accelerator: "cpu", bestReady: true }).engine,
    ).toBe("best");
  });

  test("a final pass holding the GPU: best gives way to fast and says why, auto or forced", () => {
    for (const setting of ["auto", "best"]) {
      expect(
        resolveDictationEngine({ setting, accelerator: "metal", bestReady: true, gpuBusy: true }),
      ).toEqual({
        engine: "fast",
        verdict: GPU_BUSY_VERDICT,
        download: false,
        wanted: "best",
        yielding: true,
      });
    }
    // Qwen still downloading is the download's verdict; fast and remote never wait on the GPU.
    expect(
      resolveDictationEngine({
        setting: "best",
        accelerator: "metal",
        bestReady: false,
        gpuBusy: true,
      }),
    ).toMatchObject({ download: true, yielding: false });
    for (const setting of ["fast", "remote"] as const) {
      expect(
        resolveDictationEngine({ setting, accelerator: "metal", bestReady: true, gpuBusy: true }),
      ).toMatchObject({ engine: setting, yielding: false });
    }
  });

  test("fast and remote are what they say, whatever the machine", () => {
    for (const setting of ["fast", "remote"] as const) {
      expect(
        resolveDictationEngine({ setting, accelerator: "metal", bestReady: true }).engine,
      ).toBe(setting);
    }
  });

  test("DC-E4: best and remote take a forced language, fast does not", () => {
    expect([forcesLanguage("best"), forcesLanguage("remote"), forcesLanguage("fast")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(dictationLanguages([], ["en"])).toEqual(["en"]);
    expect(dictationLanguages(["es"], ["en"])).toEqual(["es"]);
  });
});
