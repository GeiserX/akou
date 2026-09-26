/**
 * The GPU akou's llama-server runs on (bead akou-5an.94; docs/ux/SERVER.md SV-P2, SV-R2, SV-R3):
 * `asr.accelerator`, what the machine has, which pinned llama.cpp build runs where, and the check
 * that asks that build which devices it can really use. Nothing here touches the network or a GPU:
 * the machine is a fake probe, the build's answer is text captured from real runs, and the fetch is
 * pointed at a loopback server.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCELERATOR_SETTINGS,
  type AcceleratorState,
  availableBuilds,
  chooseAccelerator,
  confirmAccelerator,
  type Device,
  detectAccelerator,
  findDevices,
  listDevices,
  llamaServerBin,
  type Probe,
  parseDevices,
  verifyAccelerator,
} from "../src/main/asr/accelerator.ts";
import {
  fetchForHost,
  fetchLlamaBuild,
  LLAMA_BUILDS,
  LLAMA_RELEASE,
  llamaBuild,
  llamaBuildProblems,
  llamaUrl,
} from "../src/main/asr/llama-builds.ts";
import { QWEN_ASR } from "../src/main/asr/llama-catalog.ts";
import { ACCELERATORS, PLATFORMS } from "../src/main/asr/models.ts";
import { validateSetting } from "../src/main/config/schema.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";

/** A machine as the probe sees it: files that exist, their text, folder listings, and the nodes this user cannot open. */
function machine(
  platform: string,
  o: {
    files?: Record<string, string>;
    dirs?: Record<string, string[]>;
    denied?: string[];
    env?: Record<string, string>;
  } = {},
): Probe {
  const files = o.files ?? {};
  return {
    platform,
    env: o.env ?? {},
    exists: (p) => p in files || p in (o.dirs ?? {}),
    read: (p) => files[p] ?? null,
    list: (d) => o.dirs?.[d] ?? [],
    usable: (p) => !(o.denied ?? []).includes(p),
  };
}

/** A Linux box with one render node of the given PCI vendor. */
function renderNode(vendor: string, o: { denied?: boolean; env?: Record<string, string> } = {}) {
  return machine("linux-x64", {
    files: {
      "/dev/dri/renderD128": "",
      "/sys/class/drm/renderD128/device/vendor": `${vendor}\n`,
    },
    dirs: { "/dev/dri": ["card0", "renderD128"] },
    denied: o.denied ? ["/dev/dri/renderD128"] : [],
    env: o.env,
  });
}

// What llama-server --list-devices printed on real machines (b11200).
const LIST_METAL =
  "Available devices:\n  MTL0: Apple M4 Pro (18186 MiB, 18185 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n";
const LIST_NONE = "Available devices:\n  (none)\n";
// Debian's Mesa software renderer, listed when GGML_VK_VISIBLE_DEVICES names it: a CPU, not a GPU.
const LIST_LLVMPIPE =
  "Available devices:\n  Vulkan0: llvmpipe (LLVM 19.1.7, 128 bits) (3905 MiB, 3214 MiB free)\n";
// Written in the same format for hardware no runner has; the names are the ggml backends' own.
const LIST_UHD770 =
  "Available devices:\n  Vulkan0: Intel(R) UHD Graphics 770 (RPL-S) (31859 MiB, 28000 MiB free)\n";
const LIST_CUDA =
  "Available devices:\n  CUDA0: NVIDIA GeForce RTX 3060 (12044 MiB, 11800 MiB free)\n";
const LIST_ROCM =
  "Available devices:\n  ROCm0: AMD Radeon RX 7900 XTX (24560 MiB, 24000 MiB free)\n";
const LIST_SYCL =
  "Available devices:\n  SYCL0: Intel(R) Arc(TM) A770 Graphics (15473 MiB, 15473 MiB free)\n";

