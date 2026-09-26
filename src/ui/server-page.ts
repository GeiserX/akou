/**
 * The page of server mode (docs/ux/SERVER.md section 12.4, SV-U7): after the admin login it shows
 * the server's own screens, not the call window. It opens on Jobs, with Models, Keys and Settings
 * beside it, each over routes a script can call too. The call window's markup is taken off the
 * page, so no recording control is there to press.
 *
 * Same bundle, same transport and same session as the window: `web.ts` boots this instead of the
 * window when `GET /v1/server` says `mode: "server"`.
 */

import { h, replace } from "./dom.ts";
import type { Transport } from "./protocol.ts";
import { PAGES, type PageName, type ServerScreen } from "./server-common.ts";
import { JobsPage } from "./server-jobs.ts";
import { KeysPage } from "./server-keys.ts";
import { ModelsPage, SettingsPage } from "./server-settings.ts";

/** What stays of the window's page: the fatal notice, the login form and the toast. */
const KEEP = new Set(["fatal", "login", "toast"]);

export function bootServer(t: Transport, logout: () => void): void {
  for (const el of [...document.body.children]) if (!KEEP.has(el.id)) el.remove();
  document.body.classList.add("server");
  document.title = "akou server";

  const main = h("main", { id: "server-main" });
  const screens: ServerScreen[] = [
    new JobsPage(t),
    new ModelsPage(t),
    new KeysPage(t),
    new SettingsPage(t),
  ];
  const nav = h("nav", { id: "server-nav", attrs: { "aria-label": "Server pages" } });
  const version = h("span", { id: "server-version", class: "hint" });
  const bar = h(
    "div",
    { id: "server-bar" },
    h("strong", {}, "akou"),
    version,
    nav,
    h("button", { id: "server-logout", type: "button", on: { click: logout } }, "Log out"),
  );
  for (const s of screens) {
    s.root.id = `page-${s.name}`;
    s.root.hidden = true;
    main.append(s.root);
    nav.append(
      h(
        "button",
        {
          type: "button",
          attrs: { "data-page": s.name },
          on: { click: () => go(s.name) },
        },
        s.title,
      ),
    );
  }
  const shell = h("div", { id: "server" }, bar, main);
  document.body.prepend(shell);

  let current: ServerScreen | null = null;
  function go(name: PageName): void {
    const next = screens.find((s) => s.name === name) ?? (screens[0] as ServerScreen);
    if (current === next) return;
    current?.hide();
    if (current) current.root.hidden = true;
    current = next;
    next.root.hidden = false;
    for (const b of nav.querySelectorAll<HTMLElement>("button")) {
      if (b.dataset.page === next.name) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    }
    if (location.hash !== `#${next.name}`) history.replaceState(null, "", `#${next.name}`);
    next.show();
  }

  const asked = location.hash.slice(1);
  go((PAGES as readonly string[]).includes(asked) ? (asked as PageName) : "jobs");
  void t.request<{ version?: string }>("GET", "/server").then((r) => {
    if (r.status === 200 && r.body.version) replace(version, `version ${r.body.version}`);
  });
}
