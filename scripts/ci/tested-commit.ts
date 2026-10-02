/**
 * A release publishes only a commit CI already passed (docs/CI-CD.md CI-19). The release workflow
 * runs this on the tagged commit instead of running `bun run check` a second time: it finds the
 * newest `ci.yml` run for the commit and its `ci-ok` job, waits while that run is still going, and
 * exits 1 unless `ci-ok` passed.
 *
 *   bun scripts/ci/tested-commit.ts <sha> [--wait-minutes 90]
 *
 * Reads GITHUB_REPOSITORY and GITHUB_TOKEN (the job needs `actions: read`). A red `ci-ok` stops the
 * release: rerun the failed legs of that CI run, then rerun the release's failed jobs.
 */

export interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export interface Job {
  name: string;
  status: string;
  conclusion: string | null;
}

export type Verdict = { state: "green" } | { state: "wait" | "stop"; why: string };

/** What the newest CI run of a commit and its `ci-ok` job say about releasing it. */
export function verdict(sha: string, run: Run | null, ciOk: Job | null): Verdict {
  if (!run)
    return {
      state: "stop",
      why: `ci.yml never ran on ${sha}; tag a commit on main that CI tested`,
    };
  if (run.status !== "completed")
    return { state: "wait", why: `CI is ${run.status} on ${sha}: ${run.html_url}` };
  if (!ciOk)
    return { state: "stop", why: `the CI run of ${sha} has no ci-ok job: ${run.html_url}` };
  if (ciOk.conclusion !== "success")
    return {
      state: "stop",
      why: `ci-ok is ${ciOk.conclusion ?? ciOk.status} on ${sha}: ${run.html_url}. Rerun its failed legs, then rerun this release`,
    };
  return { state: "green" };
}

async function api<T>(repo: string, path: string, token: string): Promise<T> {
  const r = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function look(repo: string, sha: string, token: string): Promise<Verdict> {
  const runs = await api<{ workflow_runs: Run[] }>(
    repo,
    `actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`,
    token,
  );
  // Newest first; a rerun keeps its run, so the newest run carries the newest attempt.
  const run = runs.workflow_runs[0] ?? null;
  if (run?.status !== "completed") return verdict(sha, run, null);
  const jobs = await api<{ jobs: Job[] }>(
    repo,
    `actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    token,
  );
  return verdict(sha, run, jobs.jobs.find((j) => j.name === "ci-ok") ?? null);
}

export async function main(argv: string[]): Promise<number> {
  const sha = argv[0];
  const at = argv.indexOf("--wait-minutes");
  const waitMinutes = at === -1 ? 90 : Number(argv[at + 1]);
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !repo || !token || !(waitMinutes >= 0)) {
    console.error(
      "usage: GITHUB_REPOSITORY=o/r GITHUB_TOKEN=... bun scripts/ci/tested-commit.ts <40-hex sha> [--wait-minutes n]",
    );
    return 64;
  }
  const deadline = Date.now() + waitMinutes * 60_000;
  for (;;) {
    const v = await look(repo, sha, token);
    if (v.state === "green") {
      console.log(`tested-commit: ci-ok passed on ${sha}`);
      return 0;
    }
    if (v.state === "stop" || Date.now() >= deadline) {
      console.error(
        `tested-commit: ${v.why}${v.state === "wait" ? `; gave up after ${waitMinutes} min` : ""}`,
      );
      return 1;
    }
    console.log(`tested-commit: waiting, ${v.why}`);
    await Bun.sleep(30_000);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