describe("asr.accelerator, the setting", () => {
  test("takes auto and every llama.cpp backend akou ships, and nothing else", () => {
    expect([...ACCELERATOR_SETTINGS]).toEqual([
      "auto",
      "cpu",
      "metal",
      "vulkan",
      "cuda",
      "sycl",
      "rocm",
    ]);
    for (const v of ACCELERATOR_SETTINGS)
      expect(validateSetting("asr.accelerator", v)).toMatchObject({ ok: true, value: v });
    // OpenVINO's llama.cpp backend runs no audio encoder yet, so it is not a choice.
    expect(validateSetting("asr.accelerator", "openvino").ok).toBe(false);
    expect(validateSetting("asr.accelerator", "").ok).toBe(false);
  });
});

describe("what the machine has", () => {
  test("an Apple silicon Mac has Metal, nothing to probe", () => {
    expect(findDevices(machine("darwin-arm64"))).toEqual([
      { vendor: "apple", node: "metal", usable: true },
    ]);
  });

  test("Linux: render nodes by PCI vendor, and the NVIDIA device node", () => {
    const p = machine("linux-x64", {
      files: {
        "/dev/dri/renderD128": "",
        "/dev/dri/renderD129": "",
        "/sys/class/drm/renderD128/device/vendor": "0x8086\n",
        "/sys/class/drm/renderD129/device/vendor": "0x1002\n",
        "/dev/nvidia0": "",
      },
      dirs: { "/dev/dri": ["card0", "card1", "renderD129", "renderD128", "by-path"] },
    });
    expect(findDevices(p)).toEqual([
      { vendor: "nvidia", node: "/dev/nvidia0", usable: true },
      { vendor: "intel", node: "/dev/dri/renderD128", usable: true },
      { vendor: "amd", node: "/dev/dri/renderD129", usable: true },
    ]);
  });

  test("a render node this user cannot open is found but not usable", () => {
    expect(findDevices(renderNode("0x8086", { denied: true }))).toEqual([
      { vendor: "intel", node: "/dev/dri/renderD128", usable: false },
    ]);
  });

  test("a Linux box with no /dev/dri and no NVIDIA node has nothing", () => {
    expect(findDevices(machine("linux-arm64"))).toEqual([]);
  });

  test("Windows: the NVIDIA driver's nvcuda.dll, and the Vulkan loader any GPU driver installs", () => {
    const sys = join("C:\\Windows", "System32");
    const p = machine("win32-x64", {
      env: { SystemRoot: "C:\\Windows" },
      files: { [join(sys, "nvcuda.dll")]: "", [join(sys, "vulkan-1.dll")]: "" },
    });
    expect(findDevices(p)).toEqual([
      { vendor: "nvidia", node: join(sys, "nvcuda.dll"), usable: true },
      { vendor: "other", node: join(sys, "vulkan-1.dll"), usable: true },
    ]);
  });
});

describe("which builds can run here", () => {
  test("natively: every build the release has for the platform", () => {
    expect(availableBuilds(machine("darwin-arm64"))).toEqual(["cpu", "metal"]);
    expect(availableBuilds(machine("linux-x64"))).toEqual([
      "cpu",
      "vulkan",
      "cuda",
      "sycl",
      "rocm",
    ]);
    expect(availableBuilds(machine("linux-arm64"))).toEqual(["cpu", "vulkan", "cuda"]);
    expect(availableBuilds(machine("win32-x64"))).toEqual([
      "cpu",
      "vulkan",
      "cuda",
      "sycl",
      "rocm",
    ]);
    expect(availableBuilds(machine("freebsd-x64"))).toEqual([]);
  });

  test("in an image: only what the image carries (AKOU_ACCELERATORS), unknown names dropped", () => {
    const p = machine("linux-x64", { env: { AKOU_ACCELERATORS: "vulkan, cpu,openvino" } });
    expect(availableBuilds(p)).toEqual(["vulkan", "cpu"]);
    // The CPU image's one build is its own fallback.
    expect(
      availableBuilds(machine("linux-x64", { env: { AKOU_ACCELERATORS: "cpu,cpu" } })),
    ).toEqual(["cpu"]);
  });
});

