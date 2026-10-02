/**
 * The one settings registry (docs/DESIGN.md sections 6.1, 6.2 and 10): every setting akou reads,
 * with its type, its range, its default and, for the few that have one, the environment variable
 * that overrides it. The config file, `akou config set`, `PATCH /v1/config` and the environment all
 * go through `validateSetting`, so a hand-edited file cannot slip a value past a range the CLI would
 * refuse (TRAPS T4.9).
 *
 * The file is `config.json` in the config folder: one JSON object with the dotted keys below.
 *
 *   {"asr.segmentPause": 0.8, "api.port": 8476}
 *
 * A key that is unknown, of the wrong type or out of range is refused with a message and its
 * default is used; the rest of the file still applies. A file that is not JSON is refused whole.
 * There is deliberately no `vocab.boost`: the global boost is the constant 1.5, used only when
 * Parakeet decodes with beam search (TRAPS "The boost is a slider"), and a file that tries to set
 * one is told so.
 *
 * Environment: only `AKOU_HEADLESS`, `AKOU_SERVER`, `AKOU_BEHIND_PROXY`, `AKOU_MODELS_DIR`,
 * `AKOU_ACCELERATOR` and `AKOU_HOME` exist.
 * `AKOU_HOME` is not a setting: it moves the home folder itself (config and recordings), for tests.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ACTIVATIONS } from "../../core/dictation/activation.ts";
import { parseCidr } from "../api/net.ts";
import { ACCELERATOR_SETTINGS } from "../asr/accelerator.ts";
import { FINAL_MODELS, finalModelId } from "../asr/final-model.ts";
import { LIVE_ENGINE_SETTINGS } from "../asr/live-engines.ts";
import { LIVE_SETTINGS, REVIEW_MODELS } from "../asr/live-setups.ts";
import { defaultModelsDir } from "../asr/models.ts";
import { REVIEW_EVERY_MAX, REVIEW_EVERY_MIN, REVIEW_EVERY_SECONDS } from "../asr/upgrade.ts";
import { DICTATION_FINALS } from "../dictation/engines.ts";
import { checkRemotes } from "../server/remotes.ts";
import { DICTIONARY_LANGUAGES } from "../vocab/dictionary.ts";
import { defaultConfigDir } from "../vocab/files.ts";
import { checkDictationHotkey, checkExtraHotkey } from "../window/hotkey.ts";
import { KEY_TEXT } from "./secrets.ts";

export type SettingType =
  | "integer"
  | "number"
  | "boolean"
  | "string"
  | "string[]"
  | "hooks"
  | "apps";

/** What a dictation inserts with, and the key pressed after it (DC-N6, DC-S2). */
export const DICTATION_INSERTS = ["paste", "type", "clipboard"] as const;
export const DICTATION_SEND_KEYS = ["Enter", "Ctrl+Enter", "Cmd+Enter", "Shift+Enter", "none"];
export const DICTATION_ENGINES = ["auto", "fast", "best", "remote"] as const;
export const DICTATION_FORMATS = ["off", "provider"] as const;
export const APP_MODES = ["direct", "draft", "draft-send"] as const;

/**
 * One per-app dictation rule (`dictation.apps`, DC-U9), keyed by the app captured at session
 * start: a bundle id (macOS), an executable name (Windows) or a window class (Linux). A field left
 * out means the global setting.
 */
export interface AppRule {
  app: string;
  /** The app's name as people know it (`Slack`), shown for the rule; never matched. */
  name?: string;
  mode?: (typeof APP_MODES)[number];
  insert?: (typeof DICTATION_INSERTS)[number];
  sendKey?: string;
  engine?: (typeof DICTATION_ENGINES)[number];
  language?: string;
  format?: (typeof DICTATION_FORMATS)[number];
}

/** An ISO 639 code, as `asr.languages` takes them. */
const LANGUAGE = /^[a-z]{2,3}$/;

/** The stages a hand-off hook or the webhook runs at: the event type names (DESIGN 8.2). */
export const HOOK_STAGES = ["call.ended", "final.done", "enhanced"] as const;
export type HookStage = (typeof HOOK_STAGES)[number];

/**
 * One post-call hook: a command run with the call as JSON on stdin. A string runs through the
 * shell (`/bin/sh -c`, `cmd /c` on Windows); a list is the program and its arguments, no shell.
 */
export interface HookConfig {
  stage: HookStage;
  command: string | readonly string[];
  /** Killed after this long. Default 600. */
  timeoutSec?: number;
  /** Only calls in this workspace. Absent: every workspace. */
  workspace?: string;
  /** The name `hook.done` and the log carry. Default: the command. */
  name?: string;
}

export const HOOK_TIMEOUT_DEFAULT = 600;

export interface SettingSpec {
  type: SettingType;
  /** Inclusive range for numbers, or length range for strings and lists. */
  min?: number;
  max?: number;
  /** A number setting may also take these values outside the range (`api.port` 0). */
  also?: readonly number[];
  /** One of these values, for a string or for each item of a list. */
  values?: readonly string[];
  default: SettingValue;
  /** The environment variable that overrides the file. */
  env?: string;
  /**
   * False for settings that name a program akou runs: they are read from the file only, never
   * written over the local API, so the API token cannot become a way to run a chosen command.
   */
  apiWritable?: boolean;
  /**
   * With `apiWritable: false`: also writable from the desktop window, whose requests run in
   * process, never from an HTTP client. For an address the user sets on the page that decides
   * where their audio goes (`dictation.remote.url`).
   */
  windowWritable?: boolean;
  /** A secret (an API key): never shown by `GET /config`, `config show` or `status`. */
  secret?: boolean;
  /** A rule the type cannot say: the error, or null when the value is good. */
  check?: (value: SettingValue) => string | null;
  doc: string;
}

export type SettingValue =
  | number
  | boolean
  | string
  | readonly string[]
  | readonly HookConfig[]
  | readonly AppRule[];

const home = homedir();

/**
 * Defaults that depend on the machine are computed from the home folder; `resolveDefaults` redoes
 * them for `AKOU_HOME`.
 */
