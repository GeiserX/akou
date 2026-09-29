/**
 * What the Settings page calls each setting (docs/ux/design-explorations/sd-a-settings.html): a
 * human label, at most one short line of help, the unit of a number, what an empty value means,
 * and a name for each choice. The page shows these words and never the setting's key, a file
 * path of akou's own, or a value in code quotes; the registry's `doc` stays the reference for the
 * CLI and the docs.
 *
 * `tests/ui/settings-labels.test.ts` fails when a key the Settings page shows has no words here, or
 * when the words quote a key.
 */

export interface SettingWords {
  label: string;
  help?: string;
  /** The unit after a number: "seconds". */
  unit?: string;
  /** What an empty value means, shown in the empty field: "The default model". */
  empty?: string;
  /** A name for each value of a choice, in the order to offer them. */
  choices?: readonly (readonly [value: string, label: string])[];
}

export const WORDS: Readonly<Record<string, SettingWords>> = {
  "user.name": { label: "Your name", help: "Labels your side of every call.", empty: "You" },
  "app.openAtLogin": {
    label: "Open akou at login",
    help: "It waits in the menu bar, so the shortcuts always work.",
  },
  "recordings.root": { label: "Recordings folder" },
  "export.dir": { label: "Copy finished calls to" },
  "capture.call": {
    label: "Call audio",
    choices: [
      ["system", "Whole computer"],
      ["app", "One app"],
      ["none", "None"],
    ],
  },
  "capture.mic": { label: "Your microphone", help: "None records only the other people." },
  "asr.languages": {
    label: "Languages on calls",
    help: "Picks the live model. English only or Spanish only gets a model made for it.",
  },
  "app.floatingIndicator": {
    label: "Floating bar while recording",
    help: "Time, levels, Mute, Ask and Stop. It shows no transcript, so it can stay up during a screen share.",
  },
  "app.hotkey": { label: "Record shortcut" },
  "provider.kind": {
    label: "Answers and enhanced notes",
    choices: [
      ["harness", "Claude Code or Codex"],
      ["anthropic", "Anthropic API"],
      ["openai-compatible", "An OpenAI-compatible server"],
      ["none", "Nothing, the matching parts only"],
    ],
  },
  "memo.provider": {
    label: "Rolling memo during a call",
    help: "Automatic is on for an API and off for Claude Code, so your subscription never runs on its own.",
    choices: [
      ["auto", "Automatic"],
      ["on", "On"],
      ["off", "Off"],
    ],
  },
  "provider.harness": {
    label: "Which one",
    choices: [
      ["auto", "Claude Code, else Codex"],
      ["claude", "Claude Code"],
      ["codex", "Codex"],
    ],
  },
  "provider.harnessResume": {
    label: "Follow-up questions reuse one session",
    help: "Sends only what is new since the last question. Claude Code or Codex keeps those sessions in its history.",
  },
  "provider.harnessPath": {
    label: "Program",
    help: "Set in the config file.",
    empty: "Found on its own",
  },
  "provider.apiKey": { label: "API key", empty: "Not set" },
  "provider.model": { label: "Model", empty: "The default model" },
  "provider.baseUrl": {
    label: "Server address",
    help: "Set in the config file, since your key and transcripts go there.",
    empty: "The Anthropic API",
  },
  "provider.timeoutSeconds": {
    label: "Give up after",
    help: "Then akou shows the matching parts of the call instead.",
    unit: "seconds",
  },
  "share.bind": {
    label: "Share links open to",
    choices: [
      ["tailnet", "My devices (Tailscale)"],
      ["lan", "My local network"],
      ["127.0.0.1", "Only this computer"],
    ],
  },

  // Speech engines
  "asr.live.engine": {
    label: "Streaming model",
    help: "Writes the live transcript when it streams.",
    choices: [
      ["auto", "Automatic, by your languages"],
      ["nemotron-en-560", "Nemotron, English"],
      ["nemotron-3.5-560", "Nemotron, many languages"],
      ["nemotron-3.5-1120", "Nemotron, many languages, larger"],
    ],
  },
  "asr.parakeet.decoding": {
    label: "Parakeet decoding",
    help: "Beam also leans toward your words, but can drop whole stretches.",
    choices: [
      ["greedy", "Greedy"],
      ["beam", "Beam"],
    ],
  },
  "asr.threads": { label: "Threads per recognizer", unit: "threads" },
  "asr.segmentPause": {
    label: "Pause that ends a live line",
    help: "Must be shorter than the longest live line.",
    unit: "seconds",
  },
  "asr.segmentWindow": { label: "Longest live line", unit: "seconds" },
  "asr.modelsDir": { label: "Models folder" },
  "asr.diarizer": {
    label: "Who spoke",
    help: "Takes effect at the next start.",
    choices: [
      ["nemotron", "Nemotron"],
      ["embeddings", "Voice clusters"],
    ],
  },
  "asr.accelerator": {
    label: "Graphics chip for Qwen",
    choices: [
      ["auto", "Automatic"],
      ["metal", "Metal"],
      ["cuda", "CUDA"],
      ["vulkan", "Vulkan"],
      ["sycl", "SYCL"],
      ["rocm", "ROCm"],
      ["cpu", "None, the processor"],
    ],
  },
  "asr.llamaServer": {
    label: "Own Qwen server program",
    help: "Set in the config file.",
    empty: "The one akou downloads",
  },
  "asr.diarizeHelper": {
    label: "Speaker helper program",
    help: "Set in the config file.",
    empty: "The one that comes with akou",
  },

  // Audio capture
  "capture.helper": {
    label: "Capture helper program",
    help: "Set in the config file.",
    empty: "The one that comes with akou",
  },
  "capture.coldStartSeconds": {
    label: "Wait for the first start",
    help: "How long the helper may take to start capturing the first time.",
    unit: "seconds",
  },
  "capture.warmStartSeconds": {
    label: "Wait for a later start",
    unit: "seconds",
  },
  "capture.stopSeconds": {
    label: "Wait for a stop",
    help: "Then the helper is ended.",
    unit: "seconds",
  },
  "capture.stallSeconds": {
    label: "Silence that restarts the helper",
    help: "No sound data at all for this long means it is stuck.",
    unit: "seconds",
  },
  "capture.deadRestartSeconds": {
    label: "Lost call audio that restarts the helper",
    unit: "seconds",
  },
  "capture.queueSeconds": {
    label: "Audio kept while the recognizer catches up",
    unit: "seconds",
  },

  // Word lists
  "vocab.languages": {
    label: "Dictionaries",
    help: "Tell a real word from a mishearing, so your words never replace a real one.",
    empty: "Every dictionary akou has",
  },
  "vocab.extraFiles": {
    label: "Extra word files",
    help: "One file a line, added over your own words.",
    empty: "None",
  },

  // Export and ports
  "export.audio": {
    label: "Audio in copied calls",
    choices: [
      ["link", "A link"],
      ["copy", "A copy"],
      ["none", "None"],
    ],
  },
  "share.port": { label: "Share link port", help: "0 picks a free one." },
  "api.port": { label: "Local API port", help: "0 picks a free one." },
  "webhook.secret": {
    label: "Webhook signing secret",
    help: "The webhook stays off until it is set.",
    empty: "Not set",
  },

  // Server mode
  "app.headless": {
    label: "Run with no window",
    help: "From the next start: akou serves other programs and shows nothing.",
  },
  "server.enabled": {
    label: "Server mode",
    help: "Set in the config file: keys for each program instead of one token.",
  },
  "api.bind": {
    label: "Address it listens on",
    help: "Set in the config file.",
    empty: "Every address",
  },
  "server.behind_proxy": {
    label: "Behind a proxy that handles HTTPS",
    help: "Set in the config file. Needed to listen beyond this computer.",
  },
  "server.public_host": {
    label: "Host name clients use",
    help: "Set in the config file.",
    empty: "Any",
  },
  "server.trusted_proxies": {
    label: "Trusted proxies",
    help: "Set in the config file.",
    empty: "None",
  },
  "server.admin_password_hash": {
    label: "Admin password",
    help: "Set from the command line.",
    empty: "Not set",
  },
  "server.remotes": {
    label: "Other akou servers to send work to",
    help: "Set in the config file.",
    empty: "None",
  },
  "server.default_model": {
    label: "Model when a job names none",
    help: "A preset or a model from the catalog.",
  },
  "server.default_language": {
    label: "Language when a job names none",
    help: "A language tag such as es or en-US, or auto to detect it.",
  },
  "server.default_diarize": {
    label: "Label speakers when a job does not say",
  },
  "server.auto_download": {
    label: "Download a missing model for a job",
    help: "Off: the job is refused instead of waiting.",
  },
  "server.models_max_gb": {
    label: "Largest the models folder may grow",
    help: "0: no limit.",
    unit: "GB",
  },
  "server.models_unused_days": {
    label: "Delete a model unused for",
    help: "0: never. The default model and one in use are kept.",
    unit: "days",
  },
  "server.concurrency": {
    label: "Jobs at once",
    help: "Each loads its own copy of the model.",
    unit: "jobs",
  },
  "server.queue_max": { label: "Jobs waiting, at most", help: "0: no limit.", unit: "jobs" },
  "server.queue_max_per_key": {
    label: "Jobs waiting per key, at most",
    help: "0: no limit.",
    unit: "jobs",
  },
  "server.retain_days": { label: "Keep finished jobs for", unit: "days" },
  "server.max_audio_minutes": { label: "Longest audio a job takes", unit: "minutes" },
  "server.max_upload_mb": { label: "Largest upload", unit: "MB" },
  "server.dictation_slots": {
    label: "Dictations at once for other computers",
    help: "0 turns dictation off for them.",
    unit: "at once",
  },
  "server.dictation_engine": {
    label: "Engine for other computers' dictation",
  },
};

/** The words for a key; a key with none gets its last part, spaced, never the key itself. */
export function wordsFor(key: string): SettingWords {
  const w = WORDS[key];
  if (w) return w;
  const last = key.split(".").pop() ?? key;
  const spaced = last
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return { label: spaced.charAt(0).toUpperCase() + spaced.slice(1) };
}
