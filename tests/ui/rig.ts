/**
 * The UI tests' rig: the real headless app (fake capture helper, fake recognizer, a fake provider
 * when a test asks), the window's real page opened through `POST /v1/window` exactly as
 * `akou open` does, in Playwright's headless Chromium shell. Nothing opens on screen, nothing
 * plays through a real output (`--mute-audio`), and no keychain is touched (`--use-mock-keychain`).
 *
 * `AKOU_UI_BROWSER=webkit` runs the same suite in Playwright's WebKit instead, the closest stand-in
 * for the WKWebView and WebKitGTK the app ships on macOS and Linux (docs/TESTING.md TS-14).
 *
 * Run with `bun run test:ui`; `bun run check` leaves these out (bunfig.toml).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page, type Request, webkit } from "playwright-core";
import type { EventDraft, LogEvent } from "../../src/core/log/events.ts";
import type { CompleteRequest, CompleteResult, Provider } from "../../src/main/llm/provider.ts";
import { type AppRig, appRig, type RigOptions } from "../api-helpers.ts";
import { until } from "../capture-helpers.ts";
import { stereoWav } from "../fixtures/audio.ts";
import { LogBuilder, T0, TZ } from "../helpers.ts";

export { until };

export const UI_TIMEOUT = 60_000;

let browser: Browser | null = null;
/** Script errors on any page this rig opened; a test with one fails at close. */
const pageErrors: string[] = [];

/** The engine this run drives: `chromium` unless `AKOU_UI_BROWSER` says `webkit`. */
export const BROWSER: "chromium" | "webkit" = (() => {
  const b = process.env.AKOU_UI_BROWSER ?? "chromium";
  if (b !== "chromium" && b !== "webkit")
    throw new Error(`AKOU_UI_BROWSER is chromium or webkit, not ${b}`);
  return b;
})();

/**
 * The permissions that let a test read what the page copied. WebKit knows `clipboard-read` only
 * and lets a page write without asking; asking it for `clipboard-write` throws "Unknown permission".
 */
export const CLIPBOARD_PERMISSIONS: readonly string[] =
  BROWSER === "webkit" ? ["clipboard-read"] : ["clipboard-read", "clipboard-write"];

/** One headless browser for the whole run; Playwright closes it when the process exits. */
export async function launch(): Promise<Browser> {
  if (!browser?.isConnected()) {
    browser =
      BROWSER === "webkit"
        ? await webkit.launch({ headless: true })
        : await chromium.launch({
            headless: true,
            args: [
              "--mute-audio",
              "--use-mock-keychain",
              "--password-store=basic",
              "--no-first-run",
            ],
          });
  }
  return browser;
}

/** A provider whose answer the test sets; it streams in two tokens. */
export class FakeProvider implements Provider {
  readonly id = "harness" as const;
  answer: (req: CompleteRequest) => string = () => "fine";
  delayMs = 0;
  readonly requests: CompleteRequest[] = [];
  async available() {
    return { ok: true as const, detail: "fake" };
  }
  async complete(
    req: CompleteRequest,
    onToken: (t: string) => void,
    signal: AbortSignal,
  ): Promise<CompleteResult> {
    this.requests.push(req);
    const text = this.answer(req);
    const half = Math.ceil(text.length / 2);
    onToken(text.slice(0, half));
    if (this.delayMs > 0) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          r();
        });
      });
    }
    onToken(text.slice(half));
    return { text, model: "fake/1.0" };
  }
}

/**
 * TS-15, "hidden means hidden": every element with the `hidden` attribute has computed
 * `display: none` and holds no focus. Returns what breaks the rule, as `#id` or `tag.class`.
 */
export function hiddenOffenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const name = (el: Element) =>
      el.id ? `#${el.id}` : [el.tagName.toLowerCase(), ...el.classList].join(".");
    const out: string[] = [];
    for (const el of document.querySelectorAll("[hidden]")) {
      if (getComputedStyle(el).display !== "none") out.push(`${name(el)} shows`);
    }
    const a = document.activeElement;
    const box = a?.closest("[hidden]");
    if (a && box) out.push(`${name(a)} has focus inside ${name(box)}`);
    return out;
  });
}

/**
 * The display half of the same check, run on every screen a test reaches: after each change to
 * the page's DOM, what breaks the rule is kept in `window.__hiddenOffenders`, and the rig fails
 * the test at close. A new pane is covered without a new test. Focus is checked only where a test
 * calls `hiddenOffenders` itself.
 */
function watchHidden(): void {
  const found = new Set<string>();
  (window as unknown as { __hiddenOffenders: Set<string> }).__hiddenOffenders = found;
  const name = (el: Element) =>
    el.id ? `#${el.id}` : [el.tagName.toLowerCase(), ...el.classList].join(".");
  const check = () => {
    for (const el of document.querySelectorAll("[hidden]")) {
      if (getComputedStyle(el).display !== "none") found.add(`${name(el)} shows`);
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(check).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    check();
  });
}

/** What the page's watch found since it opened, or since the last `clear`. */
export function watchedOffenders(page: Page, o: { clear?: boolean } = {}): Promise<string[]> {
  return page.evaluate((clear) => {
    const found = (window as unknown as { __hiddenOffenders?: Set<string> }).__hiddenOffenders;
    const all = [...(found ?? [])];
    if (clear) found?.clear();
    return all;
  }, !!o.clear);
}

