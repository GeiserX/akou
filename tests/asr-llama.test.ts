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
  createLlamaServer,
  extractBuild,
  LlamaServer,
  llamaArgs,
  llamaBuild,
  llamaPlan,
  llamaRuntime,
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
import {
  parseAnswer,
  QWEN_LANGUAGES,
  QWEN_MAX_REQUEST_SECONDS,
  QwenEngine,
  qwenPieces,
  wavBytes,
} from "../src/main/asr/qwen.ts";
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

/** The audio each request of a fake's log carried, seconds (16-bit mono WAV, 44-byte header). */
function requestSeconds(log: Record<string, unknown>[]): number[] {
  return bodies(log).map((b) => {
    const user = b.messages.find((m) => (m as { role: string }).role === "user") as {
      content: { input_audio?: { data: string } }[];
    };
    const chars = Number.parseInt(
      user.content.find((p) => p.input_audio)?.input_audio?.data ?? "0",
      10,
    );
    return (Math.floor((chars * 3) / 4) - 44) / 2 / ASR_RATE;
  });
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
    // The Mac's too: asr.accelerator cpu there must have a build to download.
    for (const p of PLATFORMS) expect(llamaBuild(p, "cpu")).toBeDefined();
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

describe("where Qwen's llama-server comes from (akou-5an.94)", () => {
  const vulkan = { active: "vulkan", gpu: "vulkan" } as const;
  const none = { active: "cpu", gpu: null } as const;
  const base = { setting: "auto", own: [] as string[], platform: "linux-x64" };

  test("natively, the GPU detection found picks the pinned build to download", () => {
    const p = llamaPlan({ ...base, detected: vulkan });
    expect(p.build?.id).toBe(llamaBuildId("linux-x64", "vulkan"));
    expect(p).toMatchObject({ accelerator: "vulkan", provider: "vulkan" });
    expect(p.command).toBeUndefined();
    // Positive control: no GPU found downloads the CPU build.
    expect(llamaPlan({ ...base, detected: none }).build?.id).toBe(llamaBuildId("linux-x64", "cpu"));
  });

  test("a Mac on asr.accelerator cpu gets a build: the Metal archive, run with no device", () => {
    const p = llamaPlan({ ...base, setting: "cpu", platform: "darwin-arm64", detected: none });
    expect(p).toMatchObject({ accelerator: "cpu", provider: "cpu" });
    expect(p.build?.id).toBe(llamaBuildId("darwin-arm64", "cpu"));
    expect(p.build?.files).toEqual(llamaBuild("darwin-arm64", "metal")?.files);
    expect(p.note).toBeUndefined();
    const args = llamaArgs(
      { accelerator: p.accelerator, command: ["x"], model: "m", mmproj: "p" },
      1,
    );
    expect(args.slice(args.indexOf("--device"), args.indexOf("--device") + 2)).toEqual([
      "--device",
      "none",
    ]);
  });

  test("a GPU the build listed no device for runs the CPU build, not the GPU one with -ngl 999", () => {
    const p = llamaPlan({ ...base, setting: "vulkan", detected: none });
    expect(p).toMatchObject({ accelerator: "cpu", provider: "cpu" });
    expect(p.build?.id).toBe(llamaBuildId("linux-x64", "cpu"));
    expect(llamaArgs({ ...p, command: ["x"], model: "m", mmproj: "p" }, 1)).not.toContain("999");
  });

  test("a platform with no build says so in the plan's note, and plans no download", () => {
    const p = llamaPlan({ ...base, platform: "freebsd-x64", detected: none });
    expect(p.build).toBeUndefined();
    expect(p.accelerator).toBe("cpu");
    expect(p.note).toBe(
      "there is no cpu build of llama-server for freebsd-x64, so Qwen runs on the CPU",
    );
    // Positive control: a platform with a build has no note.
    expect(llamaPlan({ ...base, detected: none }).note).toBeUndefined();
  });

  test("an image runs the build it carries, on what detection chose, and downloads none", () => {
    const image = "/opt/llama/llama-server";
    const p = llamaPlan({ ...base, image, detected: vulkan });
    expect(p).toMatchObject({ command: [image], accelerator: "vulkan", provider: "vulkan" });
    expect(p.build).toBeUndefined();
    // Every layer on the GPU, none on the CPU: llamaArgs' default for the accelerator.
    expect(llamaArgs({ ...p, command: [image], model: "m", mmproj: "p" }, 1)).toContain("999");
    // `akou models pull best` in an image downloads no build either.
    const settings = { "asr.accelerator": "auto", "asr.llamaServer": [] };
    expect(llamaRuntime(settings, "linux-x64", MODELS, { image, detected: vulkan })).toBeNull();
    expect(llamaRuntime(settings, "linux-x64", MODELS, { detected: vulkan })).toBe(
      llamaBuildId("linux-x64", "vulkan"),
    );
    const cpu = llamaPlan({ ...base, image, detected: none });
    expect(cpu).toMatchObject({ command: [image], accelerator: "cpu", provider: "cpu" });
  });

  test("an own llama-server wins over the image's, and runs the GPU its setting names", () => {
    const own = ["/opt/sycl/llama-server"];
    const p = llamaPlan({ ...base, setting: "sycl", own, image: "/opt/llama/llama-server" });
    expect(p).toMatchObject({ command: own, provider: "sycl", gpuLayers: 999 });
    expect(p.note).toBeUndefined();
    expect(llamaPlan({ ...base, own }).provider).toBe("custom");
  });
});

/**
 * A pinned build as the best preset downloads it: one archive whose llama-server runs the fake,
 * whose `--list-devices` prints `devices`. A shell script, so POSIX only.
 */
function fakeBuild(devices: string): {
  build: { dir: string; archives: string[]; platform: string };
  log: string;
} {
  const dir = scratch();
  const log = join(dir, "fake.log");
  const src = join(dir, "src", "llama-b1");
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, "llama-server"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} --fake-log ${JSON.stringify(log)} --fake-devices ${JSON.stringify(devices)} "$@"\n`,
  );
  chmodSync(join(src, "llama-server"), 0o755);
  expect(
    Bun.spawnSync(["tar", "-czf", "build.tar.gz", "-C", "src", "llama-b1"], { cwd: dir }).exitCode,
  ).toBe(0);
  mkdirSync(join(dir, "build"));
  return {
    build: {
      dir: join(dir, "build"),
      archives: [join(dir, "build.tar.gz")],
      platform: "linux-x64",
    },
    log,
  };
}

describe.skipIf(process.platform === "win32")(
  "[akou-5an.94.1] a pinned GPU build is asked what it opens once unpacked, before its first start (POSIX shell; skipped on Windows)",
  () => {
    const started = (log: string) =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => (JSON.parse(l) as { argv: string[] }).argv);
    const ngl = (argv: string[]) => argv[argv.indexOf("-ngl") + 1];

    test("a build that lists no Vulkan device runs its first start on the CPU, and says why", async () => {
      const { build, log } = fakeBuild("");
      const said: string[] = [];
      const server = createLlamaServer(
        {
          kind: "llama-server",
          engine: QWEN_ASR,
          model: "m",
          mmproj: "p",
          accelerator: "vulkan",
          build,
        },
        { log: (_l, m) => said.push(m) },
      );
      cleanups.push(() => server.stop());
      await server.url();
      const [argv] = started(log);
      expect(ngl(argv as string[])).toBe("0");
      expect(argv).toContain("--device");
      expect(said.some((m) => m.includes("lists no vulkan device"))).toBe(true);
    });

    test("positive control: a build that lists the GPU runs every layer on it", async () => {
      const { build, log } = fakeBuild(
        "  Vulkan0: Intel(R) UHD Graphics 770 (RPL-S) (16384 MiB, 16000 MiB free)",
      );
      const server = createLlamaServer({
        kind: "llama-server",
        engine: QWEN_ASR,
        model: "m",
        mmproj: "p",
        accelerator: "vulkan",
        build,
      });
      cleanups.push(() => server.stop());
      await server.url();
      const [argv] = started(log);
      expect(ngl(argv as string[])).toBe("999");
      expect(argv).not.toContain("--device");
    });
  },
);

describe("the pinned build is unpacked once", () => {
  test("the archive's llama-server is found and made executable; a second call unpacks nothing", async () => {
    const dir = scratch();
    const src = join(dir, "src", "llama-b1");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "llama-server"), "#!/bin/sh\necho fake\n");
    writeFileSync(join(src, "libggml.so"), "lib");
    const archive = join(dir, "build.tar.gz");
    // Relative paths: GNU tar reads "C:" in an absolute Windows path as a remote host.
    const tar = Bun.spawnSync(["tar", "-czf", "build.tar.gz", "-C", "src", "llama-b1"], {
      cwd: dir,
    });
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

  test("a CUDA build's runtime archive lands beside llama-server, which finds it through $ORIGIN", () => {
    const dir = scratch();
    const files: Record<string, string> = {
      "llama-b1/llama-server": "#!/bin/sh\n",
      "llama-b1/libggml-cuda.so": "lib",
      "cudart-llama-b1/libcudart.so.12": "cudart",
      "cudart-llama-b1/libcublas.so.12": "cublas",
    };
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, "src", name, ".."), { recursive: true });
      writeFileSync(join(dir, "src", name), text);
    }
    for (const [archive, top] of [
      ["llama.tar.gz", "llama-b1"],
      ["cudart.tar.gz", "cudart-llama-b1"],
    ] as const) {
      const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", "src", top], { cwd: dir });
      expect(tar.exitCode).toBe(0);
    }
    const target = join(dir, "build");
    mkdirSync(target);
    const bin = extractBuild(
      target,
      [join(dir, "llama.tar.gz"), join(dir, "cudart.tar.gz")],
      "linux-x64",
    );
    expect(bin).toBe(join(target, "bin", "llama-b1", "llama-server"));
    expect(readFileSync(join(target, "bin", "llama-b1", "libcudart.so.12"), "utf8")).toBe("cudart");
    expect(existsSync(join(target, "bin", "llama-b1", "libcublas.so.12"))).toBe(true);
    expect(existsSync(join(target, "bin", "cudart-llama-b1"))).toBe(false);
  });

  test("an archive with no llama-server in it is an error naming the archive", () => {
    const dir = scratch();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "README"), "x");
    const archive = join(dir, "empty.tar.gz");
    Bun.spawnSync(["tar", "-czf", "empty.tar.gz", "-C", "src", "README"], { cwd: dir });
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

  test("only the nightly's control keeps the prompt cache: promptCache drops --cache-ram 0", () => {
    const base = { command: ["x"], model: "m", mmproj: "p", accelerator: "cpu" as const };
    expect(llamaArgs(base, 1)).toContain("--cache-ram");
    expect(llamaArgs({ ...base, promptCache: false }, 1)).toContain("--cache-ram");
    expect(llamaArgs({ ...base, promptCache: true }, 1)).not.toContain("--cache-ram");
  });

  test("a CPU build is told to keep every layer off the GPU; a GPU build offloads", () => {
    const base = { command: ["x"], model: "m", mmproj: "p" };
    const cpu = llamaArgs({ ...base, accelerator: "cpu" }, 1);
    expect(cpu.slice(cpu.indexOf("-ngl"), cpu.indexOf("-ngl") + 2)).toEqual(["-ngl", "0"]);
    expect(cpu.slice(cpu.indexOf("--device"), cpu.indexOf("--device") + 2)).toEqual([
      "--device",
      "none",
    ]);
    const gpu = llamaArgs({ ...base, accelerator: "vulkan" }, 1);
    expect(gpu.slice(gpu.indexOf("-ngl"), gpu.indexOf("-ngl") + 2)).toEqual(["-ngl", "999"]);
    expect(gpu).not.toContain("--device");
    // An own build on asr.accelerator cpu gets --device none too, as asr.llamaServer's doc says.
    const own = llamaPlan({ setting: "cpu", own: ["mine"], platform: "linux-x64" });
    expect(own.gpuLayers).toBeUndefined();
    expect(llamaArgs({ ...base, ...own, command: own.command ?? [] }, 1)).toContain("--device");
    // An own build given its own layer count picks its own devices.
    expect(llamaArgs({ ...base, accelerator: "cpu", gpuLayers: 999 }, 1)).not.toContain("--device");
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

  test("one Metal engine at a time: a second Metal server stops the first", async () => {
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
    // One this thread never started (another Worker's, or a crashed akou's) goes too, through the
    // pid file. Only where `ps` can confirm the pid is that llama-server: not on Windows, which
    // has no Metal anyway.
    if (process.platform !== "win32") {
      const orphan = Bun.spawn([process.execPath, FAKE, "--host", "127.0.0.1", "--port", "0"]);
      cleanups.push(() => orphan.kill());
      await Bun.sleep(300);
      writeFileSync(
        join(lockDir, "llama-metal.json"),
        JSON.stringify({ pid: orphan.pid, port: 0 }),
      );
      const e = fakeServer([], { accelerator: "metal", lockDir });
      await e.server.url();
      const ended = await Promise.race([
        orphan.exited.then(() => true),
        Bun.sleep(3000).then(() => false),
      ]);
      expect(ended).toBe(true);
    }
  });

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
    expect((sent[0]?.messages ?? []).map((m) => (m as { role: string }).role)).toEqual([
      "system",
      "user",
    ]);
  });

  test("a language Qwen does not know is decoded as auto, not forced", async () => {
    const { server, log } = fakeServer();
    await new QwenEngine({ id: QWEN_ASR, server }).decode(unit(["hello"], "eu"));
    const msgs = bodies(log())[0]?.messages ?? [];
    expect(msgs.map((m) => (m as { role: string }).role)).toEqual(["system", "user"]);
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

  test("the system turn is always sent, empty with no glossary: without it Qwen answers a language on silence", async () => {
    const { server, log } = fakeServer();
    const engine = new QwenEngine({ id: QWEN_ASR, server, allowed: ["en", "es"] });
    await engine.decode(unit(["hello"]));
    await engine.decode(unit(["hello"], "en"));
    // Forced: the auto decode answers English, so Spanish takes a second request.
    await engine.decode(unit(["hello"], "es"));
    const sent = bodies(log());
    expect(sent).toHaveLength(4);
    for (const b of sent) expect(b.messages[0]).toEqual({ role: "system", content: "" });
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

  test("a unit past the request limit goes in pieces cut at a pause, and every word comes back", async () => {
    const { server, log } = fakeServer();
    const samples = concat(
      speak(["hello", "world"]),
      silence(1.5),
      speak(["world", "hello"]),
      silence(1.5),
      speak(["hello"]),
    );
    const h = await new QwenEngine({ id: QWEN_ASR, server, maxSeconds: 3 }).decode({
      samples,
      lang: "auto",
      glossary: [],
    });
    expect(h.text).toBe("hello world world hello hello");
    expect(h.lang).toBe("en");
    const sent = requestSeconds(log());
    expect(sent).toHaveLength(2);
    for (const sec of sent) expect(sec).toBeLessThanOrEqual(3);
    expect(sent.reduce((a, b) => a + b, 0)).toBeCloseTo(samples.length / ASR_RATE, 2);
  });

  test("a whole dictation longer than the limit is never one request (the context fills and the rest is lost)", async () => {
    const { server, log } = fakeServer();
    const samples = concat(
      speak(["hello"]),
      silence(QWEN_MAX_REQUEST_SECONDS + 20),
      speak(["world"]),
    );
    const h = await new QwenEngine({ id: QWEN_ASR, server }).decode({
      samples,
      lang: "auto",
      glossary: [],
    });
    expect(h.text).toBe("hello world");
    const sent = requestSeconds(log());
    expect(sent.length).toBeGreaterThan(1);
    for (const sec of sent) expect(sec).toBeLessThanOrEqual(QWEN_MAX_REQUEST_SECONDS);
  });

  test("the pieces cover the unit in order, each within the limit, the cut on the quietest window", () => {
    const x = concat(speak(["hello", "world"]), silence(0.5), speak(["hello", "world", "hello"]));
    const pieces = qwenPieces(x, 1.2);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(1.2 * ASR_RATE);
    expect(concat(...pieces)).toEqual(x);
    // The first cut falls in the half second of silence after the second word.
    const first = (pieces[0] as Float32Array).length / ASR_RATE;
    expect(first).toBeGreaterThan(0.74);
    expect(first).toBeLessThan(1.24);
    expect(qwenPieces(x, 60)).toEqual([x]);
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

  test("lidc: a unit's own list (a job's languages[]) wins over the engine's", async () => {
    const lps = [
      "--fake-lang",
      "Chinese",
      "--fake-lp",
      "English=-0.2",
      "--fake-lp",
      "Spanish=-0.9",
    ];
    // The engine's list says English; the unit's says Spanish only, so Spanish it is.
    const a = fakeServer(lps);
    const h = await new QwenEngine({ id: QWEN_ASR, server: a.server, allowed: ["en"] }).decode({
      ...unit(["hello"]),
      allowed: ["es"],
    });
    expect(h.lang).toBe("es");
    // With no engine list, the unit's bounds it alone.
    const b = fakeServer(lps);
    const h2 = await new QwenEngine({ id: QWEN_ASR, server: b.server }).decode({
      ...unit(["hello"]),
      allowed: ["en", "es"],
    });
    expect(h2.lang).toBe("en");
    // An empty unit list is none: the engine's applies.
    const c = fakeServer(lps);
    const h3 = await new QwenEngine({ id: QWEN_ASR, server: c.server, allowed: ["es"] }).decode({
      ...unit(["hello"]),
      allowed: [],
    });
    expect(h3.lang).toBe("es");
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
