/**
 * The pieces every settings-like page is built from (docs/ux/design-explorations/README.md,
 * direction A): a page title with an optional search on its right, a section title, a rounded
 * panel of rows, and a row with its label and one short line of help on the left and its control
 * on the right. The controls are a switch, a segmented choice, a select, a text or number field
 * with its unit, keycaps, and a row that leads to another page. The Settings page and server
 * mode's Settings page draw from these, so both look the same.
 *
 * A control that a setting is saved from carries the setting's `data-key` on an input, select or
 * textarea, as the old form did: the save code reads it the same way whatever draws it
 * (`changedSettings` in `settings.ts`).
 */

import { append, h } from "./dom.ts";

type Child = Node | string | null | undefined | false;

const SVG = "http://www.w3.org/2000/svg";

/** A 16-unit line icon from its path data. */
export function icon(...paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "ico");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  chevron: ["m6 4 4 4-4 4"],
  back: ["m10 4-4 4 4 4"],
  updown: ["m5 6 3-3 3 3M5 10l3 3 3-3"],
  search: ["M11.5 7a4.5 4.5 0 1 1-9 0a4.5 4.5 0 1 1 9 0", "m10.5 10.5 3 3"],
  folder: ["M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"],
};

/**
 * The page's header: the way back from a page under another (`backLink`), then the title row with
 * what sits at its right (the search). In the macOS window its empty parts move the window, as a
 * title bar does, and its controls stay controls (`titleBar` in app.ts).
 */
export function pageHead(
  title: string,
  o: { back?: HTMLButtonElement; right?: Child[] } = {},
): HTMLElement {
  const head = h("div", { class: "pg-head" }, h("h1", {}, title), h("span", { class: "grow" }));
  append(head, ...(o.right ?? []));
  return h("div", { class: "pg-top" }, o.back ?? null, head);
}

/** "‹ Settings": the way back from a page under another. */
export function backLink(label: string, back: () => void): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: "pg-back", on: { click: back } },
    icon(...ICONS.back),
    label,
  );
}

/** A section: its title, then one panel of rows. */
export function section(title: string, ...rows: Child[]): HTMLElement {
  const panel = h("div", { class: "pg-grp" });
  append(panel, ...rows);
  return h(
    "section",
    { class: "pg-section", attrs: { "data-section": title } },
    h("h2", { class: "pg-sec" }, title),
    panel,
  );
}

export interface RowOptions {
  label: string;
  /** One short line under the label, plain and muted. */
  help?: Child;
  /** The setting this row saves, when it is one. */
  key?: string;
  /** The id of the control the label names. */
  for?: string;
  id?: string;
}

/** A row: the label and its help on the left, the controls on the right. */
export function row(o: RowOptions, ...controls: Child[]): HTMLElement {
  const label = o.for
    ? h("label", { class: "pg-name", attrs: { for: o.for } }, o.label)
    : h("b", { class: "pg-name" }, o.label);
  const ctl = h("div", { class: "pg-ctl" });
  append(ctl, ...controls);
  const attrs: Record<string, string> = {};
  if (o.key) attrs["data-key"] = o.key;
  return h(
    "div",
    { class: "pg-row", ...(o.id ? { id: o.id } : {}), attrs },
    h("div", { class: "pg-lbl" }, label, o.help ? h("div", { class: "pg-help" }, o.help) : null),
    ctl,
  );
}

/**
 * A row that leads to another page, the whole row one button: its help names what the page holds,
 * and its right side says the value or how many settings it holds.
 */
export function linkRow(
  o: { label: string; help?: string; value?: string; id?: string },
  go: () => void,
): HTMLButtonElement {
  return h(
    "button",
    {
      type: "button",
      class: "pg-row pg-link",
      ...(o.id ? { id: o.id } : {}),
      on: { click: go },
    },
    h(
      "span",
      { class: "pg-lbl" },
      h("b", { class: "pg-name" }, o.label),
      o.help ? h("span", { class: "pg-help" }, o.help) : null,
    ),
    h(
      "span",
      { class: "pg-ctl" },
      o.value ? h("span", { class: "pg-value" }, o.value) : null,
      h("span", { class: "pg-more" }, icon(...ICONS.chevron)),
    ),
  );
}

/** A switch: a checkbox drawn as one, with `role="switch"` so it is announced as one. */
export function toggle(o: { id: string; checked: boolean; label: string }): HTMLInputElement {
  const input = h("input", {
    id: o.id,
    type: "checkbox",
    class: "pg-switch",
    role: "switch",
    attrs: { "aria-label": o.label },
  });
  input.checked = o.checked;
  return input;
}

/**
 * A segmented choice: radio buttons drawn side by side. The value lives in a hidden input, which
 * carries the setting's key, so a save reads it like any field; a pick sets it and fires `change`.
 */
export function segmented(o: {
  id: string;
  label: string;
  options: readonly (readonly [value: string, label: string])[];
  value: string;
}): { root: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { id: o.id, type: "hidden", value: o.value });
  const root = h("div", {
    class: "pg-seg",
    role: "radiogroup",
    attrs: { "aria-label": o.label },
  });
  for (const [value, label] of o.options) {
    const radio = h("input", {
      type: "radio",
      value,
      attrs: { name: `${o.id}-choice`, "data-value": value },
    });
    radio.checked = value === o.value;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    root.append(h("label", {}, radio, h("span", {}, label)));
  }
  root.append(input);
  return { root, input };
}

/** A select drawn as the page's pop-up button. */
export function selectBox(o: {
  id: string;
  label: string;
  options: readonly (readonly [value: string, label: string])[];
  value: string;
}): HTMLSelectElement {
  const options = o.options.some(([v]) => v === o.value)
    ? o.options
    : [[o.value, o.value] as const, ...o.options];
  const select = h(
    "select",
    { id: o.id, class: "pg-select", attrs: { "aria-label": o.label } },
    ...options.map(([v, l]) => h("option", { value: v }, l)),
  );
  select.value = o.value;
  return select;
}

/** A text, password or number field; a number's unit follows it. */
export function field(o: {
  id: string;
  label: string;
  value: string;
  type?: "text" | "password" | "number";
  placeholder?: string;
  width?: "wide" | "narrow";
}): HTMLInputElement {
  return h("input", {
    id: o.id,
    type: o.type ?? "text",
    class: `pg-input${o.width === "narrow" ? " narrow" : ""}`,
    value: o.value,
    placeholder: o.placeholder ?? "",
    attrs: { "aria-label": o.label, autocomplete: "off", spellcheck: "false" },
  });
}

/** The unit after a number field. */
export function unit(text: string): HTMLElement {
  return h("span", { class: "pg-unit" }, text);
}

/** Keys as keycaps: `⌥`, `⌘`, `R`. */
export function keycaps(caps: readonly string[]): HTMLElement {
  return h(
    "span",
    { class: "pg-keys", attrs: { "aria-hidden": "true" } },
    ...caps.map((c) => h("kbd", { class: "pg-kcap" }, c)),
  );
}

/** A quiet button, the page's secondary action. */
export function button(label: string, click: () => void, id?: string): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: "pg-btn", ...(id ? { id } : {}), on: { click } },
    label,
  );
}