describe("the choice", () => {
  const intel: Device = { vendor: "intel", node: "/dev/dri/renderD128", usable: true };
  const amd: Device = { vendor: "amd", node: "/dev/dri/renderD128", usable: true };
  const nvidia: Device = { vendor: "nvidia", node: "/dev/nvidia0", usable: true };
  const apple: Device = { vendor: "apple", node: "metal", usable: true };
  const ALL = ["cpu", "vulkan", "cuda", "sycl", "rocm"] as const;

  test("auto: Metal on a Mac, CUDA for NVIDIA, Vulkan for Intel and AMD, else the CPU", () => {
    expect(chooseAccelerator("auto", [apple], ["cpu", "metal"]).active).toBe("metal");
    expect(chooseAccelerator("auto", [nvidia], ALL).active).toBe("cuda");
    expect(chooseAccelerator("auto", [intel], ALL).active).toBe("vulkan");
    expect(chooseAccelerator("auto", [amd], ALL).active).toBe("vulkan");
    // NVIDIA beside an iGPU: the discrete card.
    expect(chooseAccelerator("auto", [intel, nvidia], ALL).active).toBe("cuda");
    expect(chooseAccelerator("auto", [], ALL)).toEqual({ active: "cpu", reason: "no GPU found" });
  });

  test("auto never picks SYCL or ROCm: Vulkan runs the same cards from a build a fraction the size", () => {
    expect(chooseAccelerator("auto", [intel], ["cpu", "sycl"]).active).toBe("cpu");
    expect(chooseAccelerator("auto", [amd], ["cpu", "rocm"]).active).toBe("cpu");
  });

  test("an NVIDIA card with no CUDA build here runs on Vulkan", () => {
    expect(chooseAccelerator("auto", [nvidia], ["cpu", "vulkan"]).active).toBe("vulkan");
  });

  test("a GPU the image has no build for says which image to run", () => {
    const c = chooseAccelerator("auto", [intel], ["cpu"]);
    expect(c.active).toBe("cpu");
    expect(c.reason).toContain("/dev/dri/renderD128");
    expect(c.reason).toContain("-vulkan");
    expect(chooseAccelerator("auto", [nvidia], ["cpu"]).reason).toContain("-cuda");
  });

  test("a render node this user cannot open says how to fix it", () => {
    const c = chooseAccelerator("auto", [{ ...intel, usable: false }], ["cpu", "vulkan"]);
    expect(c.active).toBe("cpu");
    expect(c.reason).toContain("--group-add");
    expect(c.reason).toContain("stat -c %g /dev/dri/renderD128");
  });

  test("a setting names the build, when this install has it", () => {
    expect(chooseAccelerator("cpu", [nvidia], ALL).active).toBe("cpu");
    expect(chooseAccelerator("sycl", [intel], ALL)).toEqual({
      active: "sycl",
      reason: "asr.accelerator is sycl",
    });
  });

  test("a setting this install cannot honour falls back to auto's choice and says so", () => {
    const c = chooseAccelerator("cuda", [intel], ["vulkan", "cpu"]);
    expect(c.active).toBe("vulkan");
    expect(c.reason).toContain("asr.accelerator is cuda");
    expect(c.reason).toContain("vulkan, cpu");
  });
});

