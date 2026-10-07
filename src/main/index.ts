/**
 * The akou app (docs/DESIGN.md sections 1.1, 1.4, 1.5, 4.5 and 6): one process that owns every call.
 *
 * `startApp` wires the parts together:
 *
 * - **Settings** from the one registry (`config/schema.ts`), validated as a hand-edited file.
 * - **Single instance.** A pid lock in the config folder; a second app refuses to start and names
 *   the one running. `runtime.json` (pid, port, version) is written once the API listens, mode 0600,
 *   and removed at quit.
 * - **Calls**: the `CallManager` with the capture engine: the command `capture.helper` names (tests
 *   use `scripts/fake-helper.ts`), else the bundled `akou-capture`, else the one on PATH.
 * - **Speech**: the live recognizer Worker, started at once and in parallel, so a start never waits
 *   for a model; the final pass after every ending, when the part audio can be read.
 * - **Questions**: one `CallQuery` per call, kept so its index updates incrementally.
 * - **The local API** on 127.0.0.1 with the guard of DESIGN 6.3.
 *
 * Headless mode is chosen by `AKOU_HEADLESS=1`, never by command-line arguments, which the launcher
 * drops on Linux and on the first macOS launch (TRAPS "Command-line arguments dropped by the
 * launcher"). The window is a seam (`WindowShell`): until the ElectroBun shell exists the app runs
 * headless either way and says so.
 *
 * Quit (`POST /quit`, SIGINT, SIGTERM) is one path: stop the live call within the stop budget
 * (the log gets `part.ended` and `call.ended`, fsynced), let a running final pass finish for a few
 * seconds or leave it for the next start, stop the recognizer and the API, remove `runtime.json`,
 * release the lock. Nothing is killed by process name.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import type { Activation } from "../core/dictation/activation.ts";
import type { EventDraft, LogEvent } from "../core/log/events.ts";
import { type CallView, type FileVocabEntry, fold } from "../core/log/fold.ts";
import { eventsAfter, readLog } from "../core/log/reader.ts";
import {
  acquireLock,
  EVENTS_FILE,
  INSTANCE_ID,
  LockError,
  LogWriteError,
  lockHeartbeat,
  processAlive,
  readLock,
} from "../core/log/writer.ts";
import { Cues } from "../ui/dictation-cues.ts";
import { APP_IDENTITY } from "./api/access.ts";
import {
  ensureToken,
  type Guard,
  makePrivateDir,
  serverGuard,
  serverHostAllowed,
  TokenSource,
} from "./api/guard.ts";
import { HttpError } from "./api/http.ts";
import { KeyStore } from "./api/keys.ts";
import { type Cidr, isLoopback, parseCidr } from "./api/net.ts";
import { editFile, targetPath } from "./api/routes/vocab.ts";
import { type ApiApp, type ApiServer, type Levels, startApiServer } from "./api/server.ts";
import { APP_VERSION, RUNTIME_FILE } from "./app-info.ts";
import { APP_LOG, AppLog, HANGS_DIR } from "./app-log.ts";
import {
  type AcceleratorSetting,
  type AcceleratorState,
  detectAccelerator,
  hostProbe,
  llamaServerBin,
  type Probe,
  verifyAccelerator,
} from "./asr/accelerator.ts";
import type { DiarizerKind, LlamaEngineSpec, ModelSpec, ParakeetDecoding } from "./asr/engine.ts";
import {
  chooseFinalModel,
  FINAL_FUSION,
  type FinalChoice,
  finalModelId,
  finalModelOf,
  fusionEnginesHere,
} from "./asr/final-model.ts";
import type { FinalStep } from "./asr/final-text.ts";
import { type FinalAudioSpec, finalizeCall } from "./asr/finalize-worker.ts";
import {
  fusionChoice,
  fusionModelId,
  fusionParts,
  fusionSpec,
  isBuiltFuser,
  memoryBudgetMb,
} from "./asr/fusion.ts";
import { chooseLiveEngine, type LiveChoice } from "./asr/live-engines.ts";
import {
  chooseLiveSetup,
  type LiveSetupChoice,
  type LiveSetupContext,
  type LiveView,
  liveModelName,
  liveView,
  reviewerId,
  reviewModels,
  setupModels,
  shortModelName,
} from "./asr/live-setups.ts";
import {
  type CallAccess,
  type LineUpgrader,
  LiveAsr,
  type LiveReview,
  modelNameFor,
  recognizerReviewer,
  type VocabSource,
} from "./asr/live-worker.ts";
import { QWEN_ASR, QWEN_MMPROJ_FILE, QWEN_MODEL_FILE } from "./asr/llama-catalog.ts";
import {
  createLlamaServer,
  type LlamaPlan,
  type LlamaServer,
  llamaPlan,
  metalHolder,
} from "./asr/llama-server.ts";
import { chosenModels, keptModels, type ModelSetContext } from "./asr/model-set.ts";
import {
  DownloadRefused,
  downloadModels,
  hostPlatform,
  importModels,
  MODELS,
  type ModelSpecEntry,
  type ModelsStatus,
  modelFile,
  modelsFor,
  NEMOTRON,
  pruneRetiredModels,
  RECOGNIZER,
} from "./asr/models.ts";
import { DIARIZE_HELPER_NAME } from "./asr/nemotron.ts";
import { QwenEngine } from "./asr/qwen.ts";
import type { CallController } from "./call/call.ts";
import { partFile } from "./call/folder.ts";
import { CallManager, type StartAnswer, type StartRequest } from "./call/manager.ts";
import { fail, type Outcome } from "./call/state.ts";
import { type CaptureDevices, queryDevices } from "./capture/devices.ts";
import { type CaptureEngine, type Clock, realClock, withDeadline } from "./capture/engine.ts";
import { AkouCaptureEngine, findHelper, locateHelper } from "./capture/helper.ts";
import {
  buildSettings,
  HOOK_STAGES,
  type HookStage,
  type LoadedConfig,
  loadConfig,
  SETTING_KEYS,
  SETTINGS,
  type SettingKey,
  type SettingSpec,
  type Settings,
  type SettingValue,
} from "./config/schema.ts";
import {
  type SecretStore,
  STORED_SECRETS,
  type StoredSecret,
  systemSecrets,
} from "./config/secrets.ts";
import { BestEngine } from "./dictation/best.ts";
import { SystemCuePlayer } from "./dictation/cues.ts";
import {
  dictationLanguages,
  type EngineVerdict,
  LIVE_FAILED,
  resolveDictationEngine,
} from "./dictation/engines.ts";
import { formatPass } from "./dictation/format.ts";
import { LiveWords, liveDecode, type OpenStream } from "./dictation/live.ts";
import type { Bindings, InsertMethod, SendKey } from "./dictation/protocol.ts";
import { loadPunctuation } from "./dictation/punctuation.ts";
import { RemoteEngine, remoteFallback } from "./dictation/remote.ts";
import { DictationService } from "./dictation/service.ts";
import type { DictationEngine, WordStream } from "./dictation/session.ts";
import { correctDictation, knowsPair, learnPair, unlearnPair } from "./dictation/vocab.ts";
import { type ExportResult, exportCall } from "./handoff/export.ts";
import {
  buildPayload,
  type HookReport,
  hookDoneDraft,
  hooksFor,
  runHook,
} from "./handoff/hooks.ts";
import { sendWebhook, webhookDoneDraft, webhookProblem } from "./handoff/webhook.ts";
import { ImportError, type ImportResult, importHarkViewer } from "./import/hark-viewer.ts";
import { AnthropicProvider } from "./llm/anthropic.ts";
import {
  type Discovery,
  discoverHarnesses,
  HarnessProvider,
  type HarnessTarget,
  pickHarness,
} from "./llm/harness.ts";
import { NoneProvider } from "./llm/none.ts";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.ts";
import type { Provider } from "./llm/provider.ts";
import {
  enhance,
  enhancedDraft,
  enhanceExclusive,
  nextEnhancedRev,
  reEnhanceState,
  storeEnhanced,
} from "./notes/enhance.ts";
import { listPresets, type Preset } from "./notes/presets.ts";
import { listTemplates, type Template } from "./notes/templates.ts";
import { MemorySessions, type SessionStore } from "./query/ask.ts";
import { CallQuery } from "./query/context.ts";
import {
  MEMO_MIN_INTERVAL_MS,
  memoByProvider,
  ProviderMemoUpdater,
  refreshMemo,
} from "./query/memo.ts";
import { renderLine } from "./query/render.ts";
import { JobService, type JobServiceOptions, RETENTION_SWEEP_MS } from "./server/jobs.ts";
import { LiveRefused, LiveService } from "./server/live.ts";
import {
  type AutoChoice,
  autoChoice,
  type Held,
  hardwareChoice,
  kindOf,
  ModelRefused,
  ModelStore,
  type ModelStoreOptions,
  type ModelView,
} from "./server/model-store.ts";
import { NotWritable, requireWritable } from "./server/writable.ts";
import { LocalLink } from "./share/local-link.ts";
import { parseExpiry, type ShareHandle, type ShareStatus } from "./share/transport.ts";
import { callLanguages, Dictionaries } from "./vocab/dictionary.ts";
import {
  callEntries,
  type MergedEntry,
  mergeVocab,
  readVocabFile,
  toFoldEntries,
  type VocabFile,
  vocabPaths,
} from "./vocab/files.ts";
import { relaunchCommand, startWatchdog, type Watchdog } from "./watchdog.ts";
import { Bridge } from "./window/bridge.ts";
import { buildUi } from "./window/bundle.ts";
import { dictationHotkeyDefault, fixLastDefault } from "./window/hotkey.ts";
import { MAC_PANES, PageServer, type SettingsPane } from "./window/page-server.ts";

export { APP_VERSION, RUNTIME_FILE };
export const APP_LOCK = "akou.lock";

/** The events after which the watchdog reads the live state again at once (DK-M8). */
const LIVE_CHANGES: ReadonlySet<string> = new Set([
  "call.created",
  "part.started",
  "part.ended",
  "call.ended",
  "call.failed",
]);

/** The call events `app.log` names, by id only, with the words it uses (DK-M8). */
const LOGGED_EVENTS: Partial<Record<LogEvent["type"], string>> = {
  "call.created": "started",
  "call.ended": "ended",
  "call.failed": "failed",
  "part.started": "a part started",
  "part.ended": "a part ended",
  "final.started": "final pass started",
  "final.done": "final pass done",
  "final.failed": "final pass failed",
};
/** A final pass still running at quit gets this long, then is left for the next start. */
export const QUIT_FINAL_GRACE_MS = 5_000;
/** How long a settings change waits for the dictation helper to take or refuse new keys. */
const REBIND_ANSWER_MS = 3_000;
/** A running final pass pushes the status to the window at most this often, so its note moves. */
export const FINAL_PUSH_MS = 2_000;
/** How often dictation looks whether a final pass still holds the GPU `best` gave way to (DC-E2). */
export const BEST_REWARM_MS = 5_000;
/**
 * One Qwen request of the in-call upgrade: a minute's utterances took 4.5 to 7.9 s on the reference
 * Mac mini. One past a minute keeps the streaming text, since Qwen would not keep up with the call.
 */
export const LIVE_QWEN_TIMEOUT_MS = 60_000;
/**
 * The settings that decide which engine a dictation runs and how `best`'s server starts and idles
 * (DC-E2, DC-E3): a changed idle time arms its timer now, not after the next dictation.
 */
const WARM_KEYS = [
  "dictation.engine",
  "dictation.final",
  "dictation.languages",
  "asr.languages",
  "asr.accelerator",
  "asr.llamaServer",
  "asr.modelsDir",
  "asr.qwenIdleMinutes",
] as const satisfies readonly SettingKey[];
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Names, merges and vocabulary change in bursts; a re-export waits this long for the last one. */
export const REEXPORT_DEBOUNCE_MS = 1_500;

/** Events after which an exported call is exported again (DESIGN 8.2): names and corrections. */
const REEXPORT_ON: ReadonlySet<string> = new Set([
  // The export file takes the new title's name (PG-A4).
  "call.renamed",
  "speaker.name",
  "speaker.merge",
  "speaker.unmerge",
  "vocab.add",
  "vocab.propose",
  "note",
  "note.del",
]);

/** The window, when there is one. The ElectroBun shell implements it; headless has none. */
export interface WindowShell {
  /** Brings the window forward, on a call when one is named (`akou open CALL`). */
  show(call?: string): void | Promise<void>;
  close(): Promise<void>;
  /** The global hotkey that starts and stops a call, or null when another app holds it. */
  registeredHotkey?(): string | null;
  /** Is the main window open now? The watchdog opens the app again only if it was (DK-M8). */
  isOpen?(): boolean;
}

export type WindowFactory = (app: AkouApp) => Promise<WindowShell>;

/**
 * What a door just asked of the app and how it went, with who asked (`by`): the shell turns it
 * into a notification (docs/ux/DESKTOP.md section 8). Nothing about the call's content.
 */
export type Announcement =
  | { what: "start"; by: string; ok: true; call: string }
  | { what: "start"; by: string; ok: false; code: string }
  | { what: "share"; by: string; call: string };

/** The settings as `config.json` holds them. */
type ConfigFile = Partial<Record<SettingKey, SettingValue>>;

export interface AppOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Force headless on or off; by default `AKOU_HEADLESS` decides. */
  headless?: boolean;
  /** The capture engine; by default the helper `capture.helper` names. */
  engine?: CaptureEngine;
  /**
   * The recognizer's models: a spec (tests pass the fake module), null for none, or by default
   * sherpa-onnx from `asr.modelsDir` when every model file is there.
   */
  models?: ModelSpec | null;
  /** Runs the live recognizer on the main thread. Tests only. */
  asrInThread?: boolean;
  /**
   * The model files `POST /models/pull` fetches and a start requires. Tests pass tiny files on a
   * loopback server; the recognizer is then not restarted after a pull, because they are not models.
   */
  modelRegistry?: readonly ModelSpecEntry[];
  /**
   * Where the final pass reads a call's audio, or null when it cannot. By default a part's Opus
   * file, decoded by the capture helper, or a 16-bit WAV beside it (`partsAudio`).
   */
  finalAudio?: (call: { id: string; dir: string; parts: number[] }) => FinalAudioSpec | null;
  /** The window. None means headless. */
  window?: WindowFactory;
  /** The provider, replacing the one the settings name. Tests pass a fake. */
  provider?: Provider;
  /**
   * Where the provider's API key is kept instead of `config.json`: the entry points pass
   * `systemSecrets()`, the Keychain on macOS. None keeps it in the file, as on Windows and Linux,
   * and as every test does that passes no fake store.
   */
  secrets?: SecretStore | null;
  /** The webhook's HTTP client and backoff. Tests pass a local one; nothing else does. */
  webhook?: { fetch?: typeof fetch; backoffMs?: readonly number[] };
  /** Looks for Claude Code and Codex. Tests pass a fake; nothing else does. */
  discover?: (env: Record<string, string | undefined>) => Promise<Discovery>;
  clock?: Clock;
  /**
   * Opens a URL with the system (the permission banner's System Settings pane). Tests pass a fake;
   * by default macOS `open` and Windows `start` are used, and elsewhere nothing opens.
   */
  openExternal?: (url: string) => Promise<boolean>;
  /** The machine's network interfaces, for choosing a share address. Tests pass their own. */
  interfaces?: () => ReturnType<typeof import("node:os").networkInterfaces>;
  /**
   * What the capture helper excludes from the call channel as akou's own audio: the bundle id on
   * macOS, the app's process on Windows (DESIGN 2.3). The desktop entry sets it; headless has none.
   */
  excludeResponsible?: string;
  /** Test-only: the security suite's positive control replaces the guard. */
  guard?: Guard;
  /**
   * Test-only: the file jobs' upload decoder, webhook network and clock, and the
   * model store's clock, retry waits and free-space probe (both modes).
   */
  jobs?: Pick<
    JobServiceOptions,
    "decode" | "delivery" | "now" | "remoteProbeMs" | "remoteFetch"
  > & {
    modelStore?: Pick<ModelStoreOptions, "retryMs" | "freeBytes" | "fetch">;
  };
  /**
   * What `asr.accelerator` reads of the machine, and how llama-server is asked for its devices
   * (akou-5an.94). Tests pass a fake machine; by default the real one and the real binary.
   */
  accelerator?: {
    probe?: Probe;
    run?: (bin: string) => Promise<{ output?: string; error?: string }>;
  };
  /**
   * The Metal llama-server beside dictation's own (`except`), a final pass's, or null: by default
   * `metalHolder` over the build's pid file. Tests pass their own, since a fake llama-server named
   * by `asr.llamaServer` has no build folder to hold the file.
   */
  metalHolder?: (lockDir: string | undefined, except: number | null) => number | null;
  /** The machine's memory in GB, which `auto` reads before it runs Qwen in a call. Tests only. */
  memoryGb?: number;
  /** How often the in-call upgrade reviews a call's closed utterances, ms. Tests only. */
  liveReviewEveryMs?: number;
  version?: string;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
  /**
   * Write `app.log` in the config folder and run the watchdog (DK-M8). The two entry points set
   * it; tests and `akou serve` do not.
   */
  supervise?: boolean;
}

export { NotWritable };

/** The settings forbid a start; the entry point exits 78 (EX_CONFIG) with the message. */
export class StartRefused extends Error {
  override name = "StartRefused";
}

/**
 * Where the API listens (SV-D2, SV-P5): the app on 127.0.0.1 always, as DESIGN 6.3 rule 1 says;
 * server mode on `api.bind`, 0.0.0.0 by default, and on an address that is not loopback only with
 * `server.behind_proxy`, since TLS is the proxy's job and akou has none of its own.
 */
export function apiBind(s: LoadedConfig["settings"]): string {
  if (!s["server.enabled"]) return "127.0.0.1";
  const bind = s["api.bind"] === "" ? "0.0.0.0" : s["api.bind"];
  // The CLI and the MCP server on this box dial 127.0.0.1 (`runtime.json` holds the port only),
  // which reaches these three binds and no other.
  if (bind !== "127.0.0.1" && bind !== "0.0.0.0" && bind !== "::") {
    throw new StartRefused(
      `api.bind is ${bind}; server mode binds 127.0.0.1, 0.0.0.0 or ::, since akou's CLI on this box reaches the server at 127.0.0.1`,
    );
  }
  if (!isLoopback(bind) && !s["server.behind_proxy"]) {
    throw new StartRefused(
      `api.bind is ${bind}, which is not loopback, and server.behind_proxy is false: put a reverse proxy with TLS in front of akou and set server.behind_proxy to true, or set api.bind to 127.0.0.1`,
    );
  }
  return bind;
}

/**
 * The app lock names a holder this process cannot see, and is too fresh to take (SI-4): after a
 * container restart, the earlier start's lock until it is 30 s old, or another container on the
 * same volume that keeps it fresh. The entry point exits 75 (EX_TEMPFAIL), so a restart policy
 * starts it again, never 0, which would tell Docker the service finished.
 */
export class LockAgingError extends Error {
  override name = "LockAgingError";
  constructor(pid: number, aging: { ageMs: number; staleMs: number }) {
    const s = (ms: number) => Math.max(0, Math.round(ms / 1000));
    super(
      `a lock from an earlier start is ${s(aging.ageMs)} s old; it frees in ${s(aging.staleMs - aging.ageMs)} s, unless another akou on this volume (pid ${pid} in its own namespace) keeps it fresh`,
    );
  }
}

export class AlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    readonly runtime: { port?: number; version?: string } | null,
  ) {
    super(`akou is already running (pid ${pid}${runtime?.port ? `, port ${runtime.port}` : ""})`);
    this.name = "AlreadyRunningError";
  }
}

function dbfs(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i] as number);
    if (a > peak) peak = a;
  }
  return peak <= 1e-6 ? -120 : Math.max(-120, Math.round(20 * Math.log10(peak) * 10) / 10);
}

