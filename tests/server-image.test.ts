/**
 * The server image as written (docs/ux/SERVER.md SV-P1, SV-P6): what can be read from the
 * Dockerfile and the workflows without building. The built image is started and asked for
 * `/healthz`, `id -u` and a transcript on both architectures by the `server` job in ci.yml (SV-T1).
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

interface Instruction {
  op: string;
  args: string;
}

/** The Dockerfile's instructions, continuation lines joined, comments dropped. */
export function instructions(dockerfile: string): Instruction[] {
  return dockerfile
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => {
      const m = /^(\S+)\s+(.*)$/.exec(l);
      return { op: (m?.[1] ?? l).toUpperCase(), args: m?.[2] ?? "" };
    });
}

/** The instructions of the last stage: what the shipped image is made of. */
function finalStage(dockerfile: string): Instruction[] {
  const all = instructions(dockerfile);
  const from = all.map((x) => x.op).lastIndexOf("FROM");
  return all.slice(from);
}

/** Every image reference a workflow or Dockerfile tags or pulls as `latest`. */
export function latestTags(text: string): string[] {
  return [...text.matchAll(/[\w./-]+:latest\b/g)]
    .map((m) => m[0])
    .filter((ref) => !/^(ubuntu|macos|windows)-latest$/.test(ref.split("/").pop() ?? ""));
}