export interface UiRig extends AppRig {
  opened: string[];
  /** Opens the window in a new page, on a call when one is named. */
  open(call?: string, o?: { before?: (page: Page) => unknown }): Promise<Page>;
  /** Writes an event into a call through its one writer (a line, a note, a health change). */
  write(call: string, draft: EventDraft): Promise<LogEvent>;
}

export async function uiRig(
  o: RigOptions & { settings?: Record<string, unknown> } = {},
): Promise<UiRig> {
  const opened: string[] = [];
  const rig = await appRig({
    ...o,
    settings: { "share.bind": "127.0.0.1", "share.port": 0, ...o.settings },
    openExternal: async (url) => {
      opened.push(url);
      return true;
    },
  });
  const b = await launch();
  const pages: Page[] = [];
  const ui = rig as UiRig;
  ui.opened = opened;
  ui.open = async (call?: string, oo: { before?: (page: Page) => unknown } = {}) => {
    const r = await rig.api("POST", "/window", call ? { call } : {});
    if (r.status !== 200 || !r.body.url)
      throw new Error(`POST /window answered ${r.status}: ${r.text}`);
    const page = await b.newPage();
    pages.push(page);
    // A script error on the page fails the test that caused it, loudly.
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
      console.error(`page error: ${err.message}`);
    });
    page.on("console", (m) => {
      if (m.type() === "error") console.error(`page console: ${m.text()}`);
    });
    await page.addInitScript(watchHidden);
    await oo.before?.(page);
    await page.goto(r.body.url as string);
    await page.waitForFunction(() => document.body.dataset.transport === "browser");
    return page;
  };
  ui.write = (call, draft) => rig.app.write(call, draft);
  const close = rig.close;
  ui.close = async () => {
    const hidden = new Set<string>();
    // Blind spots: a page the test closed itself is skipped, and a page not opened through
    // `open` (the share viewer, opened on a browser of its own) was never watched.
    for (const p of pages) {
      if (p.isClosed()) continue;
      for (const o of await watchedOffenders(p).catch(() => [])) hidden.add(o);
    }
    for (const p of pages) await p.close().catch(() => {});
    await close();
    const errors = pageErrors.splice(0);
    if (errors.length > 0) throw new Error(`the page threw: ${errors.join("; ")}`);
    if (hidden.size > 0) {
      throw new Error(`[TS-15] hidden but shown: ${[...hidden].sort().join("; ")}`);
    }
  };
  return ui;
}

/**
 * Writes a finished call into the recordings root before the app starts, so recovery finds it:
 * fully generated, with the lines a test needs.
 */
export function seedCall(
  home: string,
  build: (b: LogBuilder) => void,
  o: { workspace?: string; folder?: string } = {},
): { id: string; dir: string } {
  const b = new LogBuilder();
  build(b);
  const created = b.events[0] as Extract<LogEvent, { type: "call.created" }>;
  const ws = o.workspace ?? created.workspace;
  const dir = join(
    home,
    "Recordings",
    "akou",
    ws,
    o.folder ?? `2026-09-23_153612_${created.id.slice(-6).toLowerCase()}`,
  );
  mkdirSync(join(dir, "audio"), { recursive: true });
  writeFileSync(
    join(dir, "events.jsonl"),
    `${b.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  return { id: created.id, dir };
}

/** A two-person call: Ana on the mic, two call-side speakers, ended. */
export function standardCall(b: LogBuilder, id = "01J8Z6Q4M2VX0K7B3D4E5F6G7H"): void {
  b.created({ id });
  b.partStarted(1, T0);
  b.seg({ id: "l000001", ch: "mic", spk: "you", w0: T0 + 1000, text: "hello everyone" });
  b.seg({
    id: "l000002",
    ch: "call",
    spk: "c1",
    w0: T0 + 3000,
    text: "we should move the build to the new box",
  });
  b.seg({ id: "l000003", ch: "call", spk: "c2", w0: T0 + 6000, text: "deploy to hetzner today" });
  b.seg({ id: "l000004", ch: "call", spk: "c1", w0: T0 + 9000, text: "thanks" });
  b.partEnded(1, "stop", 12);
  b.add({ type: "call.ended", reason: "stop" });
}

export { T0, TZ };

/** Counts the page's requests by path, for "no refetch" assertions. */
export function requestLog(page: Page): { all: Request[]; paths(): string[] } {
  const all: Request[] = [];
  page.on("request", (r) => all.push(r));
  return { all, paths: () => all.map((r) => new URL(r.url()).pathname) };
}

/** A WAV of silence for the fake helper: a live call that never produces a line. */
export function silentWav(dir: string, seconds = 30): string {
  const path = join(dir, "silence.wav");
  const n = 16000 * seconds;
  writeFileSync(path, stereoWav(new Float32Array(n), new Float32Array(n)));
  return path;
}

/** A live-layer segment draft, for writing a line into a call. */
export function seg(
  id: string,
  text: string,
  o: { ch?: "mic" | "call"; spk?: string; w0?: number; part?: number; a0?: number } = {},
): EventDraft {
  const w0 = o.w0 ?? Date.now();
  return {
    type: "seg",
    id,
    rev: 1,
    layer: "live",
    part: o.part ?? 1,
    ch: o.ch ?? "call",
    spk: o.ch === "mic" ? "you" : (o.spk ?? "c1"),
    a0: o.a0 ?? 1,
    a1: (o.a0 ?? 1) + 1,
    w0,
    w1: w0 + 900,
    text,
    model: "fake",
  } as EventDraft;
}
