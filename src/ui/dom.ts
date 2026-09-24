/**
 * The window's only way to build DOM. Every piece of text from a transcript, a note, an answer or
 * a name goes in as a text node, never as markup: there is no `innerHTML` anywhere in `src/ui`
 * (a test greps for it), so a line that reads `<img src=x onerror=…>` renders as those characters.
 */

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  id?: string;
  title?: string;
  type?: string;
  role?: string;
  hidden?: boolean;
  disabled?: boolean;
  tabIndex?: number;
  value?: string;
  placeholder?: string;
  /** `aria-*` and `data-*` attributes, and any other plain attribute. */
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (e: HTMLElementEventMap[K]) => void }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  if (props.title) el.title = props.title;
  if (props.role) el.setAttribute("role", props.role);
  if (props.hidden) el.hidden = true;
  if (props.tabIndex !== undefined) el.tabIndex = props.tabIndex;
  if (props.type !== undefined) el.setAttribute("type", props.type);
  if (props.disabled && "disabled" in el) (el as HTMLButtonElement).disabled = true;
  if (props.value !== undefined && "value" in el) (el as HTMLInputElement).value = props.value;
  if (props.placeholder !== undefined) el.setAttribute("placeholder", props.placeholder);
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const [k, fn] of Object.entries(props.on ?? {})) {
    el.addEventListener(k, fn as EventListener);
  }
  append(el, ...children);
  return el;
}

/** Appends children; strings become text nodes. */
export function append(el: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? text(String(c)) : c);
  }
}

export function text(s: string): Text {
  return document.createTextNode(s);
}

/** Replaces an element's children. */
export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, ...children);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`the page has no #${id}`);
  return el as T;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A short message at the top of the window; errors in red. */
export function toast(message: string, kind: "error" | "info" = "error"): void {
  const el = byId("toast");
  el.textContent = message;
  el.className = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}
