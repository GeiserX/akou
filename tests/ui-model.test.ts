/**
 * The window's rules without the DOM (docs/DESIGN.md section 7, `src/ui/model.ts`): the state
 * label, the banner, the final-pass note, speaker hues, durations and citations. The browser suite
 * (`bun run test:ui`) checks the same rules on the real page.
 */

import { describe, expect, test } from "bun:test";
import { formatWall } from "../src/core/log/clock.ts";
import { fold } from "../src/core/log/fold.ts";
import {
  banner,
  finalNote,
  formatDuration,
  HUES,
  HueBook,
  languages,
  presets,
  QUIET_AFTER_MS,
  REOPEN_AFTER_MS,
  resolveTimeCitation,
  splitCitations,
  stateLabel,
  suggestReopen,
  YOU_HUE,
} from "../src/ui/model.ts";
import { modelsCardText } from "../src/ui/models-text.ts";
import type { AppStatus } from "../src/ui/protocol.ts";
import { LogBuilder, T0, TZ } from "./helpers.ts";

function live(extra: (b: LogBuilder) => void = () => {}) {
  const b = new LogBuilder();
  b.created();
  b.partStarted(1, T0);
  extra(b);
  return fold(b.events);
}

const status = (liveCall: string | null): AppStatus =>
  ({
    app: { version: "0", headless: true },
    live: liveCall
      ? { call: liveCall, title: "", workspace: "", state: "recording", muted: false, lag: 0 }
      : null,
    last: null,
    asr: { state: "ready" },
    provider: { state: "available", id: "none" },
    share: { active: false },
  }) as AppStatus;

describe("speaker hues (hark-viewer parity)", () => {
  test("you are 214; others take the palette in order of first appearance; a repeat keeps its hue", () => {
    const h = new HueBook();
    expect(h.hue("you")).toBe(YOU_HUE);
    expect(h.hue("c3")).toBe(HUES[0]);
    expect(h.hue("c1")).toBe(HUES[1]);
    expect(h.hue("c3")).toBe(HUES[0]);
    expect(HUES).toEqual([36, 145, 285, 5, 178, 58, 325, 100]);
  });

  test("the palette wraps after eight speakers", () => {
    const h = new HueBook();
    for (let i = 1; i <= 8; i++) h.hue(`c${i}`);
    expect(h.hue("c9")).toBe(HUES[0]);
  });
});

describe("[T3.9] Offsets shown as times of day", () => {
  test("a duration always carries its units, never a bare mm:ss", () => {
    for (const s of [0, 5, 59, 60, 61, 125, 3599, 3600, 3725, 86_399]) {
      const d = formatDuration(s);
      expect(d).not.toMatch(/^\d{1,2}:\d{2}$/);
      expect(d).toMatch(/\d+ (s|min|h)/);
    }
    expect(formatDuration(125)).toBe("2 min 5 s");
    expect(formatDuration(3725)).toBe("1 h 2 min");
  });

  test("positive control: the check fails on the hark-style span", () => {
    expect("12:30").toMatch(/^\d{1,2}:\d{2}$/);
  });
});

