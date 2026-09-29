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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type APIResponse,
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
  type Request,
  type Route,
  webkit,
} from "playwright-core";
import type { EventDraft, LogEvent } from "../../src/core/log/events.ts";
import { tokenize } from "../../src/core/vocab/correct.ts";
import type { CompleteRequest, CompleteResult, Provider } from "../../src/main/llm/provider.ts";
import type { DictionaryEntry } from "../../src/ui/dictation-dictionary.ts";
import type { DictationRow } from "../../src/ui/dictation-history.ts";
import type { CaptureInput } from "../../src/ui/dictation-mic.ts";
import type { DictationGrants } from "../../src/ui/dictation-page.ts";
import type { DictationPair } from "../../src/ui/dictation-review.ts";
import type { ConfigReply, SchemaEntry } from "../../src/ui/settings.ts";
import { type AppRig, appRig, type RigOptions } from "../api-helpers.ts";
import { until } from "../capture-helpers.ts";
import { stereoWav } from "../fixtures/audio.ts";
import { LogBuilder, T0, TZ } from "../helpers.ts";
import { buildEntry } from "./desktop-rig.ts";

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

// ---------------------------------------------------------------------------------------------
// Dictation fixtures (docs/ux/DICTATION.md sections 5 and 6). Until the dictation settings and
// routes land in the app, the page's requests for them are answered here, and the rest of each
// request goes to the real app.

type Schema = Record<string, SchemaEntry>;
const bool = (doc: string): SchemaEntry => ({ type: "boolean", apiWritable: true, doc });
const pick = (values: string[], doc: string): SchemaEntry => ({
  type: "string",
  values,
  apiWritable: true,
  doc,
});
const int = (min: number, max: number, doc: string): SchemaEntry => ({
  type: "integer",
  min,
  max,
  apiWritable: true,
  doc,
});
const str = (doc: string, o: Partial<SchemaEntry> = {}): SchemaEntry => ({
  type: "string",
  apiWritable: true,
  doc,
  ...o,
});

/** The app-mode dictation keys of section 6, with their defaults, as `GET /config` will carry them. */
export const DICTATION_SCHEMA: Schema = {
  "dictation.enabled": bool("Dictation on or off."),
  "dictation.hotkey": str("The dictation key."),
  "dictation.activation": pick(["hold", "toggle", "hold-or-toggle"], "How the key starts."),
  "dictation.hotkeyDraft": str("Opens the draft box instead."),
  "dictation.hotkeyFixLast": str("Opens the last dictation to fix it."),
  "dictation.hotkeyPasteLast": str("Inserts the last dictation again."),
  "dictation.silenceStopSeconds": int(0, 600, "Ends a latched session after this much silence."),
  "dictation.maxMinutes": int(1, 60, "The longest session."),
  "dictation.mic": str("The microphone; empty follows the system."),
  "dictation.preferBuiltInOverBluetooth": bool("The built-in mic over a Bluetooth headset."),
  "dictation.warmMic": pick(["off", "auto", "always"], "Keeps the mic open between dictations."),
  "dictation.engine": pick(["auto", "fast", "best", "remote"], "The engine."),
  "dictation.localTimeoutSeconds": int(2, 120, "How long a local best may take."),
  "dictation.remote.url": str("The remote akou.", { apiWritable: false }),
  "dictation.remote.key": str("The remote's jobs key.", { secret: true }),
  "dictation.remote.fallback": pick(["local", "error"], "When the remote is down."),
  "dictation.remote.timeoutSeconds": int(1, 60, "The remote's budget before any audio."),
  "asr.qwenIdleMinutes": int(0, 1440, "Stops llama-server after this idle time."),
  "dictation.language": str("auto or a language tag."),
  "dictation.languages": { type: "string[]", apiWritable: true, doc: "Languages to choose among." },
  "dictation.glossary": pick(["off", "on"], "Sends learned words to the recognizer."),
  "dictation.glossaryMax": int(1, 24, "How many learned words at most."),
  "dictation.insert": pick(["paste", "type", "clipboard"], "How text is inserted."),
  "dictation.sendKey": pick(["Enter", "Ctrl+Enter", "Cmd+Enter", "Shift+Enter", "none"], "Send."),
  "dictation.sendAlways": bool("Sends after every dictation."),
  "dictation.restoreClipboard": bool("Puts the old clipboard back."),
  "dictation.smartSpacing": bool("Spacing and case from the text around the cursor."),
  "dictation.trailingSpace": bool("A space after the text."),
  "dictation.spokenPunctuation": bool("Spoken punctuation."),
  "dictation.fillers": bool("Removes filler words."),
  "dictation.spokenSend": bool("A spoken send."),
  "dictation.format": pick(["off", "provider"], "Cleans up with your provider."),
  "dictation.formatPrompt": str("The formatting prompt."),
  "dictation.formatTimeoutSeconds": int(1, 60, "How long formatting may take."),
  "dictation.muteMedia": bool("Pauses other media while listening."),
  "dictation.learn": pick(["off", "ask", "auto"], "Suggests words to learn."),
  "dictation.readField": bool("Reads the field you dictated into."),
  "dictation.learn.audioCheck": bool("Confirms a word against the audio."),
  "dictation.apps": { type: "apps", apiWritable: true, doc: "Per-app dictation rules." },
  "dictation.pill": pick(["bottom", "top", "left", "right", "off"], "Where the pill shows."),
  "dictation.pillPreview": bool("Shows the words as you speak."),
  "dictation.sounds": pick(["auto", "off", "soft", "click"], "Start and stop sounds."),
  "dictation.retainDays": int(0, 3650, "How long history is kept."),
  "dictation.keepAudio": bool("Keeps the audio for retry and learning."),
};

