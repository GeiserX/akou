/**
 * The Executor round trip of docs/research/service-interface.md SI-2: a real Executor adds akou
 * from the served `GET /v1/openapi.json?scope=jobs`, and the tools and the auth it derives are the
 * ones section 5 promises.
 *
 *   bun scripts/ci/executor-roundtrip.ts --executor PATH
 *
 * `PATH` is the `executor` program, `executor@1.6.8` from npm. Everything Executor writes goes to
 * a throwaway home and data folder, and its daemon listens on a free port, so no Executor the
 * machine already runs is touched.
 *
 * 1. An akou API server in server mode starts over an inert app, with the real route table. Each
 *    server-mode route not built yet (SERVER.md SV-J, SI-3) comes from the test fixture
 *    (`tests/fixtures/openapi-routes.ts`), only where the table has no route of that method and
 *    path, and the run names them. A real route always wins, so the file describes it. The file
 *    itself, its generation, the guard and the view are the real ones either way.
 * 2. `openapi addSpec` against the `?scope=jobs` URL, then `executor resume --action accept`.
 * 3. Executor's own store must hold the tools `jobs.create`, `jobs.get` and `keys.me`, no
 *    `openai.transcribe`, exactly one auth template, and `jobs.create` must take a file argument.
 * 4. Positive control: the same against a server that demands a key on the file must fail.
 *
 * Exits 0 when the round trip passes and the control fails as it should.
 */

import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Guard, guard } from "../../src/main/api/guard.ts";
import {
  type ApiApp,
  type ApiServer,
  buildRouter,
  startApiServer,
} from "../../src/main/api/server.ts";
import { APP_VERSION } from "../../src/main/app-info.ts";
import { addFixtureRoutes } from "../../tests/fixtures/openapi-routes.ts";

const JOBS_TOOLS = ["jobs.create", "jobs.get", "keys.me"] as const;
const STEP_MS = 120_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The OpenAPI route reads only these; anything else a request reaches refuses with 418. */
function inertApp(): ApiApp {
  return {
    version: APP_VERSION,
    mode: () => "server",
    config: () => ({ settings: {} }),
  } as unknown as ApiApp;
}

function akou(g?: Guard): { server: ApiServer; fixture: string[] } {
  const router = buildRouter();
  const fixture = addFixtureRoutes(router);
  const server = startApiServer({
    app: inertApp(),
    port: 0,
    token: () => "t".repeat(64),
    router,
    guard: g,
  });
  return { server, fixture };
}

interface Run {
  code: number;
  out: string;
}

/** Executor's store keeps its JSON columns as text or as bytes. */
type Text = string | Uint8Array;
const text = (t: Text) => (typeof t === "string" ? t : new TextDecoder().decode(t));

class Executor {
  readonly env: Record<string, string>;
  private daemon: ReturnType<typeof Bun.spawn> | null = null;

  constructor(
    readonly bin: string,
    readonly dir: string,
  ) {
    for (const d of ["home", "data", "scope"]) mkdirSync(join(dir, d), { recursive: true });
    this.env = {
      PATH: process.env.PATH ?? "",
      HOME: join(dir, "home"),
      USERPROFILE: join(dir, "home"),
      EXECUTOR_DATA_DIR: join(dir, "data"),
      EXECUTOR_SCOPE_DIR: join(dir, "scope"),
      EXECUTOR_DISABLE_ANALYTICS: "1",
      EXECUTOR_DISABLE_UPDATE_CHECK: "1",
      NO_PROXY: "127.0.0.1,localhost",
    };
  }

  async run(args: string[]): Promise<Run> {
    const p = Bun.spawn([this.bin, ...args], { env: this.env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), STEP_MS);
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    clearTimeout(timer);
    return { code: await p.exited, out: `${out}${err}` };
  }

  /** Starts the daemon on a free port and makes it the CLI's default server. */
  async start(): Promise<void> {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    this.daemon = Bun.spawn([this.bin, "daemon", "run", "--port", String(port), "--foreground"], {
      env: this.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const url = `http://localhost:${port}`;
    const until = Date.now() + STEP_MS;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        await res.arrayBuffer();
        break;
      } catch {
        if (Date.now() > until) throw new Error(`the Executor daemon did not answer on ${url}`);
        await Bun.sleep(250);
      }
    }
    const added = await this.run(["server", "add", "local", url, "--default"]);
    if (added.code !== 0) throw new Error(`executor server add: ${added.out}`);
  }

