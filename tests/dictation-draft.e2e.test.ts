/**
 * The draft box over a whole app (docs/ux/DICTATION.md DC-S1, DC-N9, DC-L1, DC-L4, DC-L6, DC-G1):
 * the fake helper refuses the insert because the keyboard moved, the text waits in the draft box,
 * the user fixes a word and presses Enter, the helper brings the target back and inserts there,
 * and Learn writes a dictation word that the next dictation uses. The draft window is a recording
 * fake; no window, key, device or clipboard is touched.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import type { DraftWindow } from "../src/main/dictation/draft.ts";
import { parseVocab } from "../src/main/vocab/files.ts";
import type { DraftOpen } from "../src/ui/dictation-protocol.ts";
import type { Chip } from "../src/ui/pill-protocol.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const RC = "RightCommand";
const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** A recording draft window: what it was told, and whether it took the keyboard. */
function fakeWindow() {
  const w = {
    opens: [] as DraftOpen[],
    chips: [] as Chip[],
    calls: [] as string[],
    window: null as unknown as DraftWindow,
  };
  w.window = {
    open: (d) => {
      w.opens.push(d);
      w.calls.push(d.focus ? "show" : "showInactive");
    },
    chip: (c) => w.chips.push(c),
    append: () => {},
    showInactive: () => w.calls.push("showInactive"),
    hide: () => w.calls.push("hide"),
  };
  return w;
}

interface Rig {
  r: AppRig;
  dir: string;
  commands(): { type: string; id?: string; send_key?: string; target?: unknown }[];
  inserted(): { id: string; text: string }[];
}

/** An app whose one press says "deploy kubernetes", the fake engine hearing "kubernetis". */
async function rig(switches: string[] = []): Promise<Rig> {
  const t = tempDir("akou-dict-draft-");
  cleanups.push(t.cleanup);
  const keys = join(t.dir, "keys.jsonl");
  const press: KeyInput[] = [
    { at: 0, key: RC, down: true },
    { at: 2500, key: RC, down: false },
  ];
  writeFileSync(keys, press.map((k) => JSON.stringify(k)).join("\n"));
  const wav = join(t.dir, "mic.wav");
  writeFileSync(wav, monoWav(concat(silence(0.5), speak(["deploy", "kubernetes"]), silence(3))));
  const r = await appRig({
    helperArgs: [
      "--wav",
      wav,
      "--keys",
      keys,
      // The keys wait for a second rebind, sent once the test has its window in place.
      "--play-after-rebinds",
      "2",
      "--commands-log",
      join(t.dir, "commands.jsonl"),
      "--inserter-log",
      join(t.dir, "inserted.jsonl"),
      ...switches,
    ],
    settings: {
      "dictation.enabled": true,
      "dictation.hotkey": RC,
      "dictation.pill": "off",
      "dictation.learn": "ask",
    },
  });
  cleanups.push(() => r.close());
  await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
  return {
    r,
    dir: t.dir,
    commands: () => lines(join(t.dir, "commands.jsonl")),
    inserted: () => lines(join(t.dir, "inserted.jsonl")),
  };
}

