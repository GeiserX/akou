/**
 * From an edit to a learning candidate (docs/ux/DICTATION.md section 8.2, DC-L3): the pure rules
 * in src/core/dictation/learn.ts, by table, and the audio check against fake engines.
 */

import { describe, expect, test } from "bun:test";
import {
  type Candidate,
  candidates,
  checkAudio,
  englishKey,
  type LearnInput,
  learn,
  PROPOSE_AT,
  reviewPairs,
  soundAlike,
  spanishKey,
} from "../src/core/dictation/learn.ts";

const COMMON = new Set(["why", "what", "tell", "the", "team", "is", "on", "we", "use", "it", "a"]);
const isCommonWord = (w: string) => COMMON.has(w);

function edit(inserted: string, edited: string, o: Partial<LearnInput> = {}): Candidate[] {
  return candidates({ inserted, edited, language: "en", isCommonWord, ...o });
}

const pairs = (cs: readonly Candidate[]) => cs.map((c) => [c.heard, c.term]);

describe("DC-L3: which edits are candidates", () => {
  test("a sound-alike fix of a misheard name is proposed at 0.45 or more", () => {
    const [c, ...rest] = edit(
      "Tell the cooper netties team the rollout is on Thursday.",
      "Tell the Kubernetes team the rollout is on Thursday.",
    );
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      heard: "cooper netties",
      term: "Kubernetes",
      evidence: "none",
      replacementOnly: false,
    });
    expect(c?.confidence).toBeGreaterThanOrEqual(PROPOSE_AT);
  });

  test("two common words are rejected: why to what", () => {
    expect(edit("why is it on", "what is it on")).toEqual([]);
    // Positive control: with no word list to ask, the same pair is scored like any other.
    expect(pairs(edit("why is it on", "what is it on", { isCommonWord: undefined }))).toEqual([
      ["why", "what"],
    ]);
  });

  test("a rewritten sentence proposes nothing, even where each change alone would", () => {
    // Five of seven words changed; on its own "versal" to "Vercel" would be proposed.
    expect(edit("we use versal on the hetzna box", "they use Vercel for the Hetzner cube")).toEqual(
      [],
    );
    expect(edit("we use it on the team today", "let us ship Postgres for them tomorrow")).toEqual(
      [],
    );
  });

  test("a change of case only is a replacement-only candidate", () => {
    expect(edit("we use vercel today", "we use Vercel today")).toEqual([
      { heard: "vercel", term: "Vercel", confidence: 1, evidence: "none", replacementOnly: true },
    ]);
  });

  test("a number, punctuation only, and a fix under 3 characters are rejected", () => {
    expect(edit("we use 3 boxes", "we use three boxes")).toEqual([]);
    // "mp three" to "MP3" sounds alike at 0.5, and is still a number.
    expect(soundAlike("mp three", "MP3", "en")).toBeGreaterThanOrEqual(PROPOSE_AT);
    expect(edit("we play the mp three file today", "we play the MP3 file today")).toEqual([]);
    expect(edit("we use it on the team", "we use it, on the team.")).toEqual([]);
    expect(edit("we use jax today", "we use JS today")).toEqual([]);
    // Positive control: a letters-only fix of the same shape is proposed.
    expect(pairs(edit("we use jax today", "we use Jack today"))).toEqual([["jax", "Jack"]]);
  });

  test("a pair already in the vocabulary, or rejected before, is not proposed again", () => {
    const pair = (h: string, t: string) => h === "versal" && t === "Vercel";
    expect(edit("we use versal", "we use Vercel", { rejected: pair })).toEqual([]);
    expect(edit("we use versal", "we use Vercel", { known: pair })).toEqual([]);
    expect(pairs(edit("we use versal", "we use Vercel"))).toEqual([["versal", "Vercel"]]);
  });

  test("a substitution of more than 3 words on a side is not a word to learn", () => {
    expect(
      edit(
        "tell the team one two three four five six seven eight nine ten eleven twelve",
        "tell the team alpha bravo charlie delta five six seven eight nine ten eleven twelve",
      ),
    ).toEqual([]);
  });

  test("with no confidence the bar stays at 0.45; an unsure word lowers it to 0.35", () => {
    // "pickle" to "Rockset" sounds alike at about 0.43: under the bar, over the unsure bar.
    const score = soundAlike("pickle", "Rockset", "en");
    expect(score).toBeGreaterThanOrEqual(0.35);
    expect(score).toBeLessThan(0.45);
    const inserted = "we use pickle today";
    const edited = "we use Rockset today";
    expect(edit(inserted, edited)).toEqual([]);
    const words = (c: number) => [
      { w: "we", c: 0.99 },
      { w: "use", c: 0.99 },
      { w: "pickle", c },
      { w: "today.", c: 0.99 },
    ];
    expect(edit(inserted, edited, { words: words(0.95) })).toEqual([]);
    expect(pairs(edit(inserted, edited, { words: words(0.2) }))).toEqual([["pickle", "Rockset"]]);
    // A second engine that heard it differently counts as unsure too.
    expect(pairs(edit(inserted, edited, { other: "we use Rockset today" }))).toEqual([
      ["pickle", "Rockset"],
    ]);
    expect(edit(inserted, edited, { other: "we use pickle today" })).toEqual([]);
  });

  test("the sound keys: Double Metaphone for English, the small key for Spanish", () => {
    expect(englishKey("cooper netties")).toBe(englishKey("Kubernetes"));
    expect(spanishKey("vaca")).toBe(spanishKey("baca"));
    expect(spanishKey("llave")).toBe(spanishKey("yabe"));
    expect(spanishKey("hola")).toBe(spanishKey("ola"));
    expect(spanishKey("cena")).toBe(spanishKey("sena"));
    expect(spanishKey("queso")).toBe(spanishKey("keso"));
  });
});

