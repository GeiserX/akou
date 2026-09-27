/**
 * Which engine a dictation decodes on (docs/ux/DICTATION.md DC-E3, DC-E4), as a pure rule the app
 * reads at each press and `GET /v1/dictation` shows.
 *
 * - `auto` is `best` where Qwen's llama-server runs on anything but the CPU and Qwen is on disk,
 *   else `fast`. It never starts a download by itself: that is a person's choice (DK-E3).
 * - `best` forced with Qwen missing dictates with `fast` until the download lands, and says so.
 * - `fast` and `remote` are what they say; `remote` never needs a local model.
 */

export type DictationEngineName = "fast" | "best" | "remote";

export interface EngineVerdict {
  /** The engine a dictation decodes on now. */
  engine: DictationEngineName;
  /** Why, as the page shows it: "best on metal", "downloading best, using fast". */
  verdict: string;
  /** `best` was asked for and its files are missing: fetch them. */
  download: boolean;
  /** The engine asked for, when it is not the one used (`best` while it downloads). */
  wanted: DictationEngineName | null;
}

export function resolveDictationEngine(o: {
  /** `dictation.engine`, or the engine a clip names. */
  setting: string;
  /** What Qwen's llama-server runs on here: `cpu`, `metal`, `cuda`, `vulkan`, ... */
  accelerator: string;
  /** Qwen and the llama-server it runs on are on disk. */
  bestReady: boolean;
}): EngineVerdict {
  const plain = (engine: DictationEngineName, verdict: string): EngineVerdict => ({
    engine,
    verdict,
    download: false,
    wanted: null,
  });
  switch (o.setting) {
    case "remote":
      return plain("remote", "remote");
    case "fast":
      return plain("fast", "fast");
    case "best":
      return o.bestReady
        ? plain("best", `best on ${o.accelerator}`)
        : {
            engine: "fast",
            verdict: "downloading best, using fast",
            download: true,
            wanted: "best",
          };
    default:
      if (o.accelerator === "cpu") return plain("fast", "fast: best needs a GPU");
      return o.bestReady
        ? plain("best", `best on ${o.accelerator}`)
        : plain("fast", "fast: best (Qwen3-ASR) is not downloaded");
  }
}

/** Whether an engine takes a forced language; `fast` (Parakeet) picks it itself (DC-E4). */
export function forcesLanguage(engine: string): boolean {
  return engine === "best" || engine === "remote";
}

/** The languages an `auto` dictation may choose among: `dictation.languages`, else `asr.languages`. */
export function dictationLanguages(
  own: readonly string[],
  asr: readonly string[],
): readonly string[] {
  return own.length > 0 ? own : asr;
}