export const SETTINGS = {
  "recordings.root": {
    type: "string",
    min: 1,
    default: join(home, "Recordings", "akou"),
    doc: "Folder that holds a subfolder per workspace, each holding one folder per call.",
  },
  "user.name": {
    type: "string",
    max: 100,
    default: "",
    doc: "Your name, written into every call and used for the mic channel's label.",
  },
  "api.port": {
    type: "integer",
    min: 1024,
    max: 65535,
    also: [0],
    default: 8476,
    doc: "Port of the local API on 127.0.0.1. 0 picks a free port; runtime.json has the one in use.",
  },
  "app.headless": {
    type: "boolean",
    default: false,
    env: "AKOU_HEADLESS",
    doc: "Run with no window. Selected by the environment, never by command-line arguments.",
  },
  "app.hotkey": {
    type: "string",
    max: 60,
    default: "",
    doc: "Global shortcut that starts and stops a call, in accelerator form (`Control+Shift+F9`). Empty: `Option+Command+R` on macOS, `Control+Shift+F9` elsewhere (never `Control+Alt`, which is AltGr on many layouts).",
  },
  "app.floatingIndicator": {
    type: "boolean",
    default: true,
    doc: "While a call records and the akou window is not in front, a small always-on-top bar with the time, the levels, Mute, Ask and Stop. It shows no transcript text, so it can stay up during a screen share.",
  },
  "app.openAtLogin": {
    type: "boolean",
    default: false,
    doc: "Start akou, with no window, when you log in, so the hotkey and the tray are always there.",
  },
  "share.bind": {
    type: "string",
    min: 1,
    max: 45,
    default: "tailnet",
    doc: "Where a share link listens: `tailnet`, `lan` (plain HTTP, visible to that network) or an IPv4 address. Never every interface unless you type `0.0.0.0`.",
  },
  "share.port": {
    type: "integer",
    min: 1024,
    max: 65535,
    also: [0],
    default: 8477,
    doc: "Port of the read-only share link. 0 picks a free port.",
  },
  "api.bind": {
    type: "string",
    max: 45,
    default: "",
    // Where the API is reachable, and who may reach it below, change only in the file: the token
    // must not become a way to put the API on the network.
    apiWritable: false,
    doc: "Address the API listens on in server mode: 127.0.0.1, 0.0.0.0 or ::, the binds akou's CLI on the same box reaches. Empty: 0.0.0.0. 0.0.0.0 and :: need `server.behind_proxy`. The app always listens on 127.0.0.1.",
  },
  "server.enabled": {
    type: "boolean",
    default: false,
    env: "AKOU_SERVER",
    apiWritable: false,
    doc: "Server mode: per-key access instead of the one token, bound to `api.bind`, for other programs to call over the network.",
  },
  "server.behind_proxy": {
    type: "boolean",
    default: false,
    // SV-P11: a container states it in its compose file, with no config.json seeded first.
    env: "AKOU_BEHIND_PROXY",
    apiWritable: false,
    doc: "A reverse proxy in front of akou terminates TLS. Required for any bind that is not loopback; with no `server.public_host`, any Host header is accepted.",
  },
  "server.public_host": {
    type: "string",
    max: 253,
    default: "",
    apiWritable: false,
    doc: "The host name clients use (`akou.example`, or with a port). Set: server mode accepts that Host header and loopback only.",
  },
  "server.trusted_proxies": {
    type: "string[]",
    default: [],
    apiWritable: false,
    check: (v) => {
      const bad = (v as readonly string[]).find((c) => parseCidr(c) === null);
      return bad === undefined ? null : `${bad} is not an address or a CIDR block`;
    },
    doc: "Addresses or CIDR blocks of the proxies whose X-Forwarded-For is believed for rate limits and audit. From any other peer the TCP address is the source.",
  },
  "server.max_upload_mb": {
    type: "integer",
    min: 1,
    max: 16384,
    default: 512,
    doc: "Largest upload an upload route takes, in MiB. Every other route keeps the 64 KB JSON cap.",
  },
  "server.max_audio_minutes": {
    type: "integer",
    min: 1,
    max: 1440,
    default: 240,
    doc: "Longest audio a file job transcribes, in minutes. A longer file fails as `too_long` before it is held in memory.",
  },
  "server.retain_days": {
    type: "integer",
    min: 1,
    max: 3650,
    default: 7,
    doc: "Days a file job and its result are kept before they are deleted, as a client's delete would. The upload itself is deleted as soon as the job ends.",
  },
  "server.concurrency": {
    type: "integer",
    min: 1,
    max: 64,
    default: 1,
    doc: "File jobs run at once. Each running job has its own Worker with its models loaded and `asr.threads` threads, so keep this times `asr.threads` under the cores, and the memory for that many copies of the model.",
  },
  "server.queue_max": {
    type: "integer",
    min: 0,
    max: 1000000,
    default: 1000,
    doc: "File jobs queued or running at most, across keys. A submit past it is refused with 429 `queue_full` and `Retry-After`. 0: no limit.",
  },
  "server.queue_max_per_key": {
    type: "integer",
    min: 0,
    max: 1000000,
    default: 500,
    doc: "File jobs one key may have queued or running, so one client cannot fill the queue. A submit past it is refused with 429 `queue_full` and `Retry-After`. 0: no limit.",
  },
  "server.default_language": {
    type: "string",
    min: 2,
    max: 35,
    default: "auto",
    check: (v) =>
      /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/.test(v as string)
        ? null
        : `${JSON.stringify(v)} is not a BCP-47 tag such as es or en-US, or auto`,
    doc: "The language a file job is transcribed in when its request sends `language: auto` or none, as Telegram-Archive does. A BCP-47 tag such as `es`, or `auto` to detect it.",
  },
  "server.default_diarize": {
    type: "boolean",
    default: false,
    doc: "Label speakers in a file job whose request has no `diarize` field. A request that sends `diarize: false` gets no labels.",
  },
  "server.default_model": {
    type: "string",
    min: 1,
    max: 100,
    default: "auto",
    check: (v) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v as string)
        ? null
        : "is a preset name (auto, fast, ...) or an engine id from the model catalog",
    doc: "The model a file job runs when its request names none (`preset: auto` and no `model`): a preset name or an engine id from the model catalog. `auto`: the hardware's choice, `fast` today.",
  },
  "server.auto_download": {
    type: "boolean",
    default: true,
    doc: "What a job naming a model that is not on disk gets. On (the default): it waits while akou downloads the model, each file checked against its pinned SHA-256, then runs. Off: it is refused with 409 `preset_unavailable` and the `akou models pull` line. Download on the Models page and `akou models pull` fetch either way.",
  },
  "server.models_max_gb": {
    type: "number",
    min: 0,
    max: 100000,
    default: 40,
    doc: "Largest the models folder may grow through downloads of one model (a job's, or Download on the Models page), in GB (10^9 bytes). 0: no cap. A download that would pass it is refused with 409 `preset_unavailable`, `reason: models_max_gb`.",
  },
  "server.models_unused_days": {
    type: "integer",
    min: 0,
    max: 3650,
    default: 30,
    doc: "Days a model may go unused before akou deletes it, in the desktop app and in server mode. The default model, any model in use (a job, a worker, the recognizer) and one downloading are never deleted. 0: never delete.",
  },
  "server.remotes": {
    type: "string[]",
    default: [],
    // Where jobs and their audio are sent, and the key files read for it, change only in the file:
    // a key must not become a way to send every upload to a chosen host.
    apiWritable: false,
    check: (v) => checkRemotes(v as readonly string[]),
    doc: "Other akou servers this one sends jobs to, one entry each: `<url> <key file> [names]`, the key file holding a `jobs` key of that server. A job goes to a remote when this server cannot run it, or first when `names` (presets or model ids, comma-separated, `*` for all) lists it; the client still sees only this server.",
  },
  "server.admin_password_hash": {
    type: "string",
    max: 512,
    default: "",
    secret: true,
    apiWritable: false,
    doc: "The web UI's admin password, hashed. Set it with `akou admin set-password`.",
  },
  "capture.helper": {
    type: "string[]",
    default: [],
    apiWritable: false,
    doc: "Command that starts the capture helper, before its own arguments. Empty: the akou-capture bundled with the app, else the one on PATH.",
  },
  "capture.mic": {
    type: "string",
    min: 1,
    default: "default",
    doc: "Microphone: `default`, `none`, or a device id (akou cannot list the ids yet).",
  },
  "capture.call": {
    type: "string",
    min: 1,
    default: "system",
    doc: "Call audio: `system`, `none`, or `app:<id>[,<id>]`.",
  },
  "capture.warmStartSeconds": {
    type: "number",
    min: 1,
    max: 30,
    default: 3,
    doc: "Wait for the helper to report capturing, after a helper has captured once this run.",
  },
  "capture.coldStartSeconds": {
    type: "number",
    min: 1,
    max: 60,
    default: 10,
    doc: "Wait for the helper to report capturing on the first start of a run.",
  },
  "capture.stopSeconds": {
    type: "number",
    min: 1,
    max: 30,
    default: 5,
    doc: "How long a helper may take to stop before it is killed.",
  },
  "capture.stallSeconds": {
    type: "number",
    min: 2,
    max: 120,
    default: 10,
    doc: "No packet at all for this long means the helper is wedged and is restarted.",
  },
  "capture.deadRestartSeconds": {
    type: "number",
    min: 10,
    max: 600,
    default: 60,
    doc: "A dead call side that lasts this long restarts the helper.",
  },
  "capture.queueSeconds": {
    type: "number",
    min: 10,
    max: 3600,
    default: 600,
    doc: "Audio kept per channel for the recognizer when it falls behind.",
  },
  "asr.modelsDir": {
    type: "string",
    min: 1,
    // The platform's data folder, never AKOU_MODELS_DIR, which applies as an override (`env`).
    default: defaultModelsDir({
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    }),
    env: "AKOU_MODELS_DIR",
    doc: "Folder the speech models are downloaded into and loaded from.",
  },
  "asr.threads": {
    type: "integer",
    min: 1,
    max: 32,
    default: 2,
    doc: "Threads per recognizer.",
  },
  "asr.diarizer": {
    type: "string",
    values: ["nemotron", "embeddings"],
    default: "nemotron",
    doc: "Who speaks when on the call channel: `nemotron` (NVIDIA Nemotron 3 Diarization, live at 2 s latency and in the final pass, through the akou-diarize helper) or `embeddings` (voice-embedding clusters live, pyannote in the final pass). `akou models pull` fetches what the choice needs; takes effect at the next start.",
  },
  "asr.accelerator": {
    type: "string",
    values: ACCELERATOR_SETTINGS,
    default: "auto",
    env: "AKOU_ACCELERATOR",
    doc: "The GPU the large speech model (Qwen3-ASR, on llama-server) runs on: `auto`, `cpu`, `metal`, `vulkan` (Intel and AMD, and NVIDIA without CUDA), `cuda`, `sycl` (Intel oneAPI) or `rocm` (AMD). `auto` picks Metal on Apple silicon, CUDA for an NVIDIA card, Vulkan for an Intel or AMD GPU, else the CPU, and never SYCL or ROCm. A build that cannot open the GPU falls back to the CPU; `GET /v1/server` says which runs and why. Natively it picks which pinned llama-server build to download; an image runs the build it carries. Natively `sycl` and `rocm` download llama.cpp's SYCL or ROCm build, which needs Intel's oneAPI or AMD's ROCm runtime on the host. `asr.llamaServer` runs an own build instead. Applies to the next job that starts llama-server.",
  },
  "asr.parakeet.decoding": {
    type: "string",
    values: ["greedy", "beam"],
    default: "greedy",
    doc: "How Parakeet decodes, live and in the final pass: `greedy` (the default) or `beam`. Beam search also steers decoding toward the call's vocabulary at boost 1.5, but on some meeting audio it returns whole spans empty. Vocabulary correction when reading and after the call applies with either. Takes effect at the next start.",
  },
  "asr.languages": {
    type: "string[]",
    default: [],
    check: (v) =>
      (v as readonly string[]).every((c) => /^[a-z]{2,3}$/.test(c))
        ? null
        : "is a list of ISO 639 codes, for example en and es",
    doc: "The languages Qwen3-ASR may choose among when a job's language is `auto`, as ISO 639 codes (for example `en` and `es`). An answer in another language is replaced by the decode, forced into one of these, that the model scores higher; a no-speech answer stays empty. Empty: whatever language the model names.",
  },
  "asr.llamaServer": {
    type: "string[]",
    default: [],
    apiWritable: false,
    doc: "Command that starts an own llama-server for Qwen3-ASR, before the arguments akou adds (for example a build compiled on this machine). Empty: the pinned llama-server release for this platform and `asr.accelerator`, downloaded like a model.",
  },
  "asr.diarizeHelper": {
    type: "string[]",
    default: [],
    apiWritable: false,
    doc: "Command that starts the diarization helper, before its own arguments. Empty: the akou-diarize bundled with the app, else the one on PATH.",
  },
  "asr.live": {
    type: "string",
    values: LIVE_SETTINGS,
    default: "auto",
    doc: "The model that writes the live transcript of a call: `auto`, or a model's id (`nemotron-3.5-560`, `nemotron-3.5-1120`, `nemotron-en-560`, `parakeet-tdt-0.6b-v3-fp32`, or another chunk size of a streaming Nemotron: `nemotron-en-80`, `nemotron-en-160`, `nemotron-en-1120`, `nemotron-3.5-80`, `nemotron-3.5-160`, `nemotron-3.5-320`), as the Record row's Live panel saves it. `nemotron`: streaming Nemotron (`asr.live.engine` picks which), a word shown is never taken back. `parakeet`: Parakeet re-decodes each stretch between pauses, and words on screen can change. `auto` picks `nemotron` when its model is downloaded, else `parakeet`. A model that is not downloaded never runs. `upgrade`, the old value, is read as `nemotron` with `asr.review.model` `qwen`, and saved that way. `akou start --live` sets it for one call. A change applies from the next call; a running call keeps its model.",
  },
  "asr.review.model": {
    type: "string",
    values: REVIEW_MODELS,
    default: "none",
    doc: "A second pass during a call, `none` or a model's id (`qwen3-asr-1.7b`, `parakeet-tdt-0.6b-v3-fp32`; `qwen` and `parakeet` name the same): every `asr.review.everySeconds`, the sentences Nemotron finished since the last review are decoded again, whole, and the new words replace the live lines once. `qwen`: Qwen3-ASR, the most accurate, about 10 to 13 GB of memory during a call; it needs its llama-server, and it goes off for the rest of a call it cannot keep up with. The window offers it only on a machine with a GPU for it and 16 GB of memory; set here, it runs anyway. `parakeet`: Parakeet, on the processor, with at most about 100 MB more memory. `none`: the live lines stay as Nemotron wrote them. It reviews Nemotron's lines only, so a call whose live model is Parakeet runs none. A line someone edited, or fixed a word on, keeps their text. `akou start --review` sets it for one call. A change applies from the next call.",
  },
  "asr.final.model": {
    type: "string",
    values: FINAL_MODELS,
    default: "auto",
    doc: "The model that writes the final transcript after a call: `auto`, or a model's id (`qwen3-asr-1.7b`, `parakeet-tdt-0.6b-v3-fp32`; `qwen` and `parakeet` name the same). `qwen`: Qwen3-ASR on its llama-server, the most accurate; it gives no word times, so each line keeps the times of the stretch it was cut from. While the pass runs it holds about 3 GB of memory and the GPU when there is one. Without a GPU it decodes on the processor, much slower, and a pass gets half the call's length plus 300 s before it is stopped as stuck, so on such a machine a long call can fail: set `parakeet` there. One Qwen pass runs at a time; another waits for it. `parakeet`: Parakeet, on the processor. `auto` picks `qwen` whenever its model and its llama-server are downloaded, else `parakeet`. A model that is not downloaded never runs: the setting falls back to the other model and says why in the log, and with neither downloaded no pass runs. On Qwen the pass does not need Parakeet on disk. Speaker labels are the same with either. A Qwen that cannot start, or fails twice in a row, fails the pass, and `akou finalize --force` runs it again. `akou finalize --model` sets it for one run, and is refused when that model is not downloaded; a pass stopped by a quit runs again at the next start on this setting's model. A change applies from the next pass.",
  },
  "asr.review.everySeconds": {
    type: "integer",
    min: REVIEW_EVERY_MIN,
    max: REVIEW_EVERY_MAX,
    default: REVIEW_EVERY_SECONDS,
    doc: "How often the second pass (`asr.review.model`) reviews, seconds: the reviewed text lands about this long after the words. `akou start --review-every` sets it for one call.",
  },
  "asr.live.engine": {
    type: "string",
    values: LIVE_ENGINE_SETTINGS,
    default: "auto",
    doc: "The streaming model that writes the live transcript when `asr.live` resolves to `nemotron`: `auto` picks by `asr.languages` (English only: `nemotron-en-560`; Spanish only: `nemotron-3.5-1120`; anything else: `nemotron-3.5-560`, which follows a switch of language), or name one. The other chunk sizes (`nemotron-en-80`, `nemotron-en-160`, `nemotron-en-1120`, `nemotron-3.5-80`, `nemotron-3.5-160`, `nemotron-3.5-320`) run only when named: a shorter chunk writes a word sooner, and `auto` never picks one. A word it shows is never taken back. Its model is fetched with `akou models pull <name>`; while none is downloaded, live lines come from Parakeet re-decoding pauses. A change applies from the next call; a running call keeps its model.",
  },
  "asr.segmentPause": {
    type: "number",
    min: 0.2,
    max: 5,
    default: 0.7,
    doc: "Silence that closes a live segment, seconds. Must be below `asr.segmentWindow`.",
  },
  "asr.segmentWindow": {
    type: "number",
    min: 2,
    max: 30,
    default: 12,
    doc: "Longest live segment, seconds.",
  },
  "provider.kind": {
    type: "string",
    values: ["harness", "openai-compatible", "anthropic", "none"],
    default: "harness",
    doc: "What answers questions and writes enhanced notes: your own Claude Code or Codex (`harness`), an OpenAI-compatible server, the Anthropic API with your key, or `none` (excerpts only).",
  },
  "provider.harness": {
    type: "string",
    values: ["auto", "claude", "codex"],
    default: "auto",
    doc: "Which harness `harness` runs. `auto`: Claude Code if found, else Codex.",
  },
  "provider.harnessPath": {
    type: "string",
    default: "",
    apiWritable: false,
    doc: "Pin the harness program by absolute path. Empty: look it up on PATH and through the login shell.",
  },
  "provider.baseUrl": {
    type: "string",
    default: "",
    // Where your key and transcripts go: set on the Settings page in the desktop window or in the
    // file, never by an HTTP client, so the API token cannot send your calls to a chosen host.
    apiWritable: false,
    windowWritable: true,
    doc: "Server address for `openai-compatible` (Ollama: `http://127.0.0.1:11434/v1`), or another Anthropic API address. Set it in the akou window or the config file, never over the API: it decides where your key and transcripts are sent.",
  },
  "provider.model": {
    type: "string",
    max: 200,
    default: "",
    doc: "Model id for `openai-compatible` (required) and `anthropic` (empty: the default model).",
  },
  "provider.apiKey": {
    type: "string",
    max: 400,
    default: "",
    secret: true,
    // Never the value in the error: it is the key.
    check: (v) =>
      KEY_TEXT.test(v as string)
        ? null
        : "must be letters, digits and symbols only, with no spaces",
    doc: "API key for `openai-compatible` (optional) or `anthropic` (required). On macOS it is saved in the Keychain, never in the config file; elsewhere in the config file. Never shown back or logged.",
  },
  "provider.timeoutSeconds": {
    type: "integer",
    min: 10,
    max: 600,
    default: 60,
    doc: "How long an answer may take before akou shows the excerpts instead and says why.",
  },
  "provider.harnessResume": {
    type: "boolean",
    default: false,
    doc: "Reuse one Claude Code session for follow-up questions on a call (`--resume`), sending only what is new since the last question. Off until measured to cut the tokens per follow-up by at least 40 % (docs/providers.md). With it on, Claude Code keeps those sessions in its own history.",
  },
  "memo.provider": {
    type: "string",
    values: ["auto", "on", "off"],
    default: "auto",
    doc: "Whether the configured provider keeps the rolling memo during a call, every few minutes of new speech. `auto`: on for `openai-compatible` and `anthropic`, off for `harness`, because it would run your subscription unattended; `on`: the harness too; `off`: never. An agent can always write it with `akou_memo_put`.",
  },
  "export.dir": {
    type: "string",
    default: "",
    doc: "Folder finished calls are exported into, one subfolder per workspace: Markdown with frontmatter, the event log and the audio. Empty: no export until you set it.",
  },
  "export.audio": {
    type: "string",
    values: ["link", "copy", "none"],
    default: "link",
    doc: "How the export carries the audio: a link to the call's file, a copy, or nothing.",
  },
  hooks: {
    type: "hooks",
    default: [],
    apiWritable: false,
    doc: 'Commands run after a call, each given the call as JSON on stdin: `[{"stage": "call.ended" | "final.done" | "enhanced", "command": "…", "timeoutSec": 600, "workspace": "work"}]`. File only: they are programs akou runs.',
  },
  "webhook.url": {
    type: "string",
    default: "",
    apiWritable: false,
    doc: "Address the call is POSTed to at every hand-off stage, signed with `webhook.secret`. Empty: off. File only: it decides where your transcripts are sent.",
  },
  "webhook.secret": {
    type: "string",
    max: 400,
    default: "",
    secret: true,
    doc: "Secret for the webhook's HMAC-SHA256 signature (`X-Akou-Signature`). The webhook stays off until it is set. Never shown back or logged.",
  },
  "vocab.extraFiles": {
    type: "string[]",
    default: [],
    doc: "Extra vocabulary files layered over the global and workspace files.",
  },
  "vocab.languages": {
    type: "string[]",
    values: DICTIONARY_LANGUAGES,
    default: [],
    doc: `Languages whose word lists tell a real word from a mishearing, so a vocabulary file never "corrects" a real word. Empty: every list akou ships (${DICTIONARY_LANGUAGES.join(", ")}). A language the recognizer detects in a call is added.`,
  },
  "dictation.enabled": {
    type: "boolean",
    default: false,
    doc: "Dictation: hold the dictation key, speak, and the text is inserted where the cursor is (docs/ux/DICTATION.md). Off: the helper's dictate process is not started and no key is taken.",
  },
  "dictation.activation": {
    type: "string",
    values: ACTIVATIONS,
    default: "hold-or-toggle",
    doc: "How the dictation key works: `hold-or-toggle` (a press of 300 ms or more is push-to-talk, a shorter tap latches listening on until the next tap), `hold` (push-to-talk only) or `toggle` (a tap starts, the next tap stops).",
  },
  "dictation.hotkey": {
    type: "string",
    max: 60,
    default: "",
    check: (v) => checkDictationHotkey(v as string),
    doc: "The dictation key: a modifier alone with its side (`RightCommand`, `RightControl`, `RightOption`, `RightShift`, the Left ones, `Fn`) or a chord (`Control+Shift+Space`). Empty: `RightCommand` on macOS, `RightControl` on Windows, `Control+Shift+Space` on Linux, where the desktop's shortcut portal binds chords only. A change applies at once; a key the helper cannot bind is refused and the old one stays.",
  },
  "dictation.hotkeyFixLast": {
    type: "string",
    max: 60,
    default: "",
    check: (v) => checkExtraHotkey(v as string),
    doc: "Opens the last dictation in the draft box to correct it and teach akou the word. Empty: Shift held before a modifier-only dictation key goes down (`Shift+RightCommand`), else `Control+Shift+Period`.",
  },
  "dictation.hotkeyDraft": {
    type: "string",
    max: 60,
    default: "",
    check: (v) => checkExtraHotkey(v as string),
    doc: "A second key that dictates into the draft box instead of the app, so you read the text before it goes anywhere. Empty: none.",
  },
  "dictation.hotkeyPasteLast": {
    type: "string",
    max: 60,
    default: "",
    check: (v) => checkExtraHotkey(v as string),
    doc: "Inserts the last dictation's text again. Empty: none.",
  },
  "dictation.silenceStopSeconds": {
    type: "integer",
    min: 0,
    max: 600,
    default: 30,
    doc: "A latched dictation (tapped on, not held) stops after this many seconds without speech, and its audio is still transcribed. 0: never.",
  },
  "dictation.maxMinutes": {
    type: "integer",
    min: 1,
    max: 60,
    default: 20,
    doc: "Any dictation stops at this length, with a warning a minute before; its audio is still transcribed.",
  },
  "dictation.mic": {
    type: "string",
    max: 200,
    default: "",
    doc: "The microphone dictation listens on, a device id from `GET /devices`. Empty: the system default.",
  },
  "dictation.preferBuiltInOverBluetooth": {
    type: "boolean",
    default: true,
    doc: "When the default microphone is a Bluetooth headset and the built-in one is there, dictate on the built-in one, so the headset keeps its good sound profile.",
  },
  "dictation.warmMic": {
    type: "string",
    values: ["off", "auto", "always"],
    default: "auto",
    doc: "How long the microphone stays open. `auto`: from the first press until 30 s after each dictation, so a quick follow-up keeps its first syllable; `always`: while dictation is on; `off`: only while the key is down. Never kept open on a Bluetooth microphone.",
  },
  "dictation.engine": {
    type: "string",
    values: DICTATION_ENGINES,
    default: "auto",
    doc: "What decodes a dictation. `fast`: Parakeet, already loaded, about 0.1 s for 5 s of speech; `best`: Qwen3-ASR, kept warm while dictation is on, falling back to fast when it fails or is too slow, and downloaded when missing (fast until it lands); `auto`: best where Qwen runs on a GPU and is downloaded, fast elsewhere; `remote`: another akou (`dictation.remote.url`), with no local model needed.",
  },
  "dictation.final": {
    type: "string",
    values: DICTATION_FINALS,
    default: "live",
    doc: "The text a dictation inserts, while `dictation.engine` is `auto` (`fast`, `best` and `remote` there win; the Dictation page sets both). `live`, the default and the fastest: the words the streaming model showed as you spoke, inserted the moment you let go, with no second decode, and less accurate than Parakeet; while no streaming model is downloaded, Parakeet inserts. `parakeet`: Parakeet decodes the whole recording at the release, with your word list. `qwen`: Qwen3-ASR, the most accurate, kept warm while dictation is on, as `dictation.engine` `best`. Whatever this says, the words while you speak come from the streaming model when one is downloaded (`akou models pull nemotron-3.5-560`), else from Parakeet twice a second.",
  },
  "dictation.localTimeoutSeconds": {
    type: "integer",
    min: 2,
    max: 120,
    default: 10,
    doc: "How long a local `best` may take, plus 0.2 s per second of audio, before the dictation is decoded with `fast` instead and says so.",
  },
  "dictation.remote.url": {
    type: "string",
    max: 2000,
    default: "",
    // Where dictation audio goes: set on the page in the desktop window or in the file, never by
    // an HTTP client, so the API token cannot send your dictations to a chosen host.
    apiWritable: false,
    windowWritable: true,
    check: (v) => {
      const url = (v as string).trim();
      if (url === "") return null;
      // The URL checks of `server.remotes`, whose lines also name a key file; any path does here.
      if (/\s/.test(url)) return `${JSON.stringify(url)} is not a URL`;
      return (
        checkRemotes([`${url} /`])?.replace(
          "its key goes in the key file",
          "the key is dictation.remote.key",
        ) ?? null
      );
    },
    doc: "The other akou a `remote` dictation is sent to: an `https` address, or `http` to a loopback, private or Tailscale address only. Set it in the akou window or the config file, never over the API: it decides where your dictation audio goes.",
  },
  "dictation.remote.key": {
    type: "string",
    max: 400,
    default: "",
    secret: true,
    doc: "A `jobs` key of the remote akou, sent as the bearer of every remote dictation. Never shown back or logged; applies to the next dictation.",
  },
  "dictation.remote.fallback": {
    type: "string",
    values: ["local", "error"],
    default: "local",
    doc: "When the remote gives no transcript: `local` decodes on this machine and says so; `error` shows the error with Retry, Copy and Open draft. With no local model installed it is `error`.",
  },
  "dictation.remote.timeoutSeconds": {
    type: "integer",
    min: 1,
    max: 60,
    default: 6,
    doc: "How long the remote may take before any audio, plus 0.25 s per second of audio, before the fallback runs.",
  },
  "asr.qwenIdleMinutes": {
    type: "integer",
    min: 0,
    max: 1440,
    default: 0,
    doc: "Stop the Qwen3-ASR server kept warm for dictation after this many idle minutes, to get its memory back; the next dictation starts it again. 0: never.",
  },
  "dictation.language": {
    type: "string",
    max: 4,
    default: "auto",
    check: (v) =>
      v === "auto" || LANGUAGE.test(v as string) ? null : "is auto or an ISO 639 code (en, es)",
    doc: "The language of a dictation: `auto` lets the engine choose among `dictation.languages`; a code (`en`) forces it on `best` and on a remote. `fast` picks the language itself.",
  },
  "dictation.languages": {
    type: "string[]",
    default: [],
    check: (v) =>
      (v as readonly string[]).every((c) => LANGUAGE.test(c))
        ? null
        : "is a list of ISO 639 codes, for example en and es",
    doc: "The languages an `auto` dictation may choose among. Empty: `asr.languages`, so editing this never changes how calls are transcribed.",
  },
  "dictation.glossary": {
    type: "string",
    values: ["off", "on"],
    default: "off",
    doc: "Send your learned dictation words to the recognizer as context. Off until a measured evaluation shows it helps without inventing names; learned words are always applied as replacements either way.",
  },
  "dictation.glossaryMax": {
    type: "integer",
    min: 1,
    max: 24,
    default: 24,
    doc: "The most learned words sent as context, by recency and use; 24 is what the decoder and the remote route take.",
  },
  "dictation.insert": {
    type: "string",
    values: DICTATION_INSERTS,
    default: "paste",
    doc: "How the text goes in: `paste` through the clipboard, which comes back afterwards; `type` as key presses, for remote desktops and fields that refuse a paste (a text with a line break is pasted, so no Return is pressed); `clipboard` only, and you paste.",
  },
  "dictation.sendKey": {
    type: "string",
    values: DICTATION_SEND_KEYS,
    default: "Enter",
    doc: "The key pressed to send after the text is in, once the app has read it: on Enter during a dictation, Ctrl+Enter in the draft box, or after every dictation with `dictation.sendAlways`. `none`: never.",
  },
  "dictation.sendAlways": {
    type: "boolean",
    default: false,
    doc: "Press the send key after every direct dictation.",
  },
  "dictation.restoreClipboard": {
    type: "boolean",
    default: true,
    doc: "Put the old clipboard back once the app has read the dictation. Off: the dictation stays in the clipboard.",
  },
  "dictation.smartSpacing": {
    type: "boolean",
    default: true,
    doc: "Add the spaces around the text, and lower-case its first word mid-sentence, from the text around the cursor.",
  },
  "dictation.trailingSpace": {
    type: "boolean",
    default: false,
    doc: "Where the text around the cursor cannot be read, end every dictation with a space.",
  },
  "dictation.spokenPunctuation": {
    type: "boolean",
    default: false,
    doc: "Replace spoken punctuation (`comma`, `new line`; Spanish `coma`, `nueva línea`) when it stands alone between pauses. Off until measured, since both engines punctuate already and `period` is often just a word.",
  },
  "dictation.fillers": {
    type: "boolean",
    default: true,
    doc: "Leave out filler words (`um`, `uh`; Spanish `eh`, `este` alone) from the inserted text; history keeps what was said.",
  },
  "dictation.spokenSend": {
    type: "boolean",
    default: false,
    doc: "A dictation ending in `send it` (Spanish `envíalo`) leaves those words out and presses the send key.",
  },
  "dictation.format": {
    type: "string",
    values: DICTATION_FORMATS,
    default: "off",
    doc: "`provider`: pass the text through your configured provider first, with the prompt `dictation.formatPrompt`, to fix punctuation and casing. History keeps the raw text; a provider past the timeout is skipped. It runs on Retry and on every clip sent to `POST /v1/dictations` (`akou dictate FILE`) too, so a script posting clips asks the provider once per clip.",
  },
  "dictation.formatPrompt": {
    type: "string",
    min: 1,
    max: 100,
    default: "default",
    check: (v) =>
      /^[A-Za-z0-9._-]+$/.test(v as string) ? null : "is a preset name: letters, digits, . _ -",
    doc: "The formatting prompt: `default`, or the name of a file in `dictation-prompts/` in the config folder, without `.md`.",
  },
  "dictation.formatTimeoutSeconds": {
    type: "integer",
    min: 0,
    max: 60,
    default: 0,
    doc: "How long the formatting pass may take before the raw text is inserted. 0: 15 s for Claude Code, 4 s for an API or a local model.",
  },
  "dictation.muteMedia": {
    type: "boolean",
    default: false,
    doc: "Pause playing media while you dictate, through the system's media controls, and resume only what akou paused.",
  },
  "dictation.learn": {
    type: "string",
    values: ["off", "ask", "auto"],
    default: "ask",
    doc: "When you fix a word akou heard wrong: `ask` offers to learn it once, and ignoring the offer changes nothing; `auto` learns it with an Undo; `off` never looks.",
  },
  "dictation.readField": {
    type: "boolean",
    default: true,
    doc: "Read the field you dictated into, for smart spacing and to learn from your fixes there. Never a password field or a terminal; on macOS only once the Accessibility grant the paste needs is there.",
  },
  "dictation.learn.audioCheck": {
    type: "boolean",
    default: true,
    doc: "Before offering a word, decode the dictation again with it on Qwen3-ASR and offer it only if the audio agrees. Where Qwen3-ASR does not run here, the offer says it was not checked.",
  },
  "dictation.apps": {
    type: "apps",
    default: [],
    doc: 'Per-app dictation rules, matched on the app that had the keyboard: `[{"app": "com.example.chat", "mode": "draft-send", "insert": "paste", "sendKey": "Enter", "engine": "auto", "language": "en", "format": "off"}]`. `app` is a bundle id (macOS), an executable name (Windows) or a window class (Linux); `name`, optional, is the name of the app the rule is shown by (`Slack`) and is never matched; a field left out follows the global setting. `mode`: `draft` opens the draft box instead of inserting, `draft-send` too with Enter there pressing the send key.',
  },
  "dictation.pill": {
    type: "string",
    values: ["top", "bottom", "left", "right", "off"],
    default: process.platform === "linux" ? "off" : "top",
    doc: "Where the dictation pill shows `listening` and `transcribing`: `top` is the island at the top centre of the display. Off by default on Linux, where a compositor may give the pill the keyboard and the text would land in it, so turn it on there knowingly; the tray and the sounds carry the state instead.",
  },
  "dictation.pillPreview": {
    type: "boolean",
    default: true,
    doc: "Show the words as you speak on the pill's island. akou cannot hide its windows from screen capture yet (DK-P3), so a screen share shows them too: turn this off before sharing your screen if that matters.",
  },
  "dictation.sounds": {
    type: "string",
    values: ["auto", "off", "soft", "click"],
    default: "auto",
    doc: "Cues at start, stop, cancel and done. `auto`: `soft` while the pill is off, silent while it shows, so a dictation is never both silent and invisible.",
  },
  "dictation.retainDays": {
    type: "integer",
    min: 0,
    max: 3650,
    default: 30,
    doc: "Days a dictation's text and audio are kept; older ones leave only a tombstone. 0: only the last one, for paste last and fix last.",
  },
  "dictation.keepAudio": {
    type: "boolean",
    default: true,
    doc: "Keep each dictation's audio for Retry and for checking a learned word. Off: deleted once the offer to learn is closed.",
  },
  "server.dictation_slots": {
    type: "integer",
    min: 0,
    max: 8,
    default: 1,
    doc: "Workers kept for dictating clients (`interactive=true`): they never take queued jobs, and a dictation is never refused by the queue limits. 0: a dictation queues like any job. Applies at the next start.",
  },
  "server.dictation_engine": {
    type: "string",
    min: 1,
    max: 100,
    default: "auto",
    doc: "The preset or model a dictating client's request runs when it names none. `auto`: the server's default.",
  },
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;

