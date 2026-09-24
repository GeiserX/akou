/**
 * The live transcript (docs/DESIGN.md section 7, the hark-viewer parity rows): append-only rows
 * with a wall-clock time column, the speaker's chip on each change of speaker, the last three rows
 * bright and older ones dim, a rise animation for new rows, auto-scroll while pinned to the bottom
 * and "Back to live" once scrolled up more than 80 px, font size 14 to 44 px with `+` and `-`.
 *
 * Rows are drawn from the page's fold and only the ones its change feed names are touched: a new
 * line is inserted in the one sort order (wall time, mic before call, `seq`), a revised line is
 * rewritten in place, a retracted or echo line is removed, and a rename or merge rewrites every
 * row's label without reading anything again. Each line shows the corrected text, with the raw
 * text on hover when a correction changed it (TRAPS "Answers from uncorrected recognition").
 *
 * The grey provisional row sits below the list with a dashed border; it is replaced as it
 * changes, never becomes a row, and is gone 3 s after its last update.
 */

import { formatWall } from "../core/log/clock.ts";
import { type CallView, type Line, PROVISIONAL_TTL_MS } from "../core/log/fold.ts";
import { byId, h, replace } from "./dom.ts";
import { formatDuration } from "./model.ts";
import type { PartialLine } from "./protocol.ts";

export const SCROLL_PIN_PX = 80;
export const FONT_MIN = 14;
export const FONT_MAX = 44;
export const FONT_DEFAULT = 22;
const NEW_FOR_MS = 4000;

export interface TranscriptDeps {
  view(): CallView | null;
  hue(spk: string): number;
  play(lineId: string): void;
  speakerMenu(spk: string, anchor: HTMLElement): void;
  fixWord(lineId: string, anchor: HTMLElement, selected: string): void;
}

/** One transcript row. Everything from the line goes in as text. */
export function rowElement(): HTMLElement {
  return h(
    "div",
    { class: "row" },
    h("time", {}),
    h(
      "div",
      { class: "body" },
      h("button", { class: "who", type: "button", attrs: { "aria-haspopup": "menu" } }),
      h("span", { class: "text" }),
    ),
  );
}

/** Fills a row: time, speaker chip, hue, text; the raw text on hover when it was corrected. */
export function fillRow(
  row: HTMLElement,
  l: {
    id: string;
    time: string;
    timeTitle?: string;
    spk: string;
    speaker: string;
    text: string;
    heard?: string;
    ch: string;
  },
  hue: number,
): void {
  row.dataset.id = l.id;
  row.dataset.spk = l.spk;
  row.dataset.h = String(hue);
  row.style.setProperty("--h", String(hue));
  row.classList.toggle("mine", l.ch === "mic");
  const [time, body] = row.children as unknown as [HTMLElement, HTMLElement];
  time.textContent = l.time;
  if (l.timeTitle) time.title = l.timeTitle;
  const who = body.querySelector(".who") as HTMLElement;
  who.textContent = l.speaker;
  who.dataset.spk = l.spk;
  who.setAttribute("aria-label", `${l.speaker}: rename, merge or unmerge`);
  const text = body.querySelector(".text") as HTMLElement;
  text.textContent = l.text;
  if (l.heard !== undefined) {
    text.title = `heard: "${l.heard}"`;
    text.classList.add("corrected");
  } else {
    text.removeAttribute("title");
    text.classList.remove("corrected");
  }
}

function key(el: HTMLElement): [number, number, number] {
  return [Number(el.dataset.w0), el.dataset.ch === "mic" ? 0 : 1, Number(el.dataset.seq)];
}

function before(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
}

export class TranscriptPane {
  private readonly rows = new Map<string, HTMLElement>();
  private readonly list = byId("lines");
  private readonly scroller = byId("scroller");
  private readonly partialBox = byId("partial");
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  pinned = true;
  private size = FONT_DEFAULT;

