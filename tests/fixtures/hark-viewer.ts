/**
 * Synthetic hark-viewer call folders in the predecessor's formats (hark-viewer `server.py` and
 * `postprocess.py`, hark's JSON Lines transcript writer). Every line is made up here; no real
 * recording or transcript is ever copied into the repository.
 */

import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeOpus } from "./opus.ts";

/** 2026-09-21 15:30:38 UTC, in epoch seconds as `meta.json` stores it. */
export const HV_STARTED = Date.UTC(2026, 8, 21, 15, 30, 38) / 1000;

type Line = { start: number; end: number; text: string; speaker?: string };

const jsonl = (lines: readonly (Line | string)[]) =>
  `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;

export interface HvSpec {
  /** Two parts (a restart 300 s in) or one. */
  parts?: 1 | 2;
  final?: boolean;
  meta?: Record<string, unknown> | null;
  /** A relabelled part 1, newer than transcript.json. */
  speakersFile?: boolean;
}

/** Writes a call folder under `dir` and returns its path. */
export function writeHarkViewerCall(
  root: string,
  name = "2026-09-21_153038_release-sync",
  spec: HvSpec = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const two = (spec.parts ?? 2) === 2;
  const meta =
    spec.meta === null
      ? null
      : {
          started: HV_STARTED,
          workspace: "team",
          title: "Release sync",
          id: "hark-42",
          ...(two
            ? {
                parts: [
                  { n: 1, audio: "audio.opus", transcript: "transcript.json", started: HV_STARTED },
                  {
                    n: 2,
                    audio: "audio.part2.opus",
                    transcript: "transcript.part2.json",
                    started: HV_STARTED + 300,
                  },
                ],
              }
            : {}),
          ...spec.meta,
        };
  if (meta) writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "audio.opus"), fakeOpus(290));
  writeFileSync(
    join(dir, "transcript.json"),
    jsonl([
      { start: 1, end: 2.5, text: "hello team", speaker: "You" },
      { start: 3, end: 6, text: "the release is on friday", speaker: "Speaker 1" },
      { start: 7, end: 10, text: "I will test the codename zephyr build", speaker: "Speaker 2" },
      { start: 12, end: 13, text: "background chatter", speaker: "Others" },
      { start: 14, end: 15, text: "this is Ben speaking", speaker: "Ben" },
      '{"start": 20, "end": 2',
    ]),
  );
  if (two) {
    writeFileSync(join(dir, "audio.part2.opus"), fakeOpus(120));
    writeFileSync(
      join(dir, "transcript.part2.json"),
      jsonl([
        { start: 1, end: 2, text: "back again after the restart", speaker: "You" },
        { start: 3, end: 5, text: "second part talk", speaker: "Speaker 1" },
      ]),
    );
  }
  if (spec.speakersFile) {
    writeFileSync(
      join(dir, "transcript.speakers.json"),
      jsonl([
        { start: 1, end: 2.5, text: "hello team", speaker: "You" },
        { start: 3, end: 6, text: "the release is on friday", speaker: "Speaker 3" },
        { start: 7, end: 10, text: "I will test the codename zephyr build", speaker: "Speaker 3" },
      ]),
    );
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "transcript.speakers.json"), later, later);
  }
  if (spec.final !== false) {
    writeFileSync(
      join(dir, "transcript.final.json"),
      jsonl([
        { start: 1, end: 2.5, speaker: "Microphone", text: "Hello team." },
        { start: 3.1, end: 6, speaker: "Others", text: "The release is on Friday." },
        { start: 7, end: 10, speaker: "Others", text: "I will test the codename Zephyr build." },
        ...(two
          ? [
              {
                start: 301,
                end: 302,
                speaker: "Microphone",
                text: "Back again after the restart.",
              },
              { start: 303, end: 305, speaker: "Others", text: "Second part talk." },
            ]
          : []),
      ]),
    );
    writeFileSync(
      join(dir, "postprocess.json"),
      JSON.stringify({
        state: "done",
        pid: 1,
        started: HV_STARTED + 450,
        finished: HV_STARTED + 500,
        settled: { waited: 5, capped: false },
        steps: {
          final: { state: "done", skipped_spans: [], warning: null, error: null },
          languages: { state: "done", languages: { present: ["en"], dominant: "en" }, error: null },
          mw: { state: "skipped", error: "turned off" },
        },
      }),
    );
  }
  return dir;
}
