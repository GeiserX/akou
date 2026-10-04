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
    label: "Assistant",
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
  "provider.apiKey": { label: "API key", empty: "Paste your key" },
  "provider.model": { label: "Model", empty: "The default model" },
  "provider.baseUrl": {
    label: "Server address",
    help: "Your key and transcripts go there.",
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
      ["nemotron-3.5-1120", "Nemotron, many languages, 1 s"],
      ["nemotron-3.5-80", "Nemotron, many languages, 80 ms"],
      ["nemotron-3.5-160", "Nemotron, many languages, 160 ms"],
      ["nemotron-3.5-320", "Nemotron, many languages, 320 ms"],
      ["nemotron-en-80", "Nemotron, English, 80 ms"],
      ["nemotron-en-160", "Nemotron, English, 160 ms"],
      ["nemotron-en-1120", "Nemotron, English, 1 s"],
    ],
  },
  "asr.final.model": {
    label: "Model after the call",
    help: "Writes the final transcript. Qwen is the most accurate; without a graphics chip, slow.",
    choices: [
      ["auto", "Automatic: Qwen when it is downloaded"],
      ["qwen3-asr-1.7b", "Qwen3-ASR"],
      ["parakeet-tdt-0.6b-v3-fp32", "Parakeet"],
      ["fusion", "Qwen, Whisper and Parakeet, combined"],
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
  "asr.final.engines": {
    label: "Fusion engines",
    help: "The fusion preset's engines, in the order ties are broken. Empty: the preset's own three.",
  },
  "asr.fusion": {
    label: "How fusion picks each word",
    choices: [
      ["rover-conf", "Confidence vote"],
      ["rover-freq", "Majority vote"],
      ["first", "First engine, gaps filled from the others"],
    ],
  },
  "asr.memoryBudgetMb": {
    label: "Memory an engine may need",
    unit: "MB",
    help: "0: 60% of this machine's memory. An engine over it is left out of the fusion pass.",
  },
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
    help: "Detect it finds each job's language from its audio.",
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
  "server.model_idle_minutes": {
    label: "Keep the model loaded between jobs for",
    help: "0: let it go after each run of jobs.",
    unit: "minutes",
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
    help: "0: their dictations wait in the queue like any job.",
    unit: "at once",
  },
  "server.dictation_engine": {
    label: "Engine for other computers' dictation",
    help: "When their dictation names none. Automatic is the server's default.",
    choices: [
      ["auto", "Automatic"],
      ["fast", "Fast"],
      ["best", "Best"],
    ],
  },

  // The Dictation page (docs/ux/design-explorations/sd-a-dictation.html).
  "dictation.enabled": {
    label: "Dictation",
    help: "Hold a key, speak, and the words go where your cursor is.",
  },
  "dictation.hotkey": { label: "Dictation key" },
  "dictation.activation": {
    label: "How the key works",
    help: "Hold to talk and let go to insert. A quick tap keeps listening until the next tap.",
    choices: [
      ["hold-or-toggle", "Hold or tap"],
      ["hold", "Hold only"],
      ["toggle", "Tap only"],
    ],
  },
  "dictation.hotkeyFixLast": {
    label: "Fix the last dictation",
    help: "Opens it to correct a word, so akou learns it.",
  },
  "dictation.hotkeyDraft": {
    label: "Dictate into a draft",
    help: "A second key. You read and edit the text before it goes in.",
  },
  "dictation.hotkeyPasteLast": { label: "Paste the last dictation again" },
  "dictation.languages": {
    label: "Languages",
    help: "akou picks between these as you speak.",
    empty: "The languages of calls",
  },
  "dictation.mic": { label: "Microphone" },
  "dictation.preferBuiltInOverBluetooth": {
    label: "Use the built-in mic when a Bluetooth headset is on",
    help: "Keeps the headset's sound clear.",
  },
  "dictation.muteMedia": {
    label: "Pause music while you dictate",
    help: "It plays again when you stop.",
  },
  "dictation.engine": {
    label: "Speed or accuracy",
    choices: [
      ["auto", "Automatic"],
      ["fast", "Fast"],
      ["best", "Best"],
      ["remote", "Another computer running akou"],
    ],
  },
  "dictation.final": {
    label: "Text that gets inserted",
    choices: [
      ["live", "Same as the live words"],
      ["parakeet", "Parakeet"],
      ["qwen", "Qwen3-ASR"],
    ],
  },
  "dictation.remote.url": { label: "Address", empty: "https://" },
  "dictation.remote.key": { label: "Key", empty: "Not set" },
  "dictation.remote.fallback": {
    label: "If it doesn't answer",
    choices: [
      ["local", "Use this computer"],
      ["error", "Show the error"],
    ],
  },
  "dictation.remote.timeoutSeconds": {
    label: "Wait up to",
    help: "Longer dictations get a little more.",
    unit: "seconds",
  },
  "dictation.insert": {
    label: "How the words go in",
    help: "Type is for remote desktops and fields that refuse a paste.",
    choices: [
      ["paste", "Paste"],
      ["type", "Type"],
      ["clipboard", "Copy only"],
    ],
  },
  "dictation.sendKey": {
    label: "Send key",
    help: "What akou presses when you send.",
    choices: [
      ["Enter", "Enter"],
      ["Ctrl+Enter", "Control+Enter"],
      ["Cmd+Enter", "Command+Enter"],
      ["Shift+Enter", "Shift+Enter"],
      ["none", "None, never send"],
    ],
  },
  "dictation.sendAlways": { label: "Send after every dictation" },
  "dictation.restoreClipboard": {
    label: "Put the clipboard back",
    help: "Otherwise the dictation stays in the clipboard.",
  },
  "dictation.smartSpacing": {
    label: "Fix the spacing around the words",
    help: "Adds the spaces and lower-cases the first word in the middle of a sentence.",
  },
  "dictation.trailingSpace": {
    label: "End with a space",
    help: "Only where akou can't read the text around the cursor.",
  },
  "dictation.fillers": { label: "Leave out um and uh", help: "History keeps what you said." },
  "dictation.spokenPunctuation": {
    label: "Say punctuation",
    help: "Say “comma” or “new line” on its own, between pauses.",
  },
  "dictation.spokenSend": { label: "Say “send it” to send" },
  "dictation.format": {
    label: "Tidy the text with AI",
    help: "Fixes punctuation and capitals. History keeps what you said. A local model is the quickest.",
    choices: [
      ["off", "Off"],
      ["provider", "With your assistant"],
    ],
  },
  "dictation.formatPrompt": { label: "Instructions" },
  "dictation.learn": {
    label: "Learn my fixes",
    help: "When you correct a word akou got wrong.",
    choices: [
      ["ask", "Ask me"],
      ["auto", "Automatically"],
      ["off", "Off"],
    ],
  },
  "dictation.readField": {
    label: "Read the field I dictated into",
    help: "For the spacing and to see your fixes. Never a password field or a terminal.",
  },
  "dictation.learn.audioCheck": {
    label: "Check the audio before offering a word",
    help: "akou listens again to make sure you said it.",
  },
  "dictation.apps": { label: "Rules per app" },
  "dictation.pill": {
    label: "Pill",
    help: "Shows that akou is listening.",
    choices: [
      ["top", "Top"],
      ["bottom", "Bottom"],
      ["left", "Left"],
      ["right", "Right"],
      ["off", "Off"],
    ],
  },
  "dictation.pillPreview": {
    label: "Show my words on the pill",
    help: "A screen share shows them too.",
  },
  "dictation.sounds": {
    label: "Sounds",
    help: "Automatic plays soft sounds only while the pill is off.",
    choices: [
      ["auto", "Automatic"],
      ["soft", "Soft"],
      ["click", "Click"],
      ["off", "Off"],
    ],
  },
  "dictation.silenceStopSeconds": {
    label: "Stop after silence",
    help: "A dictation you tapped on stops after this much quiet. 0 never stops it.",
    unit: "seconds",
  },
  "dictation.maxMinutes": {
    label: "Longest dictation",
    help: "akou warns you a minute before, and keeps what you said.",
    unit: "minutes",
  },
  "dictation.warmMic": {
    label: "Keep the microphone open",
    help: "Kept open longer, a quick second dictation keeps its first word. Never on a Bluetooth mic.",
    choices: [
      ["auto", "30 seconds after each dictation"],
      ["always", "While dictation is on"],
      ["off", "Only while the key is down"],
    ],
  },
  "dictation.language": {
    label: "One fixed language",
    help: "Best and another computer use it for every dictation. Fast picks its own.",
  },
  "dictation.glossary": {
    label: "Send my words as context",
    help: "Your learned words are always replaced either way.",
    choices: [
      ["off", "Off"],
      ["on", "On"],
    ],
  },
  "dictation.glossaryMax": { label: "Most words sent as context", unit: "words" },
  "dictation.localTimeoutSeconds": {
    label: "Wait for Best up to",
    help: "Then Fast turns it into text instead. Longer dictations get a little more.",
    unit: "seconds",
  },
  "dictation.formatTimeoutSeconds": {
    label: "Wait for the AI tidy up to",
    help: "Then the text goes in as you said it. Automatic waits 15 seconds for Claude Code, 4 for an API.",
  },
  "asr.qwenIdleMinutes": {
    label: "Unload Best after",
    help: "Frees its memory when you stop dictating. 0 keeps it loaded.",
    unit: "idle minutes",
  },
  "dictation.retainDays": {
    label: "Keep dictations for",
    help: "0 keeps only the last one, for fixing or pasting it again.",
    unit: "days",
  },
  "dictation.keepAudio": {
    label: "Keep the audio",
    help: "Needed to retry a dictation and to check a word before akou learns it.",
  },
};

/**
 * Text from akou that may name a setting by its key (a refusal, an engine's reason): each key
 * becomes the setting's label, and code quotes go.
 */
export function inWords(text: string, keys: readonly string[]): string {
  let out = text;
  for (const key of [...keys].sort((a, b) => b.length - a.length))
    if (out.includes(key)) out = out.split(key).join(wordsFor(key).label);
  return out.replace(/`/g, "");
}

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
