/**
 * The settings registry's shapes (`GET /config`: every key with its type, range, description and
 * whether it is secret) and the field code the pages share: a field per key, the keys whose field
 * changed as a `PATCH /config` body, and a refusal shown beside its key. The Settings page is
 * `settings-page.ts`; the Dictation page (docs/ux/DICTATION.md DC-U1) still draws its fields here,
 * and a list of per-app rules (the `apps` type, DC-U9) as a table of rules (`dictation-apps.ts`).
 *
 * A key the registry marks file only (`apiWritable: false`: a program akou runs, or an address
 * transcripts or keys are sent to) is shown, never editable; a secret is never shown back.
 */

import { appsEditor, type NextApp } from "./dictation-apps.ts";
import { h, toast } from "./dom.ts";
import { message } from "./notepad.ts";

export interface SchemaEntry {
  type: "integer" | "number" | "boolean" | "string" | "string[]" | "hooks" | "apps";
  min?: number;
  max?: number;
  /** One of these values, for a string: drawn as a list to pick from. */
  values?: readonly string[];
  env?: string;
  secret?: boolean;
  /** False: the file only (DESIGN 8.2, 6.3); `PATCH /config` refuses it. */
  apiWritable: boolean;
  doc: string;
}

export interface ConfigReply {
  file: string;
  settings: Record<string, unknown>;
  set: Record<string, unknown>;
  issues: { key: string; message: string }[];
  schema: Record<string, SchemaEntry>;
}

/**
 * One setting as a row: its label, an input of its type, its description and any problem the file
 * has with it. A file-only key is shown disabled; a secret is never shown back. `shown` is what
 * the input holds now, for `changedSettings` to tell an edit from no edit. `nextApp` gives an
 * `apps` editor its "Use the app I dictate into next" button.
 */
export function settingField(
  key: string,
  spec: SchemaEntry,
  value: unknown,
  issue?: string,
  o: { nextApp?: NextApp } = {},
): {
  row: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  shown: string;
} {
  const id = `set-${key.replace(/[^a-z0-9]/gi, "-")}`;
  const fileOnly = spec.apiWritable === false;
  let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  let shown: string;
  let editor: HTMLElement | null = null;
  if (spec.type === "apps") {
    const e = appsEditor(id, value, fileOnly, o.nextApp);
    ({ input, shown } = e);
    editor = e.root;
  } else if (spec.type === "boolean") {
    input = h("input", { id, type: "checkbox" });
    input.checked = value === true;
    shown = String(value === true);
  } else if (spec.type === "string[]" || spec.type === "hooks") {
    shown =
      spec.type === "hooks"
        ? JSON.stringify(value ?? [], null, 2)
        : ((value as string[] | undefined) ?? []).join("\n");
    input = h("textarea", { id, attrs: { rows: "2" } });
    input.value = shown;
  } else if (spec.type === "string" && spec.values && !spec.secret) {
    shown = String(value ?? "");
    // A value the list does not hold (a hand-edited file) stays shown as it is, never replaced.
    const options = spec.values.includes(shown) ? spec.values : [shown, ...spec.values];
    input = h("select", { id }, ...options.map((v) => h("option", { value: v }, v)));
    input.value = shown;
  } else {
    shown = spec.secret ? "" : String(value ?? "");
    input = h("input", {
      id,
      type:
        spec.type === "integer" || spec.type === "number"
          ? "number"
          : spec.secret
            ? "password"
            : "text",
      value: shown,
      placeholder: spec.secret ? (value ? "set (hidden); type to replace" : "not set") : "",
    });
    if (spec.type === "integer" || spec.type === "number") {
      if (spec.min !== undefined) input.setAttribute("min", String(spec.min));
      if (spec.max !== undefined) input.setAttribute("max", String(spec.max));
      input.setAttribute("step", spec.type === "integer" ? "1" : "any");
    }
  }
  input.dataset.key = key;
  if (fileOnly) {
    input.disabled = true;
    input.title = "set in the config file only: a program akou runs or an address it sends to";
  }
  const row = h(
    "div",
    { class: `setting${issue ? " refused" : ""}`, attrs: { "data-key": key } },
    h("label", { attrs: { for: id } }, key),
    input,
    editor,
    h(
      "small",
      {},
      spec.doc,
      fileOnly ? " (config file only)" : "",
      spec.env ? ` (environment: ${spec.env})` : "",
    ),
    issue ? h("small", { class: "issue" }, issue) : null,
  );
  return { row, input, shown };
}

/** The keys under `root` whose input no longer holds what was shown, as a `PATCH /config` body. */
export function changedSettings(
  root: HTMLElement,
  schema: Record<string, SchemaEntry>,
  shown: Record<string, string>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const el of root.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("[data-key]:not(div)")) {
    const key = el.dataset.key as string;
    const spec = schema[key];
    if (!spec || el.disabled) continue;
    const now =
      el instanceof HTMLInputElement && el.type === "checkbox" ? String(el.checked) : el.value;
    if (now === shown[key]) continue;
    if (spec.type === "boolean") patch[key] = now === "true";
    else if (spec.type === "integer" || spec.type === "number")
      patch[key] = now === "" ? null : Number(now);
    else if (spec.type === "string[]")
      patch[key] = now
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    else if (spec.type === "apps") patch[key] = JSON.parse(now);
    else patch[key] = now;
  }
  return patch;
}

/** A saved value as its input holds it, the `shown` that `changedSettings` compares against. */
export function shownValue(spec: SchemaEntry | undefined, v: unknown): string {
  if (spec?.type === "apps") return JSON.stringify(v ?? []);
  return Array.isArray(v) ? v.join("\n") : String(v ?? "");
}

/** A refused `PATCH /config`: each error beside the key it names, and all of them in a toast. */
export function showRefusals(root: HTMLElement, body: unknown): void {
  const errors = (body as { errors?: string[] }).errors ?? [message(body, "refused")];
  for (const div of root.querySelectorAll<HTMLElement>("div.setting")) {
    const key = div.dataset.key as string;
    const e = errors.find((x) => x.startsWith(`${key}:`));
    div.classList.toggle("refused", e !== undefined);
    div.querySelector(".issue")?.remove();
    if (e) div.append(h("small", { class: "issue" }, e));
  }
  toast(errors.join("; "));
}