type ValueOf<T extends SettingType> = T extends "integer" | "number"
  ? number
  : T extends "boolean"
    ? boolean
    : T extends "string"
      ? string
      : T extends "hooks"
        ? readonly HookConfig[]
        : T extends "apps"
          ? readonly AppRule[]
          : readonly string[];

export type Settings = { -readonly [K in SettingKey]: ValueOf<(typeof SETTINGS)[K]["type"]> };

/** Keys refused with a reason of their own, beyond "unknown key". */
const FORBIDDEN: Readonly<Record<string, string>> = {
  "vocab.boost":
    "there is no global boost setting: it is the constant 1.5, used only when `asr.parakeet.decoding` is `beam`; a word the engine keeps missing gets its own boost, up to 5, as `decode` in its vocabulary file entry",
};

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export interface SettingIssue {
  key: string;
  source: "file" | "env" | "api";
  message: string;
}

/** Checks one value against its spec. Returns the value to store, or an error message. */
export function validateSetting(
  key: string,
  value: unknown,
): { ok: true; key: SettingKey; value: SettingValue } | { ok: false; error: string } {
  const forbidden = FORBIDDEN[key];
  if (forbidden) return { ok: false, error: `${key}: ${forbidden}` };
  if (!isSettingKey(key)) return { ok: false, error: `${key}: unknown setting` };
  const spec: SettingSpec = SETTINGS[key];
  const range = `${spec.min ?? "-inf"} to ${spec.max ?? "inf"}`;
  switch (spec.type) {
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `${key}: must be a number` };
      }
      if (spec.type === "integer" && !Number.isInteger(value)) {
        return { ok: false, error: `${key}: must be a whole number` };
      }
      if (spec.also?.includes(value)) return { ok: true, key, value };
      if (
        (spec.min !== undefined && value < spec.min) ||
        (spec.max !== undefined && value > spec.max)
      ) {
        return { ok: false, error: `${key}: ${value} is out of range (${range})` };
      }
      return { ok: true, key, value };
    }
    case "boolean": {
      if (typeof value !== "boolean") return { ok: false, error: `${key}: must be true or false` };
      const wrong = spec.check?.(value);
      if (wrong) return { ok: false, error: `${key}: ${wrong}` };
      return { ok: true, key, value };
    }
    case "string": {
      if (typeof value !== "string") return { ok: false, error: `${key}: must be a string` };
      if (spec.values && !spec.values.includes(value)) {
        return { ok: false, error: `${key}: must be one of ${spec.values.join(", ")}` };
      }
      if (
        (spec.min !== undefined && value.length < spec.min) ||
        (spec.max !== undefined && value.length > spec.max)
      ) {
        return { ok: false, error: `${key}: length must be ${range}` };
      }
      const wrong = spec.check?.(value);
      if (wrong) return { ok: false, error: `${key}: ${wrong}` };
      return { ok: true, key, value };
    }
    case "string[]": {
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v !== "")) {
        return { ok: false, error: `${key}: must be a list of non-empty strings` };
      }
      const bad = spec.values && value.find((v) => !spec.values?.includes(v));
      if (bad) {
        return { ok: false, error: `${key}: ${bad} is not one of ${spec.values?.join(", ")}` };
      }
      const wrong = spec.check?.(value);
      if (wrong) return { ok: false, error: `${key}: ${wrong}` };
      return { ok: true, key, value: [...value] };
    }
    case "hooks": {
      const h = validateHooks(value);
      return h.ok ? { ok: true, key, value: h.value } : { ok: false, error: `${key}: ${h.error}` };
    }
    case "apps": {
      const a = validateApps(value);
      return a.ok ? { ok: true, key, value: a.value } : { ok: false, error: `${key}: ${a.error}` };
    }
  }
}

