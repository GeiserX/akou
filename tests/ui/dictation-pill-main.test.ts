/**
 * DC-D2 end to end (docs/ux/DICTATION.md section 2): the pill's real page, fed only by the main
 * side (`src/main/window/pill.ts`) over a session whose transcript is known, never shows the words
 * with the preview off, nor with the preview on while the window is not hidden from screen capture;
 * with the preview on and the window hidden, the partial shows (the positive control). The page
 * boots late and pulls the state in force. Nothing records, types, pastes or plays.
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
async function run(rule: { preview: boolean; hidden: boolean }) {
  const st = { state: "idle", loading: false, swallow_keys: true };
  const followers = new Set<(m: DictationFollow) => void>();
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
    },
    () => send,
    {
      platform: "linux",
      hotkey: () => "Control+Shift+Space",
      label: hotkeyLabel,
      now: () => Date.now(),
      onVisible: () => {},
      preview: { setting: () => rule.preview, hiddenFromCapture: () => rule.hidden },
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
  view = await viewPage("pill", { answer: (name) => (name === "state" ? p.shown() : true) });
  open = view;
  const page = view.page;
  await page.waitForFunction(() => document.getElementById("pill")?.dataset.state === "listening");
  p.preview(SAID);
  event({ type: "dictation.started", id: "d1", target: TARGET, engine: "fast", by: "user" });
  await queue;
  const whileListening = await page.textContent("body");
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
  return { whileListening: whileListening ?? "", after: after ?? "", page };
}

describe("DC-D2: the pill shows words only under its own rule", () => {
  test(
    "preview off: no words in the page's DOM at any point",
    async () => {
      const r = await run({ preview: false, hidden: true });
      expect(r.whileListening).toContain("listening");
      expect(r.whileListening).not.toContain("swordfish");
      expect(r.after).toContain("inserted");
      expect(r.after).not.toContain("swordfish");
    },
    UI_TIMEOUT,
  );

  test(
    "preview on but the window not hidden from capture: still no words",
    async () => {
      const r = await run({ preview: true, hidden: false });
      expect(r.whileListening).not.toContain("swordfish");
      expect(r.after).not.toContain("swordfish");
    },
    UI_TIMEOUT,
  );

  test(
    "positive control: preview on and the window hidden from capture shows the partial",
    async () => {
      const r = await run({ preview: true, hidden: true });
      expect(r.whileListening).toContain("swordfish");
      // Dropped at the next state: a late partial never outlives listening.
      expect(r.after).not.toContain("swordfish");
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
