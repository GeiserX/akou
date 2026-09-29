/**
 * The live model the next call runs, in the Record row (WINDOW W3.19): a "Live: <choice>" menu
 * button with a chevron where the Template select used to be. The menu lists only the live setups
 * whose models are on this machine (`GET /models`, its `live` section), each with one plain line
 * and a check on the chosen one; Automatic heads the list whenever at least one setup is there.
 * With none downloaded the button reads "Live: no model" and the menu says so, with "Get models"
 * opening the Models page.
 *
 * The choice starts as `asr.live` and is sent as `live` with the next `POST /calls`; picking one
 * also saves it as `asr.live` (`PATCH /config`, that key only), so the Models page and this
 * button always agree. While a call records the button shows the setup that call runs and is
 * disabled: a change applies from the next call. Server mode has no Record row and its
 * `GET /models` has no `live` section, so the button stays hidden there.
 */

import type { LiveSetting, LiveView } from "../main/asr/live-setups.ts";
import { byId, h, replace, toast } from "./dom.ts";
import { type LiveOption, liveChosen, liveOptions, liveTitle } from "./live-options.ts";
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
  private chosen: LiveSetting | null = null;
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
    this.paint();
  }

  /** The `live` a call started from the window asks for, or undefined to leave it to the app. */
  value(): LiveSetting | undefined {
    return this.chosen ?? undefined;
  }

  /** The live call, as the status push names it: the button shows its setup and waits. */
  follow(live: { setup?: string | null } | null): void {
    const next = live ? { setup: live.setup ?? null } : null;
    if (JSON.stringify(next) === JSON.stringify(this.running)) return;
    this.running = next;
    if (next) this.menu(false);
    this.paint();
  }

  /** Reads the live setups again: after a download, a delete, a call, or the Models page. */
  async load(): Promise<void> {
    const n = ++this.reads;
    let r: Reply<{ live?: LiveView }>;
    try {
      r = await this.d.t.request<{ live?: LiveView }>("GET", "/models");
    } catch {
      // The app is out of reach for a moment: the menu keeps what it last read.
      return;
    }
    if (n !== this.reads || r.status >= 400) return;
    const was = JSON.stringify([this.options, this.chosen]);
    this.view = r.body.live ?? null;
    this.options = this.view ? liveOptions(this.view) : [];
    this.chosen = this.view ? liveChosen(this.view, this.options) : null;
    this.paint();
    // An open menu is drawn again only when its lines changed, so the focus stays where it is.
    if (!this.menuBox.hidden && JSON.stringify([this.options, this.chosen]) !== was) {
      this.drawMenu();
      this.focusMenu();
    }
  }

  private paint(): void {
    this.box.hidden = this.view === null;
    const recording = this.running !== null;
    const name = recording
      ? liveTitle(this.running?.setup ?? this.chosen ?? "auto")
      : this.chosen
        ? liveTitle(this.chosen)
        : "no model";
    if (this.label.textContent !== name) this.label.textContent = name;
    this.button.disabled = recording;
    this.box.dataset.state = recording ? "recording" : this.chosen ? "ready" : "none";
    this.button.title = recording
      ? "This call keeps its live model; a change applies from the next call."
      : this.chosen
        ? "The model that writes the live transcript of the next call."
        : "No live model is downloaded yet.";
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
    replace(
      this.menuBox,
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
    if (id === this.chosen) return;
    const before = this.chosen;
    this.chosen = id;
    this.paint();
    const failed = (why: string) => {
      this.chosen = before;
      this.paint();
      toast(why);
    };
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
  }
}
