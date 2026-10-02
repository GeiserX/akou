/**
 * Server mode's Dictation page in a real browser (docs/ux/DICTATION.md DC-U1, DC-G6): after the
 * admin login it sits beside Jobs, Models, Keys and Settings, shows the Server group and the count
 * of dictation requests served in the last hour, and nothing of the app's groups: no key, no
 * engine picker, and never the remote's address. Over plain http from another host the page says
 * it has no microphone instead of offering to record. The dictation keys and the count come from
 * fixtures (`rig.ts`), and twice from the server's own registry and `GET /v1/server`: once as
 * it starts, once after a real interactive transcription, whose key the Keys page then shows used.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BrowserContext, Page } from "playwright-core";
import { RECOGNIZER } from "../../src/main/asr/models.ts";
import { NO_MIC_NOTICE } from "../../src/ui/dictation-page.ts";
import { type AppRig, appRig } from "../api-helpers.ts";
import { clip, newKey, SERVER } from "../server-helpers.ts";
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
): Promise<{ page: Page; fx: DictationFixture | null }> {
  const context = await (await launch()).newContext();
  contexts.push(context);
  const local = `http://127.0.0.1:${rig.port}`;
  if (origin) await proxyRoute(context, origin, local);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  // Without the fixture the keys, the count and the save are the server's own.
  const fx =
    o.fixture === false
      ? null
      : await dictationFixture(page, {
          schema: { ...DICTATION_SCHEMA, ...DICTATION_SERVER_SCHEMA },
          server: { slots: 1, engine: "auto", served_last_hour: 3 },
          proxy: origin ? { from: origin, to: local } : undefined,
        });
  // The registry's default, which the fixture's schema does not carry.
  if (fx) fx.settings["server.dictation_engine"] = "auto";
  await page.goto(`${origin ?? local}/#dictation`);
  await page.waitForSelector("#login", { state: "visible" });
  await page.fill("#login-secret", PASSWORD);
  await page.click("#login-go");
  await page.waitForSelector("#page-dictation section[data-section='For other computers']", {
    state: "visible",
  });
  return { page, fx };
}

describe("DC-U1, DC-G6: the Dictation page in server mode", () => {
  test(
    "shows the dictations for other computers and the count only, saves one key, and needs no microphone",
    async () => {
      const { page, fx } = await dictationPage();
      if (!fx) throw new Error("the fixture is on unless turned off");
      expect(await page.getAttribute("#server-nav [aria-current='page']", "data-page")).toBe(
        "dictation",
      );
      const groups = await page.$$eval("#page-dictation section.pg-section", (g) =>
        g.map((x) => x.getAttribute("data-section")),
      );
      expect(groups).toEqual(["For other computers"]);
      // The same rows as the window's pages: a label in words, never the key.
      expect(await page.textContent("#page-dictation")).not.toContain("server.dictation");
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
      // What a client needs, since the page has no row for it.
      expect(await page.textContent("#dictation-jobs-key")).toBe(
        "Other computers dictate with a jobs key from the Keys page.",
      );
      // Loopback is a secure context: no notice.
      expect(await page.$("#dictation-no-mic")).toBeNull();

      await page.fill("#page-dictation [data-key='server.dictation_slots']:not(div)", "2");
      await page.press("#page-dictation [data-key='server.dictation_slots']:not(div)", "Tab");
      await until(() => fx.patches.length === 1, 5000, "the save");
      expect(fx.patches).toEqual([{ "server.dictation_slots": 2 }]);

      // The engine is a choice in words, never the raw value in a text field, with a way to name
      // a model by its id, which the setting takes too.
      const engine = "#page-dictation select#set-server-dictation-engine";
      const choices = await page.$$eval(`${engine} option`, (o) => o.map((x) => x.textContent));
      expect(choices[0]).toBe("Automatic");
      expect(choices).toContain("Fast");
      expect(choices).toContain("Best");
      expect(choices.at(-1)).toBe("A model, by its id…");
      expect(await page.inputValue(engine)).toBe("auto");
      await page.selectOption(engine, "best");
      await until(() => fx.patches.length === 2, 5000, "the engine saved");
      expect(fx.patches[1]).toEqual({ "server.dictation_engine": "best" });
      const typed = "#page-dictation #set-server-dictation-engine-typed";
      expect(await page.isVisible(typed)).toBe(false);
      await page.selectOption(engine, "~");
      await page.waitForSelector(typed, { state: "visible" });
      // Choosing to type saves nothing until a model is named.
      expect(fx.patches).toHaveLength(2);
      await page.fill(typed, "qwen3-asr-1.7b");
      await page.press(typed, "Tab");
      await until(() => fx.patches.length === 3, 5000, "the model saved");
      expect(fx.patches[2]).toEqual({ "server.dictation_engine": "qwen3-asr-1.7b" });

      // The count is read again each time the page is shown.
      fx.server = { slots: 2, engine: "auto", served_last_hour: 4 };
      await page.click("#server-nav [data-page='jobs']");
      await page.click("#server-nav [data-page='dictation']");
      await page.waitForFunction(() =>
        document.getElementById("dictation-served")?.textContent?.endsWith(": 4"),
      );
      // Drawn again, the model named is the choice shown, by its id.
      expect(await page.inputValue(engine)).toBe("qwen3-asr-1.7b");
    },
    UI_TIMEOUT,
  );

  test(
    "on the real registry and GET /v1/server: the section for other computers, the count, and one key saved",
    async () => {
      const { page } = await dictationPage(undefined, { fixture: false });
      const patches: unknown[] = [];
      page.on("request", (r) => {
        if (r.method() === "PATCH" && r.url().endsWith("/config")) patches.push(r.postDataJSON());
      });
      expect(
        await page.$$eval("#page-dictation section.pg-section", (g) =>
          g.map((x) => x.getAttribute("data-section")),
        ),
      ).toEqual(["For other computers"]);
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
      // The engine is a select in words: Automatic, the presets, each model by its name.
      const engine = "#page-dictation select#set-server-dictation-engine";
      expect(
        await page.$eval(engine, (x) => (x as HTMLSelectElement).selectedOptions[0]?.text),
      ).toBe("Automatic");
      const words = await page.$$eval(`${engine} option`, (o) => o.map((x) => x.textContent));
      expect(words).toContain("Parakeet v3");
      expect(words).not.toContain(RECOGNIZER);
      await page.selectOption(engine, "best");
      await until(
        async () =>
          (await rig.api("GET", "/config")).body.settings["server.dictation_engine"] === "best",
        5000,
        "the engine saved",
      );
      expect(patches).toEqual([
        { "server.dictation_slots": 2 },
        { "server.dictation_engine": "best" },
      ]);
      // The next test dictates with no model named: back to the server's default.
      expect(
        (await rig.api("PATCH", "/config", { "server.dictation_engine": "auto" })).status,
      ).toBe(200);
    },
    UI_TIMEOUT,
  );

  test(
    "an interactive request raises the count, and the dictating client is a key with its last use",
    async () => {
      const set = await rig.api("PATCH", "/config", { "server.dictation_slots": 1 });
      expect(set.status).toBe(200);
      const k = await newKey(rig, "dictating-client");
      const { page } = await dictationPage(undefined, { fixture: false });
      const served = async () =>
        Number((await page.textContent("#dictation-served"))?.split(": ").at(-1));
      const before = await served();
      const row = "#keys-table tr[data-name='dictating-client'] td:nth-child(6)";
      await page.click("#server-nav [data-page='keys']");
      await page.waitForSelector(row);
      // Positive control: no request came from it yet.
      expect(await page.textContent(row)).toBe("never");

      // A dictation as a client sends it: the OpenAI endpoint, marked interactive.
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(clip(["hello", "world"], 2))]), "d.wav");
      form.append("interactive", "true");
      const res = await fetch(`http://127.0.0.1:${rig.port}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${k.key}` },
        body: form,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { text: string }).text).toContain("hello world");

      await page.click("#server-nav [data-page='dictation']");
      await page.waitForFunction(
        (n) => document.getElementById("dictation-served")?.textContent?.endsWith(`: ${n}`),
        before + 1,
      );
      await page.click("#server-nav [data-page='keys']");
      await page.waitForFunction((sel) => {
        const t = document.querySelector(sel)?.textContent;
        return !!t && t !== "never";
      }, row);
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
      const names = await page.$$eval("button", (b) => b.map((x) => x.textContent ?? ""));
      expect(names.filter((n) => /^\W*Record/.test(n))).toEqual([]);
    },
    UI_TIMEOUT,
  );
});
