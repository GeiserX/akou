/**
 * The window's pieces that need no browser (docs/DESIGN.md sections 6.3 and 7): the static bundle
 * and the page server's guard and session. The page itself is tested in a headless browser by
 * `bun run test:ui`; the ElectroBun shell in `shell.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventDraft, LogEvent } from "../src/core/log/events.ts";
import { renderExport } from "../src/main/handoff/export.ts";
import { Bridge, checkPath } from "../src/main/window/bridge.ts";
import { buildUi, nodeImport, UI_DIR } from "../src/main/window/bundle.ts";
import {
  CODE_TTL_MS,
  CSP,
  metaCsp,
  PageServer,
  WINDOW_CSP,
} from "../src/main/window/page-server.ts";
import { type AppRig, appRig, rawRequest } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";

const LONG = 30_000;

describe("the static bundle", () => {
  test("both pages build for the browser, with no Node module in them", async () => {
    const b = await buildUi();
    for (const f of ["/index.html", "/index.js", "/theme.css", "/share.html", "/share.js"]) {
      expect(b.get(f)?.body.length ?? 0).toBeGreaterThan(100);
    }
    expect(nodeImport(b.get("/index.js")?.body ?? "")).toBeNull();
    expect(b.get("/index.html")?.body).toContain('src="index.js"');
    expect(b.get("/share.html")?.body).toContain('src="share.js"');
  });

  test("positive control: a bundle that imports a Node module is caught", () => {
    expect(nodeImport('import { readFileSync } from "node:fs";')).not.toBeNull();
    expect(nodeImport('const fs = require("node:fs")')).not.toBeNull();
  });

  test("XSS: nothing in src/ui writes markup from a string (textContent and text nodes only)", () => {
    const MARKUP =
      /\.innerHTML\b|\.outerHTML\s*=|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/;
    const hits: string[] = [];
    for (const f of readdirSync(UI_DIR)) {
      if (!f.endsWith(".ts")) continue;
      const text = readFileSync(join(UI_DIR, f), "utf8");
      if (MARKUP.test(text)) hits.push(f);
    }
    expect(hits).toEqual([]);
    // Positive control: the pattern does catch the calls it is meant to catch.
    for (const bad of [
      "el.innerHTML = x",
      "el.outerHTML = x",
      "el.insertAdjacentHTML('beforeend', x)",
    ]) {
      expect(MARKUP.test(bad)).toBe(true);
    }
  });
});

/** Every rule in `css` whose declarations read `var(--name)`, by selector. */
function rulesUsing(css: string, name: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[2] ?? "").includes(`var(${name})`))
    .map((m) => (m[1] ?? "").trim().replace(/\s+/g, " "));
}

describe("one accent per screen (the design's rules)", () => {
  test("theme.css reads --accent only in the welcome's primary action (Download, or the setup's Continue), the focus ring, and the live panel's chosen radio and Add a model", () => {
    const css = readFileSync(join(UI_DIR, "theme.css"), "utf8");
    // The live panel as drawn (design-explorations/lm-live-menu-slots.html): the chosen model's
    // radio and "+ Add a model" are the panel's one accent.
    expect(rulesUsing(css, "--accent").sort()).toEqual([
      "#live-menu .live-add",
      '#live-menu .live-item[aria-checked="true"] .live-dot',
      "#welcome button.go",
      ":focus-visible",
    ]);
    // Positive control: one more rule painting with the accent is caught.
    const more = `${css}\n.row.playing .body { background: var(--accent); }`;
    expect(rulesUsing(more, "--accent")).toContain(".row.playing .body");
  });
});

