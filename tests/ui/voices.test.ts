/**
 * Names found by voice in the window (docs/DESIGN.md section 3.5): a name akou found by voice reads
 * as not confirmed (dashed, with a voice mark) in the transcript, the People strip and the share
 * page; an offer keeps `c2?` with a muted "Ben?". The speaker's popover confirms with one
 * `POST /calls/{id}/speakers`, and refuses after one more press. Settings > Voices lists, renames
 * and forgets through the voices routes, and says so when recognition is off. On the real page over
 * the real headless app.
 */

import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../../src/core/log/events.ts";
import { LIVE_EMBEDDER } from "../../src/main/voices/host.ts";
import { VoiceStore, voicesPath } from "../../src/main/voices/store.ts";
import { tempDir } from "../helpers.ts";
import {
  launch,
  requestLog,
  screenshots,
  seedCall,
  standardCall,
  UI_TIMEOUT,
  type UiRig,
  uiRig,
  until,
} from "./rig.ts";

const CALL = "01J8Z6Q4M2VX0K7B3D4E5F6G7H";

async function withRig<T>(
  o: Parameters<typeof uiRig>[0] & { seed?: (home: string) => void },
  fn: (rig: UiRig) => Promise<T>,
): Promise<T> {
  const t = tempDir("akou-ui-");
  o.seed?.(t.dir);
  const rig = await uiRig({ ...o, home: t.dir });
  try {
    return await fn(rig);
  } finally {
    await rig.close();
    t.cleanup();
  }
}

/** The two-person call, with c1 named Ben by voice and c2 offered as Cy. */
function voicedCall(home: string): string {
  return seedCall(home, (b) => {
    standardCall(b, CALL);
    b.add({
      type: "speaker.voice",
      spk: "c1",
      name: "Ben",
      status: "named",
      score: 0.9,
      by: "app",
    });
    b.add({
      type: "speaker.voice",
      spk: "c2",
      name: "Cy",
      status: "offered",
      score: 0.7,
      by: "app",
    });
  }).id;
}

async function events(rig: UiRig, id: string): Promise<LogEvent[]> {
  return (await rig.api("GET", `/calls/${id}/events`)).body.events;
}

/** The page's API requests, as `METHOD /path` and the body sent. */
function apiCalls(log: ReturnType<typeof requestLog>): { what: string; body: unknown }[] {
  return log.all
    .filter((r) => new URL(r.url()).pathname.startsWith("/api/v1/"))
    .map((r) => ({
      what: `${r.method()} ${new URL(r.url()).pathname.replace("/api/v1", "")}`,
      body: r.postData() ? JSON.parse(r.postData() as string) : undefined,
    }));
}

/** Saves the page in both themes when `AKOU_UI_SHOTS` names a folder (docs/TESTING.md TS-15c). */
async function shoot(page: import("playwright-core").Page, name: string): Promise<void> {
  if (process.env.AKOU_UI_SHOTS) await screenshots(page, process.env.AKOU_UI_SHOTS, name);
}

const exemplar = (call: string, secs: number, at: string, spk = "c1") => ({
  model: LIVE_EMBEDDER,
  dim: 4,
  vec: Float32Array.from([1, 0, 0, 0]),
  secs,
  cons: 0.8,
  call,
  spk,
  at,
});

/** Ben, taught by the seeded call and an older one; Cy, by the older one. */
async function seedVoices(rig: UiRig): Promise<void> {
  const store = new VoiceStore(voicesPath(rig.app.configDir), { log: () => {} });
  await store.upsert("Ben", exemplar("01OLDERCALL0000000000000000", 40, "2026-09-01T10:00:00Z"));
  await store.upsert("Ben", exemplar(CALL, 80, new Date().toISOString()));
  await store.upsert(
    "Cy",
    exemplar("01OLDERCALL0000000000000000", 30, "2026-09-01T10:00:00Z", "c2"),
  );
}

