/**
 * The notepad (docs/DESIGN.md section 5.1): a plain-text pane beside the transcript. A line becomes
 * a `note` event when the user presses Enter or stops typing for 2 s; later keystrokes on the same
 * line are edits (`rev + 1`). The note carries the wall time of its first keystroke and the last
 * log entry visible then, so it can be tied to what was being said.
 *
 * Each line has a time gutter: clicking it scrolls the transcript there and plays from it. Lines an
 * agent wrote (`by: agent:<client>`) are drawn in another colour and say which agent, so the user
 * and the agent are two visible authors of one notepad (TRAPS "Agent-authored notes
 * indistinguishable from the user's"). Markers: `- `, `[] ` (action), `? ` (question), `# `.
 */

import { formatWall } from "../core/log/clock.ts";
import type { CallView, NoteView } from "../core/log/fold.ts";
import { byId, h, replace, toast } from "./dom.ts";
import { noteKind } from "./model.ts";
import type { Transport } from "./protocol.ts";

export const PAUSE_SAVES_MS = 2000;

export interface NotepadDeps {
  t: Transport;
  call(): string | null;
  view(): CallView | null;
  jumpTo(w: number): void;
}

export class NotepadPane {
  private readonly list = byId("notes");
  private readonly input = byId<HTMLInputElement>("note-input");
  /** The line being typed: when it began, what was visible then, and its note once saved. */
  private draft: { w: number; afterSeq: number; id?: string; saved?: string } | null = null;
  private pause: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly d: NotepadDeps) {
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.commit(true);
      }
    });
    this.list.addEventListener("click", (e) => this.onClick(e));
  }

  reset(): void {
    this.draft = null;
    this.input.value = "";
    if (this.pause) clearTimeout(this.pause);
    this.render();
  }

  private onInput(): void {
    const v = this.d.view();
    if (!v) return;
    if (!this.draft && this.input.value.trim() !== "") {
      this.draft = { w: Date.now(), afterSeq: v.lastSeq };
    }
    if (this.pause) clearTimeout(this.pause);
    this.pause = setTimeout(() => void this.commit(false), PAUSE_SAVES_MS);
  }

  /** Saves the line: a new note the first time, an edit after. Enter also starts a new line. */
  private commit(newLine: boolean): Promise<void> {
    if (this.pause) clearTimeout(this.pause);
    this.pause = null;
    const text = this.input.value.trim();
    const draft = this.draft;
    if (newLine) {
      this.input.value = "";
      this.draft = null;
    }
    this.saving = this.saving.then(async () => {
      const call = this.d.call();
      if (!call || !draft || text === "" || text === draft.saved) return;
      if (draft.id) {
        const r = await this.d.t.request("PATCH", `/calls/${call}/notes/${draft.id}`, { text });
        if (r.status >= 400) toast(message(r.body, "the note was not saved"));
        else draft.saved = text;
        return;
      }
      const r = await this.d.t.request<{ note?: { id: string }; message?: string }>(
        "POST",
        `/calls/${call}/notes`,
        { text, w: draft.w, afterSeq: draft.afterSeq },
      );
      if (r.status >= 400 || !r.body.note) toast(message(r.body, "the note was not saved"));
      else {
        draft.id = r.body.note.id;
        draft.saved = text;
      }
    });
    return this.saving;
  }

  /** Draws the notepad from the fold. */
  render(): void {
    const v = this.d.view();
    if (!v?.call) {
      replace(this.list);
      return;
    }
    const tz = v.call.tz;
    replace(this.list, ...v.notes().map((n) => this.noteRow(n, tz)));
  }

  private noteRow(n: NoteView, tz: string): HTMLElement {
    const agent = n.author === "agent";
    return h(
      "li",
      {
        class: `note ${noteKind(n.text)}${agent ? " agent" : " human"}`,
        attrs: { "data-id": n.id, "data-w": String(n.w) },
      },
      h(
        "button",
        { class: "gutter", type: "button", title: "Show and play the call from here" },
        formatWall(n.w, tz),
      ),
      h("span", { class: "note-text" }, n.text),
      agent ? h("span", { class: "author" }, `agent ${n.client ?? n.by.slice(6)}`) : null,
      h(
        "button",
        { class: "edit", type: "button", attrs: { "aria-label": "Edit this note" } },
        "Edit",
      ),
      h(
        "button",
        { class: "del", type: "button", attrs: { "aria-label": "Delete this note" } },
        "✕",
      ),
    );
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const li = t.closest("li.note") as HTMLElement | null;
    const call = this.d.call();
    if (!li || !call) return;
    const id = li.dataset.id as string;
    if (t.closest(".gutter")) this.d.jumpTo(Number(li.dataset.w));
    else if (t.closest(".del")) {
      void this.d.t.request("DELETE", `/calls/${call}/notes/${id}`, {}).then((r) => {
        if (r.status >= 400) toast(message(r.body, "the note was not deleted"));
      });
    } else if (t.closest(".edit")) this.edit(li, call, id);
  }

  private edit(li: HTMLElement, call: string, id: string): void {
    const span = li.querySelector(".note-text") as HTMLElement;
    const input = h("input", {
      class: "note-edit",
      value: span.textContent ?? "",
      attrs: { "aria-label": "Edit the note" },
    });
    span.replaceWith(input);
    input.focus();
    const done = async (save: boolean) => {
      const text = input.value.trim();
      if (save && text !== "" && text !== span.textContent) {
        const r = await this.d.t.request("PATCH", `/calls/${call}/notes/${id}`, { text });
        if (r.status >= 400) toast(message(r.body, "the note was not saved"));
      }
      this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void done(true);
      else if (e.key === "Escape") void done(false);
    });
  }
}

export function message(body: unknown, fallback: string): string {
  const b = body as { message?: unknown } | null;
  return typeof b?.message === "string" ? b.message : fallback;
}
