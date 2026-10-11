/**
 * Re-fits the window's webview when it no longer fills the window (TRAPS "A webview left at its
 * old size", DK-M7). ElectroBun 2.0.1 on macOS makes the main WKWebView with a fixed autoresizing
 * mask and fits it to the window only in `windowDidResize`, so a display or scale change that skips
 * that path leaves the page at its old size inside a bigger window, the rest showing the window's
 * grey. The page reports its viewport; when it differs from the window's content by more than a
 * pixel, the window is made a point wider and back, which runs `windowDidResize` twice and fits the
 * webview again.
 *
 * Only on macOS, where the window has a full-size content view (`hiddenInset`), so its frame is
 * its content. Loops are guarded: one nudge at a time, at most one a second, and never twice for
 * the same pair of sizes, so a mismatch a nudge cannot fix is tried once and left.
 */

export interface Size {
  width: number;
  height: number;
}

/** What the page reports: its viewport in CSS pixels, and the device pixel ratio for the log. */
export interface Viewport extends Size {
  dpr: number;
}

export interface RefitDeps {
  /** The window's content size in points; null once closed. */
  size(): Size | null;
  setSize(width: number, height: number): void;
  log(msg: string): void;
  /** clock: injected so tests decide what a second is. */
  now(): number;
  /** Runs the second half of the nudge on a later tick. */
  later(fn: () => void): void;
}

/** A nudge waits this long after the last. */
export const REFIT_GAP_MS = 1000;
/** A difference of up to this many pixels is rounding, not a webview left behind. */
export const REFIT_SLACK_PX = 1;

export class Refit {
  private busy = false;
  private last = Number.NEGATIVE_INFINITY;
  private tried = "";

  constructor(private readonly d: RefitDeps) {}

  /** The page's viewport now; true when it started a nudge. */
  check(view: Viewport): boolean {
    const win = this.d.size();
    if (!win || this.busy) return false;
    const off =
      Math.abs(view.width - win.width) > REFIT_SLACK_PX ||
      Math.abs(view.height - win.height) > REFIT_SLACK_PX;
    if (!off) return false;
    const pair = `${view.width}x${view.height}/${win.width}x${win.height}`;
    const now = this.d.now();
    if (now - this.last < REFIT_GAP_MS || pair === this.tried) return false;
    this.busy = true;
    this.last = now;
    this.tried = pair;
    this.d.log(
      `window re-fit: the page is ${view.width}x${view.height} at ${view.dpr}x in a window of ${win.width}x${win.height}`,
    );
    this.d.setSize(win.width + 1, win.height);
    this.d.later(() => {
      this.d.setSize(win.width, win.height);
      this.busy = false;
    });
    return true;
  }
}