describe("DC-L3: the audio check", () => {
  const found = () => edit("deploy it on cooper netties", "deploy it on Kubernetes");

  test("a second decode that hears the fix confirms it; one that does not drops it", async () => {
    const asked: (readonly string[])[] = [];
    const hears = (text: string) => async (glossary: readonly string[]) => {
      asked.push(glossary);
      return text;
    };
    const [c] = found();
    expect(await checkAudio(c as Candidate, hears("deploy it on Kubernetes"))).toMatchObject({
      term: "Kubernetes",
      evidence: "audio",
    });
    // Positive control: the fake returning the wrong word rejects the pair.
    expect(await checkAudio(c as Candidate, hears("deploy it on cooper netties"))).toBeNull();
    expect(await checkAudio(c as Candidate, hears("deploy it on Kubeflow"))).toBeNull();
    expect(asked).toEqual([["Kubernetes"], ["Kubernetes"], ["Kubernetes"]]);
  });

  test("with no Qwen to check it, the candidate is proposed with evidence none", async () => {
    expect(
      await learn(
        {
          inserted: "deploy it on cooper netties",
          edited: "deploy it on Kubernetes",
          language: "en",
        },
        null,
      ),
    ).toMatchObject([{ term: "Kubernetes", evidence: "none" }]);
  });

  test("a Qwen with no word times still checks the whole utterance, once per candidate", async () => {
    let calls = 0;
    const qwen = async () => {
      calls++;
      // A whole-utterance answer, no words and no times.
      return "Deploy it on Kubernetes.";
    };
    expect(
      await learn(
        {
          inserted: "deploy it on cooper netties",
          edited: "deploy it on Kubernetes",
          language: "en",
        },
        qwen,
      ),
    ).toMatchObject([{ term: "Kubernetes", evidence: "audio" }]);
    expect(calls).toBe(1);
  });

  test("an answer that is the fix alone is the context echoed: evidence none", async () => {
    const [c] = found();
    expect(await checkAudio(c as Candidate, async () => "Kubernetes.")).toMatchObject({
      term: "Kubernetes",
      evidence: "none",
    });
    // Positive control: the fix inside the rest of what was said confirms it.
    expect(await checkAudio(c as Candidate, async () => "Deploy it on Kubernetes.")).toMatchObject({
      evidence: "audio",
    });
  });

  test("a check that fails leaves the candidate standing with evidence none", async () => {
    const broken = async () => {
      throw new Error("llama-server is gone");
    };
    const [c] = found();
    expect(await checkAudio(c as Candidate, broken)).toMatchObject({ evidence: "none" });
  });
});

describe("DC-L5: the pairs of the words to review", () => {
  const ev = (t: number, id: string, heard: string, term: string, status: string) => ({
    type: "dictation.learn",
    id,
    t,
    heard,
    term,
    status,
    evidence: "none",
  });

  test("one row per pair at its latest status, newest first, whatever the case", () => {
    const rows = reviewPairs([
      ev(1, "d1", "cooper netties", "Kubernetes", "proposed"),
      ev(2, "d2", "versal", "Vercel", "proposed"),
      ev(3, "d1", "cooper netties", "Kubernetes", "ignored"),
      ev(4, "d3", "Cooper Netties", "kubernetes", "accepted"),
      { type: "dictation.text", id: "d9", t: 5 },
    ]);
    expect(rows.map((r) => [r.heard, r.term, r.status, r.id, r.at])).toEqual([
      ["Cooper Netties", "kubernetes", "accepted", "d3", 4],
      ["versal", "Vercel", "proposed", "d2", 2],
    ]);
  });

  test("an accepted pair the vocabulary no longer holds waits again as ignored", () => {
    const events = [
      ev(1, "d1", "cooper netties", "Kubernetes", "accepted"),
      ev(2, "d2", "versal", "Vercel", "accepted"),
    ];
    const known = (heard: string, term: string) => heard === "versal" && term === "Vercel";
    expect(reviewPairs(events, known).map((r) => [r.term, r.status])).toEqual([
      ["Vercel", "accepted"],
      ["Kubernetes", "ignored"],
    ]);
    // Positive control: without the vocabulary, the log's word stands.
    expect(reviewPairs(events).map((r) => r.status)).toEqual(["accepted", "accepted"]);
  });
});
