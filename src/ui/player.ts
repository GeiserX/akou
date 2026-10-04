/**
 * The player bar (docs/ux/WINDOW.md section 5): play and pause (W5.2), the position and the part's
 * end as one wall-time readout with a scrubber over the part being played and the notes taken in
 * it marked on it (W5.3), the speed, 0.75x to 2x with `[` and `]` and
 * kept across visits (W5.4), 5 s back or forward with `Shift+←` and `Shift+→` (W5.5), and the
 * mic and call balance. On every move it names the line being played, so the transcript can light
 * it and keep it in view (W5.6).
 *
 * Audio is one part's file at a time, as `GET /calls/{id}/audio/{part}` serves it; the scrubber
 * and the 5 s seeks are bounded by that part. Every time shown goes through the part's clock, so a
 * pause inside the part is counted and no bare offset is ever drawn (TRAPS "Offsets shown as times
 * of day").
 */

import type { CallView } from "../core/log/fold.ts";
import { byId, h, replace } from "./dom.ts";
import {
  noteMarks,
  playingLine,
  positionText,
  RATES,
  rateLabel,
  restoreRate,
  SEEK_STEP_S,
  seekBy,
  stepRate,
} from "./model.ts";

const RATE_KEY = "akou.rate";

export interface PlayerDeps {
  view(): CallView | null;
  /** Whether audio may play now; it says why itself when not. */
  mayPlay(): boolean;
  /** The line being played (or none); `running` is false while paused. */
  playing(lineId: string | null, running: boolean): void;
  /** Nothing is loaded any more. */
  stopped(): void;
}

/** A key typed into a text control, a picker or a dialog belongs there, never to the player. */
function inField(t: EventTarget | null): boolean {
  return !!(t as HTMLElement | null)?.closest?.(
    "input, textarea, select, [contenteditable], dialog",
  );
}

export class Player {
  readonly el = byId<HTMLAudioElement>("player");
  private part: number | null = null;
  private rate = 1;
  private readonly scrub = byId<HTMLInputElement>("scrub");
  private readonly speed = byId<HTMLSelectElement>("speed");
  private mix: { mic: GainNode; call: GainNode } | null = null;
  private marksKey = "";
  /** A play asked for while a seek was on its way, run when the seek lands. */
  private queued: (() => void) | null = null;

  constructor(private readonly d: PlayerDeps) {
    const p = this.el;
    replace(this.speed, ...RATES.map((r) => h("option", { value: String(r) }, rateLabel(r))));
    this.setRate(restoreRate(localStorage.getItem(RATE_KEY)));
    for (const ev of ["play", "pause", "ended", "emptied"]) {
      p.addEventListener(ev, () => this.drawPlay());
    }
    for (const ev of ["timeupdate", "seeked", "play", "pause", "durationchange", "emptied"]) {
      p.addEventListener(ev, () => this.tick());
    }
    byId("play").addEventListener("click", () => this.toggle());
    this.scrub.addEventListener("input", () => {
      p.currentTime = Number(this.scrub.value);
      this.tick();
    });
    this.speed.addEventListener("change", () => this.setRate(Number(this.speed.value)));
    document.addEventListener("keydown", (e) => this.onKey(e));
    this.tick();
  }

  /** Plays one part's audio from `a0` seconds, for the line `lineId`. */
  load(url: string, part: number, a0: number, lineId: string): void {
    const p = this.el;
    this.unqueue();
    // A new source resets the element's rate to its default, which setRate keeps equal to ours.
    if (p.src !== url) p.src = url;
    this.part = part;
    p.dataset.line = lineId;
    p.dataset.seek = String(a0);
    // Play once the seek has landed: Linux WebKit's media backend left a seek started just before
    // play() pending for good in about one run in eight, and the line never played.
    const start = () => {
      if (p.dataset.line === lineId) void p.play().catch(() => {});
      this.drawPlay();
    };
    const seek = () => {
      p.addEventListener("seeked", start, { once: true });
      p.currentTime = a0;
      this.balance();
    };
    if (p.readyState >= 1) seek();
    else p.addEventListener("loadedmetadata", seek, { once: true });
  }

  /** Another call opened: the last one's audio stops and is let go, so nothing can resume it. */
  stop(): void {
    const p = this.el;
    this.unqueue();
    p.pause();
    p.removeAttribute("src");
    delete p.dataset.line;
    delete p.dataset.seek;
    this.part = null;
    p.load();
    this.tick();
  }

  toggle(): void {
    const p = this.el;
    if (!p.src) return;
    if (this.queued) this.unqueue();
    else if (!p.paused) p.pause();
    else if (this.d.mayPlay()) {
      // Play once a seek on its way has landed, as load() does: Linux WebKit's media backend
      // dropped a pause sent while a play waited on a seek, and kept playing.
      if (p.seeking) {
        const go = () => {
          this.queued = null;
          void p.play().catch(() => {});
          this.drawPlay();
        };
        this.queued = go;
        p.addEventListener("seeked", go, { once: true });
      } else void p.play().catch(() => {});
    }
    this.drawPlay();
  }

  /** A queued play is called off: a second press before the seek landed, or the audio let go. */
  private unqueue(): void {
    if (this.queued) this.el.removeEventListener("seeked", this.queued);
    this.queued = null;
  }

  /** Sets the speed everywhere it lives: the element, its default for the next part, the picker. */
  setRate(r: number): void {
    this.rate = r;
    this.el.defaultPlaybackRate = r;
    this.el.playbackRate = r;
    this.speed.value = String(r);
    localStorage.setItem(RATE_KEY, String(r));
  }

