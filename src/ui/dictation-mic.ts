/**
 * The Dictation page's microphone picker (docs/ux/DICTATION.md DC-U4): `dictation.mic` chosen from
 * the inputs `GET /devices` lists (PROGRAMMABILITY.md PG-A8), "System default" first, the transport
 * beside each name where the route gives one. The route's `inputs` are the capture helper's device
 * query (`akou-capture devices`, DESIGN 2.4): `{id, name, default}`, plus `transport` once it says.
 *
 * Where akou cannot list its inputs (a version without the route, or a helper that refuses the
 * query) the field stays the text box of a device id, with the reason beside it, so the setting is
 * never out of reach. A saved device that is not plugged in stays chosen, marked as such, and is
 * never swapped for another by opening the page.
 */

import { h } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";

export const MIC_KEY = "dictation.mic";

/** One input as `GET /devices` lists it. */
export interface CaptureInput {
  id: string;
  name: string;
  default?: boolean;
  /** `built-in`, `usb`, `bluetooth` or another word the helper uses. */
  transport?: string;
}

/** The inputs, or why akou cannot list them. */
export type MicList = { inputs: CaptureInput[] } | { error: string };

const TRANSPORT: Record<string, string> = {
  "built-in": "built-in",
  builtin: "built-in",
  usb: "USB",
  bluetooth: "Bluetooth",
};

function label(d: CaptureInput): string {
  const t = d.transport ? (TRANSPORT[d.transport.toLowerCase()] ?? d.transport) : "";
  return t ? `${d.name} (${t})` : d.name;
}

/** Reads the inputs; never throws. */
export async function readMics(t: Transport): Promise<MicList> {
  const r = await t.request<{ inputs?: unknown }>("GET", "/devices");
  if (r.status === 404) return { error: "this akou does not list its microphones yet" };
  if (r.status >= 400) return { error: message(r.body, `HTTP ${r.status}`) };
  // A body without a list would throw below and take the whole Dictation page down with it.
  if (!Array.isArray(r.body?.inputs)) return { error: "akou's answer lists no microphones" };
  const inputs = (r.body.inputs as CaptureInput[]).filter(
    (d) => typeof d?.id === "string" && d.id !== "" && typeof d.name === "string",
  );
  return { inputs };
}

/** The picker that replaces the field's text box, keeping its id and `data-key`, so the page saves it as any field. */
export function micPicker(
  input: HTMLInputElement,
  saved: string,
  inputs: readonly CaptureInput[],
): HTMLSelectElement {
  const def = inputs.find((d) => d.default);
  const options = [
    h("option", { value: "" }, def ? `System default (${label(def)})` : "System default"),
    ...inputs.map((d) => h("option", { value: d.id }, label(d))),
  ];
  if (saved !== "" && !inputs.some((d) => d.id === saved))
    options.push(h("option", { value: saved }, `${saved} (not connected)`));
  const select = h("select", { id: input.id }, ...options);
  select.dataset.key = MIC_KEY;
  select.value = saved;
  return select;
}

/** Why the field stays a text box: akou gave no list. */
export function micNote(error: string): HTMLElement {
  return h("small", { id: "dictation-mic-note", class: "hint" }, `Type a device id: ${error}.`);
}

/** The live level beside the picker while the page is open, from the dictation helper's mic. */
export function micMeter(t: Transport): { root: HTMLElement; close(): void } | null {
  if (!t.dictationLevels) return null;
  const root = h("meter", {
    id: "dictation-mic-level",
    attrs: { min: "-60", max: "0", low: "-50", value: "-60", "aria-label": "Microphone level" },
  });
  const w = t.dictationLevels((db) => {
    // The meter holds a level to its range itself; a non-number would throw.
    if (Number.isFinite(db)) root.value = db;
  });
  return { root, close: () => w.close() };
}