/** Server mode's dictation keys. */
export const DICTATION_SERVER_SCHEMA: Schema = {
  "server.dictation_slots": int(0, 8, "Workers reserved for dictation requests."),
  "server.dictation_engine": str("The engine a dictation request runs."),
};

/** A value for every fixture key: its section 6 default. */
function defaults(schema: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(schema)) {
    out[k] =
      s.type === "boolean"
        ? false
        : s.type === "integer"
          ? (s.min ?? 0)
          : s.type === "string[]" || s.type === "apps"
            ? []
            : (s.values?.[0] ?? "");
  }
  return out;
}

/**
 * The real answer to a routed request: from the app itself, or, for a page on another origin, from
 * the app at `proxy.to` with the request's `Origin` rewritten, as a reverse proxy in front of it
 * would.
 */
function upstream(route: Route, proxy?: { from: string; to: string }): Promise<APIResponse> {
  if (!proxy) return route.fetch();
  const req = route.request();
  const headers = { ...req.headers() };
  if (headers.origin) headers.origin = proxy.to;
  return route.fetch({ url: req.url().replace(proxy.from, proxy.to), headers });
}

/** Carries every request of a page on `from` to the app at `to` (see `upstream`). */
export async function proxyRoute(context: BrowserContext, from: string, to: string): Promise<void> {
  await context.route(`${from}/**`, async (route) =>
    route.fulfill({ response: await upstream(route, { from, to }) }),
  );
}

/** What `GET /devices` answers: the inputs, or a refusal with its status and message. */
export type DevicesFixture = CaptureInput[] | { status: number; message: string };

function devicesReply(d: DevicesFixture): { status: number; json: unknown } {
  return Array.isArray(d)
    ? { status: 200, json: { backend: "fake", inputs: d, outputs: [] } }
    : { status: d.status, json: { error: "unavailable", message: d.message } };
}

export interface DictationFixture {
  /** Every `PATCH /config` body the page sent that named a fixture key. */
  patches: Record<string, unknown>[];
  settings: Record<string, unknown>;
  /** Refuses the next patch of this key with this message, as the registry would. */
  refuse: Map<string, string>;
  /** What `GET /server` adds under `dictation`. */
  server: { slots: number; engine: string; served_last_hour: number } | null;
  /** The `DELETE /dictations` the page sent. */
  deletes: number;
  /** What `GET /dictations` lists, newest first. */
  history: DictationRow[];
  /** Every request under `/dictations`, in order: its path with the query, and its body. */
  calls: { method: string; path: string; body?: unknown }[];
  /** The answer to `POST /dictations/{id}/retry`; refuse it with `refuse.set("retry:ENGINE")`. */
  retry: (d: DictationRow, engine: string) => DictationRow;
  /** The helper's grants on `GET /dictation`; null answers 404, as an app without the route. */
  grants: DictationGrants | null;
}

/**
 * Answers the page's dictation requests from fixtures: `GET /config` gains `schema`'s keys (the
 * real reply is fetched and extended), a `PATCH /config` of fixture keys is recorded and answered
 * here, `GET /server` gains the `dictation` block, `GET /dictation` carries `grants`, and the
 * dictation routes (DC-G1) answer from `history`, each request recorded in `calls`.
 * `prefix`: the API's path on this page (`/api/v1`). `proxy`: the page is on another origin
 * (`proxyRoute`), whose requests reach the app at `to`.
 */
