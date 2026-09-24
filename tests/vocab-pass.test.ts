/**
 * Vocabulary layer 3, the post-call pass (docs/DESIGN.md sections 3 and 5.4, REQUIREMENTS V6,
 * ROADMAP M2): the provider corrects known terms and proposes new ones, and a deterministic span
 * check drops anything that does not rest on a line it was shown. A fake provider stands in for the
 * model; no test runs a real one.
 */

import { describe, expect, test } from "bun:test";
import { fold } from "../src/core/log/fold.ts";
import type { CompleteRequest, CompleteResult, Provider } from "../src/main/llm/provider.ts";
import { STOPWORDS } from "../src/main/query/bm25.ts";
import {
  checkPass,
  PASS_SYSTEM,
  type PassInput,
  parsePassAnswer,
  passBatches,
  passPrompt,
  runPass,
  spanIn,
} from "../src/main/vocab/pass.ts";
import { rarityOf, suggestTerms } from "../src/main/vocab/suggest.ts";
import { LogBuilder, T0, TZ } from "./helpers.ts";

const S = 1000;

function call(): LogBuilder {
  const b = new LogBuilder();
  b.created({ title: "Infra sync" });
  b.partStarted(1, T0);
  b.seg({ id: "l000001", text: "we deploy on versal next week", w0: T0 + 5 * S });
  b.seg({ id: "l000002", text: "annika will review the vessel config", w0: T0 + 12 * S });
  b.seg({ id: "l000003", text: "annika said the kubernetis cluster is fine", w0: T0 + 20 * S });
  return b;
}

const INPUT: PassInput = {
  known: [
    { term: "Vercel", heard: ["vercell"] },
    { term: "Kubernetes", heard: [] },
  ],
  rejected: ["Vessel"],
};

class FakeProvider implements Provider {
  readonly id = "openai-compatible" as const;
  readonly requests: CompleteRequest[] = [];
  constructor(private readonly answer: (req: CompleteRequest) => string) {}
  async available() {
    return { ok: true as const, detail: "fake" };
  }
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.requests.push(req);
    return { text: this.answer(req), model: "fake/1.0" };
  }
}

describe("the span check", () => {
  test("a span is found as whole words, folded; a part of a word is not", () => {
    expect(spanIn("we deploy on versal next week", "Versal")).toBe(true);
    expect(spanIn("we deploy on versal next week", "on versal")).toBe(true);
    expect(spanIn("we deploy on versal next week", "vers")).toBe(false);
    expect(spanIn("we deploy on versal next week", "")).toBe(false);
  });

  test("the answer is read from a fenced block or bare JSON; anything else is empty", () => {
    expect(
      parsePassAnswer('```json\n{"corrections": [1], "proposals": []}\n```').corrections,
    ).toEqual([1]);
    expect(parsePassAnswer('Here: {"proposals": [{"term": "x"}]} done').proposals).toHaveLength(1);
    expect(parsePassAnswer("no json at all")).toEqual({ corrections: [], proposals: [] });
    expect(parsePassAnswer("{broken")).toEqual({ corrections: [], proposals: [] });
  });
});

