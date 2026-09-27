/**
 * The words fixed while dictating in the words to review (docs/ux/DICTATION.md DC-L5, the page
 * side): the Dictation heading, Accept and Reject answering as the chip does, Forget taking a
 * learned word back out, the count on the Dictation page, and an akou without the list showing
 * nothing. The routes are answered from the vocabulary fixture (`rig.ts`) with the shapes of
 * `GET /vocab?dictation=true` and `POST /vocab/approve|reject {dictation: true}`. Nothing records,
 * types, pastes, prompts or plays.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import {
  type DictationPair,
  readDictationReview,
  reviewRows,
  waitingTerms,
} from "../../src/ui/dictation-review.ts";
import type { Transport } from "../../src/ui/protocol.ts";
import { tempDir } from "../helpers.ts";
import {
  dictationFixture,
  seedCall,
  standardCall,
  UI_TIMEOUT,
  type UiRig,
  uiRig,
  until,
  type VocabFixture,
  vocabFixture,
} from "./rig.ts";

const text = (page: Page, sel: string) => page.textContent(sel).then((t) => t?.trim() ?? "");

const T = Date.parse("2026-09-27T10:00:00Z");

/** Newest first, as the route lists them. */
function pairs(): DictationPair[] {
  return [
    { term: "Kubernetes", heard: "kubernetis", status: "proposed", id: "d5", at: T + 5 },
    { term: "Vercel", heard: "versal", status: "ignored", id: "d4", at: T + 4 },
    { term: "Kubernetes", heard: "cooper netties", status: "ignored", id: "d3", at: T + 3 },
    { term: "Postgres", heard: "post gress", status: "accepted", id: "d2", at: T + 2 },
    { term: "Kafka", heard: "calf car", status: "rejected", id: "d1", at: T + 1 },
  ];
}

describe("DC-L5: the rows", () => {
  test("one row per term and state, waiting first; the count is the terms still waiting", () => {
    const rows = reviewRows(pairs());
    expect(rows.map((r) => [r.term, r.bucket, r.heard])).toEqual([
      ["Kubernetes", "waiting", ["kubernetis", "cooper netties"]],
      ["Vercel", "waiting", ["versal"]],
      ["Postgres", "accepted", ["post gress"]],
      ["Kafka", "rejected", ["calf car"]],
    ]);
    // Two heard forms of one term are one term to answer.
    expect(waitingTerms(pairs())).toBe(2);
    expect(waitingTerms(pairs().filter((p) => p.term !== "Vercel"))).toBe(1);
  });
});

describe("DC-L5: reading the list", () => {
  const answering = (reply: () => Promise<{ status: number; body: unknown }>) =>
    ({ kind: "browser", request: reply }) as unknown as Transport;
  test("a refusal, a thrown request or an unreadable body is a reason, never a throw", async () => {
    expect(
      await readDictationReview(
        answering(async () => ({ status: 500, body: { message: "the log is locked" } })),
      ),
    ).toEqual({ error: "the log is locked" });
    expect(
      await readDictationReview(
        answering(async () => {
          throw new Error("offline");
        }),
      ),
    ).toEqual({ error: "the dictation words could not be read: offline" });
    expect(
      await readDictationReview(answering(async () => ({ status: 200, body: { dictation: {} } }))),
    ).toEqual({ error: "the dictation words came back unreadable" });
    // No `dictation` in the answer: an akou without the list.
    expect(
      await readDictationReview(answering(async () => ({ status: 200, body: { entries: [] } }))),
    ).toEqual({ pairs: null });
    // Positive control: a list is read, less the entries that are not pairs.
    const good = pairs()[0];
    expect(
      await readDictationReview(
        answering(async () => ({
          status: 200,
          body: { dictation: [good, { term: "x", heard: "y", status: "maybe" }, null] },
        })),
      ),
    ).toEqual({ pairs: [good as DictationPair] });
  });
});

