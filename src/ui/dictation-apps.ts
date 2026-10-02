/**
 * The editor for per-app dictation rules, the `apps` setting type (docs/ux/DICTATION.md DC-U9):
 * one row per app, keyed by what the session captured as the app with the keyboard (a bundle id
 * on macOS, an executable name on Windows, a window class on Linux) and named by the app's own
 * name where the helper reported one (`Slack`, the rule's `name`), saying its rule in a few words
 * and opening to its fields. Each field is a choice or "Like everywhere else", which leaves
 * it out of the rule so the global setting applies.
 *
 * The rules travel as one JSON list in a hidden input carrying the setting's `data-key`, so the
 * settings code saves them like any other key: every edit writes the whole list through
 * `PATCH /config`, whose `apps` validator refuses an unknown field or an app named twice. A row
 * with no app yet is not part of the list, so adding a row saves nothing until the app is named.
 *
 * "Use the app I dictate into next" names the app for the user: the page waits for the next
 * dictation in the dictation log and adds a rule for the app it went to (`nextDictatedApp`).
 */

import { QWEN_LANGUAGE_CODES } from "../main/asr/llama-catalog.ts";
import { languageName } from "./dictation-languages.ts";
import { h } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Reply, Transport } from "./protocol.ts";
import { button, ICONS, icon, row } from "./rows.ts";

/**
 * A rule's fields and their choices, as the registry's `apps` validator takes them
 * (`src/main/config/schema.ts`), each named in words. `null`: typed, not picked.
 */
export const APP_RULE_FIELDS: readonly {
  name: string;
  label: string;
  values: readonly (readonly [value: string, label: string])[] | null;
}[] = [
  {
    name: "mode",
    label: "What a dictation does",
    values: [
      ["direct", "Goes straight in"],
      ["draft", "Draft first"],
      ["draft-send", "Draft first, then send"],
    ],
  },
  {
    name: "insert",
    label: "How the words go in",
    values: [
      ["paste", "Paste"],
      ["type", "Types the keys"],
      ["clipboard", "Copy only"],
    ],
  },
  {
    name: "sendKey",
    label: "Send key",
    values: [
      ["Enter", "Enter"],
      ["Ctrl+Enter", "Control+Enter"],
      ["Cmd+Enter", "Command+Enter"],
      ["Shift+Enter", "Shift+Enter"],
      ["none", "Never sends"],
    ],
  },
  {
    name: "engine",
    label: "Speed or accuracy",
    values: [
      ["auto", "Automatic"],
      ["fast", "Fast"],
      ["best", "Best"],
      ["remote", "Another computer"],
    ],
  },
  {
    name: "language",
    label: "Language",
    values: QWEN_LANGUAGE_CODES.map((c) => [c, languageName(c)] as const),
  },
  {
    name: "format",
    label: "Tidy the text with AI",
    values: [
      ["off", "Off"],
      ["provider", "On"],
    ],
  },
];

/** What a field left out of a rule means: the setting everywhere else applies. */
export const APP_RULE_GLOBAL = "Like everywhere else";

