/**
 * The draft box end to end (docs/ux/DICTATION.md DC-S1, DC-L4): the box's real page in a browser,
 * fed by the real shell's draft window (a recording fake of the native window) over a whole app
 * whose fake helper records every command. Enter, Ctrl/Cmd+Enter and Escape are pressed on the
 * page and reach the helper as the app sends them; the learn chip's answers land in the real
 * vocabulary file and the dictation log. Nothing records, types, pastes or plays: the helper is
 * the fake, its "mic" a WAV file of tones, and its inserts lines in a file.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../../src/core/dictation/activation.ts";
import type { DictationItem } from "../../src/core/dictation/events.ts";
import { parseVocab } from "../../src/main/vocab/files.ts";
import { Bridge } from "../../src/main/window/bridge.ts";
import { appForShell, type DraftHandlers, Shell } from "../../src/main/window/shell.ts";
import { CHIP_ASK_MS } from "../../src/ui/dictation-chip.ts";
import type { DraftOpen } from "../../src/ui/dictation-protocol.ts";
import type { Chip } from "../../src/ui/pill-protocol.ts";
import { type AppRig, appRig } from "../api-helpers.ts";
import { concat, silence, speak } from "../fixtures/asr-fake.ts";
import { monoWav } from "../fixtures/audio.ts";
import { tempDir } from "../helpers.ts";
import { fakeUi } from "../shell-helpers.ts";
import { UI_TIMEOUT, until, type ViewPage, viewPage } from "./rig.ts";

const RC = "RightCommand";
const TARGET = { app: "com.example.chat", pid: 7, window: "w7", field: "editable" } as const;

const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

interface Rig {
  r: AppRig;
  view: ViewPage;
  /** What the shell asked of the native window: `show` takes the keyboard, `showInactive` not. */
  calls: string[];
  opens: DraftOpen[];
  /** Each chip sent to the page, with the vocabulary file's dictation terms at that moment. */
  chips: { chip: Chip; terms: string[] }[];
  /** The page's requests the main side has answered, by name. */
  answered: string[];
  commands(): { type: string; text?: string; send_key?: string; target?: unknown }[];
  inserted(): { text: string; send_key?: string }[];
  /** The `scope: dictation` terms in the user's vocabulary file. */
  terms(): string[];
  close(): Promise<void>;
}

/**
 * A whole app with dictation on and the real shell's draft window over the box's real page. With
 * `press`, the fake helper plays one press saying "deploy kubernetes", which the fake engine hears
 * as "deploy kubernetis", once the test calls `rebind`.
 */
