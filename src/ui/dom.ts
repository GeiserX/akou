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

/**
 * A short message at the top of the window; errors in red. An `action` (a fix's Undo) is a button
 * after the text, and keeps the message up a little longer.
 */
export function toast(
  message: string,
  kind: "error" | "info" = "error",
  action?: { label: string; run: () => void },
): void {
  const el = byId("toast");
  el.textContent = message;
  el.className = kind;
  el.hidden = false;
  const hide = () => {
    el.hidden = true;
  };
  if (action) {
    el.append(
      " ",
      h(
        "button",
        {
          type: "button",
          class: "toast-action",
          on: {
            click: () => {
              clearTimeout(toastTimer);
              hide();
              action.run();
            },
          },
        },
        action.label,
      ),
    );
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, action ? 10_000 : 6000);
}

/** The × of a dialog's title row (WINDOW W15.8), for a dialog built in code. */
export function closeX(): HTMLButtonElement {
  return h(
    "button",
    {
      type: "button",
      class: "icon dialog-x",
      title: "Close (Esc)",
      attrs: { "aria-label": "Close" },
    },
    "×",
  );
}

/** What opened each open dialog, given the focus back when it closes. */
const openers = new WeakMap<HTMLDialogElement, Element | null>();

/**
 * The control the user last pressed or moved the focus to. WebKit gives a clicked button no
 * focus, so `document.activeElement` alone does not say which button opened a dialog; it focuses
 * the dialog around the button instead, which leaves the button as the control.
 */
let lastControl: Element | null = null;
let tracking = false;
function trackControls(): void {
  if (tracking) return;
  tracking = true;
  const control = "button, a[href], input, select, textarea, summary, [tabindex]";
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastControl = (e.target as Element | null)?.closest?.(control) ?? null;
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (e) => {
      const to = e.target as Element;
      if (lastControl && to !== lastControl && to.contains(lastControl)) return;
      lastControl = to;
    },
    true,
  );
}

/**
 * A modal dialog closes the way a window does (WINDOW W15.8): by its × (`.dialog-x`), by Escape,
 * which `showModal` gives it, and by a click on the backdrop, pressed and released there so a text
 * selection dragged out of a field closes nothing. Closed, it gives the focus back to what opened
 * it through `openModal`: WebKit and WebView2 do not all do it themselves. While `keep` answers
 * true the dialog holds an edit a stray click must not drop, and the backdrop does nothing; the ×
 * and Escape still close it, as its Close button does.
 */
export function closable(dialog: HTMLDialogElement, keep: () => boolean = () => false): void {
  trackControls();
  dialog.querySelector(".dialog-x")?.addEventListener("click", () => dialog.close());
  const outside = (e: MouseEvent) => {
    if (e.target !== dialog) return false;
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressed = false;
  dialog.addEventListener("pointerdown", (e) => {
    pressed = outside(e);
  });
  dialog.addEventListener("click", (e) => {
    if (pressed && outside(e) && !keep()) dialog.close();
    pressed = false;
  });
  dialog.addEventListener("close", () => {
    const opener = openers.get(dialog);
    openers.delete(dialog);
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  });
}

/** Opens a `closable` dialog as a modal, remembering the control that opened it. */
export function openModal(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  const last = lastControl?.isConnected ? lastControl : null;
  openers.set(dialog, last ?? document.activeElement);
  dialog.showModal();
}
