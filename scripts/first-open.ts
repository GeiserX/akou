/**
 * The first open of a newly installed macOS app, as a person or the command line does it, in the
 * desktop session of the machine it runs on (docs/TRAPS.md "Minutes to start"):
 *
 *   bun scripts/first-open.ts [--zip FILE]
 *
 * It unpacks the release zip (by default the one `build-app.ts` made) into a scratch folder, opens
 * the wrapper through LaunchServices with a scratch `AKOU_HOME` and a free port, waits for the
 * unpacked app to answer, and then checks that:
 *
 * - no launcher of the bundle is left with nothing below it. The wrapper used to stay, waiting on
 *   its "Installation complete" panel for a click, and every later `open` took it for the running
 *   app and started nothing;
 * - the wrapper left on its own: the app's `app.log` has no line about stopping a launcher, which
 *   is what the app does at its start for a wrapper that stayed.
 *
 * It ends the app it started and exits 1 when a check fails. Run against the released 0.6.5 it
 * fails the first one, with the wrapper still there 20 s on, which is the proof that it can.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_LOG } from "../src/main/app-log.ts";
import { probe, processTable, stopAll, stopList, strayLaunchers } from "../src/main/cli/heal.ts";
import { RELEASE_DIR, ROOT, releaseName } from "./build-app.ts";
import { sourceVersion } from "./stamp-version.ts";

/** How long the unpacked app has to answer: unpacking, Gatekeeper's first look, a cold start. */
const UP_MS = 120_000;
/** How long a launcher may still be there once the app answers. */
const GONE_MS = 20_000;

let failures = 0;
function check(ok: boolean, what: string, detail = ""): boolean {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

// clock: this script waits on real processes.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(argv: string[]): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("first-open: the wrapper that unpacks the app on its first open is macOS's");
    process.exit(1);
  }
  const i = argv.indexOf("--zip");
  const zip =
    i >= 0 ? (argv[i + 1] as string) : join(RELEASE_DIR, `${releaseName(sourceVersion(ROOT))}.zip`);
  if (!existsSync(zip)) {
    console.error(`first-open: no zip at ${zip}; run bun scripts/build-app.ts first`);
    process.exit(1);
  }
  // The path as the process list shows it: macOS's temporary folder is behind a link.
  const work = realpathSync(mkdtempSync(join(tmpdir(), "akou-first-open-")));
  const app = join(work, "akou.app");
  const home = join(work, "home");
  const config = join(home, ".config", "akou");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.json"), JSON.stringify({ "api.port": await freePort() }));
  const unpack = spawnSync("/usr/bin/ditto", ["-x", "-k", zip, work]);
  if (unpack.status !== 0 || !existsSync(app)) {
    console.error(`first-open: could not unpack ${zip}: ${unpack.stderr}`);
    process.exit(1);
  }

  let appPid = 0;
  try {
    // As the command line starts it (src/main/cli/client.ts `defaultLaunch`).
    spawn("/usr/bin/open", ["-g", "-j", "-a", app, "--env", "AKOU_HEADLESS=1"], {
      stdio: "inherit",
      env: { ...process.env, AKOU_HOME: home },
    });
    const t0 = performance.now();
    while (appPid === 0 && performance.now() - t0 < UP_MS) {
      await sleep(250);
      try {
        const rt = JSON.parse(readFileSync(join(config, "runtime.json"), "utf8"));
        if ((await probe(rt.port, 2000)) === "answers") appPid = rt.pid;
      } catch {}
    }
    const took = `${Math.round((performance.now() - t0) / 100) / 10} s`;
    if (!check(appPid > 0, "the unpacked app answers after the first open", took)) return;

    let left: number[] = [];
    const t1 = performance.now();
    do {
      const rows = await processTable();
      left = rows ? strayLaunchers(rows, app, appPid) : [-1];
      if (left.length > 0) await sleep(500);
    } while (left.length > 0 && performance.now() - t1 < GONE_MS);
    // What the bundle runs now, for whoever reads the job's log.
    for (const r of (await processTable()) ?? []) {
      if (r.args.includes(`${app}/Contents/`)) console.log(`     ${r.pid} ${r.ppid} ${r.args}`);
    }
    check(
      left.length === 0,
      "no launcher of the bundle is left with nothing below it",
      left.length > 0 ? `pid ${left.join(", ")} still there ${GONE_MS / 1000} s on` : "",
    );
    const log = existsSync(join(config, APP_LOG))
      ? readFileSync(join(config, APP_LOG), "utf8")
      : "";
    const stopped = log.split("\n").find((l) => l.includes("left with nothing below"));
    check(!stopped, "the wrapper exited on its own, the app did not have to stop it", stopped);
  } finally {
    const rows = await processTable();
    if (rows) {
      const inside = `${app}/Contents/`;
      const ours = rows.filter((r) => r.args.trim().startsWith(inside)).map((r) => r.pid);
      await stopAll([...(appPid ? stopList(rows, appPid) : []), ...ours]);
    }
    rmSync(work, { recursive: true, force: true });
  }
}

await main(process.argv.slice(2));
if (failures > 0) {
  console.error(`first-open: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("first-open: the first open leaves nothing behind");
