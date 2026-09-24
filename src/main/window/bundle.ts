/**
 * The window's static bundle (docs/DESIGN.md sections 7 and 10): `src/ui` built with Bun's bundler
 * for the browser, plain TypeScript and DOM, no framework. Two pages come out of it:
 *
 * - `index.html`, `index.js`, `theme.css`: the window. The ElectroBun view loads it with the RPC
 *   transport (`src/ui/window.ts`); a browser loads it from the page server with the HTTP transport
 *   (`src/ui/web.ts`). The HTML is the same file.
 * - `share.html`, `share.js`, `theme.css`: the read-only viewer of a share link.
 *
 * The browser build must not reach Node's modules: the fold is shared with the app, and a stray
 * `node:` import would break the page at load. `buildUi` refuses such a bundle.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UI_DIR = join(import.meta.dir, "..", "..", "ui");

export interface UiFile {
  type: string;
  body: string;
}

/** Path (`/index.js`) to file. */
export type UiBundle = ReadonlyMap<string, UiFile>;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

async function buildEntry(entry: string): Promise<string> {
  const r = await Bun.build({
    entrypoints: [join(UI_DIR, entry)],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!r.success) {
    throw new Error(`the UI bundle failed: ${r.logs.map((l) => String(l)).join("; ")}`);
  }
  const out = r.outputs[0];
  if (!out) throw new Error(`the UI bundle of ${entry} produced nothing`);
  const text = await out.text();
  const node = nodeImport(text);
  if (node) throw new Error(`the UI bundle of ${entry} imports a Node module: ${node}`);
  return text;
}

/** The first import of a Node module in a browser bundle, or null. */
export function nodeImport(text: string): string | null {
  return (
    /\bfrom\s*["']node:[^"']*|\brequire\(\s*["']node:[^"']*|\bimport\(\s*["']node:[^"']*/.exec(
      text,
    )?.[0] ?? null
  );
}

let cached: Promise<UiBundle> | null = null;

/** Builds both pages in memory, once per process. */
export function buildUi(): Promise<UiBundle> {
  cached ??= (async () => {
    const [index, share] = await Promise.all([buildEntry("web.ts"), buildEntry("share-viewer.ts")]);
    const read = (f: string) => readFileSync(join(UI_DIR, f), "utf8");
    const files = new Map<string, UiFile>([
      ["/index.html", { type: TYPES.html as string, body: read("index.html") }],
      ["/index.js", { type: TYPES.js as string, body: index }],
      ["/theme.css", { type: TYPES.css as string, body: read("theme.css") }],
      ["/share.html", { type: TYPES.html as string, body: read("share.html") }],
      ["/share.js", { type: TYPES.js as string, body: share }],
    ]);
    return files;
  })();
  cached.catch(() => {
    cached = null;
  });
  return cached;
}

/** `bun run build:ui`: writes the static bundle into a folder (default `dist/ui`). */
export async function writeUi(dir: string): Promise<string[]> {
  const files = await buildUi();
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [path, f] of files) {
    const target = join(dir, path.slice(1));
    writeFileSync(target, f.body);
    written.push(target);
  }
  return written;
}

if (import.meta.main) {
  for (const f of await writeUi(join(UI_DIR, "..", "..", "dist", "ui"))) console.log(f);
}
