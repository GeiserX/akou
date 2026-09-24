/**
 * The Enhanced tab (docs/DESIGN.md sections 5.2 and 7): the notes the provider wrote from the
 * user's notepad, the transcript and a template. "Enhance" after the call, "Enhance so far" during
 * it; a template picker; every revision kept and selectable. When the final transcript lands after
 * the notes were written and akou did not re-enhance on its own (notes written by hand, or the
 * harness, which runs only when asked), a "Re-enhance from it" button is offered.
 *
 * The user's own lines (kept word for word, marked `_(your note, 15:41)_`) are drawn as theirs and
 * the provider's bullets as the AI's, and every `[#l000031]` citation becomes `[15:41 Ben]`, a
 * button that scrolls to the line and plays it. The Markdown is read line by line into elements;
 * it is never parsed into markup.
 */

import type { CallView } from "../core/log/fold.ts";
import { citedText } from "./ask.ts";
import { byId, h, replace } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";

export interface EnhancedDeps {
  t: Transport;
  call(): string | null;
  view(): CallView | null;
  cite(lineId: string): void;
  /** Opens Settings on one key. */
  openSettings(key: string): void;
}

interface Enhanced {
  rev: number;
  template: string;
  by: string;
  model: string;
  cites: string[];
  markdown: string;
}

const YOUR_NOTE = /\s*_\(your note, [^)]*\)_\s*$/;

/** Draws enhanced Markdown: headings, bullets (the user's or the AI's), paragraphs, citations. */
export function renderNotes(
  md: string,
  view: CallView | null,
  cites: readonly string[],
  cite: (id: string) => void,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  let list: HTMLElement | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(?:\[( |x)\]\s+)?(.*)$/.exec(line);
    if (heading) {
      list = null;
      const level = Math.min(4, (heading[1] as string).length + 1) as 2 | 3 | 4;
      out.push(h(`h${level}` as "h2", {}, heading[2] as string));
    } else if (bullet) {
      if (!list) {
        list = h("ul", {});
        out.push(list);
      }
      const body = bullet[2] as string;
      const mine = YOUR_NOTE.test(body);
      const item = h(
        "li",
        { class: mine ? "mine" : "ai" },
        bullet[1] !== undefined
          ? h("span", { class: "check" }, bullet[1] === "x" ? "☑ " : "☐ ")
          : null,
        ...citedText(body.replace(YOUR_NOTE, ""), view, cites, cite),
        mine ? h("span", { class: "who-note" }, " your note") : null,
      );
      list.append(item);
    } else if (line.trim() === "") {
      list = null;
    } else {
      list = null;
      out.push(h("p", {}, ...citedText(line, view, cites, cite)));
    }
  }
  return out;
}

export class EnhancedPane {
  private readonly box = byId("enhanced-body");
  private readonly template = byId<HTMLSelectElement>("enhance-template");
  private readonly button = byId<HTMLButtonElement>("enhance");
  private readonly revs = byId<HTMLSelectElement>("enhance-rev");
  private readonly note = byId("enhance-status");
  private shownRev = 0;
  private busy = false;

  constructor(private readonly d: EnhancedDeps) {
    this.button.addEventListener("click", () => void this.enhance());
    this.revs.addEventListener("change", () => void this.load(Number(this.revs.value)));
  }

  /** The template names, into the tab's picker and the header's. */
  async loadTemplates(): Promise<string[]> {
    const r = await this.d.t.request<{ templates?: string[] }>("GET", "/templates");
    const names = r.body.templates ?? [];
    replace(
      this.template,
      h("option", { value: "" }, "template: automatic"),
      ...names.map((n) => h("option", { value: n }, n)),
    );
    return names;
  }

  reset(): void {
    this.shownRev = 0;
    replace(this.box, h("p", { class: "hint" }, "No enhanced notes yet."));
    replace(this.revs);
    this.revs.hidden = true;
    this.note.textContent = "";
    this.paint();
  }

  /** The button says what it will do: "Enhance so far" during the call. */
  paint(): void {
    const v = this.d.view();
    this.button.textContent = v?.live ? "Enhance so far" : "Enhance";
    this.button.disabled = this.busy || !v?.call;
  }

  /** A new `enhanced` event arrived: show the newest revision. */
  refresh(): void {
    const latest = this.d.view()?.latestEnhanced();
    if (latest && latest.rev !== this.shownRev) void this.load();
  }

  async load(rev?: number): Promise<void> {
    const call = this.d.call();
    if (!call) return;
    const r = await this.d.t.request<{
      enhanced: Enhanced | null;
      revisions: { rev: number; template: string; by: string }[];
      reEnhance?: { due: boolean; auto: boolean; template?: string; reason: string } | null;
    }>("GET", `/calls/${call}/enhanced${rev ? `?rev=${rev}` : ""}`);
    if (r.status >= 400 || !r.body.enhanced) return;
    const e = r.body.enhanced;
    const again = r.body.reEnhance;
    if (again?.due && !again.auto && !this.busy) {
      // The final transcript is better than the one these notes were written from.
      replace(
        this.note,
        `The final transcript is ready (${again.reason}). `,
        h(
          "button",
          {
            type: "button",
            id: "reenhance",
            on: {
              click: () => {
                this.template.value = again.template ?? "";
                void this.enhance();
              },
            },
          },
          "Re-enhance from it",
        ),
      );
    }
    this.shownRev = e.rev;
    replace(
      this.revs,
      ...r.body.revisions
        .slice()
        .reverse()
        .map((x) => h("option", { value: String(x.rev) }, `rev ${x.rev} · ${x.template}`)),
    );
    this.revs.value = String(e.rev);
    this.revs.hidden = r.body.revisions.length < 2;
    replace(
      this.box,
      h(
        "p",
        { class: "enhanced-meta" },
        `${e.template} · by ${e.by === "user" ? "you" : e.by}${e.model && e.model !== e.by ? ` with ${e.model}` : ""}`,
      ),
      ...renderNotes(e.markdown, this.d.view(), e.cites, this.d.cite),
    );
  }

  async enhance(): Promise<void> {
    const call = this.d.call();
    if (!call) return;
    this.busy = true;
    this.button.disabled = true;
    this.note.textContent = "Writing the notes…";
    const r = await this.d.t.request<{
      rev?: number;
      error?: string;
      message?: string;
      reason?: string;
    }>(
      "POST",
      `/calls/${call}/enhance`,
      this.template.value ? { template: this.template.value } : {},
    );
    this.busy = false;
    this.paint();
    if (r.status >= 400) {
      // The status line under the button says it once. The API's own message is for agents (it
      // names routes), so a missing provider gets a sentence a person can act on.
      if (r.body.error === "provider_unavailable") {
        replace(
          this.note,
          "No provider is set up, so akou cannot write the notes. ",
          h(
            "button",
            { type: "button", on: { click: () => this.d.openSettings("provider.kind") } },
            "Choose one in Settings",
          ),
        );
      } else {
        this.note.textContent = message(r.body, "the notes could not be written");
      }
      return;
    }
    this.note.textContent = "";
    await this.load(r.body.rev);
  }
}
