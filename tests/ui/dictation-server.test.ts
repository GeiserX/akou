/**
 * Server mode's Dictation page in a real browser (docs/ux/DICTATION.md DC-U1, DC-G6): after the
 * admin login it sits beside Jobs, Models, Keys and Settings, shows the Server group and the count
 * of dictation requests served in the last hour, and nothing of the app's groups: no key, no
 * engine picker, and never the remote's address. Over plain http from another host the page says
 * it has no microphone instead of offering to record. The dictation keys and the count come from
 * fixtures (`rig.ts`), and once from the server's own registry and `GET /v1/server`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BrowserContext, Page } from "playwright-core";
import { NO_MIC_NOTICE } from "../../src/ui/dictation-page.ts";
import { type AppRig, appRig } from "../api-helpers.ts";
import { SERVER } from "../server-helpers.ts";
import {
  DICTATION_SCHEMA,
  DICTATION_SERVER_SCHEMA,
  type DictationFixture,
  dictationFixture,
  launch,
  proxyRoute,
  UI_TIMEOUT,
  until,
} from "./rig.ts";

const PASSWORD = "correct horse battery staple";
/** A host that is not this machine, reached through the browser's router: not a secure context. */
const REMOTE = "http://akou.test";

let rig: AppRig;
const errors: string[] = [];
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
  rig = await appRig({ settings: { ...SERVER, "server.admin_password_hash": hash } });
}, UI_TIMEOUT);

afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await rig?.close();
  expect(errors).toEqual([]);
});

/**
 * Logs in on the Dictation page. `origin`: where the browser thinks the page is; anything but the
 * app's own loopback address is carried to it by the router.
 */
async function dictationPage(
  origin?: string,
  o: { fixture?: boolean } = {},
): Promise<{ page: Page; fx: DictationFixture }> {
  const context = await (await launch()).newContext();
  contexts.push(context);
  const local = `http://127.0.0.1:${rig.port}`;
  if (origin) await proxyRoute(context, origin, local);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  // Without the fixture the keys, the count and the save are the server's own.
  const fx =
    o.fixture === false
      ? (null as unknown as DictationFixture)
      : await dictationFixture(page, {
          schema: { ...DICTATION_SCHEMA, ...DICTATION_SERVER_SCHEMA },
          server: { slots: 1, engine: "auto", served_last_hour: 3 },
          proxy: origin ? { from: origin, to: local } : undefined,
        });
  await page.goto(`${origin ?? local}/#dictation`);
  await page.waitForSelector("#login", { state: "visible" });
  await page.fill("#login-secret", PASSWORD);
  await page.click("#login-go");
  await page.waitForSelector("#page-dictation fieldset[data-group='Server']", {
    state: "visible",
  });
  return { page, fx };
}

describe("DC-U1, DC-G6: the Dictation page in server mode", () => {
  test(
    "shows the Server group and the count only, saves one key, and needs no microphone",
    async () => {
      const { page, fx } = await dictationPage();
      expect(await page.getAttribute("#server-nav [aria-current='page']", "data-page")).toBe(
        "dictation",
      );
      const groups = await page.$$eval("#page-dictation fieldset", (g) =>
        g.map((x) => x.getAttribute("data-group")),
      );
      expect(groups).toEqual(["Server"]);
      const keys = await page.$$eval("#page-dictation [data-key]:not(div)", (e) =>
        e.map((x) => (x as HTMLElement).dataset.key),
      );
      expect(keys).toEqual(["server.dictation_slots", "server.dictation_engine"]);
      // The app's keys are in the fixture's registry, and still not on this page.
      expect(await page.$("[data-key='dictation.remote.url']")).toBeNull();
      expect(await page.$("[data-key='dictation.enabled']")).toBeNull();
      expect(await page.textContent("#dictation-served")).toBe(
        "Dictation requests served in the last hour: 3",
      );
      // Loopback is a secure context: no notice.
      expect(await page.$("#dictation-no-mic")).toBeNull();

      await page.fill("#page-dictation [data-key='server.dictation_slots']:not(div)", "2");
      await page.press("#page-dictation [data-key='server.dictation_slots']:not(div)", "Tab");
      await until(() => fx.patches.length === 1, 5000, "the save");
      expect(fx.patches).toEqual([{ "server.dictation_slots": 2 }]);

      // The count is read again each time the page is shown.
      fx.server = { slots: 2, engine: "auto", served_last_hour: 4 };
      await page.click("#server-nav [data-page='jobs']");
      await page.click("#server-nav [data-page='dictation']");
      await page.waitForFunction(() =>
        document.getElementById("dictation-served")?.textContent?.endsWith(": 4"),
      );
    },
    UI_TIMEOUT,
  );

  test(
    "on the real registry and GET /v1/server: the Server group, the count, and one key saved",
    async () => {
      const { page } = await dictationPage(undefined, { fixture: false });
      const patches: unknown[] = [];
      page.on("request", (r) => {
        if (r.method() === "PATCH" && r.url().endsWith("/config")) patches.push(r.postDataJSON());
      });
      expect(
        await page.$$eval("#page-dictation fieldset", (g) =>
          g.map((x) => x.getAttribute("data-group")),
        ),
      ).toEqual(["Server"]);
      const keys = await page.$$eval("#page-dictation [data-key]:not(div)", (e) =>
        e.map((x) => (x as HTMLElement).dataset.key),
      );
      expect(keys).toEqual(["server.dictation_slots", "server.dictation_engine"]);
      // No dictation request reached this server yet.
      expect(await page.textContent("#dictation-served")).toBe(
        "Dictation requests served in the last hour: 0",
      );
      const slots = "#page-dictation [data-key='server.dictation_slots']:not(div)";
      await page.fill(slots, "2");
      await page.press(slots, "Tab");
      await until(() => patches.length === 1, 5000, "the save");
      expect(patches).toEqual([{ "server.dictation_slots": 2 }]);
      await until(
        async () => (await rig.api("GET", "/config")).body.settings["server.dictation_slots"] === 2,
        5000,
        "the value saved",
      );
    },
    UI_TIMEOUT,
  );

  test(
    "over plain http from another host the page says it has no microphone and offers no recording",
    async () => {
      const { page } = await dictationPage(REMOTE);
      expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
      expect(await page.textContent("#dictation-no-mic")).toBe(NO_MIC_NOTICE);
      expect(await page.$("#record")).toBeNull();
      expect(await page.$$eval("button", (b) => b.map((x) => x.textContent))).not.toContain(
        "● Record",
      );
    },
    UI_TIMEOUT,
  );
});