describe("[V6] the post-call pass", () => {
  test("[decision] The pass corrects a span that is not there: a real span is applied, a bad span from a fake provider is dropped", async () => {
    const b = call();
    const view = fold(b.events);
    const good = { line: "#l000001", heard: "versal", term: "Vercel" };
    const badSpan = { line: "#l000002", heard: "versal", term: "Vercel" };
    const badLine = { line: "#l000099", heard: "versal", term: "Vercel" };
    const p = new FakeProvider(() =>
      JSON.stringify({ corrections: [good, badSpan, badLine], proposals: [] }),
    );
    const r = await runPass({ view, tz: TZ, input: INPUT, provider: p });
    expect(p.requests[0]?.system).toBe(PASS_SYSTEM);
    expect(r.corrections).toEqual([{ term: "Vercel", heard: "versal", lines: ["l000001"] }]);
    expect(r.dropped.map((d) => d.reason)).toEqual([
      '"versal" is not in #l000002',
      "#l000099 is not a line the pass was shown",
    ]);
    // Every correction applied names a span that exists in its segment.
    for (const c of r.corrections) {
      for (const id of c.lines) expect(spanIn(view.resolve(id)?.raw ?? "", c.heard)).toBe(true);
    }
    // Written as a call-scoped pair restricted to its line: the raw text stays, the fold corrects.
    const add = r.drafts.find((d) => d.type === "vocab.add");
    expect(add).toMatchObject({ term: "Vercel", heard: ["versal"], segs: ["l000001"], by: "app" });
    for (const d of r.drafts) b.add(d);
    const after = fold(b.events);
    expect(after.resolve("l000001")?.text).toBe("we deploy on Vercel next week");
    expect(after.resolve("l000001")?.raw).toBe("we deploy on versal next week");
    // The same word elsewhere is not touched: the pair is for that line only.
    expect(after.resolve("l000002")?.text).toContain("vessel");
  });

  test("the new heard form of a known term is also proposed, so the next call gets it right", async () => {
    const view = fold(call().events);
    const p = new FakeProvider(() =>
      JSON.stringify({ corrections: [{ line: "l000001", heard: "versal", term: "Vercel" }] }),
    );
    const r = await runPass({ view, tz: TZ, input: INPUT, provider: p });
    expect(r.proposals).toEqual([
      { term: "Vercel", heard: ["versal"], lines: ["l000001"], why: "heard this way in this call" },
    ]);
    // A heard form the vocabulary already has is not proposed again.
    const known = await runPass({
      view,
      tz: TZ,
      input: { ...INPUT, known: [{ term: "Vercel", heard: ["versal"] }] },
      provider: p,
    });
    expect(known.proposals).toEqual([]);
  });

  test("a correction to a term the vocabulary lacks is only a proposal", async () => {
    const view = fold(call().events);
    const p = new FakeProvider(() =>
      JSON.stringify({ corrections: [{ line: "#l000002", heard: "annika", term: "Anika" }] }),
    );
    const r = await runPass({ view, tz: TZ, input: INPUT, provider: p });
    expect(r.corrections).toEqual([]);
    expect(r.proposals).toMatchObject([{ term: "Anika", heard: ["annika"], lines: ["l000002"] }]);
    expect(r.drafts).toMatchObject([
      { type: "vocab.propose", term: "Anika", status: "proposed", by: "app" },
    ]);
  });

  test("proposals are checked: cited lines, heard forms in them, rejected and repeated terms", () => {
    const view = fold(call().events);
    const shown = new Map(view.lines("best").map((l) => [l.id, l]));
    const r = checkPass(
      {
        corrections: [],
        proposals: [
          { term: "Anika", heard: ["annika"], lines: ["#l000002", "#l000003"], why: "a name" },
          { term: "Kubernetes", heard: ["kubernetis"], lines: ["l000003"] },
          { term: "Vessel", heard: [], lines: ["l000002"] },
          { term: "Hetzner", heard: ["hetzna"], lines: ["l000001"] },
          { term: "Ghost", heard: [], lines: ["l000001"] },
          { term: "Nowhere", heard: ["versal"], lines: ["f000404"] },
          { term: "Old", heard: ["annika"], lines: ["l000002"] },
          { term: "", heard: [], lines: [] },
        ],
      },
      { shown, input: INPUT, existing: [{ term: "Old" }] },
    );
    expect(r.proposals).toEqual([
      { term: "Anika", heard: ["annika"], lines: ["l000002", "l000003"], why: "a name" },
      { term: "Kubernetes", heard: ["kubernetis"], lines: ["l000003"] },
    ]);
    expect(r.dropped.map((d) => d.reason)).toEqual([
      '"Vessel" was rejected before',
      "no heard form is in the lines it cites",
      '"Ghost" is not in the lines it cites',
      "cites no line the pass was shown",
      '"Old" is already proposed in this call',
      "needs a term",
    ]);
  });

  test("a proposal stays inert until accepted; accepted, it corrects like a file entry", async () => {
    const b = call();
    const p = new FakeProvider(() =>
      JSON.stringify({ proposals: [{ term: "Anika", heard: ["annika"], lines: ["l000002"] }] }),
    );
    const r = await runPass({ view: fold(b.events), tz: TZ, input: INPUT, provider: p });
    for (const d of r.drafts) b.add(d);
    const pending = fold(b.events);
    expect(pending.proposals("proposed").map((x) => x.term)).toEqual(["Anika"]);
    expect(pending.resolve("l000002")?.text).toStartWith("annika");
    const prop = pending.proposals()[0];
    b.add({ ...(r.drafts[0] as object), id: prop?.id, rev: 2, status: "accepted" } as never);
    // Accepted proposals are file-scope rules: they need a dictionary to clear "annika".
    const accepted = fold(b.events, { isDictionaryWord: () => false });
    expect(accepted.resolve("l000002")?.text).toStartWith("Anika");
  });

  test("a long call is read in batches that each fit the cap; the prompt carries raw text and the rejected list", async () => {
    const b = new LogBuilder();
    b.created();
    b.partStarted(1, T0);
    for (let i = 1; i <= 60; i++) {
      b.seg({
        id: `l${String(i).padStart(6, "0")}`,
        text: `line ${i} ${"word ".repeat(30)}`,
        w0: T0 + i * S,
      });
    }
    const view = fold(b.events);
    const batches = passBatches(view.lines("best"), TZ, 500);
    expect(batches.length).toBeGreaterThan(3);
    expect(batches.flat()).toHaveLength(60);
    const p = new FakeProvider(() => "{}");
    const r = await runPass({ view, tz: TZ, input: INPUT, provider: p, batchTokens: 500 });
    expect(r.calls).toBe(batches.length);
    const prompt = passPrompt(INPUT, view.lines("best").slice(0, 1), TZ);
    expect(prompt).toContain("- Vercel (misheard as: vercell)");
    expect(prompt).toContain("Rejected, never propose: Vessel");
    expect(prompt).toContain("#l000001 15:36:13");
  });
});

describe("suggestions: frequency times rarity", () => {
  const stopwords = new Set(Object.values(STOPWORDS).flatMap((s) => [...s]));

  test("names, mixed case and codes rank above everyday words; known and rejected are left out", () => {
    const s = suggestTerms(
      [
        { text: "Then we asked Anika about GitHub. Anika said k3s is fine.", id: "l000001" },
        { text: "The Neutral Base team met Anika and Vercel.", id: "l000002" },
      ],
      { known: ["Vercel"], rejected: ["k3s"], stopwords, k: 10 },
    );
    const terms = s.map((x) => x.term);
    expect(terms[0]).toBe("Anika");
    expect(s[0]).toMatchObject({ count: 3, lines: ["l000001", "l000002"] });
    expect(terms).toContain("GitHub");
    expect(terms).toContain("Neutral Base");
    expect(terms).not.toContain("Vercel");
    expect(terms).not.toContain("k3s");
    expect(terms).not.toContain("Then");
    expect(terms).not.toContain("asked");
  });

  test("rarity reads the shape of a word", () => {
    expect(rarityOf("GitHub", false)).toBeGreaterThan(0);
    expect(rarityOf("Anika", false)).toBeGreaterThan(0);
    expect(rarityOf("Anika", true)).toBe(0);
    expect(rarityOf("review", false)).toBe(0);
  });
});
