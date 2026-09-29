/**
 * The live setups a user chooses between (`asr.live`, akou-chp.23): what writes the live transcript
 * of a call, with the numbers measured for each (docs/research/asr-architecture.md sections 3.1
 * and 3.2), and the rule `auto` follows.
 *
 * | Setup      | What writes the live lines                                   | AMI WER |
 * |------------|--------------------------------------------------------------|---------|
 * | `parakeet` | Parakeet re-decoding each pause-cut window (words move back)  | 36.17   |
 * | `nemotron` | streaming Nemotron (a word shown is never taken back)         | 18.80   |
 * | `upgrade`  | streaming Nemotron, each closed utterance's lines rewritten   | not run |
 * |            | once by Qwen (FLEURS: en 7.34 to 4.75, es 4.87 to 2.75)       |         |
 * | `voxtral`  | listed only: unavailable, with its reason                    |         |
 *
 * `auto` picks `nemotron` when a streaming model is on disk, else `parakeet`. It never picks
 * `upgrade`: the accurate transcript is the final pass after the call, and the upgrade keeps the
 * GPU busy for the whole call, so it runs only when chosen by name (the Models page, `asr.live`, a
 * call's `live` at its start). A setup whose models are missing is never run: a named one that
 * cannot run falls back the same way and says why. The choice is made
 * when a call takes the recognizer, so a change applies from the next call and a running call keeps
 * its setup. The in-call upgrade itself (ASR-7) is in live-worker.ts.
 */

import { type ScoreView, scoreView } from "../server/model-store.ts";
import {
  chooseLiveEngine,
  engineForLanguages,
  isLiveEngine,
  type LiveChoice,
} from "./live-engines.ts";
import { QWEN_ASR } from "./llama-catalog.ts";
import type { Measure, NotMeasured } from "./model-scores.ts";
import { REFERENCE_MACHINE } from "./model-scores.ts";
import { RECOGNIZER } from "./models.ts";

export const LIVE_SETUP_IDS = ["parakeet", "nemotron", "upgrade", "voxtral"] as const;
export type LiveSetupId = (typeof LIVE_SETUP_IDS)[number];
/** The setups a call can run. */
export type RunnableSetup = Exclude<LiveSetupId, "voxtral">;
/** The values of `asr.live`, and of a call's `live` at its start. */
export const LIVE_SETTINGS = ["auto", "parakeet", "nemotron", "upgrade"] as const;
export type LiveSetting = (typeof LIVE_SETTINGS)[number];

export function isLiveSetting(v: string): v is LiveSetting {
  return (LIVE_SETTINGS as readonly string[]).includes(v);
}

export interface LiveSetupInfo {
  title: string;
  /** What writes the live lines, in one sentence. */
  what: string;
  /**
   * What the Models page says after the accuracy figure, in plain words: how the lines behave,
   * and for a setup with no figure on meetings, what is known instead.
   */
  plain: string;
  /** Why no call can run it in this version; absent when it can. */
  unavailable?: string;
  accuracy: Measure | NotMeasured;
  latency: Measure | NotMeasured;
  cores: Measure | NotMeasured;
  memory: Measure | NotMeasured;
}

const ARCH = "docs/research/asr-architecture.md";
const LIVE = `${ARCH}#31-what-replaces-the-12-s-windows`;
const UPGRADE = `${ARCH}#32-upgrading-live-text-during-the-call`;
const E22 = `the first 600 s of an Earnings-22 call, one channel, on the ${REFERENCE_MACHINE}`;