export async function dictationFixture(
  page: Page,
  o: {
    schema?: Schema;
    prefix?: string;
    server?: DictationFixture["server"];
    proxy?: { from: string; to: string };
    history?: DictationRow[];
    grants?: DictationGrants | null;
    /** The OS `GET /status` reports, so a test runs as macOS on any machine. */
    platform?: string;
    /** `GET /devices`: its inputs, or a refusal; left out, the app answers (404 until PG-A8). */
    devices?: DevicesFixture;
  } = {},
): Promise<DictationFixture> {
  const schema = o.schema ?? DICTATION_SCHEMA;
  const prefix = o.prefix ?? "/api/v1";
  const fx: DictationFixture = {
    patches: [],
    settings: defaults(schema),
    refuse: new Map(),
    server: o.server ?? null,
    deletes: 0,
    history: o.history ?? [],
    calls: [],
    retry: (d, engine) => ({ ...d, engine, text: `${d.text} (${engine})`, ms: 640 }),
    grants: o.grants === undefined ? { mic: "granted", accessibility: "granted" } : o.grants,
  };
  if (o.platform) {
    await page.route(
      (u) => u.pathname === `${prefix}/status`,
      async (route) => {
        const res = await upstream(route, o.proxy);
        const real = (await res.json()) as { app: Record<string, unknown> };
        return route.fulfill({
          response: res,
          json: { ...real, app: { ...real.app, platform: o.platform } },
        });
      },
    );
  }
  const devices = o.devices;
  if (devices) {
    await page.route(
      (u) => u.pathname === `${prefix}/devices`,
      (route) => route.fulfill(devicesReply(devices)),
    );
  }
  await page.route(
    (u) => u.pathname === `${prefix}/dictation`,
    (route) =>
      fx.grants
        ? route.fulfill({
            status: 200,
            json: { enabled: fx.settings["dictation.enabled"], state: "idle", grants: fx.grants },
          })
        : route.fulfill({ status: 404, json: { error: "not_found", message: "no such route" } }),
  );
  await page.route(
    (u) => u.pathname === `${prefix}/config`,
    async (route) => {
      const req = route.request();
      if (req.method() === "PATCH") {
        const body = req.postDataJSON() as Record<string, unknown>;
        const mine = Object.keys(body).filter((k) => k in schema);
        if (mine.length === 0) return route.continue();
        fx.patches.push(body);
        const errors = mine.flatMap((k) => (fx.refuse.has(k) ? [`${k}: ${fx.refuse.get(k)}`] : []));
        for (const k of mine) fx.refuse.delete(k);
        if (errors.length > 0) {
          return route.fulfill({
            status: 400,
            json: { error: "bad_setting", message: errors.join("; "), errors },
          });
        }
        Object.assign(fx.settings, body);
        return route.fulfill({ status: 200, json: { ok: true } });
      }
      const res = await upstream(route, o.proxy);
      const real = (await res.json()) as ConfigReply;
      return route.fulfill({
        response: res,
        json: {
          ...real,
          settings: { ...real.settings, ...fx.settings },
          schema: { ...real.schema, ...schema },
        },
      });
    },
  );
  await page.route(
    (u) => u.pathname === `${prefix}/server`,
    async (route) => {
      const res = await upstream(route, o.proxy);
      const real = (await res.json()) as Record<string, unknown>;
      return route.fulfill({
        response: res,
        json: fx.server ? { ...real, dictation: fx.server } : real,
      });
    },
  );
  await page.route(
    (u) => u.pathname === `${prefix}/dictations` || u.pathname.startsWith(`${prefix}/dictations/`),
    (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.slice(prefix.length);
      // The browser transport sends `{}` with a bodiless request; that is no body.
      const sent = req.postData() ? (req.postDataJSON() as Record<string, unknown>) : {};
      const body = Object.keys(sent).length > 0 ? sent : undefined;
      fx.calls.push({
        method: req.method(),
        path: path + url.search,
        ...(body === undefined ? {} : { body }),
      });
      if (path === "/dictations" && req.method() === "DELETE") {
        fx.deletes++;
        fx.history = [];
        return route.fulfill({ status: 200, json: { deleted: 0 } });
      }
      if (path === "/dictations" && req.method() === "GET") {
        const q = url.searchParams.get("q")?.toLowerCase() ?? "";
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const cursor = url.searchParams.get("cursor");
        let items = fx.history;
        if (cursor) items = items.slice(items.findIndex((d) => d.id === cursor) + 1);
        if (q) items = items.filter((d) => (d.text ?? "").toLowerCase().includes(q));
        const since = url.searchParams.get("since");
        if (since !== null) items = items.filter((d) => d.at >= Number(since));
        const page = items.slice(0, limit);
        return route.fulfill({
          status: 200,
          json: {
            items: page,
            next_cursor: items.length > limit ? (page.at(-1)?.id ?? null) : null,
          },
        });
      }
      const m = /^\/dictations\/([^/]+)(?:\/(insert|retry))?$/.exec(path);
      const id = decodeURIComponent(m?.[1] ?? "");
      const d = fx.history.find((x) => x.id === id);
      if (!m || !d) return route.fulfill({ status: 404, json: { error: "not_found" } });
      if (m[2] === "retry") {
        const engine = (body as { engine: string }).engine;
        const err = fx.refuse.get(`retry:${engine}`);
        if (err)
          return route.fulfill({ status: 409, json: { error: "unavailable", message: err } });
        return route.fulfill({ status: 200, json: fx.retry(d, engine) });
      }
      if (m[2] === "insert") return route.fulfill({ status: 200, json: { opened: true } });
      if (req.method() === "DELETE") {
        fx.history = fx.history.filter((x) => x !== d);
        return route.fulfill({ status: 200, json: { deleted: 1 } });
      }
      return route.fulfill({ status: 200, json: d });
    },
  );
  return fx;
}

