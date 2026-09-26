/**
 * SV-U1 in a real browser: server mode's page asks for the admin password, a wrong one is refused
 * after its delay, a right one shows the server's pages, and the session dies with the tab, as it lives
 * in `sessionStorage` and never in a cookie.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type AppRig, appRig } from "../api-helpers.ts";
import { launch, UI_TIMEOUT, until } from "./rig.ts";

const PASSWORD = "correct horse battery staple";

let rig: AppRig;

beforeAll(async () => {
  // The hash `akou admin set-password` writes (its own test is tests/server-login.e2e.test.ts).
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
  rig = await appRig({
    settings: {
      "server.enabled": true,
      "api.bind": "127.0.0.1",
      "server.admin_password_hash": hash,
    },
  });
});

afterAll(async () => {
  await rig?.close();
});

describe("SV-U1: the admin login in a browser", () => {
  test(
    "a wrong password is refused, a right one shows the server's pages, and a new tab asks again",
    async () => {
      const browser = await launch();
      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${rig.port}/`);
        await page.waitForSelector("#login", { state: "visible" });
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("login-secret");

        await page.fill("#login-secret", "not the password");
        const t0 = performance.now();
        await page.click("#login-go");
        await until(
          async () => (await page.textContent("#login-error")) === "Wrong password or key.",
          8000,
          "the refusal",
        );
        expect(performance.now() - t0).toBeGreaterThanOrEqual(1900);
        expect(await page.isVisible("#login")).toBe(true);

        await page.fill("#login-secret", PASSWORD);
        await page.click("#login-go");
        await page.waitForSelector("#login", { state: "hidden" });
        // Server mode shows the server's pages (SV-U7, tests/ui/server-page.test.ts).
        await page.waitForSelector("#server", { state: "visible", timeout: 8000 });
        expect(await page.isVisible("#fatal")).toBe(false);
        // The session is the tab's: sessionStorage, and no cookie at all.
        expect(await page.evaluate(() => sessionStorage.getItem("akou.session"))).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(await ctx.cookies()).toEqual([]);

        // A reload keeps the tab's session.
        await page.reload();
        await page.waitForSelector("#server", { state: "visible", timeout: 8000 });
        expect(await page.isVisible("#login")).toBe(false);

        // A new tab of the same browser starts with nothing: the session died with its tab.
        const other = await ctx.newPage();
        await other.goto(`http://127.0.0.1:${rig.port}/`);
        await other.waitForSelector("#login", { state: "visible" });
        expect(await other.evaluate(() => sessionStorage.getItem("akou.session"))).toBeNull();
      } finally {
        await ctx.close();
      }
    },
    UI_TIMEOUT,
  );
});
