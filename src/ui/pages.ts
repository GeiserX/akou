/**
 * The window's pages (docs/ux/design-explorations/README.md, direction A): the sidebar's
 * destinations that are not the calls. A page takes the place of the call workspace (the composer
 * row, the notices, the transcript and the side pane) beside the sidebar, and the sidebar marks it.
 * The way back is the sidebar: Calls, or any call in its list. Leaving lets the page save what is
 * still typed into it.
 */

import { byId } from "./dom.ts";

export interface WindowPage {
  readonly root: HTMLElement;
  /** Shown; `arg` names what to go to on it (a setting's key). */
  show(arg?: string): Promise<void> | void;
  /** Hidden: save what is typed, stop what listens. */
  leave(): void;
}

export class Pages {
  private current: string | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly pages: Readonly<Record<string, WindowPage>>,
  ) {
    for (const p of Object.values(pages)) {
      p.root.hidden = true;
      host.append(p.root);
    }
    this.mark();
  }

  /** The page on screen, or null for the calls. */
  get open(): string | null {
    return this.current;
  }

  async show(name: string, arg?: string): Promise<void> {
    const page = this.pages[name];
    if (!page) return;
    if (this.current && this.current !== name) this.hide(this.current);
    this.current = name;
    page.root.hidden = false;
    this.host.hidden = false;
    document.body.classList.add("paged");
    document.body.dataset.page = name;
    this.mark();
    await page.show(arg);
  }

  /** Back to the calls. */
  leave(): void {
    if (!this.current) return;
    this.hide(this.current);
    this.current = null;
    this.host.hidden = true;
    document.body.classList.remove("paged");
    delete document.body.dataset.page;
    this.mark();
  }

  private hide(name: string): void {
    const page = this.pages[name];
    if (!page) return;
    page.leave();
    page.root.hidden = true;
  }

  /** The sidebar marks where the window is: Calls, or the page's own row. */
  private mark(): void {
    const calls = byId("calls-open");
    const on = (el: HTMLElement, yes: boolean) => {
      el.classList.toggle("on", yes);
      if (yes) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    };
    on(calls, this.current === null);
    for (const el of document.querySelectorAll<HTMLElement>("#sidebar [data-page]"))
      on(el, el.dataset.page === this.current);
  }
}
