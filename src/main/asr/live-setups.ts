/**
 * The live models a user chooses between (`asr.live`, akou-chp.23), with the numbers measured for
 * each (docs/research/asr-architecture.md sections 3.1 and 3.2) and the rule `auto` follows, and
 * the second pass that may review their lines during the call (`asr.review.model`,
 * `asr.review.everySeconds`).
 *
 * | Model      | What writes the live lines                                   | AMI WER |
 * |------------|--------------------------------------------------------------|---------|
 * | `parakeet` | Parakeet re-decoding each pause-cut window (words move back)  | 36.17   |
 * | `nemotron` | streaming Nemotron (a word shown is never taken back)         | 18.80   |
 * | `voxtral`  | listed only: unavailable, with its reason                    |         |
 *
 * `auto` picks `nemotron` when a streaming model is on disk, else `parakeet`. A model whose files
 * are missing is never run: a named one that cannot run falls back the same way and says why.
 *
 * The second pass is the user's choice only, never `auto`'s: every `asr.review.everySeconds`, the
 * utterances Nemotron closed since the last review are decoded again, whole, and their words
 * replace the lines' (upgrade.ts, live-worker.ts). `qwen` runs Qwen on llama-server, when its
 * models are here and the Mac has a GPU for it and `QWEN_MIN_MEMORY_GB` of memory; `parakeet`
 * decodes each utterance alone on the recognizer the live Worker already holds. Both review
 * Nemotron's lines, so neither runs on a call whose live model is Parakeet. A review that cannot
 * run is off for the call, with a note saying why.
 *
 * The choice is made when a call takes the recognizer, so a change applies from the next call and
 * a running call keeps its setup.
 */

import { type ScoreView, scoreView } from "../server/model-store.ts";
import {
  chooseLiveEngine,
  engineForLanguages,
  isLiveEngine,
  type LiveChoice,
} from "./live-engines.ts";
import { liveModelName } from "./live-names.ts";
import { QWEN_ASR } from "./llama-catalog.ts";
import type { Measure, NotMeasured } from "./model-scores.ts";
import { REFERENCE_MACHINE } from "./model-scores.ts";
import { RECOGNIZER } from "./models.ts";

export { liveModelName };

import { REVIEW_EVERY_MAX, REVIEW_EVERY_MIN, REVIEW_EVERY_SECONDS } from "./upgrade.ts";

export const LIVE_SETUP_IDS = ["nemotron", "parakeet", "voxtral"] as const;
export type LiveSetupId = (typeof LIVE_SETUP_IDS)[number];
/** The live models a call can run. */
export type RunnableSetup = Exclude<LiveSetupId, "voxtral">;
/** The values of `asr.live`. */
export const LIVE_SETTINGS = ["auto", "parakeet", "nemotron"] as const;
export type LiveSetting = (typeof LIVE_SETTINGS)[number];
/**
 * What a call's own `live` may say (`POST /calls`, `akou start --live`): the values of `asr.live`,
 * and `upgrade`, the old spelling of Nemotron with Qwen's second pass (`legacyLive`).
 */
export const LIVE_CALL_SETTINGS = [...LIVE_SETTINGS, "upgrade"] as const;

export function isLiveSetting(v: string): v is LiveSetting {
  return (LIVE_SETTINGS as readonly string[]).includes(v);
}

export function isLiveCallSetting(v: string): boolean {
  return (LIVE_CALL_SETTINGS as readonly string[]).includes(v);
}

/** The values of `asr.review.model`: no second pass, or the model that reviews. */
export const REVIEW_MODELS = ["none", "qwen", "parakeet"] as const;
export type ReviewModel = (typeof REVIEW_MODELS)[number];
/** A second pass that runs. */
export type Reviewer = Exclude<ReviewModel, "none">;
export const REVIEWERS: readonly Reviewer[] = ["qwen", "parakeet"];

export function isReviewModel(v: string): v is ReviewModel {
  return (REVIEW_MODELS as readonly string[]).includes(v);
}

export { REVIEW_EVERY_MAX, REVIEW_EVERY_MIN, REVIEW_EVERY_SECONDS };

/**
 * A call's `live` in today's terms: `upgrade`, the old spelling, is Nemotron with Qwen's second
 * pass, unless the call names its own review.
 */