/** Each field of a per-app rule and the values it takes; `app`, `name` and `language` are checked apart. */
const APP_FIELDS: Readonly<Record<string, readonly string[] | null>> = {
  app: null,
  name: null,
  mode: APP_MODES,
  insert: DICTATION_INSERTS,
  sendKey: DICTATION_SEND_KEYS,
  engine: DICTATION_ENGINES,
  language: null,
  format: DICTATION_FORMATS,
};

/** Checks `dictation.apps` (DC-U9): every rule names an app once, with known fields only. */
export function validateApps(
  value: unknown,
): { ok: true; value: AppRule[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "must be a list of app rules" };
  const out: AppRule[] = [];
  const seen = new Set<string>();
  for (const [i, r] of value.entries()) {
    const at = `rule ${i + 1}`;
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      return { ok: false, error: `${at} must be an object` };
    }
    const o = r as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !Object.hasOwn(APP_FIELDS, k));
    if (unknown) return { ok: false, error: `${at}: unknown field "${unknown}"` };
    if (typeof o.app !== "string" || o.app.trim() === "" || o.app.length > 200) {
      return {
        ok: false,
        error: `${at}: app must be a bundle id, executable name or window class`,
      };
    }
    if (o.name !== undefined && (typeof o.name !== "string" || o.name.length > 200)) {
      return { ok: false, error: `${at}: name must be the app's name, up to 200 characters` };
    }
    if (seen.has(o.app)) return { ok: false, error: `${at}: ${o.app} already has a rule` };
    seen.add(o.app);
    for (const [k, values] of Object.entries(APP_FIELDS)) {
      const v = o[k];
      if (v === undefined || values === null) continue;
      if (!values.includes(v as string)) {
        return { ok: false, error: `${at}: ${k} must be one of ${values.join(", ")}` };
      }
    }
    if (
      o.language !== undefined &&
      (typeof o.language !== "string" || !(o.language === "auto" || LANGUAGE.test(o.language)))
    ) {
      return { ok: false, error: `${at}: language must be auto or an ISO 639 code` };
    }
    out.push({ ...(o as unknown as AppRule) });
  }
  return { ok: true, value: out };
}

