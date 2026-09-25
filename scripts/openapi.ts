/**
 * Writes the OpenAPI 3.1 file, `docs/api/openapi.json`, from the route table (docs/ux/
 * PROGRAMMABILITY.md PG-A2). The file is generated, never edited: `tests/openapi.test.ts`
 * regenerates it on every CI run and fails when the committed copy differs.
 *
 *   bun scripts/openapi.ts           write the file
 *   bun scripts/openapi.ts --check   exit 1 when the committed file differs from the route table
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildOpenApi } from "../src/main/api/openapi.ts";
import { buildRouter } from "../src/main/api/server.ts";
import { APP_VERSION } from "../src/main/app-info.ts";

export const OPENAPI_FILE = join(import.meta.dir, "..", "docs", "api", "openapi.json");

/** The file as the route table generates it, byte for byte. */
export function renderOpenApi(entries = buildRouter().entries()): string {
  return `${JSON.stringify(buildOpenApi(entries, { version: APP_VERSION }), null, 2)}\n`;
}

/** Whether the committed file is exactly the generated one (line endings aside). */
export function openApiDrifted(committed: string, generated = renderOpenApi()): boolean {
  return committed.replace(/\r\n/g, "\n") !== generated;
}

if (import.meta.main) {
  const generated = renderOpenApi();
  if (process.argv.includes("--check")) {
    const committed = existsSync(OPENAPI_FILE) ? readFileSync(OPENAPI_FILE, "utf8") : "";
    if (openApiDrifted(committed, generated)) {
      console.error("docs/api/openapi.json differs from the route table: run bun run openapi");
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(OPENAPI_FILE), { recursive: true });
    writeFileSync(OPENAPI_FILE, generated);
  }
}
