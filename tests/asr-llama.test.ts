/**
 * ASR-5 (docs/research/asr-architecture.md section 9): the llama-server runtime and the Qwen3-ASR
 * engine. The catalog pins Qwen's GGUF files and one llama-server build per platform and
 * accelerator; the supervisor starts the build with `--cache-ram 0`, waits for its health check,
 * restarts it when it drops, and runs one Metal engine at a time; the engine strips Qwen's
 * `language X<asr_text>` prefix, forces a language when it knows one, keeps a "None" answer, and
 * falls back to forced decodes when the model names a language outside the allowed ones. Every
 * process here is the fake server of `fixtures/fake-llama-server.ts`, which answers as b11200 does.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASR_RATE, type FinalUnit } from "../src/main/asr/engine.ts";
import {
  LLAMA_RELEASE,
  llamaBuildId,
  QWEN_ASR,
  QWEN_MMPROJ_FILE,
  QWEN_MODEL_FILE,
} from "../src/main/asr/llama-catalog.ts";
import {
  extractBuild,
  LlamaServer,
  llamaArgs,
  llamaBuild,
  resolveAccelerator,
} from "../src/main/asr/llama-server.ts";
import {
  type CatalogEntry,
  catalogProblems,
  hostPlatform,
  MODELS,
  modelsFor,
  PLATFORMS,
  RECOGNIZER,
} from "../src/main/asr/models.ts";
import { parseAnswer, QWEN_LANGUAGES, QwenEngine, wavBytes } from "../src/main/asr/qwen.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const FAKE = join(import.meta.dir, "fixtures", "fake-llama-server.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function scratch(): string {
  const t = tempDir("akou-llama-");
  cleanups.push(t.cleanup);
  return t.dir;
}

/** A supervisor over the fake server, stopped after the test; `log` lists its starts and requests. */
function fakeServer(
  fake: string[] = [],
  o: Partial<ConstructorParameters<typeof LlamaServer>[0]> = {},
): { server: LlamaServer; log: () => Record<string, unknown>[]; dir: string } {
  const dir = scratch();
  const logFile = join(dir, "fake.log");
  const server = new LlamaServer({
    command: [process.execPath, FAKE, "--fake-log", logFile, ...fake],
    model: join(dir, QWEN_MODEL_FILE),
    mmproj: join(dir, QWEN_MMPROJ_FILE),
    accelerator: "cpu",
    ...o,
  });
  cleanups.push(() => server.stop());
  const log = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { server, log, dir };
}

/** The requests of a fake's log. */
function bodies(log: Record<string, unknown>[]): { messages: unknown[] }[] {
  return log.filter((l) => l.body).map((l) => l.body as { messages: unknown[] });
}

