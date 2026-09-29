/**
 * The dictation History page (docs/ux/DICTATION.md DC-H1), in the desktop window beside the
 * Dictation settings: every dictation with its time, the app it went to, the engine, the time it
 * took, the language it was heard in (akou-5v8), its state and its text, newest first, over `GET /dictations`. Search is over the text, on
 * this page only, since dictations are the user's own words and not a call.
 *
 * Every action goes through the API (DC-G1), so a script can do what the page does:
 * - Insert again: `POST /dictations/{id}/insert {text}` opens the draft box on it, so the user sees
 *   where it goes; the API never pastes blind.
 * - Fix: the same route with `fix: true`, the draft box for correcting and teaching (DC-A5), which
 *   leaves the app the dictation went into alone.
 * - Retry: `POST /dictations/{id}/retry {engine}` decodes the same audio again; its answer is shown
 *   beside the first, and either can be inserted.
 * - Delete: `DELETE /dictations/{id}` removes the dictation and its audio, after a second press.
 * - Copy: the page's own clipboard.
 */

import { closable, h, openModal, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";
import { twoStep } from "./server-common.ts";

/** A dictation as `GET /dictations` lists it. */
export interface DictationRow {
  id: string;
  /** Epoch ms of the key-down. */
  at: number;
  state: string;
  /** The app it went to; null for a clip sent to the API. */
  app: string | null;
  text: string | null;
  /** The language the engine heard or was told (`es`); null when it named none. */
  language?: string | null;
  engine: string;
  model?: string | null;
  ms: number | null;
  fallback_from?: string;
  error?: string;
}

interface Page {
  items: DictationRow[];
  next_cursor: string | null;
}

/** The engines a retry can ask for; the route refuses one this machine cannot run, and says why. */
export const RETRY_ENGINES = ["fast", "best", "remote"] as const;

/** Dictations per page. */
export const HISTORY_PAGE = 50;

/** How long the search waits after the last keystroke. */
const SEARCH_MS = 250;

/** `0.3 s` for a decode time in milliseconds. */
export function took(ms: number | null): string {
  if (ms === null) return "";
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export class DictationHistory {
  readonly root = h("div", { class: "dictation-history" });
  private readonly search = h("input", {
    id: "dictation-history-q",
    type: "search",
    placeholder: "Search your dictations",
    attrs: { "aria-label": "Search your dictations" },
  });
  private readonly list = h("ul", { id: "dictation-history-list" });
  private readonly more = h(
    "button",
    { id: "dictation-history-more", type: "button", hidden: true },
    "Older",
  );
  private cursor: string | null = null;
  private reads = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly armed = new Map<string, number>();

  constructor(private readonly t: Transport) {
    this.search.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.load(), SEARCH_MS);
    });
    this.more.addEventListener("click", () => void this.load(true));
    this.root.append(this.search, this.list, this.more);
  }

  /** The first page for the search as typed; with `older`, the next page after the last shown. */
  async load(older = false): Promise<void> {
    const read = ++this.reads;
    const q = this.search.value.trim();
    const params = new URLSearchParams({ limit: String(HISTORY_PAGE) });
    if (q) params.set("q", q);
    if (older && this.cursor) params.set("cursor", this.cursor);
    const r = await this.t.request<Page>("GET", `/dictations?${params}`);
    if (read !== this.reads) return;
    if (r.status >= 400) {
      replace(
        this.list,
        h("li", { class: "hint" }, message(r.body, "the dictations could not be read")),
      );
      this.more.hidden = true;
      return;
    }
    const rows = r.body.items.map((d) => this.row(d));
    if (older) this.list.append(...rows);
    else if (rows.length > 0) replace(this.list, ...rows);
    else this.empty();
    this.cursor = r.body.next_cursor;
    this.more.hidden = this.cursor === null;
  }

  private row(d: DictationRow): HTMLElement {
    const text = d.text ?? "";
    const results = h("div", { class: "results" }, this.result(d.id, d, "first"));
    const engine = h(
      "select",
      { class: "retry-engine", attrs: { "aria-label": "Engine to retry with" } },
      ...RETRY_ENGINES.map((e) => h("option", { value: e }, e)),
    );
    // The first other engine, since the same one would most likely hear the same.
    engine.value = RETRY_ENGINES.find((e) => e !== d.engine) ?? "best";
    const li = h(
      "li",
      { attrs: { "data-id": d.id, "data-state": d.state } },
      h(
        "p",
        { class: "meta" },
        h("time", { attrs: { datetime: new Date(d.at).toISOString() } }, when(d.at)),
        ` · ${d.app ?? "no app"} · ${d.engine}${d.ms !== null ? ` ${took(d.ms)}` : ""}`,
        d.fallback_from ? ` (instead of ${d.fallback_from})` : "",
        d.language
          ? h(
              "span",
              { class: "language", attrs: { title: "Language heard" } },
              ` · ${d.language.split("-")[0]?.toUpperCase()}`,
            )
          : "",
        " · ",
        h("span", { class: "state" }, d.state),
        d.error ? h("span", { class: "issue" }, ` ${d.error}`) : null,
      ),
      results,
      h(
        "div",
        { class: "bar" },
        h(
          "button",
          { class: "copy", type: "button", disabled: text === "", on: { click: () => copy(text) } },
          "Copy",
        ),
        h(
          "button",
          {
            class: "retry",
            type: "button",
            on: { click: () => void this.retry(d.id, engine.value, results) },
          },
          "Retry with",
        ),
        engine,
        h(
          "button",
          {
            class: "fix",
            type: "button",
            disabled: text === "",
            on: { click: () => void this.insert(d.id, text, true) },
          },
          "Fix",
        ),
        twoStep(
          {
            class: "delete stop",
            label: "Delete",
            confirm: "Delete it and its audio?",
            id: d.id,
            armed: this.armed,
          },
          () => void this.remove(d.id, li),
        ),
      ),
    );
    return li;
  }

  /** One reading of a dictation, with its own Insert: the first, or a retry's beside it. */
  private result(id: string, d: DictationRow, which: "first" | "retry"): HTMLElement {
    const text = d.text ?? "";
    return h(
      "div",
      { class: `result ${which}`, attrs: { "data-engine": d.engine } },
      which === "retry"
        ? h(
            "small",
            { class: "hint" },
            `${d.engine}${d.ms !== null ? ` ${took(d.ms)}` : ""}`,
            // The engine asked for could not run: say which one decoded it instead.
            d.fallback_from ? ` (instead of ${d.fallback_from})` : "",
          )
        : null,
      h("p", { class: "text" }, text),
      h(
        "button",
        {
          class: "insert",
          type: "button",
          disabled: text === "",
          on: { click: () => void this.insert(id, text, false) },
        },
        "Insert again",
      ),
    );
  }

  private async insert(id: string, text: string, fix: boolean): Promise<void> {
    const r = await this.t.request(
      "POST",
      `/dictations/${encodeURIComponent(id)}/insert`,
      fix ? { text, fix: true } : { text },
    );
    if (r.status >= 400) toast(message(r.body, `the draft box did not open (HTTP ${r.status})`));
  }

  private async retry(id: string, engine: string, results: HTMLElement): Promise<void> {
    const r = await this.t.request<DictationRow>(
      "POST",
      `/dictations/${encodeURIComponent(id)}/retry`,
      { engine },
    );
    if (r.status >= 400) {
      toast(message(r.body, `the retry failed (HTTP ${r.status})`));
      return;
    }
    // One retry beside the first at a time: a second replaces the one before.
    results.querySelector(".result.retry")?.remove();
    results.append(this.result(id, r.body, "retry"));
  }

  private async remove(id: string, li: HTMLElement): Promise<void> {
    const r = await this.t.request("DELETE", `/dictations/${encodeURIComponent(id)}`);
    if (r.status >= 400) {
      toast(message(r.body, `the dictation was not deleted (HTTP ${r.status})`));
      return;
    }
    li.remove();
    // The last one shown: read again, for the next page or the empty hint.
    if (this.list.children.length === 0) void this.load();
    toast("Deleted, with its audio.", "info");
  }

  private empty(): void {
    replace(
      this.list,
      h(
        "li",
        { class: "hint", attrs: { "data-empty": "" } },
        this.search.value.trim() ? "No dictation holds that." : "No dictations yet.",
      ),
    );
  }
}

/** A dictation's time, in this machine's local wall clock. */
function when(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast("Copied.", "info"),
    () => toast("The clipboard is not available here."),
  );
}

/** The window's History dialog, opened from the Dictation page or by `#dictation-history`. */
export function mountHistoryDialog(t: Transport): { open(): Promise<void> } {
  const dialog = document.getElementById("dictation-history") as HTMLDialogElement;
  const body = document.getElementById("dictation-history-body") as HTMLElement;
  const history = new DictationHistory(t);
  body.append(history.root);
  const open = async () => {
    await history.load();
    openModal(dialog);
  };
  closable(dialog);
  document
    .getElementById("dictation-history-close")
    ?.addEventListener("click", () => dialog.close());
  const fromHash = () => {
    if (location.hash === "#dictation-history") void open();
  };
  window.addEventListener("hashchange", fromHash);
  fromHash();
  return { open };
}