const HOOK_FIELDS = new Set(["stage", "command", "timeoutSec", "workspace", "name"]);

/** Checks the `hooks` list: every entry a known stage and a command, nothing else. */
export function validateHooks(
  value: unknown,
): { ok: true; value: HookConfig[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "must be a list of hooks" };
  const out: HookConfig[] = [];
  for (const [i, h] of value.entries()) {
    const at = `hook ${i + 1}`;
    if (typeof h !== "object" || h === null || Array.isArray(h)) {
      return { ok: false, error: `${at} must be an object` };
    }
    const o = h as Record<string, unknown>;
    const unknown = Object.keys(o).find((k) => !HOOK_FIELDS.has(k));
    if (unknown) return { ok: false, error: `${at}: unknown field "${unknown}"` };
    if (!HOOK_STAGES.includes(o.stage as HookStage)) {
      return { ok: false, error: `${at}: stage must be one of ${HOOK_STAGES.join(", ")}` };
    }
    const cmd = o.command;
    const okCmd =
      (typeof cmd === "string" && cmd.trim() !== "") ||
      (Array.isArray(cmd) &&
        cmd.length > 0 &&
        cmd.every((c) => typeof c === "string") &&
        cmd[0] !== "");
    if (!okCmd) {
      return { ok: false, error: `${at}: command must be a string or a list of strings` };
    }
    const t = o.timeoutSec;
    if (t !== undefined && (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 3600)) {
      return { ok: false, error: `${at}: timeoutSec must be a whole number from 1 to 3600` };
    }
    if (o.workspace !== undefined && typeof o.workspace !== "string") {
      return { ok: false, error: `${at}: workspace must be a string` };
    }
    if (o.name !== undefined && (typeof o.name !== "string" || o.name.trim() === "")) {
      return { ok: false, error: `${at}: name must be a non-empty string` };
    }
    out.push({
      stage: o.stage as HookStage,
      command: Array.isArray(cmd) ? [...(cmd as string[])] : (cmd as string),
      ...(t !== undefined ? { timeoutSec: t as number } : {}),
      ...(o.workspace !== undefined ? { workspace: o.workspace as string } : {}),
      ...(o.name !== undefined ? { name: o.name as string } : {}),
    });
  }
  return { ok: true, value: out };
}

