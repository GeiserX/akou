import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { largeCacheReexec } from "../src/main/cli/large-cache.ts";

// macOS keeps about 560 MB of a released model in its large-allocation cache unless the process
// starts with MallocLargeCache=0, and no call clears that cache later. A server started by a
// LaunchDaemon or a shell gets it by starting itself again with the variable.

const base = {
  platform: "darwin",
  env: { HOME: "/Users/a", PATH: "/usr/bin" } as Record<string, string | undefined>,
  argv: ["bun", "/src/main/cli/cli.ts", "serve", "--json"],
  execPath: "/opt/bun",
  compiled: false,
};

describe("a macOS server turns the large-allocation cache off", () => {
  test("serve without the variable starts again with it, same arguments", () => {
    const r = largeCacheReexec(base);
    expect(r?.path).toBe("/opt/bun");
    expect(r?.args).toEqual(["/opt/bun", "/src/main/cli/cli.ts", "serve", "--json"]);
    expect(r?.env).toContain("MallocLargeCache=0");
    expect(r?.env).toContain("HOME=/Users/a");
  });

  test("Bun's own flags before the entry are kept", () => {
    const r = largeCacheReexec({ ...base, execArgv: ["--smol"] });
    expect(r?.args).toEqual(["/opt/bun", "--smol", "/src/main/cli/cli.ts", "serve", "--json"]);
  });

  test("a compiled akou does not pass its own virtual entry on", () => {
    const r = largeCacheReexec({
      ...base,
      argv: ["bun", "/$bunfs/root/akou", "serve"],
      execPath: "/usr/local/bin/akou",
      compiled: true,
    });
    expect(r?.args).toEqual(["/usr/local/bin/akou", "serve"]);
  });

  test("nothing changes once the variable is set, off macOS, or for another command", () => {
    // The positive control above is the same call with only these three inputs differing.
    expect(largeCacheReexec({ ...base, env: { ...base.env, MallocLargeCache: "0" } })).toBeNull();
    expect(largeCacheReexec({ ...base, platform: "linux" })).toBeNull();
    expect(largeCacheReexec({ ...base, argv: ["bun", "/cli.ts", "status"] })).toBeNull();
  });

  test.skipIf(process.platform !== "darwin")(
    "the re-exec keeps the pid and sets the variable (macOS only)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "akou-large-cache-"));
      const file = join(dir, "probe.ts");
      writeFileSync(
        file,
        `import { execve, largeCacheReexec } from ${JSON.stringify(join(import.meta.dir, "..", "src", "main", "cli", "large-cache.ts"))};
console.log(process.pid, process.env.MallocLargeCache ?? "unset");
const again = largeCacheReexec({ platform: process.platform, env: process.env, argv: process.argv, execPath: process.execPath, compiled: false });
if (again) execve(again.path, again.args, again.env);
`,
      );
      const env = { ...process.env };
      delete env.MallocLargeCache;
      const r = spawnSync(process.execPath, [file, "serve"], { env, encoding: "utf8" });
      rmSync(dir, { recursive: true, force: true });
      const lines = r.stdout.trim().split("\n");
      // Once without the variable, once with it, and the same process both times.
      expect(lines).toHaveLength(2);
      const [before, after] = lines.map((l) => l.split(" "));
      expect(before?.[1]).toBe("unset");
      expect(after?.[1]).toBe("0");
      expect(after?.[0]).toBe(before?.[0]);
    },
  );
});
