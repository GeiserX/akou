/**
 * The sidebar's call menu (docs/ux/WINDOW.md W13.2, W13.3) on the real page: a right-click or the
 * keyboard on a call row opens akou's own menu, never the webview's text menu, and the sidebar
 * selects no text. Rename opens the call's title field (W3.16), Move to workspace moves its folder,
 * Move to Trash takes it out of the list with Undo, and a recording call cannot be trashed.
 *
 * Run with `bun run test:ui`.
 */

import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import type { LogBuilder } from "../helpers.ts";
import { tempDir } from "../helpers.ts";
import { seedCall, T0, UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

const A = "01J8Z6Q4M2VX0K7B3D4EMENUAA";
const B = "01J8Z6Q4M2VX0K7B3D4EMENUBB";
const C = "01J8Z6Q4M2VX0K7B3D4EMENUCC";

/** A short finished call, `hours` after T0, so the list's order is fixed. */
function call(id: string, title: string, hours: number, workspace = "work") {
  return (b: LogBuilder) => {
    const at = T0 + hours * 3_600_000;
    b.created({ id, title, workspace }, at);
    b.partStarted(1, at);
    b.seg({ id: "l000001", ch: "call", w0: at + 1000, text: `the ${title} line` });
    b.partEnded(1, "stop");
    b.add({ type: "call.ended", reason: "stop" });
  };
}

/** Three calls: two in work (Alpha, then Beta, the newest), one in hiring. */
function seedThree(home: string): void {
  seedCall(home, call(A, "Alpha review", 0));
  seedCall(home, call(B, "Beta planning", 1));
  seedCall(home, call(C, "Gamma intro", 2, "hiring"));
}

async function withRig<T>(
  o: Parameters<typeof uiRig>[0] & { seed?: (home: string) => void; shots?: string },
  fn: (rig: UiRig) => Promise<T>,
): Promise<T> {
  const t = tempDir("akou-ui-menu-");
  o.seed?.(t.dir);
  const rig = await uiRig({ ...o, home: t.dir });
  rig.shots = o.shots;
  try {
    return await fn(rig);
  } finally {
    await rig.close();
    t.cleanup();
  }
}

const row = (id: string) => `#calls li[data-id="${id}"]`;

function menu(page: Page) {
  return page.evaluate(() => {
    const m = document.getElementById("calls-menu") as HTMLElement;
    const items = [...m.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    return {
      open: !m.hidden,
      items: items.map((b) => b.querySelector(".label")?.textContent ?? ""),
      disabled: items
        .filter((b) => b.getAttribute("aria-disabled") === "true")
        .map(
          (b) =>
            `${b.querySelector(".label")?.textContent}: ${b.querySelector(".why")?.textContent}`,
        ),
      focused:
        document.activeElement?.getAttribute("role") === "menuitem"
          ? (document.activeElement.querySelector(".label")?.textContent ?? null)
          : null,
    };
  });
}

/** Every contextmenu the page saw, and whether something on the page kept the webview's own. */
async function watchContextMenus(page: Page): Promise<() => Promise<boolean[]>> {
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { __ctx: boolean[] }).__ctx = seen;
    // On window, bubbling: it runs after every handler of the page.
    addEventListener("contextmenu", (e) => seen.push(e.defaultPrevented));
  });
  return () => page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx.splice(0));
}

const selected = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? "");

async function listed(rig: UiRig): Promise<string[]> {
  const r = await rig.api("GET", "/calls?limit=50");
  return (r.body.calls as { id: string }[]).map((c) => c.id);
}

const ITEMS = ["Rename…", "Move to workspace…", "Move to Trash"];