  /** `openapi addSpec`, then the approval it pauses for. The resume's JSON answer. */
  async addSpec(url: string, slug: string): Promise<{ ok: boolean; error?: { message?: string } }> {
    const input = JSON.stringify({
      spec: { kind: "url", url },
      slug,
      healthCheck: { operation: "keys.me", identityField: "name" },
    });
    const paused = await this.run(["call", "executor", "openapi", "addSpec", input]);
    const id = /executionId: (exec_[0-9a-f-]+)/.exec(paused.out)?.[1];
    if (!id) throw new Error(`addSpec did not pause for approval:\n${paused.out}`);
    const resumed = await this.run(["resume", "--execution-id", id, "--action", "accept"]);
    const start = resumed.out.indexOf("{");
    const end = resumed.out.lastIndexOf("}");
    try {
      return JSON.parse(resumed.out.slice(start, end + 1));
    } catch {
      throw new Error(`executor resume answered no JSON:\n${resumed.out}`);
    }
  }

  /** What Executor stored for an integration: its tool names, auth templates and operations. */
  stored(slug: string): { tools: string[]; templates: unknown[]; ops: Map<string, unknown> } {
    const db = new Database(join(this.dir, "data", "data.db"), { readonly: true });
    try {
      const row = db
        .query<{ config: Text }, [string]>("select config from integration where slug = ?")
        .get(slug);
      const templates = row ? (JSON.parse(text(row.config)).authenticationTemplate ?? []) : [];
      const ops = new Map<string, unknown>();
      for (const r of db
        .query<{ data: Text }, []>(
          "select data from plugin_storage where plugin_id = 'openapi' and collection = 'operation'",
        )
        .all()) {
        const d = JSON.parse(text(r.data)) as { integration: string; toolName: string };
        if (d.integration === slug) ops.set(d.toolName, d);
      }
      return { tools: [...ops.keys()].sort(), templates, ops };
    } finally {
      db.close();
    }
  }

  async stop(): Promise<void> {
    await this.run(["daemon", "stop"]).catch(() => {});
    this.daemon?.kill();
    await this.daemon?.exited;
  }
}

/** Whether `jobs.create` takes its `file` part as a file argument. */
function takesFile(op: unknown): boolean {
  const props = (
    op as { binding?: { requestBody?: { schema?: { properties?: Record<string, unknown> } } } }
  ).binding?.requestBody?.schema?.properties;
  return JSON.stringify(props?.file ?? null).includes('"ToolFile"');
}

async function main(): Promise<number> {
  const bin = arg("--executor");
  if (!bin) {
    console.error("usage: bun scripts/ci/executor-roundtrip.ts --executor PATH");
    return 2;
  }
  const dir = mkdtempSync(join(tmpdir(), "akou-executor-"));
  const exe = new Executor(bin, dir);
  const open = akou();
  // The positive control: the guard with the file's `access: "open"` ignored.
  const strict = akou((req, ctx) => guard(req, { ...ctx, route: { access: "admin" } }));
  const lines: string[] = [];
  const failures: string[] = [];
  try {
    const version = await exe.run(["--version"]);
    lines.push(`- Executor: ${version.out.trim()}`);
    lines.push(
      open.fixture.length > 0
        ? `- Not built yet, from the test fixture: ${open.fixture.join(", ")}`
        : "- Every route is the route table's own",
    );
    await exe.start();

    const added = await exe.addSpec(`${open.server.url}/openapi.json?scope=jobs`, "akou");
    if (!added.ok) failures.push(`addSpec failed: ${JSON.stringify(added)}`);
    const s = exe.stored("akou");
    lines.push(`- Tools: ${s.tools.join(", ") || "none"}`);
    lines.push(`- Auth templates: ${s.templates.length}`);
    for (const t of JOBS_TOOLS) if (!s.tools.includes(t)) failures.push(`no ${t} tool`);
    if (s.tools.includes("openai.transcribe")) failures.push("openai.transcribe is a tool");
    if (s.tools.some((t) => t.startsWith("calls."))) failures.push("a call route is a tool");
    if (s.templates.length !== 1) failures.push(`${s.templates.length} auth templates, not 1`);
    if (!takesFile(s.ops.get("jobs.create"))) failures.push("jobs.create takes no file argument");

    const control = await exe.addSpec(
      `${strict.server.url}/openapi.json?scope=jobs`,
      "akou-control",
    );
    lines.push(
      `- Positive control, a server that wants a key on the file: ${
        control.ok ? "added (wrong)" : `refused: ${control.error?.message ?? "?"}`
      }`,
    );
    if (control.ok) failures.push("the control added a spec that demands a key");
  } catch (err) {
    failures.push((err as Error).message);
  } finally {
    await exe.stop();
    await open.server.stop();
    await strict.server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  const report = [
    "### Executor round trip (SI-2)",
    "",
    ...lines,
    "",
    failures.length === 0 ? "Passed." : `Failed:\n${failures.map((f) => `- ${f}`).join("\n")}`,
  ].join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