/** A rule in a few words, for its row: "Draft first, then send", "Types the keys, never sends". */
export function ruleSummary(rule: Readonly<Record<string, string>>): string {
  const words = (name: string): string | null => {
    const v = rule[name];
    if (!v) return null;
    const f = APP_RULE_FIELDS.find((x) => x.name === name);
    const named = f?.values?.find(([x]) => x === v)?.[1];
    if (name === "language") return `in ${named ?? v}`;
    if (name === "engine") return named ? `${named.toLowerCase()} engine` : v;
    if (name === "format") return v === "provider" ? "tidied with AI" : "never tidied";
    if (name === "sendKey") return v === "none" ? "never sends" : `sends with ${named ?? v}`;
    return named ?? v;
  };
  const parts = ["mode", "insert", "sendKey", "engine", "language", "format"]
    .map(words)
    .filter((x): x is string => x !== null)
    .map((x, i) => (i === 0 ? x : x.charAt(0).toLowerCase() + x.slice(1)));
  if (parts.length === 0) return APP_RULE_GLOBAL;
  const out = parts.join(", ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

type Rule = Record<string, string>;

/**
 * Waits for the next dictation into an app and hands over that app, once; `failed` gets the reason
 * instead, and nothing more comes after either. `stop` gives up waiting.
 */
export type NextApp = (
  found: (app: string, name?: string) => void,
  failed: (why: string) => void,
) => { stop(): void };

/** How often the page reads the dictation log while it waits for the next dictation. */
export const NEXT_APP_POLL_MS = 1000;

/** The button's words while the page is not waiting. */
export const NEXT_APP_LABEL = "Use the app I dictate into next";

/** What the page says while it waits. */
export const NEXT_APP_WAITING = "Waiting: dictate into the app you want a rule for.";

/**
 * The next dictation's app from the dictation log (DC-U9): the newest dictation's start is read
 * once, then `GET /dictations?since=` after it, every `every` ms, until a dictation started later
 * names an app. A clip sent to the API goes to no app (`null`) and an app the helper could not tell
 * is empty; both are passed over. The times are the log's own, so the page's clock plays no part.
 */
export function nextDictatedApp(
  t: Transport,
  found: (app: string, name?: string) => void,
  failed: (why: string) => void,
  every = NEXT_APP_POLL_MS,
): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  type Page = { items?: { at?: unknown; app?: unknown; app_name?: unknown }[] };
  const read = async (query: string): Promise<Page["items"] | null> => {
    let r: Reply<Page>;
    try {
      r = await t.request<Page>("GET", `/dictations?${query}`);
    } catch (err) {
      // A request that never answered (the app went away) ends the wait like a refusal does.
      if (stopped) return null;
      stopped = true;
      failed(`the dictations could not be read: ${(err as Error).message}`);
      return null;
    }
    if (stopped) return null;
    if (r.status >= 400 || !Array.isArray(r.body?.items)) {
      stopped = true;
      failed(message(r.body, `the dictations could not be read (HTTP ${r.status})`));
      return null;
    }
    return r.body.items;
  };
  void (async () => {
    const newest = await read("limit=1");
    if (!newest) return;
    const at = newest[0]?.at;
    const since = typeof at === "number" ? at + 1 : 0;
    const poll = async () => {
      const items = await read(`since=${since}&limit=500`);
      if (!items) return;
      // Newest first: the oldest one that names an app is the next dictation.
      const hit = [...items].reverse().find((d) => typeof d.app === "string" && d.app !== "");
      if (hit) {
        stopped = true;
        const name = typeof hit.app_name === "string" && hit.app_name !== "" ? hit.app_name : "";
        found(hit.app as string, name || undefined);
        return;
      }
      timer = setTimeout(() => void poll(), every);
    };
    timer = setTimeout(() => void poll(), every);
  })();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * The editor for one `apps` setting, as rows of the page's panel: one row per app, saying its rule
 * in a few words, which opens to the rule's fields; a row to add an app, and "Use the app I
 * dictate into next". `input` holds the rules as JSON and fires `change` after each edit; `shown`
 * is the value as it came, for the settings code to tell an edit from none.
 */
export function appsEditor(
  id: string,
  value: unknown,
  disabled: boolean,
  next?: NextApp,
): { root: HTMLElement; input: HTMLInputElement; shown: string } {
  const input = h("input", { id, type: "hidden" });
  const list = h("div", { class: "apps-rules" });
  const readRule = (el: Element): Rule => {
    const rule: Rule = {};
    for (const f of el.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]")) {
      const v = f.value.trim();
      if (v !== "") rule[f.dataset.field as string] = v;
    }
    return rule;
  };
  const rules = () =>
    [...list.querySelectorAll(".apps-rule")].map(readRule).filter((r) => r.app !== undefined);
  const changed = () => {
    for (const el of list.querySelectorAll<HTMLElement>(".apps-rule")) paint(el);
    const now = JSON.stringify(rules());
    if (now === input.value) return;
    input.value = now;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  /** The rule's row says its app and its rule as they stand in its fields. */
  const paint = (el: HTMLElement) => {
    const rule = readRule(el);
    const name = el.querySelector(".apps-name");
    const sum = el.querySelector(".apps-summary");
    if (name) name.textContent = rule.name || rule.app || "A new app";
    if (sum) sum.textContent = rule.app ? ruleSummary(rule) : "Name the app to save its rule";
  };
  const open = (el: HTMLElement, yes: boolean) => {
    const body = el.querySelector<HTMLElement>(".apps-body");
    const head = el.querySelector<HTMLElement>(".apps-head");
    if (body) body.hidden = !yes;
    head?.setAttribute("aria-expanded", String(yes));
    el.classList.toggle("open", yes);
  };
  const ruleEl = (rule: Record<string, unknown>, expanded = false) => {
    const app = h("input", {
      type: "text",
      class: "pg-input",
      value: String(rule.app ?? ""),
      placeholder: "Such as com.example.chat",
      attrs: { "data-field": "app", "aria-label": "App" },
      on: {
        change: () => {
          // A name belongs to the app it came with: another id typed here drops it.
          if (app.value.trim() !== String(rule.app ?? "")) named.value = "";
          changed();
        },
      },
    });
    // The app's name for the row, kept with the rule; never typed, never matched.
    const named = h("input", {
      type: "hidden",
      value: typeof rule.name === "string" ? rule.name : "",
      attrs: { "data-field": "name" },
    });
    const fields = APP_RULE_FIELDS.map((f) => {
      const v = typeof rule[f.name] === "string" ? (rule[f.name] as string) : "";
      let el: HTMLInputElement | HTMLSelectElement;
      if (f.values === null) {
        el = h("input", {
          type: "text",
          class: "pg-input",
          value: v,
          placeholder: APP_RULE_GLOBAL,
        });
      } else {
        // A value the list does not hold (a hand-edited file) stays shown as it is.
        const values =
          v === "" || f.values.some(([x]) => x === v) ? f.values : [[v, v], ...f.values];
        el = h(
          "select",
          { class: "pg-select" },
          h("option", { value: "" }, APP_RULE_GLOBAL),
          ...values.map(([x, l]) => h("option", { value: x }, l)),
        );
      }
      el.value = v;
      el.dataset.field = f.name;
      el.setAttribute("aria-label", f.label);
      el.addEventListener("change", changed);
      return row({ label: f.label }, el);
    });
    const remove = button("Remove this rule", () => {
      el.remove();
      changed();
    });
    remove.classList.add("apps-remove");
    const head = h(
      "button",
      {
        type: "button",
        class: "pg-row pg-link apps-head",
        attrs: { "aria-expanded": "false" },
        on: { click: () => open(el, el.querySelector<HTMLElement>(".apps-body")?.hidden === true) },
      },
      h(
        "span",
        { class: "pg-lbl apps-app" },
        h(
          "span",
          { class: "apps-icon" },
          icon(
            "M4.5 3h7a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z",
            "M2.5 6h11",
          ),
        ),
        h("b", { class: "pg-name apps-name" }),
      ),
      h(
        "span",
        { class: "pg-ctl" },
        h("span", { class: "pg-value apps-summary" }),
        h("span", { class: "pg-more" }, icon(...ICONS.chevron)),
      ),
    );
    const body = h(
      "div",
      { class: "apps-body", hidden: true },
      row(
        {
          label: "App",
          help: "Use the app I dictate into next fills this in.",
        },
        app,
        named,
      ),
      ...fields,
      row({ label: "" }, remove),
    );
    const el = h("div", { class: "apps-rule" }, head, body);
    for (const c of body.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      "input, select, button",
    ))
      c.disabled = disabled;
    paint(el);
    open(el, expanded);
    return el;
  };
  for (const r of Array.isArray(value) ? value : []) {
    if (typeof r === "object" && r !== null) list.append(ruleEl(r as Record<string, unknown>));
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
          const el = ruleEl({}, true);
          list.append(el);
          el.querySelector<HTMLElement>("[data-field='app']")?.focus();
        },
      },
    },
    icon("M8 3v10M3 8h10"),
    "Add an app",
  );
  add.disabled = disabled;
  const nextNote = h("span", { class: "apps-next-note pg-help", attrs: { role: "status" } });
  let watch: { stop(): void } | null = null;
  const idle = (note: string) => {
    watch = null;
    nextButton.textContent = NEXT_APP_LABEL;
    nextNote.textContent = note;
  };
  /** A rule for `app`: the one there is, or a new one saved with the app and its name alone. */
  const take = (app: string, name?: string) => {
    const known = [...list.querySelectorAll<HTMLInputElement>("[data-field='app']")].find(
      (el) => el.value.trim() === app,
    );
    const called = name || app;
    if (known) {
      nextNote.textContent = `${called} has a rule already.`;
      const el = known.closest<HTMLElement>(".apps-rule");
      if (el) open(el, true);
      el?.querySelector<HTMLElement>("select")?.focus();
      return;
    }
    const el = ruleEl(name ? { app, name } : { app }, true);
    list.append(el);
    changed();
    nextNote.textContent = `Added ${called}.`;
    el.querySelector<HTMLElement>("select")?.focus();
  };
  const nextButton = h(
    "button",
    {
      type: "button",
      class: "pg-btn apps-next",
      on: {
        click: () => {
          if (!next) return;
          if (watch) {
            watch.stop();
            idle("");
            return;
          }
          // `next` may answer before it returns (a refusal it knows at once).
          let answered = false;
          const w = next(
            (app, name) => {
              answered = true;
              idle("");
              take(app, name);
            },
            (why) => {
              answered = true;
              idle(why);
            },
          );
          if (answered) return;
          watch = w;
          nextButton.textContent = "Cancel";
          nextNote.textContent = NEXT_APP_WAITING;
        },
      },
    },
    NEXT_APP_LABEL,
  );
  nextButton.disabled = disabled;
  // "Add an app" on the left, the next dictation's app on the right, what the wait says under it.
  const addRow = h(
    "div",
    { class: "pg-row apps-add-row" },
    h("div", { class: "pg-lbl" }, add, next ? nextNote : null),
    next ? h("div", { class: "pg-ctl" }, nextButton) : null,
  );
  const root = h("div", { class: "apps-editor" }, list, addRow, input);
  return { root, input, shown };
}
