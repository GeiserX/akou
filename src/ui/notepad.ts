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
  /** The note being edited in place. Its row stays put on a redraw, which would drop the edit. */
  private editing: string | null = null;

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
    this.editing = null;
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
        const r = await this.d.t
          .request("PATCH", `/calls/${call}/notes/${draft.id}`, { text })
          .catch(() => null);
        if (!r || r.status >= 400) toast(message(r?.body, "the note was not saved"));
        else draft.saved = text;
        return;
      }
      const r = await this.d.t
        .request<{ note?: { id: string }; message?: string }>("POST", `/calls/${call}/notes`, {
          text,
          w: draft.w,
          afterSeq: draft.afterSeq,
        })
        .catch(() => null);
      if (!r || r.status >= 400 || !r.body.note) toast(message(r?.body, "the note was not saved"));
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
    const rows = v.notes().map((n) => this.noteRow(n, tz));
    const at = rows.findIndex((r) => r.dataset.id === this.editing);
    const kept =
      this.editing && at >= 0
        ? this.list.querySelector<HTMLElement>(`li.note[data-id="${CSS.escape(this.editing)}"]`)
        : null;
    if (!kept) {
      // Nothing is being edited, or the edited note was deleted elsewhere and its edit goes with it.
      this.editing = null;
      replace(this.list, ...rows);
      return;
    }
    // Moving the edited row would take focus from its input, which closes the edit: the other
    // notes are drawn around it instead.
    for (const el of [...this.list.children]) if (el !== kept) el.remove();
    kept.before(...rows.slice(0, at));
    kept.after(...rows.slice(at + 1));
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
    } else if (t.closest(".edit")) {
      // An open edit closes first: its save runs on the blur this click caused, and its close runs
      // before this. If that save fails, it stays open and this one does not start, so its text is
      // not lost.
      void this.saving.then(() => {
        const row = this.list.querySelector<HTMLElement>(`li.note[data-id="${CSS.escape(id)}"]`);
        if (!this.editing && row && this.d.call() === call) this.edit(row, call, id);
      });
    }
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
    this.editing = id;
    // An edit is saved on Enter, when focus leaves it and after a 2 s pause (WINDOW W6.2), each
    // save a new revision; Escape closes it without saving what was not saved yet. A save that
    // fails is a toast and leaves the editor open with its text, to try again.
    let saved = span.textContent ?? "";
    let pause: ReturnType<typeof setTimeout> | null = null;
    let open = true;
    const save = (): Promise<boolean> => {
      if (pause) clearTimeout(pause);
      pause = null;
      const text = input.value.trim();
      const run = this.saving.then(async () => {
        if (text === "" || text === saved) return true;
        const r = await this.d.t
          .request("PATCH", `/calls/${call}/notes/${id}`, { text })
          .catch(() => null);
        if (!r || r.status >= 400) {
          toast(message(r?.body, "the note was not saved"));
          return false;
        }
        saved = text;
        return true;
      });
      this.saving = run.then(() => {});
      return run;
    };
    const done = async (keep: boolean) => {
      if (!open) return;
      open = false;
      if (pause) clearTimeout(pause);
      if (keep && !(await save())) {
        open = true;
        return;
      }
      if (this.editing === id) this.editing = null;
      this.render();
    };
    input.addEventListener("input", () => {
      if (pause) clearTimeout(pause);
      pause = setTimeout(() => void save(), PAUSE_SAVES_MS);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void done(true);
      else if (e.key === "Escape") void done(false);
    });
    input.addEventListener("blur", () => void done(true));
  }
}

export function message(body: unknown, fallback: string): string {
  const b = body as { message?: unknown } | null;
  return typeof b?.message === "string" ? b.message : fallback;
}
