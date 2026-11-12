/**
 * The echo rule (src/core/log/echo.ts, DESIGN 3.1 step 7) on its own: each bound with the case
 * just inside it and the case just outside, so a rule that drifts either way fails.
 */

import { describe, expect, test } from "bun:test";
import { type EchoLine, isEcho } from "../src/core/log/echo.ts";

const T = 1_000_000;
const call: EchoLine = { w0: T, w1: T + 2000, text: "We ship on Friday, after the review." };
const mic = (o: Partial<EchoLine> = {}): EchoLine => ({
  w0: T + 400,
  w1: T + 2400,
  text: "we ship on friday after the review",
  ...o,
});

describe("[ECHO-1] Mic hears the call", () => {
  test("the same words on the mic 0.4 s after the call line are echo", () => {
    expect(isEcho(mic(), call)).toBe(true);
  });

  test("time: a mic line starting 1.5 s after the call line ends is echo; 1.6 s is not", () => {
    expect(isEcho(mic({ w0: T + 3500, w1: T + 5500 }), call)).toBe(true);
    expect(isEcho(mic({ w0: T + 3600, w1: T + 5600 }), call)).toBe(false);
  });

  test("order: the call line must start first; a mic line that starts before it is the user's", () => {
    expect(isEcho(mic({ w0: T, w1: T + 2000 }), call)).toBe(true);
    expect(isEcho(mic({ w0: T - 1, w1: T + 2000 }), call)).toBe(false);
  });

  test("share: 7 of 10 mic words in the call line is echo; 6 of 10 is not", () => {
    const ten: EchoLine = { w0: T, w1: T + 3000, text: "one two three four five six seven" };
    const seven = "one two three four five six seven eight nine ten";
    const six = "one two three four five six eight nine ten zero";
    expect(isEcho(mic({ text: seven }), ten)).toBe(true);
    expect(isEcho(mic({ text: six }), ten)).toBe(false);
  });

  test("length: three words read back can be echo; two never are", () => {
    const read: EchoLine = { w0: T, w1: T + 2000, text: "the code is four four two" };
    expect(isEcho(mic({ text: "four four two" }), read)).toBe(true);
    expect(isEcho(mic({ text: "four two" }), read)).toBe(false);
  });

  test("a word counts as many times as the call line says it, not more", () => {
    const once: EchoLine = { w0: T, w1: T + 2000, text: "no ok then" };
    expect(isEcho(mic({ text: "no no no ok" }), once)).toBe(false);
  });

  test("different words at the same time are not echo, and a retracted line never is", () => {
    expect(isEcho(mic({ text: "can you hear me now" }), call)).toBe(false);
    expect(isEcho(mic({ text: null }), call)).toBe(false);
    expect(isEcho(mic(), { ...call, text: null })).toBe(false);
  });
});
