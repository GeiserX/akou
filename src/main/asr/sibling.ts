/**
 * Where a Worker's module is. From source it is the `.ts` file beside the caller; in the packaged
 * app the release bundles each Worker into a `.js` file beside the bundled main process
 * (`scripts/build-app.ts`), because the ElectroBun bundler leaves `new Worker(new URL(...))` alone
 * and ships no `.ts` file.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function siblingModule(base: string, name: string): URL {
  const ts = new URL(`./${name}.ts`, base);
  if (ts.protocol !== "file:" || existsSync(fileURLToPath(ts))) return ts;
  const js = new URL(`./${name}.js`, base);
  return existsSync(fileURLToPath(js)) ? js : ts;
}