describe("the state label (hark-viewer's states)", () => {
  const base = {
    disconnected: false,
    now: T0 + 60_000,
    lastLineAt: null,
    levelAt: T0 + 59_000,
    followedAt: T0,
    lines: 0,
  };

  test("ready with nothing on screen; another call recording when one is live elsewhere", () => {
    expect(stateLabel({ ...base, view: null, status: status(null) }).label).toBe("ready");
    expect(stateLabel({ ...base, view: null, status: status("x") }).label).toBe(
      "another call is recording",
    );
  });

  test("recording, paused, not capturing", () => {
    const v = live();
    expect(stateLabel({ ...base, view: v, status: status(v.call?.id ?? null) })).toMatchObject({
      cls: "recording",
      label: "rec",
    });
    const p = live((b) => b.add({ type: "pause", part: 1, a: 5, wall: T0 + 5000, mono: 1 }));
    expect(stateLabel({ ...base, view: p, status: null }).label).toBe("paused");
    // No level for more than 5 s while recording: nothing is being captured.
    expect(stateLabel({ ...base, view: v, status: null, levelAt: T0 }).label).toBe("not capturing");
  });

  test("saved, ended unexpectedly, interrupted, failed", () => {
    const ended = live((b) => {
      b.partEnded(1, "stop");
      b.add({ type: "call.ended", reason: "stop" });
    });
    expect(stateLabel({ ...base, view: ended, status: null, lines: 3 })).toMatchObject({
      label: "saved",
      meta: "3 lines",
    });
    const crashed = live((b) => b.partEnded(1, "crashed"));
    expect(stateLabel({ ...base, view: crashed, status: null }).label).toBe("ended unexpectedly");
    const interrupted = live((b) => {
      b.partEnded(1, "helper-exit");
      b.add({ type: "call.ended", reason: "interrupted" });
    });
    expect(stateLabel({ ...base, view: interrupted, status: null }).label).toBe("interrupted");
    const failed = fold([
      ...new LogBuilder().events,
      ...(() => {
        const b = new LogBuilder();
        b.created();
        b.add({ type: "call.failed", stage: "open", error: "permission denied" });
        return b.events;
      })(),
    ]);
    expect(stateLabel({ ...base, view: failed, status: null })).toMatchObject({
      label: "recording failed",
      meta: "open: permission denied",
    });
  });

  test("a connection lost for a while says so", () => {
    expect(stateLabel({ ...base, view: live(), status: null, disconnected: true }).label).toBe(
      "reconnecting",
    );
  });

  test("switching to a call already recording is no false alarm: with no level yet, the wait counts from when the page started following it", () => {
    // The part started a minute ago; the page opened the call 400 ms ago and has no level yet.
    const v = live();
    const at = (followedAt: number | null) =>
      stateLabel({ ...base, view: v, status: null, levelAt: null, followedAt }).label;
    expect(at(T0 + 59_600)).toBe("rec");
    // Not open yet: no verdict either.
    expect(at(null)).toBe("rec");
    // Positive control: still no level 6 s after the page started following: not capturing.
    expect(at(T0 + 54_000)).toBe("not capturing");
    // A call the page followed since before it started keeps the part-age rule.
    expect(at(T0 - 30_000)).toBe("not capturing");
    expect(
      stateLabel({
        ...base,
        now: T0 + 3000,
        view: v,
        status: null,
        levelAt: null,
        followedAt: T0 - 30_000,
      }).label,
    ).toBe("rec");
  });

  test("[ElectroBun #518] the window's RPC socket taken over: a connection lost for long in the window says to reopen it", () => {
    const lost = stateLabel({
      ...base,
      view: live(),
      status: null,
      disconnected: true,
      reopen: true,
    });
    expect(lost.label).toBe("reconnecting");
    expect(lost.meta).toContain("close this window and open it again");
    // Positive control: without the hint the page only says it is retrying.
    expect(
      stateLabel({ ...base, view: live(), status: null, disconnected: true }).meta,
    ).not.toContain("close this window");
    // Only the window suggests it, and only once the loss outlasts a follow request's timeout.
    const since = T0;
    expect(suggestReopen("window", since, since + REOPEN_AFTER_MS + 1)).toBe(true);
    expect(suggestReopen("window", since, since + 3_000)).toBe(false);
    expect(suggestReopen("window", null, since + REOPEN_AFTER_MS + 1)).toBe(false);
    expect(suggestReopen("browser", since, since + REOPEN_AFTER_MS + 1)).toBe(false);
    expect(REOPEN_AFTER_MS).toBeGreaterThan(30_000);
  });
});

describe("the banner: red proven, amber guess or lag, grey quiet, green recovered", () => {
  const input = {
    now: T0 + 10_000,
    lastLineAt: T0 + 9_000,
    callHeardAt: T0 + 9_000,
    levelAt: T0 + 9_900,
    platform: "mac" as const,
  };
  const health = (state: string, extra: Record<string, unknown> = {}) =>
    ({
      type: "health",
      part: 1,
      ch: "call",
      state,
      silentFor: 12,
      rebuilds: 1,
      detail: "",
      ...extra,
    }) as never;

  test("nothing wrong, no banner", () => {
    expect(banner({ ...input, view: live() })).toBeNull();
  });

  test("a dead call side is red, says how long and offers Restart", () => {
    const b = banner({ ...input, view: live((x) => x.add(health("dead"))) });
    expect(b?.kind).toBe("dead");
    expect(b?.text).toContain("CALL AUDIO LOST");
    expect(b?.text).toContain("1 rebuild so far");
    expect(b?.action).toBe("restart");
  });

  test("a stalled capture and an interrupted call are red too", () => {
    expect(banner({ ...input, view: live((x) => x.add(health("stalled"))) })?.kind).toBe("dead");
    const v = live((x) => {
      x.partEnded(1, "helper-exit");
      x.add({ type: "call.ended", reason: "interrupted" });
    });
    expect(banner({ ...input, view: v })).toMatchObject({ kind: "dead", action: "restart" });
  });

  test("a suspected permission names the pane and offers to open it", () => {
    const b = banner({ ...input, view: live((x) => x.add(health("permission-suspect"))) });
    expect(b).toMatchObject({ kind: "permission", action: "open-settings" });
    expect(b?.text).toContain("System Settings > Privacy & Security > System Audio Recording");
  });

  test("a lagging transcript is amber with the seconds", () => {
    const b = banner({
      ...input,
      view: live((x) => x.add({ type: "asr.lag", part: 1, seconds: 42 })),
    });
    expect(b).toMatchObject({ kind: "lag" });
    expect(b?.text).toContain("42 s behind");
  });

  test("no new lines for a while is an amber guess, never red", () => {
    const b = banner({ ...input, view: live(), lastLineAt: T0, now: T0 + QUIET_AFTER_MS + 5000 });
    expect(b?.kind).toBe("guess");
    expect(b?.text).toContain("no new lines for 1 min 35 s");
  });

  test("a quiet call side is grey", () => {
    const now = T0 + QUIET_AFTER_MS + 10_000;
    const b = banner({
      ...input,
      view: live(),
      now,
      lastLineAt: now - 1000,
      callHeardAt: T0,
      levelAt: now,
    });
    expect(b?.kind).toBe("quiet");
  });

  test("the call side back after a death is green for a while", () => {
    const v = live((x) => {
      x.add(health("dead"));
      x.add(health("ok", { rebuilds: 2 }));
    });
    const okAt = (v.channelHealth("call") as { t: number }).t;
    expect(banner({ ...input, view: v, now: okAt + 1000 })).toMatchObject({
      kind: "recovered",
      text: "call audio is back after 2 rebuilds",
    });
    expect(
      banner({
        ...input,
        view: v,
        now: okAt + 60_000,
        lastLineAt: okAt + 59_000,
        callHeardAt: okAt + 59_000,
      }),
    ).toBeNull();
  });
});