/** Writes a file atomically with mode 0600 (a private temporary file renamed over it). */
function writePrivate(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

function modelsPresent(dir: string, registry: readonly ModelSpecEntry[]): boolean {
  return registry.every((m) => m.files.every((f) => existsSync(modelFile(dir, m.id, f.name))));
}

/** One run of `pullModels`: bytes per file so far, the file in flight, how it failed. */
interface ModelsPull {
  running: Promise<void> | null;
  done: Map<string, number>;
  file?: string;
  error?: string;
}

/**
 * Whether the final layer covers the whole call: the pass ran, and no part started after it (a
 * restarted call is final again only once the pass has run over the new part).
 */
function finalCurrent(v: CallView): boolean {
  const done = v.final.state === "done" ? (v.final.done?.seq ?? 0) : null;
  return done !== null && v.parts().every((p) => p.startSeq < done);
}

/**
 * The default final-pass audio (SV-P10): a 16-bit WAV beside every part's Opus file when each has
 * one (hark and the fake helper write them), else every part's Opus file decoded by the capture
 * helper. Null when a part has neither, when its Opus file is empty (a helper that never wrote a
 * header), or when the helper is not there.
 */
export function partsAudio(
  call: { dir: string; parts: number[] },
  helper: { command: string[]; found: string | null },
): FinalAudioSpec | null {
  if (call.parts.length === 0) return null;
  const opus: Record<number, string> = {};
  const wav: Record<number, string> = {};
  for (const p of call.parts) {
    opus[p] = join(call.dir, partFile(p));
    const w = (opus[p] as string).replace(/\.opus$/, ".wav");
    if (existsSync(w)) wav[p] = w;
  }
  if (Object.keys(wav).length === call.parts.length) return { kind: "wav", files: wav };
  if (!helper.found) return null;
  for (const f of Object.values(opus)) if (!existsSync(f) || statSync(f).size === 0) return null;
  return { kind: "opus", command: helper.command, files: opus };
}

export class AkouApp implements ApiApp {
  readonly version: string;
  readonly manager: CallManager;
  readonly configDir: string;
  readonly headless: boolean;
  readonly startedAt: number;
  readonly runtimeFile: string;
  readonly tokenPath: string;
  /** Resolves when the app has quit. */
  readonly closed: Promise<void>;
  /** `app.log` (DK-M8), when the entry point asked for it. */
  private readonly appLog: AppLog | null;
  private watchdog: Watchdog | null = null;
  /** Starts under way, which the watchdog counts as recording from before the helper spawns. */
  private starting = 0;
  server: ApiServer | null = null;
  window: WindowShell | null = null;
  asr: LiveAsr | null = null;
  asrState: { state: "loading" | "ready" | "unavailable"; reason?: string; model?: string } = {
    state: "unavailable",
    reason: "not started",
  };
  private modelsPull: ModelsPull = { running: null, done: new Map() };
  /** The recognizer waits for its model files (`startAsr`). */
  private asrAwaitingModels = false;
  /**
   * The speaker-label engine the running recognizer started with. `asr.diarizer` takes effect at
   * the next start, and the final pass runs this one until then.
   */
  private asrDiarizer: DiarizerKind | null = null;
  /** How the running recognizer decodes. `asr.parakeet.decoding` also waits for the next start. */
  private asrDecoding: ParakeetDecoding | null = null;

  private cfg: LoadedConfig;
  private readonly clock: Clock;
  private readonly bus = new Map<string, Set<(e: LogEvent) => void>>();
  private readonly watchers = new Set<(call: string, e: LogEvent) => void>();
  /** Told when the status changes without a log event (a share viewer came or went). */
  private readonly statusWatchers = new Set<() => void>();
  /** Told after every start and share, with who asked (`onAnnounce`). */
  private readonly announceWatchers = new Set<(a: Announcement) => void>();
  /** The window in a browser, started the first time a headless app is asked to show it. */
  page: PageServer | null = null;
  /** Read-only live links (DESIGN 8.3); in memory only, so a share never survives a restart. */
  readonly sharing: LocalLink;
  private pageStarting: Promise<PageServer> | null = null;
  private readonly levelsByCall = new Map<string, { mic: number; call: number; at: number }>();
  private readonly queries = new WeakMap<object, CallQuery>();
  private readonly vocabCache = new Map<string, VocabSource>();
  /** The live setup each call runs, chosen once when it first takes the recognizer. */
  private readonly liveRan = new Map<string, LiveSetupChoice>();
  /** Workspaces whose vocabulary files could not be read; retried when the vocabulary changes. */
  private readonly vocabFailed = new Set<string>();
  /** Reads of a workspace's vocabulary files in flight, so two readers share one. */
  private readonly vocabLoading = new Map<string, Promise<void>>();
  /** Bumped when the files change, so a read that started before never caches the old files. */
  private vocabGen = 0;
  /** The read-time form of each loaded vocabulary, kept so a view can tell nothing changed. */
  private readonly foldEntries = new WeakMap<VocabSource, readonly FileVocabEntry[]>();
  /** The word lists that tell a real word from a mishearing (DESIGN 5.4), read on first use. */
  private readonly dictionaries: Dictionaries;
  private readonly finals = new Map<string, Promise<unknown>>();
  /**
   * How far each running final pass is, and its recognizer: seconds of the call covered and the
   * call's length (0 until the pass has read it). In memory only; `GET /status` and
   * `GET /calls/{id}` read it, and the window gets it with the status.
   */
  private readonly finalRuns = new Map<
    string,
    {
      model: string;
      done_s: number;
      total_s: number;
      pushedAt: number;
      step: FinalStep | null;
      /** The call whose Qwen pass this one waits for, until it starts. */
      waiting: string | null;
    }
  >();
  /**
   * The last Qwen pass started or queued, and its end: one Qwen pass at a time app-wide, since a
   * second llama-server on Metal stops the first.
   */
  private qwenLine: { call: string; done: Promise<unknown> } | null = null;
  /** Aborts every running final pass when the app quits past `QUIT_FINAL_GRACE_MS`. */
  private readonly finalStop = new AbortController();
  /** Per call, the hand-off work in order: one export or hook round at a time. */
  private readonly handoffs = new Map<string, Promise<unknown>>();
  private readonly reexports = new Map<string, ReturnType<typeof setTimeout>>();
  /** Calls with a memo being written, and when a failed one may be tried again. */
  private readonly memos = new Set<string>();
  private readonly memoRetryAt = new Map<string, number>();
  private quitting: Promise<void> | null = null;
  /** Claude Code and Codex as found at start; null while still looking. */
  discovery: Discovery | null = null;
  /** The store the API key lives in instead of `config.json`, or null for the file. */
  private readonly secrets: SecretStore | null;
  /** The stored keys as read at start and written since: the settings carry them from here. */
  private readonly secretValues = new Map<StoredSecret, string>();
  /** Keys the store refused at start, so they stay in the file until a save moves them. */
  private readonly secretsInFile = new Set<StoredSecret>();
  private discovering = false;
  private resolveClosed!: () => void;
  private lockPath: string;
  tokens: TokenSource;
  /** `server` when `server.enabled` is on (docs/ux/SERVER.md); fixed for the life of the process. */
  private readonly runMode: "app" | "server";
  /** The API keys; server mode only (SV-K2). */
  private readonly keyStore: KeyStore | null;
  /**
   * File jobs (docs/ux/SERVER.md section 5), in both modes: in app mode the one token submits
   * them (`akou transcribe`) and owns every job, as the key id `app`.
   */
  private jobService: JobService | null = null;
  /** The live door, `GET /v1/live`; server mode only, made at its first use. */
  private liveService: LiveService | null = null;
  /**
   * The models on disk, their per-model downloads, last use, measured speed and the unused-days
   * sweep, in both modes (SERVER.md section 12.3, DESKTOP.md DK-E2). Made at start.
   */
  private shelf: ModelStore | null = null;
  /** The app's hourly model sweep; server mode's runs in the job service. */
  private modelSweep: ReturnType<typeof setInterval> | null = null;
  /** The GPU llama-server runs on: detected at start, then confirmed by the build itself. */
  private accel: AcceleratorState | null = null;
  /** Dictation (docs/ux/DICTATION.md); app mode only, since a server has no keyboard. */
  private dictationSvc: DictationService | null = null;
  /** The cue player dictation plays through; its files go when the app closes (DC-O3). */
  private cuePlayer: SystemCuePlayer | null = null;
  /** Dictation's vocabulary (DC-L6), read on the first dictation after a change. */
  private dictationVocab: Promise<MergedEntry[]> | null = null;
  /** The `remote` dictation engine, made at the first remote dictation; it reads its settings live. */
  private remoteDictation: RemoteEngine | null = null;
  /** The `best` dictation engine: Qwen's llama-server kept warm while dictation is on (DC-E2). */
  private bestDictation: BestEngine | null = null;
  /** Warm-ups of a dictation's models on the live Worker still running (DC-E7). */
  private dictationWarming = 0;
  /** The next look at whether `best` may be warmed again, while it gives way to the GPU's holder. */
  private bestRewarm: unknown = null;
  /**
   * Qwen's llama-server for the in-call upgrade when dictation keeps none warm, with the spec it
   * was made from. It gives way to a final pass on Metal, and stops when its call ends.
   */
  private liveQwen: { server: LlamaServer; key: string } | null = null;
  /** The machine that detection read: its env names the image's llama-server. */
  private accelProbe: Probe | null = null;

  constructor(
    private readonly o: AppOptions,
    cfg: LoadedConfig,
    token: { token: string; path: string },
    lockPath: string,
  ) {
    // Server mode keeps the key in the file on every system, and never writes it to a Keychain.
    const server = cfg.settings["server.enabled"];
    this.secrets = server ? null : (o.secrets ?? null);
    this.cfg = this.readSecrets(cfg, server ? (o.secrets ?? null) : this.secrets);
    this.version = o.version ?? APP_VERSION;
    this.clock = o.clock ?? realClock;
    this.configDir = cfg.paths.configDir;
    this.headless = o.headless ?? cfg.settings["app.headless"];
    this.runMode = cfg.settings["server.enabled"] ? "server" : "app";
    this.keyStore =
      this.runMode === "server"
        ? new KeyStore(
            this.configDir,
            // clock: the key store's injected clock, real in the app.
            () => Date.now(),
            (line) => this.log("info", line),
          )
        : null;
    this.startedAt = this.clock.now();
    this.runtimeFile = join(this.configDir, RUNTIME_FILE);
    this.appLog = o.supervise ? new AppLog(join(this.configDir, APP_LOG)) : null;
    this.tokenPath = token.path;
    this.tokens = new TokenSource(token.path, token.token);
    this.lockPath = lockPath;
    this.closed = new Promise((r) => {
      this.resolveClosed = r;
    });
    const s = cfg.settings;
    this.dictionaries = new Dictionaries(undefined, (msg) => this.log("warn", msg));
    const engine =
      o.engine ??
      new AkouCaptureEngine({
        command: locateHelper(s["capture.helper"]).command,
      });
    this.manager = new CallManager({
      root: s["recordings.root"],
      writer: { serverMode: this.runMode === "server" },
      engine,
      clock: this.clock,
      user: s["user.name"],
      akouVersion: this.version,
      capture: {
        mic: s["capture.mic"],
        call: s["capture.call"],
        excludeResponsible: o.excludeResponsible,
      },
      ingest: { queueSeconds: s["capture.queueSeconds"] },
      budgets: {
        warmStartMs: s["capture.warmStartSeconds"] * 1000,
        coldStartMs: s["capture.coldStartSeconds"] * 1000,
        stopMs: s["capture.stopSeconds"] * 1000,
        stallMs: s["capture.stallSeconds"] * 1000,
        deadRestartMs: s["capture.deadRestartSeconds"] * 1000,
      },
      onEvent: (id, e) => this.onEvent(id, e),
      onPacket: (id, part, p, ingest) => {
        this.asr?.onPacket(id, part, p, ingest);
        const lv = this.levelsByCall.get(id) ?? { mic: -120, call: -120, at: 0 };
        lv[p.ch] = dbfs(p.samples);
        lv.at = this.clock.now();
        this.levelsByCall.set(id, lv);
      },
      beforeEnd: (id) => this.asr?.flush(id) ?? Promise.resolve(),
      onOpen: (c) => void this.readyRead(c),
    });
    this.sharing = new LocalLink({
      app: this,
      bundle: buildUi,
      port: s["share.port"],
      interfaces: o.interfaces,
      onViewers: () => {
        for (const fn of this.statusWatchers) fn();
      },
      onError: (err) => this.log("warn", `share: ${(err as Error).message}`),
    });
    this.startAsr(s);
    if (s["provider.kind"] === "harness") this.discoverHarnesses();
  }

  // -------------------------------------------------------------------------
  // The provider

  /**
   * Looks for the harnesses in the background, once, so a start never waits for a login shell.
   * Runs at start when the provider is the harness, else the first time the harness is asked for.
   */
  private discoverHarnesses(): void {
    if (this.discovering) return;
    this.discovering = true;
    const env = this.o.env ?? process.env;
    const find = this.o.discover ?? ((e) => discoverHarnesses(e, this.o.platform));
    void find(env)
      .then((d) => {
        this.discovery = d;
        if (this.server) this.writeRuntime();
      })
      .catch((err) => {
        this.discovery = { claude: null, codex: null };
        this.log("warn", `harness discovery: ${(err as Error).message}`);
      });
  }

  private harnessTarget(): HarnessTarget | { none: string } {
    const s = this.cfg.settings;
    if (s["provider.harnessPath"] === "") this.discoverHarnesses();
    return pickHarness(
      s["provider.harness"] as "auto" | "claude" | "codex",
      s["provider.harnessPath"],
      this.discovery,
    );
  }

  /** The provider the settings name, built fresh so a settings change applies at once. */
  provider(): Provider {
    if (this.o.provider) return this.o.provider;
    const s = this.cfg.settings;
    switch (s["provider.kind"]) {
      case "harness":
        return new HarnessProvider({
          target: () => this.harnessTarget(),
          env: this.o.env ?? process.env,
          onLog: (level, msg) => this.log(level, msg),
        });
      case "openai-compatible":
        return new OpenAiCompatibleProvider({
          baseUrl: s["provider.baseUrl"],
          model: s["provider.model"],
          apiKey: s["provider.apiKey"],
        });
      case "anthropic":
        return new AnthropicProvider({
          apiKey: s["provider.apiKey"],
          model: s["provider.model"],
          baseUrl: s["provider.baseUrl"],
        });
      default:
        return new NoneProvider();
    }
  }

  providerTimeoutMs(): number {
    return this.cfg.settings["provider.timeoutSeconds"] * 1000;
  }

  private sessions: MemorySessions | null = null;

  /**
   * Kept harness sessions for follow-up questions (`provider.harnessResume`, off by default until
   * measured, docs/providers.md). Turning it off forgets them.
   */
  askSessions(): SessionStore | undefined {
    if (!this.cfg.settings["provider.harnessResume"]) {
      this.sessions = null;
      return undefined;
    }
    this.sessions ??= new MemorySessions((id) => HarnessProvider.endSession(id));
    return this.sessions;
  }

  /** What `status` and `akou_ask`'s visibility read: `{state, id, harness?, detail | reason}`. */
  async providerStatus(): Promise<Record<string, unknown>> {
    const p = this.provider();
    const a = await p.available();
    const harness = p instanceof HarnessProvider ? p.label() : undefined;
    const checking =
      p.id === "harness" &&
      !this.o.provider &&
      this.discovery === null &&
      this.cfg.settings["provider.harnessPath"] === "";
    if (a.ok) return { state: "available", id: p.id, harness, detail: a.detail };
    return { state: checking ? "checking" : "unavailable", id: p.id, harness, reason: a.reason };
  }

  /**
   * The models the next start needs: the helpers for `asr.diarizer` and the speech models the
   * chosen setups use (model-set.ts), so Parakeet is in it only when a setup uses it. What the
   * download card and `POST /models/pull` fetch, and what makes the models ready.
   */
  private registry(): readonly ModelSpecEntry[] {
    return modelsFor(
      this.cfg.settings,
      hostPlatform(),
      this.o.modelRegistry ?? MODELS,
      this.chosenModels(),
    );
  }

  /**
   * The speech models the live model, the second pass, the final pass and dictation use here, or
   * undefined in server mode, whose jobs name their own recognizer and keep the older set.
   */
  private chosenModels(): string[] | undefined {
    if (this.runMode === "server") return undefined;
    return chosenModels(this.modelSetContext());
  }

  /** What `chosenModels` and `keptModels` read: the settings, the files here, the machine. */
  private modelSetContext(): ModelSetContext {
    const ctx = this.liveContext();
    return {
      settings: this.cfg.settings,
      present: ctx.present,
      catalog: ctx.catalog ?? [],
      runtime: ctx.runtime,
      ...(ctx.machine ? { machine: ctx.machine } : {}),
    };
  }

  /** The speaker-label engine running now: the one the recognizer started with, else the setting. */
  private runningDiarizer(): DiarizerKind {
    return this.asrDiarizer ?? (this.cfg.settings["asr.diarizer"] as DiarizerKind);
  }

  /** How the running recognizer decodes, else the setting: the final pass decodes the same way. */
  private runningDecoding(): ParakeetDecoding {
    return this.asrDecoding ?? (this.cfg.settings["asr.parakeet.decoding"] as ParakeetDecoding);
  }

  /**
   * Whether the running engine's model files are there: what a call's start needs, the helpers and
   * the chosen setups' models. A final pass has its own rule (`finalModelsPresent`). A change to
   * `asr.diarizer` mid-run never asks for models the running recognizer does not use.
   */
  private runningModelsPresent(): boolean {
    const registry = modelsFor(
      { "asr.diarizer": this.runningDiarizer() },
      hostPlatform(),
      this.o.modelRegistry ?? MODELS,
      this.chosenModels(),
    );
    return modelsPresent(this.cfg.settings["asr.modelsDir"], registry);
  }

  /**
   * Whether a final pass has its models: the helpers of the running speaker-label engine, and
   * Parakeet when Parakeet decodes. A pass needs no live model, and Qwen's own files are checked
   * where Qwen is chosen (`chooseFinalModel`).
   */
  private finalModelsPresent(qwen: boolean): boolean {
    const registry = modelsFor(
      { "asr.diarizer": this.runningDiarizer() },
      hostPlatform(),
      this.o.modelRegistry ?? MODELS,
      qwen ? [] : [RECOGNIZER],
    );
    return modelsPresent(this.cfg.settings["asr.modelsDir"], registry);
  }

  /**
   * What the next call's live setup depends on here: the settings (or a call's own `live` and
   * review), memory and models on disk.
   */
  private liveContext(
    ask: { live?: string; review?: { model?: string; everySeconds?: number } } = {},
  ): LiveSetupContext {
    const s = this.cfg.settings;
    const catalog = this.o.modelRegistry ?? MODELS;
    const plan = this.llamaPlan();
    return {
      machine: {
        gpu: plan.accelerator !== "cpu",
        memoryGb: this.o.memoryGb ?? totalmem() / 1024 ** 3,
      },
      setting: ask.live ?? s["asr.live"],
      engine: s["asr.live.engine"],
      languages: s["asr.languages"],
      review: ask.review?.model ?? s["asr.review.model"],
      everySeconds: ask.review?.everySeconds ?? s["asr.review.everySeconds"],
      present: (id) => {
        const m = catalog.find((x) => x.id === id);
        return m !== undefined && modelsPresent(s["asr.modelsDir"], [m]);
      },
      runtime: plan.build?.id ?? null,
      catalog: catalog.map((m) => m.id),
    };
  }

  /**
   * The live setup a call runs (`asr.live` and `asr.review.*`, or the call's own), only ever one
   * whose model files are here: its streaming engine, or null for the recognizer's VAD windows,
   * and its second pass.
   */
  private liveChoice(callId: string): LiveSetupChoice {
    const c = this.manager.controller(callId);
    return chooseLiveSetup(
      this.liveContext({
        ...(c?.liveAsked ? { live: c.liveAsked } : {}),
        ...(c?.reviewAsked ? { review: c.reviewAsked } : {}),
      }),
    );
  }

  /** A call's second pass: Qwen, or Parakeet on the live Worker's own recognizer. */
  private liveReview(callId: string): LiveReview | null {
    const r = this.liveRan.get(callId)?.review;
    if (!r) return null;
    const asr = this.asr;
    const reviewer: LineUpgrader =
      r.model === "qwen"
        ? this.liveUpgrader()
        : recognizerReviewer((parts, signal) =>
            asr ? asr.review(parts, signal) : Promise.reject(new Error("the recognizer is closed")),
          );
    return {
      name: liveModelName(r.model === "qwen" ? QWEN_ASR : RECOGNIZER),
      reviewer,
      everySeconds: r.everySeconds,
      // A read does not wait on Qwen while a final pass holds its GPU.
      ...(r.model === "qwen" ? { busy: () => this.finalHoldsGpu() } : {}),
    };
  }

  /**
   * A final pass's Metal llama-server holds the GPU: one that is neither dictation's warm Qwen nor
   * the second pass's own.
   */
  private finalHoldsGpu(): boolean {
    if (this.llamaPlan().accelerator !== "metal") return false;
    const holder = (this.o.metalHolder ?? metalHolder)(
      this.llamaSpec(QWEN_ASR).build?.dir,
      this.bestDictation?.pid() ?? null,
    );
    return holder !== null && holder !== (this.liveQwen?.server.pid() ?? null);
  }

  /**
   * Review before a read (`GET /calls/{id}/transcript`, `POST /calls/{id}/context`): with a second
   * pass on for this live call, its closed lines are reviewed first, waiting at most
   * `REVIEW_READ_WAIT_MS`. Null with no second pass, or once the call has ended.
   */
  async settleReview(callId: string): Promise<{ unreviewed: number } | null> {
    return (await this.asr?.reviewForRead(callId)) ?? null;
  }

  /**
   * Qwen for a call's second pass (ASR-7): the server dictation keeps warm when one runs, so
   * one Qwen serves both, else one of its own. Its own gives way to a final pass on Metal instead
   * of stopping it: the lines keep the streaming text meanwhile. A request never starts or
   * restarts a server someone else owns or that was let go of: that process would run untracked.
   */
  private liveUpgrader(): LineUpgrader {
    const gone = () => Promise.reject(new Error("its llama-server was stopped"));
    return {
      decode: (samples, o) => {
        const spec = this.llamaSpec(QWEN_ASR);
        const langs = this.cfg.settings["asr.languages"];
        const warm = this.bestDictation?.warmServer() ?? null;
        const own = warm ? null : this.liveQwenServer(spec);
        const server = warm
          ? {
              url: () => (this.bestDictation?.warmServer() === warm ? warm.url() : gone()),
              // Dictation's server is dictation's to restart.
              restart: gone,
            }
          : {
              url: () => (this.liveQwen?.server === own ? (own as LlamaServer).url() : gone()),
              restart: () =>
                this.liveQwen?.server === own ? (own as LlamaServer).restart() : gone(),
            };
        const qwen = new QwenEngine({
          id: spec.engine,
          server,
          allowed: langs,
          timeoutMs: LIVE_QWEN_TIMEOUT_MS,
          signal: o.signal,
          log: (level, msg) => this.log(level, `second pass: ${msg}`),
        });
        const [only] = langs;
        return qwen.decode({
          samples,
          lang: langs.length === 1 && only ? only : "auto",
          glossary: o.glossary,
        });
      },
    };
  }

  /** The second pass's own llama-server for this spec, made on first use. */
  private liveQwenServer(spec: LlamaEngineSpec): LlamaServer {
    const key = JSON.stringify(spec);
    if (this.liveQwen?.key === key) return this.liveQwen.server;
    this.stopLiveQwen();
    const server = createLlamaServer(spec, {
      yieldMetal: true,
      log: (level, msg) => this.log(level, `second pass: ${msg}`),
    });
    this.liveQwen = { server, key };
    return server;
  }

  private stopLiveQwen(): void {
    const q = this.liveQwen;
    this.liveQwen = null;
    void q?.server.stop();
  }

  /** The Live section of `GET /models`: each setup, the one the next call runs and the live call's. */
  liveModels(): LiveView | null {
    if (this.runMode === "server") return null;
    const live = this.manager.live();
    const ran = live ? this.liveRan.get(live.id) : undefined;
    const running = ran
      ? { setup: ran.setup, review: ran.review, engine: ran.choice?.engine ?? null }
      : null;
    const shelf = this.shelf;
    const ctx = this.liveContext();
    return liveView(ctx, running, (id) =>
      shelf ? shelf.state(id) : ctx.present(id) ? "ready" : "missing",
    );
  }

  /** The real engines on the models folder, with the speaker-label engine the settings choose. */
  private sherpaSpec(
    s: Settings,
    diarizer = s["asr.diarizer"] as DiarizerKind,
    decoding = s["asr.parakeet.decoding"] as ParakeetDecoding,
  ): ModelSpec {
    return {
      kind: "sherpa",
      dir: s["asr.modelsDir"],
      cacheDir: join(s["asr.modelsDir"], ".cache"),
      threads: s["asr.threads"],
      diarizer,
      decoding,
      diarizeHelper: locateHelper(s["asr.diarizeHelper"], { name: DIARIZE_HELPER_NAME }).command,
    };
  }

  /**
   * The speech models on disk. `ready` when a recognizer spec is given (tests, or none on purpose)
   * or every file is present; the checksums were checked when each file was written.
   */
  models(): ModelsStatus {
    const dir = this.cfg.settings["asr.modelsDir"];
    const files = this.registry().flatMap((m) => m.files.map((f) => ({ m: m.id, f })));
    const total = files.reduce((n, x) => n + x.f.size, 0);
    const pull = this.modelsPull;
    let bytes = 0;
    for (const { m, f } of files) {
      const path = modelFile(dir, m, f.name);
      bytes += existsSync(path) ? f.size : (pull.done.get(`${m}/${f.name}`) ?? 0);
    }
    const base = { dir, bytes: Math.min(bytes, total), total };
    if (this.o.models !== undefined && !this.o.modelRegistry) return { state: "ready", ...base };
    if (pull.running) return { state: "downloading", ...base, file: pull.file };
    if (modelsPresent(dir, this.registry())) return { state: "ready", ...base, bytes: total };
    if (pull.error) return { state: "failed", ...base, error: pull.error };
    return { state: "missing", ...base };
  }

  /**
   * Starts the one download of every missing model file, each checked against its pinned SHA-256
   * (`asr/models.ts`), and answers at once; `models()` reports the progress. When it finishes the
   * recognizer starts on the new files.
   */
  pullModels(): ModelsStatus {
    const now = this.models();
    if (now.state === "ready" || now.state === "downloading") return now;
    const dir = now.dir;
    const pull: ModelsPull = { running: null, done: new Map() };
    this.modelsPull = pull;
    let pushedAt = 0;
    pull.running = downloadModels(
      dir,
      this.registry().map((m) => m.id),
      {
        registry: this.registry(),
        env: (this.o.env ?? process.env) as NodeJS.ProcessEnv,
        onProgress: (p) => {
          pull.file = `${p.model}/${p.name}`;
          pull.done.set(pull.file, p.bytes);
          // The progress rides the status push (DESKTOP DK-E2), at most once a second, so the
          // window's welcome follows it without polling `GET /models`.
          // clock: throttles a progress push to once a second of real time.
          const now = Date.now();
          if (now - pushedAt < 1000) return;
          pushedAt = now;
          for (const fn of this.statusWatchers) fn();
        },
      },
    ).then(
      () => {
        pull.running = null;
        pull.file = undefined;
        this.log("info", `models: every file is in ${dir} and verified`);
        for (const id of pruneRetiredModels(dir)) {
          this.log("info", `models: removed ${id}, which this version no longer uses`);
        }
        this.recognizerOnNewModels();
        for (const fn of this.statusWatchers) fn();
      },
      (err: Error) => {
        pull.running = null;
        pull.file = undefined;
        pull.error =
          err instanceof DownloadRefused
            ? err.message
            : `the model download failed: ${err.message}`;
        this.log("warn", `models: ${pull.error}`);
        for (const fn of this.statusWatchers) fn();
      },
    );
    return this.models();
  }

  templates(): Template[] {
    return listTemplates(this.configDir, {
      onError: (msg) => this.log("warn", `template: ${msg}`),
    });
  }

  presets(): Preset[] {
    return listPresets(this.configDir, {
      onError: (msg) => this.log("warn", `preset: ${msg}`),
    });
  }

  /** A line from the desktop shell, into the same log as the app's own (DK-M8). */
  logLine(level: "info" | "warn" | "error", msg: string): void {
    this.log(level, msg);
  }

  private log(level: "info" | "warn" | "error", msg: string): void {
    this.appLog?.line(level, msg);
    if (this.o.onLog) this.o.onLog(level, msg);
    // With app.log on, a line goes to the terminal only when there is one: launched by the CLI,
    // stderr is `launch.log`, which the CLI rotates only at a launch and must not grow for days.
    else if (!this.appLog || process.stderr.isTTY) console.error(`akou ${level}: ${msg}`);
  }

  /**
   * The model files arrived while the app waited for them: from its own pull, or from the CLI's
   * `akou models pull` or `models import`, which write the same folder behind its back. Runs on every
   * start and status read, so the next recording is transcribed without restarting the app.
   */
  private recognizerOnNewModels(): void {
    if (this.asrAwaitingModels && this.asr === null && !this.quitting) {
      this.startAsr(this.cfg.settings);
    }
  }

  /**
   * Starts the recognizer once the model files are there. A recognizer given on purpose (tests, or
   * none) starts at once, unless a model registry is given too: then it waits for those files, as
   * sherpa waits for the real ones. Until they are there, `asrAwaitingModels` is set, and
   * `recognizerOnNewModels` starts it when they arrive.
   */
  private startAsr(s: Settings): void {
    const waits = this.o.models === undefined || this.o.modelRegistry !== undefined;
    this.asrAwaitingModels = waits && !modelsPresent(s["asr.modelsDir"], this.registry());
    if (this.asrAwaitingModels) {
      this.asrState = {
        state: "unavailable",
        reason: `the speech models are not in ${s["asr.modelsDir"]}; run \`akou models pull\``,
      };
      return;
    }
    const spec: ModelSpec | null = this.o.models !== undefined ? this.o.models : this.sherpaSpec(s);
    if (!spec) {
      this.asrState = { state: "unavailable", reason: "no recognizer configured" };
      return;
    }
    this.asrDiarizer = s["asr.diarizer"] as DiarizerKind;
    this.asrDecoding = s["asr.parakeet.decoding"] as ParakeetDecoding;
    const asr = new LiveAsr(
      {
        models: spec,
        inThread: this.o.asrInThread,
        live: { segmentPause: s["asr.segmentPause"], segmentWindow: s["asr.segmentWindow"] },
        vocab: (callId) => {
          const ws = this.manager.controller(callId)?.view.call?.workspace ?? "";
          return this.vocabCache.get(ws) ?? { entries: [], files: [] };
        },
        liveEngine: (callId) => {
          let ran = this.liveRan.get(callId);
          if (!ran) {
            ran = this.liveChoice(callId);
            this.liveRan.set(callId, ran);
            this.log(
              "info",
              `asr: call ${callId} runs the ${ran.setup} live model${ran.choice ? ` (${ran.choice.engine})` : ""}${ran.review ? `, reviewed by ${ran.review.model} every ${ran.review.everySeconds} s` : ""}${ran.note ? `: ${ran.note}` : ""}`,
            );
            // The status names the live call's setup: the window's pill reads it from the push.
            for (const fn of this.statusWatchers) fn();
          }
          // A live model a call loads counts as used, so the sweep keeps it.
          if (ran.choice) {
            this.shelf?.touch([
              ran.choice.engine,
              ...(ran.review ? reviewModels(ran.review.model, this.liveContext()) : []),
            ]);
          }
          return ran.choice;
        },
        review: (callId) => this.liveReview(callId),
        ...(this.o.liveReviewEveryMs ? { reviewEveryMs: this.o.liveReviewEveryMs } : {}),
        clock: this.clock,
        onLog: (level, msg) => this.log(level, `asr: ${msg}`),
        modelIdleMinutes: () => this.cfg.settings["asr.modelIdleMinutes"],
        // What a dictation needs to start fast is loaded again; the rest waits for its next use.
        onRelease: () => this.warmDictationModels(),
      },
      (id) => this.manager.controller(id) as CallAccess | undefined,
    );
    this.asr = asr;
    this.asrState = { state: "loading" };
    // Dictation's models load first: the Worker runs this right after its start (DC-E7).
    this.warmDictationModels();
    if (this.runMode === "server") this.warmLive(asr);
    asr.ready.then(
      () => {
        this.asrState = { state: "ready" };
        this.appLog?.line("info", "asr: the live recognizer loaded its models");
        // The recognizer loaded its models: they count as used (SV-M4, in the app too).
        if (!this.givenRecognizer()) this.shelf?.touch(this.runningSet().map((m) => m.id));
      },
      (err: Error) => {
        this.asrState = { state: "unavailable", reason: err.message };
        this.appLog?.line("warn", `asr: the live recognizer is unavailable: ${err.message}`);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Events

  private onEvent(id: string, e: LogEvent): void {
    this.asr?.onEvent(id, e);
    // The watchdog learns at once that a call went live or ended, not at the next beat (DK-M8).
    if (LIVE_CHANGES.has(e.type)) this.watchdog?.touch();
    // `app.log` (DK-M8): what happened to which call, by id only.
    const happened = LOGGED_EVENTS[e.type];
    if (happened && this.appLog) this.appLog.line("info", `call ${id}: ${happened}`);
    // A pass that has ended has no figure any more, before anyone reads the status for its end.
    if (e.type === "final.done" || e.type === "final.failed") this.finalRuns.delete(id);
    // A language the recognizer just detected may bring its word list.
    if (e.type === "seg" && e.lang) {
      const c = this.manager.controller(id);
      if (c) this.applyRead(c);
    }
    const deliver = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        this.log("error", `event subscriber failed: ${(err as Error).message}`);
      }
    };
    for (const fn of this.bus.get(id) ?? []) deliver(() => fn(e));
    for (const fn of this.watchers) deliver(() => fn(id, e));
    if (e.type === "seg" && e.layer === "live") queueMicrotask(() => void this.refreshMemo(id));
    if (e.type === "final.done") queueMicrotask(() => void this.reEnhance(id));
    if (e.type === "call.ended") {
      this.levelsByCall.delete(id);
      // The final pass takes the GPU next; a later call Qwen reviews starts it again. A call that
      // started while this one was stopping and has Qwen's review too keeps it.
      const next = this.manager.live();
      const qwen = (call: string) => this.liveRan.get(call)?.review?.model === "qwen";
      const nextKeeps = next && next.id !== id && qwen(next.id);
      if (qwen(id) && !nextKeeps) this.stopLiveQwen();
      // A call on another streaming model let the dictation's go: load it again now, so the next
      // press finds it, and the pill says "loading model" while it loads (DC-E7).
      this.warmDictationModels();
      // After the event is out, so the pass starts from a log that has it.
      queueMicrotask(() => this.finalAtEnd(id));
    }
    if ((HOOK_STAGES as readonly string[]).includes(e.type)) {
      const stage = e.type as HookStage;
      queueMicrotask(() => void this.handoff(id, stage));
    } else if (REEXPORT_ON.has(e.type) || (e.type === "seg" && e.by !== undefined)) {
      this.scheduleReexport(id);
    }
  }

  // -------------------------------------------------------------------------
  // The rolling memo (DESIGN 5.4)

  /**
   * Whether the configured provider writes the memo: `memo.provider` says, and `auto` leaves the
   * harness out (TRAPS "Unattended harness use"), because the memo runs on its own every few
   * minutes and would spend the user's subscription without a request.
   */
  memoByProvider(): boolean {
    const s = this.cfg.settings;
    return memoByProvider(this.o.provider?.id ?? s["provider.kind"], s["memo.provider"]);
  }

  /** A new live line: refresh the memo when it is stale, one run at a time per call. */
  private async refreshMemo(id: string): Promise<void> {
    if (this.quitting || this.memos.has(id) || !this.memoByProvider()) return;
    const now = this.now();
    if ((this.memoRetryAt.get(id) ?? 0) > now) return;
    const c = this.manager.controller(id);
    if (!c?.view.live) return;
    this.memos.add(id);
    try {
      const q = await this.query(id);
      const tz = q.tz;
      const lines = q.view.lines("best");
      const provider = this.provider();
      if (!(await provider.available()).ok) {
        this.memoRetryAt.set(id, now + MEMO_MIN_INTERVAL_MS);
        return;
      }
      const r = await refreshMemo(
        q.view,
        lines,
        now,
        new ProviderMemoUpdater(provider, this.providerTimeoutMs()),
        (l) => renderLine(l, { tz }),
        new AbortController().signal,
      );
      if (!r) return;
      if (!r.ok) {
        this.log("warn", `memo of ${id}: ${r.error}`);
        this.memoRetryAt.set(id, now + MEMO_MIN_INTERVAL_MS);
        return;
      }
      await this.write(id, r.draft);
      this.memoRetryAt.delete(id);
    } catch (err) {
      // Nothing is queued or retried at once: the next line after the interval tries again.
      this.log("warn", `memo of ${id}: ${(err as Error).message}`);
      this.memoRetryAt.set(id, now + MEMO_MIN_INTERVAL_MS);
    } finally {
      this.memos.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Re-enhance after the final layer (DESIGN 5.2)

  /**
   * The final layer landed: notes a provider wrote from the live layer are written again from it,
   * with the same template. Notes written by hand, and the harness, wait for `akou enhance`
   * (`reEnhanceState`). A failure is logged; `akou enhance` can still run it.
   */
  private async reEnhance(id: string): Promise<void> {
    if (this.quitting) return;
    try {
      const q = await this.query(id);
      const provider = this.provider();
      const state = reEnhanceState(q.view, provider.id);
      if (!state.due || !state.auto) return;
      if (!(await provider.available()).ok) return;
      const template = this.templates().find((t) => t.name === state.template);
      if (!template) return;
      await enhanceExclusive(id, async () => {
        // Checked again inside the lock: a request may have written new notes meanwhile.
        if (!reEnhanceState(q.view, provider.id).due) return;
        const r = await enhance({
          q,
          template,
          provider,
          now: this.now(),
          write: (d) => this.write(id, d),
          timeoutMs: this.providerTimeoutMs(),
        });
        const c = await this.call(id);
        const rev = nextEnhancedRev(c.view);
        storeEnhanced(c.dir, rev, template.name, r.markdown);
        await this.write(
          id,
          enhancedDraft({
            rev,
            template: template.name,
            coversSeq: r.coversSeq,
            by: "app",
            model: r.model,
            cites: r.cites,
          }),
        );
      });
    } catch (err) {
      this.log("warn", `re-enhance of ${id}: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------------
  // The hand-off (DESIGN 8.2): export, hooks, webhook

  /** Runs `fn` after the call's earlier hand-off work, never at the same time. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.handoffs.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    this.handoffs.set(id, tail);
    void tail.then(() => {
      if (this.handoffs.get(id) === tail) this.handoffs.delete(id);
    });
    return next;
  }

  /** A finished call whose export is out of date is exported again, once the burst is over. */
  private scheduleReexport(id: string): void {
    const c = this.manager.controller(id);
    if (!c || !this.ended(c) || c.view.handoff().exports.length === 0) return;
    if (this.cfg.settings["export.dir"] === "") return;
    const t = this.reexports.get(id);
    if (t) clearTimeout(t);
    // clock: debounces a re-export after edits, in real time.
    const timer = setTimeout(() => {
      this.reexports.delete(id);
      if (this.quitting || this.finals.has(id)) return;
      void this.serial(id, async () => {
        await this.exportTo(id, this.cfg.settings["export.dir"]);
      }).catch((err) => this.log("warn", `re-export of ${id}: ${(err as Error).message}`));
    }, REEXPORT_DEBOUNCE_MS);
    timer.unref?.();
    this.reexports.set(id, timer);
  }

  private ended(c: CallController): boolean {
    const s = c.view.state;
    return !c.live && (s === "ended" || s === "interrupted");
  }

  /** Exports a call into `root`, recording `export.done` when something was written. */
  private async exportTo(id: string, root: string): Promise<ExportResult> {
    const c = await this.call(id);
    const r = exportCall({
      view: c.view,
      dir: c.dir,
      root,
      audio: this.cfg.settings["export.audio"] as "link" | "copy" | "none",
      version: this.version,
      onWarn: (msg) => this.log("warn", `export ${id}: ${msg}`),
    });
    if (r.draft) await this.write(id, r.draft);
    return r;
  }

  /** `POST /calls/{id}/export`: into `export.dir`, or the folder the caller names. */
  exportCall(id: string, o: { to?: string } = {}): Promise<Outcome<ExportResult>> {
    return this.serial(id, async () => {
      const c = await this.call(id);
      if (!this.ended(c)) {
        return fail(409, "not_ended", "export needs a call that has ended", { call: id });
      }
      const root = o.to ?? this.cfg.settings["export.dir"];
      if (root === "") {
        return fail(
          409,
          "export_not_configured",
          "no export folder: set export.dir (akou config set export.dir DIR) or pass --to DIR",
        );
      }
      return { ok: true, ...(await this.exportTo(id, root)) };
    });
  }

  // -------------------------------------------------------------------------
  // Move, trash and restore (PROGRAMMABILITY PG-A4), each after the call's hand-off work

  async moveCall(
    id: string,
    workspace: string,
    by: string,
  ): Promise<Outcome<{ workspace: string; seq: number | null }>> {
    return this.serial(id, async () => {
      const r = await this.manager.move(id, workspace);
      if (!r.ok) return r;
      const to = this.manager.summary(id)?.workspace ?? workspace;
      if (r.dir === r.from) return { ok: true, workspace: to, seq: null };
      const e = await this.write(id, (c) => ({
        type: "call.moved",
        rev: c.view.workspaceRev + 1,
        workspace: to,
        by,
      }));
      return { ok: true, workspace: to, seq: e.seq };
    });
  }

  async trashCall(id: string): Promise<Outcome<{ dir: string }>> {
    return this.serial(id, async () => {
      if (this.manager.live()?.id === id) {
        return fail(409, "live_call", "the call is recording; stop it first", { call: id });
      }
      // A link to a call that is gone would show nothing: it stops first.
      await this.stopShare(id);
      const t = this.reexports.get(id);
      if (t) clearTimeout(t);
      this.reexports.delete(id);
      const r = await this.manager.trash(id);
      return r.ok ? { ok: true, dir: r.dir } : r;
    });
  }

  restoreCall(id: string): Promise<Outcome<{ dir: string; workspace: string }>> {
    return this.manager.restore(id);
  }

  /** The hooks of one stage, in order, each recorded as `hook.done`. */
  private async runStageHooks(
    id: string,
    stage: HookStage,
    exportMd: string | null,
  ): Promise<HookReport[]> {
    const c = await this.call(id);
    const hooks = hooksFor(this.cfg.settings.hooks, stage, c.view.call?.workspace ?? "");
    if (hooks.length === 0) return [];
    const payload = JSON.stringify(
      buildPayload({ stage, view: c.view, dir: c.dir, version: this.version, exportMd }),
    );
    const out: HookReport[] = [];
    for (const hook of hooks) {
      if (this.quitting) break;
      const run = await runHook({
        hook,
        stage,
        payload,
        callId: id,
        callDir: c.dir,
        env: this.o.env ?? process.env,
        platform: this.o.platform,
      });
      if (run.exit !== 0) {
        this.log(
          "warn",
          `hook ${run.name} (${stage}) of ${id} exited ${run.exit}; see logs/hooks.log`,
        );
      }
      try {
        await this.write(id, hookDoneDraft(run));
      } catch (err) {
        this.log("warn", `hook.done for ${id}: ${(err as Error).message}`);
      }
      out.push({ stage, ...run });
    }
    return out;
  }

  private async sendStageWebhook(id: string, stage: HookStage, exportMd: string | null) {
    const s = this.cfg.settings;
    if (s["webhook.url"] === "" || this.quitting) return;
    const problem = webhookProblem(s["webhook.url"], s["webhook.secret"]);
    if (problem) {
      this.log("warn", `webhook not sent for ${id}: ${problem}`);
      return;
    }
    const c = await this.call(id);
    const body = JSON.stringify(
      buildPayload({ stage, view: c.view, dir: c.dir, version: this.version, exportMd }),
    );
    const r = await sendWebhook({
      url: s["webhook.url"],
      secret: s["webhook.secret"],
      stage,
      body,
      version: this.version,
      fetch: this.o.webhook?.fetch,
      backoffMs: this.o.webhook?.backoffMs,
    });
    if (r.status < 200 || r.status >= 300) {
      this.log(
        "warn",
        `webhook for ${id} (${stage}) failed after ${r.attempts} attempts: ${r.error ?? `HTTP ${r.status}`}`,
      );
    }
    await this.write(id, webhookDoneDraft(s["webhook.url"], r));
  }

  /**
   * One hand-off stage of a finished call: the export (when `export.dir` is set), then the hooks,
   * then the webhook. Runs in the background after the stage's event; never blocks the app, and a
   * failure is logged, never thrown into the event path.
   */
  handoff(id: string, stage: HookStage): Promise<void> {
    return this.serial(id, async () => {
      if (this.quitting) return;
      const c = this.manager.controller(id);
      // `enhanced` on a live call ("enhance so far") waits for the call's end, which exports it.
      if (!c || !this.ended(c)) return;
      let exportMd: string | null = null;
      const root = this.cfg.settings["export.dir"];
      if (root !== "") {
        try {
          exportMd = (await this.exportTo(id, root)).path;
        } catch (err) {
          this.log("warn", `export of ${id}: ${(err as Error).message}`);
        }
      }
      await this.runStageHooks(id, stage, exportMd);
      await this.sendStageWebhook(id, stage, exportMd);
    }).catch((err) => this.log("error", `hand-off of ${id} (${stage}): ${(err as Error).message}`));
  }

  /** `akou hooks run CALL [--stage S]`: the hooks again, without the export or the webhook. */
  runHooks(id: string, stages?: readonly HookStage[]): Promise<Outcome<{ runs: HookReport[] }>> {
    return this.serial(id, async () => {
      const c = await this.call(id);
      if (!this.ended(c)) {
        return fail(409, "not_ended", "hooks run on a call that has ended", { call: id });
      }
      const v = c.view;
      const reached: HookStage[] = [
        "call.ended",
        ...(v.final.state === "done" ? (["final.done"] as const) : []),
        ...(v.latestEnhanced() ? (["enhanced"] as const) : []),
      ];
      const exportMd = v.handoff().exports.at(-1)?.path ?? null;
      const runs: HookReport[] = [];
      for (const stage of stages ?? reached)
        runs.push(...(await this.runStageHooks(id, stage, exportMd)));
      return { ok: true, runs };
    });
  }

  // -------------------------------------------------------------------------
  // Import

  /** `akou import hark-viewer DIR…`: each folder becomes a call under the recordings root. */
  async importHarkViewer(
    dirs: readonly string[],
    o: { workspace?: string } = {},
  ): Promise<{ imported: ImportResult[]; skipped: { source: string; reason: string }[] }> {
    await this.manager.init();
    const imported: ImportResult[] = [];
    const skipped: { source: string; reason: string }[] = [];
    for (const dir of dirs) {
      try {
        const r = importHarkViewer(dir, {
          root: this.cfg.settings["recordings.root"],
          workspace: o.workspace,
          user: this.cfg.settings["user.name"],
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          version: this.version,
          exists: (id) => this.manager.summary(id) !== undefined,
        });
        await this.manager.adopt(r.folder, r.workspace);
        imported.push(r);
      } catch (err) {
        if (!(err instanceof ImportError))
          this.log("warn", `import ${dir}: ${(err as Error).stack}`);
        skipped.push({ source: dir, reason: (err as Error).message });
      }
    }
    return { imported, skipped };
  }

  subscribe(id: string, fn: (e: LogEvent) => void): () => void {
    let set = this.bus.get(id);
    if (!set) {
      set = new Set();
      this.bus.set(id, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.bus.delete(id);
    };
  }

  levels(id: string): Levels | null {
    return this.levelsByCall.get(id) ?? null;
  }

  /** Every event appended to any call, with the call's id. Returns the unsubscribe function. */
  watch(fn: (call: string, e: LogEvent) => void): () => void {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }

  // -------------------------------------------------------------------------
  // Sharing (DESIGN 8.3)

  shares(): ShareStatus[] {
    return this.sharing.status();
  }

  /** `POST /share`: a read-only live link to a call. Starting it again answers the same link. */
  async startShare(
    call: string,
    o: { bind?: string; notes?: boolean; expires?: string; by?: string },
  ): Promise<ShareStatus> {
    if (this.quitting) throw new HttpError(503, "quitting", "akou is quitting");
    const expires = parseExpiry(o.expires);
    if (!expires) {
      throw new HttpError(400, "bad_expires", "expires must be call-end, call-end+2h, 90m or 3h");
    }
    const h = await this.sharing.start(call, {
      include: {
        transcript: true,
        names: true,
        notes: o.notes === true,
        enhanced: false,
        audio: false,
      },
      expires,
      bind: o.bind ?? this.cfg.settings["share.bind"],
    });
    this.announce({ what: "share", by: o.by ?? "user", call: h.call });
    return this.sharing.of(h.call) as ShareStatus;
  }

  /** `DELETE /share`: stops the share of one call, or every share. */
  async stopShare(call?: string): Promise<ShareHandle[]> {
    const stopped: ShareHandle[] = [];
    for (const s of this.sharing.status()) {
      if (call !== undefined && s.call !== call) continue;
      await this.sharing.stop(s);
      stopped.push({ id: s.id, call: s.call, url: s.url, expiresAt: s.expiresAt });
    }
    return stopped;
  }

  /** Called when the status changes without a log event. Returns the unsubscribe function. */
  onStatusChange(fn: () => void): () => void {
    this.statusWatchers.add(fn);
    return () => {
      this.statusWatchers.delete(fn);
    };
  }

  /** Every start (refused ones too) and every share started, from any door. */
  onAnnounce(fn: (a: Announcement) => void): () => void {
    this.announceWatchers.add(fn);
    return () => {
      this.announceWatchers.delete(fn);
    };
  }

  private announce(a: Announcement): void {
    for (const fn of this.announceWatchers) {
      try {
        fn(a);
      } catch (err) {
        this.log("warn", `announce: ${(err as Error).message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The window

  /**
   * `POST /window`, `akou open [CALL]`: brings the window forward on a call, opening it if the app
   * started headless under the desktop shell. An app with no window at all (the CLI's headless
   * launch, the Linux tarball) answers with the address of the window in a browser instead: the
   * page server, started the first time, with a one-time code in the fragment.
   */
  async openWindow(call?: string): Promise<{ shown: true } | { url: string }> {
    if (this.quitting) throw new HttpError(503, "quitting", "akou is quitting");
    if (call !== undefined) await this.call(call);
    // A headless start (the login item) has the window factory but opened no window: open it now.
    if (!this.window && this.o.window) this.window = await this.o.window(this);
    if (this.window) {
      await this.window.show(call);
      return { shown: true };
    }
    const page = await this.pageServer();
    return { url: page.openUrl(call) };
  }

  private pageServer(): Promise<PageServer> {
    this.pageStarting ??= buildUi().then((bundle) => {
      const s = this.cfg.settings;
      this.page = new PageServer({
        // Server mode serves the page on the API's own listener, behind the proxy (SV-U1).
        mounted:
          this.runMode === "server" && this.server
            ? {
                origin: `http://127.0.0.1:${this.server.port}`,
                hostAllowed: (host) =>
                  serverHostAllowed(host, this.server?.port ?? 0, {
                    publicHost: s["server.public_host"],
                    behindProxy: s["server.behind_proxy"],
                  }),
                originAllowed: (origin) => {
                  if (s["server.public_host"] === "") return false;
                  try {
                    return serverHostAllowed(new URL(origin).host, this.server?.port ?? 0, {
                      publicHost: s["server.public_host"],
                      behindProxy: false,
                    });
                  } catch {
                    return false;
                  }
                },
                login: (c) => this.adminLogin(c),
              }
            : undefined,
        bridge: new Bridge(this, (err) =>
          this.log("error", `window request: ${(err as Error).stack ?? err}`),
        ),
        bundle,
        now: () => this.clock.now(),
        openSettings: (pane) => this.openSettingsPane(pane),
        onError: (err) => this.log("error", `page server: ${(err as Error).stack ?? err}`),
      });
      return this.page;
    });
    this.pageStarting.catch(() => {
      this.pageStarting = null;
    });
    return this.pageStarting;
  }

  /** The permission banner's button: the privacy pane that holds akou's grant. */
  async openSettingsPane(pane: SettingsPane): Promise<boolean> {
    const platform = this.o.platform ?? process.platform;
    if (pane === "config") return this.openConfigFile(platform);
    const url =
      platform === "darwin"
        ? `x-apple.systempreferences:com.apple.preference.security?${MAC_PANES[pane]}`
        : platform === "win32" && pane === "microphone"
          ? "ms-settings:privacy-microphone"
          : null;
    if (!url) return false;
    if (this.o.openExternal) return this.o.openExternal(url);
    const cmd = platform === "darwin" ? ["open", url] : ["cmd", "/c", "start", "", url];
    try {
      const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
      return (await p.exited) === 0;
    } catch {
      return false;
    }
  }

  /**
   * The Settings page's "Open config file": the file in the system's text editor, written first
   * when it does not exist yet, so the editor opens it rather than failing.
   */
  private async openConfigFile(platform: string): Promise<boolean> {
    const file = this.cfg.paths.configFile;
    if (!existsSync(file)) writePrivate(file, "{}\n");
    if (this.o.openExternal) return this.o.openExternal(file);
    const cmd =
      platform === "darwin"
        ? ["open", "-t", file]
        : platform === "win32"
          ? ["notepad.exe", file]
          : ["xdg-open", file];
    try {
      const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
      // Notepad stays open until it is closed: its start is the answer.
      if (platform === "win32") return true;
      return (await p.exited) === 0;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // ApiApp

  now(): number {
    return this.clock.now();
  }

  config(): LoadedConfig {
    return this.cfg;
  }

  /** The save running now: the next one starts after it, so none writes a copy made before it. */
  private saving: Promise<unknown> = Promise.resolve();

  async saveConfig(
    file: ConfigFile | ((current: ConfigFile) => ConfigFile),
    o: { keep?: readonly SettingKey[] } = {},
  ): Promise<LoadedConfig> {
    // A save may wait on the Keychain. The next one starts after it and, given as a change,
    // is made from the file as that save left it, so neither writes over the other.
    const run = this.saving.then(
      () => this.saveConfigNow(file, o),
      () => this.saveConfigNow(file, o),
    );
    this.saving = run.catch(() => {});
    return run;
  }

  private async saveConfigNow(
    change: ConfigFile | ((current: ConfigFile) => ConfigFile),
    o: { keep?: readonly SettingKey[] },
  ): Promise<LoadedConfig> {
    const file = typeof change === "function" ? change(this.cfg.file) : change;
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    const env = this.o.env ?? process.env;
    // The keys the API cannot write are the file's: what is on disk now wins over this process's
    // copy, so a save never drops a value written since the start (`akou admin set-password`).
    // `keep` names the window-only keys the desktop window set in this request.
    const onDisk = loadConfig(env, this.o.platform).file;
    const next: Partial<Record<SettingKey, SettingValue>> = { ...file };
    for (const k of SETTING_KEYS) {
      if ((SETTINGS[k] as SettingSpec).apiWritable !== false || o.keep?.includes(k)) continue;
      if (onDisk[k] === undefined) delete next[k];
      else next[k] = onDisk[k];
    }
    // A changed dictation key applies at once, and one the helper cannot bind is refused here,
    // before anything is written, so the old key stays in the file and in the helper (DC-A7).
    const before = this.cfg.settings;
    const target = buildSettings(this.cfg.paths, next, env).settings;
    const keys = this.dictationBindings(target);
    const rebound =
      before["dictation.enabled"] &&
      target["dictation.enabled"] &&
      JSON.stringify(keys) !== JSON.stringify(this.dictationBindings(before)) &&
      this.dictationSvc?.session()?.ready != null;
    if (rebound) {
      const answer = await withDeadline(
        realClock,
        (this.dictationSvc as DictationService).rebind(keys),
        REBIND_ANSWER_MS,
      );
      if (!answer.ok) this.log("warn", "the dictation helper did not answer a rebind in time");
      else if (!answer.value.ok) {
        const error = `dictation.hotkey: the dictation helper cannot bind ${keys.hotkey}: ${answer.value.reason}`;
        throw new HttpError(400, "bad_setting", error, { errors: [error] });
      }
    }
    await this.storeSecrets(next);
    writePrivate(this.cfg.paths.configFile, `${JSON.stringify(next, null, 2)}\n`);
    this.cfg = this.withSecrets(loadConfig(env, this.o.platform));
    const after = this.cfg.settings;
    const same = (k: "vocab.extraFiles" | "vocab.languages") =>
      before[k].join("\n") === after[k].join("\n");
    // Other files or other word lists: every open call reads its vocabulary again.
    if (!same("vocab.extraFiles") || !same("vocab.languages")) this.vocabChanged();
    // Keys changed while the helper is still starting need nothing: it is bound from the
    // settings once it reports `ready`.
    // Overflow on: a job waiting for a busy remote may run here now, not at the next job event.
    if (before["server.remotes_overflow"] !== after["server.remotes_overflow"])
      this.jobService?.reroute();
    if (before["dictation.enabled"] !== after["dictation.enabled"]) this.applyDictation();
    else if (after["dictation.enabled"] && WARM_KEYS.some((k) => !sameValue(before[k], after[k])))
      this.warmDictation();
    if (
      before["dictation.mic"] !== after["dictation.mic"] ||
      before["dictation.preferBuiltInOverBluetooth"] !==
        after["dictation.preferBuiltInOverBluetooth"]
    )
      this.dictationSvc?.rebuildMic();
    if (before["dictation.muteMedia"] !== after["dictation.muteMedia"])
      this.dictationSvc?.pauseMedia();
    // Fewer days, or the audio no longer kept: what is past it goes now, not at the next sweep.
    if (
      before["dictation.retainDays"] !== after["dictation.retainDays"] ||
      before["dictation.keepAudio"] !== after["dictation.keepAudio"]
    )
      this.dictationSvc?.sweep();
    return this.cfg;
  }

  takesWords(id: string): boolean {
    const beam = this.runningDecoding() === "beam";
    if (this.manager.live()?.id !== id) return beam;
    const ran = this.liveRan.get(id);
    return (
      ran?.review?.model === "qwen" ||
      (beam && (ran?.setup === "parakeet" || ran?.review?.model === "parakeet"))
    );
  }

  /** `GET /devices`, `GET /apps`: the device query of the helper `capture.helper` names (PG-A8). */
  devices(): Promise<CaptureDevices> {
    return queryDevices(locateHelper(this.cfg.settings["capture.helper"]).command);
  }

  /** What the API key is saved in: the Keychain, or null for the config file. */
  secretStore(): "keychain" | null {
    // A key the store refused at start is still in the file, and the page must not say otherwise.
    if (this.secretsInFile.size > 0) return null;
    return this.secrets?.where ?? null;
  }

  /**
   * At start: the store's keys are read. A key still in `config.json` stays in use from there
   * until `moveSecrets` has it in the store. In server mode, which keeps keys in the file, a key
   * the app moved into the Keychain before is still read from there while the file has none, so
   * turning server mode on does not lose it. A store that cannot be read leaves no key.
   */
  private readSecrets(cfg: LoadedConfig, store: SecretStore | null): LoadedConfig {
    if (!store) return cfg;
    for (const k of STORED_SECRETS) {
      const inFile = cfg.file[k];
      if (typeof inFile === "string" && inFile !== "") {
        if (this.secrets) {
          this.secretValues.set(k, inFile);
          this.secretsInFile.add(k);
        }
        continue;
      }
      try {
        const v = store.get(k);
        if (!v) continue;
        this.secretValues.set(k, v);
        if (!this.secrets)
          this.log(
            "warn",
            `${k} is read from the Keychain; server mode keeps it in the config file, so set it there`,
          );
      } catch (err) {
        this.log("warn", `${k}: ${(err as Error).message}; the assistant has no key for now`);
      }
    }
    return this.withSecrets(cfg);
  }

  /**
   * At start, after `readSecrets`: a key still in `config.json` moves into the store and leaves
   * the file. A store that refuses leaves it in the file, where it still works, and says so.
   */
  async moveSecrets(): Promise<void> {
    const store = this.secrets;
    if (!store) return;
    const moved: StoredSecret[] = [];
    for (const k of this.secretsInFile) {
      try {
        await store.set(k, this.secretValues.get(k) ?? "");
        moved.push(k);
      } catch (err) {
        this.log("warn", `${k} stays in the config file: ${(err as Error).message}`);
      }
    }
    if (moved.length === 0) return;
    // The file as it is on disk, keys the registry refused included: only the moved keys go.
    const file = this.cfg.paths.configFile;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const k of moved) delete raw[k];
      writePrivate(file, `${JSON.stringify(raw, null, 2)}\n`);
    } catch (err) {
      // The key is in both places and still works; the next save of it tries again.
      this.log("warn", `${moved.join(", ")} stays in the config file: ${(err as Error).message}`);
      return;
    }
    for (const k of moved) this.secretsInFile.delete(k);
    this.log("info", `moved ${moved.join(", ")} from the config file into the Keychain`);
  }

  /** The settings with the stored keys in them, as if the file held them. */
  private withSecrets(cfg: LoadedConfig): LoadedConfig {
    if (!this.secrets) {
      // Server mode: a key read from the Keychain answers only while the file has none.
      if (this.secretValues.size === 0) return cfg;
      const settings = { ...cfg.settings } as Record<string, SettingValue>;
      for (const [k, v] of this.secretValues) if (!cfg.file[k]) settings[k] = v;
      return { ...cfg, settings: settings as Settings };
    }
    const settings = { ...cfg.settings } as Record<string, SettingValue>;
    const file = { ...cfg.file };
    for (const k of STORED_SECRETS) {
      const v = this.secretValues.get(k) ?? "";
      settings[k] = v;
      if (v) file[k] = v;
      else delete file[k];
    }
    return { ...cfg, settings: settings as Settings, file };
  }

  /**
   * A save: each stored key leaves what goes to `config.json`, and a changed one is written to the
   * store (or removed from it) first. A store that refuses refuses the whole save, so the file
   * never takes the key instead. A key the store refused at start stays in the file until then.
   */
  private async storeSecrets(next: Partial<Record<SettingKey, SettingValue>>): Promise<void> {
    const store = this.secrets;
    if (!store) {
      // Server mode: a save that changes the key in the file ends the one read from the Keychain.
      for (const k of STORED_SECRETS) if (next[k] !== this.cfg.file[k]) this.secretValues.delete(k);
      return;
    }
    for (const k of STORED_SECRETS) {
      const v = typeof next[k] === "string" ? (next[k] as string) : "";
      if (v === (this.secretValues.get(k) ?? "")) {
        if (!this.secretsInFile.has(k)) delete next[k];
        continue;
      }
      try {
        if (v) await store.set(k, v);
        else await store.remove(k);
      } catch (err) {
        const error = `${k}: ${(err as Error).message}`;
        throw new HttpError(500, "keychain", error, { errors: [error] });
      }
      delete next[k];
      this.secretsInFile.delete(k);
      if (v) this.secretValues.set(k, v);
      else this.secretValues.delete(k);
    }
  }

  vocabChanged(): void {
    this.dictationVocab = null;
    this.vocabCache.clear();
    this.vocabFailed.clear();
    // A read already in flight may hold the old files; the next reader starts a fresh one.
    this.vocabLoading.clear();
    this.vocabGen++;
    // Every open call reads the new vocabulary, the live one included (its decode list too).
    for (const c of this.manager.opened()) void this.readyRead(c);
  }

  /**
   * Sets a call's read-time vocabulary (DESIGN 5.4) from what is loaded: the vocabulary files of
   * its workspace and the word lists of its languages. Without the files loaded yet, the view keeps
   * the entries it has.
   */
  private applyRead(c: CallController): void {
    const vocab = this.vocabCache.get(c.view.call?.workspace ?? "default");
    let vocabFiles = c.view.options.vocabFiles;
    if (vocab) {
      vocabFiles = this.foldEntries.get(vocab);
      if (!vocabFiles) {
        vocabFiles = toFoldEntries(vocab.entries);
        this.foldEntries.set(vocab, vocabFiles);
      }
    }
    const langs = callLanguages(this.cfg.settings["vocab.languages"], c.view.languages());
    c.view.setReadOptions({ vocabFiles, isDictionaryWord: this.dictionaries.predicate(langs) });
  }

  /** Loads the call's vocabulary files if needed, then sets its read-time vocabulary. */
  private async readyRead(c: CallController): Promise<void> {
    await this.loadVocab(c.view.call?.workspace ?? "default");
    this.applyRead(c);
  }

  private loadVocab(workspace: string): Promise<void> {
    if (this.vocabCache.has(workspace) || this.vocabFailed.has(workspace)) return Promise.resolve();
    let loading = this.vocabLoading.get(workspace);
    if (!loading) {
      loading = this.readVocab(workspace).finally(() => {
        if (this.vocabLoading.get(workspace) === loading) this.vocabLoading.delete(workspace);
      });
      this.vocabLoading.set(workspace, loading);
    }
    return loading;
  }

  private async readVocab(workspace: string): Promise<void> {
    const gen = this.vocabGen;
    try {
      const paths = vocabPaths({
        configDir: this.configDir,
        workspace,
        extra: this.cfg.settings["vocab.extraFiles"],
      });
      const layers = await Promise.all(
        paths.map(async (p) => ({ ...p, loaded: await readVocabFile(p.path) })),
      );
      if (gen !== this.vocabGen) return;
      this.vocabCache.set(workspace, {
        // A call never reads a `scope: dictation` entry (DC-L6): not in its text, its decode list
        // or its final pass, all of which read this.
        entries: callEntries(
          mergeVocab(layers.map((l) => ({ scope: l.scope, path: l.path, file: l.loaded.file }))),
        ),
        files: layers
          .filter((l) => l.loaded.exists)
          .map((l) => ({ path: l.path, sha256: l.loaded.sha256 })),
      });
    } catch (err) {
      if (gen !== this.vocabGen) return;
      this.vocabFailed.add(workspace);
      this.log("warn", `vocabulary for ${workspace}: ${(err as Error).message}`);
    }
  }

  async start(req: StartRequest): Promise<Outcome<StartAnswer>> {
    const r = await this.startCall(req);
    // An attach started nothing: no "started" and no "refused" banner for it.
    if (r.ok && r.attached) return r;
    const by = req.by ?? "user";
    this.announce(
      r.ok
        ? { what: "start", by, ok: true, call: r.call }
        : { what: "start", by, ok: false, code: r.code },
    );
    return r;
  }

  private async startCall(req: StartRequest): Promise<Outcome<StartAnswer>> {
    if (this.quitting) return fail(503, "quitting", "akou is quitting");
    // An attach to the live call starts nothing, so the start checks below do not apply to it.
    if (req.attach) {
      const attached = await this.manager.attachLive();
      if (attached) return attached;
    }
    this.recognizerOnNewModels();
    // Without the speech models a call records audio that nothing transcribes: only when asked.
    const ready =
      (this.o.models !== undefined && !this.o.modelRegistry) || this.runningModelsPresent();
    if (!req.withoutModels && !ready) {
      return fail(
        503,
        "models_missing",
        "the speech models are not downloaded yet: run `akou models pull` (or download them from the akou window), or start with --without-models to record audio only",
      );
    }
    const ws = req.workspace ?? "default";
    // A start reads the files again when they could not be read before.
    this.vocabFailed.delete(ws);
    await this.loadVocab(ws);
    // The call's own live setup rides on its controller (`liveAsked`), never a shared slot: a
    // concurrent start that is refused cannot touch the call that is starting.
    // The watchdog counts the start as a recording before the helper is spawned (DK-M8).
    this.starting++;
    this.watchdog?.touch();
    try {
      return await this.manager.start(req);
    } finally {
      this.starting--;
      this.watchdog?.touch();
    }
  }

  async call(id: string): Promise<CallController> {
    const c = await this.manager.open(id);
    if (!c) throw new HttpError(404, "not_found", `no call ${id}`, { call: id });
    await this.readyRead(c);
    return c;
  }

  async query(id: string): Promise<CallQuery> {
    const c = await this.call(id);
    let q = this.queries.get(c.view);
    if (!q) {
      q = new CallQuery(c.view);
      this.queries.set(c.view, q);
    }
    return q;
  }

  async write(
    id: string,
    draft: EventDraft | ((c: CallController) => EventDraft),
  ): Promise<LogEvent> {
    const c = await this.call(id);
    let release: () => void;
    try {
      release = c.holdWriter();
    } catch (err) {
      if (err instanceof LockError) throw new HttpError(409, "locked", err.message);
      throw err;
    }
    try {
      const e = c.record(typeof draft === "function" ? draft(c) : draft);
      if (!e) throw new HttpError(409, "log_closed", `the log of call ${id} is closed`);
      return e;
    } catch (err) {
      if (err instanceof LogWriteError) throw new HttpError(400, "refused", err.message);
      throw err;
    } finally {
      release();
    }
  }

  async events(id: string, after: number): Promise<LogEvent[]> {
    const c = await this.call(id);
    const { events } = await readLog(join(c.dir, EVENTS_FILE));
    return eventsAfter(events, after);
  }

  async status(): Promise<Record<string, unknown>> {
    this.recognizerOnNewModels();
    const live = this.manager.live();
    const last = this.manager.calls()[0];
    const s = this.cfg.settings;
    return {
      app: {
        version: this.version,
        // The host's OS: a page in another machine's browser must not read its own (DK-K4).
        platform: process.platform,
        pid: process.pid,
        port: this.server?.port ?? null,
        headless: this.headless,
        // The global hotkey that starts and stops a call, which the window shows beside Record:
        // the one the desktop shell registered, null with no shell or when another app holds it.
        hotkey: this.window?.registeredHotkey?.() ?? null,
        window: this.window ? "open" : this.headless ? "none (headless)" : "not built yet",
        page: this.page ? this.page.origin : null,
        startedAt: this.startedAt,
        uptimeMs: this.clock.now() - this.startedAt,
        quitting: this.quitting !== null,
        configDir: this.configDir,
        recordingsRoot: s["recordings.root"],
      },
      live: live
        ? {
            call: live.id,
            title: live.view.call?.title ?? "",
            workspace: live.view.call?.workspace ?? "",
            state: live.view.state,
            status: live.status,
            muted: live.muted,
            parts: live.view.parts().length,
            health: live.view.health().map((h) => ({ ch: h.ch, state: h.state, detail: h.detail })),
            lag: live.view.asrLag?.seconds ?? 0,
            // The live model, streaming engine and second pass this call runs; null before audio
            // reaches the recognizer.
            setup: this.liveRan.get(live.id)?.setup ?? null,
            engine: this.liveRan.get(live.id)?.choice?.engine ?? null,
            review: this.liveRan.get(live.id)?.review ?? null,
            // Their names, as the Record row's button and the call header say them.
            ...liveNames(this.liveRan.get(live.id)),
            levels: this.levels(live.id),
          }
        : null,
      last: last
        ? {
            call: last.id,
            title: last.title,
            state: last.state,
            endedAt: last.endedAt,
            final: await this.finalStatus(last.id),
          }
        : null,
      // Every final pass running now, the last call's or an older one's, with how far it is.
      finals: [...this.finalRuns.keys()].map((call) => ({ call, ...this.finalProgress(call) })),
      asr: {
        ...this.asrState,
        loads: this.asr?.loads ?? {},
        diarizer: this.runningDiarizer(),
        decoding: this.runningDecoding(),
      },
      models: this.models(),
      // The helper this app spawns, resolved from inside the bundle: `akou doctor` from the
      // standalone CLI, which has no helper beside it, reads its answer here.
      helper: findHelper(s["capture.helper"]),
      diarizeHelper: findHelper(s["asr.diarizeHelper"], undefined, { name: DIARIZE_HELPER_NAME }),
      provider: await this.providerStatus(),
      harnesses: this.discovery,
      share: { active: this.sharing.status().length > 0, shares: this.sharing.status() },
      config: { file: this.cfg.paths.configFile, issues: this.cfg.issues },
    };
  }

  // -------------------------------------------------------------------------
  // The final pass

  async finalize(
    id: string,
    opts: { force?: boolean; model?: string },
  ): Promise<Outcome<{ call: string; started: boolean; model?: string }>> {
    const c = await this.call(id);
    if (c.live || c.status === "stopping") {
      return fail(409, "not_ended", "the call is still recording", { call: id });
    }
    // A pass whose end is in the log is only settling (its Worker and llama-server stopping):
    // waited for, so `akou wait --for final.done` then `akou finalize --force` is never refused.
    const settling = this.finals.get(id);
    if (settling && c.view.final.state !== "running") await settling;
    if (this.finals.has(id))
      return fail(409, "final_running", "the final pass is running", { call: id });
    if (finalCurrent(c.view) && !opts.force) {
      return fail(409, "already_final", "the final pass already ran; use force to run it again", {
        call: id,
      });
    }
    const r = this.runFinal(id, true, opts.model);
    if (r) return fail(501, "final_unavailable", r.why, { call: id });
    const model = this.finalRuns.get(id)?.model;
    return { ok: true, call: id, started: true, ...(model ? { model } : {}) };
  }

  /**
   * The recognizer the next final pass runs: `asked` (`akou finalize --model`) or
   * `asr.final.model`, never one whose files are missing.
   */
  /** `GET /models`'s `final`: the setting, the model it names, and what the next pass runs. */
  finalModel(): { setting: string; named: string | null; next: string | null } | null {
    if (this.runMode === "server") return null;
    const setting = this.cfg.settings["asr.final.model"];
    const named = finalModelOf(setting);
    const fused = setting === FINAL_FUSION ? this.finalFusion() : null;
    return {
      setting,
      named: named ? finalModelId(named) : null,
      next:
        fused && fused.ids.length > 0
          ? fused.ids.length === 1
            ? (fused.ids[0] as string)
            : fusionModelId(fused.fuser, fused.ids)
          : ((m) => (m ? finalModelId(m) : null))(this.finalChoice().model),
    };
  }

  finalChoice(asked?: string): FinalChoice {
    return chooseFinalModel(asked ?? this.cfg.settings["asr.final.model"], this.finalContext());
  }

  /** What decides the final pass's models here. */
  private finalContext(): LiveSetupContext {
    const ctx = this.liveContext();
    // A recognizer given on purpose (tests) stands for Parakeet: here with no test catalog, else
    // when the catalog's recognizer set is on disk, whatever that recognizer is called.
    const given =
      this.o.models !== undefined
        ? this.givenRecognizer() || this.finalModelsPresent(false)
        : ctx.present(RECOGNIZER);
    return { ...ctx, present: (id) => (id === RECOGNIZER ? given : ctx.present(id)) };
  }

  /**
   * A fusion pass here (`asr.final.model` `fusion`): the `fusion` preset's fuser and engines
   * (`asr.final.engines`, `asr.fusion`), the ones downloaded in the list's order, and the rest.
   */
  private finalFusion(): {
    fuser: string;
    ids: string[];
    dropped: { engine: string; reason: string; units: null }[];
  } {
    const f = fusionChoice(this.cfg.settings);
    // A recognizer given on purpose (tests) with no catalog: every engine is the test's own.
    if (this.givenRecognizer()) return { fuser: f.fuser, ids: [...f.engines], dropped: [] };
    return { fuser: f.fuser, ...fusionEnginesHere(f.engines, this.finalContext()) };
  }

  /**
   * A call's final pass for `GET /status`: its state, recognizer, how far it is while it runs,
   * and when it ended. From the open call's view, else from its log, read again only when the log
   * grew.
   */
  private async finalStatus(id: string): Promise<FinalStatus | null> {
    let f = this.manager.controller(id)?.view.final;
    if (!f) {
      const dir = this.manager.summary(id)?.dir;
      if (!dir) return null;
      const file = join(dir, EVENTS_FILE);
      const size = existsSync(file) ? statSync(file).size : 0;
      const cached = this.finalSeen.get(id);
      if (cached?.size === size) f = cached.final;
      else {
        f = fold((await readLog(file)).events).final;
        this.finalSeen.set(id, { size, final: f });
      }
    }
    const run = f.state === "running" ? this.finalProgress(id) : null;
    const end = f.state === "done" ? f.done : f.state === "failed" ? f.failed : undefined;
    return {
      state: f.state,
      model: run?.model ?? f.model ?? null,
      done_s: run?.done_s ?? null,
      total_s: run?.total_s ?? null,
      step: run?.step ?? null,
      waiting: run?.waiting ?? null,
      endedAt: end?.t ?? null,
      skipped: f.state === "done" ? (f.done?.skipped.length ?? 0) : 0,
      warning: f.state === "done" ? (f.done?.warning ?? null) : null,
      error: f.state === "failed" ? (f.failed?.error ?? null) : null,
    };
  }

  /** The final state of calls not open, by the size of the log it was read from. */
  private readonly finalSeen = new Map<string, { size: number; final: CallView["final"] }>();

  /** How far a running final pass is, or null when none runs for the call. */
  finalProgress(id: string): FinalProgress | null {
    const r = this.finalRuns.get(id);
    return r
      ? {
          done_s: round1(r.done_s),
          total_s: round1(r.total_s),
          model: r.model,
          step: r.step,
          waiting: r.waiting,
        }
      : null;
  }

  /**
   * The final pass at a call's end. A pass that cannot run there (no readable audio, no models) is
   * recorded as `final.failed {step: unavailable}`, so `akou wait`, the window and the API say why
   * instead of waiting for a pass that never comes.
   */
  private finalAtEnd(id: string): void {
    const r = this.runFinal(id, false);
    const c = this.manager.controller(id);
    if (!r?.unavailable || !c) return;
    const release = c.holdWriter();
    try {
      c.record({ type: "final.failed", step: "unavailable", error: r.why });
    } finally {
      release();
    }
  }

  /**
   * The models for the final pass, or null when they are not all here. On Qwen the pass needs the
   * VAD and the speaker-label models but not Parakeet, which it never loads.
   */
  private finalModels(qwen = false): ModelSpec | null {
    // A recognizer given on purpose (tests) runs at once, unless a model registry is given too.
    if (this.o.models !== undefined && !this.o.modelRegistry) return this.o.models;
    if (!this.finalModelsPresent(qwen)) return null;
    return this.o.models !== undefined ? this.o.models : this.finalSherpaSpec();
  }

  /**
   * The real engines the final pass runs: the running recognizer's speaker-label engine and
   * decoding, whatever the settings say now. Public so a test can read it without real models.
   */
  finalSherpaSpec(): ModelSpec {
    return this.sherpaSpec(this.cfg.settings, this.runningDiarizer(), this.runningDecoding());
  }

  /** Where the final pass reads a call's audio: the test's choice, or `partsAudio`. */
  private finalAudio(call: { id: string; dir: string; parts: number[] }): FinalAudioSpec | null {
    if (this.o.finalAudio) return this.o.finalAudio(call);
    return partsAudio(call, findHelper(this.cfg.settings["capture.helper"]));
  }

  /**
   * Starts the final pass in the background. Returns null once started, or why it cannot run;
   * `unavailable` when the call lacks what the pass needs (readable audio, the models).
   */
  private runFinal(
    id: string,
    force: boolean,
    asked?: string,
  ): { why: string; unavailable?: true } | null {
    if (this.quitting) return { why: "akou is quitting" };
    if (this.finals.has(id)) return { why: "the final pass is already running" };
    const c = this.manager.controller(id);
    if (!c || c.live) return { why: "the call is not ended" };
    if (!force && finalCurrent(c.view)) return { why: "the final pass already ran" };
    const parts = c.view.parts().map((p) => p.part);
    const audio = this.finalAudio({ id, dir: c.dir, parts });
    if (!audio)
      return {
        why: "the final pass cannot read this call's audio: a part has no audio file, or the capture helper that decodes it is not there",
        unavailable: true,
      };
    // This run's model, else the call's own (`akou start --final`), else the setting.
    const setting = asked ?? c.view.call?.final ?? this.cfg.settings["asr.final.model"];
    const fused = setting === FINAL_FUSION ? this.finalFusion() : null;
    if (fused && fused.ids.length === 0 && asked === FINAL_FUSION)
      return {
        why: `fusion cannot run this pass: ${fused.dropped.map((d) => `${d.engine} is ${d.reason}`).join("; ")}`,
      };
    let models: ModelSpec;
    let qwen: boolean;
    if (fused && fused.ids.length > 0) {
      // The fusion preset's engines that are here, through the pass a fusion job runs.
      for (const d of fused.dropped)
        this.log("info", `final ${id}: ${d.engine} does not run: ${d.reason}`);
      if (!this.finalModels(!fused.ids.includes(RECOGNIZER)))
        return { why: "the speech models are not downloaded", unavailable: true };
      const spec = this.fusionModels(fused.fuser, fused.ids);
      if (!spec?.fusion) return { why: "the speech models are not downloaded", unavailable: true };
      models = { ...spec, fusion: { ...spec.fusion, dropped: fused.dropped } };
      qwen = fused.ids.includes(QWEN_ASR);
    } else {
      // The engine first, so the presence check below is that engine's own. A fusion list with
      // nothing downloaded runs what `auto` runs, and says why.
      const choice = this.finalChoice(fused ? "auto" : setting);
      const named = asked === undefined ? null : finalModelOf(asked);
      const title = (m: string) => (m === "qwen" ? "Qwen" : "Parakeet");
      // A model asked for by name for this run and not here: refused, never the other in its place.
      if (named && choice.model !== named)
        return { why: `${title(named)} cannot run this pass: ${choice.note}` };
      if (!choice.model)
        return { why: `no model can run the final pass: ${choice.note}`, unavailable: true };
      const base = this.finalModels(choice.model === "qwen");
      if (!base) return { why: "the speech models are not downloaded", unavailable: true };
      if (fused)
        this.log(
          "info",
          `final ${id}: no engine of the fusion list is downloaded (${fused.dropped.map((d) => d.engine).join(", ")}), so it runs ${title(choice.model)}`,
        );
      if (choice.note) this.log("info", `final ${id}: runs ${title(choice.model)}: ${choice.note}`);
      qwen = choice.model === "qwen";
      models = qwen ? { ...base, final: this.llamaSpec(QWEN_ASR) } : base;
    }
    const model = models.fusion
      ? models.fusion.engines.length === 1
        ? (models.fusion.engines[0]?.engine as string)
        : fusionModelId(
            models.fusion.fuser,
            models.fusion.engines.map((e) => e.engine),
          )
      : (models.final?.engine ?? modelNameFor(models));
    const ws = c.view.call?.workspace ?? "";
    // One Qwen pass at a time: this one waits for the one ahead of it.
    const ahead = qwen ? this.qwenLine : null;
    this.finalRuns.set(id, {
      model,
      done_s: 0,
      total_s: 0,
      pushedAt: 0,
      step: null,
      waiting: ahead?.call ?? null,
    });
    const p = finalizeCall(c, {
      models,
      audio,
      vocab: this.vocabCache.get(ws),
      inThread: this.o.asrInThread,
      clock: this.clock,
      signal: this.finalStop.signal,
      ...(ahead ? { waitFor: ahead.done } : {}),
      onStarted: () => {
        const r = this.finalRuns.get(id);
        if (r?.waiting) {
          r.waiting = null;
          for (const fn of this.statusWatchers) fn();
        }
      },
      onLog: (level, msg) => this.log(level, `final ${id}: ${msg}`),
      onProgress: (done_s, total_s, step) => this.finalMoved(id, done_s, total_s, step),
    })
      .then((r) => {
        if (!r.ok) this.log("warn", `final pass of ${id} failed: ${r.error}`);
        else this.ranModels(r.model ?? model, r.audio_s ?? 0, r.decode_s ?? 0);
      })
      .catch((err) => this.log("error", `final pass of ${id}: ${(err as Error).message}`))
      .finally(() => {
        this.finals.delete(id);
        this.finalRuns.delete(id);
        if (this.qwenLine?.call === id) this.qwenLine = null;
        for (const fn of this.statusWatchers) fn();
      });
    if (qwen) this.qwenLine = { call: id, done: p };
    this.finals.set(id, p);
    for (const fn of this.statusWatchers) fn();
    return null;
  }

  /**
   * A file job's turn on the one Qwen line (app mode): it waits behind the Qwen pass ahead of it,
   * a call's final pass or another job, and holds the line until it calls the function returned,
   * so a final pass that starts meanwhile waits for it in turn. A second llama-server on Metal
   * would stop the first, which is how a job would end a call's final pass halfway.
   */
  private async qwenTurn(id: string, signal: AbortSignal): Promise<() => void> {
    const ahead = this.qwenLine;
    let ended = () => {};
    const done = new Promise<void>((r) => {
      ended = r;
    });
    this.qwenLine = { call: id, done };
    // The job's place in the line ends only once the pass ahead has ended too: a job cancelled
    // while it waits must not let the pass behind it start beside the one still running.
    const release = () => {
      const finish = () => {
        ended();
        if (this.qwenLine?.done === done) this.qwenLine = null;
      };
      if (ahead) ahead.done.catch(() => {}).then(finish);
      else finish();
    };
    // An aborted job never waits; a job that waited drops its listener, so a signal that is
    // never aborted does not keep one closure per job.
    if (ahead && !signal.aborted) {
      this.log("info", `job ${id}: waits for the Qwen pass on ${ahead.call}`);
      let onAbort = () => {};
      const aborted = new Promise<void>((r) => {
        onAbort = () => r();
        signal.addEventListener("abort", onAbort, { once: true });
      });
      await Promise.race([ahead.done.catch(() => {}), aborted]);
      signal.removeEventListener("abort", onAbort);
    }
    return release;
  }

  /**
   * A running pass moved: kept for `GET /status`, and the status pushed to the window at most
   * every `FINAL_PUSH_MS`, so its note moves without a log event per piece.
   */
  private finalMoved(id: string, done_s: number, total_s: number, step: FinalStep): void {
    const r = this.finalRuns.get(id);
    if (!r) return;
    const stepped = r.step !== step;
    r.done_s = done_s;
    r.total_s = total_s;
    r.step = step;
    const now = this.clock.now();
    // A new step is pushed at once; figures within decoding at most every `FINAL_PUSH_MS`.
    if (!stepped && now - r.pushedAt < FINAL_PUSH_MS) return;
    r.pushedAt = now;
    for (const fn of this.statusWatchers) fn();
  }

  /**
   * A final pass finished here: its models count as used (the sweep's ledger), and the
   * recognizer's speed on this machine is one run more (the Models page, SV-U6): the pass's decode
   * time alone, without the Worker's start, the model loads or the speaker labels.
   */
  private ranModels(model: string, audioS: number, decodeS: number): void {
    const shelf = this.shelf;
    if (!shelf || this.givenRecognizer()) return;
    // A fusion pass: each engine was used, and the pass's time is theirs together, so it measures
    // no one engine's speed.
    const fused = fusionParts(model)?.engines;
    if (fused) {
      const set = this.runningSet()
        .map((m) => m.id)
        .filter((m) => m !== RECOGNIZER || fused.includes(RECOGNIZER));
      const q = fused.includes(QWEN_ASR) ? reviewModels("qwen", this.liveContext()) : [];
      shelf.touch([...new Set([...set, ...fused, ...q])]);
      return;
    }
    // On Qwen, Parakeet was not used (and may not be on disk).
    const qwen = model === QWEN_ASR;
    const set = this.runningSet()
      .map((m) => m.id)
      .filter((m) => !qwen || m !== RECOGNIZER);
    shelf.touch([...set, ...(qwen ? reviewModels("qwen", this.liveContext()) : [])]);
    shelf.recordRun(model === QWEN_ASR ? QWEN_ASR : RECOGNIZER, audioS, decodeS);
  }

  /**
   * Calls that ended while akou was not running and have no final layer yet, one pass at a time:
   * each pass loads its own models, and a backlog run side by side would hold them all at once.
   */
  private async catchUpFinals(): Promise<void> {
    for (const s of this.manager.calls()) {
      if (this.quitting) return;
      if (s.state !== "ended" && s.state !== "interrupted") continue;
      try {
        const { events } = await readLog(join(s.dir, EVENTS_FILE));
        const v = fold(events);
        if (finalCurrent(v)) continue;
        const parts = v.parts().map((p) => p.part);
        if (!this.finalAudio({ id: s.id, dir: s.dir, parts })) continue;
        const c = await this.manager.open(s.id);
        if (c && this.runFinal(s.id, false) === null) await this.finals.get(s.id);
      } catch (err) {
        this.log("warn", `final catch-up for ${s.id}: ${(err as Error).message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Start and quit

  keys(): KeyStore | null {
    return this.keyStore;
  }

  mode(): "app" | "server" {
    return this.runMode;
  }

  jobs(): JobService | null {
    return this.jobService;
  }

  /**
   * The live door (`GET /v1/live`), server mode only: a session's stream is a dictation's stream on
   * the live Worker (`openDictation`), so the streaming model loads once whoever uses it.
   */
  live(): LiveService | null {
    if (this.runMode !== "server") return null;
    this.liveService ??= new LiveService({
      present: (id) => {
        const m = (this.o.modelRegistry ?? MODELS).find((x) => x.id === id);
        return m !== undefined && modelsPresent(this.cfg.settings["asr.modelsDir"], [m]);
      },
      open: (choice, languages, onWords) => {
        const asr = this.asr;
        if (!asr || this.asrState.state === "unavailable") {
          throw new LiveRefused(
            "no_live_engine",
            this.asrState.reason ?? "no recognizer runs here",
          );
        }
        const s = asr.openDictation(choice, languages, onWords);
        // A streaming model a live session uses counts as used, so the sweep keeps it.
        void s.opened.then((c) => this.shelf?.touch([c.engine])).catch(() => {});
        return s;
      },
      // The key store reads keys.json again when it changes: a revoked key is gone from it.
      keyAlive: (who) =>
        who.id === APP_IDENTITY.id || who.scopes.some((sc) => this.keyStore?.has(who.id, sc)),
      log: (level, msg) => this.log(level, msg),
    });
    return this.liveService;
  }

  /**
   * Server mode: the streaming model a `hello` with no language opens is loaded at start, when it
   * is on disk, so the first live session does not wait for it. Only at start: a model the Worker
   * let go of when idle loads again at the next session.
   */
  private warmLive(asr: LiveAsr): void {
    const { choice } = chooseLiveEngine("auto", [], this.liveContext().present);
    if (!choice) return;
    asr
      .warmDictation(choice, false)
      .catch((err: Error) =>
        this.log("warn", `live: ${choice.engine} not loaded ahead: ${err.message}`),
      );
  }

  queueDepth(): number {
    return this.jobService?.depth() ?? 0;
  }

  accelerator(): AcceleratorState | null {
    return this.accel;
  }

  /**
   * Reads the machine once for `asr.accelerator`, then asks the llama-server build which devices
   * it can open, behind the API: until it answers, the choice is reported unverified.
   */
  private detectAccelerator(): AcceleratorState {
    const s = this.cfg.settings;
    const probe = this.o.accelerator?.probe ?? hostProbe(this.o.env ?? process.env);
    const first = detectAccelerator(s["asr.accelerator"] as AcceleratorSetting, probe);
    this.accel = first;
    this.accelProbe = probe;
    this.accelAsked = null;
    this.verifyAccelerator(first);
    return first;
  }

  /**
   * Asks the build for the current choice which devices it can open, once per build: a native
   * install has none until the best preset first unpacks it, so every plan checks again.
   */
  private verifyAccelerator(state: AcceleratorState): void {
    const probe = this.accelProbe;
    if (!probe || state.verified) return;
    const bin = llamaServerBin(probe, this.cfg.settings["asr.modelsDir"], state.active);
    if (bin === null || bin === this.accelAsked) return;
    this.accelAsked = bin;
    void verifyAccelerator(state, bin, this.o.accelerator?.run).then((st) => {
      // A newer detection (the setting changed) owns the state now.
      if (this.quitting || this.accel !== state) return;
      this.accel = st;
      this.log(
        "info",
        `accelerator ${st.active}${st.device ? ` (${st.device})` : ""}${st.verified ? "" : " unverified"}: ${st.reason}`,
      );
    });
  }

  /** The llama-server binary the last check asked, so each build is asked once. */
  private accelAsked: string | null = null;

  /**
   * The engine a file job runs for one recognizer id (SV-S1). The job service has checked its
   * files first. A recognizer given on purpose (tests) runs as given, or, with a test catalog, as
   * the recognizer the job names.
   */
  private jobModels(recognizer: string): ModelSpec | null {
    const fused = fusionParts(recognizer);
    if (fused) return this.fusionModels(fused.fuser, fused.engines);
    const given = this.o.models;
    const llama = this.runsOnLlama(recognizer);
    if (given !== undefined) {
      const spec =
        given?.kind === "module" && this.o.modelRegistry && !llama
          ? { ...given, model: recognizer }
          : given;
      return spec && llama ? { ...spec, final: this.llamaSpec(recognizer) } : spec;
    }
    // Parakeet on sherpa-onnx, or a llama-server engine (Qwen) over the same VAD and speaker models.
    if (llama) return { ...this.finalSherpaSpec(), final: this.llamaSpec(recognizer) };
    if (recognizer !== RECOGNIZER) {
      throw Object.assign(new Error(`${recognizer} has no engine in this version`), {
        code: "unknown_model",
      });
    }
    return this.finalSherpaSpec();
  }

  /**
   * The N-engine pass a fused job runs (ASR-6): the model set for the VAD, the speaker labels and
   * Parakeet, and each engine of the list on its own runtime, with its memory estimate and the
   * budget (`asr.memoryBudgetMb`). A test's module model set stands in for the transcribe-cpp
   * engines (its `createEngine`).
   */
  private fusionModels(fuser: string, ids: readonly string[]): ModelSpec | null {
    const given = this.o.models;
    if (given === null) return null;
    if (!isBuiltFuser(fuser)) {
      throw Object.assign(new Error(`${fuser} is not built in this version; use rover-conf`), {
        code: "unknown_model",
      });
    }
    const base: ModelSpec =
      given === undefined
        ? this.finalSherpaSpec()
        : given.kind === "module" && this.o.modelRegistry
          ? { ...given, model: RECOGNIZER }
          : given;
    const s = this.cfg.settings;
    return fusionSpec(base, fuser, ids, {
      catalog: this.o.modelRegistry ?? MODELS,
      modelsDir: s["asr.modelsDir"],
      languages: s["asr.languages"],
      llama: (id) => this.llamaSpec(id),
      ...(given?.kind === "module" ? { module: { path: given.path, options: given.options } } : {}),
      budgetMb: memoryBudgetMb(s["asr.memoryBudgetMb"], totalmem()),
    });
  }

  /** A recognizer that runs on llama-server (Qwen3-ASR), as the real catalog says. */
  private runsOnLlama(recognizer: string): boolean {
    return MODELS.some((m) => m.id === recognizer && m.runtime === "llama-server");
  }

  /**
   * Qwen's llama-server here (akou-5an.94): an own one, the image's, or the pinned build for what
   * detection chose. A changed `asr.accelerator` is detected again, so it applies to the next job
   * that starts llama-server. A plan that has to fall back (a platform with no build) says so in
   * the accelerator's state, so `GET /v1/server` reports what really runs.
   */
  private llamaPlan(): LlamaPlan {
    const s = this.cfg.settings;
    const accel =
      this.accel && this.accel.setting === s["asr.accelerator"]
        ? this.accel
        : this.detectAccelerator();
    this.verifyAccelerator(accel);
    const plan = llamaPlan({
      setting: s["asr.accelerator"],
      own: s["asr.llamaServer"],
      image: this.accelProbe?.env.AKOU_LLAMA_SERVER,
      detected: accel,
      platform: this.llamaPlatform(),
    });
    if (plan.note && this.accel === accel && !accel.reason.includes(plan.note)) {
      this.accel = {
        ...accel,
        active: plan.accelerator,
        gpu: plan.accelerator === "cpu" ? null : plan.accelerator,
        device: null,
        reason: `${accel.reason}; ${plan.note}`,
      };
      this.log("warn", plan.note);
    }
    return plan;
  }

  /** The platform detection read, which is the machine's own outside tests. */
  private llamaPlatform(): string {
    return this.accelProbe?.platform ?? hostPlatform();
  }

  /** The llama-server engine a job on `engine` runs: `asr.llamaServer`, the image's, or the pinned build. */
  private llamaSpec(engine: string): LlamaEngineSpec {
    const s = this.cfg.settings;
    const dir = s["asr.modelsDir"];
    const { accelerator, command, gpuLayers, build } = this.llamaPlan();
    const platform = this.llamaPlatform();
    return {
      kind: "llama-server",
      engine,
      model: modelFile(dir, engine, QWEN_MODEL_FILE),
      mmproj: modelFile(dir, engine, QWEN_MMPROJ_FILE),
      accelerator,
      languages: s["asr.languages"],
      ...(command
        ? { command, ...(gpuLayers === undefined ? {} : { gpuLayers }) }
        : build
          ? {
              build: {
                dir: join(dir, build.id),
                archives: build.files.map((f) => modelFile(dir, build.id, f.name)),
                platform,
              },
            }
          : {}),
    };
  }

  /**
   * Whether a job on a preset can run now, for `GET /v1/server`: `best` when Qwen, its runtime and
   * the helpers are on disk or may be fetched (`server.auto_download`), `fusion` the same for every
   * engine of its list. Undefined for the others, and outside server mode, where the route's own
   * rule stands.
   */
  presetAvailable(name: string): boolean | undefined {
    const jobs = this.jobService;
    if (!jobs) return undefined;
    if (name === "best") return jobs.obtainable(QWEN_ASR);
    // `fusion`: every engine of its list, what each runs on and the helpers (ASR-6).
    if (name === "fusion") {
      const f = fusionChoice(this.cfg.settings);
      return jobs.obtainable(fusionModelId(f.fuser, f.engines));
    }
    return undefined;
  }

  /** The last `auto` verdict logged, so each change is logged once. */
  private autoLogged = "";

  /**
   * What a job that names no model runs here, and why (SV-R2): `autoChoice` over the models on
   * disk and the GPU `asr.accelerator` found. A recognizer given at start (tests) is `fast`.
   */
  autoChoice(): AutoChoice {
    const v = this.givenRecognizer()
      ? {
          ...hardwareChoice(),
          preset: "fast" as const,
          reason: "akou was started with one recognizer.",
        }
      : this.autoFromDisk();
    const line = `auto runs ${v.preset}: ${v.reason}`;
    if (line !== this.autoLogged) {
      this.autoLogged = line;
      this.log("info", line);
    }
    return v;
  }

  private autoFromDisk(): AutoChoice {
    const c = this.liveContext();
    return autoChoice({
      present: c.present,
      catalog: c.catalog ?? [],
      runtime: c.runtime ?? null,
      ...(c.machine ? { machine: c.machine } : {}),
    });
  }

  /** Each engine `GET /v1/server` lists: where it runs and whether its files are on disk. */
  engines(): { id: string; provider: string; installed: boolean }[] {
    const dir = this.cfg.settings["asr.modelsDir"];
    const onDisk = (m: ModelSpecEntry | undefined) =>
      !!m && m.files.every((f) => existsSync(modelFile(dir, m.id, f.name)));
    const qwen = MODELS.find((m) => m.runtime === "llama-server" && m.serves.includes("final"));
    return [
      { id: RECOGNIZER, provider: "cpu", installed: this.models().state === "ready" },
      ...(qwen
        ? [{ id: qwen.id, provider: this.llamaPlan().provider, installed: onDisk(qwen) }]
        : []),
    ];
  }

  dictation(): DictationService | null {
    return this.dictationSvc;
  }

  /**
   * Dictation's log and engine in app mode, and with `dictation.enabled` the helper's `dictate`
   * process (DC-A1's master switch): off, nothing is started and no key is taken.
   */
  private startDictation(): void {
    if (this.runMode !== "app") return;
    this.cuePlayer ??= new SystemCuePlayer({ onLog: (level, msg) => this.log(level, msg) });
    const cues = new Cues(this.cuePlayer, () => ({
      sounds: this.cfg.settings["dictation.sounds"],
      pill: this.cfg.settings["dictation.pill"],
    }));
    this.dictationSvc ??= new DictationService({
      configDir: this.configDir,
      now: () => this.clock.now(),
      engine: (name) => this.dictationEngine(name),
      verdict: () => this.dictationVerdict().verdict,
      loading: () => this.dictationLoading(),
      stream: (onText) => this.dictationStream(onText),
      liveModel: () => (this.asr ? (this.dictationStreamChoice()?.engine ?? null) : null),
      language: () => {
        const l = this.cfg.settings["dictation.language"];
        return l === "auto" ? undefined : l;
      },
      correct: (raw, language) => this.correctDictation(raw, language),
      speech: (samples) => this.dictationSpeech(samples),
      fillers: () => this.cfg.settings["dictation.fillers"],
      punctuation: () =>
        this.cfg.settings["dictation.spokenPunctuation"] ? loadPunctuation(this.configDir) : null,
      format: (text, mode) =>
        formatPass(
          text,
          {
            format: mode ?? this.cfg.settings["dictation.format"],
            prompt: this.cfg.settings["dictation.formatPrompt"],
            timeoutSeconds: this.cfg.settings["dictation.formatTimeoutSeconds"],
          },
          {
            configDir: this.configDir,
            provider: () => this.provider(),
            onLog: (level, msg) => this.log(level, msg),
          },
        ),
      languages: () =>
        dictationLanguages(
          this.cfg.settings["dictation.languages"],
          this.cfg.settings["asr.languages"],
        ),
      retainDays: () => this.cfg.settings["dictation.retainDays"],
      keepAudio: () => this.cfg.settings["dictation.keepAudio"],
      learns: () => this.cfg.settings["dictation.learn"] !== "off",
      autoStop: () => ({
        silenceSeconds: this.cfg.settings["dictation.silenceStopSeconds"],
        maxMinutes: this.cfg.settings["dictation.maxMinutes"],
      }),
      spokenSend: () => this.cfg.settings["dictation.spokenSend"],
      check: () => this.dictationCheck(),
      insert: () => {
        const c = this.cfg.settings;
        return {
          method: c["dictation.insert"] as InsertMethod,
          sendKey: c["dictation.sendKey"] as SendKey,
          sendAlways: c["dictation.sendAlways"],
          restore: c["dictation.restoreClipboard"],
          // The field is read back after the insert to learn from a fix there (DC-L2), and
          // before it for the spacing (DC-S4); `dictation.readField` gates both reads.
          readField: c["dictation.readField"] && c["dictation.learn"] !== "off",
          smartSpacing: c["dictation.readField"] && c["dictation.smartSpacing"],
          trailingSpace: c["dictation.trailingSpace"],
        };
      },
      apps: () => this.cfg.settings["dictation.apps"],
      draft: {
        platform: process.platform,
        sendKey: () => this.cfg.settings["dictation.sendKey"] as SendKey,
        learnMode: () => this.cfg.settings["dictation.learn"],
        engines: () => this.retryEngines(),
        knownPairs: async () => {
          const entries = await this.dictationEntries();
          return (heard, term) => knowsPair(entries, heard, term);
        },
        commonWords: (language) =>
          this.dictionaries.predicate(
            callLanguages(this.cfg.settings["vocab.languages"], language ? [language] : []),
          ),
        learnEntry: (p) => this.editDictationVocab((f) => learnPair(f, p, this.today())),
        unlearnEntry: (p) => this.editDictationVocab((f) => unlearnPair(f, p)),
      },
      remote: () => {
        const c = this.cfg.settings;
        if (c["dictation.engine"] !== "remote") return null;
        return {
          url: c["dictation.remote.url"],
          fallback: remoteFallback(c["dictation.remote.fallback"], this.fastEngine() !== null),
          health: this.remoteDictation?.health() ?? null,
        };
      },
      probe: () => [
        ...locateHelper(this.cfg.settings["capture.helper"]).command,
        "dictate",
        "--probe",
      ],
      helper: () => locateHelper(this.cfg.settings["capture.helper"]).command,
      cue: (moment) => cues.cue(moment),
      mic: () => ({
        device: this.cfg.settings["dictation.mic"],
        preferBuiltIn: this.cfg.settings["dictation.preferBuiltInOverBluetooth"],
      }),
      pauseMedia: () => this.cfg.settings["dictation.muteMedia"],
      onLog: (level, msg) => this.log(level, msg),
    });
    // Qwen landing while `best` waits for it: it is warmed at once (DC-E3).
    this.shelf?.onEnd((e) => {
      if (e.ok && this.cfg.settings["dictation.enabled"]) this.warmDictation();
    });
    this.applyDictation();
  }

  /**
   * A dictation's text through its vocabulary (DC-L6): the global file and `vocab.extraFiles`, and
   * the word lists of `vocab.languages` plus the language the engine found.
   */
  private async correctDictation(raw: string, language: string | null): Promise<string> {
    const entries = await this.dictationEntries();
    const langs = callLanguages(this.cfg.settings["vocab.languages"], language ? [language] : []);
    return correctDictation(raw, entries, this.dictionaries.predicate(langs));
  }

  /**
   * DC-E6's silence guard: the live Worker's VAD on a dictation's buffer, before any engine sees
   * it. Null with no VAD to ask: no local model (the remote runs its own guard), or one still
   * loading while another engine decodes, which must not wait for it.
   */
  private async dictationSpeech(samples: Float32Array): Promise<boolean | null> {
    const asr = this.asr;
    if (!asr || this.asrState.state === "unavailable") return null;
    if (this.asrState.state === "loading" && this.dictationVerdict().engine !== "fast") return null;
    return asr.speech(samples);
  }

  /**
   * A dictation's Learn or Undo (DC-L4): the global vocabulary file, edited under the same lock
   * as `POST /vocab`, then read again by the next dictation.
   */
  private async editDictationVocab(edit: (f: VocabFile) => VocabFile): Promise<void> {
    await editFile(targetPath(this, undefined), (file) => ({ file: edit(file), result: null }));
    this.vocabChanged();
  }

  private today(): string {
    return new Date(this.clock.now()).toISOString().slice(0, 10);
  }

  /** The engines the draft box can retry a dictation on: those this machine can run now. */
  private retryEngines(): string[] {
    const out: string[] = [];
    if (this.fastEngine()) out.push("fast");
    if (this.bestRuns(this.llamaPlan())) out.push("best");
    if (this.asr && this.dictationStreamChoice()) out.push("live");
    if (this.cfg.settings["dictation.remote.url"].trim() !== "") out.push("remote");
    return out;
  }

  /** Dictation's vocabulary, read once per change; a failed read is tried again next time. */
  private async dictationEntries(): Promise<MergedEntry[]> {
    this.dictationVocab ??= this.readDictationVocab();
    const read = this.dictationVocab;
    try {
      return await read;
    } catch (err) {
      if (this.dictationVocab === read) this.dictationVocab = null;
      throw err;
    }
  }

  private async readDictationVocab(): Promise<MergedEntry[]> {
    const paths = vocabPaths({
      configDir: this.configDir,
      extra: this.cfg.settings["vocab.extraFiles"],
    });
    const layers = await Promise.all(
      paths.map(async (p) => ({ ...p, file: (await readVocabFile(p.path)).file })),
    );
    return mergeVocab(layers);
  }

  /**
   * The live Worker's Parakeet, already loaded at start, or null while no model is there or
   * Parakeet was never downloaded. It picks the language itself, so a forced one is not sent (DC-E4).
   */
  private fastEngine(): DictationEngine | null {
    const asr = this.asr;
    // Parakeet is what `fast` decodes with: a machine that never downloaded it has no `fast`, so
    // nothing offers it, and a live dictation whose stream fails says why instead of falling back.
    if (!asr || (!this.givenRecognizer() && !this.liveContext().present(RECOGNIZER))) return null;
    return { name: "fast", decode: (samples) => asr.decode(samples) };
  }

  /**
   * Which engine `dictation.engine` (or the one named) is on this machine now, and why (DC-E3):
   * `auto` is `best` where Qwen runs on a GPU and is on disk.
   */
  private dictationVerdict(name?: string): EngineVerdict {
    const setting = name ?? this.cfg.settings["dictation.engine"];
    if (setting === "fast" || setting === "remote")
      return resolveDictationEngine({ setting, accelerator: "cpu", bestReady: false });
    const plan = this.llamaPlan();
    const bestReady = this.bestRuns(plan);
    return resolveDictationEngine({
      setting,
      accelerator: plan.accelerator,
      bestReady,
      gpuBusy: bestReady && plan.accelerator === "metal" && this.metalBusy(),
      // Only the setting's own `auto` defers to `dictation.final`; a per-app rule's `auto` too.
      final: this.cfg.settings["dictation.final"],
      liveReady: this.asr !== null && this.dictationStreamChoice() !== null,
    });
  }

  /** The languages a dictation may be in: `dictation.languages`, else `asr.languages`. */
  private dictationLangs(): readonly string[] {
    const s = this.cfg.settings;
    return dictationLanguages(s["dictation.languages"], s["asr.languages"]);
  }

  /**
   * The streaming model a dictation's words come from (DC-E7): the one its languages ask for, the
   * way a call picks under `asr.live.engine` `auto`, and only one on disk; null with none.
   */
  private dictationStreamChoice(): LiveChoice | null {
    return chooseLiveEngine("auto", this.dictationLangs(), this.liveContext().present).choice;
  }

  /** Opens a dictation's stream on the live Worker for `choice` (DC-E7). */
  private openDictationStream(asr: LiveAsr, choice: LiveChoice): OpenStream {
    return (onWords) => {
      const s = asr.openDictation(choice, this.dictationLangs(), onWords);
      // A streaming model a dictation uses counts as used, so the sweep keeps it.
      void s.opened.then((c) => this.shelf?.touch([c.engine])).catch(() => {});
      return s;
    };
  }

  /**
   * A session's stream on the streaming model (DC-E7), or null: no model for its languages on disk,
   * or no recognizer.
   */
  private dictationStream(onText: (text: string) => void): WordStream | null {
    const asr = this.asr;
    const choice = this.dictationStreamChoice();
    if (!asr || !choice || this.asrState.state === "unavailable") return null;
    return new LiveWords(this.openDictationStream(asr, choice), onText, {
      onLog: (msg) => this.log("info", msg),
    });
  }

  /**
   * `live` (DC-E7): the streaming model's words. A dictation whose stream ran inserts its words at
   * the release (the session's hold); this decodes a buffer that had none, by streaming it whole,
   * and falls back to `fast` when the stream fails.
   */
  private liveEngine(): DictationEngine | null {
    const asr = this.asr;
    const choice = this.dictationStreamChoice();
    if (!asr || !choice) return this.fastEngine();
    const open = this.openDictationStream(asr, choice);
    return {
      name: "live",
      decode: async (samples, o) => {
        try {
          return await liveDecode(open, samples);
        } catch (err) {
          const fast = this.fastEngine();
          if (!fast) throw err;
          this.log("warn", `dictation live: ${(err as Error).message}; decoding with fast`);
          return {
            ...(await fast.decode(samples, o)),
            engine: "fast",
            fallback_from: "live",
            notice: LIVE_FAILED,
          };
        }
      },
    };
  }

  /** Whether another Metal llama-server (a final pass) holds the GPU `best` would need. */
  private metalBusy(): boolean {
    const lockDir = this.llamaSpec(QWEN_ASR).build?.dir;
    const except = this.bestDictation?.pid() ?? null;
    return (this.o.metalHolder ?? metalHolder)(lockDir, except) !== null;
  }

  /** Qwen is on disk and a llama-server is there to run it. */
  private bestRuns(plan: LlamaPlan): boolean {
    return (
      (plan.command !== undefined || plan.build !== undefined) &&
      this.qwenMissing(plan).length === 0
    );
  }

  /** Qwen's files and its llama-server build that are not on disk; an own or image build needs none. */
  private qwenMissing(plan: LlamaPlan): string[] {
    const dir = this.cfg.settings["asr.modelsDir"];
    const ids = [QWEN_ASR, ...(plan.command || !plan.build ? [] : [plan.build.id])];
    const entries = [...MODELS, ...(plan.build ? [plan.build] : [])];
    return ids.filter((id) => {
      const m = entries.find((e) => e.id === id);
      return !m || m.files.some((f) => !existsSync(modelFile(dir, id, f.name)));
    });
  }

  /**
   * Whether the engine a press decodes on is loading its model now: the pill then says so at the
   * release, and the press is decoded once it is loaded, never dropped.
   */
  private dictationLoading(): boolean {
    const v = this.dictationVerdict();
    if (v.engine === "best") return this.bestDictation?.loading() ?? false;
    return (
      (v.engine === "fast" || v.engine === "live") &&
      (this.asrState.state === "loading" || this.dictationWarming > 0)
    );
  }

  /**
   * Loads what the next dictation needs on the live Worker (DC-E7): the dictation VAD, the
   * streaming model its words come from, and Parakeet only when the text comes from it (`fast`, or
   * no streaming model), so the first press after launch waits for none of them. Runs when the
   * recognizer starts, ahead of anything else on its Worker, again whenever dictation warms (turned
   * on, a model landed, a language changed), and after the Worker let go of idle models.
   */
  private warmDictationModels(): void {
    const asr = this.asr;
    const s = this.cfg.settings;
    if (!asr || this.quitting || !s["dictation.enabled"] || s["dictation.engine"] === "remote")
      return;
    this.dictationWarming++;
    const choice = this.dictationStreamChoice();
    asr
      .warmDictation(choice, choice === null || this.dictationVerdict().engine === "fast")
      .catch((err: Error) => this.log("warn", `dictation: models not loaded ahead: ${err.message}`))
      .finally(() => {
        this.dictationWarming--;
      });
  }

  /**
   * DC-L3's audio check as it can run now: on the `best` engine dictation keeps warm, once its
   * server is up and loaded. Otherwise null, and a fix is proposed with `evidence: none`: a cold
   * start would hold the chip for a model load, and greedy Parakeet takes no context.
   */
  private dictationCheck():
    | ((samples: Float32Array, glossary: readonly string[], language?: string) => Promise<string>)
    | null {
    const best = this.bestDictation;
    if (!best || this.dictationVerdict().engine !== "best") return null;
    if (best.pid() === null || best.loading()) return null;
    return (samples, glossary, language) => best.check(samples, glossary, language);
  }

  /** The `best` engine, made once; it reads its settings and spec at each dictation. */
  private best(): BestEngine {
    this.bestDictation ??= new BestEngine({
      spec: () => {
        if (!this.bestRuns(this.llamaPlan())) return null;
        // The languages are the dictation's, per request: a changed list needs no new server.
        return { ...this.llamaSpec(QWEN_ASR), languages: undefined };
      },
      fast: () => this.fastEngine(),
      // Warm only while dictation is on: a clip sent over the API with it off stops it after.
      keepWarm: () => this.cfg.settings["dictation.enabled"],
      settings: () => {
        const c = this.cfg.settings;
        return {
          timeoutSeconds: c["dictation.localTimeoutSeconds"],
          idleMinutes: c["asr.qwenIdleMinutes"],
          languages: dictationLanguages(c["dictation.languages"], c["asr.languages"]),
        };
      },
      clock: this.clock,
      // A final pass took the GPU, or the server died: warmed again once it may be.
      onLost: () => this.rewarmBestLater(),
      onLog: (level, msg) => this.log(level, msg),
    });
    return this.bestDictation;
  }

  /**
   * Looks again in `BEST_REWARM_MS` whether `best` may be warmed: a final pass that took the GPU
   * writes its pid file a moment after it stopped dictation's server, and holds it until it ends.
   */
  private rewarmBestLater(): void {
    if (this.bestRewarm !== null || this.quitting) return;
    this.bestRewarm = this.clock.setTimeout(() => {
      this.bestRewarm = null;
      if (this.cfg.settings["dictation.enabled"]) this.warmDictation();
    }, BEST_REWARM_MS);
  }

  /**
   * Keeps `best` warm while dictation is on and resolves to it, and stops it otherwise; `best`
   * asked for with Qwen missing starts the download (DC-E2, DC-E3).
   */
  private warmDictation(): void {
    if (this.quitting) return;
    const v = this.dictationVerdict();
    if (v.download) this.fetchQwen();
    this.warmDictationModels();
    if (v.engine === "best") this.best().warm();
    else void this.bestDictation?.stop();
    // Giving way to a final pass on Metal: warmed once the pass is over.
    if (v.yielding) this.rewarmBestLater();
  }

  /** Starts Qwen's download and its llama-server build's, each refused one logged (DK-E3). */
  private fetchQwen(): void {
    const shelf = this.shelf;
    if (!shelf) return;
    for (const id of this.qwenMissing(this.llamaPlan())) {
      if (shelf.state(id) === "downloading") continue;
      try {
        shelf.pull(id);
      } catch (err) {
        this.log("warn", `dictation best: ${id} not downloaded: ${(err as Error).message}`);
      }
    }
  }

  /**
   * The engine a dictation decodes on, read at each press: `remote` sends the audio to
   * `dictation.remote.url` with the key as it is now, so a changed key or URL needs no restart;
   * `best` decodes on the warm Qwen with `fast` as its exit; `fast` on the loaded Parakeet, and in
   * place of a `best` still downloading, saying so.
   */
  private dictationEngine(name?: string): DictationEngine | null {
    const v = this.dictationVerdict(name);
    if (v.engine === "best") return this.best();
    if (v.engine === "live") return this.liveEngine();
    if (v.engine === "fast") {
      const fast = this.fastEngine();
      if (!fast || v.wanted === null) return fast;
      return {
        name: fast.name,
        decode: async (samples, o) => ({
          ...(await fast.decode(samples, o)),
          engine: fast.name,
          fallback_from: v.wanted as string,
          // `live` with no streaming model says so on the Dictation page, not on every insert.
          ...(v.wanted === "live" ? {} : { notice: v.verdict }),
        }),
      };
    }
    this.remoteDictation ??= new RemoteEngine({
      settings: () => {
        const c = this.cfg.settings;
        const language = c["dictation.language"];
        return {
          url: c["dictation.remote.url"],
          key: c["dictation.remote.key"],
          fallback: c["dictation.remote.fallback"],
          timeoutSeconds: c["dictation.remote.timeoutSeconds"],
          ...(language !== "auto" ? { language } : {}),
          // Learned words go to the recognizer only through DC-L7's measured gate, which is not
          // built, so glossary `on` sends none; DC-L6 applies them as replacements either way.
          glossary: c["dictation.glossary"] === "on" ? [] : null,
        };
      },
      local: () => this.fastEngine(),
      onLog: (level, msg) => this.log(level, msg),
    });
    return this.remoteDictation;
  }

  /**
   * The keys the helper binds, from the settings: each empty one resolved to its platform default,
   * fix last to Shift held before a modifier-only dictation key (DC-A2, DC-A5).
   */
  private dictationBindings(s: Settings): Bindings {
    const platform = this.o.platform ?? process.platform;
    const hotkey = s["dictation.hotkey"].trim() || dictationHotkeyDefault(platform);
    return {
      hotkey,
      draft: s["dictation.hotkeyDraft"].trim(),
      fixLast: s["dictation.hotkeyFixLast"].trim() || fixLastDefault(hotkey),
      pasteLast: s["dictation.hotkeyPasteLast"].trim(),
      activation: s["dictation.activation"] as Activation,
    };
  }

  /** Starts or stops the helper to match `dictation.enabled`, and sends it the keys. */
  private applyDictation(): void {
    const d = this.dictationSvc;
    if (!d || this.quitting) return;
    const s = this.cfg.settings;
    if (!s["dictation.enabled"]) {
      void d.stop();
      void this.bestDictation?.stop();
      return;
    }
    this.warmDictation();
    if (d.session()) {
      void d.rebind();
      return;
    }
    d.start([...locateHelper(s["capture.helper"]).command, "dictate"], () =>
      this.dictationBindings(this.cfg.settings),
    );
  }

  /** The models' store, both modes: what the Models page, `/models` and the sweep work on. */
  private startShelf(): ModelStore {
    const { modelStore, now } = this.o.jobs ?? {};
    const s = () => this.cfg.settings;
    const shelf = new ModelStore({
      dir: () => s()["asr.modelsDir"],
      // What a job loads besides its recognizer: the running engine's helpers, as the final pass.
      machine: () => (this.givenRecognizer() ? null : this.runningSet()),
      // This platform's entries only: a Linux server lists no macOS llama-server build.
      catalog: () =>
        this.o.modelRegistry ??
        MODELS.filter((m) => (m.platforms as readonly string[]).includes(hostPlatform())),
      requires: (id) => {
        if (!this.runsOnLlama(id)) return [];
        const build = this.llamaPlan().build;
        return build ? [build.id] : [];
      },
      autoDownload: () => s()["server.auto_download"],
      maxGb: () => s()["server.models_max_gb"],
      unusedDays: () => s()["server.models_unused_days"],
      now,
      env: (this.o.env ?? process.env) as NodeJS.ProcessEnv,
      ...modelStore,
      log: (level, msg) => this.log(level, msg),
    });
    this.shelf = shelf;
    return shelf;
  }

  /** A recognizer given on purpose (tests) with no test catalog: no model file is needed. */
  private givenRecognizer(): boolean {
    return this.o.models !== undefined && !this.o.modelRegistry;
  }

  /** The models the running recognizer and its final pass load: its speaker-label engine's set. */
  private runningSet(): readonly ModelSpecEntry[] {
    return modelsFor(
      { "asr.diarizer": this.runningDiarizer() },
      hostPlatform(),
      this.o.modelRegistry ?? MODELS,
      this.chosenModels(),
    );
  }

  /**
   * What neither the sweep nor a delete may touch: the job service's (every queued or running
   * job's and the worker's, with the default model's set in a server, and in the app the app's own
   * set in its place: `appHeld`, handed to the service as `ownerHeld`).
   */
  private modelsHeld(): Held {
    return this.jobService?.held() ?? this.appHeld();
  }

  /** The app's own set: what its settings name and what the running recognizer holds. */
  private appHeld(): Held {
    if (this.runMode === "server" || this.givenRecognizer()) {
      return { defaults: new Set(), inUse: new Set() };
    }
    const ctx = this.liveContext();
    const next = chooseLiveSetup(ctx);
    const live = [
      ...setupModels(next.setup, ctx),
      ...(next.review ? reviewModels(next.review.model, ctx) : []),
      // The final pass's Qwen, when the setting runs it or a pass runs it now.
      ...(this.finalChoice().model === "qwen" ||
      [...this.finalRuns.values()].some((r) => r.model === QWEN_ASR)
        ? reviewModels("qwen", ctx)
        : []),
    ];
    return {
      // The chosen second pass's and dictation's models stay too (keptModels).
      defaults: new Set([
        ...this.registry().map((m) => m.id),
        ...live,
        ...keptModels(this.modelSetContext()),
      ]),
      inUse:
        this.asr !== null || this.finals.size > 0 || this.modelsPull.running
          ? new Set(this.runningSet().map((m) => m.id))
          : new Set(),
    };
  }

  /** The setting that makes a model the default here, or null when none chooses it. */
  private defaultSettingOf(m: ModelSpecEntry): { key: string; value: string } | null {
    if (m.id === NEMOTRON) return { key: "asr.diarizer", value: "nemotron" };
    if (m.id === "pyannote-segmentation-3.0") return { key: "asr.diarizer", value: "embeddings" };
    // The app's recognizer is fixed; server mode's jobs run `server.default_model`.
    if (this.runMode === "server" && kindOf(m) === "speech") {
      return { key: "server.default_model", value: m.id };
    }
    return null;
  }

  /** Every catalog model as the Models page shows it (SV-M6, SV-U6), in both modes. */
  modelRows(): ModelView[] {
    const shelf = this.shelf;
    if (!shelf) return [];
    return shelf.list(this.modelsHeld(), (m) => this.defaultSettingOf(m));
  }

  /** Fetches one catalog model on purpose, under the size cap and the free-space check. */
  pullModel(id: string): ModelView {
    const shelf = this.shelf;
    if (!shelf) throw new ModelRefused(409, "not_ready", "akou is still starting");
    shelf.pull(id);
    return this.modelRows().find((m) => m.id === id) as ModelView;
  }

  /** Deletes one model under the sweep's rules: never the default's set or one in use. */
  deleteModel(id: string, by: string): { id: string; deleted: true; bytes: number } {
    const shelf = this.shelf;
    if (!shelf) throw new ModelRefused(409, "not_ready", "akou is still starting");
    return shelf.delete(id, this.modelsHeld(), by);
  }

  /** Stops one model's download; the partial file stays for the next pull. */
  cancelModel(id: string, by: string): boolean {
    return this.shelf?.cancel(id, by) ?? false;
  }

  /** Copies the catalog's model files from a folder on this machine (`POST /models/import`). */
  async importModels(dir: string): Promise<{ copied: string[]; missing: string[] }> {
    const from = resolve(dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir);
    if (!existsSync(from) || !statSync(from).isDirectory()) {
      throw new HttpError(404, "not_found", `no folder ${dir}`, { dir });
    }
    const catalog = this.o.modelRegistry ?? MODELS;
    // Through the store: the Models page shows each model's bytes as it is copied.
    const got = this.shelf
      ? await this.shelf.import(from, catalog)
      : await importModels(from, this.cfg.settings["asr.modelsDir"], catalog);
    for (const fn of this.statusWatchers) fn();
    return got;
  }

  /**
   * Deletes the models unused for `server.models_unused_days` (0: never), in both modes: never
   * the default's set, one in use, or one downloading. Both modes sweep through the job service,
   * which also knows the queue; an app whose job queue could not start sweeps alone, at start and
   * hourly.
   */
  sweepModels(): void {
    const jobs = this.jobService;
    if (jobs) {
      jobs.sweepModels();
      return;
    }
    const held = this.modelsHeld();
    this.shelf?.sweep(new Set([...held.defaults, ...held.inUse]));
  }

  /**
   * The job queue, in `<config>/jobs`, started behind the API in both modes (SV-J1); its hourly
   * sweep deletes old jobs and unused models. The desktop app's queue serves this machine's own
   * user: no key signs a callback, no job goes to a remote, no Worker is reserved for dictation
   * (the app dictates through its own engine), and an idle Worker is closed rather than kept warm,
   * so a file transcribed once does not hold its model in memory afterwards. A queue the app
   * cannot open is logged and left out: recording never depends on it.
   */
  private startJobs(): void {
    const shelf = this.startShelf();
    const keys = this.keyStore;
    const server = this.runMode === "server" && keys !== null;
    const { modelStore: _store, ...jobSeams } = this.o.jobs ?? {};
    const s = () => this.cfg.settings;
    const make = () =>
      new JobService({
        dir: join(this.configDir, "jobs"),
        version: this.version,
        models: (recognizer) => this.jobModels(recognizer),
        shelf,
        defaultModel: () => s()["server.default_model"],
        auto: () => this.autoChoice(),
        fusion: () => fusionChoice(s()),
        diarizer: () => this.runningDiarizer(),
        secrets: (id) => {
          const secret = keys?.secretOf(id);
          return secret ? [secret] : [];
        },
        hostListed: (id, host) =>
          keys?.list().some((k) => k.id === id && k.callback_hosts.includes(host.toLowerCase())) ??
          false,
        retainDays: () => s()["server.retain_days"],
        maxAudioMinutes: () => s()["server.max_audio_minutes"],
        remotes: () => (server ? s()["server.remotes"] : []),
        remotesOverflow: () => (server ? s()["server.remotes_overflow"] : false),
        env: this.o.env ?? process.env,
        concurrency: () => s()["server.concurrency"],
        modelIdleMinutes: () => s()["server.model_idle_minutes"],
        queueMax: () => s()["server.queue_max"],
        queueMaxPerKey: () => s()["server.queue_max_per_key"],
        dictationSlots: () => (server ? s()["server.dictation_slots"] : 0),
        dictationEngine: () => s()["server.dictation_engine"],
        keepIdleWorkers: () => server,
        ...(server ? {} : { ownerHeld: () => this.appHeld() }),
        ...(server
          ? {}
          : { gpuTurn: (id: string, signal: AbortSignal) => this.qwenTurn(id, signal) }),
        ...jobSeams,
        log: (level, msg) => this.log(level, msg),
      });
    if (server) {
      this.jobService = make();
      this.jobService.start();
      return;
    }
    try {
      this.jobService = make();
      this.jobService.start();
    } catch (err) {
      // The model store is shared with the Models page: keep it open for pulls.
      this.jobService?.close({ keepShelf: true });
      this.jobService = null;
      this.log(
        "error",
        `file jobs are off: the job queue did not start: ${(err as Error).message}`,
      );
      this.sweepModels();
      // clock: the hourly sweep of SV-M5, as the job service would run it.
      this.modelSweep = setInterval(() => this.sweepModels(), RETENTION_SWEEP_MS);
      this.modelSweep.unref?.();
    }
  }

  recognizer(): "loading" | "ready" | "unavailable" {
    return this.asrState.state;
  }

  /** `server.admin_password_hash` as the file holds it now, read again only when the file changes. */
  private passwordHash = { stamp: "", hash: "" };

  private currentPasswordHash(): string {
    let stamp = "";
    try {
      const st = statSync(this.cfg.paths.configFile);
      stamp = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
    } catch {}
    if (stamp !== this.passwordHash.stamp || stamp === "") {
      const hash = loadConfig(this.o.env ?? process.env, this.o.platform).settings[
        "server.admin_password_hash"
      ];
      this.passwordHash = { stamp, hash };
    }
    return this.passwordHash.hash;
  }

  /**
   * The web UI's admin login (SV-U1): the password against `server.admin_password_hash`, read
   * from the file so `akou admin set-password` works without a restart, or an `admin` key pasted
   * once. A right one answers the check its session runs on every use: the key still there with
   * `admin`, or the password hash unchanged, so a revoke or a new password ends the session.
   */
  async adminLogin(c: { password?: string; key?: string }): Promise<(() => boolean) | null> {
    const keys = this.keyStore;
    if (c.key !== undefined) {
      const id = keys?.authenticate(c.key);
      if (!keys || !id?.scopes.includes("admin")) return null;
      return () => keys.has(id.id, "admin");
    }
    if (c.password === undefined || c.password === "") return null;
    const hash = this.currentPasswordHash();
    if (hash === "") return null;
    try {
      if (!(await Bun.password.verify(c.password, hash))) return null;
    } catch {
      return null;
    }
    return () => this.currentPasswordHash() === hash;
  }

  async listen(): Promise<void> {
    const s = this.cfg.settings;
    if (this.runMode === "app" && s["api.bind"] !== "" && !isLoopback(s["api.bind"])) {
      this.log("warn", "api.bind applies in server mode only; the app listens on 127.0.0.1");
    }
    const keys = this.keyStore;
    this.server = startApiServer({
      app: this,
      port: s["api.port"],
      hostname: apiBind(s),
      maxUploadBytes: s["server.max_upload_mb"] * 1024 * 1024,
      trustedProxies: s["server.trusted_proxies"]
        .map((c) => parseCidr(c))
        .filter((c): c is Cidr => c !== null),
      token: () => this.tokens.current(),
      page:
        this.runMode === "server"
          ? async (req, srv) => (await this.pageServer()).fetch(req, srv)
          : undefined,
      guard:
        this.o.guard ??
        (keys
          ? serverGuard({
              publicHost: s["server.public_host"],
              behindProxy: s["server.behind_proxy"],
              keys,
              onRefused: (r) =>
                this.log(
                  "warn",
                  `key.refused ${r.keyPrefix === "" ? "(not an akou key)" : `${r.keyPrefix}…`} from ${r.source} on ${r.path}`,
                ),
            })
          : undefined),
      onError: (err, req) =>
        this.log(
          "error",
          `${req.method} ${new URL(req.url).pathname}: ${(err as Error).stack ?? err}`,
        ),
    });
    this.writeRuntime();
    this.detectAccelerator();
    this.startJobs();
    this.startDictation();
    // Recovery and the final-pass catch-up run behind the API, never before it.
    void this.manager
      .init()
      .then(() => this.catchUpFinals())
      .catch((err) => this.log("error", `recovery: ${(err as Error).message}`));
    if (!this.headless && this.o.window) this.window = await this.o.window(this);
    else if (!this.headless) this.log("info", "the window is not built yet; running headless");
  }

  /**
   * Once the API listens: the start line in `app.log` and the watchdog (DK-M8), when the entry
   * point asked for them. The watchdog ends a stuck app only while no call records.
   */
  supervise(): void {
    if (!this.appLog) return;
    this.appLog.line(
      "info",
      `akou ${this.version} started (pid ${process.pid}, ${this.runMode}, ${this.headless ? "headless" : "with the window"}, API on port ${this.server?.port})`,
    );
    this.watchdog = startWatchdog({
      logFile: this.appLog.file,
      hangsDir: join(this.configDir, HANGS_DIR),
      // A start counts from before its helper is spawned, so a stall in between never reads as
      // "no call is recording" (`starting`); every live change is published at once (`touch`).
      recording: () => this.starting > 0 || this.manager.live() !== null,
      windowOpen: () => this.window?.isOpen?.() ?? false,
      relaunch: relaunchCommand(),
    });
  }

  /** `runtime.json`: pid, port, version, and the harnesses found (DESIGN 5.3), mode 0600. */
  private writeRuntime(): void {
    if (!this.server || this.quitting) return;
    writePrivate(
      this.runtimeFile,
      `${JSON.stringify(
        {
          pid: process.pid,
          port: this.server.port,
          api: this.server.url,
          version: this.version,
          startedAt: this.startedAt,
          headless: this.headless,
          harnesses: this.discovery,
        },
        null,
        2,
      )}\n`,
    );
  }

  /** The one quit path. Safe to call twice; the second call waits for the first. */
  quit(): Promise<void> {
    this.quitting ??= (async () => {
      this.appLog?.line("info", "quitting");
      // Let the answer to `POST /quit` go out first.
      // clock: lets the answer to `POST /quit` go out first.
      await new Promise((r) => setTimeout(r, 20));
      try {
        await this.window?.close();
      } catch (err) {
        this.log("warn", `window close: ${(err as Error).message}`);
      }
      await this.sharing.stopAll();
      for (const t of this.reexports.values()) clearTimeout(t);
      this.reexports.clear();
      await this.manager.quit();
      const running = [...this.finals.values()];
      if (running.length > 0) {
        const r = await withDeadline(realClock, Promise.allSettled(running), QUIT_FINAL_GRACE_MS);
        if (!r.ok) {
          // Its Worker and llama-server stop now: a Worker dies with the app, its child does not.
          this.finalStop.abort();
          await Promise.allSettled(running);
          this.log("info", "a final pass was stopped; it runs again at the next start");
        }
      }
      await this.dictationSvc?.close();
      this.cuePlayer?.close();
      this.remoteDictation?.close();
      if (this.bestRewarm !== null) this.clock.clearTimeout(this.bestRewarm);
      await this.bestDictation?.stop();
      const liveQwen = this.liveQwen;
      this.liveQwen = null;
      await liveQwen?.server.stop();
      await this.asr?.close();
      await this.page?.stop();
      await this.server?.stop();
      // After the API: no request is left holding the store. A running job is queued again at start.
      this.jobService?.close();
      if (this.modelSweep) clearInterval(this.modelSweep);
      this.shelf?.close();
      try {
        const rt = JSON.parse(readFileSync(this.runtimeFile, "utf8")) as { pid?: number };
        if (rt.pid === process.pid) unlinkSync(this.runtimeFile);
      } catch {}
      releaseLock(this.lockPath);
      this.watchdog?.stop();
      this.appLog?.line("info", `akou ${this.version} quit (pid ${process.pid})`);
      this.resolveClosed();
    })();
    return this.quitting;
  }
}

/** The app lock's heartbeat, stopped when the lock is released. */
const heartbeats = new Map<string, () => void>();

function releaseLock(path: string): void {
  heartbeats.get(path)?.();
  heartbeats.delete(path);
  const held = readLock(path);
  if (held?.pid !== process.pid || held.id !== INSTANCE_ID) return;
  try {
    unlinkSync(path);
  } catch {}
}

function readRuntime(configDir: string): { port?: number; version?: string } | null {
  try {
    return JSON.parse(readFileSync(join(configDir, RUNTIME_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** Starts the app: settings, the single-instance lock, the token, the API. */
export async function startApp(o: AppOptions = {}): Promise<AkouApp> {
  const cfg = loadConfig(o.env ?? process.env, o.platform);
  // A bind the settings forbid stops the start before anything is taken or written.
  apiBind(cfg.settings);
  const serverMode = cfg.settings["server.enabled"];
  // SV-P12: a bind-mounted folder the server cannot write stops it here, with the folder named.
  if (serverMode) {
    requireWritable(cfg.paths.configDir);
    requireWritable(cfg.settings["asr.modelsDir"]);
  }
  // The folder holds the token and runtime.json: the owner's alone.
  makePrivateDir(cfg.paths.configDir);
  const lockPath = join(cfg.paths.configDir, APP_LOCK);
  try {
    acquireLock(lockPath, process.pid, processAlive, { serverMode });
  } catch (err) {
    if (err instanceof LockError) {
      if (err.aging) throw new LockAgingError(err.holderPid, err.aging);
      throw new AlreadyRunningError(err.holderPid, readRuntime(cfg.paths.configDir));
    }
    throw err;
  }
  // The heartbeat tells another container on the same volume that this one still runs (SI-4).
  heartbeats.set(lockPath, lockHeartbeat(lockPath, process.pid));
  let app: AkouApp | null = null;
  try {
    const token = ensureToken(cfg.paths.configDir);
    app = new AkouApp(o, cfg, token, lockPath);
    await app.moveSecrets();
    await app.listen();
    app.supervise();
    return app;
  } catch (err) {
    await app?.asr?.close();
    await app?.server?.stop();
    releaseLock(lockPath);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The entry point

if (import.meta.main) {
  let app: AkouApp;
  try {
    app = await startApp({ secrets: systemSecrets(), supervise: true });
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      console.error(err.message);
      process.exit(0);
    }
    if (err instanceof StartRefused) {
      console.error(`akou: cannot start: ${err.message}`);
      process.exit(78);
    }
    if (err instanceof NotWritable) {
      console.error(`akou: cannot start: ${err.message}`);
      process.exit(77);
    }
    if (err instanceof LockAgingError) {
      console.error(`akou: cannot start yet: ${err.message}`);
      process.exit(75);
    }
    console.error(`akou: cannot start: ${(err as Error).message}`);
    process.exit(70);
  }
  for (const i of app.config().issues) console.error(`akou: setting refused: ${i.message}`);
  console.error(`akou ${app.version}: listening on ${app.server?.url} (pid ${process.pid})`);
  // ElectroBun's main script swallows these; in a plain Bun process they take the same quit path.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void app.quit());
  await app.closed;
  process.exit(0);
}

/** How far a running final pass is (`GET /calls/{id}` `final.progress`, `GET /status` `finals[]`). */
export interface FinalProgress {
  done_s: number;
  total_s: number;
  model: string;
  step: FinalStep | null;
  waiting: string | null;
}

/** A call's final pass as `GET /status` reports it (`last.final`). */
export interface FinalStatus {
  state: "none" | "running" | "done" | "failed";
  /** The recognizer's id, or null when the log does not name one (an older pass). */
  model: string | null;
  /** Seconds of the call the running pass has covered, over both channels; null when not running here. */
  done_s: number | null;
  /** The call's length in seconds, once the running pass has read it (0 before). */
  total_s: number | null;
  /** What the running pass is doing before its figures move; null when not running here. */
  step: FinalStep | null;
  /** The call whose Qwen pass this one waits for; null when not waiting. */
  waiting: string | null;
  /** `t` of `final.done` or `final.failed`. */
  endedAt: number | null;
  skipped: number;
  warning: string | null;
  error: string | null;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** The live call's model and second pass by name, for the window: `Nemotron 3.5`, `Qwen`. */
function liveNames(ran: LiveSetupChoice | undefined): { name?: string; reviewName?: string } {
  if (!ran) return {};
  return {
    name: liveModelName(ran.choice?.engine ?? RECOGNIZER),
    ...(ran.review ? { reviewName: shortModelName(reviewerId(ran.review.model)) } : {}),
  };
}