/** A dictation for the history fixture: `n` sets the id, the text and the time, newest first. */
export function dictationRow(n: number, o: Partial<DictationRow> = {}): DictationRow {
  return {
    id: `d${String(n).padStart(3, "0")}`,
    at: Date.parse("2026-09-26T10:00:00Z") - n * 60_000,
    state: "inserted",
    app: "com.example.chat",
    text: `dictation number ${n}`,
    engine: "fast",
    model: "parakeet",
    ms: 120,
    ...o,
  };
}

export interface VocabFixture {
  /** What `GET /vocab` lists. */
  entries: DictionaryEntry[];
  /** Every `POST /vocab` and `DELETE /vocab/{term}`, in order. */
  calls: { method: string; path: string; body?: unknown }[];
  /** Refuses the next `POST /vocab` with this message, as the route refuses a bad term. */
  refuse: string | null;
  /**
   * The words fixed while dictating that `GET /vocab?dictation=true` lists (DC-L5), newest first;
   * unset, the answer has no `dictation`, as an akou without the list answers.
   */
  dictation?: DictationPair[];
}

/** The global vocabulary file of the fixture. */
export const VOCAB_FILE = "/config/vocabulary.yaml";

/**
 * Answers the Dictionary's requests from `entries`, as the vocabulary routes do. As the route does, a post builds a fresh entry from the body alone (`confirmed` true unless sent,
 * `note` and `decode: false` only when sent) and replaces the entry of the same term under the
 * server's key (`termKey`), as `upsertEntry` does. `POST /vocab/import` goes to the app.
 */
