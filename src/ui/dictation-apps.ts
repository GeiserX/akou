/**
 * The editor for per-app dictation rules, the `apps` setting type (docs/ux/DICTATION.md DC-U9):
 * one row per app, keyed by what the session captured as the app with the keyboard (a bundle id
 * on macOS, an executable name on Windows, a window class on Linux), each field a choice or
 * `global`, which leaves it out of the rule so the global setting applies.
 *
 * The rules travel as one JSON list in a hidden input carrying the setting's `data-key`, so the
 * settings code saves them like any other key: every edit writes the whole list through
 * `PATCH /config`, whose `apps` validator refuses an unknown field or an app named twice. A row
 * with no app yet is not part of the list, so adding a row saves nothing until the app is named.
 */

import { h } from "./dom.ts";

/**
 * A rule's fields and their choices, as the registry's `apps` validator takes them
 * (`src/main/config/schema.ts`). `null`: typed, not picked.
 */
export const APP_RULE_FIELDS: readonly { name: string; label: string; values: string[] | null }[] =
  [
    { name: "mode", label: "Mode", values: ["direct", "draft", "draft-send"] },
    { name: "insert", label: "Insert", values: ["paste", "type", "clipboard"] },
    {
      name: "sendKey",
      label: "Send key",
      values: ["Enter", "Ctrl+Enter", "Cmd+Enter", "Shift+Enter", "none"],
    },
    { name: "engine", label: "Engine", values: ["auto", "fast", "best", "remote"] },
    { name: "language", label: "Language", values: null },
    { name: "format", label: "Format", values: ["off", "provider"] },
  ];

type Rule = Record<string, string>;

/**
 * The editor for one `apps` setting. `input` holds the rules as JSON and fires `change` after each
 * edit; `shown` is the value as it came, for the settings code to tell an edit from none.
 */
export function appsEditor(
  id: string,
  value: unknown,
  disabled: boolean,
): { root: HTMLElement; input: HTMLInputElement; shown: string } {
  const input = h("input", { id, type: "hidden" });
  const body = h("tbody", {});
  const rules = () => {
    const out: Rule[] = [];
    for (const tr of body.querySelectorAll<HTMLTableRowElement>("tr")) {
      const rule: Rule = {};
      for (const el of tr.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]")) {
        const v = el.value.trim();
        if (v !== "") rule[el.dataset.field as string] = v;
      }
      if (rule.app) out.push(rule);
    }
    return out;
  };
  const changed = () => {
    const now = JSON.stringify(rules());
    if (now === input.value) return;
    input.value = now;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const row = (rule: Record<string, unknown>) => {
    const app = h("input", {
      type: "text",
      value: String(rule.app ?? ""),
      placeholder: "com.example.chat",
      attrs: { "data-field": "app", "aria-label": "App" },
      on: { change: changed },
    });
    const fields = APP_RULE_FIELDS.map((f) => {
      const v = typeof rule[f.name] === "string" ? (rule[f.name] as string) : "";
      const el =
        f.values === null
          ? h("input", {
              type: "text",
              value: v,
              placeholder: "global",
              attrs: { size: "6" },
            })
          : h(
              "select",
              {},
              h("option", { value: "" }, "global"),
              // A value the list does not hold (a hand-edited file) stays shown as it is.
              ...(v === "" || f.values.includes(v) ? f.values : [v, ...f.values]).map((x) =>
                h("option", { value: x }, x),
              ),
            );
      el.value = v;
      el.dataset.field = f.name;
      el.setAttribute("aria-label", f.label);
      el.addEventListener("change", changed);
      return h("td", {}, el);
    });
    const tr = h(
      "tr",
      {},
      h("td", {}, app),
      ...fields,
      h(
        "td",
        {},
        h(
          "button",
          {
            type: "button",
            class: "apps-remove",
            title: "Remove this rule",
            attrs: { "aria-label": "Remove this rule" },
            on: {
              click: () => {
                tr.remove();
                changed();
              },
            },
          },
          "×",
        ),
      ),
    );
    for (const el of tr.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      "input, select, button",
    ))
      el.disabled = disabled;
    return tr;
  };
  for (const r of Array.isArray(value) ? value : []) {
    if (typeof r === "object" && r !== null) body.append(row(r as Record<string, unknown>));
  }
  // What was shown, in the shape an edit writes: a saved rule whose keys come in another order is
  // no edit.
  const shown = JSON.stringify(rules());
  input.value = shown;
  const add = h(
    "button",
    {
      type: "button",
      class: "apps-add",
      on: {
        click: () => {
          const tr = row({});
          body.append(tr);
          tr.querySelector("input")?.focus();
        },
      },
    },
    "+ Add app",
  );
  add.disabled = disabled;
  const root = h(
    "div",
    { class: "apps-editor" },
    h(
      "table",
      { class: "apps-rules" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", {}, "App"),
          ...APP_RULE_FIELDS.map((f) => h("th", {}, f.label)),
          h("th", {}, ""),
        ),
      ),
      body,
    ),
    add,
  );
  return { root, input, shown };
}