export function legacyLive(
  live: string | undefined,
  review: string | undefined,
): { live: string | undefined; review: string | undefined } {
  if (live !== "upgrade") return { live, review };
  return { live: "nemotron", review: review ?? "qwen" };
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
  /** What the live menu says under the model's name, in one plain line. */
  line: string;
  /** Why no call can run it in this version; absent when it can. */
  unavailable?: string;
  accuracy: Measure | NotMeasured;
  latency: Measure | NotMeasured;
  cores: Measure | NotMeasured;
  memory: Measure | NotMeasured;
}

const ARCH = "docs/research/asr-architecture.md";
const LIVE = `${ARCH}#31-what-replaces-the-12-s-windows`;
/** Memory a Mac needs before Qwen reviews during a call: the call then takes 10 to 13 GB. */
export const QWEN_MIN_MEMORY_GB = 16;

const E22 = `the first 600 s of an Earnings-22 call, one channel, on the ${REFERENCE_MACHINE}`;

export const LIVE_SETUPS: Readonly<Record<LiveSetupId, LiveSetupInfo>> = {
  nemotron: {
    title: "Nemotron",
    what: "Streaming Nemotron writes each word once as it is heard and never takes one back",
    plain: "Words appear as they are said and never change.",
    line: "Words appear as they are said.",
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
  parakeet: {
    title: "Parakeet",
    what: "Parakeet decodes each stretch of speech between pauses and re-decodes the open one every second, so words on screen can change",
    plain: "Words can change as you watch.",
    line: "Writes each stretch between pauses; words can change for a moment.",
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
  voxtral: {
    title: "Voxtral Realtime",
    what: "Voxtral Mini 4B Realtime, the most accurate streaming model measured (7.19 % English and 3.60 % Spanish WER on FLEURS)",
    plain: "Not available yet: on a Mac's graphics chip it only just keeps up with speech.",
    line: "Not available yet.",
    unavailable:
      "it runs only at real time on an Apple M4 (real-time factor 1.0), so it needs a faster GPU and one channel, and it gives no word times and takes no vocabulary",
    accuracy: { notMeasured: "not run on AMI meetings; 7.19 % and 3.60 % WER on FLEURS" },
    latency: { notMeasured: "not measured in akou's live path" },
    cores: { notMeasured: "runs on the GPU; not measured in akou's live path" },
    memory: { notMeasured: "not measured in akou's live path" },
  },
};

export interface ReviewInfo {
  /** What the second pass does, in one sentence. */
  what: string;
  /** What the Models page says of it, in plain words. */
  plain: string;
  /** What the live menu says under its name, in one plain line. */
  line: string;
}

export const REVIEWS: Readonly<Record<Reviewer, ReviewInfo>> = {
  qwen: {
    what: "Qwen decodes the sentences Nemotron finished since its last review, whole, and its words replace theirs, once",
    // FLEURS joined into 27 and 34 minute calls, a review a minute: 14.39 to 10.19 % (29 % fewer)
    // and 8.00 to 4.19 % (48 % fewer).
    plain:
      "Rewrites the finished sentences with the most accurate model. On read speech it cuts Nemotron's mistakes by a quarter or more. Uses 10 to 13 GB of memory during a call.",
    line: "The most accurate. Uses 10 to 13 GB of memory during a call.",
  },
  parakeet: {
    what: "Parakeet decodes each sentence Nemotron finished since its last review again, alone, and its words replace theirs, once",
    // The same calls, a review a minute: 14.39 to 12.35 % (14 % fewer) and 8.00 to 4.29 % (46 %
    // fewer), on the recognizer the live Worker already holds (docs/research/asr-architecture.md
    // section 3.2).
    plain:
      "Rewrites the finished sentences with Parakeet, on the processor, with no extra memory. On read speech it cuts Nemotron's mistakes by a seventh in English and by almost half in Spanish.",
    line: "Fewer mistakes, on the processor, with no extra memory.",
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
  /** `asr.review.model`, or a call's own; absent: none. */
  review?: string;
  /** `asr.review.everySeconds`, or a call's own; absent: `REVIEW_EVERY_SECONDS`. */
  everySeconds?: number;
  /** Whether a catalog model's files are on disk. */
  present: (id: string) => boolean;
  /** The llama-server build Qwen runs on here, or null for an own llama-server. */
  runtime: string | null;
  /** What Qwen needs of the machine; absent: not known, and not checked. */
  machine?: {
    /** Qwen's llama-server runs on a GPU here (not `cpu`). */
    gpu: boolean;
    /** The machine's memory, GB. */
    memoryGb: number;
  };
}

/** A second pass a call runs: its model, and how often it reviews. */
export interface ReviewRun {
  model: Reviewer;
  everySeconds: number;
}

export interface LiveSetupChoice {
  /** The live model the call runs. */
  setup: RunnableSetup;
  /** Its streaming engine, or null for Parakeet's windows. */
  choice: LiveChoice | null;
  /** The second pass the call runs, or null for none. */
  review: ReviewRun | null;
  /** Why the setup differs from the one asked for, or why a streaming model is not used. */
  note?: string;
}

/**
 * The model ids a live model loads here, for the Models page's Download and the sweep: the
 * Nemotron the setting and languages name (or the one `auto` falls back to on disk).
 */
export function setupModels(id: LiveSetupId, c: LiveSetupContext): string[] {
  switch (id) {
    case "parakeet":
      return [RECOGNIZER];
    case "nemotron": {
      if (isLiveEngine(c.engine)) return [c.engine];
      return [
        chooseLiveEngine(c.engine, c.languages, c.present).choice?.engine ??
          engineForLanguages(c.languages),
      ];
    }
    case "voxtral":
      return [];
  }
}

/** The model ids a second pass loads here beyond the live model's. */
export function reviewModels(id: Reviewer, c: LiveSetupContext): string[] {
  return id === "qwen" ? [QWEN_ASR, ...(c.runtime ? [c.runtime] : [])] : [RECOGNIZER];
}

/**
 * Why the menu and the Models page do not offer Qwen's review on this machine, in plain words, or
 * null when they do: Qwen on a GPU and `QWEN_MIN_MEMORY_GB` or more. Not known (no `machine`):
 * null. It is advice, not a block: a review chosen anyway (in `config.json`, the CLI or the API)
 * runs, and turns itself off for a call it cannot keep up with.
 */
export function qwenRoom(c: LiveSetupContext): string | null {
  const m = c.machine;
  if (!m) return null;
  if (!m.gpu) return "Qwen would run on the processor here, too slow to keep up with a call.";
  if (m.memoryGb < QWEN_MIN_MEMORY_GB)
    return `Needs ${QWEN_MIN_MEMORY_GB} GB of memory; this computer has ${Math.round(m.memoryGb)} GB.`;
  return null;
}

/**
 * Why a second pass cannot run on the next call, or null when it can: it reviews Nemotron's lines,
 * so the live model must be Nemotron, and its models must be here.
 */
export function reviewBlock(id: Reviewer, c: LiveSetupContext, live: RunnableSetup): string | null {
  if (live !== "nemotron")
    return id === "parakeet"
      ? "Parakeet already writes the live lines."
      : "It reviews Nemotron's lines; the live model is Parakeet.";
  const missing = reviewModels(id, c).filter((m) => !c.present(m));
  if (missing.length > 0) return `Needs ${missing.join(", ")} (\`akou models pull <id>\`).`;
  return null;
}

/** `asr.review.everySeconds` kept inside its bounds. */
function every(c: LiveSetupContext): number {
  const n = c.everySeconds ?? REVIEW_EVERY_SECONDS;
  return Math.min(REVIEW_EVERY_MAX, Math.max(REVIEW_EVERY_MIN, Math.round(n)));
}

/** The live model and second pass the next call runs, never one whose models are missing. */
export function chooseLiveSetup(c: LiveSetupContext): LiveSetupChoice {
  const setting = isLiveSetting(c.setting) ? c.setting : "auto";
  const stream = chooseLiveEngine(c.engine, c.languages, c.present);
  const live: Omit<LiveSetupChoice, "review"> =
    setting === "parakeet"
      ? { setup: "parakeet", choice: null }
      : stream.choice
        ? { setup: "nemotron", choice: stream.choice }
        : { setup: "parakeet", choice: null, ...(stream.note ? { note: stream.note } : {}) };
  const asked = c.review && isReviewModel(c.review) ? c.review : "none";
  if (asked === "none") return { ...live, review: null };
  const block = reviewBlock(asked, c, live.setup);
  if (block === null) return { ...live, review: { model: asked, everySeconds: every(c) } };
  const note = [
    live.note,
    `no ${liveModelName(asked === "qwen" ? QWEN_ASR : RECOGNIZER)} second pass: ${block}`,
  ]
    .filter((x) => x)
    .join("; ");
  return { ...live, review: null, note };
}

// ---------------------------------------------------------------------------
// What the Models page, the live menu and `GET /models` show

export interface LiveSetupView {
  id: LiveSetupId;
  /** Its name here: the Nemotron that would run, by its model. */
  title: string;
  what: string;
  /** The Models page's words after the accuracy figure (`LiveSetupInfo.plain`). */
  plain: string;
  /** The live menu's line under the name (`LiveSetupInfo.line`). */
  line: string;
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

export interface ReviewChoiceView {
  id: Reviewer;
  title: string;
  what: string;
  plain: string;
  line: string;
  /** The models it loads beyond the live model's, each with its state on disk. */
  models: { id: string; state: "ready" | "downloading" | "missing" }[];
  /**
   * Why it is not offered with the next call's live model on this machine, in plain words, or
   * null: it cannot run (the live model is Parakeet), or for Qwen, `qwenRoom`. Missing models are in
   * `models`, not here.
   */
  blocked: string | null;
}

export interface ReviewView {
  /** `asr.review.model`. */
  setting: ReviewModel;
  /** `asr.review.everySeconds`. */
  everySeconds: number;
  /** The second pass the next call runs, or null. */
  next: ReviewRun | null;
  /** The live call's second pass, or null. */
  running: ReviewRun | null;
  choices: ReviewChoiceView[];
}

export interface LiveView {
  /** `asr.live`. */
  setting: LiveSetting;
  /** What the next call runs, and why it differs from the setting when it does. */
  next: RunnableSetup;
  /** What `auto` runs on this machine now. */
  auto?: RunnableSetup;
  note: string | null;
  /** What the live call runs, or null with no call or no live transcript. */
  running: RunnableSetup | null;
  setups: LiveSetupView[];
  review: ReviewView;
}

export function liveView(
  c: LiveSetupContext,
  running: { setup: RunnableSetup; review: ReviewRun | null } | null,
  state: (id: string) => "ready" | "downloading" | "missing",
): LiveView {
  const next = chooseLiveSetup(c);
  const models = (ids: readonly string[]) => ids.map((m) => ({ id: m, state: state(m) }));
  const review = c.review && isReviewModel(c.review) ? c.review : "none";
  return {
    setting: isLiveSetting(c.setting) ? c.setting : "auto",
    next: next.setup,
    auto: chooseLiveSetup({ ...c, setting: "auto" }).setup,
    note: next.note ?? null,
    running: running?.setup ?? null,
    setups: LIVE_SETUP_IDS.map((id) => {
      const s = LIVE_SETUPS[id];
      const ids = setupModels(id, c);
      return {
        id,
        title: id === "nemotron" ? liveModelName(ids[0] as string) : s.title,
        what: s.what,
        plain: s.plain,
        line: s.line,
        unavailable: s.unavailable ?? null,
        selected: next.setup === id,
        running: running?.setup === id,
        models: models(ids),
        accuracy: scoreView(s.accuracy),
        latency: scoreView(s.latency),
        cores: scoreView(s.cores),
        memory: scoreView(s.memory),
      };
    }),
    review: {
      setting: review,
      everySeconds: every(c),
      next: next.review,
      running: running?.review ?? null,
      choices: REVIEWERS.map((id) => {
        const ids = reviewModels(id, c);
        const block = reviewBlock(id, c, next.setup) ?? (id === "qwen" ? qwenRoom(c) : null);
        return {
          id,
          title: liveModelName(id === "qwen" ? QWEN_ASR : RECOGNIZER),
          what: REVIEWS[id].what,
          plain: REVIEWS[id].plain,
          line: REVIEWS[id].line,
          models: models(ids),
          // Missing models show as models, with Get; any other reason is said in words.
          blocked: block !== null && ids.every((m) => c.present(m)) ? block : null,
        };
      }),
    },
  };
}
