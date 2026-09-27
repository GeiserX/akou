/**
 * Dictation's cues (docs/ux/DICTATION.md DC-O3): a short sound at start, stop, cancel and done.
 *
 * `dictation.sounds` is `auto`, `off`, `soft` or `click`. `auto` is `soft` while the pill is off and
 * silent while it shows, so a dictation is never both silent and invisible. The setting applies
 * now: `Cues` reads it at every cue, not once per session.
 *
 * The cues are rendered here, as 16-bit mono WAV bytes a player hands to the system's output,
 * which follows the system's choice of device. This module plays nothing itself: the caller gives
 * it a `CuePlayer`, and tests give it one that keeps the bytes, so no test opens an output. The
 * session plays the start cue before its readiness gate opens and the stop cue after the post-roll,
 * so the recognizer never hears them.
 *
 * Pure code with no DOM: the main side imports it, and the Dictation page reads `cueStyle` to say
 * what `auto` does right now.
 */

export type CueMoment = "start" | "stop" | "cancel" | "done";
export type CueStyle = "soft" | "click";

export const CUE_MOMENTS: readonly CueMoment[] = ["start", "stop", "cancel", "done"];

/** The cues' sample rate: well above the highest tone, and small. */
export const CUE_RATE = 24_000;

/**
 * The cue a session plays now, or null for none. `pill` is `dictation.pill`; an unknown `sounds`
 * reads as `auto`, the default, so a bad value never silences a dictation the pill does not show.
 */
export function cueStyle(sounds: unknown, pill: unknown): CueStyle | null {
  if (sounds === "off") return null;
  if (sounds === "soft" || sounds === "click") return sounds;
  return pill === "off" ? "soft" : null;
}

/** One tone of a cue: its frequency, its length and the gap of silence before it. */
interface Tone {
  hz: number;
  ms: number;
  gapMs?: number;
}

/**
 * Soft cues are sine notes with a gentle attack and decay: start rises, stop falls, cancel is one
 * low note, done one high note. Click cues are a few milliseconds each, pitched the same way.
 */
const TONES: Record<CueStyle, Record<CueMoment, Tone[]>> = {
  soft: {
    start: [
      { hz: 660, ms: 70 },
      { hz: 880, ms: 90, gapMs: 10 },
    ],
    stop: [
      { hz: 880, ms: 70 },
      { hz: 660, ms: 90, gapMs: 10 },
    ],
    cancel: [{ hz: 392, ms: 140 }],
    done: [{ hz: 988, ms: 100 }],
  },
  click: {
    start: [{ hz: 2000, ms: 8 }],
    stop: [{ hz: 1500, ms: 8 }],
    cancel: [
      { hz: 1200, ms: 8 },
      { hz: 1200, ms: 8, gapMs: 40 },
    ],
    done: [{ hz: 2600, ms: 8 }],
  },
};

/** Peak amplitude of each style, of full scale: quiet enough for a headset at full volume. */
const PEAK: Record<CueStyle, number> = { soft: 0.2, click: 0.3 };

/** The cue's samples, in -1..1. Every tone starts and ends at zero, so nothing pops. */
export function renderCue(style: CueStyle, moment: CueMoment, rate = CUE_RATE): Float32Array {
  const tones = TONES[style][moment];
  const n = (ms: number) => Math.round((ms * rate) / 1000);
  const total = tones.reduce((sum, t) => sum + n(t.gapMs ?? 0) + n(t.ms), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const t of tones) {
    at += n(t.gapMs ?? 0);
    const len = n(t.ms);
    const attack = Math.max(1, Math.min(n(5), len >> 2));
    for (let i = 0; i < len; i++) {
      // A raised-cosine attack, then a decay that reaches zero at the tone's last sample.
      const rise = i < attack ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attack) : 1;
      const fall = ((len - 1 - i) / (len - 1)) ** 2;
      out[at + i] = PEAK[style] * rise * fall * Math.sin((2 * Math.PI * t.hz * i) / rate);
    }
    at += len;
  }
  return out;
}

/** Samples as a 16-bit mono PCM WAV file. */
export function wavBytes(samples: Float32Array, rate = CUE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    v.setInt16(44 + i * 2, Math.round(s * 0x7fff), true);
  }
  return bytes;
}

/** Plays one cue's WAV bytes on the system's output; never waited on. */
export interface CuePlayer {
  play(wav: Uint8Array, moment: CueMoment): void;
}

/** The session's cues: `cue(moment)` plays the one the settings ask for now, or nothing. */
export class Cues {
  private readonly rendered = new Map<string, Uint8Array>();

  constructor(
    private readonly player: CuePlayer,
    /** `dictation.sounds` and `dictation.pill` as they are now. */
    private readonly settings: () => { sounds: unknown; pill: unknown },
  ) {}

  cue(moment: CueMoment): void {
    const s = this.settings();
    const style = cueStyle(s.sounds, s.pill);
    if (!style) return;
    const id = `${style}:${moment}`;
    let wav = this.rendered.get(id);
    if (!wav) {
      wav = wavBytes(renderCue(style, moment));
      this.rendered.set(id, wav);
    }
    this.player.play(wav, moment);
  }
}
