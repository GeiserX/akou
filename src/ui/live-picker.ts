/**
 * The live model the next call runs, in the Record row (WINDOW W3.19): a "Live: <model>" menu
 * button with a chevron. The menu lists the live models this machine can run by name (`GET
 * /models`, its `live` section), each with one plain line and a check on the one the next call
 * runs; a model that is not downloaded is shown dim with a Get button that opens the Models page.
 * With none downloaded the button reads "Live: no model" and the menu says so, with "Get models".
 *
 * Below a separator, "Second pass: <Off | Qwen, every 2 min>" opens an inline group: the model
 * that reviews the finished sentences (Off, Qwen, Parakeet; each dim with Get or with the reason
 * in plain words when it cannot run here) and how often (every 1, 2 or 5 minutes). Escape in the
 * group closes the group first.
 *
 * With `asr.live` `auto` the check sits on the model `auto` resolves to (the app's own rule), and
 * picking a model saves that model as `asr.live` (`PATCH /config`, that key only); a second-pass
 * pick saves `asr.review.model` or `asr.review.everySeconds` alone and leaves the menu open.
 * Record reads the settings again (after any save still on its way) and sends them as the call's
 * `live`, `review` and `reviewEvery`, so a change made in the CLI, the API, another window or the
 * Models page is never overridden by what this button last read. When `asr.live` names a model
 * whose files are not all here, no model is checked, the button names what calls run instead and
 * the menu says why. While a call records the button shows the model that call runs and is
 * disabled: a change applies from the next call. Server mode has no Record row and its `GET
 * /models` has no `live` section, so the button stays hidden there.
 */

import { everyText, liveModelName } from "../main/asr/live-names.ts";
import type { LiveView } from "../main/asr/live-setups.ts";
import { byId, h, replace, toast } from "./dom.ts";
import {
  type LiveOption,
  liveChecked,
  liveNote,
  liveOptions,
  liveTitle,
  REVIEW_EVERY_CHOICES,
  type ReviewOption,
  reviewChecked,
  reviewLabel,
  reviewNote,
  reviewOptions,
} from "./live-options.ts";
import { message } from "./notepad.ts";
import type { Reply, Transport } from "./protocol.ts";

const CHECK = "m3.5 8.5 3 3 6-7";
const CHEVRON = "m6 4.5 3.5 3.5L6 11.5";

function icon(d: string, cls: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `ico ${cls}`);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

export interface LivePickerDeps {
  t: Transport;
  /** Opens the Models page. */
  openModels(): void;
}

/** What a call started from the window asks for: the settings as they are now. */
export interface LiveAsk {
  live: string;
  review: string;
  reviewEvery: number;
}