  constructor(private readonly d: TranscriptDeps) {
    this.scroller.addEventListener("scroll", () => {
      const s = this.scroller;
      this.pinned = s.scrollHeight - s.scrollTop - s.clientHeight < SCROLL_PIN_PX;
      document.body.classList.toggle("scrolled", !this.pinned);
    });
    byId("jump").addEventListener("click", () => this.backToLive());
    this.list.addEventListener("click", (e) => this.onClick(e));
    const saved = Number(localStorage.getItem("akou.size"));
    if (saved >= FONT_MIN && saved <= FONT_MAX) this.setSize(saved);
    document.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], dialog")) return;
      if (e.key === "+" || e.key === "=") this.setSize(this.size + 2);
      else if (e.key === "-") this.setSize(this.size - 2);
    });
  }

  get count(): number {
    return this.rows.size;
  }

  setSize(px: number): void {
    this.size = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
    document.documentElement.style.setProperty("--size", `${this.size}px`);
    localStorage.setItem("akou.size", String(this.size));
  }

  backToLive(): void {
    this.pinned = true;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    document.body.classList.remove("scrolled");
  }

  reset(): void {
    this.rows.clear();
    this.list.replaceChildren();
    this.setPartial([]);
    this.pinned = true;
    document.body.classList.remove("scrolled");
  }

  /** Redraws the lines the fold's change feed named (or every line). Returns how many were new. */
  update(ch: { all: boolean; ids: readonly string[] }, animate: boolean): number {
    const v = this.d.view();
    if (!v) return 0;
    const ids = ch.all
      ? new Set([...this.rows.keys(), ...v.lines("best").map((l) => l.id)])
      : new Set(ch.ids);
    let added = 0;
    for (const id of ids) {
      const line = v.visibleIn(id, "best") ? v.resolve(id) : null;
      const row = this.rows.get(id);
      if (!line) {
        row?.remove();
        this.rows.delete(id);
        continue;
      }
      if (row) this.fill(row, line, v);
      else {
        const r = rowElement();
        this.fill(r, line, v);
        r.dataset.w0 = String(line.w0);
        r.dataset.ch = line.ch;
        r.dataset.seq = String(line.seq);
        this.insert(r);
        this.rows.set(id, r);
        added++;
        if (animate) {
          r.classList.add("new");
          setTimeout(() => r.classList.remove("new"), NEW_FOR_MS);
        }
      }
    }
    this.relabel();
    if (added > 0 && this.partialBox.childElementCount > 0) {
      // A committed line closes the provisional one it covers.
      const drop = [...this.partialBox.children].filter((p) =>
        [...ids].some((id) => this.rows.get(id)?.dataset.ch === (p as HTMLElement).dataset.ch),
      );
      for (const p of drop) p.remove();
      this.partialBox.hidden = this.partialBox.childElementCount === 0;
    }
    if (this.pinned) this.scroller.scrollTop = this.scroller.scrollHeight;
    return added;
  }

  private fill(row: HTMLElement, l: Line, v: CallView): void {
    const tz = v.call?.tz ?? "UTC";
    const first = v.parts()[0]?.wallStart ?? l.w0;
    fillRow(
      row,
      {
        id: l.id,
        time: formatWall(l.w0, tz),
        timeTitle: `${formatDuration((l.w0 - first) / 1000)} into the call`,
        spk: l.spk,
        speaker: l.speaker,
        text: l.text,
        heard: l.heard,
        ch: l.ch,
      },
      this.d.hue(l.spk),
    );
    row.classList.toggle("edited", l.by !== undefined);
    if (!row.querySelector(".tools")) {
      const body = row.children[1] as HTMLElement;
      body.append(
        h(
          "span",
          { class: "tools" },
          h(
            "button",
            { class: "play", type: "button", attrs: { "aria-label": "Play from this line" } },
            "▶",
          ),
          h(
            "button",
            { class: "fix", type: "button", attrs: { "aria-label": "Fix a word in this line" } },
            "Fix",
          ),
        ),
      );
    }
  }

  /** Inserts a row in the one sort order; new lines almost always go last. */
  private insert(r: HTMLElement): void {
    const k = key(r);
    let at = this.list.lastElementChild as HTMLElement | null;
    while (at && before(k, key(at))) at = at.previousElementSibling as HTMLElement | null;
    if (at) at.after(r);
    else this.list.prepend(r);
  }

  /** The chip shows on every change of speaker. */
  private relabel(): void {
    let prev: string | undefined;
    for (const el of this.list.children as unknown as Iterable<HTMLElement>) {
      const spk = el.dataset.spk;
      el.classList.toggle("turn", spk !== prev);
      prev = spk;
    }
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const row = t.closest(".row") as HTMLElement | null;
    const id = row?.dataset.id;
    if (!row || !id) return;
    if (t.closest(".who"))
      this.d.speakerMenu(row.dataset.spk ?? "", t.closest(".who") as HTMLElement);
    else if (t.closest(".play")) this.d.play(id);
    else if (t.closest(".fix")) {
      const sel = getSelection()?.toString().trim() ?? "";
      this.d.fixWord(id, t.closest(".fix") as HTMLElement, sel.length <= 60 ? sel : "");
    }
  }

  /** The grey line still being spoken; it expires 3 s after its last update. */
  setPartial(lines: readonly PartialLine[]): void {
    const v = this.d.view();
    const box = this.partialBox;
    if (!v || lines.length === 0) {
      box.replaceChildren();
      box.hidden = true;
      return;
    }
    replace(
      box,
      ...lines.map((p) => {
        const spk = p.ch === "mic" ? "you" : (p.spk ?? "c?");
        const r = rowElement();
        r.classList.add("draft", "turn");
        fillRow(
          r,
          {
            id: `draft-${p.ch}`,
            time: p.time,
            spk,
            speaker: v.speakerLabel(spk),
            text: p.text,
            ch: p.ch,
          },
          this.d.hue(spk),
        );
        r.dataset.ch = p.ch;
        r.setAttribute("aria-label", "still being spoken, may change");
        return r;
      }),
    );
    box.hidden = false;
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = setTimeout(() => this.setPartial([]), PROVISIONAL_TTL_MS);
    if (this.pinned) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  /** Scrolls to a line and marks it for a moment (a citation, a note's time). */
  scrollTo(id: string): boolean {
    const row = this.rows.get(id);
    if (!row) return false;
    this.pinned = false;
    document.body.classList.add("scrolled");
    row.scrollIntoView({ block: "center" });
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
    return true;
  }

  /** The first line at or after a wall time (a note's gutter). */
  lineAt(w: number): string | null {
    const v = this.d.view();
    if (!v) return null;
    const lines = v.lines("best");
    const at = lines.find((l) => l.w1 >= w) ?? lines.at(-1);
    return at?.id ?? null;
  }
}
