/**
 * Which engine a dictation decodes on (docs/ux/DICTATION.md DC-E3, DC-E4), as a pure rule the app
 * reads at each press and `GET /v1/dictation` shows.
 *
 * - `auto` is `best` where Qwen's llama-server runs on anything but the CPU and Qwen is on disk,
 *   else `fast`. It never starts a download by itself: that is a person's choice (DK-E3).
 * - `best` forced with Qwen missing dictates with `fast` until the download lands, and says so.
 * - `best` gives way while another Metal llama-server holds the GPU (a call's final pass): only one
 *   fits, and its start would fail, so a press goes straight to `fast` and says why (DC-E2).
 * - `fast` and `remote` are what they say; `remote` never needs a local model.
 * - `dictation.final` (DC-E7) names the text a local dictation inserts while `dictation.engine` is
 *   `auto`: `live`, the default and the fastest, is the streaming model's own words (`live`), with
 *   Parakeet in its place while no streaming model is downloaded; `qwen` is `best` (downloaded as
 *   `best` is); `parakeet` is `auto` as above, the behaviour before this key. `fast`, `best` and `remote` in
 *   `dictation.engine` win. The Dictation page writes both keys, so what it shows is what runs, and
 *   `GET /v1/dictation` names the result as `final`. This is the one rule the page, the API and the
 *   CLI read.
 */

export type DictationEngineName = "fast" | "best" | "remote" | "live";

/** The values of `dictation.final`: the text a local dictation inserts (DC-E7). */
export const DICTATION_FINALS = ["parakeet", "live", "qwen"] as const;
export type DictationFinal = (typeof DICTATION_FINALS)[number];

/** `dictation.final` as `GET /v1/dictation` names what is inserted now, from the engine used. */
export function finalOf(engine: string | null): DictationFinal | "remote" | null {
  return engine === "fast"
    ? "parakeet"
    : engine === "best"
      ? "qwen"
      : engine === "live"
        ? "live"
        : engine === "remote"
          ? "remote"
          : null;
}

/** The pill's line when the streaming model failed at the release and Parakeet decoded instead. */
export const LIVE_FAILED = "live words failed, used fast";

/** The verdict while `live` is asked for and no streaming model is downloaded. */
export const LIVE_MISSING_VERDICT = "fast: no streaming model is downloaded for live";

export interface EngineVerdict {
  /** The engine a dictation decodes on now. */
  engine: DictationEngineName;
  /** Why, as the page shows it: "best on metal", "downloading best, using fast". */
  verdict: string;
  /** `best` was asked for and its files are missing: fetch them. */
  download: boolean;
  /** The engine asked for, when it is not the one used (`best` while it downloads). */
  wanted: DictationEngineName | null;
  /** `best` gives way to another Metal server holding the GPU; it is warmed once that one ends. */
  yielding: boolean;
}

/** The verdict while a final pass's Metal llama-server holds the GPU. */
export const GPU_BUSY_VERDICT = "fast while a final pass holds the GPU";

export function resolveDictationEngine(o: {
  /** `dictation.engine`, or the engine a clip names. */
  setting: string;
  /** What Qwen's llama-server runs on here: `cpu`, `metal`, `cuda`, `vulkan`, ... */
  accelerator: string;
  /** Qwen and the llama-server it runs on are on disk. */
  bestReady: boolean;
  /** Another Metal llama-server holds the GPU now, one `best` would have to give way to. */
  gpuBusy?: boolean;
  /** `dictation.final`, which decides while `setting` is `auto`; absent, `auto` picks as before. */
  final?: string;
  /** A streaming model for the dictation's languages is downloaded (DC-E7). */
  liveReady?: boolean;
}): EngineVerdict {
  const plain = (engine: DictationEngineName, verdict: string): EngineVerdict => ({
    engine,
    verdict,
    download: false,
    wanted: null,
    yielding: false,
  });
  const best = (): EngineVerdict =>
    o.gpuBusy
      ? {
          engine: "fast",
          verdict: GPU_BUSY_VERDICT,
          download: false,
          wanted: "best",
          yielding: true,
        }
      : plain("best", `best on ${o.accelerator}`);
  const setting =
    o.setting === "auto" && (o.final === "qwen" || o.final === "live")
      ? o.final === "qwen"
        ? "best"
        : "live"
      : o.setting;
  switch (setting) {
    case "live":
      return o.liveReady
        ? plain("live", "live")
        : {
            engine: "fast",
            verdict: LIVE_MISSING_VERDICT,
            download: false,
            wanted: "live",
            yielding: false,
          };
    case "remote":
      return plain("remote", "remote");
    case "fast":
      return plain("fast", "fast");
    case "best":
      return o.bestReady
        ? best()
        : {
            engine: "fast",
            verdict: "downloading best, using fast",
            download: true,
            wanted: "best",
            yielding: false,
          };
    default:
      if (o.accelerator === "cpu") return plain("fast", "fast: best needs a GPU");
      return o.bestReady ? best() : plain("fast", "fast: best (Qwen3-ASR) is not downloaded");
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