describe("what llama-server itself can use", () => {
  test("parses the device list of each backend, and skips the host's BLAS", () => {
    expect(parseDevices(LIST_METAL)).toEqual([{ backend: "metal", name: "Apple M4 Pro" }]);
    expect(parseDevices(LIST_UHD770)).toEqual([
      { backend: "vulkan", name: "Intel(R) UHD Graphics 770 (RPL-S)" },
    ]);
    expect(parseDevices(LIST_CUDA)).toEqual([{ backend: "cuda", name: "NVIDIA GeForce RTX 3060" }]);
    expect(parseDevices(LIST_ROCM)).toEqual([{ backend: "rocm", name: "AMD Radeon RX 7900 XTX" }]);
    expect(parseDevices(LIST_SYCL)).toEqual([
      { backend: "sycl", name: "Intel(R) Arc(TM) A770 Graphics" },
    ]);
    expect(parseDevices(LIST_NONE)).toEqual([]);
  });

  const unverified = (active: AcceleratorState["active"]): AcceleratorState => ({
    setting: "auto",
    active,
    gpu: active === "cpu" ? null : active,
    device: null,
    verified: false,
    available: ["cpu", active],
    reason: "an Intel GPU at /dev/dri/renderD128",
  });

  test("a device the build lists confirms the choice and names the GPU", () => {
    const s = confirmAccelerator(unverified("vulkan"), { output: LIST_UHD770 });
    expect(s).toMatchObject({
      active: "vulkan",
      gpu: "vulkan",
      device: "Intel(R) UHD Graphics 770 (RPL-S)",
      verified: true,
    });
  });

  test("a build that lists no such device falls back to the CPU, and says what it listed", () => {
    const s = confirmAccelerator(unverified("vulkan"), { output: LIST_NONE });
    expect(s).toMatchObject({ active: "cpu", gpu: null, device: null, verified: true });
    expect(s.reason).toContain("llama-server lists no vulkan device");
  });

  test("Mesa's software renderer is the CPU, never a GPU", () => {
    const s = confirmAccelerator(unverified("vulkan"), { output: LIST_LLVMPIPE });
    expect(s).toMatchObject({ active: "cpu", gpu: null, verified: true });
    expect(s.reason).toContain("llvmpipe");
  });

  test("a build that cannot run leaves the choice unverified, with the error", () => {
    const s = confirmAccelerator(unverified("cuda"), { error: "exited 127: libgomp.so.1 missing" });
    expect(s).toMatchObject({ active: "cuda", gpu: "cuda", verified: false });
    expect(s.reason).toContain("libgomp.so.1");
  });

  test("the CPU is confirmed by any list, the GPUs on it ignored", () => {
    expect(confirmAccelerator(unverified("cpu"), { output: LIST_CUDA })).toMatchObject({
      active: "cpu",
      gpu: null,
      device: null,
      verified: true,
    });
  });

  test("positive control: a Metal device does not confirm a Vulkan choice", () => {
    expect(confirmAccelerator(unverified("vulkan"), { output: LIST_METAL }).active).toBe("cpu");
  });
});

