/**
 * The History page (docs/ux/design-explorations/sd-a-history.html, docs/ux/DICTATION.md DC-H1),
 * under the Dictation page with a back link: every dictation, newest first, under the day it was
 * made, over `GET /dictations`. A row is the text, then its time, the app it went to, the language
 * it was heard in (akou-5v8) and what became of it when that is not a plain insert. Search is over
 * the text, on this page only, since dictations are the user's own words and not a call. The
 * retention rows and Delete all are drawn by the Dictation page, which saves settings.
 *
 * Every action goes through the API (DC-G1), so a script can do what the page does. Copy, Insert
 * again and Correct a word show on the row under the pointer or the keyboard; Retry and Delete are
 * in its menu.
 * - Insert again: `POST /dictations/{id}/insert {text}` opens the draft box on it, so the user sees
 *   where it goes; the API never pastes blind.
 * - Correct a word: the same route with `fix: true`, the draft box for correcting and teaching
 *   (DC-A5), which leaves the app the dictation went into alone.
 * - Retry with another engine: `POST /dictations/{id}/retry {engine}` decodes the same audio again;
 *   its answer is shown under the first, with its own Insert.
 * - Delete: `DELETE /dictations/{id}` removes the dictation and its audio, after a second press.
 * - Copy: the page's own clipboard.
 */

import { languageName } from "./dictation-languages.ts";
import { h, replace, toast } from "./dom.ts";
import { dayLabel, hourMinute, localZone } from "./model.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";
import { ICONS, icon } from "./rows.ts";
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
export const RETRY_ENGINES = ["fast", "best", "live", "remote"] as const;

/** An engine as a person reads it. */
export function engineName(engine: string): string {
  return engine === "remote"
    ? "the other computer"
    : engine.charAt(0).toUpperCase() + engine.slice(1);
}

/** Dictations per page. */
export const HISTORY_PAGE = 50;

/** How long the search waits after the last keystroke. */
const SEARCH_MS = 250;

/** What became of a dictation, in words; nothing for the usual insert. */
const STATES: Record<string, string> = {
  listening: "Listening",
  transcribing: "Transcribing",
  inserting: "Inserting",
  // Enter in the draft box makes it `inserted` and closing it `discarded`: this one is still there.
  drafted: "Left in the draft box",
  discarded: "Discarded",
  cancelled: "Cancelled",
  empty: "Nothing heard",
  failed: "Failed",
};

