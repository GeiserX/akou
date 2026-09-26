/**
 * The words of the server-mode page that need no browser: how long a job took, and what the
 * Models page says of each state of the speech models (docs/ux/SERVER.md SV-U4, SV-U6).
 */

import { describe, expect, test } from "bun:test";
import { modelsStateText, took } from "../src/ui/server-text.ts";

describe("the server page's words", () => {
  test("a duration reads as ms, s, min or h", () => {
    expect(took(850)).toBe("850 ms");
    expect(took(-5)).toBe("0 ms");
    expect(took(12_400)).toBe("12 s");
    expect(took(75_000)).toBe("1 min 15 s");
    expect(took(184_000)).toBe("3 min 4 s");
    expect(took(3_725_000)).toBe("1 h 2 min");
  });

  test("each models state says what it is", () => {
    const base = { dir: "/models", bytes: 0, total: 640e6 };
    expect(modelsStateText({ ...base, state: "ready" })).toContain("on disk in /models");
    expect(modelsStateText({ ...base, state: "missing" })).toContain("not downloaded: 640 MB");
    expect(modelsStateText({ ...base, state: "downloading", bytes: 320e6 })).toContain("50 %");
    expect(modelsStateText({ ...base, state: "failed", error: "HTTP 500" })).toContain(
      "stopped: HTTP 500",
    );
  });
});
