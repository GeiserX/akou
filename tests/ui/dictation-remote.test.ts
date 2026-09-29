/**
 * The remote akou on the Dictation page in a headless browser (docs/ux/DICTATION.md section 7.2):
 * DC-R4's Test button and DC-R3's standing. The Test runs on the real app over its own
 * `GET /v1/dictation/remote-test`, against a loopback fake akou server whose key and capabilities
 * a test changes; the down state comes from a `GET /v1/dictation` fixture, since reaching it for
 * real takes three failed dictations. Nothing records, types, prompts or plays.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { REMOTE_PROBE_MS } from "../../src/main/server/remotes.ts";
import { type RemoteReply, remoteStanding } from "../../src/ui/dictation-remote.ts";
import { tempDir } from "../helpers.ts";
import { UI_TIMEOUT, type UiRig, uiRig, until } from "./rig.ts";

const RIGHT = "k-right-remote-7";
const WRONG = "k-wrong-remote-7";

/** A loopback akou server that knows one key; `caps` is what it reports as its capabilities. */
function fakeRemote() {
  const state = { key: RIGHT, caps: { interactive: true } as Record<string, unknown> };
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      if (path === "/v1/server") {
        // No accelerator fields: the remote decodes on the CPU.
        return Response.json({
          name: "akou",
          mode: "server",
          capabilities: state.caps,
          dictation: { engine: "best" },
        });
      }
      if (path === "/v1/keys/me") {
        return req.headers.get("authorization") === `Bearer ${state.key}`
          ? Response.json({ id: "key_1", scope: "jobs" })
          : Response.json({ error: "unauthorized", message: "unknown key" }, { status: 401 });
      }
      return new Response("no", { status: 404 });
    },
  });
  return { state, seen, server, url: `http://127.0.0.1:${server.port}` };
}

const text = (page: Page, sel: string) => page.textContent(sel).then((t) => t?.trim() ?? "");
/** The computed colour of `sel`, or of the refusal colour (`--rec`) when `sel` is null. */
const colour = (page: Page, sel: string | null) =>
  page.evaluate((sel) => {
    if (sel) return getComputedStyle(document.querySelector(sel) as Element).color;
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = "var(--rec)";
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, sel);

/** Opens the Dictation page; `answered` counts the `GET /v1/dictation` answers it read. */
async function openPage(
  rig: UiRig,
  before?: (p: Page) => unknown,
): Promise<Page & { answered: () => number }> {
  let n = 0;
  const page = Object.assign(await rig.open(undefined, { before }), { answered: () => n });
  page.on("requestfinished", (r) => {
    if (new URL(r.url()).pathname === "/api/v1/dictation") n++;
  });
  await page.click("#dictation-open");
  await page.waitForSelector(
    "#page-dictation section[data-section='Engine'] #dictation-remote-test",
    {
      state: "visible",
    },
  );
  return page;
}

/** Clicks Test and waits for its answer. */
async function runTest(page: Page): Promise<{ line: string; cls: string }> {
  await page.click("#dictation-remote-test");
  await page.waitForFunction(() => {
    const b = document.getElementById("dictation-remote-test") as HTMLButtonElement;
    const out = document.getElementById("dictation-remote-result");
    return !b.disabled && !!out?.textContent && !out.textContent.startsWith("Testing");
  });
  return {
    line: await text(page, "#dictation-remote-result"),
    cls: (await page.getAttribute("#dictation-remote-result", "class")) ?? "",
  };
}

describe("DC-R4: the Test button on the real app", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  let remote: ReturnType<typeof fakeRemote>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-remote-");
    remote = fakeRemote();
    // No local model: the fallback resolves to `error`, which the page says.
    rig = await uiRig({
      home: t.dir,
      models: null,
      settings: {
        "dictation.engine": "remote",
        "dictation.remote.url": remote.url,
        "dictation.remote.key": RIGHT,
      },
    });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    remote?.server.stop(true);
    t?.cleanup();
  });

  test(
    "ok with the engine, the CPU, no biasing and the round trip; 401 for a wrong key, never the key; the queue warning without the capability",
    async () => {
      const page = await openPage(rig);
      // The browser only ever talks to this akou; the remote is asked by the app alone.
      const browserHosts = new Set<string>();
      page.on("request", (r) => browserHosts.add(new URL(r.url()).host));

      const ok = await runTest(page);
      expect(ok.line).toMatch(/^ok, best on cpu, no biasing, \d+ ms$/);
      expect(ok.cls).toBe("pg-help");
      expect(remote.seen).toEqual(["/v1/server", "/v1/keys/me"]);

      // A wrong key: the refusal's status, and no trace of the key on the page.
      expect((await rig.api("PATCH", "/config", { "dictation.remote.key": WRONG })).status).toBe(
        200,
      );
      const refused = await runTest(page);
      expect(refused.line).toStartWith("401: ");
      expect(refused.cls).toBe("issue");
      // Marked like every other refusal on the page, not body text.
      expect(await colour(page, "#dictation-remote-result")).toBe(await colour(page, null));
      expect(await page.content()).not.toContain(WRONG);
      expect(await page.content()).not.toContain(RIGHT);

      // An akou from before the dictation lane: it works, and a dictation there queues.
      await rig.api("PATCH", "/config", { "dictation.remote.key": RIGHT });
      remote.state.caps = {};
      const older = await runTest(page);
      expect(older.line).toMatch(
        /^ok, best on cpu, no biasing, \d+ ms; this akou is older; dictation will queue$/,
      );
      // One with the lane switched off (server.dictation_slots: 0) says that instead.
      remote.state.caps = { interactive: false };
      expect((await runTest(page)).line).toEndWith(
        "this akou has no dictation slots (Dictations at once for other computers); dictation will queue",
      );

      expect([...browserHosts]).not.toContain(new URL(remote.url).host);
      expect(browserHosts.size).toBe(1);
    },
    UI_TIMEOUT,
  );

  test(
    "no local model installed: the page says the fallback ends in an error",
    async () => {
      // The reply the page reads is the route's own, in the shape the page expects.
      const st = (await rig.api("GET", "/dictation")).body;
      expect(st.fallback).toBe("error");
      expect(Object.keys(st.remote).sort()).toEqual(
        ["down", "error", "failures", "probing", "url"].sort(),
      );
      const page = await openPage(rig);
      await page.waitForSelector("#dictation-remote-standing:not([hidden])");
      expect(await text(page, "#dictation-remote-standing")).toBe(
        "No local model is installed, so a dictation the remote akou does not answer ends in an error instead of falling back.",
      );
    },
    UI_TIMEOUT,
  );
});

