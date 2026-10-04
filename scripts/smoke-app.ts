/**
 * Checks a built app without opening it (docs/DESIGN.md section 9, TRAPS "Packaging"), on the
 * machine that built it:
 *
 *   bun scripts/smoke-app.ts [--allow-missing-helper]
 *
 * On macOS it reads `build/stable-macos-arm64/akou.app` (the wrapper `build-app.ts` made), on
 * Windows and Linux `build/stable-<platform>/akou` (a launcher and the packed app), and the release
 * files in `dist/release/`, unpacks the inner app into a temporary folder, and fails on the first
 * of these that does not hold:
 *
 * - on macOS, both `Info.plist` files carry both usage strings, the bundle id, the version (as
 *   `CFBundleVersion` and `CFBundleShortVersionString`) and the macOS 14.4 floor, and both
 *   bundles pass `codesign --verify --deep --strict` (ad-hoc when unsigned);
 * - the inner app runs ElectroBun 2.0.1 with its bundled Bun 1.4.0 and says the version;
 * - every file the app loads by path is beside its main process: the Workers, the browser pages,
 *   the templates, the ask presets, the word lists, the tray icon, sherpa-onnx-node with its
 *   `.node` file and both libraries, the capture helper;
 * - NOTICE and LICENSE are there too: the word lists' CC BY-SA 4.0 wants its credit to travel;
 * - the bundled Bun loads sherpa-onnx-node from inside the bundle, and the process has the `.node`
 *   file and its libraries open from the bundle's own folder (`lsof` on macOS, where the hardened
 *   runtime ignores `DYLD_PRINT_LIBRARIES`; `/proc/self/maps` on Linux; the process's module list
 *   through PowerShell on Windows) (TRAPS "Native libraries missing from the bundle");
 * - the `akou` command line the akou menu links into PATH runs from the bundle and says the
 *   version;
 * - the bundled Bun imports both Worker modules;
 * - the app's own helper resolver, bundled into the main folder and run by the bundled Bun, finds
 *   the helper there;
 * - the bundled helper says the version, and records a generated two-channel WAV with `--from-wav`
 *   and `AKOU_CAPTURE_FILE_ONLY=1` into an Ogg Opus file with two channels (no device is opened).
 *
 * Nothing here launches the app, opens a window or asks for a permission.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SHERPA_LIBS as SHERPA_LIBS_BY_OS } from "../electrobun.config.ts";
import { BUNDLE_ID } from "../src/main/app-info.ts";
import { parseStderrLine } from "../src/main/capture/protocol.ts";
import { DICTIONARY_LANGUAGES } from "../src/main/vocab/dictionary.ts";
import {
  APP_DIR,
  diarizeArchive,
  MIN_MACOS,
  PINS,
  RELEASE_DIR,
  releaseName,
  WRAPPER_APP,
} from "./build-app.ts";
import { sourceVersion } from "./stamp-version.ts";

const ROOT = join(import.meta.dir, "..");
const USAGE_KEYS = ["NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription"];
const MAC = process.platform === "darwin";
const EXE = process.platform === "win32" ? ".exe" : "";
const SHERPA_PLATFORM = `sherpa-onnx-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const SHERPA_LIBS = SHERPA_LIBS_BY_OS[process.platform] ?? [];
/** `tar` that reads a drive letter as a drive: Windows' own, never Git's GNU tar. */
const TAR =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : MAC
      ? "/usr/bin/tar"
      : "tar";
/** The tray images each system loads (src/main/window/shell.ts `trayImage`). */
const TRAY = MAC
  ? ["akou-template.png", "akou-recording-macos.png"]
  : process.platform === "win32"
    ? ["akou.ico", "akou-recording.ico"]
    : ["akou.png", "akou-recording.png"];

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
  for (const key of ["CFBundleVersion", "CFBundleShortVersionString"]) {
    const v = plistValue(plist, key);
    check(v === version, `${label} ${key} is ${version}`, `found ${v}`);
  }
  const min = plistValue(plist, "LSMinimumSystemVersion");
  check(min === MIN_MACOS, `${label} LSMinimumSystemVersion is ${MIN_MACOS}`, `found ${min}`);
  // The app icon Hutch builds from `build.mac.icons` (scripts/app-icon.ts).
  const icon = plistValue(plist, "CFBundleIconFile");
  const icns =
    icon && join(app, "Contents", "Resources", icon.endsWith(".icns") ? icon : `${icon}.icns`);
  check(!!icns && existsSync(icns), `${label} carries its app icon`, `CFBundleIconFile ${icon}`);
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