export const LIVE_SETUPS: Readonly<Record<LiveSetupId, LiveSetupInfo>> = {
  parakeet: {
    title: "Parakeet",
    what: "Parakeet decodes each stretch of speech between pauses and re-decodes the open one every second, so words on screen can change",
    plain: "Words can change as you watch.",
    accuracy: {
      metric: "call-wer",
      value: 36.17,
      set: "meetings",
      what: "AMI meetings through the live path: 36.17 % WER, and 20.8 words taken back per 100",
      source: LIVE,
    },
    latency: {
      metric: "seconds",
      value: 0.78,
      what: `a word shows 0.78 s (p50) after it is said, 3.20 s (p95), over ${E22}`,
      source: LIVE,
    },
    cores: {
      metric: "cores",
      value: 0.95,
      what: `0.95 CPU cores per channel over ${E22}`,
      source: LIVE,
    },
    memory: {
      metric: "gb",
      value: 3.6,
      what: "3.6 GB resident on AMI",
      source: LIVE,
    },
  },
  nemotron: {
    title: "Nemotron",
    what: "Streaming Nemotron writes each word once as it is heard and never takes one back",
    plain: "Words appear as they are said and never change.",
    accuracy: {
      metric: "call-wer",
      value: 18.8,
      set: "meetings",
      what: "AMI meetings through streaming Nemotron at 560 ms: 18.80 % WER, 0 words taken back",
      source: LIVE,
    },
    latency: {
      metric: "seconds",
      value: 0.46,
      what: `a word shows 0.46 s (p50) after it is said, 0.88 s (p95), over ${E22}`,
      source: LIVE,
    },
    cores: {
      metric: "cores",
      value: 0.39,
      what: `0.39 CPU cores for one channel (0.56 for both channels batched) over ${E22}`,
      source: LIVE,
    },
    memory: {
      metric: "gb",
      value: 2.25,
      what: `2.25 GB resident over ${E22}`,
      source: LIVE,
    },
  },
  upgrade: {
    title: "Nemotron, each line rewritten by Qwen",
    what: "Streaming Nemotron writes the words; when the speaker stops, Qwen rewrites the lines once, about 1 s after the utterance closes",
    // FLEURS, 20 clips per language: 7.34 to 4.75 % (35 % fewer) and 4.87 to 2.75 % (44 % fewer).
    plain:
      "Cleaner lines a second after each speaker stops. Not measured on meetings yet; on read speech it cuts Nemotron's mistakes by a third or more. Uses 10 to 13 GB of memory during a call.",
    accuracy: {
      notMeasured:
        "not run on AMI meetings; on 20 FLEURS clips per language, Qwen's rewrite takes the stream from 7.34 to 4.75 % WER in English and from 4.87 to 2.75 in Spanish",
    },
    latency: {
      metric: "seconds",
      value: 0.46,
      what: "the words show as Nemotron's (0.46 s p50); Qwen's rewrite lands 0.74 to 1.04 s (p50) after the utterance closes on 20 FLEURS clips per language, 2.1 to 2.8 s (p95)",
      source: UPGRADE,
    },
    cores: {
      notMeasured:
        "Nemotron's 0.39 cores per channel plus a Qwen decode per utterance; the two together were not timed",
    },
    memory: {
      metric: "gb",
      value: 13,
      what: "live Nemotron 2.25 GB, Parakeet 2.7 GB (loaded on every setup) and Qwen 4.9 to 7.8 GB: about 10 to 13 GB during a call (the bar takes 13)",
      source: UPGRADE,
    },
  },
  voxtral: {
    title: "Voxtral Realtime",
    what: "Voxtral Mini 4B Realtime, the most accurate streaming model measured (7.19 % English and 3.60 % Spanish WER on FLEURS)",
    plain: "Not available yet: on a Mac's graphics chip it only just keeps up with speech.",
    unavailable:
      "it runs only at real time on an Apple M4 (real-time factor 1.0), so it needs a faster GPU and one channel, and it gives no word times and takes no vocabulary",
    accuracy: { notMeasured: "not run on AMI meetings; 7.19 % and 3.60 % WER on FLEURS" },
    latency: { notMeasured: "not measured in akou's live path" },
    cores: { notMeasured: "runs on the GPU; not measured in akou's live path" },
    memory: { notMeasured: "not measured in akou's live path" },
  },
};

/** What the next call's setup depends on. */
export interface LiveSetupContext {
  /** `asr.live`, or a call's own `live`. */
  setting: string;
  /** `asr.live.engine`: which Nemotron. */
  engine: string;
  /** `asr.languages`. */
  languages: readonly string[];
  /** Whether a catalog model's files are on disk. */
  present: (id: string) => boolean;
  /** The llama-server build Qwen runs on here, or null for an own llama-server. */
  runtime: string | null;
}