describe("DC-R3: the remote's standing on the page", () => {
  const url = "https://akou.example";
  const standing = (o: Partial<NonNullable<RemoteReply["remote"]>> = {}) => ({
    url,
    down: false,
    failures: 0,
    error: null,
    ...o,
  });
  const down = standing({ down: true, failures: 3, error: "http://127.0.0.1:9 is unreachable" });

  test("says nothing while the engine is local, or the remote answers and a local model is there", () => {
    expect(remoteStanding(null, "local")).toBeNull();
    expect(remoteStanding({ fallback: null, remote: null }, "local")).toBeNull();
    expect(remoteStanding({ fallback: "local", remote: standing() }, "local")).toBeNull();
    // `error` chosen on purpose is no news.
    expect(remoteStanding({ fallback: "error", remote: standing() }, "error")).toBeNull();
    // Two failures in a row are not down yet.
    expect(
      remoteStanding({ fallback: "local", remote: standing({ failures: 2 }) }, "local"),
    ).toBeNull();
  });

  test("down after three dictations in a row, with the reason and the probe's interval", () => {
    expect(remoteStanding({ fallback: "local", remote: down }, "local")).toBe(
      `The remote akou is down: 3 dictations in a row failed: http://127.0.0.1:9 is unreachable. akou checks it every ${REMOTE_PROBE_MS / 1000} s and clears this once it answers.`,
    );
  });

  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-remote-down-");
    rig = await uiRig({ home: t.dir, settings: { "dictation.engine": "remote" } });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  test(
    "positive control: with the local model there and the remote never failed, no standing line",
    async () => {
      const page = await openPage(rig);
      // The page's load and the panel each read it once.
      await until(() => page.answered() >= 2, 10_000, "GET /v1/dictation read twice");
      expect(await page.isHidden("#dictation-remote-standing")).toBe(true);
      expect(await text(page, "#dictation-remote-standing")).toBe("");
    },
    UI_TIMEOUT,
  );

  test(
    "the page shows a down remote from GET /v1/dictation, and a Test with no address says why",
    async () => {
      const page = await openPage(rig, (p) =>
        p.route(
          (u) => u.pathname === "/api/v1/dictation",
          (route) =>
            route.fulfill({
              status: 200,
              json: {
                enabled: false,
                state: "off",
                fallback: "local",
                remote: { ...down, url: "http://127.0.0.1:9", probing: true },
                grants: null,
              },
            }),
        ),
      );
      await page.waitForSelector("#dictation-remote-standing:not([hidden])");
      expect(await text(page, "#dictation-remote-standing")).toStartWith(
        "The remote akou is down: 3 dictations in a row failed: http://127.0.0.1:9 is unreachable.",
      );
      expect(await colour(page, "#dictation-remote-standing")).toBe(await colour(page, null));
      // No address set: the app's refusal, not a test result.
      const r = await runTest(page);
      // In the page's words: the setting is named by its label, never its key.
      expect(r.line).toBe("Address is empty: set the akou to test");
      expect(r.cls).toBe("issue");
    },
    UI_TIMEOUT,
  );
});
