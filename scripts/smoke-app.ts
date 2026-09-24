/**
 * Checks a built macOS app without opening it (docs/DESIGN.md section 9, TRAPS "Packaging"):
 *
 *   bun scripts/smoke-app.ts [--allow-missing-helper]
 *
 * It reads `build/stable-macos-arm64/akou.app` (the wrapper `build-app.ts` made) and the release
 * files in `dist/release/`, unpacks the inner app into a temporary folder, and fails on the first
 * of these that does not hold:
 *
 * - both `Info.plist` files carry both usage strings, the bundle id and the version;
 * - both bundles pass `codesign --verify --deep --strict` (ad-hoc when unsigned);
 * - the inner app runs ElectroBun 2.0.1 with its bundled Bun 1.4.0 and says the version;
 * - every file the app loads by path is beside its main process: the Workers, the browser pages,
 *   the templates, sherpa-onnx-node with its `.node` file and both libraries, the capture helper;
 * - the bundled Bun loads sherpa-onnx-node from inside the bundle, and the process has the `.node`
 *   file and both libraries open from the bundle's own folder (`lsof`; the hardened runtime ignores
 *   `DYLD_PRINT_LIBRARIES`) (TRAPS "Native libraries missing from the bundle");
 * - the bundled Bun imports both Worker modules;
 * - the bundled helper says the version, and records a generated two-channel WAV with `--from-wav`
 *   and `AKOU_CAPTURE_FILE_ONLY=1` into an Ogg Opus file with two channels (no device is opened).
 *
 * Nothing here launches the app, opens a window or asks for a permission.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLE_ID } from "../src/main/app-info.ts";
import { parseStderrLine } from "../src/main/capture/protocol.ts";
import { PINS, RELEASE_DIR, releaseName, WRAPPER_APP } from "./build-app.ts";
import { sourceVersion } from "./stamp-version.ts";

const ROOT = join(import.meta.dir, "..");
const USAGE_KEYS = ["NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription"];
const SHERPA_PLATFORM = "sherpa-onnx-darwin-arm64";
const SHERPA_LIBS = ["libsherpa-onnx-c-api.dylib", "libonnxruntime.dylib"];

let failures = 0;
function check(ok: boolean, what: string, detail = ""): boolean {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

function plistValue(plist: string, key: string): string | null {
  const r = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", plist]);
  return r.status === 0 ? r.stdout.toString().trim() : null;
}

function checkPlist(app: string, label: string, version: string): void {
  const plist = join(app, "Contents", "Info.plist");
  for (const key of USAGE_KEYS) {
    check(!!plistValue(plist, key)?.startsWith("akou records"), `${label} Info.plist ${key}`);
  }
  check(plistValue(plist, "CFBundleIdentifier") === BUNDLE_ID, `${label} bundle id ${BUNDLE_ID}`);
  const v = plistValue(plist, "CFBundleVersion");
  check(v === version, `${label} CFBundleVersion is ${version}`, `found ${v}`);
}

function checkSignature(app: string, label: string): void {
  const r = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  check(
    r.status === 0,
    `${label} passes codesign --verify --deep --strict`,
    r.stderr.toString().trim(),
  );
}

/** A two-channel 16-bit WAV: a 440 Hz tone on the left (mic), 660 Hz on the right (call). */
function writeStereoWav(path: string, seconds: number, rate = 48_000): void {
  const frames = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * 4, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 4);
    buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 660 * i) / rate)), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

/** The channel count in an Ogg Opus file's `OpusHead`, or 0. */
function opusChannels(path: string): number {
  if (!existsSync(path)) return 0;
  const b = readFileSync(path);
  const at = b.indexOf("OpusHead");
  return b.subarray(0, 4).toString() === "OggS" && at >= 0 ? (b[at + 9] ?? 0) : 0;
}

async function smokeHelper(helper: string, version: string, work: string): Promise<void> {
  const v = spawnSync(helper, ["--version"]);
  const out = v.stdout.toString().trim();
  check(
    v.status === 0 && out.startsWith(`akou-capture ${version} `),
    `helper --version is ${version}`,
    out,
  );

  const wav = join(work, "call.wav");
  const opus = join(work, "part-001.opus");
  writeStereoWav(wav, 3);
  const child = Bun.spawn(
    [helper, "run", "--out", opus, "--mic", "default", "--call", "system", "--from-wav", wav],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AKOU_CAPTURE_FILE_ONLY: "1" },
    },
  );
  const stdout = new Response(child.stdout).arrayBuffer();
  const stderr = new Response(child.stderr).text();
  // The file ends by itself; a helper that keeps running is asked to stop, as the app does.
  const timer = setTimeout(() => {
    child.stdin.write("stop\n");
    child.stdin.end();
  }, 15_000);
  const code = await child.exited;
  clearTimeout(timer);
  const err = await stderr;
  const hello = parseStderrLine(err.split("\n")[0] ?? "");
  check(
    hello.kind === "msg" && hello.msg.type === "hello" && hello.msg.version === version,
    `helper hello says ${version}`,
    err.split("\n")[0] ?? "",
  );
  check(
    code === 0,
    "helper --from-wav exits 0",
    `exit ${code}; ${err.trim().split("\n").slice(-2).join(" | ")}`,
  );
  check((await stdout).byteLength > 0, "helper wrote packets on stdout");
  check(opusChannels(opus) === 2, "helper wrote a two-channel Ogg Opus file");
}

