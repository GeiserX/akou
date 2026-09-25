/**
 * The server image as written (docs/ux/SERVER.md SV-P1, SV-P6): what can be read from the
 * Dockerfile and the workflows without building. The built image is started and asked for
 * `/healthz`, `id -u` and a transcript on both architectures by the `server` job in ci.yml (SV-T1).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("no image is ever tagged latest, in the Dockerfile or any workflow", () => {
    for (const f of ["Dockerfile", ".github/workflows/release.yml", ".github/workflows/ci.yml"]) {
      expect({ f, latest: latestTags(read(f)) }).toEqual({ f, latest: [] });
    }
    // Positive control: a latest tag is seen, and a runner label is not an image.
    expect(latestTags("docker push geiserx/akou:latest\nruns-on: ubuntu-latest")).toEqual([
      "geiserx/akou:latest",
    ]);
  });

  test("the release publishes geiserx/akou:<version> for amd64 and arm64, built on each architecture's runner", () => {
    const wf = Bun.YAML.parse(read(".github", "workflows", "release.yml")) as {
      jobs: Record<
        string,
        {
          "runs-on"?: string;
          if?: string;
          strategy?: { matrix?: { include?: { runner: string; platform: string }[] } };
          steps?: { run?: string }[];
        }
      >;
    };
    const include = wf.jobs.image?.strategy?.matrix?.include ?? [];
    expect(include).toEqual([
      { runner: "ubuntu-24.04", platform: "linux/amd64" },
      { runner: "ubuntu-24.04-arm", platform: "linux/arm64" },
    ]);
    const manifest = wf.jobs["image-manifest"];
    expect(manifest?.if).toContain("github.ref_type == 'tag'");
    const script = (manifest?.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(script).toContain('--tag "docker.io/geiserx/akou:$version"');
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
      // is in front; install.md publishes the port on loopback and says so in the data volume.
      '"server.behind_proxy": true',
      "-p 127.0.0.1:8476:8476",
      "http://127.0.0.1:8476/healthz",
      "http://127.0.0.1:8476/v1/server",
      "id -u",
      "scripts/server-smoke.ts",
      "scripts/server-roundtrip.ts",
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
