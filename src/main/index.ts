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
import { join } from "node:path";
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
import { type ApiApp, type ApiServer, type Levels, startApiServer } from "./api/server.ts";
import { APP_VERSION, RUNTIME_FILE } from "./app-info.ts";
import type { DiarizerKind, ModelSpec, ParakeetDecoding } from "./asr/engine.ts";
import { type FinalAudioSpec, finalizeCall } from "./asr/finalize-worker.ts";
import { type CallAccess, LiveAsr, type VocabSource } from "./asr/live-worker.ts";
import {
  DownloadRefused,
  downloadModels,
  MODELS,
  type ModelSpecEntry,
  type ModelsStatus,
  modelFile,
  modelsFor,
  pruneRetiredModels,
} from "./asr/models.ts";
import { DIARIZE_HELPER_NAME } from "./asr/nemotron.ts";
import type { CallController, StartOk } from "./call/call.ts";
import { partFile } from "./call/folder.ts";
import { CallManager, type StartRequest } from "./call/manager.ts";
import { fail, type Outcome } from "./call/state.ts";
import { type CaptureEngine, type Clock, realClock, withDeadline } from "./capture/engine.ts";
import { AkouCaptureEngine, findHelper, locateHelper } from "./capture/helper.ts";
import {
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
import { LocalLink } from "./share/local-link.ts";
import { parseExpiry, type ShareHandle, type ShareStatus } from "./share/transport.ts";
import { callLanguages, Dictionaries } from "./vocab/dictionary.ts";
import { mergeVocab, readVocabFile, toFoldEntries, vocabPaths } from "./vocab/files.ts";
import { Bridge } from "./window/bridge.ts";
import { buildUi } from "./window/bundle.ts";
import { PageServer, type SettingsPane } from "./window/page-server.ts";

export { APP_VERSION, RUNTIME_FILE };
export const APP_LOCK = "akou.lock";
/** A final pass still running at quit gets this long, then is left for the next start. */
export const QUIT_FINAL_GRACE_MS = 5_000;
/** Names, merges and vocabulary change in bursts; a re-export waits this long for the last one. */
export const REEXPORT_DEBOUNCE_MS = 1_500;

/** Events after which an exported call is exported again (DESIGN 8.2): names and corrections. */
const REEXPORT_ON: ReadonlySet<string> = new Set([
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
   * Where the final pass reads a call's audio, or null when it cannot. By default a part is read
   * from a 16-bit WAV beside its Opus file (`part-001.wav`); the app cannot decode Opus yet.
   */
  finalAudio?: (call: { id: string; dir: string; parts: number[] }) => FinalAudioSpec | null;
  /** The window. None means headless. */
  window?: WindowFactory;
  /** The provider, replacing the one the settings name. Tests pass a fake. */
  provider?: Provider;
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
  version?: string;
  onLog?(level: "info" | "warn" | "error", msg: string): void;
}

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

/** The default final-pass audio: a WAV beside every part's Opus file, or nothing. */
function wavBesideParts(call: { dir: string; parts: number[] }): FinalAudioSpec | null {
  if (call.parts.length === 0) return null;
  const files: Record<number, string> = {};
  for (const p of call.parts) {
    const wav = join(call.dir, partFile(p).replace(/\.opus$/, ".wav"));
    if (!existsSync(wav)) return null;
    files[p] = wav;
  }
  return { kind: "wav", files };
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
  /** Per call, the hand-off work in order: one export or hook round at a time. */
  private readonly handoffs = new Map<string, Promise<unknown>>();
  private readonly reexports = new Map<string, ReturnType<typeof setTimeout>>();
  /** Calls with a memo being written, and when a failed one may be tried again. */
  private readonly memos = new Set<string>();
  private readonly memoRetryAt = new Map<string, number>();
  private quitting: Promise<void> | null = null;
  /** Claude Code and Codex as found at start; null while still looking. */
  discovery: Discovery | null = null;
  private discovering = false;
  private resolveClosed!: () => void;
  private lockPath: string;
  tokens: TokenSource;
  /** `server` when `server.enabled` is on (docs/ux/SERVER.md); fixed for the life of the process. */
  private readonly runMode: "app" | "server";
  /** The API keys; server mode only (SV-K2). */
  private readonly keyStore: KeyStore | null;

  constructor(
    private readonly o: AppOptions,
    cfg: LoadedConfig,
    token: { token: string; path: string },
    lockPath: string,
  ) {
    this.cfg = cfg;
    this.version = o.version ?? APP_VERSION;
    this.clock = o.clock ?? realClock;
    this.configDir = cfg.paths.configDir;
    this.headless = o.headless ?? cfg.settings["app.headless"];
    this.runMode = cfg.settings["server.enabled"] ? "server" : "app";
    this.keyStore =
      this.runMode === "server" ? new KeyStore(this.configDir, () => Date.now()) : null;
    this.startedAt = this.clock.now();
    this.runtimeFile = join(this.configDir, RUNTIME_FILE);
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

  /** The models the next start needs (`asr.diarizer`): what the download card offers. */
  private registry(): readonly ModelSpecEntry[] {
    return modelsFor(
      this.cfg.settings["asr.diarizer"] as DiarizerKind,
      this.o.modelRegistry ?? MODELS,
    );
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
   * Whether the running engine's model files are there: what a start and the final pass need. A
   * change to `asr.diarizer` mid-run never asks for models the running recognizer does not use.
   */
  private runningModelsPresent(): boolean {
    const registry = modelsFor(this.runningDiarizer(), this.o.modelRegistry ?? MODELS);
    return modelsPresent(this.cfg.settings["asr.modelsDir"], registry);
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
    pull.running = downloadModels(
      dir,
      this.registry().map((m) => m.id),
      {
        registry: this.registry(),
        env: (this.o.env ?? process.env) as NodeJS.ProcessEnv,
        onProgress: (p) => {
          pull.file = `${p.model}/${p.name}`;
          pull.done.set(pull.file, p.bytes);
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

  private log(level: "info" | "warn" | "error", msg: string): void {
    if (this.o.onLog) this.o.onLog(level, msg);
    else console.error(`akou ${level}: ${msg}`);
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
        clock: this.clock,
        onLog: (level, msg) => this.log(level, `asr: ${msg}`),
      },
      (id) => this.manager.controller(id) as CallAccess | undefined,
    );
    this.asr = asr;
    this.asrState = { state: "loading" };
    asr.ready.then(
      () => {
        this.asrState = { state: "ready" };
      },
      (err: Error) => {
        this.asrState = { state: "unavailable", reason: err.message };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Events

  private onEvent(id: string, e: LogEvent): void {
    this.asr?.onEvent(id, e);
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
   * with the same template. Notes written by hand, and the harness, are left to the window's button
   * (`reEnhanceState`). A failure is logged; the button is still there.
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
    const url =
      platform === "darwin"
        ? `x-apple.systempreferences:com.apple.preference.security?${pane === "microphone" ? "Privacy_Microphone" : "Privacy_AudioCapture"}`
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

  // -------------------------------------------------------------------------
  // ApiApp

  now(): number {
    return this.clock.now();
  }

  config(): LoadedConfig {
    return this.cfg;
  }

  async saveConfig(file: Partial<Record<SettingKey, SettingValue>>): Promise<LoadedConfig> {
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    // The keys the API cannot write are the file's: what is on disk now wins over this process's
    // copy, so a save never drops a value written since the start (`akou admin set-password`).
    const onDisk = loadConfig(this.o.env ?? process.env, this.o.platform).file;
    const next: Partial<Record<SettingKey, SettingValue>> = { ...file };
    for (const k of SETTING_KEYS) {
      if ((SETTINGS[k] as SettingSpec).apiWritable !== false) continue;
      if (onDisk[k] === undefined) delete next[k];
      else next[k] = onDisk[k];
    }
    writePrivate(this.cfg.paths.configFile, `${JSON.stringify(next, null, 2)}\n`);
    const before = this.cfg.settings;
    this.cfg = loadConfig(this.o.env ?? process.env, this.o.platform);
    const after = this.cfg.settings;
    const same = (k: "vocab.extraFiles" | "vocab.languages") =>
      before[k].join("\n") === after[k].join("\n");
    // Other files or other word lists: every open call reads its vocabulary again.
    if (!same("vocab.extraFiles") || !same("vocab.languages")) this.vocabChanged();
    return this.cfg;
  }

  vocabChanged(): void {
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
        entries: mergeVocab(
          layers.map((l) => ({ scope: l.scope, path: l.path, file: l.loaded.file })),
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

  async start(req: StartRequest): Promise<Outcome<StartOk>> {
    const r = await this.startCall(req);
    const by = req.by ?? "user";
    this.announce(
      r.ok
        ? { what: "start", by, ok: true, call: r.call }
        : { what: "start", by, ok: false, code: r.code },
    );
    return r;
  }

  private async startCall(req: StartRequest): Promise<Outcome<StartOk>> {
    if (this.quitting) return fail(503, "quitting", "akou is quitting");
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
    return this.manager.start(req);
  }

  async call(id: string): Promise<CallController> {
    const c = await this.manager.open(id);
    if (!c) throw new HttpError(404, "not_found", `no call ${id}`);
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
            levels: this.levels(live.id),
          }
        : null,
      last: last
        ? { call: last.id, title: last.title, state: last.state, endedAt: last.endedAt }
        : null,
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
    opts: { force?: boolean },
  ): Promise<Outcome<{ call: string; started: boolean }>> {
    const c = await this.call(id);
    if (c.live || c.status === "stopping") {
      return fail(409, "not_ended", "the call is still recording", { call: id });
    }
    if (this.finals.has(id))
      return fail(409, "final_running", "the final pass is running", { call: id });
    if (finalCurrent(c.view) && !opts.force) {
      return fail(409, "already_final", "the final pass already ran; use force to run it again", {
        call: id,
      });
    }
    const r = this.runFinal(id, true);
    if (r) return fail(501, "final_unavailable", r.why, { call: id });
    return { ok: true, call: id, started: true };
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

  /** The recognizer models for the final pass, or null when there are none. */
  private finalModels(): ModelSpec | null {
    // A recognizer given on purpose (tests) runs at once, unless a model registry is given too.
    if (this.o.models !== undefined && !this.o.modelRegistry) return this.o.models;
    if (!this.runningModelsPresent()) return null;
    return this.o.models !== undefined ? this.o.models : this.finalSherpaSpec();
  }

  /**
   * The real engines the final pass runs: the running recognizer's speaker-label engine and
   * decoding, whatever the settings say now. Public so a test can read it without real models.
   */
  finalSherpaSpec(): ModelSpec {
    return this.sherpaSpec(this.cfg.settings, this.runningDiarizer(), this.runningDecoding());
  }

  /**
   * Starts the final pass in the background. Returns null once started, or why it cannot run;
   * `unavailable` when the call lacks what the pass needs (readable audio, the models).
   */
  private runFinal(id: string, force: boolean): { why: string; unavailable?: true } | null {
    if (this.quitting) return { why: "akou is quitting" };
    if (this.finals.has(id)) return { why: "the final pass is already running" };
    const c = this.manager.controller(id);
    if (!c || c.live) return { why: "the call is not ended" };
    if (!force && finalCurrent(c.view)) return { why: "the final pass already ran" };
    const parts = c.view.parts().map((p) => p.part);
    const audio = (this.o.finalAudio ?? wavBesideParts)({ id, dir: c.dir, parts });
    if (!audio)
      return {
        why: "the final pass cannot read this call's audio yet (Opus decoding is not built)",
        unavailable: true,
      };
    const models = this.finalModels();
    if (!models) return { why: "the speech models are not downloaded", unavailable: true };
    const ws = c.view.call?.workspace ?? "";
    const p = finalizeCall(c, {
      models,
      audio,
      vocab: this.vocabCache.get(ws),
      inThread: this.o.asrInThread,
      clock: this.clock,
      onLog: (level, msg) => this.log(level, `final ${id}: ${msg}`),
    })
      .then((r) => {
        if (!r.ok) this.log("warn", `final pass of ${id} failed: ${r.error}`);
      })
      .catch((err) => this.log("error", `final pass of ${id}: ${(err as Error).message}`))
      .finally(() => this.finals.delete(id));
    this.finals.set(id, p);
    return null;
  }

  /** Calls that ended while akou was not running and have no final layer yet. */
  private async catchUpFinals(): Promise<void> {
    for (const s of this.manager.calls()) {
      if (this.quitting) return;
      if (s.state !== "ended" && s.state !== "interrupted") continue;
      try {
        const { events } = await readLog(join(s.dir, EVENTS_FILE));
        const v = fold(events);
        if (finalCurrent(v)) continue;
        const parts = v.parts().map((p) => p.part);
        if (!(this.o.finalAudio ?? wavBesideParts)({ id: s.id, dir: s.dir, parts })) continue;
        const c = await this.manager.open(s.id);
        if (c) this.runFinal(s.id, false);
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
    // Recovery and the final-pass catch-up run behind the API, never before it.
    void this.manager
      .init()
      .then(() => this.catchUpFinals())
      .catch((err) => this.log("error", `recovery: ${(err as Error).message}`));
    if (!this.headless && this.o.window) this.window = await this.o.window(this);
    else if (!this.headless) this.log("info", "the window is not built yet; running headless");
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
      // Let the answer to `POST /quit` go out first.
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
        if (!r.ok)
          this.log("info", "a final pass is still running; it runs again at the next start");
      }
      await this.asr?.close();
      await this.page?.stop();
      await this.server?.stop();
      try {
        const rt = JSON.parse(readFileSync(this.runtimeFile, "utf8")) as { pid?: number };
        if (rt.pid === process.pid) unlinkSync(this.runtimeFile);
      } catch {}
      releaseLock(this.lockPath);
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
  // The folder holds the token and runtime.json: the owner's alone.
  makePrivateDir(cfg.paths.configDir);
  const lockPath = join(cfg.paths.configDir, APP_LOCK);
  const serverMode = cfg.settings["server.enabled"];
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
    await app.listen();
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
    app = await startApp();
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      console.error(err.message);
      process.exit(0);
    }
    if (err instanceof StartRefused) {
      console.error(`akou: cannot start: ${err.message}`);
      process.exit(78);
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