/** The inner app, unpacked into `work` the way the wrapper does on first launch. */
async function checkInner(
  work: string,
  version: string,
  allowMissingHelper: boolean,
): Promise<void> {
  const res = join(WRAPPER_APP, "Contents", "Resources");
  const packed = readdirSync(res).filter((f) => f.endsWith(".tar.zst"));
  if (!check(packed.length === 1, "the wrapper carries one packed app", packed.join(", "))) return;
  const tar = Bun.zstdDecompressSync(readFileSync(join(res, packed[0] as string)));
  const untar = spawnSync("/usr/bin/tar", ["-x", "-C", work], { input: tar });
  if (!check(untar.status === 0, "the packed app unpacks", untar.stderr.toString())) return;
  const app = join(work, "akou.app");
  checkPlist(app, "app", version);
  checkSignature(app, "app");

  const build = JSON.parse(readFileSync(join(app, "Contents", "Resources", "build.json"), "utf8"));
  check(
    build.electrobunVersion === PINS.electrobun,
    `ElectroBun ${PINS.electrobun}`,
    build.electrobunVersion,
  );
  check(
    build.runtimeVersions?.bun === PINS.appBun,
    `bundled Bun ${PINS.appBun}`,
    build.runtimeVersions?.bun,
  );
  check(build.mainProcess === "bun", "the main process is Bun");
  const ver = JSON.parse(readFileSync(join(app, "Contents", "Resources", "version.json"), "utf8"));
  check(ver.version === version && ver.identifier === BUNDLE_ID, `version.json says ${version}`);

  const main = join(app, "Contents", "Resources", "app", "bun");
  const bun = join(app, "Contents", "MacOS", "bun");
  const need = [
    "index.js",
    "live-worker.js",
    "finalize-worker.js",
    ...["index.html", "index.js", "theme.css", "share.html", "share.js"].map((f) => `ui/${f}`),
    ...["general", "one-on-one", "standup", "customer-call", "interview"].map(
      (t) => `templates/${t}.md`,
    ),
    "node_modules/sherpa-onnx-node/addon.js",
    `node_modules/${SHERPA_PLATFORM}/sherpa-onnx.node`,
    ...SHERPA_LIBS.map((l) => `node_modules/${SHERPA_PLATFORM}/${l}`),
  ];
  const missing = need.filter((f) => !existsSync(join(main, f)));
  check(missing.length === 0, `${need.length} files beside the main process`, missing.join(", "));

  // sherpa-onnx-node, loaded by the bundled Bun the way the app loads it.
  const probe = join(work, "load-sherpa.mjs");
  writeFileSync(
    probe,
    `import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const s = createRequire(${JSON.stringify(join(main, "index.js"))})("sherpa-onnx-node");
if (typeof s.OfflineRecognizer !== "function") throw new Error("no OfflineRecognizer");
// The files this process has mapped, one "n<path>" line each.
const open = spawnSync("/usr/sbin/lsof", ["-p", String(process.pid), "-Fn"]).stdout.toString();
console.log(JSON.stringify({ bun: Bun.version, open: open.split("\\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)) }));
`,
  );
  const load = spawnSync(bun, [probe]);
  let loaded: { bun: string; open: string[] } = { bun: "", open: [] };
  try {
    loaded = JSON.parse(load.stdout.toString());
  } catch {}
  check(
    load.status === 0,
    "the bundled Bun loads sherpa-onnx-node",
    load.status === 0 ? `Bun ${loaded.bun}` : load.stderr.toString().slice(-400),
  );
  const inBundle = join(main, "node_modules", SHERPA_PLATFORM);
  for (const lib of [...SHERPA_LIBS, "sherpa-onnx.node"]) {
    const path = loaded.open.find((p) => p.endsWith(`/${lib}`)) ?? "(not open)";
    check(path.endsWith(join(inBundle, lib)), `${lib} is loaded from the bundle`, path);
  }

  // The Worker modules resolve and evaluate under the bundled Bun (their entry is guarded).
  const workers = spawnSync(bun, [
    "-e",
    `for (const w of ["live-worker.js", "finalize-worker.js"]) await import(${JSON.stringify(main)} + "/" + w);`,
  ]);
  check(
    workers.status === 0,
    "the bundled Bun imports both Worker modules",
    workers.stderr.toString().trim(),
  );

  // The capture helper.
  const helper = join(main, "akou-capture");
  if (existsSync(helper)) await smokeHelper(helper, version, work);
  // The flag covers a tree without native/akou-capture only: a built helper must be in the bundle.
  else if (allowMissingHelper && !existsSync(join(ROOT, "native", "akou-capture", "Cargo.toml")))
    console.log("SKIP the capture helper is not in the bundle (--allow-missing-helper)");
  else check(false, "the capture helper is in the bundle", helper);
}

async function main(argv: string[]): Promise<void> {
  const allowMissingHelper = argv.includes("--allow-missing-helper");
  const version = sourceVersion(ROOT);
  if (!existsSync(WRAPPER_APP)) {
    console.error(`smoke-app: no app at ${WRAPPER_APP}; run bun scripts/build-app.ts first`);
    process.exit(1);
  }

  // The release files.
  for (const ext of ["dmg", "zip"]) {
    check(
      existsSync(join(RELEASE_DIR, `${releaseName(version)}.${ext}`)),
      `${releaseName(version)}.${ext} exists`,
    );
  }

  // The wrapper.
  checkPlist(WRAPPER_APP, "wrapper", version);
  checkSignature(WRAPPER_APP, "wrapper");

  const work = mkdtempSync(join(tmpdir(), "akou-smoke-"));
  try {
    await checkInner(work, version, allowMissingHelper);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`smoke-app: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("smoke-app: every check passed");
}

if (import.meta.main) await main(process.argv.slice(2));