describe("the final pass note and the languages chip", () => {
  const ended = (extra: (b: LogBuilder) => void) =>
    live((b) => {
      b.partEnded(1, "stop");
      b.add({ type: "call.ended", reason: "stop" });
      extra(b);
    });

  test("running with progress, failed with the error, done with skipped spans and the warning", () => {
    const running = ended((b) => b.add({ type: "final.started", pid: 1 }));
    expect(finalNote(running)).toMatchObject({ state: "running", progress: 0 });
    const failed = ended((b) => {
      b.add({ type: "final.started", pid: 1 });
      b.add({ type: "final.failed", step: "diarize", error: "model missing" });
    });
    expect(finalNote(failed)?.text).toBe("final transcript: failed (model missing)");
    const done = ended((b) => {
      b.add({ type: "final.started", pid: 1 });
      b.add({ type: "final.part.done", part: 1 });
      b.add({
        type: "final.done",
        parts: [1],
        skipped: [{}, {}],
        warning: "call side had energy but no text",
      });
    });
    expect(finalNote(done)?.text).toBe(
      "final transcript: ready (2 spans skipped)  ·  call side had energy but no text",
    );
    expect(languages(done)).toEqual([]);
  });

  test("the languages chip only when a model reported them", () => {
    const v = ended((b) =>
      b.add({ type: "final.done", parts: [1], skipped: [], languages: ["en", "es"] }),
    );
    expect(languages(v)).toEqual(["en", "es"]);
    expect(finalNote(ended(() => {}))).toBeNull();
  });
});

describe("citations", () => {
  test("wall-clock and segment citations are split out of the text, the rest stays text", () => {
    expect(splitCitations("Ben said so [15:41 Ben] and [#l000031]; see #f000002.")).toEqual([
      { kind: "text", text: "Ben said so " },
      { kind: "time", text: "[15:41 Ben]", time: "15:41", speaker: "Ben" },
      { kind: "text", text: " and " },
      { kind: "seg", text: "[#l000031]", id: "l000031" },
      { kind: "text", text: "; see " },
      { kind: "seg", text: "#f000002", id: "f000002" },
      { kind: "text", text: "." },
    ]);
  });

  test("a [HH:MM Name] citation resolves to the line of that speaker in that minute", () => {
    const v = live((b) => {
      b.seg({ id: "l000001", ch: "call", spk: "c2", w0: T0 + 1000, text: "move the build" });
      b.add({ type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    });
    const minute = formatWall(T0 + 1000, TZ, { seconds: false });
    expect(resolveTimeCitation(v, minute, "Ben", [])).toBe("l000001");
    expect(resolveTimeCitation(v, minute, "Nobody", [])).toBeNull();
    // The answer's own ids win even when the speaker was renamed since.
    expect(resolveTimeCitation(v, minute, "Old name", ["l000001"])).toBe("l000001");
  });

  test("the presets, with one per named speaker", () => {
    const p = presets(["Ben"]).map((x) => x.label);
    expect(p).toEqual([
      "Catch me up",
      "Was my name mentioned?",
      "Decisions so far",
      "Action items",
      "What did Ben say?",
    ]);
  });
});

describe("the first-run download card", () => {
  test("hidden once the models are there; offers the download, shows progress, offers a retry", () => {
    const base = { dir: "/m", bytes: 0, total: 700_000_000 };
    expect(modelsCardText(undefined)).toBeNull();
    expect(modelsCardText({ ...base, state: "ready", bytes: base.total })).toBeNull();
    const missing = modelsCardText({ ...base, state: "missing" });
    expect(missing?.button).toBe("Download speech models");
    expect(missing?.text).toContain("700 MB");
    const down = modelsCardText({
      ...base,
      state: "downloading",
      bytes: 350_000_000,
      file: "x/a.onnx",
    });
    expect(down?.button).toBeNull();
    expect(down?.progress).toBe(0.5);
    expect(down?.text).toContain("50 %");
    const failed = modelsCardText({ ...base, state: "failed", error: "a.onnx: SHA-256 mismatch" });
    expect(failed?.button).toBe("Try again");
    expect(failed?.text).toContain("SHA-256 mismatch");
    // A file that fails its checksum is deleted and fetched again: the card must not say it is kept.
    expect(failed?.text).not.toContain("What arrived is kept");
    expect(failed?.text).toContain("the one that failed is fetched again");
  });
});