  /** The part's length: the element's once it knows it, else what the log says was written. */
  private duration(): number {
    const d = this.el.duration;
    if (Number.isFinite(d)) return d;
    const part = this.part === null ? undefined : this.d.view()?.part(this.part);
    return part?.ended?.fileSeconds ?? Number.NaN;
  }

  /**
   * Keys outside text fields: Space plays or pauses (W5.2), `[` and `]` change the speed (W5.4),
   * `Shift+←` and `Shift+→` seek 5 s (W5.5). They work from the scrubber and the speed picker too,
   * where the scrubber's plain arrows also seek 5 s and Space stays the picker's own key.
   */
  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    // The player's own controls are no text field: its keys work from them too (principle 11).
    const bar = t?.closest?.("#scrub, #speed") ?? null;
    if (!bar && inField(e.target)) return;
    const p = this.el;
    if (e.key === "[" || e.key === "]") {
      // Some layouts type a bracket with Option or AltGr (Ctrl+Alt on Windows): those still count.
      if (e.metaKey || (e.ctrlKey && !e.altKey)) return;
      e.preventDefault();
      this.setRate(stepRate(this.rate, e.key === "]" ? 1 : -1));
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || !p.src) return;
    if (e.key === " ") {
      // Any other focused control keeps Space as its own key, the speed picker too (Space opens
      // its list). A line's Play is taken, so the key pauses what it started instead of starting
      // the line again; the scrubber has no Space of its own.
      if (
        t?.closest("button, a[href], summary, [role=tab], select") &&
        !t.closest(".row .play, #play")
      )
        return;
      e.preventDefault();
      if (!e.repeat) this.toggle();
      return;
    }
    const arrow = e.key === "ArrowLeft" || e.key === "ArrowRight";
    // On the scrubber the plain arrows take the same 5 s, not the input's 0.1 s step.
    if (arrow && (e.shiftKey || bar?.id === "scrub")) {
      // The tabs move with the arrows themselves.
      if (t?.closest("[role=tab]")) return;
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      p.currentTime = seekBy(p.currentTime, dir * SEEK_STEP_S, this.duration());
    }
  }

  /** Redraws the position, the scrubber and the line being played from the element. */
  private tick(): void {
    const p = this.el;
    const v = this.d.view();
    const part = this.part;
    const pos = byId("pos");
    const end = byId("pos-end");
    if (!v || part === null || !p.src) {
      this.scrub.disabled = true;
      this.scrub.max = "0";
      this.scrub.value = "0";
      this.scrub.removeAttribute("aria-valuetext");
      pos.textContent = "";
      end.textContent = "";
      byId("pos-sep").textContent = "";
      this.marks();
      this.d.stopped();
      return;
    }
    const d = this.duration();
    const known = Number.isFinite(d);
    this.scrub.disabled = !known;
    if (known) this.scrub.max = String(d);
    this.scrub.value = String(p.currentTime);
    const at = positionText(v, part, p.currentTime);
    pos.textContent = at;
    this.scrub.setAttribute("aria-valuetext", at);
    end.textContent = known ? positionText(v, part, d) : "";
    byId("pos-sep").textContent = end.textContent ? " / " : "";
    this.marks();
    this.d.playing(playingLine(v.lines("best"), part, p.currentTime), !p.paused);
  }

  /**
   * The notes taken during the part being played, as marks on the scrubber (b2). Drawn again when
   * the part, its length or the notes change; the transcript calls it when a note lands.
   */
  marks(): void {
    const v = this.d.view();
    const d = this.duration();
    const at =
      v && this.part !== null && this.el.src && Number.isFinite(d)
        ? noteMarks(v, this.part, d)
        : [];
    const key = at.join(",");
    if (key === this.marksKey) return;
    this.marksKey = key;
    // Placed through the style object: the page's policy refuses a style attribute.
    replace(
      byId("marks"),
      ...at.map((f) => {
        const mk = h("i", { class: "mk" });
        mk.style.left = `${(f * 100).toFixed(2)}%`;
        return mk;
      }),
    );
  }

  /** An icon, round, as b2 draws it: its name says Play or Pause. */
  private drawPlay(): void {
    const p = this.el;
    const btn = byId<HTMLButtonElement>("play");
    btn.disabled = !p.src;
    btn.classList.toggle("playing", !p.paused);
    btn.setAttribute("aria-label", p.paused ? "Play" : "Pause");
  }

  /** Mic and call balance: the file keeps them on the left and the right channel. */
  private balance(): void {
    const b = Number(byId<HTMLInputElement>("balance").value);
    if (!this.mix) {
      try {
        const ctx = new AudioContext();
        const src = ctx.createMediaElementSource(this.el);
        const split = ctx.createChannelSplitter(2);
        const merge = ctx.createChannelMerger(2);
        const mic = ctx.createGain();
        const call = ctx.createGain();
        src.connect(split);
        split.connect(mic, 0);
        split.connect(call, 1);
        for (const g of [mic, call]) {
          g.connect(merge, 0, 0);
          g.connect(merge, 0, 1);
        }
        merge.connect(ctx.destination);
        this.mix = { mic, call };
        byId("balance").addEventListener("input", () => this.balance());
      } catch {
        return;
      }
    }
    this.mix.mic.gain.value = Math.min(1, 1 - b);
    this.mix.call.gain.value = Math.min(1, 1 + b);
  }
}
