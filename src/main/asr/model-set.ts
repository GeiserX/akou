/**
 * The speech models this machine's chosen setups use. The live model's and the final pass's
 * (`chosenModels`), with the helpers every setup shares (voice detection, TitaNet and the
 * speaker-label model, `modelsFor`), are what a call needs: what the first download fetches, what
 * `akou models pull` with no name gets, and what makes the models ready. The second pass's and
 * dictation's are kept with them while chosen (`keptModels`). A model none of them uses, Parakeet on
 * a Mac that runs Nemotron live and Qwen after the call, is one more model a person may Get or
 * Remove.
 *
 * `auto` prefers what is already on disk, so an upgrade never asks for a new download before the
 * next call:
 *
 * - **Final pass** (`asr.final.model`): `qwen` or `parakeet` as named. `auto` is Qwen when Qwen and
 *   its llama-server are here, on any machine, as `chooseFinalModel` runs it; else Parakeet when
 *   Parakeet is here. With neither, a first download fetches Qwen where the machine has room for it
 *   (`qwenRoom`: a GPU for it and 16 GB) and Parakeet elsewhere.
 * - **Live** (`asr.live`): `parakeet` as Parakeet; a named Nemotron when it is here, else Parakeet
 *   while Parakeet is here (a call runs it in the Nemotron's place and says why), else the named
 *   one. `auto` and `nemotron` are the downloaded Nemotron that hears the call's languages; with
 *   none, Parakeet when Parakeet is here or already chosen for the final pass, which then writes
 *   the live lines too; else the Nemotron the languages pick (`engineForLanguages`).
 * - **Second pass** (`asr.review.model`) and **dictation** (while it is on: `fast` is Parakeet,
 *   `best` is Qwen, `auto` follows `dictation.final`, whose `live` adds none) are kept while chosen
 *   (`keptModels`) but never waited for: a call runs without them, as it did before.
 *
 * A model the catalog here does not hold (a test's registry, a build for another platform) is
 * never asked for: a live or final choice that names one falls back to Parakeet.
 */

import { existsSync, statSync } from "node:fs";
import { totalmem } from "node:os";
import { type AcceleratorSetting, detectAccelerator, hostProbe } from "./accelerator.ts";
import { finalModelOf } from "./final-model.ts";
import { chooseLiveEngine, engineForLanguages, isLiveEngine } from "./live-engines.ts";
import { type LiveSetupContext, qwenRoom, reviewerId, reviewerOf } from "./live-setups.ts";
import { QWEN_ASR } from "./llama-catalog.ts";
import { llamaRuntime } from "./llama-server.ts";
import { type CatalogEntry, type ModelSpecEntry, modelFile, RECOGNIZER } from "./models.ts";

/** The settings the choice reads. */
export interface ModelSetSettings {
  readonly "asr.live": string;
  readonly "asr.live.engine": string;
  readonly "asr.languages": readonly string[];
  readonly "asr.review.model": string;
  readonly "asr.final.model": string;
  readonly "dictation.enabled": boolean;
  readonly "dictation.engine": string;
  readonly "dictation.final": string;
}

export interface ModelSetContext {
  settings: ModelSetSettings;
  /** Whether a catalog model's files are on disk. */
  present: (id: string) => boolean;
  /** The ids of the catalog here. */
  catalog: readonly string[];
  /** The llama-server build Qwen runs on here, or null for none (an own llama-server). */
  runtime: string | null;
  /** What Qwen needs of the machine; absent: not known, and Qwen is not assumed to fit. */
  machine?: { gpu: boolean; memoryGb: number };
}

/** The final pass's recognizer to keep and fetch: Qwen or Parakeet. */
export function intendedFinal(c: ModelSetContext): "qwen" | "parakeet" {
  const asked = finalModelOf(c.settings["asr.final.model"]);
  const qwenHere = c.catalog.includes(QWEN_ASR);
  if (asked === "parakeet" || !qwenHere) return "parakeet";
  if (asked === "qwen") return "qwen";
  // `auto` runs Qwen whenever it is downloaded (`chooseFinalModel`), on any machine.
  const qwenFiles = [QWEN_ASR, ...(c.runtime ? [c.runtime] : [])];
  if (qwenFiles.every((id) => c.present(id))) return "qwen";
  if (c.present(RECOGNIZER)) return "parakeet";
  // Neither is here: a first download fetches Qwen only where it has room to run well.
  if (!c.machine || qwenRoom({ machine: c.machine } as LiveSetupContext) !== null)
    return "parakeet";
  return "qwen";
}

