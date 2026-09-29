/**
 * The live model the next call runs, in the Record row (WINDOW W3.19): a "Live: <choice>" menu
 * button with a chevron where the Template select used to be. The menu lists only the live setups
 * whose models are on this machine (`GET /models`, its `live` section), each with one plain line
 * and a check on the chosen one; Automatic heads the list whenever at least one setup is there.
 * With none downloaded the button reads "Live: no model" and the menu says so, with "Get models"
 * opening the Models page.
 *
 * The check sits on `asr.live`; picking a line saves it as `asr.live` (`PATCH /config`, that key
 * only), so the Models page and this button always agree. Record reads `asr.live` again (after any
 * save still on its way) and sends it as the call's `live`, so a change made in the CLI, the API,
 * another window or the Models page is never overridden by what this button last read. When
 * `asr.live` names a setup whose models are not all here, no line is checked, the button names what
 * calls run instead and the menu says why. While a call records the button shows the setup that
 * call runs and is disabled: a change applies from the next call. Server mode has no Record row and its
 * `GET /models` has no `live` section, so the button stays hidden there.
 */

import type { LiveSetting, LiveView } from "../main/asr/live-setups.ts";
import { byId, h, replace, toast } from "./dom.ts";
import { type LiveOption, liveChecked, liveNote, liveOptions, liveTitle } from "./live-options.ts";
import { message } from "./notepad.ts";
import type { Reply, Transport } from "./protocol.ts";

const CHECK = "m3.5 8.5 3 3 6-7";

function check(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico check");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", CHECK);
  svg.append(path);
  return svg;
}

export interface LivePickerDeps {
  t: Transport;
  /** Opens the Models page. */
  openModels(): void;
}

export class LivePicker {
  private readonly box = byId("live-pick");
  private readonly button = byId<HTMLButtonElement>("live");
  private readonly label = byId("live-name");
  private readonly menuBox = byId("live-menu");
  /** `GET /models`'s live section as last read; null before it, or where there is none. */
  private view: LiveView | null = null;
  private options: LiveOption[] = [];
  /** The line with the check: `asr.live` when it is listed, else null. */
  private chosen: LiveSetting | null = null;
  /** A pick's `PATCH /config` still on its way, which Record waits for. */
  private saving: Promise<void> = Promise.resolve();
  /** The re-read while a model downloads, so the menu gains the setup when it lands. */
  private poll: ReturnType<typeof setTimeout> | null = null;
  /** The setup the live call runs, or null with no call recording. */
  private running: { setup: string | null } | null = null;
  /** Bumped by every read, so an older answer that lands late never draws over a newer one. */
  private reads = 0;