/** `0.3 s` for a decode time in milliseconds. */
export function took(ms: number | null): string {
  if (ms === null) return "";
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export class DictationHistory {
  readonly search = h("input", {
    id: "dictation-history-q",
    type: "search",
    placeholder: "Search your dictations",
    attrs: { "aria-label": "Search your dictations", autocomplete: "off" },
  });
  /** The search as the page's header holds it. */
  readonly find = h(
    "div",
    { class: "pg-find" },
    h("label", {}, icon(...ICONS.search), this.search),
  );
  readonly root = h("div", { class: "dictation-history" });
  private readonly list = h("div", { id: "dictation-history-list" });
  private readonly more = h(
    "button",
    { id: "dictation-history-more", type: "button", class: "pg-textlink", hidden: true },
    "Older dictations",
  );
  private items: DictationRow[] = [];
  private readonly rows = new Map<string, HTMLElement>();
  private cursor: string | null = null;
  private reads = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly armed = new Map<string, number>();

  /**
   * Whether another computer is set up to retry on; the Dictation page, which reads the settings,
   * sets it. The menu asks it each time it opens.
   */
  remote: () => boolean = () => true;

  constructor(private readonly t: Transport) {
    this.search.addEventListener("input", () => {
      clearTimeout(this.timer);
      // clock: debounces the search box while the user types.
      this.timer = setTimeout(() => void this.load(), SEARCH_MS);
    });
    this.more.addEventListener("click", () => void this.load(true));
    // A menu closes on a press anywhere else, and on Escape.
    document.addEventListener("pointerdown", (e) => {
      if (!(e.target as Element | null)?.closest?.(".hist-menu, .hist-more")) this.closeMenus();
    });
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.root.querySelector(".hist-menu:not([hidden])")) {
        e.stopPropagation();
        this.closeMenus();
      }
    });
    this.root.append(this.list, h("p", { class: "pg-under" }, this.more));
  }

  /** The first page for the search as typed; with `older`, the next page after the last shown. */
  async load(older = false): Promise<void> {
    const read = ++this.reads;
    const q = this.search.value.trim();
    const params = new URLSearchParams({ limit: String(HISTORY_PAGE) });
    if (q) params.set("q", q);
    if (older && this.cursor) params.set("cursor", this.cursor);
    // A request that throws (the app gone) is said in the list, so the page still opens.
    const r = await this.t
      .request<Page>("GET", `/dictations?${params}`)
      .catch((err: Error) => ({ status: 599, body: { message: err.message } as unknown as Page }));
    if (read !== this.reads) return;
    if (r.status >= 400) {
      replace(
        this.list,
        h("p", { class: "pg-sechelp" }, message(r.body, "the dictations could not be read")),
      );
      this.more.hidden = true;
      return;
    }
    if (!older) {
      this.items = [];
      this.rows.clear();
    }
    this.items.push(...r.body.items);
    this.cursor = r.body.next_cursor;
    this.more.hidden = this.cursor === null;
    this.draw();
  }

  /** The rows under their days; a row drawn before is moved, so a retry's reading stays. */
  private draw(): void {
    if (this.items.length === 0) {
      replace(
        this.list,
        h(
          "p",
          { class: "pg-sechelp pg-empty", attrs: { "data-empty": "" } },
          this.search.value.trim() ? "No dictation holds that." : "No dictations yet.",
        ),
      );
      return;
    }
    const days = new Map<string, HTMLElement[]>();
    // clock: the history groups by day against the page's own clock.
    const now = Date.now();
    // The same days and times as the calls in the sidebar.
    const tz = localZone();
    for (const d of this.items) {
      const label = dayLabel(d.at, now, tz);
      let li = this.rows.get(d.id);
      if (!li) {
        li = this.row(d);
        this.rows.set(d.id, li);
      }
      days.set(label, [...(days.get(label) ?? []), li]);
    }
    replace(
      this.list,
      ...[...days].map(([label, rows]) =>
        h(
          "section",
          { class: "pg-section", attrs: { "data-section": label } },
          h("h2", { class: "pg-sec" }, label),
          h("ul", { class: "pg-grp pg-list" }, ...rows),
        ),
      ),
    );
  }

  private row(d: DictationRow): HTMLElement {
    const text = d.text ?? "";
    const results = h("div", { class: "results" }, this.result(d.id, d, "first"));
    const menu = h("div", { class: "pg-menu hist-menu", role: "menu", hidden: true });
    const moreBtn = h(
      "button",
      {
        type: "button",
        class: "hist-more",
        title: "More",
        attrs: { "aria-label": "More", "aria-haspopup": "menu", "aria-expanded": "false" },
        on: {
          click: () => {
            const open = menu.hidden === true;
            this.closeMenus();
            if (open) this.fillMenu(menu, d, results);
            menu.hidden = !open;
            moreBtn.setAttribute("aria-expanded", String(open));
            li.classList.toggle("menu-open", open);
            if (open) placeMenu(menu, moreBtn, li);
          },
        },
      },
      icon("M3.5 8h0M8 8h0M12.5 8h0"),
    );
    const li = h(
      "li",
      { class: "pg-row hist-row", attrs: { "data-id": d.id, "data-state": d.state } },
      h("div", { class: "pg-lbl" }, results, h("span", { class: "pg-help meta" }, ...this.meta(d))),
      h(
        "div",
        { class: "pg-ctl hist-actions" },
        h(
          "button",
          {
            class: "pg-btn copy",
            type: "button",
            disabled: text === "",
            on: { click: () => copy(text) },
          },
          "Copy",
        ),
        h(
          "button",
          {
            class: "pg-btn insert",
            type: "button",
            disabled: text === "",
            on: { click: () => void this.insert(d.id, text, false) },
          },
          "Insert again",
        ),
        h(
          "button",
          {
            class: "pg-btn ghost fix",
            type: "button",
            disabled: text === "",
            on: { click: () => void this.insert(d.id, text, true) },
          },
          "Correct a word",
        ),
        moreBtn,
      ),
      menu,
    );
    return li;
  }

  /**
   * The row's menu as it opens: Retry with every engine but the one that heard it, since that one
   * would most likely hear the same, and the other computer only when one is set up; then Delete,
   * which asks once more.
   */
  private fillMenu(menu: HTMLElement, d: DictationRow, results: HTMLElement): void {
    const engines = RETRY_ENGINES.filter(
      (x) => x !== d.engine && (x !== "remote" || this.remote()),
    );
    const del = twoStep(
      {
        class: "delete",
        label: "Delete",
        confirm: "Delete it and its audio?",
        id: d.id,
        armed: this.armed,
      },
      () => void this.remove(d.id),
    );
    del.setAttribute("role", "menuitem");
    replace(
      menu,
      ...engines.map((e) =>
        h(
          "button",
          {
            type: "button",
            role: "menuitem",
            class: "retry",
            attrs: { "data-engine": e },
            on: {
              click: () => {
                this.closeMenus();
                void this.retry(d.id, e, results);
              },
            },
          },
          e === "remote" ? "Retry on the other computer" : `Retry with ${engineName(e)}`,
        ),
      ),
      engines.length > 0 ? h("hr", {}) : null,
      del,
    );
  }

  /** The line under the text: its time, its app, its language, and what became of it. */
  private meta(d: DictationRow): (Node | string)[] {
    const out: (Node | string)[] = [
      h(
        "time",
        { attrs: { datetime: new Date(d.at).toISOString() } },
        hourMinute(d.at, localZone()),
      ),
      ` · ${d.app ?? "No app"}`,
    ];
    // The engine asked for could not run: the one that heard it instead, as a retry says.
    if (d.fallback_from)
      out.push(
        " · ",
        h(
          "span",
          { class: "fallback" },
          `${engineName(d.engine)} instead of ${engineName(d.fallback_from)}`,
        ),
      );
    if (d.language)
      out.push(
        " · ",
        h("span", { class: "language" }, languageName(d.language.split("-")[0] ?? d.language)),
      );
    const state = STATES[d.state];
    if (state) out.push(" · ", h("span", { class: "state" }, state));
    if (d.error) out.push(": ", h("span", { class: "issue" }, d.error));
    return out;
  }

  /** One reading of a dictation: the first, or a retry's under it with its own Insert. */
  private result(id: string, d: DictationRow, which: "first" | "retry"): HTMLElement {
    const text = d.text ?? "";
    return h(
      "div",
      { class: `result ${which}`, attrs: { "data-engine": d.engine } },
      which === "retry"
        ? h(
            "small",
            { class: "pg-help" },
            `${engineName(d.engine)}${d.ms !== null ? ` · ${took(d.ms)}` : ""}`,
            // The engine asked for could not run: say which one decoded it instead.
            d.fallback_from ? `, instead of ${engineName(d.fallback_from)}` : "",
          )
        : null,
      h("p", { class: "text" }, text),
      which === "retry"
        ? h(
            "button",
            {
              class: "pg-btn insert",
              type: "button",
              disabled: text === "",
              on: { click: () => void this.insert(id, text, false) },
            },
            "Insert this",
          )
        : null,
    );
  }

  private closeMenus(): void {
    for (const m of this.root.querySelectorAll<HTMLElement>(".hist-menu")) m.hidden = true;
    for (const b of this.root.querySelectorAll<HTMLElement>(".hist-more"))
      b.setAttribute("aria-expanded", "false");
    for (const r of this.root.querySelectorAll<HTMLElement>(".menu-open"))
      r.classList.remove("menu-open");
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
    // One retry under the first at a time: a second replaces the one before.
    results.querySelector(".result.retry")?.remove();
    results.append(this.result(id, r.body, "retry"));
  }

  private async remove(id: string): Promise<void> {
    const r = await this.t.request("DELETE", `/dictations/${encodeURIComponent(id)}`);
    if (r.status >= 400) {
      toast(message(r.body, `the dictation was not deleted (HTTP ${r.status})`));
      return;
    }
    this.items = this.items.filter((d) => d.id !== id);
    this.rows.delete(id);
    // The last one shown: read again, for the next page or the empty line.
    if (this.items.length === 0) void this.load();
    else this.draw();
    toast("Deleted, with its audio.", "info");
  }
}

/**
 * Opens the menu under its ⋯ button, or over it when the page has no room below, so Delete is
 * never past the bottom of the window.
 */
function placeMenu(menu: HTMLElement, button: HTMLElement, row: HTMLElement): void {
  const b = button.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const view = row.closest("#pages")?.getBoundingClientRect();
  const bottom = Math.min(window.innerHeight, view?.bottom ?? window.innerHeight);
  // Below the macOS window's title-bar strip, which stays over the page.
  const bar = document.querySelector("#pages > .pg-bar")?.getBoundingClientRect().height ?? 0;
  const top = (view?.top ?? 0) + bar;
  const tall = menu.offsetHeight;
  const up = b.bottom + 4 + tall > bottom && b.top - 4 - tall >= top;
  menu.classList.toggle("up", up);
  menu.style.top = `${Math.round((up ? b.top - 4 - tall : b.bottom + 4) - r.top)}px`;
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast("Copied.", "info"),
    () => toast("The clipboard is not available here."),
  );
}
