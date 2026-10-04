/**
 * What the next call records besides the microphone (WINDOW W3.3, the call half): the
 * "Call: <choice>" button beside the live model opens a radio list of
 *
 * - **Whole computer** (`system`), **None (microphone only)** (`none`), and the apps playing sound
 *   now, by name, from `GET /apps` (the id is the tooltip), with Refresh;
 * - the row `capture.call` names (`GET /config`) marked "Default": the Settings value, whole
 *   computer unless the user chose otherwise there. A saved app that is not playing now keeps a row
 *   of its own.
 *
 * A pick holds for one call and is never saved: Record sends it as the call's `call` only when it
 * differs from the default, so a user who never opens the list sends exactly what Record always
 * sent, and the app resolves `capture.call` as before. The pick goes back to the default once the
 * start is answered, whether it started or not. Where one app cannot be recorded (`GET /apps` 501,
 * Linux) or the list cannot be read (503, file-only mode, no helper), the app rows are absent and a
 * line says why; Whole computer and None still work. Like the workspace and the title, the menu is
 * for the next call: disabled while a start is on its way and gone from the row while a call
 * records, when the row needs the room for Stop, Mute and Pause. Escape, a click outside or Tab
 * out closes the list; arrow keys move between its rows.
 */

import type { AudioApp } from "../main/capture/devices.ts";
import { byId, h, replace } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Reply, Transport } from "./protocol.ts";

/** `capture.call` when the config says nothing (schema.ts). */
const SYSTEM = "system";
const EMPTY =
  "No app is playing sound right now. Join the meeting first, or record the whole computer.";

/** A call side as the button and the rows say it: "Whole computer", "None", the apps' names. */
export function callName(mode: string, names: ReadonlyMap<string, string>): string {
  if (mode === SYSTEM) return "Whole computer";
  if (mode === "none" || mode === "") return "None";
  if (!mode.startsWith("app:")) return mode;
  const ids = mode
    .slice("app:".length)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  return ids.map((id) => names.get(id) ?? id).join(", ");
}

interface Row {
  value: string;
  name: string;
  line: string;
  tip?: string;
}

export class CallPicker {
  private readonly box = byId("call-source");
  private readonly button = byId<HTMLButtonElement>("call-pick");
  private readonly label = byId("call-name");
  private readonly panel = byId("call-menu");
  /** `capture.call` as `GET /config` last said it: the default row. */
  private fallback = SYSTEM;
  /** The row picked for the next call, or null for the default. Never saved. */
  private pick: string | null = null;
  /** The apps playing sound as `GET /apps` last listed them, or null with `why` saying why not. */
  private apps: AudioApp[] | null = null;
  private why: string | null = null;
  /** Every app id named so far, so a saved default names its app after it stopped playing. */
  private readonly names = new Map<string, string>();
  /** A call is starting or recording: the list waits for the next call. */
  private busy = false;
  /** Bumped by every read, so an older answer that lands late never draws over a newer one. */
  private reads = 0;

