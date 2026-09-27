/**
 * The dictionary and replacements editor (docs/ux/DICTATION.md DC-U5), opened from the Dictation
 * page. It edits the user's vocabulary file, the one calls read too (WINDOW W9.2), through the API,
 * so a script can do what the page does.
 *
 * An entry is a term and the forms it is heard as. A replacement is the same entry read the other
 * way: its heard form is what you say (`dot com`) and its term what akou writes (`.com`), replaced
 * whole word, in any case, longest first (DC-L6).
 *
 * - Add: `POST /vocab {term, heard, scope: "dictation"}`. Dictation always applies such an entry
 *   and calls never read it, since a heard form such as "versal" would otherwise rewrite call
 *   transcripts. Adding forms to a term the file has keeps its forms, its scope, its note, its
 *   `decode: false` and whether it is confirmed: the route replaces the whole entry, so the page
 *   sends them back (the route keeps its `source` and `added_at`).
 * - Use in calls too: the same route without `scope`, which makes it an ordinary entry.
 * - Remove: `DELETE /vocab/{term}`, one click.
 * - Import: a text file, one term per line, through `POST /vocab/import {scope: "dictation"}`, into
 *   the same file; a word the file already holds for calls stays one.
 *
 * Dictation belongs to no workspace, so the page changes only the global file. It reads
 * `GET /vocab` for the workspace of the call the window shows, if any, so that workspace's words
 * are listed too, read only, with their file's path, as are those of `vocab.extraFiles`.
 */