async function draftRig(o: { press?: boolean; switches?: string[] } = {}): Promise<Rig> {
  const t = tempDir("akou-ui-draft-");
  const args = [
    "--commands-log",
    join(t.dir, "commands.jsonl"),
    "--inserter-log",
    join(t.dir, "inserted.jsonl"),
    ...(o.switches ?? []),
  ];
  if (o.press) {
    const keys = join(t.dir, "keys.jsonl");
    const press: KeyInput[] = [
      { at: 0, key: RC, down: true },
      { at: 2500, key: RC, down: false },
    ];
    writeFileSync(keys, press.map((k) => JSON.stringify(k)).join("\n"));
    const wav = join(t.dir, "mic.wav");
    writeFileSync(wav, monoWav(concat(silence(0.5), speak(["deploy", "kubernetes"]), silence(3))));
    // The press waits for a second rebind, sent once the window is in place.
    args.push("--wav", wav, "--keys", keys, "--play-after-rebinds", "2");
  }
  const r = await appRig({
    helperArgs: args,
    settings: {
      "dictation.enabled": true,
      "dictation.hotkey": RC,
      "dictation.pill": "off",
      "dictation.learn": "ask",
    },
  });
  await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");

  const vocabFile = join(r.app.configDir, "vocabulary.yaml");
  const terms = () =>
    existsSync(vocabFile)
      ? parseVocab(readFileSync(vocabFile, "utf8"))
          .file.entries.filter((e) => e.entryScope === "dictation")
          .map((e) => e.term)
      : [];
  const calls: string[] = [];
  const opens: DraftOpen[] = [];
  const chips: Rig["chips"] = [];
  const answered: string[] = [];
  let handlers: DraftHandlers | null = null;
  const view = await viewPage("draft", {
    answer: async (name, params) => {
      const fn = handlers?.[name as keyof DraftHandlers] as
        | ((p: unknown) => Promise<boolean>)
        | undefined;
      const out = await fn?.(params);
      answered.push(name);
      return out;
    },
  });
  // Messages reach the page in order, as ElectroBun's `rpc.send` does.
  let queue: Promise<void> = Promise.resolve();
  const push = (name: string, payload: unknown) => {
    queue = queue.then(() => view.send(name, payload));
  };
  const f = fakeUi();
  f.ui.openDraft = (w) => {
    handlers = w.handlers;
    return {
      window: {
        show: () => calls.push("show"),
        showInactive: () => calls.push("showInactive"),
        hide: () => calls.push("hide"),
        close: () => calls.push("close"),
        onClose: () => {},
      },
      send: {
        open: (d) => {
          opens.push(d);
          push("open", d);
        },
        chip: (c) => {
          chips.push({ chip: c, terms: terms() });
          push("chip", c);
        },
        append: (text) => push("append", { text }),
      },
    };
  };
  const shell = new Shell(appForShell(r.app), new Bridge(r.app), f.ui, {
    platform: "darwin",
    setLoginItem: async () => {},
  });
  await shell.start();
  if (!handlers) throw new Error("the shell opened no draft window");
  return {
    r,
    view,
    calls,
    opens,
    chips,
    answered,
    commands: () => lines(join(t.dir, "commands.jsonl")),
    inserted: () => lines(join(t.dir, "inserted.jsonl")),
    terms,
    close: async () => {
      await queue.catch(() => {});
      await shell.close();
      await view.close();
      await r.close();
      t.cleanup();
    },
  };
}

function dictation(g: Rig) {
  const d = g.r.app.dictation();
  if (!d) throw new Error("no dictation");
  return d;
}

/**
 * A dictation that went into the chat app as `text`, written to the log as a session writes it;
 * `words` are the engine's, with their confidences.
 */
function seed(g: Rig, id: string, text: string, words: DictationItem["words"] = []): void {
  const log = dictation(g).log;
  log.append({ type: "dictation.started", id, target: TARGET, engine: "fast", by: "user" });
  log.append({ type: "dictation.ended", id, reason: "released", seconds: 2 });
  log.append({
    type: "dictation.text",
    id,
    raw: text,
    text,
    language: "en",
    words,
    engine: "fast",
    model: "parakeet",
    ms: 120,
  });
  log.append({ type: "dictation.inserted", id, method: "paste", receipt_ms: 5 });
}

/** Opens the box on dictation `id` from the API, as history's Insert again does. */
async function openBox(g: Rig, id: string): Promise<void> {
  const before = g.opens.length;
  const res = await g.r.api("POST", `/dictations/${id}/insert`, {});
  expect(res.status).toBe(200);
  await until(() => g.opens.length > before, 5000, "the box opened");
  const text = g.opens.at(-1)?.text ?? "";
  await g.view.page.waitForFunction(
    (t) =>
      !(document.getElementById("draft") as HTMLElement).hidden &&
      (document.getElementById("draft-text") as HTMLTextAreaElement).value === t,
    text,
  );
}

const focused = (g: Rig) => g.view.page.evaluate(() => document.activeElement?.id ?? "");
const chipShown = (g: Rig) =>
  g.view.page.evaluate(() => !(document.getElementById("chip") as HTMLElement).hidden);