describe("detect, then verify with the real binary", () => {
  const t = tempDir("akou-accel-");
  afterAll(() => t.cleanup());

  /**
   * A stand-in llama-server: a Bun script that prints a device list on stdout, as the real one does,
   * run through Bun so it works the same on Windows.
   */
  function fakeLlama(dir: string, listing: string, exit = 0): string {
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "llama-server.ts");
    writeFileSync(
      bin,
      `if (process.argv[2] !== "--list-devices") process.exit(2);\nprocess.stdout.write(${JSON.stringify(listing)});\nprocess.exit(${exit});\n`,
    );
    return bin;
  }
  const run = (bin: string) => listDevices([process.execPath, bin]);

  test("detect is the setting, the devices and the builds, unverified", () => {
    const s = detectAccelerator(
      "auto",
      renderNode("0x8086", { env: { AKOU_ACCELERATORS: "vulkan,cpu" } }),
    );
    expect(s).toEqual({
      setting: "auto",
      active: "vulkan",
      gpu: "vulkan",
      device: null,
      verified: false,
      available: ["vulkan", "cpu"],
      reason: "an Intel GPU at /dev/dri/renderD128",
    });
  });

  test("the binary: AKOU_LLAMA_SERVER in an image, else the build the best preset unpacked, else none", () => {
    const models = join(t.dir, "models");
    const p = machine("linux-x64", { env: { AKOU_LLAMA_SERVER: "/opt/llama/llama-server" } });
    expect(llamaServerBin(p, models, "vulkan")).toBe("/opt/llama/llama-server");
    const native = machine("linux-x64", { files: {} });
    expect(llamaServerBin(native, models, "vulkan")).toBeNull();
    // Where llama-server.ts unpacks a build: the release's top folder on Linux and macOS.
    const there = join(
      models,
      `llama-server-${LLAMA_RELEASE}-linux-x64-vulkan`,
      "bin",
      `llama-${LLAMA_RELEASE}`,
      "llama-server",
    );
    const withFile = machine("linux-x64", { files: { [there]: "" } });
    expect(llamaServerBin(withFile, models, "vulkan")).toBe(there);
    const mac = join(
      models,
      `llama-server-${LLAMA_RELEASE}-darwin-arm64-metal`,
      "bin",
      `llama-${LLAMA_RELEASE}`,
      "llama-server",
    );
    expect(llamaServerBin(machine("darwin-arm64", { files: { [mac]: "" } }), models, "metal")).toBe(
      mac,
    );
    // Windows' zip has no top folder.
    const win = join(
      models,
      `llama-server-${LLAMA_RELEASE}-win32-x64-cuda`,
      "bin",
      "llama-server.exe",
    );
    expect(llamaServerBin(machine("win32-x64", { files: { [win]: "" } }), models, "cuda")).toBe(
      win,
    );
  });

  test("runs the binary's --list-devices and confirms from its answer", async () => {
    const bin = fakeLlama(join(t.dir, "uhd"), LIST_UHD770);
    expect(await run(bin)).toEqual({ output: LIST_UHD770 });
    const s = await verifyAccelerator(
      detectAccelerator("auto", renderNode("0x8086", { env: { AKOU_ACCELERATORS: "vulkan,cpu" } })),
      bin,
      run,
    );
    expect(s).toMatchObject({
      active: "vulkan",
      device: "Intel(R) UHD Graphics 770 (RPL-S)",
      verified: true,
    });
  });

  test("a binary that fails is an error, not an empty list", async () => {
    const bin = fakeLlama(join(t.dir, "broken"), "", 127);
    const r = await run(bin);
    expect(r.error).toContain("127");
    expect((await listDevices([join(t.dir, "absent", "llama-server")])).error).toBeDefined();
  });

  test("no binary: the state stays as detected", async () => {
    const s = detectAccelerator("auto", machine("darwin-arm64"));
    expect(await verifyAccelerator(s, null)).toEqual(s);
    expect(s).toMatchObject({ active: "metal", gpu: "metal", verified: false });
  });
});

describe("the pinned llama.cpp builds", () => {
  test("every entry is whole: a known platform and backend, pinned by SHA-256 and size, of this release", () => {
    expect(llamaBuildProblems(LLAMA_BUILDS)).toEqual([]);
    for (const b of LLAMA_BUILDS) {
      expect(PLATFORMS).toContain(b.platform);
      expect(ACCELERATORS).toContain(b.accelerator);
      for (const a of b.assets)
        expect(llamaUrl(a)).toStartWith(
          `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/`,
        );
    }
  });

  test("positive control: a bad digest, a duplicate and another release's asset are caught", () => {
    const b = LLAMA_BUILDS[0];
    if (!b) throw new Error("no builds");
    const bad = [
      b,
      b,
      { ...b, accelerator: "vulkan" as const, assets: [{ ...b.assets[0], sha256: "abc" }] },
      {
        ...b,
        accelerator: "cuda" as const,
        assets: [{ ...b.assets[0], name: "llama-b1-bin-ubuntu-x64.tar.gz" }],
      },
    ];
    const problems = llamaBuildProblems(bad as typeof LLAMA_BUILDS).join("\n");
    expect(problems).toContain("duplicate");
    expect(problems).toContain("sha256");
    expect(problems).toContain("release");
  });

  test("every released platform has a CPU build; CUDA builds carry their runtime libraries", () => {
    for (const p of PLATFORMS) expect(llamaBuild(p, "cpu")).not.toBeNull();
    for (const b of LLAMA_BUILDS.filter((x) => x.accelerator === "cuda")) {
      expect(b.assets.map((a) => a.name.startsWith("cudart-"))).toEqual([false, true]);
    }
    // One download serves a Mac both ways: Metal, and the CPU with no layers offloaded.
    expect(llamaBuild("darwin-arm64", "cpu")?.assets).toEqual(
      llamaBuild("darwin-arm64", "metal")?.assets,
    );
    expect(llamaBuild("linux-arm64", "sycl")).toBeNull();
  });
});

