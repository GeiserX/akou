/**
 * SV-P10 end to end: a call recorded by the real capture helper (`native/akou-capture`, in file
 * mode) gets its final pass from the part's Ogg Opus file, decoded by the same helper, with no WAV
 * anywhere in the call's folder. The app picks that audio itself (`partsAudio`); the recognizer is
 * the fake one, which hears the fixture's tone words through the Opus round trip.
 *
 * Nothing here opens an audio device or asks for a permission: the helper reads a generated WAV
 * (`--from-wav`) under `AKOU_CAPTURE_FILE_ONLY=1`. Needs `AKOU_CAPTURE_BIN`, a build of the helper:
 *
 *   cargo build --release --manifest-path native/akou-capture/Cargo.toml
 *   AKOU_CAPTURE_BIN=native/akou-capture/target/release/akou-capture bun test tests/asr-opus-final.e2e.test.ts
 *
 * Without it the test is skipped, and says so. CI's `helper` job runs it on macOS, Windows and Linux.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AkouCaptureEngine } from "../src/main/capture/helper.ts";
import { type AppRig, appRig, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const BIN = process.env.AKOU_CAPTURE_BIN;
const LONG = 60_000;

/** Every file under `dir`, relative to it. */
function files(dir: string, at = ""): string[] {
  return readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir, join(at, e.name)) : [join(at, e.name)],
  );
}

if (!BIN) {
  test.skipIf(!BIN)(
    "[SV-P10] the final pass decodes the helper's Opus part (skipped: needs AKOU_CAPTURE_BIN, a helper build)",
    () => {},
  );
} else {
  const bin = BIN;
  const wavDir = tempDir("akou-opus-final-");
  let rig: AppRig | undefined;
  afterAll(async () => {
    await rig?.close();
    wavDir.cleanup();
  });

  describe("[SV-P10] a recorded call's final pass reads its Opus part through the helper", () => {
    test(
      "the final layer has both channels' words, and the call's folder holds no WAV",
      async () => {
        const wav = speechWav(wavDir.dir);
        rig = await appRig({
          // The helper decodes what it recorded: `capture.helper` is the one `decode` runs.
          settings: { "capture.helper": [bin] },
          engine: new AkouCaptureEngine({
            command: [bin],
            extraArgs: () => ["--from-wav", wav, "--loop", "--speed", "1"],
            env: { ...process.env, AKOU_CAPTURE_FILE_ONLY: "1" },
          }),
        });
        const r = rig;
        const id = await r.startCall({ title: "Opus final" });
        // A live line, then more than one pass of the 2.6 s fixture on disk.
        await until(
          async () => (await r.api("GET", `/calls/${id}/transcript`)).body.lines.length > 0,
          15_000,
          "a live line",
        );
        await Bun.sleep(3_000);
        await r.api("POST", "/calls/live/stop");
        await until(
          async () => {
            const s = (await r.api("GET", `/calls/${id}`)).body.final.state;
            return s === "done" || s === "failed";
          },
          30_000,
          "the final pass",
        );
        const detail = (await r.api("GET", `/calls/${id}`)).body;
        expect(detail.final.state).toBe("done");
        const part = join(detail.folder, detail.parts[0].file);
        expect(statSync(part).size).toBeGreaterThan(1000);
        expect(files(detail.folder).filter((f) => f.endsWith(".wav"))).toEqual([]);

        const lines = (await r.api("GET", `/calls/${id}/transcript?layer=final`)).body.lines as {
          ch: string;
          text: string;
        }[];
        const said = (ch: string) =>
          lines
            .filter((l) => l.ch === ch)
            .map((l) => l.text.toLowerCase())
            .join(" ");
        // The mic is the file's left channel and the call its right, through the Opus round trip.
        expect(said("mic")).toContain("hello world");
        expect(said("call")).toContain("ok great");
        expect(said("mic")).not.toContain("ok great");
        expect(said("call")).not.toContain("hello world");
      },
      LONG,
    );
  });
}
