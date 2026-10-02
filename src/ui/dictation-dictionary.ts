/**
 * The Words page (docs/ux/design-explorations/sd-a-words.html, docs/ux/DICTATION.md DC-U5), under
 * the Dictation page with a back link. It edits the user's vocabulary file, the one calls read too
 * (WINDOW W9.2), through the API, so a script can do what the page does.
 *
 * An entry is a term and the forms it is heard as. A replacement is the same entry read the other
 * way: its heard form is what you say (`dot com`) and its term what akou writes (`.com`), replaced
 * whole word, in any case, longest first (DC-L6). The page lists an entry as a replacement when
 * what akou writes holds more than letters (`isReplacement`), and as a word otherwise.
 *
 * - Add a word, or Replace something I say: `POST /vocab {term, heard, scope: "dictation"}`.
 *   Dictation always applies such an entry and calls never read it, since a heard form such as
 *   "versal" would otherwise rewrite call transcripts. Adding forms to a term the file has keeps
 *   its forms, its scope, its note, its `decode: false` and whether it is confirmed: the route
 *   replaces the whole entry, so the page sends them back (the route keeps `source` and
 *   `added_at`).
 * - A row opens to Use in calls too, a switch: on is the same route without `scope`, an ordinary
 *   entry; off puts `scope: "dictation"` back. Remove is `DELETE /vocab/{term}`, one click.
 * - Import: a text file, one term per line, through `POST /vocab/import {scope: "dictation"}`, into
 *   the same file; a word the file already holds for calls stays one.
 * - To review: the words fixed while dictating (DC-L5, `dictation-review.ts`).
 *
 * Dictation belongs to no workspace, so the page changes only the global file. It reads
 * `GET /vocab` for the workspace of the call the window shows, if any, so that workspace's words
 * are listed too, read only, as are those of the other word lists (`vocab.extraFiles`).
 */

