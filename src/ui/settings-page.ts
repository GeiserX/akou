/**
 * The Settings page (docs/ux/design-explorations/sd-a-settings.html, direction A): a page of the
 * main window, opened from the sidebar, not a dialog over the call. One scrolling column of
 * sections, each a rounded panel of rows with a human label, one short line of help at most and
 * its control on the right: a switch, a segmented choice, a select, a field with its unit, keycaps.
 * A default shows as its value; nothing on the page names a key, akou's own files or a value in
 * code quotes (the words are in `settings-labels.ts`).
 *
 * Every setting the registry (`GET /config`) has and the Dictation page does not show has a home
 * here: on the page itself, or on one of the pages its Advanced rows lead to, each row naming what
 * its page holds. A key this layout does not place yet lands on an "Other settings" page rather
 * than out of reach. A key the registry keeps file only is shown and cannot be changed; the page's
 * foot opens the config file. A secret is never shown back.
 *
 * Each change saves that key alone through `PATCH /config`, which validates it as the file is
 * validated; a refusal shows under the row's label. A field being typed into saves when it is
 * left, and leaving the page saves what is still in one, so nothing typed is dropped.
 *
 * The search finds a setting by its words across the page and its Advanced pages, and goes to it.
 */

import { everyText, liveModelName } from "../main/asr/model-text.ts";
import { hotkeyFor } from "../main/window/hotkey.ts";
import { LanguageList, languageName } from "./dictation-languages.ts";
import { type CaptureInput, readMics } from "./dictation-mic.ts";
import { onDictationPage } from "./dictation-page.ts";
import { KEY_SETTINGS, KeyRecorder } from "./dictation-recorder.ts";
import { h, replace, toast } from "./dom.ts";
import { MODELS_KEYS } from "./models-rows.ts";
import { message } from "./notepad.ts";
import type { AppStatus, Transport } from "./protocol.ts";
import {
  backLink,
  button,
  field,
  ICONS,
  icon,
  linkRow,
  pageHead,
  row,
  section,
  segmented,
  selectBox,
  toggle,
  unit,
} from "./rows.ts";
import { type ConfigReply, changedSettings, type SchemaEntry, shownValue } from "./settings.ts";
import { inWords, type SettingWords, wordsFor } from "./settings-labels.ts";

/** A page an Advanced row leads to, and what it holds. */
interface SubPage {
  title: string;
  /** What the page holds, as the row that leads to it says it. */
  help: string;
  groups: { title: string; keys: string[] }[];
}

/** The rows drawn by hand rather than from one key. */
const WORKSPACES = "#workspaces";
const LIVE = "#live";
const AFTER_CALL = "#after-call";
const YOUR_WORDS = "#your-words";
/** The rows the chosen assistant needs, under the Assistant row: its service, address, model, key. */
const ASSISTANT_USE = "#assistant-use";
/** "Run the setup again": the first-run setup, with what is set now (`setup-wizard.ts`). */
const SETUP = "#setup";

/** Ollama's OpenAI-compatible address on this computer: what "Local model (Ollama)" sets. */
export const OLLAMA_URL = "http://127.0.0.1:11434/v1";
/** OpenAI's own address: what the OpenAI-compatible service starts from in the window. */
export const OPENAI_URL = "https://api.openai.com/v1";

/** Whether an address is Ollama's on this computer. */
export function isOllama(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):11434(\/|$)/.test(url.trim());
}

/**
 * What the assistant is, as the Settings page offers it: the Claude Code or Codex found here, an
 * API key (Anthropic, or an OpenAI-compatible server), a local model through Ollama, or none. Each
 * is one or two settings: `provider.kind`, and `provider.baseUrl` for Ollama.
 */
export type AssistantUse = "harness" | "key" | "ollama" | "none";

export function assistantUse(settings: Record<string, unknown>): AssistantUse {
  const kind = String(settings["provider.kind"] ?? "harness");
  if (kind === "harness" || kind === "none") return kind;
  if (kind === "openai-compatible" && isOllama(String(settings["provider.baseUrl"] ?? "")))
    return "ollama";
  return "key";
}
/** Server mode: where a job's result may be sent is each key's, on the Keys page. */
export const WEBHOOKS = "#webhooks";

/** The sections of the page, in the mockup's order: a key, a row drawn by hand, or `>page`. */
export type Layout = readonly { title: string; items: readonly string[] }[];

const MAIN: Layout = [
  { title: "General", items: ["user.name", "app.openAtLogin", SETUP] },
  { title: "Workspaces and recordings", items: ["recordings.root", WORKSPACES, "export.dir"] },
  {
    title: "Calls",
    items: [
      "capture.call",
      "capture.mic",
      "asr.languages",
      LIVE,
      "app.floatingIndicator",
      "app.hotkey",
    ],
  },
  {
    title: "Notes and AI",
    items: ["provider.kind", ASSISTANT_USE, "memo.provider", ">assistant"],
  },
  { title: "Privacy and sharing", items: ["share.bind", AFTER_CALL] },
  { title: "Advanced", items: [">speech", ">capture", ">words", ">export", ">server", ">other"] },
];

const PROVIDER_KEYS = [
  "provider.harness",
  "provider.harnessResume",
  "provider.harnessPath",
  "provider.apiKey",
  "provider.model",
  "provider.baseUrl",
  "provider.timeoutSeconds",
];

/** The assistant's details that apply to each kind, first; the others follow under their own title. */
const FOR_KIND: Record<string, string[]> = {
  harness: [
    "provider.harness",
    "provider.harnessResume",
    "provider.timeoutSeconds",
    "provider.harnessPath",
  ],
  anthropic: ["provider.apiKey", "provider.model", "provider.timeoutSeconds", "provider.baseUrl"],
  "openai-compatible": [
    "provider.baseUrl",
    "provider.model",
    "provider.apiKey",
    "provider.timeoutSeconds",
  ],
  none: [],
};

const SUBS: Record<string, SubPage> = {
  assistant: {
    title: "Assistant details",
    help: "Claude Code or Codex, model, API key, time limit.",
    groups: [{ title: "Assistant", keys: PROVIDER_KEYS }],
  },
  speech: {
    title: "Speech engines",
    help: "Which streaming model, decoding, the final transcript's model, threads, models folder.",
    groups: [
      {
        title: "Live transcript",
        keys: ["asr.live.engine", "asr.parakeet.decoding", "asr.segmentPause", "asr.segmentWindow"],
      },
      { title: "Final transcript", keys: ["asr.final.model"] },
      { title: "Engines", keys: ["asr.threads", "asr.modelsDir"] },
      { title: "Programs", keys: ["asr.llamaServer", "asr.diarizeHelper"] },
    ],
  },
  capture: {
    title: "Audio capture",
    help: "Start and stop timings, the helper program.",
    groups: [
      {
        title: "Timings",
        keys: [
          "capture.coldStartSeconds",
          "capture.warmStartSeconds",
          "capture.stopSeconds",
          "capture.stallSeconds",
          "capture.deadRestartSeconds",
          "capture.queueSeconds",
        ],
      },
      { title: "Program", keys: ["capture.helper"] },
    ],
  },
  words: {
    title: "Word lists",
    help: "Your words, which dictionaries tell a real word from a mishearing, extra word files.",
    groups: [{ title: "Word lists", keys: [YOUR_WORDS, "vocab.languages", "vocab.extraFiles"] }],
  },
  export: {
    title: "Export and ports",
    help: "Audio in copied calls, ports for share links and the local API, the webhook's secret.",
    groups: [
      { title: "Export", keys: ["export.audio"] },
      { title: "Ports", keys: ["share.port", "api.port"] },
      { title: "Webhook", keys: ["webhook.secret"] },
    ],
  },
  server: {
    title: "Server mode",
    help: "Let other computers and programs use this akou.",
    groups: [
      {
        title: "Access",
        keys: [
          "server.enabled",
          "app.headless",
          "api.bind",
          "server.behind_proxy",
          "server.public_host",
          "server.trusted_proxies",
          "server.admin_password_hash",
        ],
      },
      {
        title: "Jobs",
        keys: [
          "server.default_model",
          "server.default_language",
          "server.default_diarize",
          "server.concurrency",
          "server.queue_max",
          "server.queue_max_per_key",
          "server.retain_days",
          "server.max_audio_minutes",
          "server.max_upload_mb",
        ],
      },
      { title: "Models", keys: ["server.auto_download"] },
      {
        title: "Dictation for other computers",
        keys: ["server.dictation_slots", "server.dictation_engine"],
      },
      { title: "Other servers", keys: ["server.remotes"] },
    ],
  },
};

