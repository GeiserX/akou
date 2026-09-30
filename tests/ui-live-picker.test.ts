/**
 * What the Record row's live model menu lists (docs/ux/WINDOW.md W3.19, `src/ui/live-options.ts`),
 * without the DOM: only the setups whose every model is on disk, Automatic first when one is, never
 * an unavailable setup, and the checked line. The browser suite (`tests/ui/live-picker.test.ts`)
 * checks the same menu on the real page.
 */

import { describe, expect, test } from "bun:test";
import type { LiveSetupView, LiveView } from "../src/main/asr/live-setups.ts";
import { liveChecked, liveNote, liveOptions } from "../src/ui/live-options.ts";

type State = "ready" | "downloading" | "missing";
const none: LiveSetupView["accuracy"] = { score: null, not_measured: "not measured" };

function setup(id: LiveSetupView["id"], models: State[], unavailable: string | null = null) {
  return {
    id,
    title: id,
    what: id,
    plain: id,
    unavailable,
    selected: false,
    running: false,
    models: models.map((state, i) => ({ id: `${id}-${i}`, state })),
    accuracy: none,
    latency: none,
    cores: none,
    memory: none,
  } satisfies LiveSetupView;
}

function view(
  setting: LiveView["setting"],
  s: { parakeet: State[]; nemotron: State[]; upgrade: State[] },
): LiveView {
  return {
    setting,
    next: "parakeet",
    note: null,
    running: null,
    setups: [
      setup("parakeet", s.parakeet),
      setup("nemotron", s.nemotron),
      setup("upgrade", s.upgrade),
      // Voxtral lists no models and is unavailable: never a line, whatever the disk holds.
      setup("voxtral", [], "not in this version"),
    ],
  };
}

const ids = (v: LiveView) => liveOptions(v).map((o) => o.id);

describe("W3.19: the live model menu's lines", () => {
  test("every setup downloaded: Automatic, then streaming, the Qwen rewrite and Parakeet", () => {
    const v = view("auto", {
      parakeet: ["ready"],
      nemotron: ["ready"],
      upgrade: ["ready", "ready", "ready"],
    });
    expect(ids(v)).toEqual(["auto", "nemotron", "upgrade", "parakeet"]);
    const upgrade = liveOptions(v).find((o) => o.id === "upgrade");
    expect(upgrade?.title).toBe("Streaming + Qwen rewrite");
    // Plain words, no accuracy figures.
    for (const o of liveOptions(v)) expect(o.line).not.toMatch(/WER|%/);
  });

  test("Automatic names the Qwen review when the Mac allows it, and Nemotron when it does not", () => {
    const all: Parameters<typeof view>[1] = {
      parakeet: ["ready"],
      nemotron: ["ready"],
      upgrade: ["ready", "ready", "ready"],
    };
    const roomy = { ...view("auto", all), auto: "upgrade" as const };
    expect(liveOptions(roomy)[0]?.line).toBe(
      "Picks the best one here: Streaming + Qwen rewrite now.",
    );
    const tight = { ...view("auto", all), auto: "nemotron" as const };
    expect(liveOptions(tight)[0]?.line).toBe("Picks the best one here: Streaming (Nemotron) now.");
  });

  test("a setup with one model missing or still downloading is not listed", () => {
    const v = view("auto", {
      parakeet: ["ready"],
      nemotron: ["downloading"],
      upgrade: ["downloading", "ready", "missing"],
    });
    expect(ids(v)).toEqual(["auto", "parakeet"]);
    // Automatic says what it runs here: Parakeet, with no streaming model on disk.
    expect(liveOptions(v)[0]?.line).toContain("Parakeet between pauses");
  });

  test("nothing downloaded: no line at all, not even Automatic", () => {
    const v = view("auto", { parakeet: ["missing"], nemotron: ["missing"], upgrade: ["missing"] });
    expect(liveOptions(v)).toEqual([]);
    expect(liveChecked(v, liveOptions(v))).toBeNull();
    expect(liveNote(v, liveOptions(v))).toBeNull();
  });

  test("the check is on asr.live when it is listed, else on nothing, with a note naming what runs", () => {
    const listed = view("nemotron", {
      parakeet: ["ready"],
      nemotron: ["ready"],
      upgrade: ["missing"],
    });
    expect(liveChecked(listed, liveOptions(listed))).toBe("nemotron");
    expect(liveNote(listed, liveOptions(listed))).toBeNull();
    // The upgrade was chosen, then its Qwen deleted: the check does not move to Automatic, which
    // nobody picked, and the note says what calls run meanwhile. asr.live stays the upgrade.
    const gone = {
      ...view("upgrade", { parakeet: ["ready"], nemotron: ["ready"], upgrade: ["missing"] }),
      next: "nemotron" as const,
    };
    expect(liveChecked(gone, liveOptions(gone))).toBeNull();
    expect(liveNote(gone, liveOptions(gone))).toBe(
      "Streaming + Qwen rewrite is not downloaded, so calls run Streaming (Nemotron) until it is.",
    );
  });
});
