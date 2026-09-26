/**
 * The server-mode page in a real browser (docs/ux/SERVER.md section 12.4): after the admin login it
 * opens on Jobs, with Models, Keys and Settings beside it, and no recording control (SV-U7). The
 * Jobs page shows a job submitted from outside within a second and cancels it (SV-U4); the Keys
 * page creates a key that works from a client and shows it once (SV-U3); the Settings page holds
 * the server's defaults and no device picker (SV-U2, SV-S2). The same bundle in app mode still
 * shows the call window.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { readUploadAudio } from "../../src/main/server/audio.ts";
import { type AppRig, appRig } from "../api-helpers.ts";
import { asKey, clip, type Key, newKey, SERVER, submit } from "../server-helpers.ts";
import { launch, UI_TIMEOUT, until } from "./rig.ts";

const PASSWORD = "correct horse battery staple";

/** Holds every upload's decode until `open()`: the first job stays `running`. */
function gate() {
  let open = () => {};
  const held = new Promise<void>((r) => {
    open = r;
  });
  return {
    open: () => open(),
    decode: async (path: string, signal: AbortSignal) => {
      await held;
      return readUploadAudio(path, { signal });
    },
  };
}

const held = gate();
let rig: AppRig;
let app: AppRig;
let archive: Key;
const errors: string[] = [];

beforeAll(async () => {
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
  rig = await appRig({
    settings: { ...SERVER, "server.admin_password_hash": hash },
    jobs: { decode: held.decode },
  });
  archive = await newKey(rig, "archive");
});

afterAll(async () => {
  held.open();
  await rig?.close();
  await app?.close();
});

async function loggedIn(): Promise<Page> {
  const browser = await launch();
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${rig.port}/`);
  await page.waitForSelector("#login", { state: "visible" });
  await page.fill("#login-secret", PASSWORD);
  await page.click("#login-go");
  await page.waitForSelector("#server", { state: "visible" });
  return page;
}

/** The text of the jobs table's row for one job, or null. */
function rowText(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    (id) => document.querySelector(`#jobs-table tr[data-id="${id}"]`)?.textContent ?? null,
    id,
  );
}