describe("fetching a build", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test("downloads each asset, checks it, and unpacks it flat beside llama-server", async () => {
    const t = tempDir("akou-llama-fetch-");
    // Two tarballs, each with one top folder, as the release's are.
    const tar = async (name: string, files: Record<string, string>) => {
      const out = join(t.dir, name);
      await Bun.Archive.write(out, files, { compress: "gzip" });
      const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
      return {
        name,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      };
    };
    const a = await tar("llama.tar.gz", {
      "llama-b0/llama-server": "#!/bin/sh\n",
      "llama-b0/sub/x.txt": "x",
    });
    const c = await tar("cudart.tar.gz", { "cudart-b0/libcudart.so.12": "lib" });
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const name = new URL(req.url).pathname.slice(1);
        const hit = [a, c].find((x) => x.name === name);
        return hit ? new Response(hit.bytes) : new Response("no", { status: 404 });
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const dir = join(t.dir, "out");
    const bin = await fetchLlamaBuild(
      {
        platform: "linux-x64",
        accelerator: "cuda",
        assets: [a, c].map(({ name, sha256, size }) => ({ name, sha256, size })),
      },
      dir,
      { base },
    );
    expect(bin).toBe(join(dir, "llama-server"));
    expect(existsSync(join(dir, "sub", "x.txt"))).toBe(true);
    expect(existsSync(join(dir, "libcudart.so.12"))).toBe(true);
    // Nothing of the download is left beside the build.
    expect(existsSync(join(dir, ".download"))).toBe(false);
    t.cleanup();
  });

  test("a digest that does not match leaves nothing unpacked", async () => {
    const t = tempDir("akou-llama-bad-");
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("tampered") });
    const dir = join(t.dir, "out");
    const build = {
      platform: "linux-x64" as const,
      accelerator: "cpu" as const,
      assets: [{ name: "llama.tar.gz", sha256: "0".repeat(64), size: 8 }],
    };
    await expect(
      fetchLlamaBuild(build, dir, { base: `http://127.0.0.1:${server.port}` }),
    ).rejects.toThrow();
    expect(existsSync(join(dir, "llama-server"))).toBe(false);
    t.cleanup();
  });

  test("a backend this platform has no build of is refused by name", async () => {
    await expect(fetchForHost("openvino", "/nonexistent")).rejects.toThrow(
      /no llama-server build for openvino/,
    );
  });

  test("tests and CI never fetch the real release", async () => {
    const b = llamaBuild("linux-x64", "cpu");
    if (!b) throw new Error("no build");
    const t = tempDir("akou-llama-guard-");
    await expect(fetchLlamaBuild(b, join(t.dir, "out"), { env: { CI: "1" } })).rejects.toThrow(
      /downloads are off/,
    );
    t.cleanup();
  });
});