/**
 * Two paths to one file, both through the system's own resolution: on Windows the temporary folder
 * may come back under its short 8.3 name on one side only (`RUNNER~1` against `runneradmin`).
 */
function samePath(a: string | undefined, b: string): boolean {
  try {
    return !!a && realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  } catch {
    return false;
  }
}

/** The folder holding `app/bun/index.js` under `dir`, wherever the packed app put it; or null. */
function findResources(dir: string): string | null {
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const p = join(f.parentPath, f.name);
    if (f.name === "index.js" && p.endsWith(join("Resources", "app", "bun", "index.js"))) {
      return join(p, "..", "..", "..");
    }
  }
  return null;
}

/** The inner app, unpacked into `work` the way the wrapper does on first launch. */
/** Where the parts of an unpacked app are. */
export interface UnpackedApp {
  /** The app's own `Resources` folder. */
  resources: string;
  /** The folder above it: `Contents` in the macOS bundle, the app folder elsewhere. */
  app: string;
  /** The bundled main process's folder, where everything it loads by path sits. */
  main: string;
  /** The Bun the app runs on. */
  bun: string;
}

/**
 * The built app's packed inner app, unpacked into `work` the way the wrapper does on first launch;
 * or what went wrong. Also used by the gate runners that run code inside the app (G2).
 */
export function unpackApp(work: string): UnpackedApp | string {
  const res = MAC ? join(WRAPPER_APP, "Contents", "Resources") : join(APP_DIR, "Resources");
  const packed = existsSync(res) ? readdirSync(res).filter((f) => f.endsWith(".tar.zst")) : [];
  if (packed.length !== 1) return `expected one packed app in ${res}, found ${packed.join(", ")}`;
  const tarFile = join(work, "app.tar");
  writeFileSync(tarFile, Bun.zstdDecompressSync(readFileSync(join(res, packed[0] as string))));
  const untar = spawnSync(TAR, ["-x", "-f", tarFile, "-C", work]);
  rmSync(tarFile);
  if (untar.status !== 0) return `the packed app does not unpack: ${untar.stderr ?? untar.error}`;
  // The app's own `Resources` folder holds `app/bun/index.js`, the bundled main process.
  const resources = findResources(work);
  if (resources === null) return "the packed app has no Resources/app/bun/index.js";
  const app = join(resources, "..");
  return {
    resources,
    app,
    main: join(resources, "app", "bun"),
    bun: join(app, MAC ? "MacOS" : "bin", `bun${EXE}`),
  };
}