export async function vocabFixture(
  page: Page,
  entries: DictionaryEntry[] = [],
  prefix = "/api/v1",
): Promise<VocabFixture> {
  const fx: VocabFixture = { entries, calls: [], refuse: null };
  await page.route(
    (u) =>
      (u.pathname === `${prefix}/vocab` || u.pathname.startsWith(`${prefix}/vocab/`)) &&
      u.pathname !== `${prefix}/vocab/import`,
    (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname.slice(prefix.length);
      if (req.method() === "GET" && path === "/vocab") {
        const withDictation =
          new URL(req.url()).searchParams.get("dictation") === "true" && fx.dictation;
        return route.fulfill({
          status: 200,
          json: {
            workspace: null,
            files: [{ scope: "global", path: VOCAB_FILE }],
            entries: fx.entries,
            ...(withDictation ? { dictation: fx.dictation } : {}),
          },
        });
      }
      const sent = req.postData() ? (req.postDataJSON() as Record<string, unknown>) : {};
      const body = Object.keys(sent).length > 0 ? sent : undefined;
      fx.calls.push({ method: req.method(), path, ...(body === undefined ? {} : { body }) });
      const key = (t: string) =>
        tokenize(t)
          .map((x) => x.folded)
          .join(" ");
      const answer = /^\/vocab\/(approve|reject)$/.exec(path)?.[1];
      if (req.method() === "POST" && answer && (sent as { dictation?: boolean }).dictation) {
        // As the route answers dictation's words: by term, approve the waiting pairs, reject
        // those and a learned one, which leaves the file; a call word is refused whole.
        if (fx.refuse) {
          const message = fx.refuse;
          fx.refuse = null;
          return route.fulfill({ status: 409, json: { error: "call_word", message } });
        }
        const terms = new Set((sent as { terms: string[] }).terms.map(key));
        const open =
          answer === "approve" ? ["proposed", "ignored"] : ["proposed", "ignored", "accepted"];
        const done = new Set<string>();
        for (const p of fx.dictation ?? []) {
          if (!terms.has(key(p.term)) || !open.includes(p.status)) continue;
          done.add(p.term);
          if (answer === "approve") {
            // One entry per term, a heard form added to it, as `learnPair` writes.
            const had = fx.entries.find((e) => e.scope === "global" && key(e.term) === key(p.term));
            if (had) had.heard = [...new Set([...had.heard, p.heard])];
            else
              fx.entries.push({
                term: p.term,
                heard: [p.heard],
                confirmed: true,
                scope: "global",
                file: VOCAB_FILE,
                entryScope: "dictation",
              });
          } else if (p.status === "accepted") {
            fx.entries = fx.entries.filter((e) => key(e.term) !== key(p.term));
          }
          p.status = answer === "approve" ? "accepted" : "rejected";
        }
        return route.fulfill({
          status: 200,
          json: {
            ok: true,
            path: VOCAB_FILE,
            [answer === "approve" ? "approved" : "rejected"]: [...done],
          },
        });
      }
      if (req.method() === "POST" && path === "/vocab") {
        if (fx.refuse) {
          const message = fx.refuse;
          fx.refuse = null;
          return route.fulfill({ status: 400, json: { error: "bad_term", message } });
        }
        const b = sent as {
          term: string;
          heard?: string[];
          scope?: "dictation";
          confirmed?: boolean;
          note?: string;
          decode?: boolean;
        };
        const entry: DictionaryEntry = {
          term: b.term,
          heard: b.heard ?? [],
          confirmed: b.confirmed ?? true,
          scope: "global",
          file: VOCAB_FILE,
          ...(b.decode === false ? { decode: false } : {}),
          ...(b.note ? { note: b.note } : {}),
          ...(b.scope ? { entryScope: b.scope } : {}),
        };
        const at = fx.entries.findIndex((e) => e.scope === "global" && key(e.term) === key(b.term));
        if (at < 0) fx.entries.push(entry);
        else fx.entries[at] = entry;
        return route.fulfill({ status: 201, json: { ok: true, path: VOCAB_FILE, entry } });
      }
      const term = decodeURIComponent(path.slice("/vocab/".length));
      const at = fx.entries.findIndex((e) => e.scope === "global" && key(e.term) === key(term));
      if (req.method() !== "DELETE" || at < 0)
        return route.fulfill({
          status: 404,
          json: { error: "not_found", message: "no such word" },
        });
      fx.entries.splice(at, 1);
      return route.fulfill({ status: 200, json: { ok: true, path: VOCAB_FILE, term } });
    },
  );
  return fx;
}

/** A small ElectroBun view (the pill, the draft box) on its own page, with a fake main side. */
export interface ViewPage {
  page: Page;
  /** Every request the page made, in order. */
  requests: { name: string; params: unknown }[];
  /** Pushes a message to the page, as the main process does. */
  send(name: string, payload: unknown): Promise<void>;
  close(): Promise<void>;
}

const VIEW_FILES: Record<"pill" | "draft" | "main", { html: string; css: string; entry: string }> =
  {
    pill: { html: "pill.html", css: "pill.css", entry: "dictation-pill-window.ts" },
    draft: { html: "draft.html", css: "draft.css", entry: "dictation-draft-window.ts" },
    main: { html: "index.html", css: "theme.css", entry: "window.ts" },
  };

/**
 * Opens a dictation view's real page, built from its ElectroBun entry over the shim, on its own
 * origin; the requests it makes are recorded and answered by `answer`, or `true`. With `clock`,
 * the page runs on Playwright's clock from its first script.
 */
