/**
 * ROADMAP G4's macOS 14.3 run (scripts/gates/g4-macos14-vm.sh) against stand-ins: `tart` boots
 * nothing, the "guest" is this machine reached through a fake `sshpass` with its own `sw_vers` and
 * `afplay`, the helper writes a file and exits with the code it is given, and `ffmpeg` reports a
 * loud call channel for the tone recording and silence for the other. The verdict must refuse a
 * guest that is not 14.3 and a helper that exits non-zero, and pass the run with neither.
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
  ffmpeg: `case "$*" in
  *lavfi*) for a; do last="$a"; done; : > "$last" ;;
  *astats*) case "$*" in
    *tone.opus*) echo "[Parsed_astats_1] RMS level dB: -24.0" >&2 ;;
    *) echo "[Parsed_astats_1] RMS level dB: -inf" >&2 ;;
  esac ;;
esac`,
};

/** The helper stand-in: writes its `--out` file, then exits with FAKE_HELPER_EXIT. */
const HELPER = `while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; shift; done
printf OggS > "$out"
exit "\${FAKE_HELPER_EXIT:-0}"`;

function run(env: { FAKE_MACOS: string; FAKE_HELPER_EXIT?: string }) {
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
    env: {
      ...process.env,
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
      TART_HOME: join(t.dir, "tart"),
      SHARE_IN_VM: join(out, "share"),
      RECORD_SECONDS: "1",
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
  },
);
