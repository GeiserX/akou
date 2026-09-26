/**
 * Which GPU akou's llama-server runs on (bead akou-5an.94; docs/ux/SERVER.md SV-P2, SV-R2, SV-R3).
 *
 * `asr.accelerator` is `auto` or a llama.cpp backend: `cpu`, `metal`, `vulkan`, `cuda`, `sycl` or
 * `rocm`. `auto` reads the machine once at start: Apple silicon has Metal; on Linux an NVIDIA device
 * node means CUDA and a DRI render node (Intel or AMD, by its PCI vendor) means Vulkan; on Windows
 * the NVIDIA driver's `nvcuda.dll` means CUDA and the Vulkan loader means Vulkan. `auto` never picks
 * SYCL or ROCm: Vulkan runs the same cards from a build a fraction of the size, with no vendor
 * runtime on the host.
 *
 * What can run is the builds this install has: in an image, the ones it carries
 * (`AKOU_ACCELERATORS`, set by the Dockerfile per variant, since the drivers are in the image);
 * natively, every build the pinned release has for the platform (llama-builds.ts).
 *
 * Then the build itself is asked: `llama-server --list-devices` lists the devices its backend can
 * really open. A GPU it does not list (a render node the container user cannot open, a missing
 * driver) turns the choice into the CPU, with the reason, so `GET /v1/server` never claims a GPU
 * nothing runs on. Mesa's software renderer, llvmpipe, is a CPU and never counts.
 *
 * Speech engines on ONNX Runtime stay on the CPU: sherpa-onnx's npm packages are CPU builds on
 * Linux and Windows, and the Nemotron diarizer (100M parameters) and Parakeet (0.6B) already run
 * far faster than real time there. The GPU goes where the large model is: Qwen3-ASR on llama-server.
 */

import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LlamaBuild, llamaAccelerators, llamaBuild, llamaServerName } from "./llama-builds.ts";
import { ACCELERATORS, type Accelerator, hostPlatform } from "./models.ts";

export const ACCELERATOR_SETTINGS = ["auto", ...ACCELERATORS] as const;
export type AcceleratorSetting = (typeof ACCELERATOR_SETTINGS)[number];

export type Vendor = "nvidia" | "intel" | "amd" | "apple" | "other";

/** A GPU the machine shows: who made it, the node it is reached through, and whether this user can open it. */
export interface Device {
  vendor: Vendor;
  node: string;
  usable: boolean;
}

/** What detection reads of the machine; tests pass a fake. */
export interface Probe {
  /** `${process.platform}-${process.arch}`. */
  platform: string;
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  read(path: string): string | null;
  list(dir: string): string[];
  /** Readable and writable by this process: a render node needs both. */
  usable(path: string): boolean;
}

