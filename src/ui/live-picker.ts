/**
 * The live panel in the Record row (WINDOW W3.19, design-explorations/lm-live-menu-slots.html):
 * the "Live: <model>" button opens one panel with two slots.
 *
 * - **Live**: one radio row per downloaded model that can write the live transcript, by name with
 *   its line (the catalog's). The radio sits on the model the next call runs, `auto`'s pick
 *   included; picking one saves its id as `asr.live`.
 * - **Second pass**: Off, then each downloaded model that can review the finished sentences, and on
 *   the heading a 1 | 2 | 5 min switch (`asr.review.everySeconds`), dim while Off. A pick saves its
 *   id as `asr.review.model`.
 *
 * Each slot ends in "+ Add a model", which opens in place a box of the catalog models that fit the
 * slot and are not here: name, line, size and Download; while one downloads, its bar and Cancel
 * (`POST /models/pull`, `POST /models/cancel`, `GET /models`, the Models page's calls and words).
 * A model that lands moves up into the slot's rows and is not picked for you. "From a folder…" takes
 * a folder's path and copies the models found there (`POST /models/import`, as `akou models
 * import`). A slot with nothing downloaded says "No model yet." with the box already open, and the
 * button then reads "Live: no model".
 *
 * The button names what the next call runs: "Live: Nemotron 3.5", and "+ Qwen 2 min" in the dim
 * colour when a second pass is on. Record reads the settings again (after any save still on its way)
 * and sends them as the call's `live`, `review` and `reviewEvery`, so a change made in the CLI, the
 * API or the Models page is never overridden by what this button last read. While a call records
 * the button shows what that call runs and is disabled. Escape, a click outside or Tab out closes
 * the panel; arrow keys move between its radio rows; a download keeps running when it closes.
 * Server mode has no Record row and its `GET /models` has no `live` section, so the button stays
 * hidden there.
 */

import type { LiveView } from "../main/asr/live-setups.ts";
import type { ModelView } from "../main/server/model-store.ts";
import { byId, h, replace, toast } from "./dom.ts";
import {
  buttonLabel,
  everyChoices,
  everyShort,
  liveNote,
  type RunningLive,
  reviewNote,
  runningLabel,
  type Slot,
  type SlotRow,
  sizeShort,
  slotRows,
} from "./live-options.ts";
import { reasonText } from "./models-rows.ts";
import { message } from "./notepad.ts";
import type { Reply, Transport } from "./protocol.ts";

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

const SLOT_TITLE: Record<Slot, string> = { live: "Live", review: "Second pass" };
const KEY: Record<Slot, "asr.live" | "asr.review.model"> = {
  live: "asr.live",
  review: "asr.review.model",
};

export class LivePicker {
  private readonly box = byId("live-pick");
  private readonly button = byId<HTMLButtonElement>("live");
  private readonly label = byId("live-name");
  private readonly extra = byId("live-extra");
  private readonly panel = byId("live-menu");
  /** `GET /models`'s live section and model rows as last read; null before, or where there is none. */
  private view: LiveView | null = null;
  private rows: ModelView[] = [];
  /** Each slot's "Add a model" box: open or closed by hand, or null for the slot's default. */
  private adding: Record<Slot, boolean | null> = { live: null, review: null };
  /** The slot whose "From a folder…" field is open, and what is typed in it. */
  private folder: { slot: Slot; text: string } | null = null;
  /** A save still on its way, which Record waits for. */
  private saving: Promise<void> = Promise.resolve();
  /** The re-read while a model downloads, so its bar moves and it lands in its slot. */
  private poll: ReturnType<typeof setTimeout> | null = null;
  /** The live call as the status names it, or null with no call recording. */
  private running: RunningLive | null = null;
  /** Bumped by every read, so an older answer that lands late never draws over a newer one. */
  private reads = 0;

