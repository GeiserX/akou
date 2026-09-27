/**
 * Dictation's cues (docs/ux/DICTATION.md DC-O3), rendered to buffers and handed to a fake player
 * that keeps them. No test opens an output device (docs/TESTING.md: nothing plays through a
 * speaker).
 */

import { describe, expect, test } from "bun:test";
import {
  CUE_MOMENTS,
  CUE_RATE,
  type CueMoment,
  type CueStyle,
  Cues,
  cueStyle,
  renderCue,
  wavBytes,
} from "../../src/ui/dictation-cues.ts";

/** Keeps every cue it is handed, and plays none. */
function fakePlayer() {
  const got: { moment: CueMoment; wav: Uint8Array }[] = [];
  return {
    got,
    player: { play: (wav: Uint8Array, moment: CueMoment) => got.push({ moment, wav }) },
  };
}

/** A session's four moments, in order. */
function session(cues: Cues): void {
  for (const m of CUE_MOMENTS) cues.cue(m);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("DC-O3: start, stop, cancel and done cues", () => {
  test("auto is soft with the pill off and silent while it shows; off is silent; soft and click play", () => {
    expect(cueStyle("auto", "off")).toBe("soft");
    for (const pill of ["bottom", "top", "left", "right"])
      expect(cueStyle("auto", pill)).toBeNull();
    expect(cueStyle("off", "off")).toBeNull();
    expect(cueStyle("off", "bottom")).toBeNull();
    expect(cueStyle("soft", "bottom")).toBe("soft");
    expect(cueStyle("click", "off")).toBe("click");
    // A value the list does not hold reads as the default, never as silence with the pill off.
    expect(cueStyle(undefined, "off")).toBe("soft");
    expect(cueStyle("loud", "off")).toBe("soft");
  });

  test("with soft the fake player receives four distinct buffers, one at each moment", () => {
    const { got, player } = fakePlayer();
    session(new Cues(player, () => ({ sounds: "soft", pill: "bottom" })));
    expect(got.map((g) => g.moment)).toEqual(["start", "stop", "cancel", "done"]);
    expect(new Set(got.map((g) => hex(g.wav))).size).toBe(4);
  });

  test("with off it receives none; with auto, four while the pill is off and none while it shows", () => {
    const settings = { sounds: "off", pill: "off" };
    const { got, player } = fakePlayer();
    const cues = new Cues(player, () => settings);
    session(cues);
    expect(got).toEqual([]);

    // The setting applies now, read at every cue.
    settings.sounds = "auto";
    session(cues);
    expect(got.map((g) => g.moment)).toEqual(["start", "stop", "cancel", "done"]);
    expect(got.map((g) => hex(g.wav))).toEqual(
      CUE_MOMENTS.map((m) => hex(wavBytes(renderCue("soft", m)))),
    );

    settings.pill = "bottom";
    session(cues);
    expect(got).toHaveLength(4);
  });

  test("every cue is short, quiet, starts and ends at zero, and click differs from soft", () => {
    for (const style of ["soft", "click"] as CueStyle[]) {
      for (const m of CUE_MOMENTS) {
        const s = renderCue(style, m);
        const ms = (s.length * 1000) / CUE_RATE;
        expect(ms).toBeGreaterThanOrEqual(style === "soft" ? 90 : 8);
        expect(ms).toBeLessThanOrEqual(200);
        const peak = s.reduce((p, x) => Math.max(p, Math.abs(x)), 0);
        expect(peak).toBeGreaterThan(0.05);
        expect(peak).toBeLessThanOrEqual(0.3);
        expect(s[0]).toBe(0);
        expect(Math.abs(s.at(-1) as number)).toBeLessThan(1e-3);
      }
    }
    for (const m of CUE_MOMENTS)
      expect(renderCue("click", m).length).toBeLessThan(renderCue("soft", m).length);
  });

  test("the WAV bytes are 16-bit mono PCM at the cue rate, holding every sample", () => {
    const s = renderCue("soft", "start");
    const wav = wavBytes(s);
    const v = new DataView(wav.buffer);
    const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(CUE_RATE);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(s.length * 2);
    const i = s.reduce((best, x, k) => (Math.abs(x) > Math.abs(s[best] as number) ? k : best), 0);
    expect(v.getInt16(44 + i * 2, true)).toBe(Math.round((s[i] as number) * 0x7fff));
  });
});