describe("DC-L5: the Dictation heading in the words to review", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  let call = "";
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-review-");
    call = seedCall(t.dir, (b) => standardCall(b)).id;
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  const row = (term: string) => `#review-list .review-dictation li[data-term='${term}']`;

  async function openPage(dictation?: DictationPair[]): Promise<{ page: Page; v: VocabFixture }> {
    let v: VocabFixture | null = null;
    const page = await rig.open(undefined, {
      before: async (p) => {
        await dictationFixture(p);
        v = await vocabFixture(p);
        if (dictation) v.dictation = dictation;
      },
    });
    return { page, v: v as unknown as VocabFixture };
  }

  test(
    "the Dictation page counts the waiting terms; Open lists every pair; Accept, Reject and Forget answer as the chip does",
    async () => {
      const { page, v } = await openPage(pairs());
      await page.click("#dictation-open");
      await page.waitForSelector("#dictation-review-row");
      expect(await text(page, "#dictation-review-row")).toBe("Words to review (2) Open");
      // It sits in the Learning group, as the section 6 mockup has it.
      expect(
        await page
          .locator("#dictation fieldset[data-group='Learning'] #dictation-review-open")
          .count(),
      ).toBe(1);

      await page.click("#dictation-review-open");
      await page.waitForSelector("#review[open] .review-dictation h3");
      expect(await text(page, "#review-list .review-dictation h3")).toBe("Dictation");
      const states = await page.$$eval("#review-list .review-dictation li[data-term]", (els) =>
        els.map((e) => `${e.getAttribute("data-term")}:${e.getAttribute("data-state")}`),
      );
      expect(states).toEqual([
        "Kubernetes:waiting",
        "Vercel:waiting",
        "Postgres:accepted",
        "Kafka:rejected",
      ]);
      expect(await text(page, `${row("Kubernetes")} strong`)).toBe("Kubernetes");
      expect(await text(page, row("Kubernetes"))).toContain("(heard: kubernetis, cooper netties)");
      expect(await text(page, row("Vercel"))).toContain("the chip closed unanswered");
      const buttons = (term: string) =>
        page.$$eval(`${row(term)} button`, (els) => els.map((e) => e.textContent));
      expect(await buttons("Kubernetes")).toEqual(["Accept", "Reject"]);
      expect(await buttons("Postgres")).toEqual(["Forget"]);
      expect(await buttons("Kafka")).toEqual([]);

      // Accept writes the term's scope: dictation entry, for every waiting heard form of it.
      await page.click(`${row("Kubernetes")} button[data-action='approve']`);
      await page.waitForSelector(`#review-list li[data-term='Kubernetes'][data-state='accepted']`);
      expect(v.calls.at(-1)).toEqual({
        method: "POST",
        path: "/vocab/approve",
        body: { terms: ["Kubernetes"], dictation: true },
      });
      expect(await text(page, "#review-status")).toBe(
        "Kubernetes is learned: dictation writes it for what you said.",
      );
      expect(v.entries.filter((e) => e.term === "Kubernetes")).toEqual([
        expect.objectContaining({
          heard: ["kubernetis", "cooper netties"],
          entryScope: "dictation",
        }),
      ]);

      // Reject keeps it from being proposed again.
      await page.click(`${row("Vercel")} button[data-action='reject']`);
      await page.waitForSelector(`#review-list li[data-term='Vercel'][data-state='rejected']`);
      expect(v.calls.at(-1)?.body).toEqual({ terms: ["Vercel"], dictation: true });
      expect(await text(page, "#review-status")).toBe("Vercel will not be proposed again.");

      // Forget takes a learned word back out of the vocabulary.
      v.entries.push({
        term: "Postgres",
        heard: ["post gress"],
        confirmed: true,
        scope: "global",
        file: "/config/vocabulary.yaml",
        entryScope: "dictation",
      });
      await page.click(`${row("Postgres")} button[data-action='reject']`);
      await page.waitForSelector(`#review-list li[data-term='Postgres'][data-state='rejected']`);
      expect(v.entries.some((e) => e.term === "Postgres")).toBe(false);
      expect(await text(page, "#review-status")).toBe(
        "Postgres is out of the vocabulary and will not be proposed again.",
      );

      // Back on the Dictation page, the count follows the answers.
      await page.click("#review-close");
      await page.waitForFunction(
        () =>
          document.querySelector("#dictation-review-row")?.textContent ===
          "Words to review (0) Open",
      );
    },
    UI_TIMEOUT,
  );

  test(
    "a refused answer is said and the row keeps its buttons",
    async () => {
      const { page, v } = await openPage(pairs());
      await page.click("#dictation-open");
      await page.click("#dictation-review-open");
      await page.waitForSelector(row("Kubernetes"));
      v.refuse = '"Kubernetes" is a call word in the vocabulary file; edit it there';
      await page.click(`${row("Kubernetes")} button[data-action='approve']`);
      await until(
        async () => (await text(page, "#review-status")).includes("call word"),
        5000,
        "the refusal said",
      );
      expect(await page.getAttribute(row("Kubernetes"), "data-state")).toBe("waiting");
      expect(await page.isEnabled(`${row("Kubernetes")} button[data-action='approve']`)).toBe(true);
      expect(v.entries).toEqual([]);
    },
    UI_TIMEOUT,
  );

  test(
    "an akou without the list shows no row and no heading",
    async () => {
      const { page } = await openPage();
      await page.click("#dictation-open");
      await page.waitForSelector("#dictation fieldset[data-group='Learning']");
      // A count, not `page.$(...)` with toBeNull: that passed here with the row on the page.
      expect(await page.locator("#dictation-review-row").count()).toBe(0);
      // Positive control: the same page with the list shows the row.
      const withList = await openPage([]);
      await withList.page.click("#dictation-open");
      await withList.page.waitForSelector("#dictation-review-row");
      expect(await text(withList.page, "#dictation-review-row")).toBe("Words to review (0) Open");
    },
    UI_TIMEOUT,
  );

  test(
    "on a call, the call's words come first and the Dictation heading follows them",
    async () => {
      let v: VocabFixture | null = null;
      const page = await rig.open(call, {
        before: async (p) => {
          await dictationFixture(p);
          v = await vocabFixture(p);
          v.dictation = pairs();
          await p.route(
            (u) => u.pathname.endsWith(`/calls/${call}/vocab`),
            (route) =>
              route.fulfill({
                status: 200,
                json: {
                  review: {
                    proposals: [
                      { id: "p1", term: "Hetzner", heard: ["hetzner"], by: "app", lines: [] },
                    ],
                    unconfirmed: [],
                  },
                },
              }),
          );
        },
      });
      await page.waitForSelector("#lines .row");
      // The pill shows once the call's log proposes; the pane is what is under test here.
      await page.evaluate(() => (document.getElementById("pill-review") as HTMLElement).click());
      await page.waitForSelector("#review[open] .review-dictation");
      const order = await page.$$eval("#review-list > li", (els) =>
        els.map((e) => e.getAttribute("data-term") ?? e.querySelector("h3")?.textContent),
      );
      expect(order).toEqual(["Hetzner", "Dictation"]);
    },
    UI_TIMEOUT,
  );
});