  constructor(private readonly d: LivePickerDeps) {
    this.button.addEventListener("click", () => this.open(this.panel.hasAttribute("hidden")));
    this.button.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" || !this.panel.hidden) return;
      e.preventDefault();
      this.open(true);
    });
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.open(false);
        this.button.focus();
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!step || !(e.target as HTMLElement).classList.contains("live-item")) return;
      const items = [
        ...this.panel.querySelectorAll<HTMLButtonElement>(".live-item:not(:disabled)"),
      ];
      const at = items.indexOf(e.target as HTMLButtonElement);
      if (at < 0 || items.length === 0) return;
      e.preventDefault();
      items[(at + step + items.length) % items.length]?.focus();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.panel.hidden && !this.box.contains(e.target as Node)) this.open(false);
    });
    // Tab out of the panel closes it, as a click elsewhere does.
    this.box.addEventListener("focusout", (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (!this.panel.hidden && to !== null && !this.box.contains(to)) this.open(false);
    });
    this.paint();
  }

  /**
   * What a call started from the window asks for: the settings read now, after any save still on
   * its way, or undefined to leave it to the app. Never the last read, which a change made
   * elsewhere may have outdated.
   */
  async value(): Promise<LiveAsk | undefined> {
    await this.saving;
    const read = await this.load();
    const v = read === undefined ? this.view : read;
    if (!v) return undefined;
    return { live: v.setting, review: v.review.setting, reviewEvery: v.review.everySeconds };
  }

  /** The live call, as the status push names it: the button shows what it runs and waits. */
  follow(live: RunningLive | null): void {
    const next = live
      ? {
          setup: live.setup ?? null,
          engine: live.engine ?? null,
          review: live.review ?? null,
          ...(live.name ? { name: live.name } : {}),
          ...(live.reviewName ? { reviewName: live.reviewName } : {}),
        }
      : null;
    if (JSON.stringify(next) === JSON.stringify(this.running)) return;
    this.running = next;
    if (next) this.open(false);
    this.paint();
  }

  /**
   * Reads the models again: after a download, a delete, a call, or the Models page. Answers the
   * live section it read (null where there is none), or undefined when the read failed.
   */
  async load(): Promise<LiveView | null | undefined> {
    const n = ++this.reads;
    let r: Reply<{ live?: LiveView; models?: ModelView[] }>;
    try {
      r = await this.d.t.request<{ live?: LiveView; models?: ModelView[] }>("GET", "/models");
    } catch {
      // The app is out of reach for a moment: the panel keeps what it last read.
      return undefined;
    }
    if (r.status >= 400) return undefined;
    const read = r.body.live ?? null;
    if (n !== this.reads) return read;
    const was = this.drawn();
    this.view = read;
    this.rows = r.body.models ?? [];
    this.paint();
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
    const downloading = this.view
      ? (["live", "review"] as const).some((s) =>
          slotRows(this.view as LiveView, this.rows, s).some((x) => x.state === "downloading"),
        )
      : false;
    // A model on its way: its bar moves every second while the panel is open, and it lands in its
    // slot when done.
    if (downloading)
      // clock: polls a model download while it runs.
      this.poll = setTimeout(() => void this.load(), this.panel.hidden ? 3000 : 1000);
    if (!this.panel.hidden && this.drawn() !== was) this.redraw();
    return read;
  }

  /** What the open panel shows, to tell whether a read changed it. */
  private drawn(): string {
    const v = this.view;
    if (!v) return "";
    return JSON.stringify([
      slotRows(v, this.rows, "live"),
      slotRows(v, this.rows, "review"),
      v.review.everySeconds,
      v.review.setting,
      liveNote(v, this.rows),
      reviewNote(v, this.rows),
    ]);
  }

  private paint(): void {
    this.box.hidden = this.view === null;
    const recording = this.running !== null;
    // A call whose audio has not reached the recognizer yet names nothing: show what it will run.
    const label =
      recording && this.running?.setup
        ? runningLabel(this.running as RunningLive)
        : this.view
          ? buttonLabel(this.view, this.rows)
          : { name: "no model", extra: null, none: true };
    if (this.label.textContent !== label.name) this.label.textContent = label.name;
    const extra = label.extra ? ` ${label.extra}` : "";
    if (this.extra.textContent !== extra) this.extra.textContent = extra;
    this.extra.hidden = extra === "";
    this.button.disabled = recording;
    const none = !recording && "none" in label && label.none;
    this.box.dataset.state = recording ? "recording" : none ? "none" : "ready";
    this.button.title = recording
      ? "This call keeps its models; a change applies from the next call."
      : none
        ? "No live model is downloaded yet."
        : ((this.view && liveNote(this.view, this.rows)) ??
          "The models that write the live transcript of the next call.");
  }

  private open(open: boolean): void {
    if (open && this.button.disabled) return;
    this.panel.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (!open) {
      this.folder = null;
      // Opened again, a slot with no model shows its box open again (W3.19).
      this.adding = { live: null, review: null };
      return;
    }
    this.draw();
    this.focusFirst();
    // The models may have changed since the last read: a download or a delete elsewhere.
    void this.load();
  }

  private focusFirst(): void {
    (
      this.panel.querySelector<HTMLElement>('.live-item[aria-checked="true"]:not(:disabled)') ??
      this.panel.querySelector<HTMLElement>("button:not(:disabled)")
    )?.focus();
  }

  /** Draws the panel again and keeps the focus on the same control when it is still there. */
  private redraw(focus?: string): void {
    const at = document.activeElement as HTMLElement | null;
    const inside = at !== null && this.panel.contains(at);
    const key = focus ?? (inside ? at?.dataset.focus : undefined);
    this.draw();
    const again = key
      ? this.panel.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)
      : null;
    if (again && !(again as HTMLButtonElement).disabled) again.focus();
    else if (inside) this.focusFirst();
  }

  private draw(): void {
    const v = this.view;
    if (!v) return;
    replace(
      this.panel,
      this.slot(v, "live"),
      h("div", { class: "live-sep", attrs: { role: "separator" } }),
      this.slot(v, "review"),
    );
  }

  /** One slot: its heading, its radio rows, and "+ Add a model". */
  private slot(v: LiveView, slot: Slot): HTMLElement {
    const all = slotRows(v, this.rows, slot);
    const here = all.filter((r) => r.state === "ready");
    const missing = all.filter((r) => r.state !== "ready");
    const note = slot === "live" ? liveNote(v, this.rows) : reviewNote(v, this.rows);
    const open = this.adding[slot] ?? here.length === 0;
    // Off is on whenever the next call runs no second pass, a saved one that cannot run included.
    const offChecked = slot === "review" && !v.review.next;
    const radios: HTMLElement[] = [
      ...(slot === "review"
        ? [
            this.radio(slot, {
              id: "none",
              name: "Off",
              line: "",
              checked: offChecked,
              blocked: null,
            }),
          ]
        : []),
      ...here.map((r) => this.radio(slot, r)),
    ];
    return h(
      "section",
      { class: "live-slot", attrs: { "data-slot": slot, "aria-label": SLOT_TITLE[slot] } },
      h(
        "div",
        { class: "live-head" },
        h("span", { class: "live-head-name" }, SLOT_TITLE[slot]),
        slot === "review" ? this.everySwitch(v) : null,
      ),
      ...(slot === "review"
        ? [h("p", { class: "live-before" }, "Also runs before an agent reads the call.")]
        : []),
      ...(note ? [h("p", { class: "live-note" }, note)] : []),
      h(
        "div",
        {
          class: "live-radios",
          attrs: { role: "radiogroup", "aria-label": `${SLOT_TITLE[slot]} model` },
        },
        ...radios,
      ),
      ...(here.length === 0 ? [h("p", { class: "live-none" }, "No model yet.")] : []),
      h(
        "button",
        {
          type: "button",
          class: "live-add",
          attrs: {
            "aria-expanded": String(open),
            "data-focus": `add-${slot}`,
            "data-add": slot,
          },
          on: {
            click: () => {
              this.adding[slot] = !open;
              this.redraw(`add-${slot}`);
            },
          },
        },
        h("span", { class: "live-plus", attrs: { "aria-hidden": "true" } }, open ? "−" : "+"),
        "Add a model",
      ),
      ...(open ? [this.catalog(slot, missing)] : []),
    );
  }

  /** A radio row: a pick saves the slot's key. Blocked, it is dim and its line says why. */
  private radio(
    slot: Slot,
    r: Pick<SlotRow, "id" | "name" | "line" | "checked" | "blocked">,
  ): HTMLElement {
    const dot = h("span", { class: "live-dot", attrs: { "aria-hidden": "true" } });
    return h(
      "button",
      {
        type: "button",
        role: "radio",
        class: "live-item",
        disabled: r.blocked !== null && !r.checked,
        attrs: {
          "aria-checked": String(r.checked),
          [`data-${slot === "live" ? "live" : "review"}`]: r.id,
          "data-focus": `${slot}:${r.id}`,
        },
        on: { click: () => void this.pick(slot, r.id) },
      },
      dot,
      h(
        "span",
        { class: "live-text" },
        h("span", { class: "live-title" }, r.name),
        ...(r.blocked || r.line ? [h("span", { class: "live-line" }, r.blocked ?? r.line)] : []),
      ),
    );
  }

  /** The Second pass heading's 1 | 2 | 5 min switch, dim while Off. */
  private everySwitch(v: LiveView): HTMLElement {
    const off = !v.review.next && !slotRows(v, this.rows, "review").some((r) => r.checked);
    return h(
      "span",
      {
        class: "live-every",
        attrs: {
          role: "radiogroup",
          "aria-label": "How often",
          ...(off ? { "data-off": "" } : {}),
        },
      },
      ...everyChoices(v.review.everySeconds).map((s) =>
        h(
          "button",
          {
            type: "button",
            role: "radio",
            class: "live-every-one",
            disabled: off,
            attrs: {
              "aria-checked": String(v.review.everySeconds === s),
              "data-every": String(s),
              "data-focus": `every:${s}`,
            },
            on: { click: () => void this.save("asr.review.everySeconds", s) },
          },
          everyShort(s),
        ),
      ),
    );
  }

  /** The "Add a model" box: what fits the slot and is not here, then "From a folder…". */
  private catalog(slot: Slot, missing: readonly SlotRow[]): HTMLElement {
    const rows = missing.map((r) => {
      const downloading = r.state === "downloading";
      const pct = r.size > 0 ? Math.round((100 * r.bytes) / r.size) : 0;
      return h(
        "div",
        { class: "live-cat-row", attrs: { "data-model": r.id } },
        h(
          "span",
          { class: "live-text" },
          h("span", { class: "live-title" }, r.name),
          h("span", { class: "live-line" }, `${r.line} ${sizeShort(r.size)}.`.trim()),
          ...(downloading
            ? [
                h(
                  "span",
                  {
                    class: "live-bar",
                    attrs: {
                      role: "progressbar",
                      "aria-label": `Downloading ${r.name}`,
                      "aria-valuemin": "0",
                      "aria-valuemax": "100",
                      "aria-valuenow": String(pct),
                    },
                  },
                  barFill(pct),
                ),
              ]
            : []),
        ),
        h(
          "button",
          {
            type: "button",
            class: "live-get",
            attrs: {
              "data-action": downloading ? "cancel" : "download",
              "data-focus": `get:${slot}:${r.id}`,
            },
            on: { click: () => void (downloading ? this.cancel(r) : this.download(r)) },
          },
          downloading ? "Cancel" : "Download",
        ),
      );
    });
    const f = this.folder?.slot === slot ? this.folder : null;
    return h(
      "div",
      { class: "live-cat", attrs: { "data-cat": slot } },
      ...(rows.length > 0
        ? rows
        : [h("p", { class: "live-cat-empty" }, "Every model that fits is already here.")]),
      f
        ? h(
            "form",
            {
              class: "live-folder",
              on: {
                submit: (e: Event) => {
                  e.preventDefault();
                  void this.importFrom(slot);
                },
              },
            },
            h("input", {
              class: "live-folder-path",
              type: "text",
              value: f.text,
              placeholder: "The folder's full path",
              attrs: {
                "aria-label": "Folder to copy the models from",
                "data-focus": `path:${slot}`,
              },
              on: {
                input: (e: Event) => {
                  if (this.folder) this.folder.text = (e.target as HTMLInputElement).value;
                },
              },
            }),
            h(
              "button",
              { type: "submit", class: "live-get", attrs: { "data-focus": `import:${slot}` } },
              "Copy",
            ),
          )
        : h(
            "button",
            {
              type: "button",
              class: "live-from",
              attrs: { "data-focus": `from:${slot}` },
              on: {
                click: () => {
                  this.folder = { slot, text: "" };
                  this.redraw(`path:${slot}`);
                },
              },
            },
            "From a folder…",
          ),
    );
  }

  private async pick(slot: Slot, id: string): Promise<void> {
    const v = this.view;
    if (!v) return;
    // Against the saved setting, not the radio: a model picked while `auto` resolves to it is
    // still a real change of asr.live, from `auto` to that model.
    if ((slot === "live" ? v.setting : v.review.setting) === id) return;
    await this.save(KEY[slot], id);
  }

  /** Saves one key; a failure says why and the next read shows what is saved. */
  private async save(
    key: "asr.live" | "asr.review.model" | "asr.review.everySeconds",
    value: string | number,
  ): Promise<void> {
    // A read already on its way carries the old setting: it must not draw over the save.
    this.reads++;
    const what = key === "asr.live" ? "The live model" : "The second pass";
    const save = async (): Promise<void> => {
      let r: Reply;
      try {
        r = await this.d.t.request("PATCH", "/config", { [key]: value });
      } catch {
        toast(`${what} could not be saved: akou is out of reach.`);
        return;
      }
      if (r.status >= 400)
        toast(message(r.body, `${what.toLowerCase()} could not be saved (HTTP ${r.status})`));
      await this.load();
    };
    const saving = save();
    this.saving = saving;
    await saving;
  }

  /** Downloads what a model needs, as the Models page's Download does. */
  private async download(r: SlotRow): Promise<void> {
    for (const id of r.models) {
      if (this.rows.find((x) => x.id === id)?.state === "ready") continue;
      const res = await this.d.t.request("POST", "/models/pull", { model: id }).catch(() => null);
      if (!res || res.status >= 400) {
        const why = reasonText(message(res?.body, ""));
        toast(`${r.name} could not start downloading${why ? `: ${why}` : ""}.`);
        break;
      }
    }
    await this.load();
  }

  /** Stops a model's download; the partial file stays for the next Download. */
  private async cancel(r: SlotRow): Promise<void> {
    for (const id of r.models) {
      const res = await this.d.t.request("POST", "/models/cancel", { model: id }).catch(() => null);
      // Already finished or stopped: the read below shows where it is.
      if (res && res.status >= 400 && res.status !== 404) {
        const why = reasonText(message(res.body, ""));
        toast(`${r.name} could not be stopped${why ? `: ${why}` : ""}.`);
      }
    }
    await this.load();
  }

  /** Copies the models found in the typed folder (`POST /models/import`). */
  private async importFrom(slot: Slot): Promise<void> {
    const dir = this.folder?.text.trim() ?? "";
    if (dir === "") return;
    const copying = this.d.t
      .request<{ copied?: string[] }>("POST", "/models/import", { dir })
      .catch(() => null);
    // A model being copied reads as downloading: its bar moves and Cancel stops it.
    // clock: polls a model copy while it runs.
    const follow = setInterval(() => void this.load(), 1000);
    const res = await copying.finally(() => clearInterval(follow));
    if (!res || res.status >= 400) {
      toast(`The models could not be copied: ${message(res?.body, "akou is out of reach")}.`);
      return;
    }
    const n = res.body.copied?.length ?? 0;
    toast(
      n === 0 ? "No model files of akou's were in that folder." : `Copied ${n} model files.`,
      "info",
    );
    this.folder = null;
    await this.load();
    this.redraw(`from:${slot}`);
  }
}

function barFill(pct: number): HTMLElement {
  const i = h("i", {});
  i.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return i;
}