function unit(words: string[], lang = "auto", glossary: string[] = []): FinalUnit {
  return { samples: concat(silence(0.3), speak(words), silence(0.3)), lang, glossary };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the catalog pins Qwen3-ASR and one llama-server build per platform and accelerator", () => {
  const qwen = MODELS.find((m) => m.id === QWEN_ASR) as CatalogEntry;

  test("Qwen3-ASR-1.7B is the Q8_0 GGUF and its projector, pinned to a revision, Apache-2.0", () => {
    expect(qwen).toBeDefined();
    expect(qwen.licence).toBe("Apache-2.0");
    expect(qwen.serves).toEqual(["final"]);
    expect(qwen.runtime).toBe("llama-server");
    expect(qwen.onDemand).toBe(true);
    expect(qwen.files).toEqual([
      {
        name: QWEN_MODEL_FILE,
        url: expect.stringMatching(/\/resolve\/[0-9a-f]{40}\/Qwen3-ASR-1\.7B-Q8_0\.gguf$/),
        sha256: "58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57",
        size: 2165034944,
      },
      {
        name: QWEN_MMPROJ_FILE,
        url: expect.stringMatching(/\/resolve\/[0-9a-f]{40}\/mmproj-Qwen3-ASR-1\.7B-Q8_0\.gguf$/),
        sha256: "46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d",
        size: 355709344,
      },
    ]);
    // English and Spanish are the operator's languages; the list is Qwen's own 30.
    expect(qwen.languages).toContain("en");
    expect(qwen.languages).toContain("es");
    expect(qwen.languages).toHaveLength(30);
    expect(Object.keys(QWEN_LANGUAGES).sort()).toEqual([...(qwen.languages as string[])].sort());
  });

  test("every released platform has a CPU build; Apple silicon has Metal; Linux x64 has Vulkan and CUDA", () => {
    for (const p of PLATFORMS) expect(llamaBuild(p, "cpu") ?? llamaBuild(p, "metal")).toBeDefined();
    expect(llamaBuild("darwin-arm64", "metal")?.id).toBe(llamaBuildId("darwin-arm64", "metal"));
    for (const a of ["cpu", "vulkan", "cuda"] as const) {
      expect(llamaBuild("linux-x64", a)).toBeDefined();
      expect(llamaBuild("win32-x64", a)).toBeDefined();
    }
    expect(llamaBuild("linux-arm64", "vulkan")).toBeDefined();
    // Metal is Apple's: no Linux build claims it.
    expect(llamaBuild("linux-x64", "metal")).toBeUndefined();
    const builds = MODELS.filter((m) => m.serves.includes("runtime"));
    expect(builds.length).toBeGreaterThanOrEqual(9);
    for (const b of builds) {
      expect(b.runtime).toBe("llama-server");
      expect(b.onDemand).toBe(true);
      expect(b.platforms).toHaveLength(1);
      expect(b.accelerators).toHaveLength(1);
      expect(b.licence).toBe("MIT");
      for (const f of b.files) {
        expect(f.url).toStartWith(
          `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/`,
        );
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(catalogProblems(MODELS as CatalogEntry[])).toEqual([]);
  });

  test("a machine's default download never includes an on-demand entry", () => {
    const ids = modelsFor({ "asr.diarizer": "nemotron" }, hostPlatform()).map((m) => m.id);
    expect(ids).toEqual([RECOGNIZER, "silero-vad", "nemotron-3-diarization", "titanet-small"]);
    // Positive control: the same entry without the flag is part of the default download.
    const plain = { ...qwen, onDemand: undefined };
    const withPlain = modelsFor({ "asr.diarizer": "nemotron" }, hostPlatform(), [
      ...MODELS.filter((m) => m.id !== QWEN_ASR),
      plain,
    ]);
    expect(withPlain.map((m) => m.id)).toContain(QWEN_ASR);
  });
});

describe("which accelerator runs llama-server", () => {
  test("auto is Metal on Apple silicon and the CPU elsewhere; an asked-for build is used where it exists", () => {
    expect(resolveAccelerator("auto", "darwin-arm64")).toEqual({ accelerator: "metal" });
    expect(resolveAccelerator("auto", "linux-x64")).toEqual({ accelerator: "cpu" });
    expect(resolveAccelerator("vulkan", "linux-x64")).toEqual({ accelerator: "vulkan" });
    expect(resolveAccelerator("cuda", "win32-x64")).toEqual({ accelerator: "cuda" });
  });

  test("a build that does not exist for the platform falls back to the CPU and says why", () => {
    const r = resolveAccelerator("metal", "linux-x64");
    expect(r.accelerator).toBe("cpu");
    expect(r.note).toContain("no metal build of llama-server for linux-x64");
  });
});

describe("the pinned build is unpacked once", () => {
  test("the archive's llama-server is found and made executable; a second call unpacks nothing", async () => {
    const dir = scratch();
    const src = join(dir, "src", "llama-b1");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "llama-server"), "#!/bin/sh\necho fake\n");
    writeFileSync(join(src, "libggml.so"), "lib");
    const archive = join(dir, "build.tar.gz");
    const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", join(dir, "src"), "llama-b1"]);
    expect(tar.exitCode).toBe(0);
    const target = join(dir, "build");
    mkdirSync(target);
    const bin = extractBuild(target, [archive], "linux-x64");
    expect(bin).toBe(join(target, "bin", "llama-b1", "llama-server"));
    expect(existsSync(join(target, "bin", "llama-b1", "libggml.so"))).toBe(true);
    if (process.platform !== "win32") expect(statSync(bin).mode & 0o111).not.toBe(0);
    // Marked unpacked: a changed file inside is not overwritten by a second call.
    writeFileSync(bin, "#!/bin/sh\necho mine\n");
    chmodSync(bin, 0o755);
    expect(extractBuild(target, [archive], "linux-x64")).toBe(bin);
    expect(readFileSync(bin, "utf8")).toContain("mine");
  });

  test("an archive with no llama-server in it is an error naming the archive", () => {
    const dir = scratch();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "README"), "x");
    const archive = join(dir, "empty.tar.gz");
    Bun.spawnSync(["tar", "-czf", archive, "-C", join(dir, "src"), "README"]);
    mkdirSync(join(dir, "build"));
    expect(() => extractBuild(join(dir, "build"), [archive], "linux-x64")).toThrow(
      "no llama-server in empty.tar.gz",
    );
  });
});

