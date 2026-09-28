/**
 * DC-D2 and DC-O2 end to end (docs/ux/DICTATION.md sections 2 and 5.1): the pill's real page, fed
 * only by the main side (`src/main/window/pill.ts`) over a session whose transcript is known,
 * never shows the words with the preview off; with the preview on, the session's partial shows
 * (the positive control). The language chip (akou-5v8) shows the language heard and a click on it
 * reaches the session. The page boots late and pulls the state in force. Nothing records, types,
 * pastes or plays.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { DictationDraft, DictationEvent } from "../../src/core/dictation/events.ts";
import type { DictationFollow } from "../../src/main/dictation/service.ts";
import { hotkeyLabel } from "../../src/main/window/hotkey.ts";
import { type PillSend, pillRpc } from "../../src/main/window/pill.ts";
import { UI_TIMEOUT, type ViewPage, viewPage } from "./rig.ts";

const SAID = "the launch code is swordfish";
const TARGET = { app: "com.example.editor", pid: 1, window: "w1", field: "editable" } as const;

let open: ViewPage | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

/** The pill page over the main side, and a session whose words are `SAID`. */
async function run(rule: { preview: boolean }, during?: (page: ViewPage) => Promise<void>) {
  const st = { state: "idle", loading: false, swallow_keys: true };
  const followers = new Set<(m: DictationFollow) => void>();
  const forced: string[] = [];
  let seq = 0;
  let queue: Promise<void> = Promise.resolve();
  let view: ViewPage | null = null;
  // Messages go to the page in order, each once it has booted.
  const push = (name: string) => (payload: unknown) => {
    queue = queue.then(() => view?.send(name, payload));
  };
  const send: PillSend = {
    state: push("state"),
    level: push("level"),
    preview: push("preview"),
    chip: push("chip"),
  };
  const p = pillRpc(
    {
      status: () => ({ ...st }),
      follow: (fn) => {
        followers.add(fn);
        return () => followers.delete(fn);
      },
      control: async () => true,
      languageChoice: () => ({ languages: ["en", "es"], switchable: true }),
      setLanguage: (l) => {
        forced.push(l);
        return true;
      },
    },
    () => send,
    {
      platform: "linux",
      hotkey: () => "Control+Shift+Space",
      label: hotkeyLabel,
      now: () => Date.now(),
      onVisible: () => {},
      preview: { setting: () => rule.preview },
      later: () => () => {},
    },
  );
  const to = (state: string) => {
    st.state = state;
    p.update();
  };
  const event = (d: DictationDraft) => {
    for (const fn of followers)
      fn({ kind: "event", e: { ...d, v: 1, seq: ++seq, t: seq } as DictationEvent });
  };

  // The session starts before the page has booted: the page pulls it.
  to("listening");
  view = await viewPage("pill", {
    answer: (name, params) =>
      name === "state"
        ? p.shown()
        : name === "control"
          ? p.handlers.control(params as { action: "language" })
          : true,
  });
  open = view;
  const page = view.page;
  await page.waitForFunction(() => document.getElementById("pill")?.dataset.state === "listening");
  // The session's partial, as the service tells its followers (DC-E5).
  for (const fn of followers) fn({ kind: "partial", text: SAID, language: "en" });
  await queue;
  const whileListening = await page.textContent("body");
  await during?.(view);
  await queue;
  event({ type: "dictation.started", id: "d1", target: TARGET, engine: "fast", by: "user" });
  to("transcribing");
  event({
    type: "dictation.text",
    id: "d1",
    raw: SAID,
    text: SAID,
    language: "en",
    words: [],
    engine: "fast",
    model: "m",
    ms: 1,
  });
  to("inserting");
  event({ type: "dictation.inserted", id: "d1", method: "paste", receipt_ms: 5 });
  to("idle");
  await queue;
  const after = await page.textContent("body");
  p.close();
  return { whileListening: whileListening ?? "", after: after ?? "", page, forced };
}

describe("DC-D2: the pill shows words only under its own rule", () => {
  test(
    "preview off: no words in the page's DOM at any point",
    async () => {
      const r = await run({ preview: false });
      // The listening island drew (its key hints are there), and without the words.
      expect(r.whileListening).toContain("cancels");
      expect(r.whileListening).not.toContain("swordfish");
      expect(r.after).toContain("Inserted");
      expect(r.after).not.toContain("swordfish");
    },
    UI_TIMEOUT,
  );

  test(
    "positive control: preview on shows the session's partial",
    async () => {
      const r = await run({ preview: true });
      expect(r.whileListening).toContain("swordfish");
      // Dropped at the next state: a late partial never outlives listening.
      expect(r.after).not.toContain("swordfish");
    },
    UI_TIMEOUT,
  );
});

describe("akou-5v8: the language chip on the island", () => {
  test(
    "shows the language heard, and a click moves the session to the next one",
    async () => {
      const chip = { before: "", chosen: "" };
      const r = await run({ preview: false }, async (view) => {
        chip.before = (await view.page.textContent("#lang")) ?? "";
        await view.page.click("#lang");
        await view.page.waitForFunction(() =>
          document.getElementById("lang")?.hasAttribute("data-forced"),
        );
        chip.chosen = (await view.page.textContent("#lang")) ?? "";
      });
      expect(chip.before).toBe("EN");
      expect(chip.chosen).toBe("ES");
      expect(r.forced).toEqual(["es"]);
    },
    UI_TIMEOUT,
  );
});

describe("the page's boot-time pull", () => {
  test(
    "an answer that arrives after a newer pushed state never overwrites it",
    async () => {
      let answer: (s: unknown) => void = () => {};
      const late = new Promise((r) => {
        answer = r;
      });
      const view = await viewPage("pill", { answer: (name) => (name === "state" ? late : true) });
      open = view;
      const page = view.page;
      await page.waitForFunction(() => document.getElementById("pill")?.dataset.state === "hidden");
      await view.send("state", { state: "transcribing", since: Date.now() });
      await page.waitForFunction(
        () => document.getElementById("pill")?.dataset.state === "transcribing",
      );
      // The pull's answer, older than the push, arrives now.
      answer({ state: "listening", since: Date.now(), keys: [], hotkey: "Ctrl" });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
      expect(await page.getAttribute("#pill", "data-state")).toBe("transcribing");
    },
    UI_TIMEOUT,
  );
});