export function hostProbe(env: Record<string, string | undefined> = process.env): Probe {
  return {
    platform: hostPlatform(),
    env,
    exists: (p) => existsSync(p),
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    list: (d) => {
      try {
        return readdirSync(d);
      } catch {
        return [];
      }
    },
    usable: (p) => {
      try {
        accessSync(p, constants.R_OK | constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const PCI_VENDORS: Readonly<Record<string, Vendor>> = {
  "0x8086": "intel",
  "0x1002": "amd",
  "0x10de": "nvidia",
};

/** The GPUs the machine shows, NVIDIA's device node first, then render nodes in order. */
export function findDevices(p: Probe): Device[] {
  if (p.platform === "darwin-arm64") return [{ vendor: "apple", node: "metal", usable: true }];
  if (p.platform.startsWith("win32")) {
    const sys = join(p.env.SystemRoot ?? "C:\\Windows", "System32");
    const out: Device[] = [];
    const nv = join(sys, "nvcuda.dll");
    const vk = join(sys, "vulkan-1.dll");
    if (p.exists(nv)) out.push({ vendor: "nvidia", node: nv, usable: true });
    if (p.exists(vk)) out.push({ vendor: "other", node: vk, usable: true });
    return out;
  }
  if (!p.platform.startsWith("linux")) return [];
  const out: Device[] = [];
  // The NVIDIA Container Toolkit (`--gpus all`) and the host driver both create /dev/nvidia0.
  if (p.exists("/dev/nvidia0")) {
    out.push({ vendor: "nvidia", node: "/dev/nvidia0", usable: p.usable("/dev/nvidia0") });
  }
  const renders = p
    .list("/dev/dri")
    .filter((n) => /^renderD\d+$/.test(n))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  for (const r of renders) {
    const id = (p.read(`/sys/class/drm/${r}/device/vendor`) ?? "").trim().toLowerCase();
    const node = `/dev/dri/${r}`;
    out.push({ vendor: PCI_VENDORS[id] ?? "other", node, usable: p.usable(node) });
  }
  return out;
}

/** The backends this install can run: an image's own list, else every build for the platform. */
export function availableBuilds(p: Probe): Accelerator[] {
  const image = p.env.AKOU_ACCELERATORS;
  if (image !== undefined) {
    const listed = image
      .split(",")
      .map((x) => x.trim())
      .filter((x): x is Accelerator => (ACCELERATORS as readonly string[]).includes(x));
    // The CPU image says `cpu,cpu`: its one build is also its fallback.
    return [...new Set(listed)];
  }
  return llamaAccelerators(p.platform);
}

const LABEL: Readonly<Record<Vendor, string>> = {
  nvidia: "an NVIDIA GPU",
  intel: "an Intel GPU",
  amd: "an AMD GPU",
  apple: "Apple silicon",
  other: "a GPU",
};

/** The backend to run and why. A setting this install cannot honour falls back to `auto`'s choice. */
export function chooseAccelerator(
  setting: AcceleratorSetting,
  devices: readonly Device[],
  available: readonly Accelerator[],
): { active: Accelerator; reason: string } {
  const has = (a: Accelerator) => available.includes(a);
  if (setting !== "auto") {
    if (has(setting)) return { active: setting, reason: `asr.accelerator is ${setting}` };
    const auto = chooseAccelerator("auto", devices, available);
    return {
      active: auto.active,
      reason: `asr.accelerator is ${setting}, but this install has builds for ${available.join(", ") || "nothing"} only; ${auto.reason}`,
    };
  }
  const usable = devices.filter((d) => d.usable);
  const at = (d: Device) =>
    d.vendor === "apple" ? LABEL.apple : `${LABEL[d.vendor]} at ${d.node}`;
  const apple = usable.find((d) => d.vendor === "apple");
  if (apple && has("metal")) return { active: "metal", reason: at(apple) };
  const nvidia = usable.find((d) => d.vendor === "nvidia");
  if (nvidia && has("cuda")) return { active: "cuda", reason: at(nvidia) };
  const vk = usable.find((d) => d.vendor !== "apple" && d.vendor !== "nvidia") ?? nvidia;
  if (vk && has("vulkan")) return { active: "vulkan", reason: at(vk) };
  // Nothing to run on: say what was seen and what would make it run.
  const locked = devices.find((d) => !d.usable);
  if (locked) {
    return {
      active: "cpu",
      reason: `${LABEL[locked.vendor]} is at ${locked.node}, but this user cannot open it: add --group-add $(stat -c %g ${locked.node}) to docker run, or its number under group_add in compose`,
    };
  }
  const seen = usable[0];
  if (seen) {
    const image = seen.vendor === "nvidia" ? "-cuda" : "-vulkan";
    return {
      active: "cpu",
      reason: `${at(seen)} is here, but this install has no build for it: run the geiserx/akou:<version>${image} image`,
    };
  }
  return { active: "cpu", reason: "no GPU found" };
}

/** What `GET /v1/server` reports and llama-server is started with. */
export interface AcceleratorState {
  setting: AcceleratorSetting;
  /** The llama-server build akou runs. */
  active: Accelerator;
  /** `active` when it is a GPU, else null. */
  gpu: Exclude<Accelerator, "cpu"> | null;
  /** The GPU's name as llama-server lists it, once verified. */
  device: string | null;
  /** llama-server was run and confirmed the choice. */
  verified: boolean;
  available: readonly Accelerator[];
  reason: string;
}

const gpuOf = (a: Accelerator): AcceleratorState["gpu"] => (a === "cpu" ? null : a);

/** The choice from the setting and the machine, before llama-server is asked. */
export function detectAccelerator(setting: AcceleratorSetting, p: Probe): AcceleratorState {
  const available = availableBuilds(p);
  const { active, reason } = chooseAccelerator(setting, findDevices(p), available);
  return { setting, active, gpu: gpuOf(active), device: null, verified: false, available, reason };
}

/** ggml's device name prefixes, per backend. */
const BACKENDS: Readonly<Record<string, Accelerator>> = {
  MTL: "metal",
  Vulkan: "vulkan",
  CUDA: "cuda",
  SYCL: "sycl",
  ROCm: "rocm",
};

/** The GPU devices in `llama-server --list-devices` output; the host's BLAS entry is not one. */
export function parseDevices(output: string): { backend: Accelerator; name: string }[] {
  const out: { backend: Accelerator; name: string }[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(MTL|Vulkan|CUDA|SYCL|ROCm)\d+: (.*?)(?: \(\d+ MiB, \d+ MiB free\))?\s*$/.exec(
      line,
    );
    const backend = m ? BACKENDS[m[1] as string] : undefined;
    if (m && backend) out.push({ backend, name: m[2] as string });
  }
  return out;
}

/** A Vulkan device that is the CPU: Mesa's llvmpipe (lavapipe) and Google's SwiftShader. */
const SOFTWARE = /\b(llvmpipe|lavapipe|swiftshader)\b/i;

/** The state after llama-server answered: its device list, or the error that kept it from running. */
export function confirmAccelerator(
  state: AcceleratorState,
  answer: { output?: string; error?: string },
): AcceleratorState {
  if (answer.output === undefined) {
    return { ...state, verified: false, reason: `${state.reason}; not verified: ${answer.error}` };
  }
  if (state.active === "cpu") return { ...state, device: null, verified: true };
  const listed = parseDevices(answer.output).filter((d) => d.backend === state.active);
  const gpu = listed.find((d) => !SOFTWARE.test(d.name));
  if (gpu) return { ...state, device: gpu.name, verified: true };
  const what = listed.length
    ? `only ${listed.map((d) => d.name).join(", ")}, a software renderer on the CPU`
    : "nothing";
  return {
    ...state,
    active: "cpu",
    gpu: null,
    device: null,
    verified: true,
    reason: `${state.reason}, but llama-server lists no ${state.active} device (it lists ${what}), so the CPU runs it`,
  };
}

/** The folder a build is unpacked into under the models folder; a Mac's one build serves both backends. */
export function llamaBuildDir(modelsDir: string, build: LlamaBuild): string {
  const first = build.assets[0]?.name ?? "llama";
  return join(modelsDir, "runtimes", first.replace(/\.(tar\.gz|zip)$/, ""));
}

/** llama-server for the active backend: the image's (`AKOU_LLAMA_SERVER`), else a downloaded build, else none. */
export function llamaServerBin(p: Probe, modelsDir: string, active: Accelerator): string | null {
  if (p.env.AKOU_LLAMA_SERVER) return p.env.AKOU_LLAMA_SERVER;
  const build = llamaBuild(p.platform, active);
  if (!build) return null;
  const bin = join(llamaBuildDir(modelsDir, build), llamaServerName(p.platform));
  return p.exists(bin) ? bin : null;
}

/** Runs `<cmd> --list-devices` for at most 15 s: its stdout, or why it failed. */
export async function listDevices(
  cmd: readonly string[],
): Promise<{ output?: string; error?: string }> {
  try {
    const proc = Bun.spawn([...cmd, "--list-devices"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [output, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) {
      const last = err.trim().split("\n").at(-1) ?? "";
      return { error: `llama-server --list-devices exited ${code}${last ? `: ${last}` : ""}` };
    }
    return { output };
  } catch (err) {
    return { error: `llama-server could not start: ${(err as Error).message}` };
  }
}

/** Asks the build which devices it can use, when there is a build to ask. */
export async function verifyAccelerator(
  state: AcceleratorState,
  bin: string | null,
  run: (bin: string) => Promise<{ output?: string; error?: string }> = (b) => listDevices([b]),
): Promise<AcceleratorState> {
  if (bin === null) return state;
  return confirmAccelerator(state, await run(bin));
}