describe("[SV-P1] the server image", () => {
  const dockerfile = read("Dockerfile");

  test("both base images are pinned by version and digest", () => {
    const args = instructions(dockerfile).filter((x) => x.op === "ARG" && /_IMAGE=/.test(x.args));
    expect(args.length).toBe(2);
    for (const a of args) expect(a.args).toMatch(/:\d+\.\d+\.\d+[\w.-]*@sha256:[0-9a-f]{64}$/);
    // The runtime's Bun is the repository's Bun.
    expect(dockerfile).toContain(`oven/bun:${read(".bun-version").trim()}-slim@sha256:`);
  });

  test("runs as a non-root user, with AKOU_HOME=/data and AKOU_MODELS_DIR=/models as volumes, and starts akou serve", () => {
    const last = finalStage(dockerfile);
    const user = last.filter((x) => x.op === "USER").at(-1)?.args;
    expect(user).toBeDefined();
    expect(["root", "0", "0:0"]).not.toContain(user as string);
    const env = last
      .filter((x) => x.op === "ENV")
      .map((x) => x.args)
      .join(" ");
    expect(env).toContain("AKOU_HOME=/data");
    expect(env).toContain("AKOU_MODELS_DIR=/models");
    expect(env).toContain("AKOU_SERVER=1");
    const volume = last.find((x) => x.op === "VOLUME")?.args ?? "";
    expect(JSON.parse(volume)).toEqual(["/data", "/models"]);
    expect(last.find((x) => x.op === "EXPOSE")?.args).toBe("8476");
    expect(JSON.parse(last.find((x) => x.op === "ENTRYPOINT")?.args ?? "null")).toEqual(["akou"]);
    expect(JSON.parse(last.find((x) => x.op === "CMD")?.args ?? "null")).toEqual(["serve"]);
    expect(last.find((x) => x.op === "HEALTHCHECK")?.args).toContain("/healthz");
  });

  test("positive control: a root USER, or none, is caught", () => {
    const root = `FROM a@sha256:${"0".repeat(64)}\nUSER root\n`;
    expect(
      finalStage(root)
        .filter((x) => x.op === "USER")
        .at(-1)?.args,
    ).toBe("root");
    const none = `FROM b\nUSER bun\nFROM c\nCMD ["x"]\n`;
    expect(finalStage(none).filter((x) => x.op === "USER")).toEqual([]);
  });

  test("[SV-P6] the runtime stage installs ffmpeg with one apt line", () => {
    const apt = finalStage(dockerfile).filter(
      (x) => x.op === "RUN" && x.args.includes("apt-get install"),
    );
    expect(apt.length).toBe(1);
    expect(apt[0]?.args).toMatch(/--no-install-recommends ffmpeg\b/);
  });

  test("[akou-5an.93] the runtime stage has libgomp1: llama-server's Linux builds load it at start", () => {
    // Without it the pinned build exits with "libgomp.so.1: cannot open shared object file" in
    // the image (checked on oven/bun:1.4.2-slim), and every best job fails.
    const apt = finalStage(dockerfile).filter(
      (x) => x.op === "RUN" && x.args.includes("apt-get install"),
    );
    expect(apt[0]?.args).toMatch(/\blibgomp1\b/);
  });

  test("no image is ever tagged latest, in the Dockerfile or any workflow", () => {
    for (const f of ["Dockerfile", ".github/workflows/release.yml", ".github/workflows/ci.yml"]) {
      expect({ f, latest: latestTags(read(f)) }).toEqual({ f, latest: [] });
    }
    // Positive control: a latest tag is seen, and a runner label is not an image.
    expect(latestTags("docker push drumsergio/akou:latest\nruns-on: ubuntu-latest")).toEqual([
      "drumsergio/akou:latest",
    ]);
  });

  test("the release publishes drumsergio/akou:<version> for amd64 and arm64, built on each architecture's runner", () => {
    const wf = Bun.YAML.parse(read(".github", "workflows", "release.yml")) as {
      jobs: Record<
        string,
        {
          "runs-on"?: string;
          if?: string;
          strategy?: {
            matrix?: { include?: { runner: string; platform: string; variant: string }[] };
          };
          steps?: { run?: string }[];
        }
      >;
    };
    const include = wf.jobs.image?.strategy?.matrix?.include ?? [];
    // Each variant (akou-5an.94) on each architecture's own runner.
    const legs = [];
    for (const variant of ["cpu", "vulkan", "cuda"]) {
      legs.push({ runner: "ubuntu-24.04", platform: "linux/amd64", variant });
      legs.push({ runner: "ubuntu-24.04-arm", platform: "linux/arm64", variant });
    }
    expect(include).toEqual(legs);
    const build = (wf.jobs.image?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(build).toContain('--build-arg ACCELERATOR="$VARIANT"');
    const manifest = wf.jobs["image-manifest"];
    expect(manifest?.if).toContain("github.ref_type == 'tag'");
    const script = (manifest?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(script).toContain('--tag "docker.io/drumsergio/akou:$version$suffix"');
    // The version is the tag without its v: a shell expansion, spelled out so it is not a template.
    expect(script).toContain(`version="$${"{"}TAG#v}"`);
    // A GitHub release never goes out while the image of the same tag failed.
    expect((wf.jobs.release as { needs?: string[] }).needs).toContain("image-manifest");
  });

  test("the build context holds what the image copies and leaves the rest out", () => {
    const ignored = read(".dockerignore")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    for (const needed of ["src", "skills", "package.json", "bun.lock", "native/akou-diarize"]) {
      expect(ignored).not.toContain(needed);
    }
    for (const out of ["node_modules", ".git", "tests", "native/akou-capture"]) {
      expect(ignored).toContain(out);
    }
  });
});

describe("[SV-T1] the server job in ci.yml", () => {
  interface Wf {
    jobs: Record<
      string,
      {
        needs?: string[];
        strategy?: { matrix?: { os?: string[] } };
        steps?: { id?: string; name?: string; run?: string; if?: string }[];
      }
    >;
  }
  /** Why ci.yml's server job would not prove the image, or [] when it would. */
  function serverJobGaps(wf: Wf): string[] {
    const gaps: string[] = [];
    const job = wf.jobs.server;
    if (!job) return ["no server job"];
    const os = job.strategy?.matrix?.os ?? [];
    for (const r of ["ubuntu-24.04", "ubuntu-24.04-arm"]) if (!os.includes(r)) gaps.push(`no ${r}`);
    if (!(wf.jobs["ci-ok"]?.needs ?? []).includes("server")) gaps.push("ci-ok does not need it");
    const runs = (job.steps ?? []).map((st) => st.run ?? "").join("\n");
    for (const want of [
      "docker build",
      "models pull fast",
      // The container binds 0.0.0.0, which SV-P5 refuses without the operator's word that a proxy
      // is in front; install.md publishes the port on loopback and says so in the environment
      // (SV-P11), and the job also watches the image refuse without it and a folder it cannot write.
      "-e AKOU_BEHIND_PROXY=true",
      "exited 78",
      "exited 77",
      "-p 127.0.0.1:8476:8476",
      "http://127.0.0.1:8476/healthz",
      "http://127.0.0.1:8476/v1/server",
      "id -u",
      "scripts/server-smoke.ts",
      "scripts/server-roundtrip.ts",
      // SV-T6: akou from the compose example beside Telegram-Archive.
      "scripts/compose-e2e.sh",
    ]) {
      if (!runs.includes(want)) gaps.push(`no step runs ${want}`);
    }
    // The round trip runs on what the running server says it can do, never on a file name that a
    // rename would turn into a step that never runs, and a skip is a warning on the run.
    const steps = job.steps ?? [];
    const caps = steps.find((st) => st.run?.includes("capabilities.jobs"));
    const roundTrip = steps.find((st) => st.run?.includes("server-roundtrip.ts"));
    if (
      !caps?.id ||
      roundTrip?.if !== `steps.${caps.id}.outputs.roundtrip == 'true'` ||
      !caps.run?.includes("::warning::")
    ) {
      gaps.push("the round trip is not gated on the server's own capabilities, loudly");
    }
    if (steps.some((st) => st.if?.includes("hashFiles")))
      gaps.push("a step is gated on a file name");
    return gaps;
  }

  test("runs on x64 and arm64, is required through ci-ok, and asks the running image everything SV-P1 and SV-P6 need", () => {
    expect(serverJobGaps(Bun.YAML.parse(read(".github", "workflows", "ci.yml")) as Wf)).toEqual([]);
  });

  test("positive control: a server job ci-ok does not wait for, or with no arm64 leg, is caught", () => {
    const wf = Bun.YAML.parse(read(".github", "workflows", "ci.yml")) as Wf;
    const noArm = structuredClone(wf);
    (noArm.jobs.server?.strategy?.matrix as { os: string[] }).os = ["ubuntu-24.04"];
    expect(serverJobGaps(noArm)).toEqual(["no ubuntu-24.04-arm"]);
    const notRequired = structuredClone(wf);
    (notRequired.jobs["ci-ok"] as { needs: string[] }).needs = ["changes", "check"];
    expect(serverJobGaps(notRequired)).toEqual(["ci-ok does not need it"]);
    const byFile = structuredClone(wf);
    const rt = byFile.jobs.server?.steps?.find((st) => st.run?.includes("server-roundtrip.ts"));
    (rt as { if: string }).if = "hashFiles('src/main/api/routes/jobs.ts') != ''";
    expect(serverJobGaps(byFile)).toEqual([
      "the round trip is not gated on the server's own capabilities, loudly",
      "a step is gated on a file name",
    ]);
  });
});

/** Runs a workflow step's script with bash, a fake `docker` on PATH that records its arguments. */
function runStep(
  script: string,
  env: Record<string, string>,
): { code: number; out: string; docker: string } {
  const dir = mkdtempSync(join(tmpdir(), "akou-step-"));
  try {
    const log = join(dir, "docker.log");
    writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$@" >> "${log}"\ncat > /dev/null\n`);
    chmodSync(join(dir, "docker"), 0o755);
    const r = Bun.spawnSync(["bash", "-e", "-c", script], {
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    let docker = "";
    try {
      docker = readFileSync(log, "utf8");
    } catch {}
    return { code: r.exitCode, out: `${r.stdout}${r.stderr}`, docker };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("[SV-P1] Docker Hub credentials on a tag", () => {
  // The step is a bash script with a fake `docker`, which Windows runs neither of.
  test.skipIf(process.platform === "win32")(
    "each login step fails naming both secrets when either is missing, before docker runs (skipped on Windows: no bash)",
    () => {
      const wf = Bun.YAML.parse(read(".github", "workflows", "release.yml")) as {
        jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
      };
      const logins = ["image", "image-manifest"].map(
        (j) =>
          wf.jobs[j]?.steps?.find((s) => s.name?.startsWith("log in to Docker Hub"))?.run ?? "",
      );
      expect(logins.every((r) => r.includes("docker login"))).toBe(true);
      for (const run of logins) {
        for (const env of [
          { DOCKERHUB_USERNAME: "", DOCKERHUB_TOKEN: "" },
          { DOCKERHUB_USERNAME: "u", DOCKERHUB_TOKEN: "" },
          { DOCKERHUB_USERNAME: "", DOCKERHUB_TOKEN: "t" },
        ]) {
          const r = runStep(run, env);
          expect(r.code).not.toBe(0);
          expect(r.out).toContain("DOCKERHUB_USERNAME");
          expect(r.out).toContain("DOCKERHUB_TOKEN");
          expect(r.docker).toBe("");
        }
        // Positive control: with both set, the step logs in.
        const ok = runStep(run, { DOCKERHUB_USERNAME: "u", DOCKERHUB_TOKEN: "t" });
        expect([ok.code, ok.docker.trim()]).toEqual([0, "login --username u --password-stdin"]);
      }
    },
  );
});

describe("[akou-5an.94] the GPU image variants", () => {
  const dockerfile = read("Dockerfile");
  const last = finalStage(dockerfile);

  test("the llama stage copies every file the fetch imports, so a new import cannot break the image", () => {
    const copy = instructions(dockerfile).find(
      (x) => x.op === "COPY" && x.args.startsWith("src/main/asr/llama-builds.ts"),
    );
    const copied = (copy?.args ?? "").split(/\s+/).slice(0, -1);
    // Every file llama-builds.ts reaches through value imports; type imports vanish at run time.
    const reached = new Set<string>();
    const todo = ["src/main/asr/llama-builds.ts"];
    while (todo.length > 0) {
      const file = todo.pop() as string;
      if (reached.has(file)) continue;
      reached.add(file);
      for (const m of read(file).matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)";/gm)) {
        todo.push(join(file, "..", m[1] as string));
      }
    }
    expect(reached.size).toBeGreaterThan(1);
    expect(copied.sort()).toEqual([...reached].sort());
  });

  test("one Dockerfile builds every variant from ACCELERATOR, default cpu, with akou's pinned llama-server", () => {
    const all = instructions(dockerfile);
    expect(
      all.filter((x) => x.op === "ARG" && x.args.startsWith("ACCELERATOR=")).map((x) => x.args),
    ).toContain("ACCELERATOR=cpu");
    // The build is fetched by the same pinned table akou reads (llama-builds.ts), never by a URL here.
    const fetch = all.find(
      (x) => x.op === "RUN" && x.args.includes("src/main/asr/llama-builds.ts"),
    );
    expect(fetch?.args).toContain('fetchForHost(process.env.ACCELERATOR, "/opt/llama")');
    expect(dockerfile).not.toMatch(/releases\/download/);
    expect(last.some((x) => x.op === "COPY" && x.args.includes("/opt/llama /opt/llama"))).toBe(
      true,
    );
    const env = last
      .filter((x) => x.op === "ENV")
      .map((x) => x.args)
      .join(" ");
    // A Dockerfile expansion, spelled out so it is not a template.
    expect(env).toContain(`AKOU_ACCELERATORS=$${"{"}ACCELERATOR},cpu`);
    expect(env).toContain("AKOU_LLAMA_SERVER=/opt/llama/llama-server");
    // --gpus all hands the driver's compute libraries to the CUDA image.
    expect(env).toContain("NVIDIA_DRIVER_CAPABILITIES=compute,utility");
  });

  test("the Vulkan variant brings Mesa's drivers (Intel and AMD) and every variant brings OpenMP, in the one apt line", () => {
    const apt = last.find((x) => x.op === "RUN" && x.args.includes("apt-get install"))?.args ?? "";
    expect(apt).toMatch(/vulkan\) gpu="mesa-vulkan-drivers libvulkan1"/);
    expect(apt).toMatch(/--no-install-recommends ffmpeg libgomp1 \$gpu\b/);
    // The image checks its llama-server loads before it ships.
    expect(
      last.some((x) => x.op === "RUN" && x.args.includes("/opt/llama/llama-server --version")),
    ).toBe(true);
  });

  // The step is a bash script with a fake `docker`, which Windows runs neither of.
  test.skipIf(process.platform === "win32")(
    "a tag publishes <version>, <version>-vulkan and <version>-cuda, each over both architectures (skipped on Windows: no bash)",
    () => {
      const wf = Bun.YAML.parse(read(".github", "workflows", "release.yml")) as {
        jobs: Record<string, { steps?: { name?: string; run?: string }[] }>;
      };
      const step = wf.jobs["image-manifest"]?.steps?.find((s) =>
        s.run?.includes("imagetools create"),
      );
      const dir = mkdtempSync(join(tmpdir(), "akou-digests-"));
      try {
        mkdirSync(join(dir, "digests"));
        for (const v of ["cpu", "vulkan", "cuda"])
          for (const a of ["amd64", "arm64"])
            writeFileSync(join(dir, "digests", `${v}-linux-${a}`), `sha256:${v}${a}\n`);
        const r = runStep(`cd ${dir}\n${step?.run ?? "exit 9"}`, { TAG: "v0.3.0" });
        expect({ code: r.code, out: r.out }).toMatchObject({ code: 0 });
        const creates = r.docker.split("\n").filter((l) => l.includes("imagetools create"));
        expect(creates).toEqual([
          "buildx imagetools create --tag docker.io/drumsergio/akou:0.3.0 docker.io/drumsergio/akou@sha256:cpuamd64 docker.io/drumsergio/akou@sha256:cpuarm64",
          "buildx imagetools create --tag docker.io/drumsergio/akou:0.3.0-vulkan docker.io/drumsergio/akou@sha256:vulkanamd64 docker.io/drumsergio/akou@sha256:vulkanarm64",
          "buildx imagetools create --tag docker.io/drumsergio/akou:0.3.0-cuda docker.io/drumsergio/akou@sha256:cudaamd64 docker.io/drumsergio/akou@sha256:cudaarm64",
        ]);
        // Positive control: a variant missing one architecture stops the release.
        rmSync(join(dir, "digests", "cuda-linux-arm64"));
        expect(runStep(`cd ${dir}\n${step?.run ?? ""}`, { TAG: "v0.3.0" }).code).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    // Two runs of a shell script with seven fake docker calls each: slow on a loaded runner.
    20_000,
  );

  test("ci.yml builds the GPU variants on both architectures and asks each what it runs on, under ci-ok", () => {
    const wf = Bun.YAML.parse(read(".github", "workflows", "ci.yml")) as {
      jobs: Record<
        string,
        {
          needs?: string[];
          if?: string;
          strategy?: { matrix?: { os?: string[]; variant?: string[] } };
          steps?: { run?: string }[];
        }
      >;
    };
    const job = wf.jobs["gpu-image"];
    expect(job?.strategy?.matrix?.os).toEqual(["ubuntu-24.04", "ubuntu-24.04-arm"]);
    expect(job?.strategy?.matrix?.variant).toEqual(["vulkan", "cuda"]);
    expect(job?.if).toBe("needs.changes.outputs.gpu == 'true'");
    expect(wf.jobs["ci-ok"]?.needs).toContain("gpu-image");
    const runs = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");
    for (const want of [
      '--build-arg ACCELERATOR="$VARIANT"',
      "/opt/llama/llama-server --version",
      // The Vulkan loader and Mesa's driver really load: llvmpipe shows once it is made visible.
      "GGML_VK_VISIBLE_DEVICES=0",
      "Vulkan0: llvmpipe",
      // Every CUDA library resolves in the image but the driver's own.
      "ldd /opt/llama/libggml-cuda.so",
      "scripts/accelerator-report.ts",
    ]) {
      expect({ want, found: runs.includes(want) }).toEqual({ want, found: true });
    }
  });
});