  constructor(private readonly t: Transport) {
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
      if (!step || !(e.target as HTMLElement).classList.contains("call-item")) return;
      const items = [...this.panel.querySelectorAll<HTMLButtonElement>(".call-item")];
      const at = items.indexOf(e.target as HTMLButtonElement);
      if (at < 0) return;
      e.preventDefault();
      items[(at + step + items.length) % items.length]?.focus();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.panel.hidden && !this.box.contains(e.target as Node)) this.open(false);
    });
    this.box.addEventListener("focusout", (e) => {
      const to = (e as FocusEvent).relatedTarget as Node | null;
      if (!this.panel.hidden && to !== null && !this.box.contains(to)) this.open(false);
    });
    this.paint();
    void this.load();
  }

  /** The `call` a start from the window sends: the pick, or undefined to leave it to the app. */
  value(): string | undefined {
    return this.pick ?? undefined;
  }

  /** The start was answered: the pick was for that one call, so the list goes back to the default. */
  used(): void {
    this.pick = null;
    this.paint();
    if (!this.panel.hidden) this.draw();
  }

  /** Whether a call is starting or recording. Called on every paint, so it draws only on a change. */
  follow(busy: boolean): void {
    if (busy === this.busy) return;
    const ended = this.busy && !busy;
    this.busy = busy;
    if (busy) this.open(false);
    // The default may have changed during the call, and so have the apps playing.
    if (ended) void this.load();
    this.paint();
  }

  /** Reads the default (`GET /config`) and the apps playing now (`GET /apps`) again. */
  async load(): Promise<void> {
    const n = ++this.reads;
    const get = <T>(path: string): Promise<Reply<T> | null> =>
      this.t.request<T>("GET", path).catch(() => null);
    const [config, apps] = await Promise.all([
      get<{ settings?: Record<string, unknown> }>("/config"),
      get<{ apps?: AudioApp[] }>("/apps"),
    ]);
    if (n !== this.reads) return;
    const saved = config && config.status < 400 ? config.body.settings?.["capture.call"] : null;
    if (typeof saved === "string" && saved !== "") this.fallback = saved;
    if (this.pick === this.fallback) this.pick = null;
    if (!apps) {
      this.apps = null;
      this.why = "akou is out of reach, so the apps playing now are not listed.";
    } else if (apps.status < 400) {
      this.apps = apps.body.apps ?? [];
      this.why = null;
      for (const a of this.apps) this.names.set(a.id, a.name);
    } else {
      this.apps = null;
      const why = message(apps.body, `HTTP ${apps.status}`);
      this.why =
        apps.status === 501
          ? `Recording one app is not available here: ${why}`
          : `The apps playing now cannot be listed: ${why}`;
    }
    this.paint();
    if (!this.panel.hidden) this.redraw();
  }

  private paint(): void {
    const name = callName(this.pick ?? this.fallback, this.names);
    if (this.label.textContent !== name) this.label.textContent = name;
    this.button.disabled = this.busy;
    this.box.dataset.state = this.pick !== null ? "picked" : "default";
    this.button.title =
      "What the next call records besides your microphone. A pick holds for one call; Settings holds the default.";
  }

  private open(open: boolean): void {
    if (open && this.button.disabled) return;
    this.panel.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (!open) return;
    this.draw();
    this.focusFirst();
    // An app may have started or stopped playing since the last read.
    void this.load();
  }

  private focusFirst(): void {
    (
      this.panel.querySelector<HTMLElement>('.call-item[aria-checked="true"]') ??
      this.panel.querySelector<HTMLElement>("button")
    )?.focus();
  }

  /** Draws the list again and keeps the focus on the same control when it is still there. */
  private redraw(): void {
    const at = document.activeElement as HTMLElement | null;
    const inside = at !== null && this.panel.contains(at);
    const key = inside ? at?.dataset.focus : undefined;
    this.draw();
    const again = key
      ? this.panel.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)
      : null;
    if (again) again.focus();
    else if (inside) this.focusFirst();
  }

  /** The rows above the apps: Whole computer, None, and a saved app that is not playing now. */
  private fixedRows(): Row[] {
    const rows: Row[] = [
      { value: SYSTEM, name: "Whole computer", line: "Everything this computer plays." },
      {
        value: "none",
        name: "None (microphone only)",
        line: "No call audio, only your microphone.",
      },
    ];
    const listed = this.apps?.some((a) => `app:${a.id}` === this.fallback) ?? false;
    if (this.fallback.startsWith("app:") && !listed) {
      rows.push({
        value: this.fallback,
        name: callName(this.fallback, this.names),
        line: "Not playing now.",
        tip: this.fallback.slice("app:".length),
      });
    }
    return rows;
  }

  private draw(): void {
    const appRows: Row[] = (this.apps ?? []).map((a) => ({
      value: `app:${a.id}`,
      name: a.name,
      line: "",
      tip: a.id,
    }));
    const note = this.why ?? (this.apps?.length === 0 ? EMPTY : null);
    replace(
      this.panel,
      h(
        "div",
        { class: "call-radios", attrs: { role: "radiogroup", "aria-label": "Call audio" } },
        ...this.fixedRows().map((r) => this.radio(r)),
      ),
      h("div", { class: "call-sep", attrs: { role: "separator" } }),
      h(
        "div",
        { class: "call-head" },
        h("span", { class: "call-head-name" }, "Apps playing now"),
        h(
          "button",
          {
            type: "button",
            class: "call-refresh",
            attrs: { "data-focus": "refresh" },
            on: { click: () => void this.load() },
          },
          "Refresh",
        ),
      ),
      ...(appRows.length > 0
        ? [
            h(
              "div",
              {
                class: "call-radios",
                attrs: { role: "radiogroup", "aria-label": "Apps playing now" },
              },
              ...appRows.map((r) => this.radio(r)),
            ),
          ]
        : []),
      ...(note ? [h("p", { class: "call-note" }, note)] : []),
    );
  }

  private radio(r: Row): HTMLElement {
    const checked = r.value === (this.pick ?? this.fallback);
    const fallback = r.value === this.fallback;
    const line = [fallback ? "Default, from Settings." : "", r.line].filter(Boolean).join(" ");
    return h(
      "button",
      {
        type: "button",
        role: "radio",
        class: "call-item",
        title: r.tip,
        attrs: {
          "aria-checked": String(checked),
          "data-call": r.value,
          "data-focus": `call:${r.value}`,
          ...(fallback ? { "data-default": "" } : {}),
        },
        on: { click: () => this.choose(r.value) },
      },
      h("span", { class: "call-dot", attrs: { "aria-hidden": "true" } }),
      h(
        "span",
        { class: "call-text" },
        h("span", { class: "call-title" }, r.name),
        ...(line ? [h("span", { class: "call-line" }, line)] : []),
      ),
    );
  }

  private choose(value: string): void {
    this.pick = value === this.fallback ? null : value;
    this.open(false);
    this.button.focus();
    this.paint();
  }
}