describe("the supervisor", () => {
  test("starts llama-server with --cache-ram 0 on a loopback port and waits for its health check", async () => {
    const { server, log } = fakeServer(["--fake-loading-ms", "400", "--fake-refuse-cache"]);
    const url = await server.url();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    const argv = log()[0]?.argv as string[];
    // The out-of-memory trap: the default prompt cache grows with every request.
    expect(argv.slice(argv.indexOf("--cache-ram"), argv.indexOf("--cache-ram") + 2)).toEqual([
      "--cache-ram",
      "0",
    ]);
    expect(argv).toContain("--mmproj");
    expect(argv).toContain("--no-webui");
    expect(server.starts).toBe(1);
  });

  test("positive control: the fake refuses a start without --cache-ram 0, and the supervisor reports it", () => {
    const args = llamaArgs(
      { command: ["x"], model: "m", mmproj: "p", accelerator: "cpu" },
      1234,
    ).filter((a, i, xs) => a !== "--cache-ram" && xs[i - 1] !== "--cache-ram");
    const r = Bun.spawnSync([process.execPath, FAKE, "--fake-refuse-cache", ...args]);
    expect(r.exitCode).toBe(64);
  });

  test("a CPU build is told to keep every layer off the GPU; a GPU build offloads", () => {
    const base = { command: ["x"], model: "m", mmproj: "p" };
    const cpu = llamaArgs({ ...base, accelerator: "cpu" }, 1);
    expect(cpu.slice(cpu.indexOf("-ngl"), cpu.indexOf("-ngl") + 2)).toEqual(["-ngl", "0"]);
    const gpu = llamaArgs({ ...base, accelerator: "vulkan" }, 1);
    expect(gpu.slice(gpu.indexOf("-ngl"), gpu.indexOf("-ngl") + 2)).toEqual(["-ngl", "999"]);
  });

  test("a server that dies is started again on the next request", async () => {
    const { server } = fakeServer(["--fake-die-after", "1"]);
    const engine = new QwenEngine({ id: QWEN_ASR, server });
    expect((await engine.decode(unit(["hello"]))).text).toBe("hello");
    // It exited after answering; the next decode restarts it and succeeds.
    await Bun.sleep(100);
    expect((await engine.decode(unit(["world"]))).text).toBe("world");
    expect(server.starts).toBe(2);
  });

  test("a server that answers 500 (a Metal out-of-memory) is restarted and the request retried once", async () => {
    const { server, log } = fakeServer(["--fake-500", "1"]);
    const engine = new QwenEngine({ id: QWEN_ASR, server });
    const pid0 = await server.url().then(() => server.pid());
    expect((await engine.decode(unit(["yes"]))).text).toBe("yes");
    expect(server.starts).toBe(2);
    expect(alive(pid0 as number)).toBe(false);
    expect(log().filter((l) => l.body).length).toBe(2);
  });

  test("a server that keeps failing fails the decode with engine_unavailable, never an empty text", async () => {
    const { server } = fakeServer(["--fake-500", "99"]);
    const engine = new QwenEngine({ id: QWEN_ASR, server });
    const err = await engine.decode(unit(["yes"])).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("engine_unavailable");
    expect(err.fatal).toBe(true);
  });

  test.skipIf(process.platform === "win32")(
    "one Metal engine at a time: a second Metal server stops the first (skipped on Windows: no Metal)",
    async () => {
      const lockDir = scratch();
      const a = fakeServer([], { accelerator: "metal", lockDir });
      const b = fakeServer([], { accelerator: "metal", lockDir });
      await a.server.url();
      const pidA = a.server.pid() as number;
      await b.server.url();
      await Bun.sleep(200);
      expect(alive(pidA)).toBe(false);
      expect(alive(b.server.pid() as number)).toBe(true);
      // Positive control: two CPU servers sharing the lock folder both keep running.
      const c = fakeServer([], { accelerator: "cpu", lockDir });
      const d = fakeServer([], { accelerator: "cpu", lockDir });
      await c.server.url();
      await d.server.url();
      expect(alive(c.server.pid() as number)).toBe(true);
      expect(alive(d.server.pid() as number)).toBe(true);
    },
  );

  test("stop ends the process and reports it through onChild", async () => {
    const seen: [number, boolean][] = [];
    const { server } = fakeServer([], { onChild: (pid, up) => seen.push([pid, up]) });
    await server.url();
    const pid = server.pid() as number;
    await server.stop();
    expect(alive(pid)).toBe(false);
    expect(seen).toEqual([
      [pid, true],
      [pid, false],
    ]);
  });
});

