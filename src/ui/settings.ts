/**
 * The settings registry's shapes (`GET /config`: every key with its type, range, description and
 * whether it is secret) and what the pages share to save them: the keys whose control changed as a
 * `PATCH /config` body. The pages are `settings-page.ts`, `dictation-page.ts` and `models-page.ts`.
 *
 * A key the registry marks file only (`apiWritable: false`: a program akou runs, or an address
 * transcripts or keys are sent to) is shown, never editable; a secret is never shown back.
 */

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
