/**
 * Settings (docs/DESIGN.md section 7), drawn from the one settings registry: `GET /config` returns
 * every key with its type, range, description and whether it is secret, so this pane has no list
 * of its own and cannot drift from the registry. Saving sends only the keys that changed through
 * `PATCH /config`, which validates them exactly as a hand-edited file is validated; a refusal is
 * shown next to the key.
 *
 * Keys the registry marks file only (`apiWritable: false`: a program akou runs, or an address
 * transcripts or keys are sent to) are shown, never editable here; the schema says which. A secret
 * is never shown back; typing a new one replaces it.
 *
 * Below the settings, the vocabulary panel: the entries in force for the workspace, where each
 * came from, and the files they live in.
 */

import { hotkeyWarning } from "../main/window/hotkey.ts";
import { byId, h, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";

export interface SchemaEntry {
  type: "integer" | "number" | "boolean" | "string" | "string[]" | "hooks";
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

export class SettingsPane {
  private readonly dialog = byId<HTMLDialogElement>("settings");
  private readonly form = byId<HTMLFormElement>("settings-form");
  private readonly fields = byId("settings-fields");
  private readonly vocab = byId("settings-vocab");
  private schema: Record<string, SchemaEntry> = {};
  /** The OS of the machine akou runs on, from its status: not the browser's (DK-K4). */
  private platform = "";
  private shown: Record<string, string> = {};

  constructor(
    private readonly t: Transport,
    private readonly workspace: () => string,
  ) {
    byId("settings-open").addEventListener("click", () => void this.open());
    byId("settings-close").addEventListener("click", () => this.dialog.close());
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.save();
    });
  }

  /** Opens the pane, on one key when named (the Enhanced tab's "Choose a provider"). */
  async open(key?: string): Promise<void> {
    await this.load();
    if (!this.dialog.open) this.dialog.showModal();
    const at = key
      ? this.fields.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]:not(div)`)
      : null;
    (at ?? (this.fields.querySelector("input, select, textarea") as HTMLElement | null))?.focus();
  }

  private async load(): Promise<void> {
    const [r, st] = await Promise.all([
      this.t.request<ConfigReply>("GET", "/config"),
      this.t.request<{ app?: { platform?: string } }>("GET", "/status"),
    ]);
    this.platform = String(st.body?.app?.platform ?? "");
    if (r.status >= 400) {
      toast(message(r.body, "the settings could not be read"));
      return;
    }
    this.schema = r.body.schema;
    this.shown = {};
    const issues = new Map(r.body.issues.map((i) => [i.key, i.message]));
    replace(
      this.fields,
      h("p", { class: "hint" }, `Saved in ${r.body.file}`),
      ...Object.entries(this.schema).map(([key, spec]) =>
        this.field(key, spec, r.body.settings[key], issues.get(key)),
      ),
    );
    void this.loadVocab();
  }

  private field(key: string, spec: SchemaEntry, value: unknown, issue?: string): HTMLElement {
    const f = settingField(key, spec, value, issue);
    this.shown[key] = f.shown;
    if (key === "app.hotkey") f.row.append(hotkeyHint(f.input, this.platform));
    return f.row;
  }

  private async save(): Promise<void> {
    const patch = changedSettings(this.fields, this.schema, this.shown);
    if (Object.keys(patch).length === 0) {
      this.dialog.close();
      return;
    }
    const r = await this.t.request<{ errors?: string[]; note?: string }>("PATCH", "/config", patch);
    if (r.status >= 400) {
      showRefusals(this.fields, r.body);
      return;
    }
    toast(r.body.note ?? "Saved.", "info");
    await this.load();
  }

  private async loadVocab(): Promise<void> {
    const ws = this.workspace();
    const r = await this.t.request<{
      files?: { scope: string; path: string; exists?: boolean }[];
      entries?: {
        term: string;
        heard: string[];
        scope?: string;
        source?: string;
        confirmed?: boolean;
      }[];
    }>("GET", `/vocab${ws ? `?workspace=${encodeURIComponent(ws)}` : ""}`);
    if (r.status >= 400) {
      replace(
        this.vocab,
        h("p", { class: "hint" }, message(r.body, "the vocabulary could not be read")),
      );
      return;
    }
    const entries = r.body.entries ?? [];
    replace(
      this.vocab,
      h("h3", {}, `Vocabulary${ws ? ` (${ws})` : ""}`),
      h(
        "ul",
        { class: "vocab-files" },
        ...(r.body.files ?? []).map((f) =>
          h("li", {}, `${f.scope}: ${f.path}${f.exists === false ? " (not created yet)" : ""}`),
        ),
      ),
      entries.length === 0
        ? h("p", { class: "hint" }, "No words yet. Use Fix on a transcript line to add one.")
        : h(
            "table",
            { class: "vocab-entries" },
            h(
              "tr",
              {},
              h("th", {}, "Word"),
              h("th", {}, "Heard as"),
              h("th", {}, "From"),
              h("th", {}, "State"),
            ),
            ...entries.map((e) =>
              h(
                "tr",
                {},
                h("td", {}, e.term),
                h("td", {}, e.heard.join(", ")),
                h("td", {}, e.source ?? e.scope ?? ""),
                h("td", {}, e.confirmed === false ? "to review" : "in force"),
              ),
            ),
          ),
    );
  }
}

/**
 * The hotkey's warning (DK-K4), under the field while you type: off macOS, `Control+Alt` is AltGr
 * on many layouts. A warning, never a refusal: the key is yours to choose.
 */
function hotkeyHint(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  platform: string,
): HTMLElement {
  const hint = h("small", { class: "issue", attrs: { role: "status" } });
  const draw = () => {
    // An app too old to say its OS: no warning rather than a guess from the browser.
    const w = platform ? hotkeyWarning(input.value, platform) : null;
    hint.textContent = w ?? "";
    hint.hidden = w === null;
  };
  input.addEventListener("input", draw);
  draw();
  return hint;
}

/**
 * One setting as a row: its label, an input of its type, its description and any problem the file
 * has with it. A file-only key is shown disabled; a secret is never shown back. `shown` is what
 * the input holds now, for `changedSettings` to tell an edit from no edit.
 */
export function settingField(
  key: string,
  spec: SchemaEntry,
  value: unknown,
  issue?: string,
): {
  row: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  shown: string;
} {
  const id = `set-${key.replace(/[^a-z0-9]/gi, "-")}`;
  const fileOnly = spec.apiWritable === false;
  let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  let shown: string;
  if (spec.type === "boolean") {
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
    else patch[key] = now;
  }
  return patch;
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
