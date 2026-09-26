/**
 * What the pages of server mode share (`server-page.ts`): the page shape, and the button that
 * asks before it acts. Their words that need no DOM are in `server-text.ts`.
 */

import { append, h } from "./dom.ts";

export interface ServerScreen {
  readonly name: PageName;
  readonly title: string;
  readonly root: HTMLElement;
  /** The page is shown: read what it shows, and start following it. */
  show(): void;
  /** The page is hidden: stop following. */
  hide(): void;
}

export const PAGES = ["jobs", "models", "keys", "settings"] as const;
export type PageName = (typeof PAGES)[number];

/**
 * A button that asks before it acts: the first press changes its label to `confirm`, the second
 * within five seconds runs `act`. `armed` keeps the state across a redraw of the row it is in.
 */
export function twoStep(
  o: { class: string; label: string; confirm: string; id: string; armed: Map<string, number> },
  act: () => void,
): HTMLButtonElement {
  const armedAt = o.armed.get(o.id);
  const live = armedAt !== undefined && Date.now() - armedAt < 5000;
  const b = h("button", { class: o.class, type: "button" }, live ? o.confirm : o.label);
  b.addEventListener("click", () => {
    const at = o.armed.get(o.id);
    if (at !== undefined && Date.now() - at < 5000) {
      o.armed.delete(o.id);
      act();
      return;
    }
    o.armed.set(o.id, Date.now());
    b.textContent = o.confirm;
    setTimeout(() => {
      if (o.armed.get(o.id) === undefined || b.textContent !== o.confirm) return;
      o.armed.delete(o.id);
      b.textContent = o.label;
    }, 5000);
  });
  return b;
}

/** A section with its heading, the shape every page shares. */
export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  const s = h("section", {}, h("h2", {}, title));
  append(s, ...children);
  return s;
}