export class LivePicker {
  private readonly box = byId("live-pick");
  private readonly button = byId<HTMLButtonElement>("live");
  private readonly label = byId("live-name");
  private readonly menuBox = byId("live-menu");
  /** `GET /models`'s live section as last read; null before it, or where there is none. */
  private view: LiveView | null = null;
  private options: LiveOption[] = [];
  /** The model with the check, or null when the saved one is not here. */
  private chosen: string | null = null;
  private reviews: ReviewOption[] = [];
  /** The second pass with the check, or null when the saved one cannot run. */
  private reviewChosen: string | null = null;
  /** The second pass's group is open in the menu. */
  private group = false;
  /** A pick's `PATCH /config` still on its way, which Record waits for. */
  private saving: Promise<void> = Promise.resolve();
  /** The re-read while a model downloads, so the menu gains the model when it lands. */
  private poll: ReturnType<typeof setTimeout> | null = null;
  /** The live call's model and second pass, or null with no call recording. */
  private running: {
    setup: string | null;
    engine: string | null;
    review: { model: string; everySeconds: number } | null;
  } | null = null;
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
      const inGroup = (document.activeElement as HTMLElement | null)?.closest("#live-review-group");
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (inGroup || (e.target as HTMLElement).id === "live-review") {
          if (this.group) {
            this.toggleGroup(false);
            return;
          }
        }
        this.menu(false);
        this.button.focus();
        return;
      }
      if ((e.target as HTMLElement).id === "live-review") {
        if (e.key === "ArrowRight" && !this.group) {
          e.preventDefault();
          this.toggleGroup(true);
          return;
        }
        if (e.key === "ArrowLeft" && this.group) {
          e.preventDefault();
          this.toggleGroup(false);
          return;
        }
      }
      if (e.key === "ArrowLeft" && inGroup) {
        e.preventDefault();
        this.toggleGroup(false);
        return;
      }
      const items = [...this.menuBox.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
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
   * What a call started from the window asks for: the settings read now, after any pick still
   * being saved, or undefined to leave it to the app. Never the last read, which a change made
   * elsewhere may have outdated.
   */
  async value(): Promise<LiveAsk | undefined> {
    await this.saving;
    // Its own answer, even when a later read supersedes it on screen.
    const read = await this.load();
    const v = read === undefined ? this.view : read;
    if (!v) return undefined;
    return { live: v.setting, review: v.review.setting, reviewEvery: v.review.everySeconds };
  }

  /** The live call, as the status push names it: the button shows its model and waits. */
  follow(
    live: {
      setup?: string | null;
      engine?: string | null;
      review?: { model: string; everySeconds: number } | null;
    } | null,
  ): void {
    const next = live
      ? { setup: live.setup ?? null, engine: live.engine ?? null, review: live.review ?? null }
      : null;
    if (JSON.stringify(next) === JSON.stringify(this.running)) return;
    this.running = next;
    if (next) this.menu(false);
    this.paint();
  }

  /**
   * Reads the live models again: after a download, a delete, a call, or the Models page. Answers
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
    const was = this.drawn();
    this.view = read;
    this.options = this.view ? liveOptions(this.view) : [];
    this.chosen = this.view ? liveChecked(this.view, this.options) : null;
    this.reviews = this.view ? reviewOptions(this.view) : [];
    this.reviewChosen = this.view ? reviewChecked(this.view, this.reviews) : null;
    this.paint();
    // A model on its way: read again shortly, so it can be picked when it lands.
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
    const downloading =
      this.view?.setups.some((s) => s.models.some((m) => m.state === "downloading")) ||
      this.view?.review.choices.some((c) => c.models.some((m) => m.state === "downloading"));
    if (downloading) this.poll = setTimeout(() => void this.load(), 3000);
    // An open menu is drawn again only when its lines changed, so the focus stays where it is.
    if (!this.menuBox.hidden && this.drawn() !== was) this.redraw();
    return read;
  }

  /** What the open menu shows, to tell whether a read changed it. */
  private drawn(): string {
    return JSON.stringify([
      this.options,
      this.chosen,
      this.note(),
      this.reviews,
      this.reviewChosen,
      this.view ? [reviewLabel(this.view), this.view.review.everySeconds] : null,
    ]);
  }

  private note(): string | null {
    return this.view ? liveNote(this.view, this.options) : null;
  }

  private paint(): void {
    this.box.hidden = this.view === null;
    const recording = this.running !== null;
    const any = this.options.length > 0;
    // What the next call runs: the checked model, or with the saved one not here, its fallback.
    const next = this.chosen ?? (this.view && any ? this.view.next : null);
    const name = recording
      ? liveModelName(this.running?.engine ?? this.running?.setup ?? next ?? "auto")
      : next
        ? liveTitle(this.view, next)
        : "no model";
    if (this.label.textContent !== name) this.label.textContent = name;
    this.button.disabled = recording;
    this.box.dataset.state = recording ? "recording" : any ? "ready" : "none";
    const review = this.running?.review;
    this.button.title = recording
      ? `This call keeps its live model${review ? ` and ${liveModelName(review.model)}'s second pass ${everyText(review.everySeconds)}` : ""}; a change applies from the next call.`
      : !any
        ? "No live model is downloaded yet."
        : (this.note() ?? "The model that writes the live transcript of the next call.");
  }

  private menu(open: boolean): void {
    if (open && this.button.disabled) return;
    this.menuBox.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (!open) {
      this.group = false;
      return;
    }
    this.drawMenu();
    this.focusMenu();
    // The list may have changed since the last read: a model downloaded or deleted elsewhere.
    void this.load();
  }

  private focusMenu(): void {
    (
      this.menuBox.querySelector<HTMLButtonElement>('.live-item[aria-checked="true"]') ??
      this.menuBox.querySelector<HTMLButtonElement>("button:not(:disabled)")
    )?.focus();
  }

  /** Draws the menu again and keeps the focus on the same control when it is still there. */
  private redraw(focus?: string): void {
    const at = document.activeElement as HTMLElement | null;
    const key = focus ?? (at && this.menuBox.contains(at) ? focusKey(at) : null);
    this.drawMenu();
    const again = key ? this.menuBox.querySelector<HTMLElement>(key) : null;
    if (again && !(again as HTMLButtonElement).disabled) again.focus();
    else this.focusMenu();
  }

  private toggleGroup(open: boolean): void {
    this.group = open;
    this.redraw("#live-review");
  }

  /** A Get button: opens the Models page, where the model downloads. */
  private get(what: string): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        role: "menuitem",
        class: "live-get-one",
        attrs: { "aria-label": `Get ${what}` },
        on: {
          click: (e: Event) => {
            e.stopPropagation();
            this.menu(false);
            this.d.openModels();
          },
        },
      },
      "Get",
    );
  }

  /**
   * A line that cannot be picked: dim, its reason in its line, and Get when a download fixes it.
   * The dim item and its Get are siblings in the row, so Get stays a working button.
   */
  private dim(
    data: Record<string, string>,
    title: string,
    line: string,
    missing: boolean,
    checked = false,
  ): HTMLElement {
    return h(
      "div",
      { class: "live-item dim", attrs: { role: "none", ...data } },
      h(
        "span",
        {
          class: "live-dim",
          attrs: {
            role: "menuitemradio",
            "aria-checked": String(checked),
            "aria-disabled": "true",
          },
        },
        icon(CHECK, "check"),
        h(
          "span",
          { class: "live-text" },
          h("span", { class: "live-title" }, title),
          h("span", { class: "live-line" }, line),
        ),
      ),
      ...(missing ? [this.get(title)] : []),
    );
  }

  private drawMenu(): void {
    if (this.options.length === 0 || !this.view) {
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
    const models = this.options.map((o) =>
      o.ready
        ? h(
            "button",
            {
              type: "button",
              role: "menuitemradio",
              class: "live-item",
              attrs: { "aria-checked": String(o.id === this.chosen), "data-live": o.id },
              on: { click: () => void this.pick(o.id) },
            },
            icon(CHECK, "check"),
            h(
              "span",
              { class: "live-text" },
              h("span", { class: "live-title" }, o.title),
              h("span", { class: "live-line" }, o.line),
            ),
          )
        : this.dim({ "data-live": o.id }, o.title, `Not downloaded. ${o.line}`, true),
    );
    replace(
      this.menuBox,
      ...(note ? [h("p", { class: "live-note" }, note)] : []),
      ...models,
      h("div", { class: "live-sep", attrs: { role: "separator" } }),
      h(
        "button",
        {
          type: "button",
          id: "live-review",
          role: "menuitem",
          class: "live-review",
          attrs: { "aria-expanded": String(this.group), "aria-controls": "live-review-group" },
          on: { click: () => this.toggleGroup(!this.group) },
        },
        h("span", { class: "live-review-key" }, "Second pass:"),
        h("span", { id: "live-review-name" }, reviewLabel(this.view)),
        icon(CHEVRON, "chev"),
      ),
      ...(this.group ? [this.reviewGroup(this.view)] : []),
    );
  }

  /** The second pass's group: its model, a note when the saved one cannot run, and how often. */
  private reviewGroup(v: LiveView): HTMLElement {
    const note = reviewNote(v, this.reviews);
    const on = this.reviewChosen !== null && this.reviewChosen !== "none";
    return h(
      "div",
      { id: "live-review-group", attrs: { role: "group", "aria-label": "Second pass" } },
      ...(note ? [h("p", { class: "live-note" }, note)] : []),
      ...this.reviews.map((o) =>
        o.state === "ready"
          ? h(
              "button",
              {
                type: "button",
                role: "menuitemradio",
                class: "live-item",
                attrs: {
                  "aria-checked": String(o.id === this.reviewChosen),
                  "data-review": o.id,
                },
                on: { click: () => void this.save("asr.review.model", o.id) },
              },
              icon(CHECK, "check"),
              h(
                "span",
                { class: "live-text" },
                h("span", { class: "live-title" }, o.title),
                h("span", { class: "live-line" }, o.line),
              ),
            )
          : this.dim(
              { "data-review": o.id },
              o.title,
              o.state === "missing" ? `Not downloaded. ${o.line}` : o.line,
              o.state === "missing",
              o.id === this.reviewChosen,
            ),
      ),
      h(
        "div",
        { class: "live-every", attrs: { role: "group", "aria-label": "How often" } },
        h("span", { class: "live-every-key" }, "Every"),
        ...REVIEW_EVERY_CHOICES.map((s) =>
          h(
            "button",
            {
              type: "button",
              role: "menuitemradio",
              class: "live-every-one",
              disabled: !on,
              attrs: {
                "aria-checked": String(v.review.everySeconds === s),
                "data-every": String(s),
              },
              on: { click: () => void this.save("asr.review.everySeconds", s) },
            },
            `${s / 60} min`,
          ),
        ),
      ),
    );
  }

  private async pick(id: string): Promise<void> {
    this.menu(false);
    this.button.focus();
    // Against the saved setting, not the check: a model picked while `auto` resolves to it is
    // still a real change of asr.live, from `auto` to that model.
    if (!this.view || id === this.view.setting) return;
    // A read already on its way carries the old setting: it must not draw over the pick.
    this.reads++;
    const before = this.chosen;
    this.chosen = id;
    this.paint();
    await this.save("asr.live", id, () => {
      this.chosen = before;
      this.paint();
    });
  }

  /** Saves one key; a failure puts back what was shown and says why. */
  private async save(
    key: "asr.live" | "asr.review.model" | "asr.review.everySeconds",
    value: string | number,
    undo?: () => void,
  ): Promise<void> {
    const failed = (why: string) => {
      undo?.();
      toast(why);
    };
    const what = key === "asr.live" ? "The live model" : "The second pass";
    const save = async (): Promise<void> => {
      let r: Reply;
      try {
        r = await this.d.t.request("PATCH", "/config", { [key]: value });
      } catch {
        failed(`${what} could not be saved: akou is out of reach.`);
        return;
      }
      if (r.status >= 400) {
        failed(message(r.body, `${what.toLowerCase()} could not be saved (HTTP ${r.status})`));
        return;
      }
      await this.load();
    };
    const saving = save();
    this.saving = saving;
    await saving;
  }
}

/** A selector that finds a menu control again after the menu is drawn anew. */
function focusKey(el: HTMLElement): string | null {
  if (el.id) return `#${el.id}`;
  const host = el.closest<HTMLElement>("[data-live],[data-review],[data-every]");
  if (!host) return null;
  const [k, v] =
    host.dataset.live !== undefined
      ? ["data-live", host.dataset.live]
      : host.dataset.review !== undefined
        ? ["data-review", host.dataset.review]
        : ["data-every", host.dataset.every];
  return `[${k}="${v}"]${host === el ? "" : " .live-get-one"}`;
}