async function openVoices(page: import("playwright-core").Page): Promise<void> {
  await page.click("#settings-open");
  await page.waitForSelector("#settings-voices li.voice");
}

describe("names found by voice in the window", () => {
  test(
    "a name found by voice is dashed with a voice mark and an offer keeps c2? with a muted name; a typed name is solid",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = voicedCall(home)) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector("#lines .row >> nth=3");
        const ben = page.locator('#lines .row[data-id="l000002"] .who');
        expect(await ben.textContent()).toBe("Ben");
        expect(await ben.getAttribute("class")).toContain("voice");
        expect(await ben.getAttribute("class")).toContain("provisional");
        expect(await ben.locator("svg.vmark").count()).toBe(1);
        expect(await ben.getAttribute("aria-label")).toStartWith(
          "Ben, recognised by voice, not confirmed",
        );
        const cy = page.locator('#lines .row[data-id="l000003"] .who');
        expect(await cy.locator(".offer").textContent()).toBe("Cy?");
        expect((await cy.textContent())?.startsWith("c2?")).toBe(true);
        expect(await cy.getAttribute("aria-label")).toContain("sounds like Cy");
        // The People strip marks the same.
        const strip = page.locator('#people li[data-spk="c1"]');
        expect(await strip.getAttribute("class")).toContain("voice");
        expect(await strip.locator(".who").getAttribute("aria-label")).toBe(
          "Ben, recognised by voice, not confirmed",
        );
        expect(await page.locator('#people li[data-spk="c2"] .offer').textContent()).toBe("Cy?");
        await shoot(page, "voices-transcript");
        // Positive control: a typed name reads solid, with no mark and no offer.
        expect(
          (await rig.api("POST", `/calls/${id}/speakers`, { spk: "c2", name: "Dee" })).status,
        ).toBe(200);
        await until(async () => (await cy.textContent()) === "Dee", 5000, "typed");
        expect(await cy.getAttribute("class")).not.toContain("provisional");
        expect(await cy.locator(".offer, svg.vmark").count()).toBe(0);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Yes confirms with exactly one POST /calls/:id/speakers; the name field and its one submit stay first",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = voicedCall(home)) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector("#lines .row >> nth=3");
        const before = (await events(rig, id)).length;
        const log = requestLog(page);
        await page.click('#lines .row[data-id="l000002"] .who');
        await page.waitForSelector("#popover:not([hidden])");
        expect(await page.locator("#popover").textContent()).toContain("Sounds like Ben");
        // The form the parity rows pin comes first: its input, then the one submit button.
        expect(await page.locator("#popover button[type=submit]").count()).toBe(1);
        expect(
          await page.evaluate(() => {
            const pop = document.getElementById("popover") as HTMLElement;
            const first = pop.querySelector("input, button");
            return first?.tagName;
          }),
        ).toBe("INPUT");
        await page.click("#popover .voice-yes");
        const who = page.locator('#lines .row[data-id="l000002"] .who');
        await until(
          async () => !(await who.getAttribute("class"))?.includes("voice"),
          5000,
          "confirmed",
        );
        expect(await who.textContent()).toBe("Ben");
        const after = await events(rig, id);
        expect(after.length).toBe(before + 1);
        expect(after.at(-1)).toMatchObject({
          type: "speaker.name",
          spk: "c1",
          name: "Ben",
          by: "user",
        });
        expect(apiCalls(log)).toEqual([
          { what: `POST /calls/${id}/speakers`, body: { spk: "c1", name: "Ben" } },
        ]);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Not Cy asks once more, then sends the refuse route, and the label shows no voice again",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = voicedCall(home)) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector("#lines .row >> nth=3");
        const log = requestLog(page);
        await page.click('#lines .row[data-id="l000003"] .who');
        await page.waitForSelector("#popover:not([hidden])");
        const no = page.locator("#popover .voice-no");
        expect(await no.textContent()).toBe("Not Cy");
        await no.click();
        expect(await no.textContent()).toBe("Not Cy: sure?");
        // The first press only asks.
        expect(apiCalls(log)).toEqual([]);
        await no.click();
        const who = page.locator('#lines .row[data-id="l000003"] .who');
        await until(async () => (await who.locator(".offer").count()) === 0, 5000, "refused");
        expect(await who.textContent()).toBe("c2?");
        expect(apiCalls(log)).toEqual([
          { what: `POST /calls/${id}/speakers/refuse`, body: { spk: "c2" } },
        ]);
        expect((await events(rig, id)).at(-1)).toMatchObject({
          type: "speaker.voice",
          spk: "c2",
          name: "Cy",
          status: "refused",
          by: "user",
        });
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a name an MCP agent gave offers Remember this voice, which names the speaker again as the user",
    async () => {
      let id = "";
      await withRig(
        {
          seed: (home) =>
            (id = seedCall(home, (b) => {
              standardCall(b, CALL);
              b.add({ type: "speaker.name", spk: "c2", name: "Eve", by: "agent:mcp" });
            }).id),
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          await page.click('#lines .row[data-id="l000003"] .who');
          await page.waitForSelector("#popover .voice-remember");
          await page.click("#popover .voice-remember");
          const last = async () => (await events(rig, id)).at(-1) as LogEvent & { by?: string };
          await until(
            async () => {
              const e = await last();
              return e?.type === "speaker.name" && e.by === "user";
            },
            5000,
            "named again by the user",
          );
          expect((await events(rig, id)).at(-1)).toMatchObject({ spk: "c2", name: "Eve" });
          // Positive control: a name the user typed has no such button.
          await page.click('#lines .row[data-id="l000003"] .who');
          await page.waitForSelector("#popover:not([hidden])");
          await Bun.sleep(300);
          expect(await page.locator("#popover .voice-remember").count()).toBe(0);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "the share page marks a name found by voice as the window does",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = voicedCall(home)) }, async (rig) => {
        const share = await rig.api("POST", "/share", { call: id });
        expect(share.status).toBe(201);
        const viewer = await (await launch()).newPage();
        try {
          await viewer.goto(share.body.url as string);
          await viewer.waitForSelector("#lines .row >> nth=3");
          const ben = viewer.locator('#lines .row[data-id="l000002"] .who');
          expect(await ben.textContent()).toBe("Ben");
          expect(await ben.getAttribute("class")).toContain("voice");
          expect(await ben.locator("svg.vmark").count()).toBe(1);
          expect(
            await viewer.locator('#lines .row[data-id="l000003"] .who .offer').textContent(),
          ).toBe("Cy?");
          // Confirmed in the window, the viewer shows it solid.
          expect(
            (await rig.api("POST", `/calls/${id}/speakers`, { spk: "c1", name: "Ben" })).status,
          ).toBe(200);
          await until(
            async () => !(await ben.getAttribute("class"))?.includes("voice"),
            5000,
            "confirmed in the viewer",
          );
          expect(await ben.locator("svg.vmark").count()).toBe(0);
        } finally {
          await viewer.close();
        }
      });
    },
    UI_TIMEOUT,
  );
});