describe("the Qwen engine's protocol", () => {
  test("Qwen's prefix is stripped and its language name becomes an ISO code", () => {
    expect(parseAnswer("language Spanish<asr_text>Se recomienda.")).toEqual({
      lang: "Spanish",
      text: "Se recomienda.",
    });
    expect(parseAnswer("language None<asr_text>")).toEqual({ lang: "None", text: "" });
    expect(parseAnswer("no prefix at all")).toEqual({ lang: null, text: "no prefix at all" });
    expect(QWEN_LANGUAGES.es).toBe("Spanish");
    expect(QWEN_LANGUAGES.en).toBe("English");
  });

  test("an auto decode: text without the prefix, the language, words with confidences from the log-probs", async () => {
    const { server, log } = fakeServer();
    const h = await new QwenEngine({ id: QWEN_ASR, server }).decode(unit(["hello", "world"]));
    expect(h.engine).toBe(QWEN_ASR);
    expect(h.text).toBe("hello world");
    expect(h.lang).toBe("en");
    expect(h.words.map((w) => w.w)).toEqual(["hello", "world"]);
    for (const w of h.words) expect(w.conf).toBeCloseTo(Math.exp(-0.05), 5);
    const body = log().find((l) => l.body)?.body as { logprobs: boolean; temperature: number };
    expect(body.logprobs).toBe(true);
    expect(body.temperature).toBe(0);
  });

  test("a known language the model did not choose is forced with Qwen's own prefix as the assistant's first words", async () => {
    const { server, log } = fakeServer();
    const h = await new QwenEngine({ id: QWEN_ASR, server }).decode(unit(["hello"], "es"));
    expect(h.lang).toBe("es");
    expect(h.text).toBe("hello");
    // The auto decode answered English, so the Spanish one is forced.
    const sent = bodies(log());
    expect(sent).toHaveLength(2);
    const msgs = sent[1]?.messages ?? [];
    expect(msgs[msgs.length - 1]).toEqual({
      role: "assistant",
      content: "language Spanish<asr_text>",
    });
  });

  test("a known language the model chose is one request: greedy, the forced decode would be the same", async () => {
    const { server, log } = fakeServer();
    const h = await new QwenEngine({ id: QWEN_ASR, server }).decode(unit(["hello"], "en"));
    expect([h.lang, h.text]).toEqual(["en", "hello"]);
    expect(bodies(log())).toHaveLength(1);
  });

  test("no speech stays empty even with a language set: forcing one on a None answer invents words", async () => {
    const { server, log } = fakeServer();
    const h = await new QwenEngine({ id: QWEN_ASR, server }).decode({
      samples: silence(1),
      lang: "es",
      glossary: [],
    });
    expect(h.text).toBe("");
    const sent = bodies(log());
    expect(sent).toHaveLength(1);
    expect((sent[0]?.messages ?? []).map((m) => (m as { role: string }).role)).toEqual(["user"]);
  });

  test("a language Qwen does not know is decoded as auto, not forced", async () => {
    const { server, log } = fakeServer();
    await new QwenEngine({ id: QWEN_ASR, server }).decode(unit(["hello"], "eu"));
    const msgs = bodies(log())[0]?.messages ?? [];
    expect(msgs.map((m) => (m as { role: string }).role)).toEqual(["user"]);
  });

  test("the glossary is the system prompt, and fixes the word the engine mishears", async () => {
    const { server, log } = fakeServer();
    const engine = new QwenEngine({ id: QWEN_ASR, server });
    expect((await engine.decode(unit(["hetzner"]))).text).toBe("hetzna");
    const h = await engine.decode(unit(["hetzner"], "auto", ["Hetzner", "Kubernetes"]));
    expect(h.text).toBe("Hetzner");
    const sys = bodies(log())[1]?.messages[0];
    expect(sys).toEqual({ role: "system", content: "Hetzner, Kubernetes" });
  });

  test("a 'None' answer is kept: no speech is empty text, never a forced sentence", async () => {
    const { server, log } = fakeServer();
    const engine = new QwenEngine({ id: QWEN_ASR, server, allowed: ["en", "es"] });
    const h = await engine.decode({ samples: silence(1), lang: "auto", glossary: [] });
    expect(h.text).toBe("");
    expect(h.words).toEqual([]);
    // One request: a None answer is not re-decoded in a forced language.
    expect(log().filter((l) => l.body)).toHaveLength(1);
  });

  test("lidc: a language outside the allowed ones is replaced by the better-scoring forced decode", async () => {
    const { server, log } = fakeServer([
      "--fake-lang",
      "Chinese",
      "--fake-lp",
      "English=-0.9",
      "--fake-lp",
      "Spanish=-0.2",
    ]);
    const engine = new QwenEngine({ id: QWEN_ASR, server, allowed: ["en", "es"] });
    const h = await engine.decode(unit(["hello", "world"]));
    expect(h.lang).toBe("es");
    expect(log().filter((l) => l.body)).toHaveLength(3);
    // An allowed answer is taken as it is, with one request.
    const ok = fakeServer(["--fake-lang", "English"]);
    const h2 = await new QwenEngine({
      id: QWEN_ASR,
      server: ok.server,
      allowed: ["en", "es"],
    }).decode(unit(["hello"]));
    expect(h2.lang).toBe("en");
    expect(ok.log().filter((l) => l.body)).toHaveLength(1);
    // With no allowed list, whatever the model names stands.
    const free = fakeServer(["--fake-lang", "Chinese"]);
    const h3 = await new QwenEngine({ id: QWEN_ASR, server: free.server }).decode(unit(["hello"]));
    expect(h3.lang).toBe("zh");
  });

  test("the unit is sent as a 16 kHz 16-bit mono WAV", () => {
    const bytes = wavBytes(new Float32Array([0, 0.5, -1, 1.5]));
    const v = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(ASR_RATE);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    // Clipped, never wrapped.
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + 2 * i, true))).toEqual([
      0, 16384, -32768, 32767,
    ]);
  });
});