async function clip(r: AppRig, words: string[]) {
  const form = new FormData();
  form.append("file", new Blob([monoWav(concat(silence(0.3), speak(words), silence(0.5)))]));
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations`, {
    method: "POST",
    headers: { authorization: `Bearer ${r.token}`, "x-akou-client": "test" },
    body: form,
  });
  return (await res.json()) as { id: string; text: string; raw: string };
}

describe("DC-S1, DC-N9: a refused insert waits in the draft box", () => {
  test("the text opens without the keyboard, Enter inserts where it began, and Learn teaches the next dictation", async () => {
    const g = await rig(["--focus-change"]);
    const d = g.r.app.dictation();
    if (!d) throw new Error("no dictation");
    const w = fakeWindow();
    d.draft.attach(w.window);
    await d.rebind();
    await until(() => d.log.items()[0]?.state === "drafted", 10_000, "the dictation drafted");
    const it = d.log.items()[0];
    if (!it) throw new Error("no dictation");
    expect(d.log.events().find((e) => e.type === "dictation.drafted")).toMatchObject({
      id: it.id,
      reason: "focus-changed",
    });
    // An automatic open never takes the keyboard.
    expect(w.calls).toEqual(["showInactive"]);
    expect(w.opens[0]).toMatchObject({
      id: it.id,
      text: "deploy kubernetis",
      to: "com.example.editor",
      focus: false,
    });

    // Enter with the word fixed: the helper brings the target forward, then inserts there.
    expect(
      await d.draft.handlers.insert({ id: it.id, text: "deploy Kubernetes", send: false }),
    ).toBe(true);
    expect(d.log.item(it.id)?.state).toBe("inserted");
    const sent = g.commands().filter((c) => c.type === "focus" || c.type === "insert");
    expect(sent.map((c) => c.type)).toEqual(["insert", "focus", "insert"]);
    expect(sent[1]?.target).toEqual(it.target);
    expect(sent[2]).toMatchObject({ send_key: "none", target: it.target });
    expect(g.inserted().at(-1)).toMatchObject({ text: "deploy Kubernetes" });

    // The fix is offered once, as a chip in the box, and the word is proposed in the log.
    const learn = d.log.events().filter((e) => e.type === "dictation.learn");
    expect(learn).toEqual([
      expect.objectContaining({ term: "Kubernetes", heard: "kubernetis", status: "proposed" }),
    ]);
    expect(w.chips).toEqual([
      { id: it.id, candidates: [{ term: "Kubernetes", heard: "kubernetis" }], mode: "ask" },
    ]);

    // Learn: a dictation-only word in the user's file, and the next dictation says it.
    expect(await d.draft.handlers.chip({ id: it.id, action: "learn", terms: ["Kubernetes"] })).toBe(
      true,
    );
    const file = parseVocab(readFileSync(join(g.r.app.configDir, "vocabulary.yaml"), "utf8"));
    expect(file.file.entries).toEqual([
      expect.objectContaining({
        term: "Kubernetes",
        heard: ["kubernetis"],
        source: `dictation:${it.id}`,
        entryScope: "dictation",
      }),
    ]);
    expect(d.log.events().at(-1)).toMatchObject({ type: "dictation.learn", status: "accepted" });
    const next = await clip(g.r, ["deploy", "kubernetes"]);
    expect(next).toMatchObject({ text: "deploy Kubernetes", raw: "deploy kubernetis" });
  });

  test("with no draft box the refused insert fails as before (positive control)", async () => {
    const g = await rig(["--focus-change"]);
    const d = g.r.app.dictation();
    if (!d) throw new Error("no dictation");
    await d.rebind();
    await until(() => d.log.items()[0]?.state === "failed", 10_000, "the dictation failed");
    expect(d.log.items()[0]?.error).toBe("insert: focus-changed");
  });
});

describe("DC-G1: POST /v1/dictations/{id}/insert opens the draft box and pastes nothing", () => {
  test("it opens taking the keyboard, and no insert reaches the helper", async () => {
    const g = await rig();
    const d = g.r.app.dictation();
    if (!d) throw new Error("no dictation");
    await d.rebind();
    await until(() => d.log.items()[0]?.state === "inserted", 10_000, "the dictation inserted");
    const id = d.log.items()[0]?.id as string;
    const before = g.inserted().length;

    // No window: the route says why.
    const none = await g.r.api("POST", `/dictations/${id}/insert`, {});
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ error: "no_draft_box" });

    const w = fakeWindow();
    d.draft.attach(w.window);
    const res = await g.r.api("POST", `/dictations/${id}/insert`, { text: "deploy it" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, opened: true, fix: false });
    expect(w.calls).toEqual(["show"]);
    expect(w.opens[0]).toMatchObject({ id, text: "deploy it", focus: true });
    expect(g.inserted()).toHaveLength(before);

    expect((await g.r.api("POST", "/dictations/dnope/insert", {})).status).toBe(404);
    // A clip went to no app: only Fix can open it.
    const c = await clip(g.r, ["hello"]);
    const noTarget = await g.r.api("POST", `/dictations/${c.id}/insert`, {});
    expect(noTarget.body).toMatchObject({ error: "no_target" });
    expect((await g.r.api("POST", `/dictations/${c.id}/insert`, { fix: true })).status).toBe(200);
  });
});
