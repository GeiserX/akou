/**
 * Names found by voice in the window (docs/DESIGN.md section 3.5): a name akou found by voice reads
 * as not confirmed (dashed, with a voice mark) in the transcript, the People strip and the share
 * page; an offer keeps `c2?` with a muted "Ben?" in the window and never reaches the share page.
 * The speaker's popover confirms with one `POST /calls/{id}/speakers` and refuses with one press.
 * Settings > Voices lists, renames and forgets through the voices routes, and says so when
 * recognition is off. Text that leaves the chip marks the name `Ben (voice)`. On the real page over
 * the real headless app.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { formatWall } from "../../src/core/log/clock.ts";
import type { LogEvent } from "../../src/core/log/events.ts";
import { LIVE_EMBEDDER } from "../../src/main/voices/host.ts";
import { VoiceStore, voicesPath } from "../../src/main/voices/store.ts";
import { tempDir } from "../helpers.ts";
import {
  CLIPBOARD_PERMISSIONS,
  FakeProvider,
  launch,
  requestLog,
  screenshots,
  seedCall,
  standardCall,
  T0,
  TZ,
  UI_TIMEOUT,
  type UiRig,
  uiRig,
  until,
  windowPage,
} from "./rig.ts";

const CALL = "01J8Z6Q4M2VX0K7B3D4E5F6G7H";

/** A call id (a ULID) made at `ms`: its first 10 characters are the time, in Crockford base 32. */
function ulidAt(ms: number): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = "";
  for (let n = ms, i = 0; i < 10; i++, n = Math.floor(n / 32)) t = A[n % 32] + t;
  return `${t}${"0".repeat(16)}`;
}

/** A call the window has not loaded, made on 1 August at noon UTC. */
const OLDER = ulidAt(Date.UTC(2026, 7, 1, 12));

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

/**
 * Saves the page in both themes when `AKOU_UI_SHOTS` names a folder (docs/TESTING.md TS-15c),
 * once every animation that ends (a row's rise, a fade) has ended.
 */
async function shoot(page: Page, name: string): Promise<void> {
  if (!process.env.AKOU_UI_SHOTS) return;
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  await screenshots(page, process.env.AKOU_UI_SHOTS, name);
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
  await store.upsert("Ben", exemplar(OLDER, 40, "2026-09-01T10:00:00Z"));
  await store.upsert("Ben", exemplar(CALL, 80, new Date().toISOString()));
  await store.upsert("Cy", exemplar(OLDER, 30, "2026-09-01T10:00:00Z", "c2"));
}