describe("DC-S1: the draft box's page over the real main side", () => {
  let g: Rig;
  beforeAll(async () => {
    g = await draftRig({ press: true, switches: ["--focus-change"] });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await g?.close();
  });

  test(
    "an automatic open leaves the keyboard alone, a click takes it, and Enter inserts where the dictation began",
    async () => {
      const d = dictation(g);
      await d.rebind();
      await until(() => d.log.items()[0]?.state === "drafted", 10_000, "the dictation drafted");
      const it = d.log.items()[0] as DictationItem;
      const page = g.view.page;
      await page.waitForFunction(
        () =>
          (document.getElementById("draft-text") as HTMLTextAreaElement).value ===
          "deploy kubernetis",
      );
      // The focus guard refused the paste: the box shows without the keyboard.
      expect(g.calls).toEqual(["showInactive"]);
      expect(await focused(g)).not.toBe("draft-text");
      expect(await page.textContent("#draft-app")).toBe("com.example.editor");
      // The fake engine gives no word confidences: nothing underlined, and the box says so.
      expect(await page.isVisible("#draft-noconf")).toBe(true);
      expect(await page.$$("#draft-marks mark")).toHaveLength(0);

      await page.click("#draft-text");
      expect(await focused(g)).toBe("draft-text");
      await page.fill("#draft-text", "deploy Kubernetes");
      await page.press("#draft-text", "Enter");
      await until(
        () => g.inserted().some((x) => x.text === "deploy Kubernetes"),
        10_000,
        "the insert",
      );
      await until(() => d.log.item(it.id)?.state === "inserted", 5000, "the dictation inserted");
      // The helper brought the captured target forward, then pasted there with no send key.
      const sent = g.commands().filter((c) => c.type === "focus" || c.type === "insert");
      expect(sent.map((c) => c.type)).toEqual(["insert", "focus", "insert"]);
      expect(sent[1]?.target).toEqual(it.target);
      expect(sent[2]).toMatchObject({ text: "deploy Kubernetes", send_key: "none" });
      expect(sent[2]?.target).toEqual(it.target);
      // The box stepped aside for the paste, and came back without the keyboard for the chip.
      await until(() => g.chips.length === 1, 5000, "the chip");
      expect(g.calls).toEqual(["showInactive", "hide", "showInactive"]);
      await page.waitForSelector("#chip:not([hidden])");
      expect(await page.textContent("#chip")).toContain('Learn "Kubernetes"?');
      expect(await page.textContent("#chip")).toContain("You changed kubernetis");
    },
    UI_TIMEOUT,
  );

  test(
    "Learn writes a dictation word to the vocabulary file, and Undo takes it back out",
    async () => {
      const page = g.view.page;
      await page.click("#chip-learn");
      await until(() => g.terms().includes("Kubernetes"), 5000, "the word learned");
      expect(await page.textContent("#chip")).toContain('Learned "Kubernetes"');
      await page.click("#chip-undo");
      const learn = () =>
        dictation(g)
          .log.events()
          .filter((e) => e.type === "dictation.learn")
          .map((e) => (e as { status: string }).status);
      // Undo takes the word out of the file first and writes `ignored` after: wait for both, or
      // the next test finds the box still closing.
      await until(() => learn().length === 3, 5000, "the undo written");
      expect(g.terms()).not.toContain("Kubernetes");
      expect(learn()).toEqual(["proposed", "accepted", "ignored"]);
    },
    UI_TIMEOUT,
  );

  test(
    "a deliberate open takes the keyboard, and Ctrl/Cmd+Enter inserts and presses the send key",
    async () => {
      seed(g, "d-send", "see you at the standup");
      const calls = g.calls.length;
      await openBox(g, "d-send");
      expect(g.calls.slice(calls)).toEqual(["show"]);
      expect(await focused(g)).toBe("draft-text");
      const mod = g.opens.at(-1)?.platform === "darwin" ? "Meta" : "Control";
      const before = g.inserted().length;
      await g.view.page.press("#draft-text", `${mod}+Enter`);
      await until(() => g.inserted().length > before, 10_000, "the insert");
      // dictation.sendKey's default. The fake helper logs the send key it pressed as a record of
      // its own right after the insert, so the insert is the last record with a text, not the last.
      const records = g.inserted().slice(before) as { text?: string; type?: string }[];
      expect(records.filter((x) => x.text !== undefined).at(-1)).toMatchObject({
        text: "see you at the standup",
        send_key: "Enter",
      });
      await until(() => g.answered.at(-1) === "insert", 5000, "the answer");
      // No edit, so no chip: the box closes.
      expect(g.calls.slice(calls)).toEqual(["show", "hide"]);
      expect(g.chips).toHaveLength(1);
    },
    UI_TIMEOUT,
  );

  test(
    "Escape writes discarded and inserts nothing",
    async () => {
      const d = dictation(g);
      const log = d.log;
      // A dictation the focus guard kept in the box.
      log.append({
        type: "dictation.started",
        id: "d-esc",
        target: TARGET,
        engine: "fast",
        by: "user",
      });
      log.append({
        type: "dictation.text",
        id: "d-esc",
        raw: "never mind",
        text: "never mind",
        language: "en",
        words: [],
        engine: "fast",
        model: "parakeet",
        ms: 90,
      });
      log.append({ type: "dictation.drafted", id: "d-esc", reason: "focus-changed" });
      await openBox(g, "d-esc");
      const before = g.inserted().length;
      await g.view.page.press("#draft-text", "Escape");
      await until(() => g.answered.at(-1) === "discard", 5000, "the discard");
      expect(log.item("d-esc")?.state).toBe("discarded");
      expect(log.events().at(-1)).toMatchObject({ type: "dictation.discarded", id: "d-esc" });
      expect(g.inserted()).toHaveLength(before);
      expect(g.calls.at(-1)).toBe("hide");
    },
    UI_TIMEOUT,
  );

  test(
    "a dictation made while the box has the keyboard goes at the end of its field (DC-A4)",
    async () => {
      seed(g, "d-more", "see you at the standup");
      await openBox(g, "d-more");
      const box = dictation(g).draft;
      // The window takes the keyboard: the page's own focus listener tells the main side.
      await g.view.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await until(() => box.takesDictation(), 5000, "the page's focus report");
      expect(box.append("d-more-2", "and bring the slides")).toBe(true);
      await g.view.page.waitForFunction(
        () =>
          (document.getElementById("draft-text") as HTMLTextAreaElement).value ===
          "see you at the standup and bring the slides",
      );
      // Positive control: the window loses the keyboard, and the box takes no dictation.
      await g.view.page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await until(() => !box.takesDictation(), 5000, "the page's blur report");
      expect(box.append("d-more-3", "never")).toBe(false);
      await g.view.page.press("#draft-text", "Escape");
      await until(() => g.answered.at(-1) === "discard", 5000, "the discard");
    },
    UI_TIMEOUT,
  );

  test(
    "the engine's unsure words are underlined, and no note shows (positive control for the note)",
    async () => {
      seed(g, "d-conf", "ship it to grafanna today", [
        { w: "ship", s: 0, e: 0.3, c: 0.97 },
        { w: "it", s: 0.3, e: 0.4, c: 0.95 },
        { w: "to", s: 0.4, e: 0.5, c: 0.93 },
        { w: "grafanna", s: 0.5, e: 1.0, c: 0.21 },
        { w: "today", s: 1.0, e: 1.4, c: 0.9 },
      ]);
      await openBox(g, "d-conf");
      const page = g.view.page;
      expect(await page.$$eval("#draft-marks mark", (m) => m.map((x) => x.textContent))).toEqual([
        "grafanna",
      ]);
      expect(await page.isVisible("#draft-noconf")).toBe(false);
      await page.press("#draft-text", "Escape");
      await until(() => g.answered.at(-1) === "discard", 5000, "the discard");
    },
    UI_TIMEOUT,
  );
});

