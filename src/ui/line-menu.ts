/**
 * The line menu (docs/ux/WINDOW.md W4.4): right-click on a transcript line, or `Shift+F10` or the
 * Menu key while focus is on a line, opens one menu of that line's actions. Each item runs the
 * action it names from the list the window hands in, the same code a line's own buttons run.
 *
 * It is a WAI-ARIA menu: focus moves to the first item, `↑` `↓` `Home` `End` move between items,
 * `Enter` or `Space` runs one, `Esc` or `Tab` closes it, and focus goes back to where it was.
 * It stays beside its line: a scroll of the transcript (new lines, the reader) moves it with the
 * line, and it closes once the line leaves the view, the window loses focus or is resized.
 *
 * The sidebar's call rows open the same menu on their own element (W13.2, W13.3): `o` names the
 * menu, what a row is and the control focus goes back to.
 */

import { byId, h, replace } from "./dom.ts";

export interface LineAction {
  id: string;
  label: string;
  /** Shown but not runnable, with this reason under its label. */
  disabled?: string;
  /** A line above it sets it apart; `danger` marks what removes something. */
  separated?: boolean;
  danger?: boolean;
  /** Runs on a line; `anchor` is where a follow-up popover should open. */
  run(lineId: string, anchor: HTMLElement): void;
}

export interface MenuPlace {
  /** The menu's element id. */
  menu: string;
  /** What a row is, carrying its id in `data-id`. */
  row: string;
  /** The control in a row focus goes back to when the menu was not opened from inside it. */
  from: string;
}

const LINES: MenuPlace = { menu: "line-menu", row: ".row", from: ".play" };

export class LineMenu {
  private readonly menu: HTMLElement;
  private from: HTMLElement | null = null;
  /** The line the open menu acts on, and the menu's distance below the line's top. */
  private at: { row: HTMLElement; dy: number } | null = null;
  /** Where the pointer last opened the menu, for `reopen`. */
  private lastAt: { x: number; y: number } | null = null;

  constructor(
    private readonly list: HTMLElement,
    private readonly scroller: HTMLElement,
    private readonly actions: (id: string) => readonly LineAction[],
    private readonly o: MenuPlace = LINES,
  ) {
    this.menu = byId(o.menu);
    list.addEventListener("contextmenu", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(o.row);
      if (!row?.dataset.id) return;
      e.preventDefault();
      // A contextmenu from the keyboard has no pointer position: open at the focused control.
      const keyboard = e.clientX === 0 && e.clientY === 0;
      this.open(row, keyboard ? null : { x: e.clientX, y: e.clientY });
    });
    document.addEventListener("keydown", (e) => {
      const key = (e.key === "F10" && e.shiftKey) || e.key === "ContextMenu";
      if (!key || e.metaKey || e.ctrlKey || e.altKey) return;
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(o.row);
      if (!row?.dataset.id || !list.contains(row)) return;
      e.preventDefault();
      this.open(row, null);
    });
    this.menu.addEventListener("keydown", (e) => this.onKey(e));
    // A contextmenu the platform sends on the menu itself (WebView2 on the Menu key's release)
    // must not open the webview's own menu over ours.
    this.menu.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("mousedown", (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.close(false);
    });
    scroller.addEventListener("scroll", () => this.follow());
    // Focus in a hidden menu would be lost, so these give it back to the line.
    addEventListener("blur", () => this.close(true));
    addEventListener("resize", () => this.close(true));
  }

  /** Moves the open menu with its line, or closes it once the line is out of the view. */
  private follow(): void {
    const at = this.at;
    if (this.menu.hidden || !at) return;
    const r = at.row.getBoundingClientRect();
    const s = this.scroller.getBoundingClientRect();
    if (!at.row.isConnected || r.bottom <= s.top || r.top >= s.bottom) {
      this.close(true);
      return;
    }
    this.menu.style.top = `${r.top + at.dy}px`;
  }

  /**
   * Opens the menu again on a row, where it was last opened, with other items: a step like "Move
   * to workspace…" lists its choices in the same place.
   */
  reopen(id: string, actions: readonly LineAction[]): void {
    // The list may have been drawn again meanwhile: the row is found again by its id.
    const row = [...this.list.querySelectorAll<HTMLElement>(this.o.row)].find(
      (r) => r.dataset.id === id,
    );
    if (row) this.open(row, this.lastAt, actions);
  }

  private open(
    row: HTMLElement,
    at: { x: number; y: number } | null,
    actions?: readonly LineAction[],
  ): void {
    const id = row.dataset.id as string;
    const active = document.activeElement as HTMLElement | null;
    // Focus goes back to the control the reader was on, or the row's own control.
    this.from =
      active && row.contains(active) ? active : row.querySelector<HTMLElement>(this.o.from);
    this.lastAt = at;
    replace(
      this.menu,
      ...(actions ?? this.actions(id)).flatMap((a) => [
        a.separated ? h("div", { role: "separator" }) : null,
        h(
          "button",
          {
            type: "button",
            role: "menuitem",
            tabIndex: -1,
            class: a.danger ? "danger" : undefined,
            attrs: {
              "data-action": a.id,
              ...(a.disabled ? { "aria-disabled": "true" } : {}),
            },
            on: {
              click: () => {
                // A disabled item stays focusable, so its reason can be read, and does nothing.
                if (a.disabled) return;
                const anchor = this.from ?? row;
                this.close(true);
                a.run(id, anchor);
              },
            },
          },
          h("span", { class: "label" }, a.label),
          a.disabled ? h("span", { class: "why" }, a.disabled) : null,
        ),
      ]),
    );
    this.menu.hidden = false;
    const r = (this.from ?? row).getBoundingClientRect();
    const x = at?.x ?? r.left;
    const y = at?.y ?? r.bottom;
    const box = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(innerWidth - box.width - 8, x))}px`;
    const top = Math.max(8, Math.min(innerHeight - box.height - 8, y));
    this.menu.style.top = `${top}px`;
    this.at = { row, dy: top - row.getBoundingClientRect().top };
    this.items()[0]?.focus();
  }

  private items(): HTMLElement[] {
    return [...this.menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  }

  private close(restore: boolean): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    // Never scrolled to: the line may have just left the view.
    if (restore) this.from?.focus({ preventScroll: true });
    this.from = null;
    this.at = null;
  }

  private onKey(e: KeyboardEvent): void {
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    }
  }
}