describe("Settings > Voices", () => {
  test(
    "lists each person with calls, seconds and last heard; Forget this call, Forget and Forget all ask once more, then call the voices routes",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = voicedCall(home)) }, async (rig) => {
        await seedVoices(rig);
        const page = await rig.open(id);
        await openVoices(page);
        const ben = page.locator('#settings-voices li[data-name="Ben"]');
        expect(await ben.locator(".pg-help").first().textContent()).toBe(
          "2 calls · 2 min of speech · last heard Today",
        );
        expect(await page.locator("#settings-voices li.voice").count()).toBe(2);
        expect(await page.locator("#settings-voices .pg-sechelp").getAttribute("data-voices")).toBe(
          "on",
        );
        await ben.locator(".pg-link").click();
        await page.waitForSelector('#settings-voices li[data-name="Ben"] .voice-rename');
        await shoot(page, "voices-settings");
        const log = requestLog(page);
        // Forget what the seeded call taught: one press asks, the second sends.
        const forgetCall = ben.locator(`.pg-row[data-call="${id}"] .forget-call`);
        await forgetCall.click();
        expect(await forgetCall.textContent()).toBe("Forget: sure?");
        expect(apiCalls(log).filter((c) => c.what.startsWith("POST"))).toEqual([]);
        await forgetCall.click();
        await until(
          async () =>
            (await ben.locator(".pg-help").first().textContent())?.startsWith("1 call ") === true,
          5000,
          "the call forgotten",
        );
        // Forget Ben.
        const forget = ben.locator(".forget");
        await forget.click();
        await forget.click();
        await page.waitForSelector('#settings-voices li[data-name="Ben"]', { state: "detached" });
        // Forget all.
        const all = page.locator("#settings-voices .forget-all");
        await all.click();
        expect(await all.textContent()).toBe("Forget all for good?");
        await all.click();
        await page.waitForSelector("#settings-voices li.voices-none");
        expect(apiCalls(log).filter((c) => c.what.startsWith("POST"))).toEqual([
          { what: "POST /voices/forget", body: { name: "Ben", call: id } },
          { what: "POST /voices/forget", body: { name: "Ben" } },
          { what: "POST /voices/forget", body: { all: true } },
        ]);
        expect((await rig.api("GET", "/voices")).body.voices).toEqual([]);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Rename goes to the rename route, and onto a known name it asks once more first",
    async () => {
      await withRig({}, async (rig) => {
        await seedVoices(rig);
        const page = await rig.open();
        await openVoices(page);
        const cy = page.locator('#settings-voices li[data-name="Cy"]');
        await cy.locator(".pg-link").click();
        const log = requestLog(page);
        const input = cy.locator(".voice-rename input");
        await input.fill("ben");
        await cy.locator(".voice-rename .rename").click();
        expect(await cy.locator(".voice-rename .rename").textContent()).toBe("Join with Ben?");
        expect(apiCalls(log).filter((c) => c.what.startsWith("POST"))).toEqual([]);
        await input.fill("Cyrus");
        await cy.locator(".voice-rename .rename").click();
        await page.waitForSelector('#settings-voices li[data-name="Cyrus"]');
        expect(apiCalls(log).filter((c) => c.what.startsWith("POST"))).toEqual([
          { what: "POST /voices/rename", body: { from: "Cy", to: "Cyrus" } },
        ]);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "with recognition off the list says akou is not learning or naming voices, and still lists and forgets",
    async () => {
      await withRig({ settings: { "voices.enabled": false } }, async (rig) => {
        await seedVoices(rig);
        const page = await rig.open();
        await openVoices(page);
        const help = page.locator("#settings-voices .pg-sechelp");
        expect(await help.getAttribute("data-voices")).toBe("off");
        expect(await help.textContent()).toContain("akou is not learning or naming voices now");
        const cy = page.locator('#settings-voices li[data-name="Cy"]');
        await cy.locator(".pg-link").click();
        await page.waitForSelector('#settings-voices li[data-name="Cy"] .forget');
        // Rename answers 409 while it is off, so it is not offered.
        expect(await cy.locator(".voice-rename").count()).toBe(0);
        await cy.locator(".forget").click();
        await cy.locator(".forget").click();
        await page.waitForSelector('#settings-voices li[data-name="Cy"]', { state: "detached" });
        expect(
          ((await rig.api("GET", "/voices")).body.voices as { name: string }[]).map((v) => v.name),
        ).toEqual(["Ben"]);
      });
    },
    UI_TIMEOUT,
  );
});