  constructor(private readonly d: LivePickerDeps) {
    this.button.addEventListener("click", () => this.menu(this.menuBox.hasAttribute("hidden")));
    this.button.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" || !this.menuBox.hidden) return;
      e.preventDefault();
      this.menu(true);
    });
    this.menuBox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.menu(false);
        this.button.focus();
        return;
      }
      const items = [...this.menuBox.querySelectorAll<HTMLButtonElement>("button")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (step && items.length > 0 && at >= 0) {
        e.preventDefault();
        items[(at + step + items.length) % items.length]?.focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.menuBox.hidden && !this.box.contains(e.target as Node)) this.menu(false);
    });
    // Tab out of the menu closes it, as a click elsewhere does.
    this.box.addEventListener("focusout", (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (!this.menuBox.hidden && to !== null && !this.box.contains(to)) this.menu(false);
    });
    this.paint();
  }

  /**
   * The `live` a call started from the window asks for: `asr.live` read now, after any pick still
   * being saved, or undefined to leave it to the app. Never the last read, which a change made
   * elsewhere may have outdated.
   */
  async value(): Promise<LiveSetting | undefined> {
    await this.saving;
    // Its own answer, even when a later read supersedes it on screen.
    const read = await this.load();
    return (read === undefined ? this.view : read)?.setting;
  }

  /** The live call, as the status push names it: the button shows its setup and waits. */
  follow(live: { setup?: string | null } | null): void {
    const next = live ? { setup: live.setup ?? null } : null;
    if (JSON.stringify(next) === JSON.stringify(this.running)) return;
    this.running = next;
    if (next) this.menu(false);
    this.paint();
  }

  /**
   * Reads the live setups again: after a download, a delete, a call, or the Models page. Answers
   * the live section it read (null where there is none), or undefined when the read failed.
   */
  async load(): Promise<LiveView | null | undefined> {
    const n = ++this.reads;
    let r: Reply<{ live?: LiveView }>;
    try {
      r = await this.d.t.request<{ live?: LiveView }>("GET", "/models");
    } catch {
      // The app is out of reach for a moment: the menu keeps what it last read.
      return undefined;
    }
    if (r.status >= 400) return undefined;
    const read = r.body.live ?? null;
    if (n !== this.reads) return read;
    const was = JSON.stringify([this.options, this.chosen, this.note()]);
    this.view = read;
    this.options = this.view ? liveOptions(this.view) : [];
    this.chosen = this.view ? liveChecked(this.view, this.options) : null;
    this.paint();
    // A model on its way: read again shortly, so the setup is listed when it lands.
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
    const downloading = this.view?.setups.some((s) =>
      s.models.some((m) => m.state === "downloading"),
    );
    if (downloading) this.poll = setTimeout(() => void this.load(), 3000);
    // An open menu is drawn again only when its lines changed, so the focus stays where it is.
    if (!this.menuBox.hidden && JSON.stringify([this.options, this.chosen, this.note()]) !== was) {
      this.drawMenu();
      this.focusMenu();
    }
    return read;
  }

  private note(): string | null {
    return this.view ? liveNote(this.view, this.options) : null;
  }

  private paint(): void {
    this.box.hidden = this.view === null;
    const recording = this.running !== null;
    const any = this.options.length > 0;
    // What the next call runs: the checked line, or with the saved setup not here, its fallback.
    const next = this.chosen ?? (this.view && any ? this.view.next : null);
    const name = recording
      ? liveTitle(this.running?.setup ?? next ?? "auto")
      : next
        ? liveTitle(next)
        : "no model";
    if (this.label.textContent !== name) this.label.textContent = name;
    this.button.disabled = recording;
    this.box.dataset.state = recording ? "recording" : any ? "ready" : "none";
    this.button.title = recording
      ? "This call keeps its live model; a change applies from the next call."
      : !any
        ? "No live model is downloaded yet."
        : (this.note() ?? "The model that writes the live transcript of the next call.");
  }

  private menu(open: boolean): void {
    if (open && this.button.disabled) return;
    this.menuBox.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (!open) return;
    this.drawMenu();
    this.focusMenu();
    // The list may have changed since the last read: a model downloaded or deleted elsewhere.
    void this.load();
  }

  private focusMenu(): void {
    (
      this.menuBox.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      this.menuBox.querySelector<HTMLButtonElement>("button")
    )?.focus();
  }

  private drawMenu(): void {
    if (this.options.length === 0) {
      replace(
        this.menuBox,
        h("p", { class: "live-none" }, "No live model is downloaded yet."),
        h(
          "button",
          {
            type: "button",
            id: "live-get",
            role: "menuitem",
            class: "live-get",
            on: {
              click: () => {
                this.menu(false);
                this.d.openModels();
              },
            },
          },
          "Get models",
        ),
      );
      return;
    }
    const note = this.note();
    replace(
      this.menuBox,
      ...(note ? [h("p", { class: "live-note" }, note)] : []),
      ...this.options.map((o) =>
        h(
          "button",
          {
            type: "button",
            role: "menuitemradio",
            class: "live-item",
            attrs: { "aria-checked": String(o.id === this.chosen), "data-live": o.id },
            on: { click: () => void this.pick(o.id) },
          },
          check(),
          h(
            "span",
            { class: "live-text" },
            h("span", { class: "live-title" }, o.title),
            h("span", { class: "live-line" }, o.line),
          ),
        ),
      ),
    );
  }

  private async pick(id: LiveSetting): Promise<void> {
    this.menu(false);
    this.button.focus();
    // Against the saved setting, not the check: Automatic picked while the saved setup is not
    // here is a real change of asr.live.
    if (!this.view || id === this.view.setting) return;
    // A read already on its way carries the old setting: it must not draw over the pick.
    this.reads++;
    const before = this.chosen;
    this.chosen = id;
    this.paint();
    const failed = (why: string) => {
      this.chosen = before;
      this.paint();
      toast(why);
    };
    const save = async (): Promise<void> => {
      let r: Reply;
      try {
        r = await this.d.t.request("PATCH", "/config", { "asr.live": id });
      } catch {
        failed("The live model could not be saved: akou is out of reach.");
        return;
      }
      if (r.status >= 400) {
        failed(message(r.body, `the live model could not be saved (HTTP ${r.status})`));
        return;
      }
      await this.load();
    };
    const saving = save();
    this.saving = saving;
    await saving;
  }
}