/** Keys whose value is a folder: drawn as its name, changed by typing where it is. */
const FOLDERS = new Set(["recordings.root", "export.dir", "asr.modelsDir"]);

/**
 * Keys the Settings page shows neither on itself nor on its pages: their home is the Models page,
 * which its Live transcript row and its search lead to.
 */
const ELSEWHERE = new Set<string>(MODELS_KEYS);

/** The keys a row drawn by hand shows: the after-call row says what the file sends where. */
const BY_HAND: Readonly<Record<string, readonly string[]>> = {
  [AFTER_CALL]: ["hooks", "webhook.url"],
};

/** What the Models page calls its settings, for the search here. */
const MODELS_WORDS: Readonly<Record<string, string>> = {
  "asr.review.model": "Second pass during a call",
  "asr.review.everySeconds": "How often the second pass reviews",
  "asr.diarizer": "Speakers: who spoke when",
  "asr.accelerator": "Use the graphics chip",
  "server.models_unused_days": "Delete models unused for",
  "server.models_max_gb": "Keep all models under",
};

/** Every key this layout places, on the page or an Advanced page. */
export function placedKeys(): Set<string> {
  const out = new Set<string>(Object.values(BY_HAND).flat());
  for (const s of MAIN) for (const k of s.items) if (!/^[#>]/.test(k)) out.add(k);
  for (const p of Object.values(SUBS))
    for (const g of p.groups) for (const k of g.keys) if (!k.startsWith("#")) out.add(k);
  return out;
}

/** The keys the Settings page is the home of: every key but the Dictation page's. */
export function settingsKeys(schema: Record<string, unknown>): string[] {
  return Object.keys(schema).filter((k) => !onDictationPage(k) && !ELSEWHERE.has(k));
}

/** A folder's name with its parent's: `/x/Recordings/akou` is "akou in Recordings". */
export function folderName(path: string): { name: string; parent: string } {
  const parts = path.split(/[\\/]+/).filter((p) => p !== "");
  return { name: parts.at(-1) ?? path, parent: parts.at(-2) ?? "" };
}

/** What a call's audio setting means: the whole computer, one app (and which), or none. */
function callAudio(v: string): { mode: string; apps: string } {
  if (v === "system" || v === "none") return { mode: v, apps: "" };
  if (v.startsWith("app:")) return { mode: "app", apps: v.slice(4) };
  return { mode: "system", apps: "" };
}

type Status = Partial<Pick<AppStatus, "provider" | "asr">> & {
  app?: Partial<AppStatus["app"]>;
  /** Claude Code and Codex as the app found them; null while it has not looked. */
  harnesses?: { claude: unknown; codex: unknown } | null;
};

type LiveReply = {
  live?: {
    setting?: string;
    next?: string;
    setups?: { id: string; title: string }[];
    review?: {
      setting?: string;
      everySeconds?: number;
      next?: { model: string; everySeconds: number } | null;
    };
    slots?: {
      live: { id: string; checked: boolean }[];
      review: { id: string; checked: boolean }[];
    };
  };
};

interface SearchItem {
  label: string;
  help: string;
  /** "Settings", or the Advanced page's title: "Speech engines". */
  where: string;
  go: () => void;
}

export interface SettingsPageHooks {
  /** The workspaces the calls list knows, for the Workspaces row. */
  workspaces?: () => string[];
  /** Opens the Models page, where the live transcript is chosen; on `key`, at that setting. */
  openModels?: (key?: string) => void;
  /** Opens the dictionary of your words (DC-U5). */
  openDictionary?: () => void;
  /**
   * Server mode (docs/ux/SERVER.md SV-U2): these sections instead of the app's, no Advanced
   * pages, nothing of the recorder, and no config file to open, since it is on the server.
   */
  server?: Layout;
  /** Reopens the first-run setup; absent, the page has no "Run the setup again". */
  runSetup?: () => void;
  /**
   * Drawn inside another view (the first-run setup's assistant step): these rows alone, with no
   * title, search, Advanced pages or foot, and the page's root under this id.
   */
  only?: { id: string; layout: Layout };
}

export class SettingsPage {
  readonly root = h("section", {
    id: "page-settings",
    class: "pg",
    attrs: { "aria-label": "Settings" },
  });
  private readonly col = h("div", { class: "pg-col" });
  private schema: Record<string, SchemaEntry> = {};
  private settings: Record<string, unknown> = {};
  private issues = new Map<string, string>();
  private shown: Record<string, string> = {};
  private status: Status = {};
  private live: LiveReply["live"] | null = null;
  private mics: CaptureInput[] | null = null;
  /** Server mode: the presets and engines a job may name. */
  private models: string[] = [];
  private recorder: KeyRecorder | null = null;
  /** The Advanced page on screen, or null for the page itself. */
  private sub: string | null = null;
  private reads = 0;
  private shows = 0;
  private readonly search = h("input", {
    id: "settings-search",
    type: "search",
    placeholder: "Search all settings",
    attrs: { "aria-label": "Search all settings", autocomplete: "off", spellcheck: "false" },
  });
  private readonly results = h("div", {
    id: "settings-results",
    class: "pg-menu",
    role: "listbox",
    hidden: true,
  });
  private found: SearchItem[] = [];
  private pick = 0;

  constructor(
    private readonly t: Transport,
    private readonly hooks: SettingsPageHooks = {},
  ) {
    if (hooks.only) {
      this.root.id = hooks.only.id;
      this.root.classList.remove("pg");
    }
    this.root.append(this.col);
    this.root.addEventListener("change", (e) => {
      const el = e.target as HTMLElement;
      // Only a control a save reads: a segment or an add list sets one of those, which fires too.
      const rowEl = el.dataset?.key ? el.closest<HTMLElement>(".pg-row[data-key]") : null;
      if (rowEl) void this.save(rowEl);
    });
    this.search.addEventListener("input", () => this.find());
    this.search.addEventListener("keydown", (e) => this.searchKey(e));
    this.search.addEventListener("blur", () => {
      // A click on a result lands before the list goes.
      // clock: lets a click on a result land before the list goes.
      setTimeout(() => {
        this.results.hidden = true;
      }, 150);
    });
  }

  /** Reads everything and draws the page; on `key`, goes to that setting and focuses it. */
  async show(key?: string): Promise<void> {
    // Shown again while on screen (its sidebar row, clicked from an Advanced page): what is typed
    // there is saved first, as leaving saves it, since a click in WebKit leaves the field focused
    // and fires no change. The read below then sees it.
    // A later show, or leaving, makes this one stale: it draws nothing and moves no focus.
    const shown = ++this.shows;
    await this.saveTyped();
    if (shown !== this.shows) return;
    // What the last visit drew goes until the read lands: typing into it would be lost when the
    // read draws over it.
    replace(this.col, h("p", { class: "pg-reading" }, "Reading the settings…"));
    await this.load();
    if (shown !== this.shows) return;
    this.sub = key ? this.pageOf(key) : null;
    this.draw();
    if (key) this.goTo(key);
  }

  /** The page is left: what is still typed into a field is saved; a key recording stops. */
  leave(): void {
    this.shows++;
    void this.saveTyped();
  }

  /** Stops a key recording and saves each row whose field holds what the file does not. */
  private async saveTyped(): Promise<void> {
    this.recorder?.stop();
    this.results.hidden = true;
    const rows = [...this.col.querySelectorAll<HTMLElement>(".pg-row[data-key]")].filter(
      (r) => Object.keys(changedSettings(r, this.schema, this.shown)).length > 0,
    );
    await Promise.all(rows.map((r) => this.save(r)));
  }

  private async load(): Promise<void> {
    const read = ++this.reads;
    const app = !this.hooks.server;
    const [cfg, st, models, mics, server] = await Promise.all([
      this.t.request<ConfigReply>("GET", "/config"),
      app ? this.t.request<Status>("GET", "/status") : null,
      app ? this.t.request<LiveReply>("GET", "/models") : null,
      app ? readMics(this.t) : null,
      app
        ? null
        : this.t.request<{ presets?: { name: string }[]; engines?: { id: string }[] }>(
            "GET",
            "/server",
          ),
    ]);
    if (read !== this.reads) return;
    this.status = st && st.status < 400 ? (st.body ?? {}) : {};
    this.live = models && models.status < 400 ? (models.body?.live ?? null) : null;
    this.mics = mics && "inputs" in mics ? mics.inputs : null;
    // A job's model is a preset or an engine: offer both.
    this.models =
      server && server.status < 400
        ? [
            ...new Set([
              "auto",
              ...(server.body.presets ?? []).map((p) => p.name),
              ...(server.body.engines ?? []).map((e) => e.id),
            ]),
          ]
        : [];
    if (cfg.status >= 400) {
      toast(message(cfg.body, "the settings could not be read"));
      return;
    }
    this.schema = cfg.body.schema;
    this.settings = { ...cfg.body.settings };
    this.issues = new Map(cfg.body.issues.map((i) => [i.key, i.message]));
  }

  private get main(): Layout {
    return this.hooks.only?.layout ?? this.hooks.server ?? MAIN;
  }

  private get platform(): string {
    return String(this.status.app?.platform ?? "");
  }

  private get here(): string {
    return this.platform === "darwin" ? "this Mac" : "this computer";
  }

  /** The Advanced page a key lives on, or null for the page itself. */
  private pageOf(key: string): string | null {
    for (const s of this.main)
      if (s.items.some((i) => i === key || BY_HAND[i]?.includes(key))) return null;
    for (const [name, p] of Object.entries(this.subs()))
      if (p.groups.some((g) => g.keys.includes(key))) return name;
    return settingsKeys(this.schema).includes(key) ? "other" : null;
  }

  /** The Advanced pages with what each holds; `other` only when a key has no place. */
  private subs(): Record<string, SubPage> {
    if (this.hooks.server || this.hooks.only) return {};
    const placed = placedKeys();
    const rest = settingsKeys(this.schema).filter((k) => !placed.has(k));
    return rest.length === 0
      ? SUBS
      : {
          ...SUBS,
          other: {
            title: "Other settings",
            help: rest.map((k) => wordsFor(k).label).join(", "),
            groups: [{ title: "Other settings", keys: rest }],
          },
        };
  }

  private draw(): void {
    this.recorder?.stop();
    this.recorder = null;
    this.shown = {};
    const subs = this.subs();
    const sub = this.sub ? subs[this.sub] : undefined;
    if (!sub) this.sub = null;
    replace(this.col, ...(sub ? this.drawSub(sub) : this.drawMain(subs)));
    this.root.scrollTop = 0;
    this.root.parentElement?.scrollTo?.({ top: 0 });
  }

  private drawMain(subs: Record<string, SubPage>): HTMLElement[] {
    const find = h(
      "div",
      { class: "pg-find" },
      h("label", {}, icon(...ICONS.search), this.search),
      this.results,
    );
    const sections = this.main
      .map((s) => {
        const rows = s.items.flatMap((item) => this.item(item, subs) ?? []);
        return rows.length > 0 ? section(s.title, ...rows) : null;
      })
      .filter((x): x is HTMLElement => x !== null);
    if (this.hooks.only) return sections;
    return [
      pageHead("Settings", { right: [find] }),
      ...sections,
      this.hooks.server ? null : this.foot(),
    ].filter((x): x is HTMLElement => x !== null);
  }

  private drawSub(p: SubPage): HTMLElement[] {
    const groups = this.sub === "assistant" ? this.assistantGroups() : p.groups;
    const sections = groups
      .map((g) => {
        const rows = g.keys
          .map((k) => (k === YOUR_WORDS ? this.yourWords() : this.keyRow(k)))
          .filter((x): x is HTMLElement => x !== null);
        return rows.length > 0 ? section(g.title, ...rows) : null;
      })
      .filter((x): x is HTMLElement => x !== null);
    return [
      pageHead(p.title, {
        back: backLink("Settings", () => {
          const from = this.sub;
          void this.saveTyped();
          this.sub = null;
          this.draw();
          // The keyboard goes on from the row it came through, not the top of the window.
          this.col.querySelector<HTMLElement>(`#settings-go-${from}`)?.focus();
        }),
      }),
      ...sections,
      this.foot(),
    ];
  }

  /** The assistant's page: the kind, what it uses, then the details the other kinds use. */
  private assistantGroups(): { title: string; keys: string[] }[] {
    const kind = String(this.settings["provider.kind"] ?? "harness");
    const mine = FOR_KIND[kind] ?? PROVIDER_KEYS;
    const rest = PROVIDER_KEYS.filter((k) => !mine.includes(k));
    const name = (wordsFor("provider.kind").choices ?? []).find(([v]) => v === kind)?.[1] ?? kind;
    return [
      { title: "Assistant", keys: ["provider.kind"] },
      { title: name, keys: mine },
      { title: "For the other assistants", keys: rest },
    ];
  }

  private item(item: string, subs: Record<string, SubPage>): HTMLElement | HTMLElement[] | null {
    if (item === WORKSPACES) return this.workspacesRow();
    if (item === ASSISTANT_USE) return this.useRows();
    if (item === SETUP) {
      const run = this.hooks.runSetup;
      return run
        ? linkRow(
            {
              label: "Run the setup again",
              help: "What you use akou for, the speech models, dictation, permissions and the assistant.",
              id: "settings-setup-open",
            },
            run,
          )
        : null;
    }
    if (item === LIVE) return this.liveRow();
    if (item === AFTER_CALL) return this.afterCallRow();
    if (item === WEBHOOKS)
      return row({
        label: "Where a job's result may be sent",
        help: "Set for each key, on the Keys page.",
      });
    if (item.startsWith(">")) {
      const name = item.slice(1);
      const p = subs[name];
      if (!p) return null;
      const n = p.groups.flatMap((g) => g.keys).filter((k) => k in this.schema).length;
      if (n === 0) return null;
      return linkRow(
        {
          label: p.title,
          help: p.help,
          value: `${n} setting${n === 1 ? "" : "s"}`,
          id: `settings-go-${name}`,
        },
        () => {
          void this.saveTyped();
          this.sub = name;
          this.draw();
          this.col.querySelector<HTMLElement>(".pg-back")?.focus();
        },
      );
    }
    return this.keyRow(item);
  }

  // -------------------------------------------------------------------------
  // Rows

  /** One key's row, its control chosen by the key's type; null when this akou has no such key. */
  private keyRow(key: string): HTMLElement | null {
    const spec = this.schema[key];
    if (!spec) return null;
    const w = wordsFor(key);
    const value = this.settings[key];
    const id = `set-${key.replace(/[^a-z0-9]/gi, "-")}`;
    // The desktop window may set a key only it can, as the address the assistant is reached at.
    const fileOnly =
      spec.apiWritable === false && !(spec.windowWritable && this.t.kind === "window");
    this.shown[key] = spec.secret ? "" : shownValue(spec, value);
    let help: string | undefined = w.help;
    if (key === "app.openAtLogin" && this.platform && this.platform !== "darwin")
      help = help?.replace("the menu bar", "the tray");
    if (key === "provider.baseUrl" && fileOnly)
      help = "Set in the akou window, since your key and transcripts go there.";
    let controls: (Node | null)[];
    if (key === "provider.kind") {
      controls = [this.kindControl(id)];
      // The select holds a use, not a kind: it is saved by `chooseUse`, never as the key.
      this.shown[key] = assistantUse(this.settings);
      help = this.agentState();
    } else if (key === "provider.apiKey") controls = this.apiKeyControls(id);
    else if (key === "capture.call") controls = this.callAudioControls(id, String(value ?? ""));
    else if (key === "capture.mic") controls = [this.micControl(id, String(value ?? ""))];
    else if (key === "asr.languages") controls = [this.languagesControl(id, value)];
    else if (key === "app.hotkey") controls = this.hotkeyControls(id, String(value ?? ""));
    else if (key === "share.bind") controls = [this.bindControl(id, String(value ?? ""))];
    else if (key === "server.default_model" && this.models.length > 0)
      controls = [
        selectBox({
          id,
          label: w.label,
          options: this.models.map((m) => [m, m === "auto" ? "Automatic" : m] as const),
          value: String(value ?? "auto"),
        }),
      ];
    else if (FOLDERS.has(key))
      controls = this.folderControls(id, key, String(value ?? ""), fileOnly);
    else controls = this.control(id, key, spec, w, value);
    const els = controls.filter((c): c is HTMLElement => c instanceof HTMLElement);
    const all = (sel: string) =>
      els.flatMap((el) => [
        ...(el.matches(sel) ? [el] : []),
        ...el.querySelectorAll<HTMLElement>(sel),
      ]);
    // The control a save reads carries the key; a control that sets it for another (a list of
    // segments, an app's field) carries none, so only its own change is saved.
    if (all("[data-key]").length === 0) {
      const input = all("input, select, textarea")[0];
      if (input) input.dataset.key = key;
    }
    if (fileOnly)
      for (const x of all("input, select, textarea, button"))
        (x as HTMLInputElement).disabled = true;
    const r = row(
      { label: w.label, help, key, for: controlId(controls) ?? undefined },
      ...controls,
    );
    const issue = this.issues.get(key);
    if (issue) {
      r.classList.add("refused");
      r.querySelector(".pg-lbl")?.append(h("small", { class: "issue" }, issue));
    }
    if (key === "provider.kind")
      r.querySelector(".pg-help")?.setAttribute("id", "settings-provider-state");
    return r;
  }

  /** The control for a key of any type, from its words and the registry. */
  private control(
    id: string,
    key: string,
    spec: SchemaEntry,
    w: SettingWords,
    value: unknown,
  ): (Node | null)[] {
    if (spec.type === "boolean") return [toggle({ id, checked: value === true, label: w.label })];
    if (spec.type === "hooks") return [h("span", { class: "pg-value" }, hooksText(value))];
    const choices =
      w.choices?.filter(([v]) => !spec.values || spec.values.includes(v)) ??
      spec.values?.map((v) => [v, v] as const);
    if (spec.type === "string" && choices && !spec.secret) {
      const v = String(value ?? "");
      if (choices.length <= 3 && choices.every(([, l]) => l.length < 24)) {
        const seg = segmented({ id, label: w.label, options: choices, value: v });
        seg.input.dataset.key = key;
        return [seg.root];
      }
      return [selectBox({ id, label: w.label, options: choices, value: v })];
    }
    if (spec.type === "string[]") {
      const list = Array.isArray(value) ? (value as string[]) : [];
      if (spec.values) return [this.chips(id, key, list, spec.values, w)];
      // Read only and one line at most (a program): a one-line field, the whole of it on hover.
      if (spec.apiWritable === false && list.length <= 1) {
        const one = field({ id, label: w.label, value: list[0] ?? "", placeholder: w.empty ?? "" });
        if (list[0]) one.title = list[0];
        return [one];
      }
      const area = h("textarea", {
        id,
        class: "pg-input pg-lines",
        placeholder: w.empty ?? "",
        attrs: {
          rows: String(Math.max(2, list.length)),
          "aria-label": w.label,
          spellcheck: "false",
        },
      });
      area.value = list.join("\n");
      return [area];
    }
    if (spec.type === "integer" || spec.type === "number") {
      const f = field({
        id,
        label: w.label,
        value: String(value ?? ""),
        type: "number",
        width: "narrow",
      });
      if (spec.min !== undefined) f.min = String(spec.min);
      if (spec.max !== undefined) f.max = String(spec.max);
      f.step = spec.type === "integer" ? "1" : "any";
      return [f, w.unit ? unit(w.unit) : null];
    }
    return [
      field({
        id,
        label: w.label,
        type: spec.secret ? "password" : "text",
        value: spec.secret ? "" : String(value ?? ""),
        placeholder: spec.secret
          ? value
            ? "Set, type to replace"
            : (w.empty ?? "Not set")
          : (w.empty ?? ""),
      }),
    ];
  }

  /** A list with choices as chips, and a list to add one more. */
  private chips(
    id: string,
    key: string,
    list: string[],
    values: readonly string[],
    w: SettingWords,
  ): HTMLElement {
    const hidden = h("textarea", { id, hidden: true });
    hidden.value = list.join("\n");
    hidden.dataset.key = key;
    const name = (c: string) => languageName(c);
    const root = h("div", { class: "pg-chips" });
    const draw = (now: string[]) => {
      const left = values.filter((v) => !now.includes(v));
      const add = h(
        "select",
        { class: "pg-chip add", attrs: { "aria-label": `Add to ${w.label}` } },
        h("option", { value: "" }, "+ Add"),
        ...left.map((v) => h("option", { value: v }, name(v))),
      );
      add.addEventListener("change", () => {
        if (add.value) set([...now, add.value]);
      });
      replace(
        root,
        now.length === 0 && w.empty ? h("span", { class: "pg-value" }, w.empty) : null,
        ...now.map((c) =>
          h(
            "span",
            { class: "pg-chip" },
            name(c),
            h(
              "button",
              {
                type: "button",
                class: "x",
                attrs: { "aria-label": `Remove ${name(c)}` },
                on: { click: () => set(now.filter((x) => x !== c)) },
              },
              "✕",
            ),
          ),
        ),
        left.length > 0 ? add : null,
        hidden,
      );
    };
    const set = (next: string[]) => {
      hidden.value = next.join("\n");
      draw(next);
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    };
    draw(list);
    return root;
  }

  /** The assistant, the Claude Code or Codex named for what was found on this machine. */
  private kindControl(id: string): HTMLSelectElement {
    const now = assistantUse(this.settings);
    const base = String(this.settings["provider.baseUrl"] ?? "");
    const select = selectBox({
      id,
      label: "Assistant",
      options: [
        ["harness", this.harnessName()],
        ["key", "Use an API key"],
        ["ollama", "Local model (Ollama)"],
        ["none", "None"],
      ],
      value: now,
    });
    // The address is the window's to change (an HTTP client may not): in a browser, a use that
    // changes it is offered and cannot be picked, rather than refused after the pick.
    if (this.t.kind !== "window")
      for (const opt of select.options) {
        const changes =
          opt.value !== now && (opt.value === "ollama" || (opt.value === "key" && base !== ""));
        if (changes) {
          opt.disabled = true;
          opt.textContent = `${opt.textContent}, in the akou window`;
        }
      }
    select.addEventListener("change", (e) => {
      e.stopPropagation();
      const r = select.closest<HTMLElement>(".pg-row");
      if (r) void this.chooseUse(r, select.value as AssistantUse);
    });
    return select;
  }

  /** "Claude Code on this Mac": the one found, or both names while none is known. */
  private harnessName(): string {
    const pick = String(this.settings["provider.harness"] ?? "auto");
    const found = this.status.harnesses;
    const has = (k: "claude" | "codex") => Boolean(found?.[k]);
    const name =
      pick === "claude"
        ? "Claude Code"
        : pick === "codex"
          ? "Codex"
          : has("claude")
            ? "Claude Code"
            : has("codex")
              ? "Codex"
              : "Claude Code or Codex";
    const none =
      found != null && (pick === "auto" ? !has("claude") && !has("codex") : !has(pick as "claude"));
    return none ? `${name} (not found)` : `${name} on ${this.here}`;
  }

  /** The settings a use is, saved together, then the page drawn again for its rows. */
  private async chooseUse(r: HTMLElement, use: AssistantUse): Promise<void> {
    const base = String(this.settings["provider.baseUrl"] ?? "");
    const patch: Record<string, unknown> = {};
    // A model is the previous service's name for one (Ollama's `llama3.2`), not this one's.
    if (this.settings["provider.model"]) patch["provider.model"] = null;
    if (use === "harness" || use === "none") patch["provider.kind"] = use;
    else if (use === "ollama") {
      patch["provider.kind"] = "openai-compatible";
      patch["provider.baseUrl"] = OLLAMA_URL;
    } else {
      patch["provider.kind"] = "anthropic";
      // Ollama's address is not the Anthropic API's.
      if (base) patch["provider.baseUrl"] = null;
    }
    await this.saveMany(r, patch);
  }

  /** The rows the chosen assistant needs: which service, its address and model, and the key. */
  private useRows(): HTMLElement[] {
    const use = assistantUse(this.settings);
    const rows: (HTMLElement | null)[] = [];
    if (use === "key") {
      const kind = String(this.settings["provider.kind"] ?? "anthropic");
      const seg = segmented({
        id: "set-provider-service",
        label: "Service",
        options: [
          ["anthropic", "Anthropic"],
          ["openai-compatible", "OpenAI-compatible"],
        ],
        value: kind,
      });
      const service = row(
        {
          label: "Service",
          help:
            kind === "anthropic"
              ? "Claude, with your Anthropic key."
              : "OpenAI, or any server that speaks its API.",
        },
        seg.root,
      );
      service.id = "settings-provider-service";
      // Back to Anthropic clears an address, which only the window may do.
      if (this.t.kind !== "window" && kind !== "anthropic" && this.settings["provider.baseUrl"])
        for (const radio of seg.root.querySelectorAll<HTMLInputElement>("input[value='anthropic']"))
          radio.disabled = true;
      seg.input.addEventListener("change", (e) => {
        e.stopPropagation();
        const base = String(this.settings["provider.baseUrl"] ?? "");
        const to = seg.input.value;
        const patch: Record<string, unknown> = { "provider.kind": to };
        // The other service's model name means nothing to this one.
        if (this.settings["provider.model"]) patch["provider.model"] = null;
        // An address left from another choice would send the key there.
        if (base && (to === "anthropic" || isOllama(base))) patch["provider.baseUrl"] = null;
        // OpenAI's own address, shown as the value, where the window may set it.
        if (to === "openai-compatible" && !base && this.t.kind === "window")
          patch["provider.baseUrl"] = OPENAI_URL;
        void this.saveMany(service, patch);
      });
      rows.push(service);
      if (kind === "openai-compatible") {
        rows.push(this.useField("provider.baseUrl", "The server's address"));
        rows.push(this.useField("provider.model", "The model's name"));
      }
      rows.push(this.keyRow("provider.apiKey"));
    } else if (use === "ollama") {
      rows.push(this.useField("provider.model", "The model's name, as Ollama lists it"));
    }
    return rows.filter((x): x is HTMLElement => x !== null);
  }

  /** A key's row with what its empty field asks for here. */
  private useField(key: string, placeholder: string): HTMLElement | null {
    const r = this.keyRow(key);
    const input = r?.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(key)}"]`);
    if (!input) return r;
    input.placeholder = placeholder;
    // One this page cannot change reads as a value, not as a field that takes no clicks.
    if (input.disabled)
      input.replaceWith(h("span", { id: input.id, class: "pg-value" }, input.value || "Not set"));
    return r;
  }

  /**
   * The API key, never shown: "Saved in Keychain" and Replace when there is one, a field to paste
   * it into when there is none. Escape puts back what was there; Enter or leaving the field saves.
   */
  private apiKeyControls(id: string): (Node | null)[] {
    const input = field({
      id,
      label: "API key",
      value: "",
      type: "password",
      placeholder: wordsFor("provider.apiKey").empty ?? "",
    });
    input.dataset.key = "provider.apiKey";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });
    if (!this.settings["provider.apiKey"]) return [input];
    const saved = h(
      "span",
      { id: "settings-key-saved", class: "pg-value" },
      this.schema["provider.apiKey"]?.keychain ? "Saved in Keychain" : "Saved",
    );
    input.hidden = true;
    const show = (typing: boolean) => {
      input.hidden = !typing;
      saved.hidden = typing;
      swap.hidden = typing;
    };
    const swap = button(
      "Replace",
      () => {
        show(true);
        input.focus();
      },
      "settings-key-replace",
    );
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      input.value = "";
      show(false);
      swap.focus();
    });
    return [saved, swap, input];
  }

  /** What answers now, as a sentence: the agent's state, read only. */
  private agentState(): string {
    const p = this.status.provider;
    if (!p) return "";
    const names: Record<string, string> = {
      "claude-code": "Claude Code",
      codex: "Codex",
      harness: "Claude Code or Codex",
      anthropic: "the Anthropic API",
      "openai-compatible": "the OpenAI-compatible server",
    };
    const name =
      assistantUse(this.settings) === "ollama"
        ? "Ollama"
        : // The harness comes as its id and version: "claude-code/2.1.0".
          (names[p.harness?.replace(/\/.*$/, "") ?? ""] ?? names[p.id] ?? p.id);
    if (p.id === "none") return "Ask shows the matching parts of the call instead.";
    if (p.state === "available")
      return p.id === "harness" || name === "Ollama"
        ? `Uses ${name} on ${this.here}.`
        : `Uses ${name}.`;
    const why = p.reason ?? p.detail;
    // Where akou looked and how to pin a path are for the command line (`akou status`).
    if (p.id === "harness" && why?.startsWith("no harness found"))
      return `${capital(name)} was not found on ${this.here}. Install one, or choose another assistant.`;
    return `${capital(name)} is not available${why ? `: ${this.inWords(why)}.` : "."}`.replace(
      /\.\.$/,
      ".",
    );
  }

  /** Text from akou that may name a setting by its key: each key becomes the setting's label. */
  private inWords(text: string): string {
    // A hint that names an address, as "(for Ollama: http://…)", is for the command line.
    return inWords(text.replace(/\s*\([^()]*:\/\/[^()]*\)/g, ""), Object.keys(this.schema));
  }

  private callAudioControls(id: string, value: string): (Node | null)[] {
    const now = callAudio(value);
    const w = wordsFor("capture.call");
    // The value saved is the hidden field's; the segments and the app field write it.
    const hidden = h("input", { id, type: "hidden", value });
    hidden.dataset.key = "capture.call";
    const app = field({
      id: `${id}-app`,
      label: "The app's id",
      value: now.apps,
      placeholder: "The app's id",
    });
    app.hidden = now.mode !== "app";
    const seg = segmented({
      id: `${id}-mode`,
      label: w.label,
      options: w.choices ?? [],
      value: now.mode,
    });
    const write = () => {
      const mode = seg.input.value;
      app.hidden = mode !== "app";
      const next = mode === "app" ? (app.value.trim() ? `app:${app.value.trim()}` : "") : mode;
      if (mode === "app" && !app.value.trim()) {
        app.focus();
        return;
      }
      if (next === hidden.value) return;
      hidden.value = next;
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    };
    // The segments' own hidden value carries no key: only `hidden` is saved.
    seg.input.addEventListener("change", (e) => {
      e.stopPropagation();
      write();
    });
    app.addEventListener("change", (e) => {
      e.stopPropagation();
      write();
    });
    return [app, seg.root, hidden];
  }

  /** The microphone from the inputs akou lists; a device id to type when it lists none. */
  private micControl(id: string, value: string): HTMLElement {
    const def = this.mics?.find((d) => d.default);
    const options: [string, string][] = [
      ["default", def ? `System default (${def.name})` : "System default"],
      ["none", "None"],
      ...(this.mics ?? []).map((d) => [d.id, d.name] as [string, string]),
    ];
    if (!options.some(([v]) => v === value))
      options.push([value, this.mics ? `${value} (not connected)` : value]);
    const select = selectBox({ id, label: "Your microphone", options, value });
    if (this.mics) return select;
    // akou lists no inputs here: a device is named by its id, typed.
    select.append(h("option", { value: "~" }, "A device by its id…"));
    const typed = field({
      id: `${id}-id`,
      label: "The device's id",
      value: "",
      placeholder: "The device's id",
    });
    typed.hidden = true;
    const hidden = h("input", { type: "hidden", value });
    hidden.dataset.key = "capture.mic";
    select.addEventListener("change", (e) => {
      e.stopPropagation();
      typed.hidden = select.value !== "~";
      if (select.value === "~") {
        typed.focus();
        return;
      }
      hidden.value = select.value;
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    });
    typed.addEventListener("change", (e) => {
      e.stopPropagation();
      const v = typed.value.trim();
      if (!v) return;
      hidden.value = v;
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return h("span", { class: "pg-ctl-group" }, typed, select, hidden);
  }

  private languagesControl(id: string, value: unknown): HTMLElement {
    const list = Array.isArray(value) ? (value as string[]) : [];
    const hidden = h("textarea", { id, hidden: true });
    hidden.value = list.join("\n");
    hidden.dataset.key = "asr.languages";
    const chips = new LanguageList(
      list,
      (l) => {
        hidden.value = l.join("\n");
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      },
      "settings-call-languages",
      "Any language",
    );
    return h("div", { class: "pg-chips" }, chips.root, hidden);
  }

  /**
   * The record shortcut as keycaps, its default when none is set, Change to record another, and
   * Use default to go back to it.
   */
  private hotkeyControls(id: string, value: string): (Node | null)[] {
    const input = h("input", { id, type: "text", value, hidden: true });
    input.dataset.key = "app.hotkey";
    const platform = this.platform;
    this.recorder = new KeyRecorder("app.hotkey", input, this.t, {
      platform,
      button: "Change",
      helper: false,
      label: "record shortcut",
      fallback: hotkeyFor("", platform),
      // The shortcut in use still starts a call while recording: the words ask for a new one.
      chordsOnly: () => "Press the new chord. A key alone cannot start a call.",
      others: () =>
        Object.entries(KEY_SETTINGS)
          .map(([k, words]) => [words, this.settings[k]] as [string, unknown])
          .filter((x): x is [string, string] => typeof x[1] === "string"),
    });
    this.recorder.warnSaved();
    const reset = button(
      "Use default",
      () => {
        input.value = "";
        input.dispatchEvent(new Event("input"));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      "settings-hotkey-default",
    );
    const follow = () => {
      reset.hidden = input.value === "";
    };
    input.addEventListener("input", follow);
    input.addEventListener("change", follow);
    follow();
    return [this.recorder.root, reset, input];
  }

  /** Where share links listen: the tailnet, the local network, this computer, or an address typed. */
  private bindControl(id: string, value: string): HTMLElement {
    const w = wordsFor("share.bind");
    const options = w.choices ?? [];
    const known = options.some(([v]) => v === value);
    const select = selectBox({ id, label: w.label, options, value: known ? value : "~" });
    select.append(h("option", { value: "~" }, "An address…"));
    select.value = known ? value : "~";
    const typed = field({
      id: `${id}-address`,
      label: "The address",
      value: known ? "" : value,
      placeholder: "An IPv4 address",
    });
    typed.hidden = known;
    const hidden = h("input", { type: "hidden", value });
    hidden.dataset.key = "share.bind";
    const write = (v: string) => {
      if (!v || v === hidden.value) return;
      hidden.value = v;
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    };
    select.addEventListener("change", (e) => {
      e.stopPropagation();
      typed.hidden = select.value !== "~";
      if (select.value === "~") {
        typed.focus();
        return;
      }
      write(select.value);
    });
    typed.addEventListener("change", (e) => {
      e.stopPropagation();
      write(typed.value.trim());
    });
    return h("span", { class: "pg-ctl-group" }, typed, select, hidden);
  }

  /**
   * A folder as its name and its parent's, with a list to type another or, where it may be
   * empty, choose none. The path shows only in the field it is typed into.
   */
  private folderControls(
    id: string,
    key: string,
    value: string,
    fileOnly: boolean,
  ): (Node | null)[] {
    const w = wordsFor(key);
    const mayBeEmpty = (this.schema[key]?.min ?? 0) === 0;
    const hidden = h("input", { id, type: "hidden", value });
    hidden.dataset.key = key;
    const typed = field({
      id: `${id}-path`,
      label: `${w.label}: where`,
      value,
      placeholder: "The folder's full path",
    });
    typed.classList.add("wide");
    typed.hidden = true;
    const f = folderName(value);
    const choose = h(
      "select",
      { id: `${id}-pick`, class: "pg-select pg-folder", attrs: { "aria-label": w.label } },
      value ? h("option", { value: "=" }, f.parent ? `${f.name} in ${f.parent}` : f.name) : null,
      mayBeEmpty ? h("option", { value: "" }, "Nowhere") : null,
      h("option", { value: "~" }, value ? "Another folder…" : "A folder…"),
    );
    choose.value = value ? "=" : "";
    choose.addEventListener("change", (e) => {
      e.stopPropagation();
      if (choose.value === "~") {
        typed.hidden = false;
        typed.focus();
        typed.select();
        return;
      }
      typed.hidden = true;
      if (choose.value === "" && hidden.value !== "") {
        hidden.value = "";
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    typed.addEventListener("change", (e) => {
      e.stopPropagation();
      const next = typed.value.trim();
      if (!next || next === hidden.value) return;
      hidden.value = next;
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    });
    typed.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      typed.value = hidden.value;
      typed.hidden = true;
      choose.value = hidden.value ? "=" : "";
    });
    if (fileOnly) choose.disabled = true;
    return [typed, choose, hidden];
  }

  private workspacesRow(): HTMLElement {
    const names = [...new Set(["default", ...(this.hooks.workspaces?.() ?? [])])];
    return row(
      { label: "Workspaces", help: "A call recorded into a new workspace creates it." },
      h("span", { id: "settings-workspaces", class: "pg-value" }, names.map(title).join(", ")),
    );
  }

  /**
   * The live panel's three values as rows, as the Record row and the Models page show them: the
   * live model, the second pass and how often. Each opens the Models page, where they are chosen.
   */
  private liveRow(): HTMLElement[] | null {
    if (!("asr.live" in this.schema)) return null;
    const l = this.live;
    const liveId = l?.slots?.live.find((e) => e.checked)?.id;
    const setting = String(this.settings["asr.live"] ?? l?.setting ?? "auto");
    const name = liveId ? liveModelName(liveId) : "No model yet";
    const live = setting === "auto" && liveId ? `Automatic, ${name}` : name;
    const reviewId = l?.slots?.review.find((e) => e.checked)?.id;
    const every = l?.review?.everySeconds ?? Number(this.settings["asr.review.everySeconds"] ?? 60);
    const open = (key: string) => () => this.hooks.openModels?.(key);
    return [
      linkRow({ label: "Live model", value: live, id: "settings-live" }, open("asr.live")),
      linkRow(
        {
          label: "Second pass",
          value: reviewId ? liveModelName(reviewId) : "Off",
          id: "settings-review",
        },
        open("asr.review.model"),
      ),
      linkRow(
        { label: "Second pass every", value: capitalEvery(every), id: "settings-review-every" },
        open("asr.review.everySeconds"),
      ),
    ];
  }

  private afterCallRow(): HTMLElement {
    const hooks = Array.isArray(this.settings.hooks) ? this.settings.hooks.length : 0;
    const webhook =
      typeof this.settings["webhook.url"] === "string" && this.settings["webhook.url"] !== "";
    const parts = [
      webhook ? "a webhook" : "",
      hooks > 0 ? `${hooks} command${hooks === 1 ? "" : "s"}` : "",
    ].filter((p) => p !== "");
    const text = parts.length === 0 ? "Nothing" : capital(parts.join(" and "));
    return row(
      {
        label: "After a call, send it to",
        help: "Set in the config file, since it decides where your calls go.",
      },
      h("span", { id: "settings-after-call", class: "pg-value" }, text),
      this.openConfigButton(),
    );
  }

  private yourWords(): HTMLElement | null {
    if (!this.hooks.openDictionary) return null;
    return row(
      {
        label: "Your words",
        help: "Words akou should spell your way, and what to write for what you say.",
      },
      button("Open", () => this.hooks.openDictionary?.(), "settings-dictionary"),
    );
  }

  private openConfigButton(): HTMLButtonElement {
    return button(
      "Open config file",
      () =>
        void this.t.openSettingsPane("config").then((ok) => {
          if (!ok) toast("This window cannot open the config file here.");
        }),
    );
  }

  /**
   * The foot: the version and the speech engine's state, read only, in words (the engine's own
   * reason names a folder and a command, so it is never shown); on an Advanced page, the config
   * file, where its file-only rows are set.
   */
  private foot(): HTMLElement {
    const v = this.status.app?.version;
    const asr = this.status.asr;
    const missing =
      asr?.state === "unavailable" && /speech models are not in/.test(asr.reason ?? "");
    const engine = !asr
      ? ""
      : asr.state === "ready"
        ? "The speech engine is ready."
        : asr.state === "loading"
          ? "The speech engine is starting."
          : missing
            ? "The speech models are not downloaded yet."
            : "The speech engine could not start.";
    return h(
      "div",
      { class: "pg-foot" },
      v ? h("span", { id: "settings-version" }, `akou ${v}`) : null,
      engine ? h("span", { id: "settings-engine-state" }, engine) : null,
      missing && this.hooks.openModels
        ? button("Open Models", () => this.hooks.openModels?.(), "settings-get-models")
        : null,
      h("span", { class: "grow" }),
      this.sub ? this.openConfigButton() : null,
    );
  }

  // -------------------------------------------------------------------------
  // Saving

  /** Saves the one key of this row. */
  private async save(r: HTMLElement): Promise<void> {
    const patch = changedSettings(r, this.schema, this.shown);
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const res = await this.t.request<{ note?: string }>("PATCH", "/config", patch);
    if (res.status >= 400) {
      this.refused(r, keys, res.body);
      return;
    }
    for (const [k, v] of Object.entries(patch)) {
      const spec = this.schema[k];
      // A secret is never kept on the page, only whether there is one.
      this.settings[k] = spec?.secret ? (v ? "(set)" : "") : v;
      this.issues.delete(k);
      this.shown[k] = spec?.secret ? "" : shownValue(spec, v);
      if (spec?.secret) {
        const input = r.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(k)}"]`);
        if (input) {
          input.value = "";
          input.placeholder = v ? "Set, type to replace" : (wordsFor(k).empty ?? "Not set");
        }
      }
    }
    r.classList.remove("refused");
    r.querySelector(".issue")?.remove();
    toast(this.savedNote(keys, res.body?.note), "info");
    // What the agent is, and which details apply, follow the kind and the harness.
    if (keys.some((k) => k.startsWith("provider.")) && this.root.isConnected) {
      const st = await this.t.request<Status>("GET", "/status");
      if (st.status < 400) this.status = st.body ?? {};
      if (["provider.kind", "provider.harness", "provider.apiKey"].some((k) => keys.includes(k)))
        this.redraw();
    }
  }

  /** What a save says: the assistant's settings apply at once, so no note about a restart. */
  private savedNote(keys: string[], note: string | undefined): string {
    return keys.every((k) => k.startsWith("provider.")) ? "Saved." : (note ?? "Saved.");
  }

  /** Saves several keys at once (the assistant's use), then reads and draws the page again. */
  private async saveMany(r: HTMLElement, patch: Record<string, unknown>): Promise<void> {
    const res = await this.t.request<{ note?: string }>("PATCH", "/config", patch);
    if (res.status >= 400) {
      this.refused(r, Object.keys(patch), res.body);
      return;
    }
    toast(this.savedNote(Object.keys(patch), res.body?.note), "info");
    await this.load();
    if (this.root.isConnected) this.redraw();
  }

  /**
   * A refused change: the reason under the row's label, in the row's words rather than the key's,
   * and the same in a toast.
   */
  private refused(r: HTMLElement, keys: string[], body: unknown): void {
    const errors = (body as { errors?: string[] }).errors ?? [message(body, "refused")];
    const lines = errors.map((e) => {
      const key = keys.find((k) => e.startsWith(`${k}:`));
      return key ? { key, text: e.slice(key.length + 1).trim() } : { key: null, text: e };
    });
    const mine = lines.find((l) => l.key !== null) ?? lines[0];
    r.classList.add("refused");
    r.querySelector(".issue")?.remove();
    const why = this.inWords(mine?.text ?? "");
    r.querySelector(".pg-lbl")?.append(h("small", { class: "issue" }, capital(why)));
    const label = wordsFor(keys[0] ?? "").label;
    toast(`${label} was not saved: ${why}`);
  }

  /** Draws again where the page is, keeping the focus on the same setting. */
  private redraw(): void {
    const at = (document.activeElement as HTMLElement | null)?.closest?.(
      ".pg-row[data-key]",
    ) as HTMLElement | null;
    const key = at?.dataset.key;
    const top = this.root.parentElement?.scrollTop ?? 0;
    this.draw();
    this.root.parentElement?.scrollTo?.({ top });
    if (key) this.focusRow(key);
  }

  // -------------------------------------------------------------------------
  // Finding a setting

  private index(): SearchItem[] {
    const out: SearchItem[] = [];
    const subs = this.subs();
    const add = (key: string, where: string, sub: string | null) => {
      if (!(key in this.schema)) return;
      const w = wordsFor(key);
      out.push({ label: w.label, help: w.help ?? "", where, go: () => this.goTo(key, sub) });
    };
    for (const s of this.main)
      for (const item of s.items) {
        if (item === LIVE && "asr.live" in this.schema)
          out.push({
            label: "Live model",
            help: "Second pass",
            where: "Models",
            go: () => this.hooks.openModels?.(),
          });
        else if (item === AFTER_CALL)
          out.push({
            label: "After a call, send it to",
            help: "webhook commands",
            where: "Settings",
            go: () => this.goToRow("settings-after-call"),
          });
        else if (!/^[#>]/.test(item)) add(item, "Settings", null);
      }
    for (const [name, p] of Object.entries(subs))
      for (const g of p.groups) for (const k of g.keys) add(k, p.title, name);
    // The Models page's settings are found here too, and the search goes there.
    if (this.hooks.openModels && !this.hooks.server)
      for (const k of MODELS_KEYS)
        if (k !== "asr.live" && k in this.schema)
          out.push({
            label: MODELS_WORDS[k] ?? wordsFor(k).label,
            help: wordsFor(k).label,
            where: "Models",
            go: () => this.hooks.openModels?.(k),
          });
    return out;
  }

  private find(): void {
    const q = this.search.value.trim().toLowerCase();
    if (!q) {
      this.results.hidden = true;
      return;
    }
    this.found = this.index()
      .filter((i) => `${i.label} ${i.help}`.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(!a.label.toLowerCase().includes(q)) - Number(!b.label.toLowerCase().includes(q)),
      )
      .slice(0, 8);
    this.pick = 0;
    this.drawFound();
  }

  private drawFound(): void {
    replace(
      this.results,
      ...(this.found.length === 0
        ? [h("div", { class: "none" }, "No setting has those words.")]
        : this.found.map((f, i) =>
            h(
              "div",
              {
                class: i === this.pick ? "hi" : "",
                role: "option",
                attrs: { "aria-selected": String(i === this.pick) },
                on: {
                  mousedown: (e) => e.preventDefault(),
                  click: () => this.choose(f),
                },
              },
              h("span", {}, f.label),
              h("span", { class: "where" }, f.where),
            ),
          )),
    );
    this.results.hidden = false;
  }

  private searchKey(e: KeyboardEvent): void {
    if (this.results.hidden || this.found.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = this.found.length;
      this.pick = (this.pick + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      this.drawFound();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = this.found[this.pick];
      if (f) this.choose(f);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.search.value = "";
      this.results.hidden = true;
    }
  }

  private choose(f: SearchItem): void {
    this.results.hidden = true;
    this.search.value = "";
    f.go();
  }

  /** Goes to a key's row, on the page it lives on, and gives its control the focus. */
  private goTo(key: string, sub: string | null = this.pageOf(key)): void {
    if (sub !== this.sub) {
      void this.saveTyped();
      this.sub = sub;
      this.draw();
    }
    this.focusRow(key);
  }

  private goToRow(id: string): void {
    if (this.sub !== null) {
      void this.saveTyped();
      this.sub = null;
      this.draw();
    }
    const el = document.getElementById(id)?.closest<HTMLElement>(".pg-row");
    if (el) flash(el);
  }

  private focusRow(key: string): void {
    const r = this.col.querySelector<HTMLElement>(`.pg-row[data-key="${CSS.escape(key)}"]`);
    if (!r) return;
    flash(r);
    const control =
      r.querySelector<HTMLElement>(
        `select[data-key="${CSS.escape(key)}"], input[data-key="${CSS.escape(key)}"]:not([type=hidden]), textarea[data-key="${CSS.escape(key)}"]:not([hidden])`,
      ) ??
      r.querySelector<HTMLElement>(
        ".pg-ctl input:not([type=hidden]):not([hidden]), .pg-ctl select, .pg-ctl button, .pg-ctl textarea:not([hidden])",
      );
    control?.focus();
  }
}

/** The id of the first control a label can name, for its `for`. */
function controlId(controls: (Node | null)[]): string | null {
  for (const c of controls) {
    if (!(c instanceof HTMLElement)) continue;
    if (c.matches("input:not([type=hidden]):not([hidden]), select, textarea:not([hidden])"))
      return c.id || null;
  }
  return null;
}

/** Brings a row into view and marks it a moment. */
function flash(el: HTMLElement): void {
  el.scrollIntoView({ block: "center" });
  el.classList.add("pg-flash");
  // clock: how long a setting's highlight shows.
  setTimeout(() => el.classList.remove("pg-flash"), 1200);
}

function hooksText(v: unknown): string {
  const n = Array.isArray(v) ? v.length : 0;
  return n === 0 ? "None" : `${n} command${n === 1 ? "" : "s"}`;
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A workspace's name as the list shows it: `default` is "Default". */
function title(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `Every 2 min`, as the Models page's list says it. */
function capitalEvery(seconds: number): string {
  const t = everyText(seconds);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