describe("SV-U7: the server-mode page", () => {
  let page: Page;

  beforeAll(async () => {
    page = await loggedIn();
  }, UI_TIMEOUT);

  afterAll(async () => {
    await page?.context().close();
    expect(errors).toEqual([]);
  });

  test(
    "after login it opens on Jobs, links the four pages, and has no recording control",
    async () => {
      const current = await page.getAttribute("#server-nav [aria-current='page']", "data-page");
      expect(current).toBe("jobs");
      expect(await page.isVisible("#page-jobs")).toBe(true);
      for (const name of ["jobs", "models", "keys", "settings"]) {
        await page.click(`#server-nav [data-page="${name}"]`);
        await page.waitForSelector(`#page-${name}`, { state: "visible" });
        expect(await page.textContent(`#page-${name} h2`)).toBeTruthy();
        // One page at a time.
        const shown = await page.$$eval("#server-main > section:not([hidden])", (s) =>
          s.map((x) => x.id),
        );
        expect(shown).toEqual([`page-${name}`]);
      }
      // The call window is not on the page at all.
      for (const sel of ["#record", "#controls", "#meters", "#layout", "#note-input"]) {
        expect(await page.$(sel)).toBeNull();
      }
      await page.click('#server-nav [data-page="jobs"]');
    },
    UI_TIMEOUT,
  );

  test(
    "SV-U4: a job submitted from outside shows running within a second, opens, and cancels",
    async () => {
      const s = await submit(rig, archive.key, clip(["hello", "world"], 3), {
        metadata: '{"chat": 7}',
      });
      expect(s.status).toBe(202);
      const id = s.body.id as string;
      await until(
        async () => (await asKey(rig, archive.key, "GET", `/jobs/${id}`)).body.status === "running",
        10_000,
        "the job to run",
      );
      const t0 = performance.now();
      await until(
        async () => /running/.test((await rowText(page, id)) ?? ""),
        1500,
        "the running job on the dashboard",
      );
      expect(performance.now() - t0).toBeLessThan(1000);
      const row = (await rowText(page, id)) as string;
      expect(row).toContain("archive");

      // Filters: another state hides it, the state it is in shows it.
      await page.selectOption("#jobs-status", "done");
      await until(async () => (await rowText(page, id)) === null, 3000, "the state filter");
      await page.selectOption("#jobs-status", "running");
      await until(async () => (await rowText(page, id)) !== null, 3000, "the job again");
      await page.selectOption("#jobs-status", "");

      await page.click(`#jobs-table tr[data-id="${id}"] button.open`);
      await page.waitForSelector("#job-detail", { state: "visible" });
      await until(
        async () => ((await page.textContent("#job-detail")) ?? "").includes('"chat": 7'),
        3000,
        "the job's metadata",
      );

      // A client waiting on the job hears it end when the dashboard cancels it.
      const waiting = asKey(rig, archive.key, "GET", `/jobs/${id}?wait=30`);
      await page.click(`#jobs-table tr[data-id="${id}"] button.cancel`);
      // The first press asks; the second does it.
      expect(await page.textContent(`#jobs-table tr[data-id="${id}"] button.cancel`)).toContain(
        "Confirm",
      );
      await page.click(`#jobs-table tr[data-id="${id}"] button.cancel`);
      expect((await waiting).body.status).toBe("cancelled");
      await until(
        async () => (await asKey(rig, archive.key, "GET", `/jobs/${id}`)).status === 404,
        3000,
        "the job to be gone",
      );
      await until(async () => (await rowText(page, id)) === null, 3000, "the row to go");
      held.open();
    },
    UI_TIMEOUT,
  );

  test(
    "SV-U3: a key created in the browser works from a client and is never shown again",
    async () => {
      await page.click('#server-nav [data-page="keys"]');
      await page.waitForSelector("#page-keys", { state: "visible" });
      await until(
        async () => ((await page.textContent("#keys-table")) ?? "").includes("archive"),
        3000,
        "the CLI's key on the list",
      );
      await page.fill("#key-name", "viewer");
      await page.selectOption("#key-scope", "jobs");
      await page.fill("#key-hosts", "telegram-viewer");
      await page.click("#key-create");
      await page.waitForSelector("#key-created", { state: "visible" });
      const key = await page.inputValue("#key-created-key");
      const secret = await page.inputValue("#key-created-secret");
      expect(key).toMatch(/^ak_/);
      expect(secret).toMatch(/^whsec_/);

      const s = await submit(rig, key, clip(["ok"], 2));
      expect(s.status).toBe(202);
      await asKey(rig, key, "GET", `/jobs/${s.body.id}?wait=60`);

      await page.click("#key-created-close");
      await until(async () => (await page.$("#key-created")) === null, 3000, "the dialog to go");
      const html = await page.content();
      expect(html).not.toContain(key);
      expect(html).not.toContain(secret);
      const text = (await page.textContent("#keys-table")) ?? "";
      expect(text).toContain("viewer");
      expect(text).toContain("telegram-viewer");

      // Revoke, with the same two presses: its next request gets 401.
      const id = (await asKey(rig, archive.key, "GET", "/keys/me")).body.id;
      expect(id).toBe(archive.id);
      const viewerId = await page.$eval(
        "#keys-table tr[data-name='viewer']",
        (tr) => (tr as HTMLElement).dataset.id,
      );
      await page.click(`#keys-table tr[data-id="${viewerId}"] button.revoke`);
      await page.click(`#keys-table tr[data-id="${viewerId}"] button.revoke`);
      await until(
        async () => (await page.$(`#keys-table tr[data-id="${viewerId}"]`)) === null,
        3000,
        "the revoked key to leave the list",
      );
      expect((await asKey(rig, key, "GET", "/keys/me")).status).toBe(401);
    },
    UI_TIMEOUT,
  );

  test(
    "SV-U2: the settings page holds the server's defaults and no device picker; a save applies",
    async () => {
      await page.click('#server-nav [data-page="settings"]');
      await page.waitForSelector("#page-settings [data-key='server.default_language']");
      for (const key of [
        "server.default_language",
        "server.default_diarize",
        "server.retain_days",
      ]) {
        expect(await page.$(`#page-settings [data-key='${key}']`)).not.toBeNull();
      }
      for (const key of ["capture.mic", "capture.call", "app.hotkey"]) {
        expect(await page.$(`#page-settings [data-key='${key}']`)).toBeNull();
      }
      // Network settings are shown, never editable here.
      expect(await page.isDisabled("#page-settings input[data-key='api.bind']")).toBe(true);

      await page.fill("#page-settings input[data-key='server.default_language']", "not a tag");
      await page.click("#settings-save");
      await until(
        async () =>
          (
            await page.getAttribute(
              "#page-settings div[data-key='server.default_language']",
              "class",
            )
          )?.includes("refused") === true,
        3000,
        "the refusal on the field",
      );
      await page.fill("#page-settings input[data-key='server.default_language']", "es");
      await page.check("#page-settings input[data-key='server.default_diarize']");
      await page.click("#settings-save");
      await until(
        async () =>
          (await rig.api("GET", "/config")).body.settings["server.default_language"] === "es",
        3000,
        "the saved language",
      );
      expect((await rig.api("GET", "/config")).body.settings["server.default_diarize"]).toBe(true);
    },
    UI_TIMEOUT,
  );

  test(
    "SV-U6: the models page says whether the speech models are on disk",
    async () => {
      await page.click('#server-nav [data-page="models"]');
      await until(
        async () => ((await page.textContent("#models-state")) ?? "").includes("on disk"),
        3000,
        "the models' state",
      );
    },
    UI_TIMEOUT,
  );
});

describe("app mode", () => {
  test(
    "the same bundle shows the call window, not the server's pages",
    async () => {
      app = await appRig();
      const url = (await app.api("POST", "/window", {})).body.url as string;
      const browser = await launch();
      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        await page.goto(url);
        await page.waitForSelector("#record", { state: "visible" });
        expect(await page.$("#server")).toBeNull();
      } finally {
        await ctx.close();
      }
    },
    UI_TIMEOUT,
  );
});