describe("[W13.3] a call row has akou's own menu, never the webview's", () => {
  test(
    "right-click on a row opens the call menu and selects nothing; the sidebar never shows the native menu, the search field keeps it",
    async () => {
      await withRig({ seed: seedThree, shots: "call-menu" }, async (rig) => {
        const page = await rig.open(A);
        await page.waitForSelector("#calls li >> nth=2");
        const prevented = await watchContextMenus(page);

        await page.click(`${row(B)} .what`, { button: "right" });
        expect(await menu(page)).toMatchObject({ open: true, items: ITEMS, focused: "Rename…" });
        expect(await prevented()).toEqual([true]);
        expect(await selected(page)).toBe("");
        expect(await page.getAttribute("#calls-menu", "role")).toBe("menu");
        // A click elsewhere closes it and runs nothing.
        await page.click("#scroller", { position: { x: 5, y: 5 } });
        expect((await menu(page)).open).toBe(false);
        expect(await listed(rig)).toContain(B);

        // A workspace header has no menu, and still no native one.
        await page.click('#calls .ws-head[data-ws="work"]', { button: "right" });
        expect((await menu(page)).open).toBe(false);
        expect(await prevented()).toEqual([true]);

        // Positive control: the search field keeps the webview's menu, to paste and correct.
        await page.click("#calls-search", { button: "right" });
        expect(await prevented()).toEqual([false]);
        expect((await menu(page)).open).toBe(false);

        // Left open for the review screenshot (TS-15c).
        await page.click(`${row(A)} .what`, { button: "right" });
        expect((await menu(page)).open).toBe(true);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "the rows and headers select no text, the search field and the transcript do",
    async () => {
      await withRig({ seed: seedThree }, async (rig) => {
        const page = await rig.open(A);
        await page.waitForSelector("#calls li >> nth=2");
        await page.waitForSelector("#lines .row");
        const selectable = () =>
          page.evaluate(() => {
            const us = (sel: string) => {
              const el = document.querySelector(sel) as HTMLElement;
              const cs = getComputedStyle(el);
              return cs.userSelect || cs.getPropertyValue("-webkit-user-select");
            };
            return {
              row: us("#calls li .what"),
              head: us("#calls .ws-head"),
              search: us("#calls-search"),
              line: us("#lines .row .text"),
            };
          });
        const s = await selectable();
        expect(s.row).toBe("none");
        expect(s.head).toBe("none");
        expect(s.search).not.toBe("none");
        expect(s.line).not.toBe("none");
        // Positive control: with the rule taken off a row, the same probe reads it as selectable.
        // (The page's CSP refuses a style tag; a style set from script is allowed.)
        await page.evaluate(() => {
          const el = document.querySelector("#calls li .what") as HTMLElement;
          el.style.setProperty("user-select", "text");
          el.style.setProperty("-webkit-user-select", "text");
        });
        expect((await selectable()).row).not.toBe("none");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Shift+F10 and the Menu key open it on the focused row; arrows move, Esc closes and gives focus back",
    async () => {
      await withRig({ seed: seedThree }, async (rig) => {
        const page = await rig.open(A);
        await page.waitForSelector("#calls li >> nth=2");
        const focusedRow = () =>
          page.evaluate(
            () =>
              (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("li")?.dataset
                .id ?? null,
          );
        // Positive control: the keys do nothing on a control outside the rows.
        await page.focus("#calls-search");
        await page.keyboard.press("Shift+F10");
        expect((await menu(page)).open).toBe(false);

        await page.focus(`${row(B)} button`);
        await page.keyboard.press("Shift+F10");
        expect(await menu(page)).toMatchObject({ open: true, items: ITEMS, focused: "Rename…" });
        await page.keyboard.press("ArrowDown");
        expect((await menu(page)).focused).toBe("Move to workspace…");
        await page.keyboard.press("End");
        expect((await menu(page)).focused).toBe("Move to Trash");
        await page.keyboard.press("ArrowDown");
        expect((await menu(page)).focused).toBe("Rename…");
        await page.keyboard.press("Escape");
        expect((await menu(page)).open).toBe(false);
        expect(await focusedRow()).toBe(B);

        await page.keyboard.press("ContextMenu");
        expect((await menu(page)).open).toBe(true);
        await page.keyboard.press("Escape");
        expect(await focusedRow()).toBe(B);
      });
    },
    UI_TIMEOUT,
  );
});

describe("[W13.3] Move to Trash, with Undo", () => {
  test(
    "the row leaves at once, the window moves to the call beside it, and Undo brings it back as it was",
    async () => {
      await withRig({ seed: seedThree }, async (rig) => {
        const page = await rig.open(B);
        await page.waitForSelector("#calls li >> nth=2");
        await until(
          async () => (await page.textContent("#title-text")) === "Beta planning",
          5000,
          "Beta open",
        );
        // Positive control: the API lists the call before, so its absence after means something.
        expect(await listed(rig)).toContain(B);

        await page.click(`${row(B)} .what`, { button: "right" });
        await page.click('#calls-menu [data-action="call.trash"]');
        expect(await page.locator(row(B)).count()).toBe(0);
        await page.waitForSelector("#toast:not([hidden]) .toast-action");
        expect(await page.textContent("#toast")).toContain("“Beta planning” moved to the Trash.");
        await until(async () => !(await listed(rig)).includes(B), 5000, "B trashed");
        // The call beside it in the list is on screen now.
        await until(
          async () => (await page.textContent("#title-text")) === "Alpha review",
          5000,
          "Alpha open",
        );
        expect(new URL(page.url()).searchParams.get("call")).toBe(A);
        // A status push or a list read later does not bring it back.
        await Bun.sleep(1500);
        expect(await page.locator(row(B)).count()).toBe(0);

        await page.click("#toast .toast-action");
        await page.waitForSelector(row(B));
        expect(await listed(rig)).toContain(B);
        await until(
          async () => (await page.textContent("#title-text")) === "Beta planning",
          5000,
          "Beta back",
        );
        const lines = await page.locator("#lines .row").allTextContents();
        expect(lines.join(" ")).toContain("the Beta planning line");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "trashing the only call on screen leaves no call open",
    async () => {
      await withRig({ seed: (home) => seedCall(home, call(A, "Alpha review", 0)) }, async (rig) => {
        const page = await rig.open(A);
        await until(
          async () => (await page.textContent("#title-text")) === "Alpha review",
          5000,
          "Alpha open",
        );
        expect(await page.isVisible("#call-head")).toBe(true);
        await page.click(`${row(A)} .what`, { button: "right" });
        await page.click('#calls-menu [data-action="call.trash"]');
        await until(async () => !(await page.isVisible("#call-head")), 5000, "no call open");
        expect(await page.locator("#calls li").count()).toBe(0);
        expect(await page.locator("#lines .row").count()).toBe(0);
        expect(new URL(page.url()).searchParams.get("call")).toBeNull();
        // The status push still names it as the last call; the window does not open it again.
        await Bun.sleep(1500);
        expect(await page.isVisible("#call-head")).toBe(false);
        await until(async () => (await listed(rig)).length === 0, 5000, "trashed");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a recording call keeps Move to Trash in its menu, greyed with the reason, and clicking it does nothing",
    async () => {
      await withRig({ seed: (home) => seedCall(home, call(A, "Alpha review", 0)) }, async (rig) => {
        const live = await rig.startCall({ title: "Live sync" });
        const page = await rig.open(live);
        await page.waitForSelector(`${row(live)}.live`);
        await page.waitForSelector(row(A));

        await page.click(`${row(live)} .what`, { button: "right" });
        const m = await menu(page);
        expect(m.items).toEqual(ITEMS);
        expect(m.disabled).toEqual([
          "Move to workspace…: Stop the recording to move it.",
          "Move to Trash: Stop the recording to move it to the Trash.",
        ]);
        // Playwright counts aria-disabled as disabled, so the click is forced, as a person's is.
        await page.click('#calls-menu [data-action="call.trash"]', { force: true });
        expect((await menu(page)).open).toBe(true);
        // Enter on it, from the keyboard, does nothing either.
        await page.keyboard.press("End");
        expect((await menu(page)).focused).toBe("Move to Trash");
        await page.keyboard.press("Enter");
        expect((await menu(page)).open).toBe(true);
        await Bun.sleep(500);
        expect(await page.locator(row(live)).count()).toBe(1);
        expect((await rig.api("GET", `/calls/${live}`)).body.state).toBe("recording");
        await page.keyboard.press("Escape");

        // Positive control: a finished call's Move to Trash is enabled.
        await page.click(`${row(A)} .what`, { button: "right" });
        expect((await menu(page)).disabled).toEqual([
          "Move to workspace…: There is no other workspace yet.",
        ]);
        await page.keyboard.press("Escape");
        await rig.api("POST", `/calls/${live}/stop`);
      });
    },
    UI_TIMEOUT,
  );
});

describe("[W13.2] Rename and Move to workspace from a call row", () => {
  test(
    "Rename… opens that call with its title field; Enter saves the new name",
    async () => {
      await withRig({ seed: seedThree }, async (rig) => {
        const page = await rig.open(A);
        await page.waitForSelector("#calls li >> nth=2");
        // Positive control: the call starts with its old name.
        expect((await rig.api("GET", `/calls/${B}`)).body.title).toBe("Beta planning");
        await page.click(`${row(B)} .what`, { button: "right" });
        await page.click('#calls-menu [data-action="call.rename"]');
        await page.waitForSelector("#title-input");
        expect(await page.inputValue("#title-input")).toBe("Beta planning");
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("title-input");
        await page.fill("#title-input", "Beta kickoff");
        await page.keyboard.press("Enter");
        await until(
          async () => (await rig.api("GET", `/calls/${B}`)).body.title === "Beta kickoff",
          5000,
          "renamed",
        );
        await until(
          async () => (await page.textContent(`${row(B)} .what`)) === "Beta kickoff",
          5000,
          "row renamed",
        );
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Move to workspace… lists the other workspaces, and picking one moves the call there",
    async () => {
      await withRig({ seed: seedThree }, async (rig) => {
        const page = await rig.open(A);
        await page.waitForSelector("#calls li >> nth=2");
        expect((await rig.api("GET", `/calls/${B}`)).body.workspace).toBe("work");
        await page.click(`${row(B)} .what`, { button: "right" });
        await page.click('#calls-menu [data-action="call.move"]');
        // The same menu, now the workspaces other than the call's own.
        expect(await menu(page)).toMatchObject({
          open: true,
          items: ["hiring"],
          focused: "hiring",
        });
        await page.keyboard.press("Enter");
        await until(
          async () => (await rig.api("GET", `/calls/${B}`)).body.workspace === "hiring",
          5000,
          "moved",
        );
        await page.waitForSelector(`#calls .ws-group[data-workspace="hiring"] li[data-id="${B}"]`);
      });
    },
    UI_TIMEOUT,
  );
});
