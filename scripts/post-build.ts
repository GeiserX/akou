/**
 * ElectroBun's `postBuild` build hook (`electrobun.config.ts`): runs after the app bundle is built
 * and before Hutch signs it and the stable wrapper packs it. The inner bundle is the app that runs
 * once the wrapper has extracted it, so its `Info.plist` must carry both usage strings too, or
 * macOS never asks for the System Audio Recording grant (TRAPS "Info.plist cannot carry the
 * system-audio usage string"). `post-wrap.ts` patches the wrapper's. Hutch runs this file with
 * Cottontail, so it uses only standard Node APIs.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.ELECTROBUN_OS === "macos") {
  const dir = process.env.ELECTROBUN_BUILD_DIR;
  if (!dir || !existsSync(dir)) throw new Error(`postBuild: no build folder (${dir ?? "unset"})`);
  const apps = readdirSync(dir).filter((f) => f.endsWith(".app"));
  if (apps.length === 0) throw new Error(`postBuild: no .app in ${dir}`);
  const script = fileURLToPath(new URL("./patch-plist.sh", import.meta.url));
  for (const app of apps) {
    const r = spawnSync("/bin/sh", [script, join(dir, app)], { stdio: "inherit" });
    if (r.status !== 0) throw new Error(`patch-plist.sh exited ${r.status} on ${app}`);
  }
}