export async function viewPage(
  view: "pill" | "draft" | "main",
  o: { clock?: Date; answer?: (name: string, params: unknown) => unknown } = {},
): Promise<ViewPage> {
  const f = VIEW_FILES[view];
  const ui = join(import.meta.dir, "..", "..", "src", "ui");
  const files: Record<string, { body: string; type: string }> = {
    "index.html": { body: readFileSync(join(ui, f.html), "utf8"), type: "text/html" },
    [f.css]: { body: readFileSync(join(ui, f.css), "utf8"), type: "text/css" },
    "index.js": { body: await buildEntry(f.entry), type: "text/javascript" },
  };
  const b = await launch();
  const context = await b.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
    console.error(`${view} page error: ${err.message}`);
  });
  await page.addInitScript(watchHidden);
  // The page's timers are Playwright's from the start, so a test moves them.
  if (o.clock) await page.clock.install({ time: o.clock });
  const requests: ViewPage["requests"] = [];
  await page.route("http://akou.test/**", (route) => {
    const file = files[new URL(route.request().url()).pathname.slice(1) || "index.html"];
    if (!file) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: file.type, body: file.body });
  });
  await page.exposeFunction("__akouRequest", async (name: string, params: unknown) => {
    requests.push({ name, params });
    return (await o.answer?.(name, params)) ?? true;
  });
  await page.goto("http://akou.test/index.html");
  return {
    page,
    requests,
    send: (name, payload) =>
      page.evaluate(([n, m]) => window.__akouMessage(n as string, m), [name, payload] as const),
    close: async () => {
      const hidden = await watchedOffenders(page).catch(() => []);
      await context.close();
      const errors = pageErrors.splice(0);
      if (errors.length > 0) throw new Error(`the page threw: ${errors.join("; ")}`);
      if (hidden.length > 0) throw new Error(`[TS-15] hidden but shown: ${hidden.join("; ")}`);
    },
  };
}

/**
 * The desktop window's own page (`window.ts` over the shim) with a fake main side: its API
 * requests reach the real app, except the dictation keys, the grants and the OS, answered as the
 * dictation fixture does. For what only the window has, such as the helper's keys (DC-U3).
 */
export async function windowPage(
  rig: AppRig,
  o: {
    platform?: string;
    /** Read at every `GET /dictation`, so a test changes the grants as the OS would. */
    grants?: DictationGrants;
    /** The grants the running helper lost since it started, on `GET /dictation` (DC-N1). */
    lost?: string[];
    /** The answer to `recordDictationKeys`: false, no helper hears keys (DC-N2). */
    hearing?: boolean;
    /** Saved values over the section 6 defaults. */
    settings?: Record<string, unknown>;
    devices?: DevicesFixture;
  } = {},
): Promise<ViewPage & { patches: Record<string, unknown>[] }> {
  const settings = { ...defaults(DICTATION_SCHEMA), ...o.settings };
  const patches: Record<string, unknown>[] = [];
  const status = async () => {
    const r = await rig.api("GET", "/status");
    return o.platform ? { ...r.body, app: { ...r.body.app, platform: o.platform } } : r.body;
  };
  const api = async (p: { method: string; path: string; body?: unknown }) => {
    if (p.path === "/status") return { status: 200, body: await status() };
    if (p.path === "/devices" && o.devices) {
      const r = devicesReply(o.devices);
      return { status: r.status, body: r.json };
    }
    if (p.path === "/dictation")
      return {
        status: 200,
        body: {
          enabled: settings["dictation.enabled"],
          state: "idle",
          grants: o.grants ?? { mic: "granted", accessibility: "granted" },
          lost: o.lost ?? [],
        },
      };
    if (p.path === "/config" && p.method === "PATCH") {
      const body = p.body as Record<string, unknown>;
      if (Object.keys(body).every((k) => k in DICTATION_SCHEMA)) {
        patches.push(body);
        Object.assign(settings, body);
        return { status: 200, body: { ok: true } };
      }
    }
    const r = await rig.api(p.method, p.path, p.body);
    if (p.path === "/config" && p.method === "GET" && r.status === 200) {
      const real = r.body as ConfigReply;
      return {
        status: 200,
        body: {
          ...real,
          settings: { ...real.settings, ...settings },
          schema: { ...real.schema, ...DICTATION_SCHEMA },
        },
      };
    }
    return { status: r.status, body: r.body };
  };
  const v = await viewPage("main", {
    answer: (name, params) =>
      name === "api"
        ? api(params as Parameters<typeof api>[0])
        : name === "status"
          ? status()
          : name === "follow"
            ? { ok: false }
            : name === "recordDictationKeys"
              ? (o.hearing ?? true)
              : undefined,
  });
  await v.page.waitForFunction(() => document.body.dataset.transport === "window");
  return { ...v, patches };
}