/** Parses an environment value by the setting's type (`1`/`true` and `0`/`false` for booleans). */
function fromEnv(spec: SettingSpec, raw: string): unknown {
  switch (spec.type) {
    case "boolean":
      if (/^(1|true|yes)$/i.test(raw)) return true;
      if (/^(0|false|no|)$/i.test(raw)) return false;
      return raw;
    case "integer":
    case "number":
      return raw.trim() === "" ? raw : Number(raw);
    case "string[]":
      return raw.split(",").filter((s) => s !== "");
    case "string":
    case "hooks":
    case "apps":
      return raw;
  }
}

/** Where akou keeps its own files. `AKOU_HOME` moves all of them, for tests. */
export interface Paths {
  home: string;
  configDir: string;
  configFile: string;
}

export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): Paths {
  const akouHome = env.AKOU_HOME;
  const h = akouHome ?? homedir();
  // With AKOU_HOME the config folder is inside it on every OS, never in %APPDATA%.
  const configDir = akouHome
    ? join(akouHome, ".config", "akou")
    : defaultConfigDir(env, platform, h);
  return { home: h, configDir, configFile: join(configDir, "config.json") };
}

/** Defaults, with the machine-dependent ones computed from `home`. */
export function resolveDefaults(paths: Paths): Settings {
  const out = {} as Record<string, SettingValue>;
  for (const k of SETTING_KEYS) {
    const d = SETTINGS[k].default as SettingValue;
    out[k] = Array.isArray(d) ? [...d] : d;
  }
  out["recordings.root"] = join(paths.home, "Recordings", "akou");
  if (paths.home !== homedir()) {
    out["asr.modelsDir"] = join(paths.home, ".local", "share", "akou", "models");
  }
  return out as Settings;
}