import { tokenize } from "../core/vocab/correct.ts";
import { h, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";

/** An entry as `GET /vocab` lists it. */
export interface DictionaryEntry {
  term: string;
  heard: string[];
  confirmed: boolean;
  /** The file it comes from: `global` is the one this page changes. */
  scope: "global" | "workspace" | "extra";
  file: string;
  /** The entry's own `scope` key: `dictation` is read by dictation only (DC-L6). */
  entryScope?: "dictation";
  note?: string;
  /** `false` keeps the entry out of decoding. */
  decode?: boolean | number;
}

/** What `POST /vocab` takes from this page. */
interface WriteBody {
  term: string;
  heard: string[];
  confirmed?: boolean;
  note?: string;
  decode?: false;
  scope?: "dictation";
}

/**
 * An entry of the file as `POST /vocab` writes it back unchanged: the route replaces the whole
 * entry, so a field left out is lost. A numeric `decode` has no form the route takes.
 */
function kept(e: DictionaryEntry): WriteBody {
  return {
    term: e.term,
    heard: e.heard,
    confirmed: e.confirmed,
    ...(e.note ? { note: e.note } : {}),
    ...(e.decode === false ? { decode: false as const } : {}),
  };
}

/** The heard forms typed in one box, comma-separated. */
export function heardForms(typed: string): string[] {
  return typed
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

/** Two terms are the same entry under the server's key (`termKey`): words folded, accents off. */
const key = (s: string) =>
  tokenize(s)
    .map((t) => t.folded)
    .join(" ");
const same = (a: string, b: string) => key(a) === key(b);

export class DictationDictionary {
  readonly root = h("div", { class: "dictation-dictionary" });
  private readonly heard = h("input", {
    id: "dictionary-heard",
    placeholder: "dot com",
    attrs: { "aria-label": "What you say" },
  });
  private readonly term = h("input", {
    id: "dictionary-term",
    placeholder: ".com",
    attrs: { "aria-label": "What akou writes" },
  });
  private readonly issue = h("small", { id: "dictionary-issue", class: "issue", hidden: true });
  private readonly file = h("input", {
    id: "dictionary-import",
    type: "file",
    attrs: { accept: ".txt,text/plain", "aria-label": "Import a word list" },
  });
  private readonly list = h("ul", { id: "dictionary-list" });
  private entries: DictionaryEntry[] = [];
  private reads = 0;

  constructor(
    private readonly t: Transport,
    /** The workspace of the call the window shows, whose words are listed read only. */
    private readonly workspace: () => string | undefined = () => undefined,
  ) {
    const form = h(
      "form",
      {
        id: "dictionary-form",
        on: {
          submit: (e) => {
            e.preventDefault();
            void this.add();
          },
        },
      },
      h("label", {}, "You say ", this.heard),
      h("label", {}, " akou writes ", this.term),
      h("button", { id: "dictionary-add", type: "submit" }, "Add"),
      this.issue,
    );
    this.file.addEventListener("change", () => void this.importFile());
    this.root.append(
      h(
        "p",
        { class: "hint" },
        "A word akou should spell your way, or a phrase it should turn into other text. Leave 'You say' empty to teach a word alone; separate several ways of saying it with commas. What you add or import here applies to dictation only.",
      ),
      form,
      h(
        "p",
        { class: "hint" },
        h("label", {}, "Import a text file, one word per line: ", this.file),
      ),
      this.list,
    );
  }

  async load(): Promise<void> {
    const read = ++this.reads;
    const ws = this.workspace();
    const r = await this.t.request<{ entries?: DictionaryEntry[] }>(
      "GET",
      ws ? `/vocab?workspace=${encodeURIComponent(ws)}` : "/vocab",
    );
    if (read !== this.reads) return;
    if (r.status >= 400) {
      replace(
        this.list,
        h("li", { class: "hint" }, message(r.body, "the vocabulary could not be read")),
      );
      return;
    }
    this.entries = Array.isArray(r.body?.entries) ? r.body.entries : [];
    const rows = this.entries.map((e) => this.row(e));
    if (rows.length > 0) replace(this.list, ...rows);
    else
      replace(
        this.list,
        h(
          "li",
          { class: "hint", attrs: { "data-empty": "" } },
          "No words yet. Add one above, or import a list.",
        ),
      );
  }

  private row(e: DictionaryEntry): HTMLElement {
    const mine = e.scope === "global";
    const where = [
      // Dictation reads no workspace file: those words are for that workspace's calls.
      e.scope === "workspace"
        ? `calls in ${this.workspace() ?? "this workspace"} only`
        : e.entryScope === "dictation"
          ? "dictation only"
          : "calls and dictation",
      e.confirmed ? "" : "waiting for your yes",
      mine ? "" : `from ${e.file}`,
    ].filter((x) => x !== "");
    return h(
      "li",
      { attrs: { "data-term": e.term } },
      e.heard.length > 0 ? h("span", { class: "heard" }, e.heard.join(", ")) : null,
      e.heard.length > 0 ? " → " : null,
      h("span", { class: "term" }, e.term),
      " ",
      h("small", { class: "where hint" }, where.join(", ")),
      mine
        ? h(
            "span",
            { class: "bar" },
            e.entryScope === "dictation"
              ? h(
                  "button",
                  {
                    class: "calls-too",
                    type: "button",
                    title: "Calls read it too, under their own rules",
                    on: { click: () => void this.write(kept(e)) },
                  },
                  "Use in calls too",
                )
              : null,
            h(
              "button",
              { class: "remove", type: "button", on: { click: () => void this.remove(e.term) } },
              "Remove",
            ),
          )
        : null,
    );
  }

  private async add(): Promise<void> {
    const term = this.term.value.trim();
    if (term === "") {
      this.refused("Type what akou writes.");
      return;
    }
    const heard = heardForms(this.heard.value);
    const had = this.entries.find((e) => e.scope === "global" && same(e.term, term));
    // Adding forms to a term the file has keeps its spelling, its forms, its scope and the rest of
    // the entry: the route replaces the whole entry.
    const all = [...(had?.heard ?? [])];
    for (const x of heard) if (!all.some((y) => same(x, y))) all.push(x);
    const scoped = !had || had.entryScope === "dictation";
    const entry = had ? { ...kept(had), heard: all } : { term, heard: all };
    if (await this.write(scoped ? { ...entry, scope: "dictation" } : entry)) {
      this.term.value = "";
      this.heard.value = "";
    }
  }

  /** Writes one entry; the refusal, if any, is shown beside the form. */
  private async write(body: WriteBody): Promise<boolean> {
    const r = await this.t.request("POST", "/vocab", body);
    if (r.status >= 400) {
      this.refused(message(r.body, `the word was not saved (HTTP ${r.status})`));
      return false;
    }
    this.issue.hidden = true;
    toast("Saved.", "info");
    await this.load();
    return true;
  }

  private refused(why: string): void {
    this.issue.textContent = why;
    this.issue.hidden = false;
  }

  private async remove(term: string): Promise<void> {
    const r = await this.t.request("DELETE", `/vocab/${encodeURIComponent(term)}`);
    if (r.status >= 400) {
      toast(message(r.body, `the word was not removed (HTTP ${r.status})`));
      return;
    }
    toast(`Removed "${term}".`, "info");
    await this.load();
  }

  private async importFile(): Promise<void> {
    const f = this.file.files?.[0];
    if (!f) return;
    const text = await f.text();
    // The same file can be chosen again after an edit.
    this.file.value = "";
    const r = await this.t.request<{ imported?: number; skipped?: unknown[] }>(
      "POST",
      "/vocab/import",
      { text, scope: "dictation" },
    );
    if (r.status >= 400) {
      toast(message(r.body, `the list was not imported (HTTP ${r.status})`));
      return;
    }
    const n = r.body.imported ?? 0;
    const skipped = r.body.skipped?.length ?? 0;
    toast(
      `Imported ${n} ${n === 1 ? "word" : "words"}${skipped > 0 ? `; ${skipped} ${skipped === 1 ? "line was" : "lines were"} not a word` : ""}.`,
      "info",
    );
    await this.load();
  }
}

/** The window's Dictionary dialog, opened from the Dictation page or by `#dictation-dictionary`. */
export function mountDictionaryDialog(
  t: Transport,
  workspace?: () => string | undefined,
): { open(): Promise<void> } {
  const dialog = document.getElementById("dictation-dictionary") as HTMLDialogElement;
  const body = document.getElementById("dictation-dictionary-body") as HTMLElement;
  const dictionary = new DictationDictionary(t, workspace);
  body.append(dictionary.root);
  const open = async () => {
    await dictionary.load();
    if (!dialog.open) dialog.showModal();
  };
  document
    .getElementById("dictation-dictionary-close")
    ?.addEventListener("click", () => dialog.close());
  const fromHash = () => {
    if (location.hash === "#dictation-dictionary") void open();
  };
  window.addEventListener("hashchange", fromHash);
  fromHash();
  return { open };
}
