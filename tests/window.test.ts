/**
 * The window's pieces that need no browser (docs/DESIGN.md sections 6.3 and 7): the static bundle
 * and the page server's guard and session. The page itself is tested in a headless browser by
 * `bun run test:ui`; the ElectroBun shell in `shell.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { Bridge, checkPath } from "../src/main/window/bridge.ts";
import { buildUi, nodeImport, UI_DIR } from "../src/main/window/bundle.ts";
import { CODE_TTL_MS, CSP, PageServer } from "../src/main/window/page-server.ts";
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

  test("the bridge refuses paths that are not API paths", () => {
    for (const bad of ["calls", "//evil/x", "/calls/../status", "/./x"]) {
      expect(() => checkPath(bad)).toThrow();
    }
    expect(checkPath("/calls/live?x=1")).toBe("/calls/live?x=1");
  });
});