export interface LoadedConfig {
  settings: Settings;
  /** What the file set, after validation: what `PATCH /config` edits and writes back. */
  file: Partial<Record<SettingKey, SettingValue>>;
  issues: SettingIssue[];
  paths: Paths;
}

/** Cross-field rules, checked after every key has its value. Returns the keys to reset. */
function crossCheck(s: Settings): { key: SettingKey; message: string }[] {
  const out: { key: SettingKey; message: string }[] = [];
  if (s["asr.segmentPause"] >= s["asr.segmentWindow"]) {
    out.push({
      key: "asr.segmentPause",
      message: `asr.segmentPause (${s["asr.segmentPause"]}) must be below asr.segmentWindow (${s["asr.segmentWindow"]})`,
    });
  }
  if (s["dictation.engine"] === "remote" && s["dictation.remote.url"].trim() === "") {
    out.push({
      key: "dictation.engine",
      message: "dictation.engine: remote needs dictation.remote.url, the akou to send the audio to",
    });
  }
  return out;
}

/**
 * Old values rewritten in today's keys, so a file or a `PATCH /config` that carries one keeps
 * working and the next save writes the new form: `asr.live` `upgrade` is `nemotron` with
 * `asr.review.model` `qwen` (unless it names its own). And short names read as the ids they name:
 * `asr.final.model` `qwen` and `parakeet`.
 */
