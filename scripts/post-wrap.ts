/**
 * ElectroBun's `postWrap` build hook (`electrobun.config.ts`): runs after the release wrapper is
 * assembled and before it is signed. On macOS it patches the usage strings into `Info.plist`
 * (`patch-plist.sh`), so the signature covers them. Hutch runs this file with Cottontail, so it uses
 * only standard Node APIs.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.ELECTROBUN_OS === "macos") {
  const bundle = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
  if (!bundle) throw new Error("postWrap: ELECTROBUN_WRAPPER_BUNDLE_PATH is not set");
  const script = fileURLToPath(new URL("./patch-plist.sh", import.meta.url));
  const r = spawnSync("/bin/sh", [script, bundle], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`patch-plist.sh exited ${r.status}`);
}