describe("DC-S1, akou-w51.81: the other engine's word under an unsure one, over the real main side", () => {
  let g: Rig;
  beforeAll(async () => {
    g = await draftRig();
  }, UI_TIMEOUT);
  afterAll(async () => {
    await g?.close();
  });

  test(
    "a retry on fast underlines its unsure word, a click offers what best heard, and picking it changes the field",
    async () => {
      const d = dictation(g);
      // `best` read the dictation: text only, since Qwen gives no word times.
      const log = d.log;
      log.append({
        type: "dictation.started",
        id: "d-alt",
        target: TARGET,
        engine: "best",
        by: "user",
      });
      log.append({ type: "dictation.ended", id: "d-alt", reason: "released", seconds: 2 });
      log.append({
        type: "dictation.text",
        id: "d-alt",
        raw: "Ship it to Grafana today.",
        text: "Ship it to Grafana today.",
        language: "en",
        words: [],
        engine: "best",
        model: "qwen",
        ms: 300,
      });
      log.append({ type: "dictation.inserted", id: "d-alt", method: "paste", receipt_ms: 5 });
      // The engine is the fake here: fast's reading of the same audio, unsure of one word.
      const asked: string[] = [];
      (d as unknown as { retry: typeof d.retry }).retry = async (id, o = {}) => {
        asked.push(`${id} ${o.engine}`);
        return {
          ok: true,
          answer: {
            id,
            text: "ship it to grafanna today",
            raw: "ship it to grafanna today",
            language: "en",
            words: [
              { w: "ship", s: 0, e: 0.3, c: 0.97 },
              { w: "it", s: 0.3, e: 0.4, c: 0.95 },
              { w: "to", s: 0.4, e: 0.5, c: 0.93 },
              { w: "grafanna", s: 0.5, e: 1.0, c: 0.21 },
              { w: "today", s: 1.0, e: 1.4, c: 0.9 },
            ],
            engine: "fast",
            model: "parakeet",
            ms: 40,
          },
        };
      };
      await openBox(g, "d-alt");
      const page = g.view.page;
      expect(await page.$$("#draft-marks mark")).toHaveLength(0);
      const opens = g.opens.length;
      // The engine menu shows only with two engines or more: the retry's engine is set directly.
      expect(g.opens.at(-1)?.engines).toContain("fast");
      await page.$eval("#draft-retry-engine", (e) => {
        (e as HTMLSelectElement).value = "fast";
        e.dispatchEvent(new Event("change"));
      });
      expect(await page.textContent("#draft-retry")).toBe("↻ Retry with fast");
      await page.click("#draft-retry");
      await until(() => g.opens.length > opens, 5000, "the retry's reading");
      expect(asked).toEqual(["d-alt fast"]);
      await page.waitForFunction(
        () =>
          (document.getElementById("draft-text") as HTMLTextAreaElement).value ===
          "ship it to grafanna today",
      );
      expect(await page.$$eval("#draft-marks mark", (m) => m.map((x) => x.textContent))).toEqual([
        "grafanna",
      ]);
      // A click inside the underlined word offers what best heard there.
      await page.evaluate(() => {
        const f = document.getElementById("draft-text") as HTMLTextAreaElement;
        f.focus();
        f.setSelectionRange(13, 13);
        f.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await page.waitForSelector("#draft-alts:not([hidden])");
      expect(
        await page.$$eval("#draft-alts button.alt", (b) => b.map((x) => x.textContent)),
      ).toEqual(["Grafana"]);
      await page.click("#draft-alts button.alt");
      expect(await page.inputValue("#draft-text")).toBe("ship it to Grafana today");
      expect(await page.$$("#draft-marks mark")).toHaveLength(0);
      await page.press("#draft-text", "Escape");
      await until(() => g.answered.at(-1) === "discard", 5000, "the discard");
    },
    UI_TIMEOUT,
  );
});

describe("DC-L4: the chip asks once, from the draft box's page", () => {
  let g: Rig;
  let n = 0;
  beforeAll(async () => {
    g = await draftRig();
  }, UI_TIMEOUT);
  afterAll(async () => {
    await g?.close();
  });

  /** A dictation of `heard`, opened in the box, fixed to `fixed` and inserted with Enter. */
  async function fix(heard: string, fixed: string): Promise<{ id: string; chip: boolean }> {
    const id = `d${++n}`;
    seed(g, id, heard);
    await openBox(g, id);
    const chips = g.chips.length;
    const answers = g.answered.filter((a) => a === "insert").length;
    await g.view.page.fill("#draft-text", fixed);
    await g.view.page.press("#draft-text", "Enter");
    await until(
      () => g.answered.filter((a) => a === "insert").length > answers,
      10_000,
      "the insert answered",
    );
    const chip = g.chips.length > chips;
    if (chip) await g.view.page.waitForSelector("#chip:not([hidden])");
    else expect(await chipShown(g)).toBe(false);
    return { id, chip };
  }

  /** Waits out the chip's own time, after which it answers `ignore`. */
  const ignored = () =>
    g.view.page.waitForSelector("#chip", { state: "hidden", timeout: CHIP_ASK_MS + 5000 });

  const statuses = (id: string) =>
    dictation(g)
      .log.events()
      .filter((e) => e.type === "dictation.learn" && e.id === id)
      .map((e) => (e as { status: string }).status);

  test(
    "ignored, the same fix asks again at its third time, then never",
    async () => {
      const heard = "we moved the box to hetzna today";
      const fixed = "we moved the box to Hetzner today";
      const first = await fix(heard, fixed);
      expect(first.chip).toBe(true);
      expect(await g.view.page.textContent("#chip")).toContain('Learn "Hetzner"?');
      expect(await g.view.page.textContent("#chip")).toContain("You changed hetzna");
      // The chip asks with Learn and Not a word only: left alone, it answers ignore by itself.
      await ignored();
      await until(() => statuses(first.id).includes("ignored"), 5000, "ignored written");
      expect(statuses(first.id)).toEqual(["proposed", "ignored"]);
      expect((await fix(heard, fixed)).chip).toBe(false);
      const third = await fix(heard, fixed);
      expect(third.chip).toBe(true);
      await ignored();
      await until(() => statuses(third.id).includes("ignored"), 5000, "ignored written");
      expect((await fix(heard, fixed)).chip).toBe(false);
      expect((await fix(heard, fixed)).chip).toBe(false);
      expect(g.terms()).not.toContain("Hetzner");
    },
    UI_TIMEOUT,
  );

  test(
    "Not a word writes rejected, and the same fix never shows the chip again",
    async () => {
      const heard = "the tailskale node is down";
      const fixed = "the Tailscale node is down";
      const first = await fix(heard, fixed);
      expect(first.chip).toBe(true);
      await g.view.page.click("#chip-reject");
      await until(() => statuses(first.id).includes("rejected"), 5000, "rejected written");
      const again = await fix(heard, fixed);
      expect(again.chip).toBe(false);
      expect(statuses(again.id)).toEqual([]);
      expect(g.terms()).not.toContain("Tailscale");
    },
    UI_TIMEOUT,
  );

  test(
    "two candidates show two checkboxes, and Learn writes only the ticked one",
    async () => {
      const r = await fix(
        "move kubernetis and grafanna to the new box",
        "move Kubernetes and Grafana to the new box",
      );
      expect(r.chip).toBe(true);
      const page = g.view.page;
      expect(
        await page.$$eval("#chip input[data-term]", (b) => b.map((x) => x.dataset.term)),
      ).toEqual(["Kubernetes", "Grafana"]);
      await page.uncheck("#chip input[data-term='Grafana']");
      await page.click("#chip-learn");
      // The learner saves the word before it writes `accepted` and `ignored`: wait for all four
      // events, not only the word in the file.
      await until(() => statuses(r.id).length === 4, 5000, "the answer written");
      expect(g.terms()).toContain("Kubernetes");
      expect(g.terms()).not.toContain("Grafana");
      expect(statuses(r.id)).toEqual(["proposed", "proposed", "accepted", "ignored"]);
    },
    UI_TIMEOUT,
  );

  test(
    "with dictation.learn auto the entry is in the file before the chip reaches the page, which offers only Undo",
    async () => {
      const set = await g.r.api("PATCH", "/config", { "dictation.learn": "auto" });
      expect(set.status).toBe(200);
      const r = await fix("the zorblat build is green", "the Zorblax build is green");
      expect(r.chip).toBe(true);
      expect(g.chips.at(-1)).toMatchObject({
        chip: { id: r.id, mode: "learned" },
        terms: expect.arrayContaining(["Zorblax"]),
      });
      const page = g.view.page;
      expect(await page.textContent("#chip")).toContain('Learned "Zorblax"');
      expect(await page.$("#chip-learn")).toBeNull();
      await page.click("#chip-undo");
      await until(() => !g.terms().includes("Zorblax"), 5000, "the word taken back");
    },
    UI_TIMEOUT,
  );
});