export function legacyValues(values: Record<string, unknown>): Record<string, unknown> {
  const short = values["asr.final.model"];
  if (short === "qwen" || short === "parakeet") {
    values = { ...values, "asr.final.model": finalModelId(short) };
  }
  if (values["asr.live"] !== "upgrade") return values;
  return {
    ...values,
    "asr.live": "nemotron",
    ...("asr.review.model" in values ? {} : { "asr.review.model": "qwen" }),
  };
}

/** Applies file values over defaults, then the environment, validating each. */
export function buildSettings(
  paths: Paths,
  fileValues: Record<string, unknown>,
  env: Record<string, string | undefined>,
  source: "file" | "api" = "file",
): LoadedConfig {
  const defaults = resolveDefaults(paths);
  const settings = { ...defaults } as Record<string, SettingValue>;
  const file: Partial<Record<SettingKey, SettingValue>> = {};
  const issues: SettingIssue[] = [];
  for (const [key, value] of Object.entries(legacyValues(fileValues))) {
    const v = validateSetting(key, value);
    if (!v.ok) {
      issues.push({ key, source, message: `${v.error}; using the default` });
      continue;
    }
    settings[v.key] = v.value;
    file[v.key] = v.value;
  }
  for (const key of SETTING_KEYS) {
    const spec: SettingSpec = SETTINGS[key];
    if (!spec.env) continue;
    const raw = env[spec.env];
    if (raw === undefined) continue;
    const v = validateSetting(key, fromEnv(spec, raw));
    if (!v.ok) {
      issues.push({ key, source: "env", message: `${spec.env}: ${v.error}; ignored` });
      continue;
    }
    settings[key] = v.value;
  }
  for (const bad of crossCheck(settings as Settings)) {
    issues.push({ key: bad.key, source, message: `${bad.message}; using the defaults` });
    const reset: readonly SettingKey[] =
      bad.key === "dictation.engine"
        ? ["dictation.engine"]
        : ["asr.segmentPause", "asr.segmentWindow"];
    for (const k of reset) {
      settings[k] = defaults[k];
      delete file[k];
    }
  }
  return { settings: settings as Settings, file, issues, paths };
}

/** Reads `config.json` (if any), validates every key, and applies the environment. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): LoadedConfig {
  const paths = resolvePaths(env, platform);
  let values: Record<string, unknown> = {};
  const issues: SettingIssue[] = [];
  if (existsSync(paths.configFile)) {
    try {
      const parsed = JSON.parse(readFileSync(paths.configFile, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        issues.push({
          key: "*",
          source: "file",
          message: "config.json must be a JSON object; using the defaults",
        });
      } else {
        values = parsed as Record<string, unknown>;
      }
    } catch (err) {
      issues.push({
        key: "*",
        source: "file",
        message: `config.json is not valid JSON (${(err as Error).message}); using the defaults`,
      });
    }
  }
  const loaded = buildSettings(paths, values, env);
  loaded.issues.unshift(...issues);
  return loaded;
}

/**
 * Validates a `PATCH /config` body: `{key: value}` to set, `{key: null}` to go back to the default.
 * Returns the new file contents, or every error at once. Settings that name a program are refused;
 * a `windowWritable` one is taken only `inProcess`, from the desktop window.
 */
export function patchConfig(
  current: Partial<Record<SettingKey, SettingValue>>,
  patch: Record<string, unknown>,
  paths: Paths,
  o: { inProcess?: boolean } = {},
): { ok: true; file: Partial<Record<SettingKey, SettingValue>> } | { ok: false; errors: string[] } {
  const next = { ...current };
  const errors: string[] = [];
  for (const [key, value] of Object.entries(legacyValues(patch))) {
    const spec = isSettingKey(key) ? (SETTINGS[key] as SettingSpec) : null;
    if (spec?.apiWritable === false && !(o.inProcess && spec.windowWritable)) {
      if (spec.windowWritable) {
        errors.push(
          `${key}: set it in the akou window or config.json; it is not writable over the API`,
        );
        continue;
      }
      errors.push(`${key}: set it in config.json; it is not writable over the API`);
      continue;
    }
    if (value === null) {
      if (!isSettingKey(key)) errors.push(`${key}: unknown setting`);
      else delete next[key];
      continue;
    }
    const v = validateSetting(key, value);
    if (!v.ok) errors.push(v.error);
    else next[v.key] = v.value;
  }
  if (errors.length === 0) {
    const check = buildSettings(paths, next, {}, "api");
    for (const i of check.issues) errors.push(i.message.replace(/; using the defaults?$/, ""));
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, file: next };
}

/** The settings with every secret replaced by `set` or empty: what may be shown or sent back. */
export function redactSettings<T extends Partial<Record<SettingKey, SettingValue>>>(values: T): T {
  const out = { ...values } as Record<string, SettingValue>;
  for (const k of SETTING_KEYS) {
    if ((SETTINGS[k] as SettingSpec).secret && typeof out[k] === "string" && out[k] !== "") {
      out[k] = "(set)";
    }
  }
  return out as T;
}

/** The reference table, generated from the registry. */
export function settingsReference(): string {
  const rows = SETTING_KEYS.map((k) => {
    const s: SettingSpec = SETTINGS[k];
    const range =
      s.type === "integer" || s.type === "number"
        ? `${s.min} to ${s.max}${s.also ? ` or ${s.also.join(", ")}` : ""}`
        : "";
    const d = Array.isArray(s.default)
      ? s.type === "hooks" || s.type === "apps"
        ? "[]"
        : `[${(s.default as readonly string[]).join(", ")}]`
      : String(s.default);
    return `| \`${k}\` | ${s.type} | ${range} | ${k.includes("Dir") || k.includes("root") ? "per OS" : `\`${d}\``} | ${s.env ? `\`${s.env}\`` : ""} | ${s.doc} |`;
  });
  return [
    "| Key | Type | Range | Default | Environment | Meaning |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