/** The live model to keep and fetch: a Nemotron's id, or Parakeet's. */
export function intendedLive(c: ModelSetContext, final: "qwen" | "parakeet"): string {
  const setting = c.settings["asr.live"];
  if (setting === "parakeet" || setting === RECOGNIZER) return RECOGNIZER;
  const named = isLiveEngine(setting) ? setting : c.settings["asr.live.engine"];
  // A named Nemotron that is not here: a call runs Parakeet in its place while Parakeet is here
  // (`chooseLiveSetup`), so nothing new is waited for; with neither, the named one is fetched.
  if (isLiveEngine(named)) {
    if (!c.catalog.includes(named)) return RECOGNIZER;
    return c.present(named) || !c.present(RECOGNIZER) ? named : RECOGNIZER;
  }
  const languages = c.settings["asr.languages"];
  const here = chooseLiveEngine("auto", languages, (id) => c.catalog.includes(id) && c.present(id));
  if (here.choice) return here.choice.engine;
  if (c.present(RECOGNIZER) || final === "parakeet") return RECOGNIZER;
  const wanted = engineForLanguages(languages);
  return c.catalog.includes(wanted) ? wanted : RECOGNIZER;
}

/** Qwen with its llama-server build, or one other id. */
function withRuntime(c: ModelSetContext, id: string): string[] {
  return id === QWEN_ASR ? [QWEN_ASR, ...(c.runtime ? [c.runtime] : [])] : [id];
}

/** Each id once, in order, and only the catalog's. */
function tidy(c: ModelSetContext, ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => c.catalog.includes(id));
}

/**
 * The speech models a call needs here: the live model and the final pass's, Qwen followed by its
 * llama-server build. With the helpers, what makes the models ready, what the download card and
 * `akou models pull` fetch, and what a call or a final pass waits for.
 */
export function chosenModels(c: ModelSetContext): string[] {
  const final = intendedFinal(c);
  return tidy(c, [
    intendedLive(c, final),
    ...withRuntime(c, final === "qwen" ? QWEN_ASR : RECOGNIZER),
  ]);
}

/**
 * What the Models page keeps as the default, beyond `chosenModels`: the second pass's models and
 * dictation's, when chosen. A call does not wait for them (a second pass whose model is missing is
 * off, with a note; dictation falls back), so they are fetched by their own Download, but they are
 * never removed while chosen.
 */
export function keptModels(c: ModelSetContext): string[] {
  const s = c.settings;
  const out = chosenModels(c);
  const review = reviewerOf(s["asr.review.model"]);
  if (review) out.push(...withRuntime(c, reviewerId(review)));
  if (s["dictation.enabled"]) {
    const engine = s["dictation.engine"];
    const by =
      engine === "auto"
        ? s["dictation.final"] === "parakeet"
          ? "fast"
          : s["dictation.final"] === "qwen"
            ? "best"
            : null
        : engine;
    if (by === "fast") out.push(RECOGNIZER);
    if (by === "best") out.push(...withRuntime(c, QWEN_ASR));
  }
  return tidy(c, out);
}

/**
 * The chosen setups' models as the CLI sees them with no app to ask (`akou models pull` with no
 * name, `akou doctor`): the settings, the files on disk at their full size, the llama-server build
 * and GPU that detection finds, and this machine's memory. Undefined in server mode, whose jobs
 * name their own recognizer and keep the older set (`modelsFor` without `chosen`).
 */
export function chosenModelsHere(
  settings: ModelSetSettings & {
    readonly "server.enabled": boolean;
    readonly "asr.modelsDir": string;
    readonly "asr.accelerator": string;
    readonly "asr.llamaServer": readonly string[];
  },
  catalog: readonly ModelSpecEntry[],
  platform: string,
  env: NodeJS.ProcessEnv,
): string[] | undefined {
  if (settings["server.enabled"]) return undefined;
  const detected = detectAccelerator(
    settings["asr.accelerator"] as AcceleratorSetting,
    hostProbe(env),
  );
  const runtime = llamaRuntime(settings, platform, catalog as readonly CatalogEntry[], {
    image: env.AKOU_LLAMA_SERVER,
    detected,
  });
  const dir = settings["asr.modelsDir"];
  const present = (id: string) => {
    const m = catalog.find((x) => x.id === id);
    return (
      m?.files.every((f) => {
        const path = modelFile(dir, id, f.name);
        return existsSync(path) && statSync(path).size === f.size;
      }) === true
    );
  };
  return chosenModels({
    settings,
    present,
    catalog: catalog.map((m) => m.id),
    runtime,
    machine: { gpu: detected.gpu !== null, memoryGb: totalmem() / 1024 ** 3 },
  });
}
