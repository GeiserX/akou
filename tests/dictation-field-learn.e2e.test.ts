/**
 * Learning from a fix made in the app's own field after a direct insert (docs/ux/DICTATION.md
 * DC-L2, DC-L4, DC-O4), over a whole app with the fake helper and the fake engine: the insert asks
 * for the read-back, the helper's hunks become the same offer as a fix in the draft box, the chip
 * goes to the pill's followers, and with the pill off the shell shows one notification and the fix
 * waits in the words to review. The fake helper answers the read-back right after the receipt; no
 * window, key, device, field or clipboard is touched.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyInput } from "../src/core/dictation/activation.ts";
import type { DictationFollow, DictationService } from "../src/main/dictation/service.ts";
import { parseVocab } from "../src/main/vocab/files.ts";
import type { Chip } from "../src/ui/pill-protocol.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";
import { shellOn } from "./shell-helpers.ts";

setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const RC = "RightCommand";
/** The user fixed the word the fake engine hears wrong, in the field akou pasted into. */
const FIX = JSON.stringify([{ inserted: "kubernetis", now: "Kubernetes", at: 1 }]);

const lines = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

interface Rig {
  r: AppRig;
  d: DictationService;
  chips: Chip[];
  commands(): { type: string; read_field?: boolean }[];
  /** Plays the one press, "deploy kubernetes", which the fake engine hears as "kubernetis". */
  press(): Promise<void>;
}

async function rig(switches: string[], settings: Record<string, unknown> = {}): Promise<Rig> {
  const t = tempDir("akou-dict-field-");
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
      // The press waits for a second rebind, sent once the test follows the service.
      "--play-after-rebinds",
      "2",
      "--commands-log",
      join(t.dir, "commands.jsonl"),
      ...switches,
    ],
    settings: {
      "dictation.enabled": true,
      "dictation.hotkey": RC,
      "dictation.pill": "off",
      "dictation.learn": "ask",
      ...settings,
    },
  });
  cleanups.push(() => r.close());
  await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
  const d = r.app.dictation();
  if (!d) throw new Error("the app runs no dictation");
  const chips: Chip[] = [];
  const unfollow = d.follow((m: DictationFollow) => {
    if (m.kind === "chip") chips.push(m.chip);
  });
  cleanups.push(unfollow);
  return {
    r,
    d,
    chips,
    commands: () => lines(join(t.dir, "commands.jsonl")),
    press: async () => {
      await d.rebind();
      await until(() => d.log.items()[0]?.state === "inserted", 10_000, "the dictation inserted");
    },
  };
}

const learnEvents = (d: DictationService) =>
  d.log.events().filter((e) => e.type === "dictation.learn");

describe("DC-L2: a fix in the app's field is offered like one in the draft box", () => {
  test("the insert asks for the read-back, and the fix becomes a proposed word and a chip", async () => {
    const g = await rig(["--edit", FIX]);
    await g.press();
    await until(() => g.chips.length === 1, 10_000, "the chip");
    const it = g.d.log.items()[0];
    if (!it) throw new Error("no dictation");
    expect(it.text).toBe("deploy kubernetis");
    expect(g.commands().find((c) => c.type === "insert")).toMatchObject({ read_field: true });
    // The log keeps the changed run only, never the field's other text.
    expect(g.d.log.events().find((e) => e.type === "dictation.edit")).toMatchObject({
      id: it.id,
      hunks: [{ inserted: "kubernetis", now: "Kubernetes" }],
    });
    expect(learnEvents(g.d)).toEqual([
      expect.objectContaining({
        id: it.id,
        term: "Kubernetes",
        heard: "kubernetis",
        status: "proposed",
        evidence: "none",
      }),
    ]);
    expect(g.chips).toEqual([
      { id: it.id, candidates: [{ term: "Kubernetes", heard: "kubernetis" }], mode: "ask" },
    ]);

    // Learn from the pill: a dictation-only word in the user's file.
    expect(await g.d.answerChip({ id: it.id, action: "learn", terms: ["Kubernetes"] })).toBe(true);
    const file = parseVocab(readFileSync(join(g.r.app.configDir, "vocabulary.yaml"), "utf8"));
    expect(file.file.entries).toEqual([
      expect.objectContaining({
        term: "Kubernetes",
        heard: ["kubernetis"],
        entryScope: "dictation",
      }),
    ]);
    expect(learnEvents(g.d).map((e) => e.status)).toEqual(["proposed", "accepted"]);
  });

  test("positive control: with dictation.readField off nothing is asked, read or offered", async () => {
    const g = await rig(["--edit", FIX], { "dictation.readField": false });
    await g.press();
    await g.d.session()?.settled();
    const insert = g.commands().find((c) => c.type === "insert");
    expect(insert).toBeDefined();
    expect(insert).not.toHaveProperty("read_field");
    expect(insert).not.toHaveProperty("smart_spacing");
    expect(g.d.log.events().some((e) => e.type === "dictation.edit")).toBe(false);
    expect(learnEvents(g.d)).toEqual([]);
    expect(g.chips).toEqual([]);
  });

  test("a field that cannot be read records why, and offers nothing", async () => {
    const g = await rig(["--dormant-tree"]);
    await g.press();
    await until(
      () => g.d.log.items()[0]?.learn === "unreadable",
      10_000,
      "the item to record the unreadable field",
    );
    const id = g.d.log.items()[0]?.id as string;
    const got = await g.r.api("GET", `/dictations/${id}`);
    expect(got.body).toMatchObject({ id, learn: "unreadable" });
    expect(learnEvents(g.d)).toEqual([]);
    expect(g.chips).toEqual([]);
  });
});

describe("DC-O4: with the pill off, one notification and a word to review", () => {
  test("the chip becomes one notification naming no word, and the fix waits in the words to review", async () => {
    const g = await rig(["--edit", FIX]);
    const { shell, f } = await shellOn(g.r);
    cleanups.push(() => shell.close());
    await g.press();
    await until(() => learnEvents(g.d).length === 1, 10_000, "the proposed word");
    await until(
      () => f.notices.some((n) => n.title.includes("you fixed")),
      5000,
      "the notification",
    );
    const notices = f.notices.filter((n) => n.title.includes("you fixed"));
    expect(notices).toEqual([
      {
        title: "akou can learn a word you fixed",
        body: "It waits in Words to review on the Dictation page.",
      },
    ]);
    expect(JSON.stringify(notices)).not.toMatch(/kubernet/i);
    // Released with nothing written: the chip cannot be answered, and the pair waits.
    const id = g.d.log.items()[0]?.id as string;
    expect(await g.d.answerChip({ id, action: "ignore" })).toBe(false);
    const listed = await g.r.api("GET", "/vocab?dictation=true");
    expect(listed.body.dictation).toMatchObject([
      { term: "Kubernetes", heard: "kubernetis", status: "proposed", id },
    ]);
  });
});