describe("GET /v1/server reports the accelerator", () => {
  const t = tempDir("akou-accel-e2e-");
  const rigs: AppRig[] = [];
  afterAll(async () => {
    for (const r of rigs) await r.close();
    t.cleanup();
  });

  /** A rig on a fake machine whose llama-server prints `listing`. */
  async function rig(
    listing: string,
    o: { settings?: Record<string, unknown>; vendor?: string } = {},
  ) {
    mkdirSync(t.dir, { recursive: true });
    const bin = join(t.dir, `llama-${rigs.length}.ts`);
    writeFileSync(bin, `process.stdout.write(${JSON.stringify(listing)});\n`);
    const r = await appRig({
      settings: o.settings,
      accelerator: {
        probe: renderNode(o.vendor ?? "0x8086", {
          env: { AKOU_ACCELERATORS: "vulkan,cpu", AKOU_LLAMA_SERVER: bin },
        }),
        run: (b) => listDevices([process.execPath, b]),
      },
    });
    rigs.push(r);
    return r;
  }

  /** `/v1/server` once llama-server has answered. */
  async function server(
    r: AppRig,
  ): Promise<Record<string, unknown> & { accelerator: Omit<AcceleratorState, "gpu"> }> {
    for (let i = 0; i < 100; i++) {
      const b = (await r.api("GET", "/server")).body;
      if (b.accelerator?.verified) return b;
      await Bun.sleep(50);
    }
    throw new Error("the accelerator was never verified");
  }

  test("an Intel iGPU the Vulkan build opens: gpu vulkan, with its name", async () => {
    const b = await server(await rig(LIST_UHD770));
    expect(b.gpu).toBe("vulkan");
    expect(b.accelerator).toEqual({
      setting: "auto",
      active: "vulkan",
      device: "Intel(R) UHD Graphics 770 (RPL-S)",
      verified: true,
      available: ["vulkan", "cpu"],
      reason: "an Intel GPU at /dev/dri/renderD128",
    });
    // The best preset's Qwen runs there too: on the image's llama-server, on the Vulkan GPU.
    const engines = b.engines as { id: string; provider: string }[];
    expect(engines.find((e) => e.id === QWEN_ASR)?.provider).toBe("vulkan");
  });

  test("the same box whose build opens nothing: the CPU, and why", async () => {
    const b = await server(await rig(LIST_NONE));
    expect(b.gpu).toBeNull();
    expect(b.accelerator.active).toBe("cpu");
    expect(b.accelerator.reason).toContain("llama-server lists no vulkan device");
    const engines = b.engines as { id: string; provider: string }[];
    expect(engines.find((e) => e.id === QWEN_ASR)?.provider).toBe("cpu");
  });

  test("a changed asr.accelerator applies to the next Qwen job, with no restart", async () => {
    const r = await rig(LIST_UHD770);
    await server(r);
    const qwen = async () =>
      ((await r.api("GET", "/server")).body.engines as { id: string; provider: string }[]).find(
        (e) => e.id === QWEN_ASR,
      )?.provider;
    expect(await qwen()).toBe("vulkan");
    expect((await r.api("PATCH", "/config", { "asr.accelerator": "cpu" })).status).toBe(200);
    expect(await qwen()).toBe("cpu");
    expect((await r.api("GET", "/server")).body.accelerator.setting).toBe("cpu");
  });

  test("asr.accelerator cpu keeps the GPU out of it", async () => {
    const b = await server(await rig(LIST_UHD770, { settings: { "asr.accelerator": "cpu" } }));
    expect(b.gpu).toBeNull();
    expect(b.accelerator).toMatchObject({ setting: "cpu", active: "cpu", device: null });
  });

  test("the default rig reports no GPU, whatever machine runs the tests", async () => {
    const r = await appRig();
    rigs.push(r);
    const b = (await r.api("GET", "/server")).body;
    expect(b.gpu).toBeNull();
    expect(b.accelerator).toMatchObject({ active: "cpu", verified: false, reason: "no GPU found" });
  });
});
