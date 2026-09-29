/**
 * The live setups a user chooses between (`asr.live`, akou-chp.23): what writes the live transcript
 * of a call, with the numbers measured for each (docs/research/asr-architecture.md sections 3.1
 * and 3.2), and the rule `auto` follows.
 *
 * | Setup      | What writes the live lines                                   | AMI WER |
 * |------------|--------------------------------------------------------------|---------|
 * | `parakeet` | Parakeet re-decoding each pause-cut window (words move back)  | 36.17   |
 * | `nemotron` | streaming Nemotron (a word shown is never taken back)         | 18.80   |
 * | `upgrade`  | streaming Nemotron, each closed line rewritten by Parakeet    | 13.31   |
 * |            | and then by Qwen fused with it                               |         |
 * | `voxtral`  | listed only: unavailable, with its reason                    |         |
 *
 * `auto` picks `upgrade` on a machine with 16 GB or more whose models are all on disk, else
 * `nemotron` when a streaming model is on disk, else `parakeet`. A setup whose models are missing is
 * never run: a named one that cannot run falls back the same way and says why. The choice is made
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

/**
 * The memory `auto` asks of `upgrade`: 16 GB, less what an OS keeps for itself (a 16 GB Linux box
 * reports about 15.5 GiB). Live Nemotron, Parakeet and Qwen hold 10 to 13 GB during a call.
 */
export const UPGRADE_MIN_BYTES = 15 * 2 ** 30;

export interface LiveSetupInfo {
  title: string;
  /** What writes the live lines, in one sentence. */
  what: string;
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
    accuracy: {
      metric: "call-wer",
      value: 36.17,
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
    accuracy: {
      metric: "call-wer",
      value: 18.8,
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
    title: "Nemotron, each line upgraded",
    what: "Streaming Nemotron writes the words; when the speaker stops, Parakeet rewrites the lines about 0.2 s later and Qwen fused with Parakeet about 1.5 to 2.5 s later",
    accuracy: {
      metric: "call-wer",
      value: 13.31,
      what: "AMI meetings, each Nemotron line rewritten by ROVER over Qwen and Parakeet: 13.31 % WER, against 13.80 for Qwen after the call",
      source: UPGRADE,
    },
    latency: {
      metric: "seconds",
      value: 0.46,
      what: "the words show as Nemotron's (0.46 s p50); the Parakeet line lands 0.18 s (p50) after the line closes, the Qwen line 1.43 s with one channel and 2.56 s with two",
      source: UPGRADE,
    },
    cores: {
      notMeasured:
        "Nemotron's 0.39 cores per channel plus a Parakeet and a Qwen decode per line; the three together were not timed",
    },
    memory: {
      metric: "gb",
      value: 13,
      what: "live Nemotron 2.25 GB, Parakeet 2.7 GB and Qwen 4.9 to 7.8 GB: about 10 to 13 GB during a call (the bar takes 13)",
      source: UPGRADE,
    },
  },
  voxtral: {
    title: "Voxtral Realtime",
    what: "Voxtral Mini 4B Realtime, the most accurate streaming model measured (7.19 % English and 3.60 % Spanish WER on FLEURS)",
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
  /** Physical memory, bytes. */
  memoryBytes: number;
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
      return [nemotron(), RECOGNIZER, QWEN_ASR, ...(c.runtime ? [c.runtime] : [])];
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
  if (setting === "nemotron") return fallback();
  const missing = setupModels("upgrade", c).filter((id) => !c.present(id));
  const upgradeWhy =
    missing.length > 0
      ? `the upgrade setup needs ${missing.join(", ")} (\`akou models pull <id>\` or the Models page)`
      : null;
  if (setting === "upgrade") {
    if (upgradeWhy === null && stream.choice) return { setup: "upgrade", choice: stream.choice };
    return fallback(upgradeWhy ?? undefined);
  }
  // auto
  if (upgradeWhy === null && stream.choice && c.memoryBytes >= UPGRADE_MIN_BYTES) {
    return { setup: "upgrade", choice: stream.choice };
  }
  return fallback();
}

// ---------------------------------------------------------------------------
// What the Models page and `GET /models` show

export interface LiveSetupView {
  id: LiveSetupId;
  title: string;
  what: string;
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
