/**
 * The lines an agent reads for what a fix taught akou (docs/DESIGN.md section 5.4): one per
 * `learned` item in `akou_read` and `akou tail`, and the newest five in a context pack. Exact
 * wording, because an agent acts on it.
 */

import { describe, expect, test } from "bun:test";
import type { LearnedChange } from "../src/core/log/fold.ts";
import { LEARNED_IN_PACK, learnedNote, learnedPackLines } from "../src/core/vocab/learned.ts";

describe("learnedNote", () => {
  test("a term the user taught, with the lines it changed", () => {
    expect(
      learnedNote({
        term: "Vercel",
        heard: ["versal"],
        by: "user",
        time: "15:41:07",
        lines: 4,
        kept: "workspace",
      }),
    ).toBe(
      'The user taught akou "Vercel" (heard "versal") at 15:41:07: 4 lines now read Vercel, lines you read before included. Spell it that way.',
    );
  });

  test("one line, no heard form, an agent, a rename, a take-back", () => {
    expect(
      learnedNote({ term: "Marc", heard: [], by: "agent:claude", time: "15:42:00", lines: 1 }),
    ).toBe(
      'An agent (claude) taught akou "Marc" at 15:42:00: 1 line now reads Marc, even if you read it before. Spell it that way.',
    );
    expect(
      learnedNote({
        term: "Vercel.com",
        was: "Vercel",
        heard: ["versal"],
        by: "user",
        time: "15:44:00",
        lines: 2,
      }),
    ).toBe(
      'The user renamed "Vercel" to "Vercel.com" (heard "versal") at 15:44:00: 2 lines now read Vercel.com, lines you read before included. Spell it that way.',
    );
    expect(
      learnedNote({ term: null, was: "Hetzner", heard: ["hetzna"], by: "user", time: "15:43:10" }),
    ).toBe('The user took back "Hetzner" at 15:43:10: those lines read "hetzna" again.');
  });
});

describe("learnedPackLines", () => {
  const change = (id: string, seq: number, term: string | null, was?: string): LearnedChange => ({
    id,
    rev: seq,
    seq,
    t: Date.UTC(2026, 8, 23, 15, 40, seq),
    term,
    ...(was ? { was } : {}),
    heard: [],
    by: "user",
  });

  test("each term once, its latest change, newest first, at most five", () => {
    const changes = [
      change("k1", 1, "One"),
      change("k2", 2, "Two"),
      change("k3", 3, "Three"),
      change("k4", 4, "Four"),
      change("k5", 5, "Five"),
      change("k6", 6, "Six"),
      change("k2", 7, null, "Two"),
    ];
    const lines = learnedPackLines(changes, "UTC");
    expect(lines[0]).toBe("Words fixes taught akou in this call, newest first:");
    expect(lines.slice(1)).toEqual([
      '- "Two": taken back by the user at 15:40:07; those lines read as heard.',
      '- "Six": taught by the user at 15:40:06. Spell it that way.',
      '- "Five": taught by the user at 15:40:05. Spell it that way.',
      '- "Four": taught by the user at 15:40:04. Spell it that way.',
      '- "Three": taught by the user at 15:40:03. Spell it that way.',
    ]);
    expect(lines).toHaveLength(LEARNED_IN_PACK + 1);
  });

  test("nothing taught, nothing said", () => {
    expect(learnedPackLines([], "UTC")).toEqual([]);
  });
});