export interface LiveSetupChoice {
  /** The setup the call runs. */
  setup: RunnableSetup;
  /** Its streaming engine, or null for Parakeet's windows. */
  choice: LiveChoice | null;
  /** Why the setup differs from the one asked for, or why a streaming model is not used. */
  note?: string;
}

/**
 * The model ids a setup loads here, for the Models page's Download and the sweep: the Nemotron
 * the setting and languages name (or the one `auto` falls back to on disk).
 */
export function setupModels(id: LiveSetupId, c: LiveSetupContext): string[] {
  const nemotron = (): string => {
    if (isLiveEngine(c.engine)) return c.engine;
    return (
      chooseLiveEngine(c.engine, c.languages, c.present).choice?.engine ??
      engineForLanguages(c.languages)
    );
  };
  switch (id) {
    case "parakeet":
      return [RECOGNIZER];
    case "nemotron":
      return [nemotron()];
    case "upgrade":
      return [nemotron(), QWEN_ASR, ...(c.runtime ? [c.runtime] : [])];
    case "voxtral":
      return [];
  }
}

/** The setup the next call runs, never one whose models are missing. */
export function chooseLiveSetup(c: LiveSetupContext): LiveSetupChoice {
  const setting = isLiveSetting(c.setting) ? c.setting : "auto";
  const stream = chooseLiveEngine(c.engine, c.languages, c.present);
  const fallback = (why?: string): LiveSetupChoice => {
    if (stream.choice)
      return { setup: "nemotron", choice: stream.choice, ...(why ? { note: why } : {}) };
    const note = [why, stream.note].filter((x) => x).join("; ");
    return { setup: "parakeet", choice: null, ...(note ? { note } : {}) };
  };
  if (setting === "parakeet") return { setup: "parakeet", choice: null };
  if (setting === "nemotron" || setting === "auto") return fallback();
  const missing = setupModels("upgrade", c).filter((id) => !c.present(id));
  const upgradeWhy =
    missing.length > 0
      ? `the upgrade setup needs ${missing.join(", ")} (\`akou models pull <id>\` or the Models page)`
      : null;
  if (upgradeWhy === null && stream.choice) return { setup: "upgrade", choice: stream.choice };
  return fallback(upgradeWhy ?? undefined);
}

// ---------------------------------------------------------------------------
// What the Models page and `GET /models` show

export interface LiveSetupView {
  id: LiveSetupId;
  title: string;
  what: string;
  /** The Models page's words after the accuracy figure (`LiveSetupInfo.plain`). */
  plain: string;
  /** Why no call can run it in this version, or null. */
  unavailable: string | null;
  /** The next call runs it: the setting as it resolves on this machine now. */
  selected: boolean;
  /** The live call runs it. */
  running: boolean;
  /** The models it loads here, each with its state on disk. */
  models: { id: string; state: "ready" | "downloading" | "missing" }[];
  accuracy: ScoreView;
  latency: ScoreView;
  cores: ScoreView;
  memory: ScoreView;
}

export interface LiveView {
  /** `asr.live`. */
  setting: LiveSetting;
  /** What the next call runs, and why it differs from the setting when it does. */
  next: RunnableSetup;
  note: string | null;
  /** What the live call runs, or null with no call or no live transcript. */
  running: RunnableSetup | null;
  setups: LiveSetupView[];
}

export function liveView(
  c: LiveSetupContext,
  running: RunnableSetup | null,
  state: (id: string) => "ready" | "downloading" | "missing",
): LiveView {
  const next = chooseLiveSetup(c);
  return {
    setting: isLiveSetting(c.setting) ? c.setting : "auto",
    next: next.setup,
    note: next.note ?? null,
    running,
    setups: LIVE_SETUP_IDS.map((id) => {
      const s = LIVE_SETUPS[id];
      return {
        id,
        title: s.title,
        what: s.what,
        plain: s.plain,
        unavailable: s.unavailable ?? null,
        selected: next.setup === id,
        running: running === id,
        models: setupModels(id, c).map((m) => ({ id: m, state: state(m) })),
        accuracy: scoreView(s.accuracy),
        latency: scoreView(s.latency),
        cores: scoreView(s.cores),
        memory: scoreView(s.memory),
      };
    }),
  };
}