/** WCAG contrast ratio of two `#rgb` or `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.slice(1);
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** The value of `--name` in the first `:root` block of `css`. */
function rootVar(css: string, name: string): string {
  const root = css.slice(css.indexOf(":root {"));
  const m = root.slice(0, root.indexOf("}")).match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]+);`));
  return m?.[1] ?? "";
}

describe("the accent button is readable (WCAG AA)", () => {
  test("the welcome's Download text is at least 4.5:1 on the accent, dark and light", () => {
    const css = readFileSync(join(UI_DIR, "theme.css"), "utf8");
    expect(rulesUsing(css, "--on-accent")).toEqual(["#welcome button.go"]);
    const light = css.slice(css.indexOf("@media (prefers-color-scheme: light)"));
    for (const scheme of [css, light]) {
      const fg = rootVar(scheme, "--on-accent");
      const bg = rootVar(scheme, "--accent");
      expect(fg && bg).toBeTruthy();
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
    // Positive control: white on the dark theme's accent, as it was, fails.
    expect(contrast("#fff", rootVar(css, "--accent"))).toBeLessThan(4.5);
  });
});

describe("the window's own Content Security Policy", () => {
  // The ElectroBun window loads index.html from views://, where no server adds the header: the
  // page carries the policy itself, or the window runs with none at all.
  test("index.html carries a meta policy: scripts from the bundle only, the RPC socket allowed", () => {
    const html = readFileSync(join(UI_DIR, "index.html"), "utf8");
    expect(metaCsp(html)).toBe(WINDOW_CSP);
    for (const d of [
      "default-src 'none'",
      "script-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ]) {
      expect(WINDOW_CSP).toContain(d);
    }
    expect(WINDOW_CSP).not.toMatch(/unsafe-inline|unsafe-eval/);
    // The window's RPC socket is ws://127.0.0.1:<port>, which 'self' under views:// does not cover.
    expect(WINDOW_CSP).toMatch(/connect-src [^;]*ws:\/\/127\.0\.0\.1:\*/);
    // A meta policy cannot carry frame-ancestors; the browser would only warn about it.
    expect(WINDOW_CSP).not.toContain("frame-ancestors");
  });

  test("positive control: a page without the meta policy is caught", () => {
    expect(metaCsp("<html><head><title>x</title></head></html>")).toBeNull();
    expect(metaCsp(`<meta http-equiv="Content-Security-Policy" content="script-src *">`)).not.toBe(
      WINDOW_CSP,
    );
  });
});

describe("the page server: the window in a browser, with a session of its own", () => {
  let rig: AppRig;
  let page: PageServer;

  beforeAll(async () => {
    rig = await appRig();
    const r = await rig.api("POST", "/window", {});
    expect(r.status).toBe(200);
    page = rig.app.page as PageServer;
  });
  afterAll(() => rig.close());

  const codeOf = (url: string) => /#k=(.+)$/.exec(url)?.[1] as string;
  const session = async () => {
    const code = codeOf(page.openUrl());
    const r = await fetch(`${page.origin}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ code }),
    });
    return ((await r.json()) as { session: string }).session;
  };

  test("POST /window on a headless app answers the page's address, the code in the fragment only", async () => {
    const r = await rig.api("POST", "/window", {});
    const url = new URL(r.body.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#k=[A-Za-z0-9_-]{30,}$/);
    // The API token is nowhere in it.
    expect(r.body.url).not.toContain(rig.token);
  });

  test("the page and its bundle are served with a strict CSP and no Referer", async () => {
    const res = await fetch(`${page.origin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toContain("unsafe-inline");
    expect((await fetch(`${page.origin}/index.js`)).status).toBe(200);
    // The share viewer is the share listener's, not this one's.
    expect((await fetch(`${page.origin}/share.html`)).status).toBe(404);
  });

  test("a code opens one session, once: a second use and an expired code are refused", async () => {
    const code = codeOf(page.openUrl());
    const trade = () =>
      fetch(`${page.origin}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
    expect((await trade()).status).toBe(200);
    expect((await trade()).status).toBe(403);
    // A code older than a minute is refused, even unused.
    let now = 1_000_000;
    const own = new PageServer({
      bridge: new Bridge(rig.app),
      bundle: await buildUi(),
      now: () => now,
    });
    const late = codeOf(own.openUrl());
    const fresh = codeOf(own.openUrl());
    now += CODE_TTL_MS + 1;
    const tradeOn = (c: string) =>
      fetch(`${own.origin}/session`, { method: "POST", body: JSON.stringify({ code: c }) });
    expect((await tradeOn(late)).status).toBe(403);
    now -= 2;
    expect((await tradeOn(fresh)).status).toBe(200);
    await own.stop();
  });

  test(
    "the API through the page needs the session; with it, writes are the user's own",
    async () => {
      const none = await fetch(`${page.origin}/api/v1/status`);
      expect(none.status).toBe(401);
      const bad = await fetch(`${page.origin}/api/v1/status`, {
        headers: { authorization: `Bearer ${rig.token}` },
      });
      expect(bad.status).toBe(401);
      const s = await session();
      const ok = await fetch(`${page.origin}/api/v1/status`, {
        headers: { authorization: `Bearer ${s}` },
      });
      expect(ok.status).toBe(200);
      const id = await rig.startCall();
      const note = await fetch(`${page.origin}/api/v1/calls/${id}/notes`, {
        method: "POST",
        headers: { authorization: `Bearer ${s}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "from the window", w: Date.now() - 2000, afterSeq: 1 }),
      });
      expect(note.status).toBe(201);
      const e = ((await note.json()) as { note: LogEvent & { by: string; afterSeq: number } }).note;
      expect(e.by).toBe("user");
      expect(e.afterSeq).toBe(1);
      await rig.api("POST", "/calls/live/stop");
    },
    LONG,
  );

  test("cross-site requests, foreign Host headers and CORS preflights are refused", async () => {
    const s = await session();
    const cross = await fetch(`${page.origin}/api/v1/status`, {
      headers: { authorization: `Bearer ${s}`, "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    const host = await rawRequest(page.port, {
      method: "GET",
      path: "/",
      headers: {},
      host: `attacker.example:${page.port}`,
    });
    expect(host.status).toBe(403);
    const pre = await fetch(`${page.origin}/api/v1/calls/live/stop`, { method: "OPTIONS" });
    expect(pre.status).toBe(405);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    // Positive control: the same request from the page itself goes through.
    const same = await fetch(`${page.origin}/api/v1/status`, {
      headers: { authorization: `Bearer ${s}`, "sec-fetch-site": "same-origin" },
    });
    expect(same.status).toBe(200);
  });

  test(
    "a stream through the page resumes after Last-Event-ID, and closeStreams drops it",
    async () => {
      const s = await session();
      const id = await rig.startCall();
      const ctl = new AbortController();
      const res = await fetch(`${page.origin}/api/v1/calls/${id}/stream`, {
        headers: { authorization: `Bearer ${s}`, "last-event-id": "2" },
        signal: ctl.signal,
      });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let text = "";
      while (!/id: \d+/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
      expect(Number(/id: (\d+)/.exec(text)?.[1])).toBe(3);
      await until(() => page.openStreams >= 1, 2000, "the stream to be counted");
      expect(page.closeStreams()).toBeGreaterThanOrEqual(1);
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
      }
      await rig.api("POST", "/calls/live/stop");
    },
    LONG,
  );

  test(
    "[W12.2] the transcript as the export's `## Transcript` section reaches the window as a string, through the bridge and the page",
    async () => {
      const id = await rig.startCall({ title: "Copy me" });
      const w0 = Date.now();
      for (const [n, spk, text] of [
        [1, "c1", "we should move the build"],
        [2, "c1", "- to the new box"],
        [3, "c2", "which region"],
      ] as const) {
        await rig.app.write(id, {
          type: "seg",
          id: `l00000${n}`,
          rev: 1,
          layer: "live",
          part: 1,
          ch: "call",
          spk,
          a0: n,
          a1: n + 1,
          w0: w0 + n * 1000,
          w1: w0 + n * 1000 + 900,
          text,
          model: "fake",
        } as EventDraft);
      }
      const view = (await rig.app.call(id)).view;
      const md = renderExport({ view, version: "0.0.0", enhanced: null, audio: [], rev: 1 });
      const section = md.slice(md.indexOf("## Transcript"));
      expect(section).toContain("\\- to the new box");
      const viaBridge = await new Bridge(rig.app).json(
        "GET",
        `/calls/${id}/transcript?format=export`,
      );
      expect(viaBridge).toEqual({ status: 200, body: section });
      const res = await fetch(`${page.origin}/api/v1/calls/${id}/transcript?format=export`, {
        headers: { authorization: `Bearer ${await session()}` },
      });
      expect(res.headers.get("content-type")).toContain("text/markdown");
      expect(await res.text()).toBe(section);
      // A JSON reply still arrives parsed.
      const detail = await new Bridge(rig.app).json("GET", `/calls/${id}`);
      expect(typeof detail.body).toBe("object");
      expect(detail.body).not.toBeNull();
      await rig.api("POST", "/calls/live/stop");
    },
    LONG,
  );

  test("the bridge refuses paths that are not API paths", () => {
    for (const bad of ["calls", "//evil/x", "/calls/../status", "/./x"]) {
      expect(() => checkPath(bad)).toThrow();
    }
    expect(checkPath("/calls/live?x=1")).toBe("/calls/live?x=1");
  });
});
