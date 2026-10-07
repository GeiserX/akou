/**
 * ROADMAP G4's macOS 14.3 run (scripts/gates/g4-macos14-vm.sh) against stand-ins: `tart` boots
 * nothing, the "guest" is this machine reached through a fake `sshpass` with its own `sw_vers`,
 * `afplay` and `open`, the helper writes a file and exits with the code it is given, and `ffmpeg`
 * reports a loud call channel for a tone recording the helper really heard, and silence otherwise.
 * The verdict must refuse a guest that is not 14.3, a helper that exits non-zero and a recording
 * that never finishes, and pass the run with none of them.
 *
 * The helper only "hears" when Terminal started it, as in the VM: a helper started over SSH has no
 * process that macOS can ask for system-audio access, so its tap delivers digital zeros and no
 * prompt ever appears. Started from Terminal in the guest's console session, it gets the prompt.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "gates", "g4-macos14-vm.sh");

const STANDINS: Record<string, string> = {
  tart: `case "$1" in
  list) echo akou-g4-macos14 ;;
  ip) echo 127.0.0.1 ;;
  run) exec sleep 600 ;;
esac`,
  // Everything after the user@host argument is the command the guest runs.
  sshpass: `while [ $# -gt 0 ]; do case "$1" in admin@*) shift; break ;; esac; shift; done
exec bash -c "$*"`,
  sw_vers: `echo "$FAKE_MACOS"`,
  afplay: "exit 0",
  // \`open -a Terminal <file>\`: Terminal runs the file in the console session, detached.
  open: `[ "$1" = -a ] && shift 2
[ -n "\${FAKE_OPEN_HANG:-}" ] && exit 0
AKOU_FAKE_VIA=Terminal nohup bash "$1" > /dev/null 2>&1 &`,
  ffmpeg: `case "$*" in
  *lavfi*) for a; do last="$a"; done; : > "$last" ;;
  *astats*)
    while [ $# -gt 0 ]; do [ "$1" = -i ] && in="$2"; shift; done
    case "$in" in
      *tone.opus) if grep -q heard "$in"; then db=-24.0; else db=-inf; fi ;;
      *) db=-inf ;;
    esac
    echo "[Parsed_astats_1] RMS level dB: $db" >&2 ;;
esac`,
};

/**
 * The helper stand-in: writes its `--out` file (audio it heard only when Terminal started it),
 * then exits with FAKE_HELPER_EXIT. Like the real
 * helper in the VM, it cannot create its recording on the shared folder: the helper syncs the file
 * with F_FULLFSYNC, which tart's shared folder refuses (`Inappropriate ioctl for device`), so
 * the recording has to land on the guest's own disk first.
 */
const HELPER = `while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done
case "$out" in /*) path="$out" ;; *) path="$PWD/$out" ;; esac
case "$path" in "$SHARE_IN_VM"/*)
  echo '{"type":"warn","code":"io","msg":"cannot create: Inappropriate ioctl for device (os error 25)"}' >&2
  exit 74 ;;
esac
if [ "\${AKOU_FAKE_VIA:-}" = Terminal ]; then printf 'OggS heard' > "$out"; else printf 'OggS zeros' > "$out"; fi
exit "\${FAKE_HELPER_EXIT:-0}"`;

function run(env: { FAKE_MACOS: string; FAKE_HELPER_EXIT?: string; FAKE_OPEN_HANG?: string }) {
  const t = tempDir();
  const bin = join(t.dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(STANDINS)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const helper = join(t.dir, "akou-capture");
  writeFileSync(helper, `#!/bin/sh\n${HELPER}\n`);
  chmodSync(helper, 0o755);
  const out = join(t.dir, "out");
  const r = Bun.spawnSync(["bash", SCRIPT, helper, out], {
    // A script that blocks fails here, not at CI's job limit.
    timeout: 25_000,
    env: {
      ...process.env,
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
      TART_HOME: join(t.dir, "tart"),
      SHARE_IN_VM: join(out, "share"),
      RECORD_SECONDS: "1",
      RECORD_TIMEOUT: "4",
    },
  });
  const file = join(out, "verdict.json");
  const verdict = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const left = (name: string) => existsSync(join(out, name));
  return { code: r.exitCode, verdict, left, stderr: r.stderr.toString(), cleanup: t.cleanup };
}

describe.skipIf(process.platform === "win32")(
  "[G4] the macOS 14.3 VM run's verdict (bash; skipped on Windows)",
  () => {
    test("positive control: a 14.3 guest and a helper that exits 0 pass", () => {
      const r = run({ FAKE_MACOS: "14.3.1" });
      try {
        expect(r.verdict).toMatchObject({ verdict: "pass", macos: "14.3.1" });
        expect(r.code).toBe(0);
        // Both recordings came back from the guest's disk for the record.
        expect(r.left("tone.opus")).toBe(true);
        expect(r.left("silent.opus")).toBe(true);
      } finally {
        r.cleanup();
      }
    }, 30_000);

    test("a guest that is not 14.3 fails before any recording", () => {
      const r = run({ FAKE_MACOS: "15.1" });
      try {
        expect(r.verdict).toMatchObject({ verdict: "fail", macos: "15.1" });
        expect(r.verdict.reason).toContain("not 14.3");
        expect(r.left("tone.opus")).toBe(false);
        expect(r.code).not.toBe(0);
      } finally {
        r.cleanup();
      }
    }, 30_000);

    test("a helper that writes audio and then exits 1 fails the run", () => {
      const r = run({ FAKE_MACOS: "14.3", FAKE_HELPER_EXIT: "1" });
      try {
        expect(r.verdict).toMatchObject({ verdict: "fail" });
        expect(r.verdict.reason).toContain("exited non-zero");
        // It did leave a file, and the file is kept for the record.
        expect(r.left("tone.opus")).toBe(true);
        expect(r.code).not.toBe(0);
      } finally {
        r.cleanup();
      }
    }, 30_000);

    test("a recording that never finishes fails and points at the system-audio prompt", () => {
      const r = run({ FAKE_MACOS: "14.3", FAKE_OPEN_HANG: "1" });
      try {
        expect(r.verdict).toMatchObject({ verdict: "fail" });
        expect(r.verdict.reason).toContain("did not finish");
        expect(r.verdict.reason).toContain("VNC=1");
        expect(r.code).not.toBe(0);
      } finally {
        r.cleanup();
      }
    }, 30_000);
  },
);