import { tokenize } from "../core/vocab/correct.ts";
import {
  type DictationReview,
  dictationReviewError,
  dictationReviewSection,
  readDictationReview,
} from "./dictation-review.ts";
import { h, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";
import { ICONS, icon, linkRow, row, toggle } from "./rows.ts";

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

/**
 * Two terms are the same entry under the server's key (`termKey`): words folded, accents off, and
 * a symbol alone (`@`) its own key.
 */
const key = (s: string) => {
  const words = tokenize(s).map((t) => t.folded);
  return words.length > 0 ? words.join(" ") : s.trim();
};
const same = (a: string, b: string) => key(a) === key(b);

/**
 * `GET /vocab` for the workspace of the call on screen. A call folder can have a name the
 * vocabulary refuses as a workspace (`con`, `a..b`), which answers 400: the words are read again
 * without it, so the global ones still show. A request that throws (the app gone) answers 599 with
 * the reason, so the page still opens and says it.
 */
export async function readVocab(
  t: Transport,
  ws: string | undefined,
): Promise<{ status: number; body: { entries?: DictionaryEntry[] } }> {
  const get = (path: string) =>
    t.request<{ entries?: DictionaryEntry[] }>("GET", path).catch((err: Error) => ({
      status: 599,
      body: { message: err.message } as { entries?: DictionaryEntry[] },
    }));
  const r = await get(ws ? `/vocab?workspace=${encodeURIComponent(ws)}` : "/vocab");
  return ws && r.status >= 400 && r.status < 500 ? get("/vocab") : r;
}

/** A section shows this many entries, then a row that shows the rest. */
export const WORDS_SHOWN = 8;

/**
 * An entry read as a replacement, "dot com → .com": it has a way of saying it and what akou writes
 * holds more than letters, digits, spaces, hyphens and apostrophes. Any other entry is a word,
 * with the forms it is also heard as. Both are the same entry in the file; this is only how the
 * page lists it.
 */
export function isReplacement(e: Pick<DictionaryEntry, "term" | "heard">): boolean {
  return e.heard.length > 0 && /[^\p{L}\p{N}\s'’-]/u.test(e.term);
}

const quote = (forms: readonly string[]) => forms.map((f) => `“${f}”`).join(", ");

/** The forms a closed row names: two, then how many more, since the open row lists them all. */
export function fewForms(forms: readonly string[]): string {
  return forms.length <= 2
    ? quote(forms)
    : `${quote(forms.slice(0, 2))} and ${forms.length - 2} more`;
}

/** Where the keyboard was in the list: the entry, the control, and the row's place. */
interface Spot {
  term: string | undefined;
  section: string | undefined;
  control: string;
  index: number;
}

/** The controls of a row, as a selector that finds the same one after a redraw. */
const CONTROLS = [
  ".pg-link",
  ".calls-too",
  ".remove",
  "button[data-action='approve']",
  "button[data-action='reject']",
  ".pg-rest button",
];

export class DictationDictionary {
  readonly root = h("div", { class: "dictation-dictionary" });
  private readonly heard = h("input", {
    id: "dictionary-heard",
    class: "pg-input",
    placeholder: "You say (commas for several)",
    hidden: true,
    attrs: { "aria-label": "What you say", autocomplete: "off", spellcheck: "false" },
  });
  private readonly arrow = h("span", { class: "pg-unit", hidden: true }, "→");
  private readonly term = h("input", {
    id: "dictionary-term",
    class: "pg-input",
    placeholder: "Add a word",
    attrs: { "aria-label": "A word", autocomplete: "off", spellcheck: "false" },
  });
  private readonly issue = h("small", { id: "dictionary-issue", class: "issue", hidden: true });
  private readonly mode = h("button", {
    id: "dictionary-replace",
    type: "button",
    class: "pg-textlink",
  });
  private readonly file = h("input", {
    id: "dictionary-import",
    type: "file",
    hidden: true,
    attrs: { accept: ".txt,text/plain", "aria-label": "Import a word list" },
  });
  private readonly list = h("div", { id: "dictionary-list" });
  private entries: DictionaryEntry[] = [];
  private review: DictationReview | null = null;
  private reads = 0;
  /** The typing form is "Replace something I say", not "Add a word". */
  private replacing = false;
  /** The entry opened to change, by the server's key of its term. */
  private opened: string | null = null;
  /** The sections showing every entry, not only the first few. */
  private readonly all = new Set<string>();
  /** Where the keyboard was in the list, until it leaves it. */
  private spot: Spot | null = null;

  constructor(
    private readonly t: Transport,
    /** The workspace of the call the window shows, whose words are listed read only. */
    private readonly workspace: () => string | undefined = () => undefined,
  ) {
    const form = h(
      "form",
      {
        id: "dictionary-form",
        class: "pg-grp",
        on: {
          submit: (e) => {
            e.preventDefault();
            void this.add();
          },
        },
      },
      h(
        "div",
        { class: "pg-row pg-add" },
        this.heard,
        this.arrow,
        this.term,
        h("button", { id: "dictionary-add", type: "submit", class: "pg-btn" }, "Add"),
      ),
    );
    this.mode.addEventListener("click", () => this.switchMode(!this.replacing));
    // An answer redraws the list, which takes the focused control with it: the keyboard is put
    // back where it was, or on the row that took the place of the one gone.
    this.list.addEventListener("focusin", (e) => {
      this.spot = spotOf(e.target as HTMLElement);
    });
    this.list.addEventListener("focusout", (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && !this.list.contains(to)) this.spot = null;
    });
    this.file.addEventListener("change", () => void this.importFile());
    this.switchMode(false);
    this.root.append(
      form,
      this.issue,
      h("p", { class: "pg-under" }, this.mode),
      this.list,
      h(
        "p",
        { class: "pg-under" },
        h(
          "button",
          {
            id: "dictionary-import-open",
            type: "button",
            class: "pg-textlink",
            on: { click: () => this.file.click() },
          },
          icon("M8 3v10M3 8h10"),
          "Import a list, one word per line",
        ),
        this.file,
      ),
    );
  }

  /** "Add a word", or "You say → akou writes" for a replacement; what is typed stays. */
  private switchMode(replacing: boolean): void {
    this.replacing = replacing;
    this.heard.hidden = !replacing;
    this.arrow.hidden = !replacing;
    this.term.placeholder = replacing ? "akou writes" : "Add a word";
    this.term.setAttribute("aria-label", replacing ? "What akou writes" : "A word");
    this.mode.textContent = replacing ? "Add a word instead" : "Replace something I say";
  }

  async load(): Promise<void> {
    const read = ++this.reads;
    const [r, review] = await Promise.all([
      readVocab(this.t, this.workspace()),
      readDictationReview(this.t),
    ]);
    if (read !== this.reads) return;
    this.review = review;
    if (r.status >= 400) {
      replace(
        this.list,
        h("p", { class: "pg-sechelp" }, message(r.body, "the vocabulary could not be read")),
      );
      return;
    }
    this.entries = Array.isArray(r.body?.entries) ? r.body.entries : [];
    this.draw();
  }

  private draw(): void {
    const mine = this.entries.filter((e) => e.scope === "global");
    const ws = this.workspace();
    const review =
      this.review && "error" in this.review
        ? dictationReviewError(this.review.error)
        : this.review?.pairs
          ? dictationReviewSection(this.t, this.review.pairs, async (said, ok) => {
              toast(said, ok ? "info" : "error");
              if (ok) await this.load();
            })
          : null;
    replace(
      this.list,
      review,
      mine.length === 0
        ? h(
            "p",
            { class: "pg-sechelp pg-empty", attrs: { "data-empty": "" } },
            "No words yet. Add one above, or import a list.",
          )
        : null,
      this.part(
        "Words",
        mine.filter((e) => !isReplacement(e)),
      ),
      this.part("Replacements", mine.filter(isReplacement)),
      this.part(
        ws ? `From the ${ws} workspace` : "From this workspace",
        this.entries.filter((e) => e.scope === "workspace"),
        `Used on ${ws ? `${ws}'s` : "this workspace's"} calls only, not in dictation. Change them from that workspace.`,
      ),
      this.part(
        "From your other word lists",
        this.entries.filter((e) => e.scope === "extra"),
        "Used in calls and dictation. Change them in their own file.",
      ),
    );
    this.refocus();
  }

  /** Puts the keyboard back after a redraw took the control it was on. */
  private refocus(): void {
    const spot = this.spot;
    const now = document.activeElement;
    if (!spot || (now && now !== document.body && now.isConnected)) return;
    const section = spot.section
      ? this.list.querySelector(`[data-section="${CSS.escape(spot.section)}"]`)
      : null;
    const rows = [...(section?.querySelectorAll<HTMLElement>("[data-term], .pg-rest") ?? [])];
    const same = spot.term
      ? rows.find((r) => r.dataset.term === spot.term)
      : rows.find((r) => r.classList.contains("pg-rest"));
    // The entry is gone (learned, removed): the row now in its place, or the last one left.
    const at = same ?? rows[Math.min(spot.index, rows.length - 1)];
    const target =
      (same ? at?.querySelector<HTMLElement>(spot.control) : null) ??
      at?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)") ??
      this.term;
    target.focus();
  }

  /** One section of entries with its count; the first few, then a row that shows the rest. */
  private part(title: string, entries: DictionaryEntry[], help?: string): HTMLElement | null {
    if (entries.length === 0) return null;
    const shown = this.all.has(title) ? entries : entries.slice(0, WORDS_SHOWN);
    const rest = entries.length - shown.length;
    const items = shown.map((e) => this.item(e));
    if (rest > 0)
      items.push(
        h(
          "li",
          { class: "pg-rest" },
          linkRow({ label: `${rest} more` }, () => {
            this.all.add(title);
            this.draw();
          }),
        ),
      );
    return h(
      "section",
      { class: "pg-section", attrs: { "data-section": title } },
      h(
        "h2",
        { class: "pg-sec" },
        title,
        " ",
        h("span", { class: "pg-count" }, String(entries.length)),
      ),
      help ? h("p", { class: "pg-sechelp" }, help) : null,
      h("ul", { class: "pg-grp pg-list" }, ...items),
    );
  }

  /** What the row says on its right: how else it is heard, and where it applies. */
  private where(e: DictionaryEntry): string {
    return [
      e.heard.length > 0 && !isReplacement(e) ? `also heard as ${fewForms(e.heard)}` : "",
      // Another list's section says where its words apply, so its rows need not.
      e.scope === "global" && e.entryScope !== "dictation" ? "Calls too" : "",
      e.confirmed ? "" : "Not confirmed yet",
    ]
      .filter((x) => x !== "")
      .join(" · ");
  }

  private item(e: DictionaryEntry): HTMLElement {
    const name = isReplacement(e)
      ? h(
          "b",
          { class: "pg-name" },
          h("span", { class: "heard" }, e.heard.join(", ")),
          h("span", { class: "pg-arrow" }, " → "),
          h("span", { class: "term" }, e.term),
        )
      : h("b", { class: "pg-name" }, h("span", { class: "term" }, e.term));
    const li = h("li", { attrs: { "data-term": e.term } });
    // Another file's words are read only: changed from where they live.
    if (e.scope !== "global") {
      const where = this.where(e);
      li.append(
        h(
          "div",
          { class: "pg-row pg-ro" },
          h("span", { class: "pg-lbl" }, name),
          where
            ? h(
                "span",
                { class: "pg-ctl" },
                h("span", { class: "pg-value where", title: where }, where),
              )
            : null,
        ),
      );
      return li;
    }
    const open = this.opened === key(e.term);
    const where = this.where(e);
    const head = h(
      "button",
      {
        type: "button",
        class: `pg-row pg-link${open ? " open" : ""}`,
        attrs: { "aria-expanded": String(open) },
        on: {
          click: () => {
            this.opened = open ? null : key(e.term);
            this.draw();
            this.list
              .querySelector<HTMLElement>(`li[data-term="${CSS.escape(e.term)}"] .pg-link`)
              ?.focus();
          },
        },
      },
      h(
        "span",
        { class: "pg-lbl" },
        name,
        open && e.heard.length > 0
          ? h(
              "span",
              { class: "pg-help" },
              isReplacement(e)
                ? `Written for ${quote(e.heard)}.`
                : `Also heard as ${quote(e.heard)}.`,
            )
          : null,
      ),
      h(
        "span",
        { class: "pg-ctl" },
        !open && where ? h("span", { class: "pg-value where", title: where }, where) : null,
        h("span", { class: "pg-more" }, icon(...ICONS.chevron)),
      ),
    );
    li.append(head);
    if (!open) return li;
    const calls = toggle({
      id: `dictionary-calls-${this.entries.indexOf(e)}`,
      checked: e.entryScope !== "dictation",
      label: "Use in calls too",
    });
    calls.classList.add("calls-too");
    calls.addEventListener("change", () => {
      // Calls read it too, under their own rules; off, dictation alone reads it again. A refusal
      // is said at once, and the switch shows what the file still holds.
      void this.write(calls.checked ? kept(e) : { ...kept(e), scope: "dictation" }, false).then(
        (ok) => {
          if (!ok) calls.checked = e.entryScope !== "dictation";
        },
      );
    });
    li.append(
      row(
        {
          label: "Use in calls too",
          help: "Fixes it in every call transcript as well.",
          for: calls.id,
        },
        calls,
      ),
      h(
        "div",
        { class: "pg-row" },
        h(
          "button",
          {
            class: "remove pg-textlink",
            type: "button",
            on: { click: () => void this.remove(e.term) },
          },
          isReplacement(e) ? "Remove this replacement" : "Remove this word",
        ),
      ),
    );
    return li;
  }

  private async add(): Promise<void> {
    const term = this.term.value.trim();
    if (term === "") {
      this.refused(this.replacing ? "Type what akou writes." : "Type a word.");
      return;
    }
    const heard = this.replacing ? heardForms(this.heard.value) : [];
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

  /** Writes one entry; the refusal, if any, is shown under the form, or said by a row's change. */
  private async write(body: WriteBody, fromForm = true): Promise<boolean> {
    const r = await this.t.request("POST", "/vocab", body);
    if (r.status >= 400) {
      const why = message(r.body, `the word was not saved (HTTP ${r.status})`);
      if (fromForm) this.refused(why);
      else toast(why);
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
    this.opened = null;
    toast(`Removed ${term}.`, "info");
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

/** The spot of a focused control in the list, or null when it is none of a row's. */
function spotOf(el: HTMLElement): Spot | null {
  const control = CONTROLS.find((c) => el.matches(c));
  const item = el.closest<HTMLElement>("[data-term], .pg-rest");
  const section = el.closest<HTMLElement>("[data-section]");
  if (!control || !item || !section) return null;
  const rows = [...section.querySelectorAll<HTMLElement>("[data-term], .pg-rest")];
  return {
    term: item.dataset.term,
    section: section.dataset.section,
    control,
    index: rows.indexOf(item),
  };
}
