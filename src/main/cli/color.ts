/**
 * Colour in the terminal (docs/ux/CLI.md section 8, CLI-20). Only on a terminal, never with
 * `NO_COLOR`, never on `TERM=dumb` (`colorOn` in `cli.ts`), and never alone: every state keeps
 * its word (PRINCIPLES rule 12).
 *
 * Speakers get the window's hues in the window's order (`HueBook` in `src/ui/model.ts`): "you" on
 * the mic keeps its own, everyone else the next in order of first appearance. Each hue maps to the
 * nearest of the 16 colours every terminal has.
 */

import { HueBook } from "../../ui/model.ts";

const RESET = "\x1b[0m";

/** The window's hues (`YOU_HUE`, then `HUES`) as terminal colours. */
const ANSI_FOR_HUE: Readonly<Record<number, string>> = {
  214: "34", // you: blue
  36: "33", // orange: yellow
  145: "32", // green
  285: "35", // violet: magenta
  5: "91", // red: bright red, so it never reads as a dead channel
  178: "36", // cyan
  58: "93", // olive: bright yellow
  325: "95", // pink: bright magenta
  100: "92", // lime: bright green
};

export function paint(on: boolean, code: string, text: string): string {
  return on ? `\x1b[${code}m${text}${RESET}` : text;
}

export const dim = (on: boolean, text: string) => paint(on, "2", text);

/** Red for dead, yellow for quiet or degraded, as `status` and `watch` show a channel. */
export function healthWord(on: boolean, state: string): string {
  if (state === "dead" || state === "failed") return paint(on, "31", state);
  if (state === "ok") return state;
  return paint(on, "33", state);
}

/** One colour per speaker id for one output, the window's order. */
export class SpeakerColors {
  private readonly book = new HueBook();

  constructor(private readonly on: boolean) {}

  /** `spk` is the speaker id (`you`, `c2`); a renamed speaker keeps its colour. */
  name(spk: string, label: string): string {
    return paint(this.on, ANSI_FOR_HUE[this.book.hue(spk)] ?? "39", label);
  }
}