async function openVoices(page: Page): Promise<void> {
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
        // The form the parity rows pin comes first: its input, then the one submit button, the
        // popover's one primary button. Yes says what it confirms.
        expect(await page.locator("#popover button[type=submit]").count()).toBe(1);
        expect(await page.locator("#popover button.go").count()).toBe(1);
        expect(await page.locator("#popover .voice-yes").textContent()).toBe("Yes, it is Ben");
        await shoot(page, "voices-popover");
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
    "Not Cy sends the refuse route at one press, says so, and the label shows no voice again",
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
        await page.waitForFunction(
          () => document.getElementById("toast")?.textContent === "Name taken off this speaker.",
        );
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
          expect(await page.getAttribute("#popover", "data-remember")).toBe("shown");
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
          // A name the user typed has no such button.
          await page.click('#lines .row[data-id="l000003"] .who');
          await page.waitForSelector("#popover[data-remember]");
          expect(await page.getAttribute("#popover", "data-remember")).toBe("no");
          expect(await page.locator("#popover .voice-remember").count()).toBe(0);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "an open popover follows the speaker's voice: a withdrawn name leaves it, a new offer comes in",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = voicedCall(home)) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector("#lines .row >> nth=3");
        await page.click('#lines .row[data-id="l000003"] .who');
        await page.waitForSelector("#popover .pop-voice");
        // akou withdraws Cy while the popover is open.
        await rig.write(id, {
          type: "speaker.voice",
          spk: "c2",
          name: "Cy",
          status: "refused",
          by: "app",
        });
        await page.waitForSelector("#popover .pop-voice", { state: "detached" });
        expect(await page.locator("#popover").isVisible()).toBe(true);
        // A new offer comes in: the row is back, for the new name, after the name field.
        await rig.write(id, {
          type: "speaker.voice",
          spk: "c2",
          name: "Dee",
          status: "offered",
          score: 0.7,
          by: "app",
        });
        await page.waitForSelector("#popover .pop-voice");
        expect(await page.locator("#popover .voice-yes").textContent()).toBe("Yes, it is Dee");
        expect(
          await page.evaluate(
            () => document.querySelector("#popover form.pop-row")?.nextElementSibling?.className,
          ),
        ).toBe("pop-voice");
      });
    },
    UI_TIMEOUT,
  );

  test(
    "a request that never reaches akou says so, for Yes and for Not",
    async () => {
      let id = "";
      await withRig({ seed: (home) => (id = voicedCall(home)) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector("#lines .row >> nth=3");
        await page.route("**/speakers**", (r) => r.abort());
        const toast = () => page.evaluate(() => document.getElementById("toast")?.textContent);
        for (const [line, button] of [
          ["l000002", ".voice-yes"],
          ["l000003", ".voice-no"],
        ] as const) {
          await page.evaluate(() => {
            const t = document.getElementById("toast");
            if (t) t.textContent = "";
          });
          await page.click(`#lines .row[data-id="${line}"] .who`);
          await page.waitForSelector(`#popover ${button}`);
          await page.click(`#popover ${button}`);
          await until(
            async () => (await toast()) === "That did not work: akou did not answer.",
            5000,
            `the failure of ${button}`,
          );
          // The popover stays, to try again.
          expect(await page.locator("#popover").isVisible()).toBe(true);
          await page.keyboard.press("Escape");
        }
      });
    },
    UI_TIMEOUT,
  );

  test(
    "Remember this voice is offered only for an MCP agent's name, and only while akou learns voices",
    async () => {
      const seed = (home: string) =>
        seedCall(home, (b) => {
          standardCall(b, CALL);
          b.add({ type: "speaker.name", spk: "c1", name: "Cli", by: "agent:cli" });
          b.add({ type: "speaker.name", spk: "c2", name: "Eve", by: "agent:mcp" });
        }).id;
      const decided = async (page: Page, line: string) => {
        await page.click(`#lines .row[data-id="${line}"] .who`);
        await page.waitForSelector("#popover[data-remember]:not([data-remember='reading'])");
        const d = await page.getAttribute("#popover", "data-remember");
        const n = await page.locator("#popover .voice-remember").count();
        await page.keyboard.press("Escape");
        return [d, n];
      };
      let id = "";
      await withRig({ seed: (home) => (id = seed(home)) }, async (rig) => {
        const page = await rig.open(id);
        await page.waitForSelector("#lines .row >> nth=3");
        // A name from the CLI already teaches: no button.
        expect(await decided(page, "l000002")).toEqual(["no", 0]);
        // Positive control: the MCP agent's name has it.
        expect(await decided(page, "l000003")).toEqual(["shown", 1]);
      });
      await withRig(
        { seed: (home) => (id = seed(home)), settings: { "voices.enabled": false } },
        async (rig) => {
          const page = await rig.open(id);
          await page.waitForSelector("#lines .row >> nth=3");
          // With recognition off, naming again would teach nothing: no button.
          expect(await decided(page, "l000003")).toEqual(["off", 0]);
        },
      );
    },
    UI_TIMEOUT,
  );

  test(
    "a copied line, an answer's citation, the words to review and the speaker preset mark a name found by voice",
    async () => {
      let id = "";
      const provider = new FakeProvider();
      provider.answer = () => "Ben moved the build [#l000002].";
      await withRig(
        {
          provider,
          seed: (home) =>
            (id = seedCall(home, (b) => {
              standardCall(b, CALL);
              b.add({
                type: "speaker.voice",
                spk: "c1",
                name: "Ben",
                status: "named",
                score: 0.9,
                by: "app",
              });
              b.add({ type: "speaker.name", spk: "c2", name: "Dee", by: "user" });
              b.add({
                type: "vocab.propose",
                id: "p1",
                rev: 1,
                term: "Hetzner",
                heard: ["hetzna"],
                by: "agent:mcp",
                evidence: { lines: ["l000002", "l000003"] },
                status: "proposed",
              });
            }).id),
        },
        async (rig) => {
          const page = await rig.open(id);
          await page.context().grantPermissions([...CLIPBOARD_PERMISSIONS]);
          await page.waitForSelector("#lines .row >> nth=3");
          const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
          const copy = async (line: string) => {
            await page.evaluate(() => navigator.clipboard.writeText("before"));
            await page.click(`#lines .row[data-id="${line}"] .text`, { button: "right" });
            await page.click('#line-menu [role="menuitem"] >> text="Copy with time and speaker"');
            await until(async () => (await clipboard()) !== "before", 5000, "the copy");
            return clipboard();
          };
          expect(await copy("l000002")).toBe(
            `[${formatWall(T0 + 3000, TZ)} Ben (voice)] we should move the build to the new box`,
          );
          // Positive control: a typed name is copied as it is.
          expect(await copy("l000003")).toBe(
            `[${formatWall(T0 + 6000, TZ)} Dee] deploy to hetzner today`,
          );
          await page.fill("#ask-input", "who moved the build");
          await page.keyboard.press("Enter");
          await page.waitForSelector("#ask-out .answer button.cite");
          const minute = formatWall(T0 + 3000, TZ, { seconds: false });
          expect(await page.getAttribute("#ask-out .answer button.cite", "aria-label")).toBe(
            `Show and play ${minute} Ben (voice)`,
          );
          const review = (await rig.api("GET", `/calls/${id}/vocab`)).body.review;
          expect(review.proposals[0].lines.map((l: { speaker: string }) => l.speaker)).toEqual([
            "Ben (voice)",
            "Dee",
          ]);
          const presets = (await rig.api("GET", `/presets?call=${id}`)).body.presets as {
            label: string;
            question: string;
            speaker?: string;
          }[];
          const said = presets.filter((p) => p.speaker !== undefined);
          expect(said.map((p) => p.label)).toEqual([
            "What did Ben (voice) say?",
            "What did Dee say?",
          ]);
          // The question asks about Ben: the pack tells the model the name is unconfirmed.
          expect(said[0]?.question).toContain("What did Ben say");
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
          // The chip does nothing there: it says who, at full strength, and no action.
          expect(await ben.getAttribute("aria-label")).toBe(
            "Ben, recognised by voice, not confirmed",
          );
          expect(await ben.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
          // An offer is a guess the user never confirmed: it never leaves the window.
          const cy = viewer.locator('#lines .row[data-id="l000003"] .who');
          expect(await cy.textContent()).toBe("Speaker 2");
          expect(await cy.locator(".offer").count()).toBe(0);
          await shoot(viewer, "voices-share");
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
        const older = ben.locator(`.pg-row[data-call="${OLDER}"]`);
        expect(await older.locator(".pg-name").textContent()).toBe("Learned in an older call");
        expect(await older.locator(".pg-help").textContent()).toBe("1 Aug");
        // A call id is never shown.
        expect(await page.locator("#settings-voices").textContent()).not.toContain(OLDER);
        await shoot(page, "voices-settings");
        const log = requestLog(page);
        // Forget what the seeded call taught: one press asks, the second sends.
        const forgetCall = ben.locator(`.pg-row[data-call="${id}"] .forget-call`);
        await forgetCall.click();
        expect(await forgetCall.textContent()).toBe("Forget this call: sure?");
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
        expect(await forget.textContent()).toBe("Forget: sure?");
        await forget.click();
        await page.waitForSelector('#settings-voices li[data-name="Ben"]', { state: "detached" });
        // Forget all.
        const all = page.locator("#settings-voices .forget-all");
        await all.click();
        expect(await all.textContent()).toBe("Forget all: sure?");
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

  test(
    "a voices.yaml akou cannot read still offers Forget all, which deletes it",
    async () => {
      await withRig({}, async (rig) => {
        writeFileSync(voicesPath(rig.app.configDir), "people: [not: a, list");
        const page = await rig.open();
        await page.click("#settings-open");
        await page.waitForSelector("#settings-voices .forget-all");
        expect(await page.locator("#settings-voices").textContent()).toContain(
          "The voices could not be read",
        );
        await page.click("#settings-voices .forget-all");
        await page.click("#settings-voices .forget-all");
        await page.waitForSelector("#settings-voices li.voices-none");
        expect((await rig.api("GET", "/voices")).body.voices).toEqual([]);
      });
    },
    UI_TIMEOUT,
  );

  test(
    "turning the switch off in the window says at once that akou is not learning or naming voices",
    async () => {
      await withRig({}, async (rig) => {
        await seedVoices(rig);
        const w = await windowPage(rig);
        try {
          const page = w.page;
          await openVoices(page);
          const help = page.locator("#settings-voices .pg-sechelp");
          expect(await help.getAttribute("data-voices")).toBe("on");
          await page.click("#set-voices-enabled");
          await until(() => w.configPatches.length === 1, 5000, "the switch saved");
          expect(w.configPatches[0]).toEqual({ "voices.enabled": false });
          await until(
            async () => (await help.getAttribute("data-voices")) === "off",
            5000,
            "the list follows the switch",
          );
        } finally {
          await w.close();
        }
      });
    },
    UI_TIMEOUT,
  );
});
