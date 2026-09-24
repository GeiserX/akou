/**
 * The capture traps against the real Rust helper (`native/akou-capture`), in file mode: the same
 * scenarios as tests/capture-traps.test.ts, with the helper reading a generated WAV (`--from-wav`)
 * instead of devices and taking the faults as `--simulate` switches. Nothing here opens an audio
 * device or asks for a permission: every spawn carries `--from-wav` and `AKOU_CAPTURE_FILE_ONLY=1`.
 *
 * Needs `AKOU_CAPTURE_BIN`, a test build of the helper:
 *
 *   cargo build --release --features simulate --manifest-path native/akou-capture/Cargo.toml
 *   AKOU_CAPTURE_BIN=native/akou-capture/target/release/akou-capture bun test tests/capture-rust.e2e.test.ts
 *
 * `AKOU_CAPTURE_BIN_SHIPPING`, a build without the feature, adds the check that fault switches are
 * absent from what ships. Without `AKOU_CAPTURE_BIN` every test here is skipped, and says so.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, parseStderrLine } from "../src/main/capture/protocol.ts";
import { ofType, until } from "./capture-helpers.ts";
import {
  captureTrapScenarios,
  LONG,
  rig,
  rustHelper,
  useRigCleanups,
} from "./capture-scenarios.ts";
import { writeCallWav } from "./fixtures/audio.ts";

const BIN = process.env.AKOU_CAPTURE_BIN;
const SHIPPING = process.env.AKOU_CAPTURE_BIN_SHIPPING;

const dir = mkdtempSync(join(tmpdir(), "akou-rust-e2e-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const WAV = join(dir, "call.wav");
writeCallWav(WAV, 4);

/** Runs the helper once with stdin closed, which means stop at once. */
function once(bin: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(
    [bin, "run", "--out", join(dir, "once.opus"), "--mic", "default", "--call", "system", ...args],
    { stdin: "ignore", env: { ...process.env, AKOU_CAPTURE_FILE_ONLY: "1", ...env } },
  );
  return { code: r.exitCode, stderr: r.stderr.toString() };
}

/** Last page granule and pre-skip of an Ogg Opus file, read page by page. */
function oggOpus(bytes: Uint8Array): { channels: number; preSkip: number; granule: bigint } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  let granule = 0n;
  let channels = 0;
  let preSkip = 0;
  while (o + 27 <= bytes.length) {
    if (String.fromCharCode(...bytes.subarray(o, o + 4)) !== "OggS")
      throw new Error(`no page at ${o}`);
    const segs = bytes[o + 26] as number;
    let size = 0;
    for (let i = 0; i < segs; i++) size += bytes[o + 27 + i] as number;
    const body = o + 27 + segs;
    if (body + size > bytes.length) break;
    if (String.fromCharCode(...bytes.subarray(body, body + 8)) === "OpusHead") {
      channels = bytes[body + 9] as number;
      preSkip = v.getUint16(body + 10, true);
    }
    const g = v.getBigUint64(o + 6, true);
    if (g !== 0xffffffffffffffffn && g > granule) granule = g;
    o = body + size;
  }
  return { channels, preSkip, granule };
}

if (!BIN) {
  test.skip("set AKOU_CAPTURE_BIN to a `--features simulate` build to run the capture traps against the Rust helper", () => {});
} else {
  useRigCleanups();
  const bin = BIN;
  const caps = (() => {
    const hello = once(bin, ["--from-wav", WAV]).stderr.split("\n")[0] ?? "";
    const m = parseStderrLine(hello);
    return m.kind === "msg" && m.msg.type === "hello" ? m.msg.caps : [];
  })();

  describe("akou-capture (Rust): the build under test", () => {
    test("AKOU_CAPTURE_BIN is a test build that accepts fault switches", () => {
      expect(caps).toContain("file");
      expect(caps).toContain("simulate");
    });

    test("device capture is refused under AKOU_CAPTURE_FILE_ONLY; the file source is not", () => {
      const refused = once(bin, []);
      expect(refused.code).toBe(EXIT.unavailable);
      expect(refused.stderr).toContain('"code":"file-only"');
      // Control: the same launch with a WAV runs and exits cleanly.
      const control = once(bin, ["--from-wav", WAV]);
      expect(control.code).toBe(EXIT.ok);
      expect(control.stderr).toContain('"type":"stopped"');
    });

    test.skipIf(!SHIPPING)(
      "[T0.2] fault switches are absent from the shipping build (needs AKOU_CAPTURE_BIN_SHIPPING)",
      () => {
        const shipped = once(SHIPPING as string, ["--from-wav", WAV, "--simulate", "crash-at=1"]);
        expect(shipped.code).toBe(EXIT.usage);
        expect(shipped.stderr).toContain("no fault switches");
        expect(once(SHIPPING as string, ["--from-wav", WAV]).stderr).not.toContain("simulate");
        // Positive control: the test build takes the same switch.
        expect(once(bin, ["--from-wav", WAV, "--simulate", "crash-at=1"]).code).toBe(EXIT.ok);
      },
    );
  });

  const h = rustHelper(bin, WAV);
  if (caps.includes("simulate")) captureTrapScenarios(h);

  describe("akou-capture (Rust): the part it leaves", () => {
    test(
      "every stderr line is an akou-capture/1 message, and the Opus file is stereo and as long as the part",
      async () => {
        const r = rig(h, () => ({}));
        const a = await r.mgr.start({ workspace: "work" });
        if (!a.ok) throw new Error(a.error);
        await until(() => r.packets.length > 100, 5_000, "a second of packets");
        await r.mgr.stop("live");
        const log = readFileSync(join(a.folder, "logs/capture-part-001.log"), "utf8")
          .split("\n")
          .filter((l) => l.startsWith("{"));
        expect(log.length).toBeGreaterThan(5);
        for (const line of log) expect(parseStderrLine(line).kind).toBe("msg");
        const types = new Set(log.map((l) => JSON.parse(l).type));
        for (const t of ["hello", "capturing", "first_audio", "level", "stopped"]) {
          expect(types.has(t)).toBe(true);
        }
        const ended = ofType(r.events, "part.ended")[0];
        expect(ended?.reason).toBe("stop");
        const ogg = oggOpus(new Uint8Array(readFileSync(join(a.folder, "audio/part-001.opus"))));
        expect(ogg.channels).toBe(2);
        const fileSeconds = Number(ogg.granule - BigInt(ogg.preSkip)) / 48000;
        expect(Math.abs(fileSeconds - (ended?.fileSeconds ?? 0))).toBeLessThan(0.021);
      },
      LONG,
    );
  });
}
