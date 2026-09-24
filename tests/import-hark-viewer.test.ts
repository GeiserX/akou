/**
 * `akou import hark-viewer` (docs/DESIGN.md section 6.1, REQUIREMENTS I2.10 to I2.12): predecessor
 * call folders, in the formats hark-viewer and hark wrote, become akou calls with every part, the
 * accurate pass as the final layer and the speakers mapped. The folders are synthetic.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { formatWall } from "../src/core/log/clock.ts";
import type { LogEvent } from "../src/core/log/events.ts";
import { fold } from "../src/core/log/fold.ts";
import { readLog } from "../src/core/log/reader.ts";
import {
  ImportError,
  importHarkViewer,
  importId,
  readHarkViewerFolder,
} from "../src/main/import/hark-viewer.ts";
import { HV_STARTED, writeHarkViewerCall } from "./fixtures/hark-viewer.ts";
import { tempDir } from "./helpers.ts";

const TZ = "America/Chicago";
const opts = (root: string) => ({ root, user: "Ana", tz: TZ, version: "0.1.0" });

async function imported(spec?: Parameters<typeof writeHarkViewerCall>[2]) {
  const t = tempDir("akou-import-");
  const src = writeHarkViewerCall(join(t.dir, "calls", "team"), undefined, spec);
  const root = join(t.dir, "akou");
  const r = importHarkViewer(src, opts(root));
  const log = await readLog(join(r.folder, "events.jsonl"));
  return { t, src, root, r, log, view: fold(log.events) };
}

describe("importing a hark-viewer call", () => {
  test("every part, the live and the final lines, one log with nothing invalid in it", async () => {
    const { t, r, log, view } = await imported();
    try {
      expect(r).toMatchObject({
        workspace: "team",
        parts: 2,
        segments: { live: 7, final: 5 },
        speakers: 6,
        audio: { copied: 2, missing: 0 },
      });
      expect(log.invalid).toEqual([]);
      expect(log.torn).toBeNull();
      expect(view.call).toMatchObject({
        title: "Release sync",
        workspace: "team",
        user: "Ana",
        tz: TZ,
      });
      expect(view.state).toBe("ended");
      expect(view.final.state).toBe("done");
      expect(view.final.done?.languages).toEqual(["en"]);
      expect(view.parts().map((p) => [p.part, p.file, p.wallStart])).toEqual([
        [1, "audio/part-001.opus", HV_STARTED * 1000],
        [2, "audio/part-002.opus", (HV_STARTED + 300) * 1000],
      ]);
      expect(view.parts().map((p) => p.ended?.fileSeconds)).toEqual([290, 120]);
    } finally {
      t.cleanup();
    }
  });

  test("wall-clock times per part: part 2's lines sit 300 s after the call's start", async () => {
    const { t, view } = await imported();
    try {
      const live = view.lines("live");
      const back = live.find((l) => l.text === "back again after the restart");
      expect(back?.part).toBe(2);
      expect(back?.w0).toBe((HV_STARTED + 301) * 1000);
      expect(back?.a0).toBe(1);
      const fin = view.lines("final").find((l) => l.text === "Second part talk.");
      expect(fin).toMatchObject({ part: 2, a0: 3, w0: (HV_STARTED + 303) * 1000 });
    } finally {
      t.cleanup();
    }
  });

  test("a part with no `started` follows the end of the part before it, not the call's start", async () => {
    const { t, view } = await imported({
      meta: {
        parts: [
          { n: 1, audio: "audio.opus", transcript: "transcript.json", started: HV_STARTED },
          { n: 2, audio: "audio.part2.opus", transcript: "transcript.part2.json" },
        ],
      },
    });
    try {
      // Part 1's audio is 290 s long, so part 2 starts where it ended.
      expect(view.parts().map((p) => p.wallStart)).toEqual([
        HV_STARTED * 1000,
        (HV_STARTED + 290) * 1000,
      ]);
      const back = view.lines("live").find((l) => l.text === "back again after the restart");
      expect(back).toMatchObject({ part: 2, w0: (HV_STARTED + 291) * 1000 });
      // A final line early on the call's clock is part 1's, one past part 1's end is part 2's.
      const fin = view.lines("final");
      expect(fin.find((l) => l.text === "Hello team.")).toMatchObject({ part: 1, a0: 1 });
      expect(fin.find((l) => l.text === "Second part talk.")).toMatchObject({ part: 2, a0: 13 });
    } finally {
      t.cleanup();
    }
  });

  test("speakers mapped: you on the mic, Speaker N per part, Others unknown, a name kept", async () => {
    const { t, view } = await imported();
    try {
      const who = Object.fromEntries(
        view.lines("live").map((l) => [l.text, [l.ch, l.spk, l.speaker]]),
      );
      expect(who["hello team"]).toEqual(["mic", "you", "Ana"]);
      expect(who["the release is on friday"]).toEqual(["call", "c1", "Speaker 1"]);
      expect(who["I will test the codename zephyr build"]).toEqual(["call", "c2", "Speaker 2"]);
      expect(who["background chatter"]).toEqual(["call", "c?", "Unknown speaker"]);
      expect(who["this is Ben speaking"]).toEqual(["call", "c3", "Ben"]);
      // hark numbered afresh after the restart: part 2's "Speaker 1" is its own cluster.
      expect(who["second part talk"]).toEqual(["call", "c4", "Speaker 4"]);
    } finally {
      t.cleanup();
    }
  });

  test("the final layer takes the live speaker it overlaps most, and is the best view", async () => {
    const { t, view } = await imported();
    try {
      const best = view.lines("best");
      expect(best.every((l) => l.layer === "final")).toBe(true);
      expect(best.map((l) => [l.spk, l.text])).toEqual([
        ["you", "Hello team."],
        ["c1", "The release is on Friday."],
        ["c2", "I will test the codename Zephyr build."],
        ["you", "Back again after the restart."],
        ["c4", "Second part talk."],
      ]);
      expect(formatWall(best[1]?.w0 as number, "UTC")).toBe("15:30:41");
    } finally {
      t.cleanup();
    }
  });

  test("every event's t is the time it describes, and never goes back", async () => {
    const { t, log } = await imported();
    try {
      const ts = log.events.map((e: LogEvent) => e.t);
      expect(ts[0]).toBe(HV_STARTED * 1000);
      for (let i = 1; i < ts.length; i++)
        expect(ts[i] as number).toBeGreaterThanOrEqual(ts[i - 1] as number);
    } finally {
      t.cleanup();
    }
  });

  test("[T3.2] [T3.13] a restarted call is one folder with one log and no per-part transcript", async () => {
    const { t, root, r } = await imported();
    try {
      expect(readdirSync(join(root, "team"))).toEqual(["2026-09-21_103038_release-sync"]);
      expect(readdirSync(r.folder).sort()).toEqual(["audio", "events.jsonl", "logs"]);
      expect(readdirSync(join(r.folder, "audio")).sort()).toEqual([
        "part-001.opus",
        "part-002.opus",
      ]);
    } finally {
      t.cleanup();
    }
  });

  test("the same folder twice is refused; the id is derived from the source", async () => {
    const { t, src, root, r } = await imported();
    try {
      expect(importId(readHarkViewerFolder(src))).toBe(r.call);
      expect(() => importHarkViewer(src, { ...opts(root), exists: (id) => id === r.call })).toThrow(
        /already imported/,
      );
    } finally {
      t.cleanup();
    }
  });

  test("a relabelled part 1 (transcript.speakers.json, newer) gives the live speakers", async () => {
    const { t, view } = await imported({ speakersFile: true, final: false, parts: 1 });
    try {
      expect(view.final.state).toBe("none");
      expect(view.lines("best").map((l) => l.spk)).toEqual(["you", "c1", "c1"]);
    } finally {
      t.cleanup();
    }
  });

  test("a folder with no meta.json: start from its name, title from its slug, workspace from its parent", async () => {
    const t = tempDir("akou-import-");
    try {
      const src = writeHarkViewerCall(
        join(t.dir, "calls", "personal"),
        "2026-09-21_153038_old-call",
        {
          meta: null,
          parts: 1,
          final: false,
        },
      );
      const r = importHarkViewer(src, opts(join(t.dir, "akou")));
      const v = fold((await readLog(join(r.folder, "events.jsonl"))).events);
      expect(r.workspace).toBe("personal");
      expect(v.call?.title).toBe("old call");
      expect(v.parts()[0]?.wallStart).toBe(new Date(2026, 8, 21, 15, 30, 38).getTime());
    } finally {
      t.cleanup();
    }
  });

  test("not a call folder is refused, and a failed import leaves nothing behind", () => {
    const t = tempDir("akou-import-");
    try {
      const empty = join(t.dir, "calls", "work", "empty");
      mkdirSync(empty, { recursive: true });
      expect(() => importHarkViewer(empty, opts(join(t.dir, "akou")))).toThrow(ImportError);
      const src = writeHarkViewerCall(join(t.dir, "calls", "work"), undefined, { parts: 1 });
      // The audio cannot be copied: the import fails part way and removes its folder.
      rmSync(join(src, "audio.opus"));
      mkdirSync(join(src, "audio.opus"));
      const root = join(t.dir, "akou");
      expect(() => importHarkViewer(src, opts(root))).toThrow();
      expect(readdirSync(join(root, "team"))).toEqual([]);
    } finally {
      t.cleanup();
    }
  });
});
