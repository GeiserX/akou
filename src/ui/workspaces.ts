/**
 * The workspace a new call goes in (WINDOW section 3.1). In the Record row it is a menu button,
 * the name and a chevron: a click lists every workspace with a check on the chosen one, and
 * "New workspace…" turns into a name field in place (Enter creates, Escape cancels). The sidebar's
 * "New workspace" opens the same field under the groups.
 *
 * Which one is chosen: the one the user picked since the call on screen changed, else the
 * workspace of the call on screen, else the last one used (kept in the page's storage), else
 * "default". Creating one makes its folder through `POST /workspaces`, so an empty workspace is
 * still there after a restart; the list is `GET /workspaces` with the calls' own workspaces.
 */

import { byId, h, replace, toast } from "./dom.ts";
import { defaultWorkspace, workspaceNameProblem, workspaceNames } from "./model.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";

/** Where the last workspace used is kept between runs. */
export const LAST_WORKSPACE_KEY = "akou.workspace";

export interface WorkspaceDeps {
  t: Transport;
  /** The workspaces of the calls the sidebar lists. */
  fromCalls(): readonly string[];
  /** The list changed: the sidebar redraws its groups. */
  changed(): void;
}

function icon(d: string, cls = "ico"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

const CHECK = "m3.5 8.5 3 3 6-7";
const PLUS = "M8 3.5v9M3.5 8h9";

export class WorkspacePicker {
  private readonly button = byId<HTMLButtonElement>("workspace");
  private readonly label = byId("workspace-name");
  private readonly menuBox = byId("workspace-menu");
  private readonly sideNew = byId<HTMLButtonElement>("workspace-new");
  /** The folders `GET /workspaces` listed. */
  private known: string[] = [];
  /** The user's pick since the call on screen last changed. */
  private picked: string | null = null;
  /** The call on screen and its workspace, as the page last drew them. */
  private onScreen: { call: string | null; workspace: string | undefined } = {
    call: null,
    workspace: undefined,
  };

  constructor(private readonly d: WorkspaceDeps) {
    this.button.addEventListener("click", () => this.menu(this.menuBox.hasAttribute("hidden")));
    this.button.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" || !this.menuBox.hidden) return;
      e.preventDefault();
      this.menu(true);
    });
    this.menuBox.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        // Escape in the name field goes back to the list; on the list it closes the menu.
        if (this.menuBox.querySelector("input")) this.drawMenu("New workspace…");
        else {
          this.menu(false);
          this.button.focus();
        }
        return;
      }
      const items = [...this.menuBox.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (step && items.length > 0 && at >= 0) {
        e.preventDefault();
        items[(at + step + items.length) % items.length]?.focus();
      }
    });
    document.addEventListener("pointerdown", (e) => {
      const inside =
        this.menuBox.contains(e.target as Node) || this.button.contains(e.target as Node);
      if (!this.menuBox.hidden && !inside) this.menu(false);
    });
    this.sideNew.addEventListener("click", () => this.sideField());
  }

  /** The workspace the next call goes in. */
  value(): string {
    const last = (() => {
      try {
        return localStorage.getItem(LAST_WORKSPACE_KEY);
      } catch {
        return null;
      }
    })();
    if (this.picked !== null) return this.picked;
    return defaultWorkspace(this.onScreen.workspace, last);
  }

  /** Every workspace: the folders, the calls' own, and the chosen one. */
  names(): string[] {
    return workspaceNames([...this.known, ...this.d.fromCalls()], this.value());
  }

  /** The workspaces with no call yet that the sidebar still shows as groups. */
  folders(): readonly string[] {
    return this.known;
  }

  /** The call on screen, drawn each paint: a new call brings its own workspace to the chip. */
  follow(call: string | null, workspace: string | undefined): void {
    // A pick holds until another call is on screen; that call's workspace takes over then.
    if (call !== this.onScreen.call) this.picked = null;
    this.onScreen = { call, workspace };
    this.paint();
  }

  /** A call started in this workspace: it is the last one used. */
  used(name: string): void {
    this.remember(name);
  }

  async load(): Promise<void> {
    const r = await this.d.t.request<{ workspaces?: { name: string }[] }>("GET", "/workspaces");
    if (r.status >= 400) return;
    const next = (r.body.workspaces ?? []).map((w) => w.name);
    if (next.join("\n") === this.known.join("\n")) return;
    this.known = next;
    this.d.changed();
    if (!this.menuBox.hidden && !this.menuBox.querySelector("input")) this.drawMenu();
  }

  private paint(): void {
    const name = this.value();
    if (this.label.textContent !== name) this.label.textContent = name;
    this.button.title = `New calls go in ${name}. Click to switch or add a workspace.`;
  }

  private remember(name: string): void {
    try {
      localStorage.setItem(LAST_WORKSPACE_KEY, name);
    } catch {
      // A page without storage keeps the choice until it closes.
    }
  }

  private pick(name: string): void {
    this.picked = name;
    this.remember(name);
    this.paint();
  }

  private menu(open: boolean): void {
    this.menuBox.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (!open) return;
    this.drawMenu();
  }

  /** The list, with the focus on the chosen workspace or on `focus` (an item's text). */
  private drawMenu(focus?: string): void {
    const chosen = this.value();
    const items = this.names().map((n) =>
      h(
        "button",
        {
          type: "button",
          role: "menuitemradio",
          class: "ws-item",
          attrs: { "aria-checked": String(n === chosen), "data-ws": n },
          on: {
            click: () => {
              this.pick(n);
              this.menu(false);
              this.button.focus();
            },
          },
        },
        icon(CHECK, "ico check"),
        h("span", { class: "ws-label" }, n),
      ),
    );
    const add = h(
      "button",
      {
        type: "button",
        role: "menuitem",
        class: "ws-item ws-add",
        on: { click: () => this.menuField() },
      },
      icon(PLUS),
      h("span", { class: "ws-label" }, "New workspace…"),
    );
    replace(this.menuBox, ...items, h("hr", { attrs: { "aria-hidden": "true" } }), add);
    const target =
      focus === undefined
        ? this.menuBox.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        : add;
    target?.focus();
  }

  /** "New workspace…" becomes the name field, in the menu. */
  private menuField(): void {
    const add = this.menuBox.querySelector(".ws-add");
    if (!add) return;
    const field = this.nameField({
      done: () => {
        this.menu(false);
        this.button.focus();
      },
      cancel: () => this.drawMenu("New workspace…"),
    });
    add.replaceWith(field);
    field.querySelector("input")?.focus();
  }

  /** The sidebar's "New workspace" becomes the same field, in its place. */
  private sideField(): void {
    const field = this.nameField({
      done: () => {
        field.remove();
        this.sideNew.hidden = false;
      },
      cancel: () => {
        field.remove();
        this.sideNew.hidden = false;
        this.sideNew.focus();
      },
    });
    field.classList.add("side");
    this.sideNew.hidden = true;
    this.sideNew.after(field);
    field.querySelector("input")?.focus();
  }

  /**
   * A name field: Enter creates the workspace and picks it, Escape cancels, and what is wrong with
   * the name shows under it as one plain line. Leaving an empty field cancels it.
   */
  private nameField(o: { done(): void; cancel(): void }): HTMLElement {
    const input = h("input", {
      class: "ws-name-input",
      placeholder: "Workspace name",
      attrs: {
        "aria-label": "New workspace name",
        maxlength: "64",
        autocomplete: "off",
        spellcheck: "false",
      },
    });
    const problem = h("p", { class: "ws-problem", role: "status" });
    const box = h("div", { class: "ws-new" }, icon(PLUS), input, problem);
    let busy = false;
    input.addEventListener("input", () => {
      problem.textContent = "";
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        o.cancel();
        return;
      }
      if (e.key !== "Enter" || busy) return;
      e.preventDefault();
      const name = input.value.trim();
      const bad = workspaceNameProblem(name, this.names());
      if (bad) {
        problem.textContent = bad;
        return;
      }
      busy = true;
      void this.create(name).then((err) => {
        busy = false;
        if (err) problem.textContent = err;
        else o.done();
      });
    });
    input.addEventListener("blur", () => {
      if (!busy && input.value.trim() === "" && box.isConnected) {
        // A click elsewhere with nothing typed puts the button back, and never steals the focus.
        queueMicrotask(() => {
          if (box.isConnected && document.activeElement !== input) {
            if (box.classList.contains("side")) {
              box.remove();
              this.sideNew.hidden = false;
            }
          }
        });
      }
    });
    return box;
  }

  /** Makes the folder, then picks it. Returns what went wrong, or null. */
  private async create(name: string): Promise<string | null> {
    type Made = { workspace?: string; error?: string; message?: string };
    const r = await this.d.t.request<Made>("POST", "/workspaces", { name });
    if (r.status >= 400) {
      const why = message(r.body, `the workspace could not be made (${r.status})`);
      if (r.status >= 500) toast(why);
      return why;
    }
    const made = r.body.workspace ?? name;
    if (!this.known.includes(made)) this.known = [...this.known, made];
    this.pick(made);
    this.d.changed();
    return null;
  }
}