async function checkInner(
  work: string,
  version: string,
  allowMissingHelper: boolean,
): Promise<void> {
  const unpacked = unpackApp(work);
  if (typeof unpacked === "string") {
    check(false, "the packed app unpacks", unpacked);
    return;
  }
  check(true, "the packed app unpacks");
  const { resources, app, main, bun } = unpacked;
  if (MAC) {
    checkPlist(join(app, ".."), "app", version);
    checkSignature(join(app, ".."), "app");
  }

  const build = JSON.parse(readFileSync(join(resources, "build.json"), "utf8"));
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
  const ver = JSON.parse(readFileSync(join(resources, "version.json"), "utf8"));
  check(ver.version === version && ver.identifier === BUNDLE_ID, `version.json says ${version}`);

  if (!check(existsSync(bun), "the bundled Bun is in the app", bun)) return;
  const need = [
    "NOTICE",
    "LICENSE",
    "index.js",
    "live-worker.js",
    "finalize-worker.js",
    ...["index.html", "index.js", "theme.css", "share.html", "share.js"].map((f) => `ui/${f}`),
    ...["general", "one-on-one", "standup", "customer-call", "interview"].map(
      (t) => `templates/${t}.md`,
    ),
    ...["catch-up", "my-name", "decisions", "action-items", "speaker"].map(
      (p) => `presets/${p}.md`,
    ),
    ...DICTIONARY_LANGUAGES.map((l) => `dictionaries/${l}.txt.gz`),
    ...TRAY.map((t) => `tray/${t}`),
    "node_modules/sherpa-onnx-node/addon.js",
    `node_modules/${SHERPA_PLATFORM}/sherpa-onnx.node`,
    ...SHERPA_LIBS.map((l) => `node_modules/${SHERPA_PLATFORM}/${l}`),
  ];
  const missing = need.filter((f) => !existsSync(join(main, f)));
  check(missing.length === 0, `${need.length} files beside the main process`, missing.join(", "));

  // The command line the akou menu links into PATH (DK-M6), run from inside the bundle: it must
  // start under the bundle's signature and say the app's version.
  const cli = join(main, `akou${EXE}`);
  const said = spawnSync(cli, ["--version"]);
  check(
    said.status === 0 && said.stdout.toString().trim() === version,
    `the bundled akou command says ${version}`,
    said.status === 0 ? said.stdout.toString().trim() : String(said.stderr ?? said.error),
  );

  // sherpa-onnx-node, loaded by the bundled Bun the way the app loads it.
  const probe = join(work, "load-sherpa.mjs");
  writeFileSync(
    probe,
    `import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const s = createRequire(${JSON.stringify(join(main, "index.js"))})("sherpa-onnx-node");
if (typeof s.OfflineRecognizer !== "function") throw new Error("no OfflineRecognizer");
// The files this process has mapped: lsof's "n<path>" lines on macOS, /proc/self/maps on Linux,
// its loaded modules on Windows.
let open = [];
if (process.platform === "darwin") {
  const out = spawnSync("/usr/sbin/lsof", ["-p", String(process.pid), "-Fn"]).stdout.toString();
  open = out.split("\\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
} else if (process.platform === "linux") {
  const { readFileSync } = await import("node:fs");
  open = readFileSync("/proc/self/maps", "utf8").split("\\n").map((l) => l.split(/\\s+/).slice(5).join(" ")).filter((p) => p.startsWith("/"));
} else if (process.platform === "win32") {
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-Command", \`(Get-Process -Id \${process.pid}).Modules | ForEach-Object { $_.FileName }\`]);
  open = ps.stdout.toString().split(/\\r?\\n/).filter((l) => l.trim() !== "");
}
console.log(JSON.stringify({ bun: Bun.version, open }));
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
  // ONNX Runtime loads its shared provider library only for a provider other than the CPU, so it is
  // in the bundle (above) but not open here.
  const loadedNow = SHERPA_LIBS.filter((l) => l !== "onnxruntime_providers_shared.dll");
  for (const lib of [...loadedNow, "sherpa-onnx.node"]) {
    const path =
      loaded.open.find((p) => basename(p).toLowerCase() === lib.toLowerCase()) ?? "(not open)";
    check(samePath(path, join(inBundle, lib)), `${lib} is loaded from the bundle`, path);
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

  // The capture helper, where the app's own resolver looks: `locateHelper` bundled into the main
  // folder the way the app's index.js is, and run by the bundled Bun, so a helper copied anywhere
  // else, or a resolver that looks anywhere else, turns this red. (After the signature check: the
  // probe is a file the seal does not cover.)
  const locate = join(main, "locate-helper-probe.js");
  const built = await Bun.build({
    entrypoints: [join(ROOT, "scripts", "locate-helper-probe.ts")],
    target: "bun",
    format: "esm",
  });
  if (!check(built.success && !!built.outputs[0], "the resolver probe builds")) return;
  await Bun.write(locate, built.outputs[0] as Blob);
  const located = spawnSync(bun, [locate]);
  let where: { command: string[]; source: string } = { command: [], source: "" };
  try {
    where = JSON.parse(located.stdout.toString());
  } catch {}
  const helper = join(main, `akou-capture${EXE}`);
  const found = where.source === "bundled" && samePath(where.command[0], helper);
  if (existsSync(helper) || where.source === "bundled") {
    if (
      check(
        found,
        "the app's resolver finds the bundled helper",
        `${where.source} ${where.command.join(" ")}${located.stderr.toString().trim()}`,
      )
    )
      await smokeHelper(helper, version, work);
  }
  // The flag covers a tree without native/akou-capture only: a built helper must be in the bundle.
  else if (allowMissingHelper && !existsSync(join(ROOT, "native", "akou-capture", "Cargo.toml")))
    console.log("SKIP the capture helper is not in the bundle (--allow-missing-helper)");
  else check(false, "the capture helper is in the bundle", helper);
  // The diarization helper: beside the capture helper, and it runs.
  const diarize = join(main, `akou-diarize${EXE}`);
  if (check(existsSync(diarize), "the diarization helper is in the bundle", diarize)) {
    const v = spawnSync(diarize, ["--version"]);
    const out = v.stdout.toString().trim();
    check(
      v.status === 0 && out === `akou-diarize ${version}`,
      `akou-diarize --version is ${version}`,
      out,
    );
  }
}

async function main(argv: string[]): Promise<void> {
  const allowMissingHelper = argv.includes("--allow-missing-helper");
  const version = sourceVersion(ROOT);
  const built = MAC ? WRAPPER_APP : APP_DIR;
  if (!existsSync(built)) {
    console.error(`smoke-app: no app at ${built}; run bun scripts/build-app.ts first`);
    process.exit(1);
  }

  if (MAC) {
    // The release files.
    for (const ext of ["dmg", "zip"]) {
      check(
        existsSync(join(RELEASE_DIR, `${releaseName(version)}.${ext}`)),
        `${releaseName(version)}.${ext} exists`,
      );
    }

    // The diarization helper alone: one file, the binary, at the archive's top.
    const tgz = join(RELEASE_DIR, diarizeArchive(version));
    if (check(existsSync(tgz), `${diarizeArchive(version)} exists`)) {
      const listed = spawnSync("tar", ["-tzf", tgz]).stdout.toString().trim();
      check(
        listed === "akou-diarize",
        `${diarizeArchive(version)} holds akou-diarize alone`,
        listed,
      );
    }

    // The wrapper.
    checkPlist(WRAPPER_APP, "wrapper", version);
    checkSignature(WRAPPER_APP, "wrapper");
  } else {
    // The installer, and the launcher the installed app starts from.
    const setup = existsSync(RELEASE_DIR)
      ? readdirSync(RELEASE_DIR).filter((f) => f.startsWith(`${releaseName(version)}-setup.`))
      : [];
    if (
      check(setup.length === 1, `one ${releaseName(version)}-setup installer`, setup.join(", "))
    ) {
      // What the installer holds. Windows: `akou-Setup.exe` and the packed app beside it under
      // `.installer/`. Linux: one `installer` program that carries the packed app inside itself,
      // so it must be larger than the packed app.
      const file = join(RELEASE_DIR, setup[0] as string);
      const entries = spawnSync(TAR, ["-t", "-f", file])
        .stdout.toString()
        .split(/\r?\n/)
        .filter((l) => l !== "");
      if (process.platform === "win32") {
        check(
          entries.includes("akou-Setup.exe"),
          "the installer holds akou-Setup.exe",
          entries.join(", "),
        );
        check(
          entries.filter((e) => /^\.installer\/[^/]+\.tar\.zst$/.test(e)).length === 1,
          "the installer holds one packed app",
          entries.join(", "),
        );
      } else {
        const out = mkdtempSync(join(tmpdir(), "akou-setup-"));
        try {
          spawnSync(TAR, ["-x", "-f", file, "-C", out]);
          const program = join(out, "installer");
          const packed = readdirSync(join(APP_DIR, "Resources")).find((f) =>
            f.endsWith(".tar.zst"),
          );
          const size = existsSync(program) ? statSync(program).size : 0;
          const app = packed ? statSync(join(APP_DIR, "Resources", packed)).size : 0;
          check(
            app > 0 && size > app,
            "the installer program carries the packed app",
            `${entries.join(", ")}; installer ${size} bytes, packed app ${app}`,
          );
        } finally {
          rmSync(out, { recursive: true, force: true });
        }
      }
    }
    const launcher = join(APP_DIR, "bin", `launcher${EXE}`);
    check(existsSync(launcher), "the app has its launcher", launcher);
  }

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
