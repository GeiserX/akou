/**
 * The Dictation page (docs/ux/design-explorations/sd-a-dictation.html, docs/ux/DICTATION.md
 * section 6, DC-U1): a page of the main window, opened from the sidebar like Settings and Models,
 * not a dialog over the call. One scrolling column of sections, each a rounded panel of rows with
 * a human label, one short line of help at most and its control on the right; a default shows as
 * its value, and nothing on the page names a key, a file or a value in code quotes (the words are
 * in `settings-labels.ts`). The settings a person rarely changes are on its Advanced page, whose
 * row names what it holds.
 *
 * The same component draws server mode's Dictation page (SV-U2): only what a server has, the
 * dictations it serves other computers, since a server has no keyboard to type into.
 *
 * Each change saves that key alone through `PATCH /config`; a refusal shows under the row's label.
 * A field being typed into saves when it is left, and leaving the page saves what is still in one.
 *
 * `dictation.remote.url` decides where dictation audio goes, so it is written from the desktop
 * window (its RPC) or the config file only, never over the HTTP API, the same rule as `webhook.url`
 * and `server.remotes`: a browser page shows it and cannot change it.
 *
 * The page never records: a browser page served over plain http from another machine has no
 * microphone at all (no `getUserMedia` outside a secure context), and says so rather than failing.
 */

import { QWEN_LANGUAGE_CODES } from "../main/asr/llama-catalog.ts";
import type { Grant } from "../main/dictation/protocol.ts";
import { dictationHotkeyDefault, fixLastDefault, hotkeyFor } from "../main/window/hotkey.ts";
import { appsEditor, nextDictatedApp } from "./dictation-apps.ts";
import { cueStyle } from "./dictation-cues.ts";
import type { DictationDictionary } from "./dictation-dictionary.ts";
import type { DictationHistory } from "./dictation-history.ts";
import { LanguageList, languageName } from "./dictation-languages.ts";
import { MIC_KEY, type MicList, micMeter, micNote, micPicker, readMics } from "./dictation-mic.ts";
import { KEY_SETTINGS, KeyRecorder } from "./dictation-recorder.ts";
import { remoteParts } from "./dictation-remote.ts";
import { type DictationReview, readDictationReview, waitingTerms } from "./dictation-review.ts";
import { DictationSetup, grantOk } from "./dictation-setup.ts";
import { h, replace, toast } from "./dom.ts";
import { type JobModels, jobModelChoices, modelName } from "./models-rows.ts";
import { message } from "./notepad.ts";
import type { Reply, Transport } from "./protocol.ts";
import {
  backLink,
  button,
  choiceRow,
  field,
  icon,
  keycaps,
  linkRow,
  pageHead,
  row,
  section,
  segmented,
  selectBox,
  selectOrTyped,
  toggle,
  unit,
} from "./rows.ts";
import { twoStep } from "./server-common.ts";
import { type ConfigReply, changedSettings, type SchemaEntry, shownValue } from "./settings.ts";
import { inWords, wordsFor } from "./settings-labels.ts";

/** A section of the page: its title and what it shows, a key or a row drawn by hand (`#`). */
export interface DictationGroup {
  title: string;
  keys: readonly string[];
}

/** The grants the dictation helper reports (`GET /dictation`, DC-G1), as its `ready` names them. */
export interface DictationGrants {
  mic: Grant;
  accessibility: Grant;
}

/** What `GET /dictation` says: the grants, the ones the running helper lost (DC-N1), the engine. */
type DictationReply = {
  grants?: DictationGrants;
  lost?: unknown;
  engine?: string | null;
  swallow_keys?: boolean;
  /** The streaming model the words while you speak come from; null for Parakeet (DC-E7). */
  live?: string | null;
  /** What a dictation inserts now, as the engines resolve here (DC-E7). */
  final?: string | null;
};

/** The master switch, the first row. */
export const ENABLE_KEY = "dictation.enabled";

/** Where dictation audio goes: the desktop window or the config file only. */
export const REMOTE_URL_KEY = "dictation.remote.url";

/** The sounds and the pill: together they decide what `auto` plays now (DC-O3). */
const SOUNDS_KEY = "dictation.sounds";
const PILL_KEY = "dictation.pill";

/** Reading the field back (DC-L2), which on macOS waits for the Accessibility grant. */
const READ_FIELD_KEY = "dictation.readField";
const LEARN_KEY = "dictation.learn";
const ENGINE_KEY = "dictation.engine";
/** What a dictation inserts (DC-E7): while `dictation.engine` is `auto`, this decides. */
const FINAL_KEY = "dictation.final";
/** The `dictation.engine` a choice of `dictation.final` saves with it, so what shows is what runs. */
const FINAL_ENGINE: Readonly<Record<string, string>> = {
  parakeet: "fast",
  qwen: "best",
  live: "auto",
};
const FORMAT_KEY = "dictation.format";
const PROMPT_KEY = "dictation.formatPrompt";
const FORMAT_WAIT_KEY = "dictation.formatTimeoutSeconds";

/** The rows that only apply while dictation goes to another computer. */
const REMOTE_KEYS = [
  REMOTE_URL_KEY,
  "dictation.remote.key",
  "dictation.remote.fallback",
  "dictation.remote.timeoutSeconds",
];

/** The rows drawn by hand. */
const MIC_GRANT = "#mic-grant";
const A11Y_GRANT = "#accessibility-grant";
const SETUP = "#setup";
const WHILE = "#while-listening";
/** The rows, and `show`'s names, of the Words and History pages under this one. */
export const WORDS = "#words";
export const HISTORY = "#history";
const LIVE_WORDS = "#live-words";
const REVIEW = "#review";
const ADVANCED = "#advanced";

/** The sections of the app-mode page, in the mockup's order. */
export const DICTATION_GROUPS: readonly DictationGroup[] = [
  { title: "", keys: [ENABLE_KEY, MIC_GRANT, A11Y_GRANT, SETUP] },
  {
    title: "Keys",
    keys: [
      "dictation.hotkey",
      "dictation.activation",
      WHILE,
      "dictation.hotkeyFixLast",
      "dictation.hotkeyDraft",
      "dictation.hotkeyPasteLast",
    ],
  },
  {
    title: "Voice",
    keys: [
      "dictation.languages",
      MIC_KEY,
      "dictation.preferBuiltInOverBluetooth",
      "dictation.muteMedia",
    ],
  },
  { title: "Words and history", keys: [WORDS, HISTORY] },
  { title: "Rules per app", keys: ["dictation.apps"] },
  { title: "Engine", keys: [LIVE_WORDS, FINAL_KEY, ENGINE_KEY, ...REMOTE_KEYS] },
  {
    title: "Inserting",
    keys: [
      "dictation.insert",
      "dictation.sendKey",
      "dictation.sendAlways",
      "dictation.restoreClipboard",
      "dictation.smartSpacing",
      "dictation.trailingSpace",
    ],
  },
  {
    title: "Cleaning up",
    keys: [
      "dictation.fillers",
      "dictation.spokenPunctuation",
      "dictation.spokenSend",
      FORMAT_KEY,
      PROMPT_KEY,
    ],
  },
  { title: "Learning", keys: [LEARN_KEY, READ_FIELD_KEY, "dictation.learn.audioCheck", REVIEW] },
  { title: "Pill and sounds", keys: [PILL_KEY, "dictation.pillPreview", SOUNDS_KEY] },
  { title: "Advanced", keys: [ADVANCED] },
];

/** The Advanced page: what it holds, as its row says it, and its sections. */
export const ADVANCED_PAGE = {
  title: "Advanced",
  help: "Silence and length, the mic, one fixed language, context words, time limits.",
  groups: [
    {
      title: "Listening",
      keys: ["dictation.silenceStopSeconds", "dictation.maxMinutes", "dictation.warmMic"],
    },
    {
      title: "Language",
      keys: ["dictation.language", "dictation.glossary", "dictation.glossaryMax"],
    },
    {
      title: "Time limits",
      keys: [
        "dictation.localTimeoutSeconds",
        "dictation.formatTimeoutSeconds",
        "asr.qwenIdleMinutes",
      ],
    },
  ] as readonly DictationGroup[],
};

/** The History page's settings, above the dictations (sd-a-history). */
export const HISTORY_KEYS: readonly string[] = ["dictation.retainDays", "dictation.keepAudio"];

/** Server mode: what the server does for dictating clients. */
export const SERVER_GROUPS: readonly DictationGroup[] = [
  { title: "For other computers", keys: ["server.dictation_slots", "server.dictation_engine"] },
];

/** The setting a dictating client's request runs when it names no engine (server mode). */
export const SERVER_ENGINE_KEY = "server.dictation_engine";

/**
 * The engine for other computers' dictation: Automatic, a preset or a model by name (`choices`,
 * the server's own list when it answered, else the presets in words), or a model named by its id,
 * which the setting takes too. The Settings page draws it the same way.
 */
export function serverEngineControl(
  id: string,
  value: string,
  choices?: readonly (readonly [value: string, label: string])[],
): HTMLElement {
  const w = wordsFor(SERVER_ENGINE_KEY);
  return selectOrTyped({
    id,
    key: SERVER_ENGINE_KEY,
    label: w.label,
    options: choices?.length ? choices : (w.choices ?? []),
    value,
    other: "A model, by its id…",
    placeholder: "Its id, such as qwen3-asr-1.7b",
  });
}

/** Every key the app-mode page and its Advanced page place. */
export function dictationKeys(): string[] {
  return [...DICTATION_GROUPS, ...ADVANCED_PAGE.groups]
    .flatMap((g) => g.keys)
    .concat(HISTORY_KEYS)
    .filter((k) => !k.startsWith("#"));
}

/** A key the Dictation page shows, so the Settings page leaves it out. */
export function onDictationPage(key: string): boolean {
  return key.startsWith("dictation.") || dictationKeys().includes(key);
}

/** The words the server-mode page shows instead of a record button when it has no microphone. */
export const NO_MIC_NOTICE =
  "This page is served over plain http from another computer, so the browser gives it no microphone. Dictate from the akou app, with this server as the other computer it uses.";

export interface DictationHooks {
  /** The Words page's list: words, replacements and the words to review (DC-U5, DC-L5). */
  words?: DictationDictionary;
  /** The History page's list (DC-H1). */
  history?: DictationHistory;
  /**
   * "Run the setup again" opens the window's first-run setup (`setup-wizard.ts`) with what is set
   * now; absent, it runs dictation's own setup (DC-N3), which the switch still runs for a missing
   * grant.
   */
  runSetup?: () => void;
  /** Opens the Models page: the words while you speak need a streaming model (DC-E7). */
  openModels?: () => void;
}

/** A page under the Dictation page, reached from its row and left by its back link. */
type Sub = "advanced" | "words" | "history";

/** The rows that lead to each page under this one, for the focus on the way back. */
const SUB_ROWS: Record<Sub, string> = {
  advanced: "dictation-advanced",
  words: "dictation-dictionary-open",
  history: "dictation-history-open",
};

type Status = {
  app?: { platform?: string };
  provider?: { id?: string; harness?: string };
};

/** How long the AI tidy may take: Automatic (0) by name, never a bare 0, then whole seconds. */
function formatWait(
  id: string,
  label: string,
  spec: SchemaEntry,
  value: unknown,
): HTMLSelectElement {
  const min = spec.min ?? 0;
  const max = spec.max ?? 60;
  const steps = [2, 4, 6, 8, 10, 15, 20, 30, 45, 60].filter(
    (n) => n >= Math.max(min, 1) && n <= max,
  );
  return selectBox({
    id,
    label,
    options: [
      ...(min <= 0 ? [["0", "Automatic"] as const] : []),
      ...steps.map((n) => [String(n), `${n} seconds`] as const),
    ],
    value: String(value ?? 0),
  });
}
/** One line of help at most: while `now` says something, the row's own help steps aside. */
function helpGives(now: HTMLElement): void {
  const help = now.parentElement?.querySelector<HTMLElement>(":scope > div.pg-help");
  if (help) help.hidden = !now.hidden && now.textContent !== "";
}
export class DictationPage {
  readonly name = "dictation" as const;
  readonly title = "Dictation";
  readonly root = h("section", {
    id: "page-dictation",
    class: "pg",
    attrs: { "aria-label": "Dictation" },
  });
  private readonly col = h("div", { class: "pg-col" });
  private schema: Record<string, SchemaEntry> = {};
  private settings: Record<string, unknown> = {};
  private issues = new Map<string, string>();
  /** What each key's control held when drawn, so a save sends only an edit. */
  private shown: Record<string, string> = {};
  private reads = 0;
  private shows = 0;
  private readonly armed = new Map<string, number>();
  /** The OS akou runs on, from its status: the recorder's keycaps and warnings follow it. */
  private platform = "";
  private status: Status = {};
  /** What `GET /dictation` says; null where it says nothing (server mode, an older app). */
  private dictation: DictationReply | null = null;
  /** The grants the running helper lost since it started (DC-N1): its key does nothing now. */
  private lost: string[] = [];
  private recorders: KeyRecorder[] = [];
  /** Dictation's setup (DC-N3), drawn instead of the sections while it runs. */
  private setup: DictationSetup | null = null;
  /** The inputs `GET /devices` lists for the microphone picker (DC-U4); null in server mode. */
  private mics: MicList | null = null;
  /** The microphone's live level while the page shows it. */
  private meter: { close(): void } | null = null;
  /** The wait for the next dictation's app, for a per-app rule (DC-U9). */
  private waitApp: { stop(): void } | null = null;
  /** The words fixed while dictating, for the Learning section's count (DC-L5). */
  private review: DictationReview | null = null;
  /** Dictations served in the last hour, in server mode. */
  private served: number | undefined;
  /** Server mode: the presets and engines a dictation may run, as a select's choices. */
  private engines: [value: string, label: string][] = [];
  /** The page under this one on screen instead of the page itself, if any. */
  private sub: Sub | null = null;
  /** "Use another computer" was turned on before an address was saved: the address turns it on. */
  private remotePending = false;
  /** Why `GET /config` failed, said where the settings would be; null once it answers. */
  private readError: string | null = null;
  /** Automatic, Fast or Best: what the engine goes back to when another computer is turned off. */
  private localEngine = "auto";
  /** The saves on their way, by the change they send. */
  private readonly saving = new Map<string, Promise<void>>();

  constructor(
    private readonly t: Transport,
    private readonly mode: "app" | "server",
    private readonly hooks: DictationHooks = {},
  ) {
    this.root.append(this.col);
    this.root.addEventListener("change", (e) => this.changed(e.target as HTMLElement));
    // History retries on another computer only when one has an address.
    if (hooks.history)
      hooks.history.remote = () => String(this.settings[REMOTE_URL_KEY] ?? "").trim() !== "";
  }

  /** Reads everything and draws the page; on `key`, goes to that setting. */
  async show(key?: string): Promise<void> {
    const shown = ++this.shows;
    await this.saveTyped();
    if (shown !== this.shows) return;
    replace(this.col, h("p", { class: "pg-reading" }, "Reading the dictation settings…"));
    const sub = subFor(key, this.hooks);
    await Promise.all([this.load(), this.loadSub(sub)]);
    if (shown !== this.shows) return;
    this.sub = sub;
    this.draw();
    if (key && !key.startsWith("#")) this.focusRow(key);
  }

  /** Reads what a page under this one lists: the words, or the dictations. */
  private async loadSub(sub: Sub | null): Promise<void> {
    if (sub === "words") await this.hooks.words?.load();
    if (sub === "history") await this.hooks.history?.load();
  }

  /** Goes to a page under this one; what is typed is saved and a key recording stops first. */
  private async openSub(sub: Sub): Promise<void> {
    // A live recorder would take every key typed into the page's fields.
    this.stopRecording();
    const shown = ++this.shows;
    await Promise.all([this.saveTyped(), this.loadSub(sub)]);
    if (shown !== this.shows) return;
    this.sub = sub;
    this.draw();
    // The draw scrolls the page to its top, smoothly; a focus that scrolled would stop it.
    this.col.querySelector<HTMLElement>(".pg-back")?.focus({ preventScroll: true });
  }

  /** "‹ Dictation": back to this page, with the keyboard on the row it came through. */
  private back(): HTMLButtonElement {
    return backLink("Dictation", async () => {
      const from = this.sub;
      const shown = ++this.shows;
      // Saved first, so the row that led here shows what was typed there.
      await this.saveTyped();
      if (shown !== this.shows) return;
      this.sub = null;
      this.draw();
      if (from) this.col.querySelector<HTMLElement>(`#${SUB_ROWS[from]}`)?.focus();
      // The words to review may have been answered there.
      if (from === "words") void this.refreshReview();
    });
  }

  /** Reads everything again and draws the page, saving nothing first. */
  private async reread(): Promise<void> {
    const shown = ++this.shows;
    await this.load();
    if (shown !== this.shows) return;
    this.draw();
  }

  /** The page is left: what is typed is saved; no recorder, meter, wait or setup outlives it. */
  leave(): void {
    this.shows++;
    void this.saveTyped();
    this.close();
  }

  /** Server mode's name for leaving. */
  hide(): void {
    this.leave();
  }

  /** Stops what listens: the key recorders, the level, the wait for an app, a setup half way. */
  private close(): void {
    this.stopRecording();
    this.stopMeter();
    this.stopNextApp();
    this.setup?.stop();
    this.setup = null;
  }

  private async load(): Promise<void> {
    const read = ++this.reads;
    const app = this.mode === "app";
    // A request that throws (akou out of reach) is said where the settings go, as a refused read
    // is, so the page never stays on "Reading the dictation settings…".
    const reach = (err: Error): Reply<ConfigReply> => ({
      status: 599,
      body: { message: `akou is out of reach (${err.message})` } as unknown as ConfigReply,
    });
    const [cfg, server, status, dictation, mics, review] = await Promise.all([
      this.t.request<ConfigReply>("GET", "/config").catch(reach),
      app
        ? null
        : this.t.request<JobModels & { dictation?: { served_last_hour?: number } }>(
            "GET",
            "/server",
          ),
      app ? this.t.request<Status>("GET", "/status") : null,
      app ? this.readDictation() : null,
      app ? readMics(this.t) : null,
      app && this.hooks.words ? readDictationReview(this.t) : null,
    ]);
    if (read !== this.reads) return;
    // "Use another computer" turned on with no address saved is forgotten with the page.
    this.remotePending = false;
    this.issues = new Map();
    this.review = review;
    this.status = status && status.status < 400 ? (status.body ?? {}) : {};
    this.platform = String(this.status.app?.platform ?? "");
    this.dictation = dictation;
    this.lost = lostOf(dictation);
    this.mics = mics;
    this.served = server?.body?.dictation?.served_last_hour;
    this.engines = server && server.status < 400 ? jobModelChoices(server.body) : [];
    this.readError = null;
    if (cfg.status !== 200) {
      this.schema = {};
      this.settings = {};
      this.readError = `The dictation settings could not be read: ${message(cfg.body, `HTTP ${cfg.status}`)}`;
      toast(message(cfg.body, "the settings could not be read"));
      return;
    }
    this.schema = cfg.body.schema;
    this.settings = { ...cfg.body.settings };
    this.issues = new Map(cfg.body.issues.map((i) => [i.key, i.message]));
    const engine = this.settings[ENGINE_KEY];
    if (typeof engine === "string" && engine !== "remote") this.localEngine = engine;
    // The file asks for another computer but has no address, so the registry uses the default
    // engine: the switch is on and waits for the address, as if turned on here.
    this.remotePending = this.remoteAsked();
  }

  /** `GET /dictation`, or null where the app says nothing. */
  private async readDictation(): Promise<DictationReply | null> {
    const r = await this.t.request<DictationReply>("GET", "/dictation");
    return r.status >= 400 ? null : (r.body ?? null);
  }

  private get grants(): DictationGrants | null {
    return this.dictation?.grants ?? null;
  }

  private get mac(): boolean {
    return this.platform === "darwin";
  }

  private get here(): string {
    return this.mac ? "this Mac" : "this computer";
  }

  // -------------------------------------------------------------------------
  // Drawing

  private draw(): void {
    this.stopRecording();
    this.stopMeter();
    this.stopNextApp();
    this.recorders = [];
    this.shown = {};
    if (this.setup) {
      // The switch stays above the setup, which turns it on at its end.
      replace(
        this.col,
        pageHead("Dictation"),
        section("", this.keyRow(ENABLE_KEY)),
        h("div", { class: "pg-grp pg-setup" }, this.setup.root),
      );
      return;
    }
    if (this.sub === "words" || this.sub === "history") {
      replace(this.col, ...(this.sub === "words" ? this.wordsPage() : this.historyPage()));
      this.root.parentElement?.scrollTo?.({ top: 0 });
      return;
    }
    const groups =
      this.mode === "server"
        ? SERVER_GROUPS
        : this.sub === "advanced"
          ? ADVANCED_PAGE.groups
          : DICTATION_GROUPS;
    // An akou whose registry has none of the page's keys has no dictation to set.
    const any = groups.some((g) => g.keys.some((k) => k in this.schema));
    const sections = (any ? groups : [])
      .map((g) => {
        const rows = g.keys.flatMap((k) => this.item(k) ?? []);
        return rows.length > 0 ? section(g.title, ...rows) : null;
      })
      .filter((x): x is HTMLElement => x !== null);
    const head =
      this.sub === "advanced"
        ? pageHead(ADVANCED_PAGE.title, { back: this.back() })
        : pageHead("Dictation");
    replace(
      this.col,
      head,
      this.mode === "server" ? this.serverNotes() : null,
      ...sections,
      sections.length === 0
        ? h(
            "p",
            { class: "pg-sechelp", attrs: { "data-empty": "" } },
            // A read that failed says why, not that there is nothing to set.
            this.readError ?? "This akou has no dictation settings yet.",
          )
        : null,
    );
    this.soundsNow();
    this.root.parentElement?.scrollTo?.({ top: 0 });
  }

  private item(item: string): HTMLElement | HTMLElement[] | null {
    switch (item) {
      case LIVE_WORDS:
        return this.mode === "app" ? this.liveWordsRow() : null;
      case FINAL_KEY:
        return this.finalRows();
      case MIC_GRANT:
        return this.micGrant();
      case A11Y_GRANT:
        return this.accessibilityGrant();
      case SETUP:
        return this.grants
          ? linkRow({ label: "Run the setup again", id: "dictation-setup-open" }, () =>
              this.hooks.runSetup ? this.hooks.runSetup() : this.runSetup(),
            )
          : null;
      case WHILE:
        return this.whileListening();
      case WORDS:
        return this.hooks.words
          ? linkRow(
              {
                label: "Words and replacements",
                help: "Names and terms spelled your way.",
                id: "dictation-dictionary-open",
              },
              () => void this.openSub("words"),
            )
          : null;
      case HISTORY:
        return this.hooks.history ? this.historyRow() : null;
      case ENGINE_KEY:
        return this.remoteRow();
      case REVIEW:
        return this.reviewRow();
      case ADVANCED:
        return this.advancedRow();
      default:
        return this.keyRow(item);
    }
  }

  /** One key's row, its control chosen by the key; null when this akou has no such key. */
  private keyRow(key: string): HTMLElement | null {
    const spec = this.schema[key];
    if (!spec) return null;
    const w = wordsFor(key);
    const value = this.settings[key];
    const id = `set-${key.replace(/[^a-z0-9]/gi, "-")}`;
    const inWindow = this.t.kind === "window";
    // The remote's address is the window's to write, never an HTTP client's (the owner's rule).
    const fileOnly = spec.apiWritable === false && !(key === REMOTE_URL_KEY && inWindow);
    this.shown[key] = spec.secret ? "" : shownValue(spec, value);
    let help: string | undefined = w.help;
    let controls: (Node | null)[];
    if (key === "dictation.apps") return this.appsRows(key, spec, value);
    if (key in KEY_SETTINGS) controls = this.keyControls(key, id, String(value ?? ""));
    else if (key === "dictation.languages") controls = [this.languagesControl(id, value)];
    else if (key === MIC_KEY) controls = this.micControls(id, String(value ?? ""));
    else if (key === FORMAT_KEY) controls = [this.formatControl(id, String(value ?? "off"))];
    else if (key === PROMPT_KEY) controls = [this.promptControl(id, String(value ?? "default"))];
    else if (key === FORMAT_WAIT_KEY) controls = [formatWait(id, w.label, spec, value)];
    else if (key === SERVER_ENGINE_KEY)
      controls = [serverEngineControl(id, String(value ?? "auto"), this.engines)];
    else if (key === "dictation.language")
      controls = [
        selectBox({
          id,
          label: w.label,
          options: [
            ["auto", "Automatic, from your languages"],
            ...QWEN_LANGUAGE_CODES.map((c) => [c, languageName(c)] as const),
          ],
          value: String(value ?? "auto"),
        }),
      ];
    else controls = this.control(id, key, spec, value);
    if (key === ENABLE_KEY) help = this.offReason() ?? help;
    if (key === REMOTE_URL_KEY && !inWindow)
      help = "Set in the akou app, since it decides where your voice goes.";
    const els = controls.filter((c): c is HTMLElement => c instanceof HTMLElement);
    const all = (sel: string) =>
      els.flatMap((el) => [
        ...(el.matches(sel) ? [el] : []),
        ...el.querySelectorAll<HTMLElement>(sel),
      ]);
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
    if (key === ENABLE_KEY && this.offReason())
      r.querySelector(".pg-help")?.setAttribute("id", "dictation-off-reason");
    // Why akou lists no microphones goes under the label, as help does.
    const note = r.querySelector<HTMLElement>(".pg-ctl #dictation-mic-note");
    if (note) {
      note.className = "pg-help";
      r.querySelector(".pg-lbl")?.append(note);
    }
    const issue = this.issues.get(key);
    if (issue) {
      r.classList.add("refused");
      const said =
        key === ENGINE_KEY && this.remoteAsked()
          ? "Another computer is on, but it has no address yet."
          : inWords(issue, this.keys());
      r.querySelector(".pg-lbl")?.append(h("small", { class: "issue" }, said));
    }
    if (REMOTE_KEYS.includes(key)) r.hidden = !this.remoteOn();
    if (key === PROMPT_KEY) r.hidden = this.settings[FORMAT_KEY] !== "provider";
    if (key === SOUNDS_KEY)
      r.querySelector(".pg-lbl")?.append(
        h("span", { id: "dictation-sounds-now", class: "pg-help" }),
      );
    if (key === READ_FIELD_KEY) {
      const waiting = this.readWaits();
      if (waiting) r.querySelector(".pg-lbl")?.append(waiting);
      if (waiting) helpGives(waiting);
    }
    if (key === "dictation.remote.timeoutSeconds" && this.mode === "app") {
      const parts = remoteParts(
        this.t,
        () => this.settings["dictation.remote.fallback"],
        (x) => inWords(x, this.keys()),
      );
      r.querySelector(".pg-ctl")?.append(parts.test);
      r.querySelector(".pg-lbl")?.append(parts.result, parts.standing);
    }
    return r;
  }

  private keys(): string[] {
    return Object.keys(this.schema);
  }

  /** The control for a key of any other type, from its words and the registry. */
  private control(id: string, key: string, spec: SchemaEntry, value: unknown): (Node | null)[] {
    const w = wordsFor(key);
    if (spec.type === "boolean") return [toggle({ id, checked: value === true, label: w.label })];
    const choices =
      w.choices?.filter(([v]) => !spec.values || spec.values.includes(v)) ??
      spec.values?.map((v) => [v, v] as const);
    if (spec.type === "string" && choices && !spec.secret) {
      const v = String(value ?? "");
      // Off or On is a switch; the setting keeps its words, carried by a hidden input.
      if (choices.length === 2 && choices.every(([c]) => c === "off" || c === "on")) {
        const sw = toggle({ id, checked: v === "on", label: w.label });
        const held = h("input", { type: "hidden", value: v });
        held.dataset.key = key;
        sw.addEventListener("change", (e) => {
          e.stopPropagation();
          held.value = sw.checked ? "on" : "off";
          held.dispatchEvent(new Event("change", { bubbles: true }));
        });
        return [sw, held];
      }
      const short = choices.reduce((n, [, l]) => n + l.length, 0) <= 40;
      if (choices.length <= 5 && short && choices.some(([c]) => c === v)) {
        const seg = segmented({ id, label: w.label, options: choices, value: v });
        seg.input.dataset.key = key;
        return [seg.root];
      }
      return [selectBox({ id, label: w.label, options: choices, value: v })];
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

  // -------------------------------------------------------------------------
  // The grants and the setup

  /** "Stays off": the microphone is refused, so the switch cannot turn dictation on (DC-N3). */
  private offReason(): string | null {
    const g = this.grants;
    // The setup's microphone step says it, and knows when the grant arrives.
    if (!g || grantOk(g.mic) || this.settings[ENABLE_KEY] === true || this.setup) return null;
    return "Stays off until akou may use the microphone.";
  }

  private micGrant(): HTMLElement | null {
    const g = this.grants?.mic;
    if (!g) return null;
    const linux = this.platform === "linux";
    const r = row(
      {
        label: "Microphone access",
        help:
          grantOk(g) || g === "not-asked"
            ? undefined
            : linux
              ? "akou cannot open the microphone. Check that a microphone is connected."
              : "Not allowed, so dictation stays off.",
        id: "dictation-grant-mic",
      },
      grantOk(g) || g === "not-asked" || linux ? grantState(g) : this.paneButton("microphone"),
    );
    return r;
  }

  private accessibilityGrant(): HTMLElement | null {
    const g = this.grants?.accessibility;
    if (!g || !this.mac) return null;
    const lost = this.lost.includes("accessibility");
    if (lost)
      return row(
        {
          label: "Accessibility access",
          help: h(
            "span",
            { id: "dictation-grant-lost" },
            "macOS took it back, so the dictation key does nothing. It works again once you allow it.",
          ),
          id: "dictation-grant-accessibility",
        },
        this.paneButton("accessibility", "dictation-grant-lost-open"),
      );
    const ok = grantOk(g);
    return row(
      {
        label: "Accessibility access",
        help: ok
          ? "Lets akou put the words in for you."
          : "Not allowed, so dictations are copied and you paste them.",
        id: "dictation-grant-accessibility",
      },
      ok ? grantState(g) : this.paneButton("accessibility"),
    );
  }

  /** A button that opens a privacy pane, or says to open it by hand where this page cannot. */
  private paneButton(pane: "microphone" | "accessibility", id?: string): HTMLButtonElement {
    return button(
      pane === "microphone" ? "Open Microphone settings" : "Open Accessibility settings",
      () =>
        void this.t.openSettingsPane(pane).then((ok) => {
          if (!ok) toast("Open the privacy settings yourself: this window cannot open them here.");
        }),
      id ?? `dictation-grant-open-${pane}`,
    );
  }

  /**
   * A grant dictation cannot run without, or has not been set up without: the microphone, and on
   * macOS Accessibility (whose refusal the setup turns into clipboard-only mode).
   */
  private missingGrant(): boolean {
    const g = this.grants;
    if (!g) return false;
    return !grantOk(g.mic) || (this.mac && !grantOk(g.accessibility));
  }

  private runSetup(): void {
    this.setup?.stop();
    const setup = new DictationSetup({
      t: this.t,
      platform: this.platform,
      grants: () => this.grants,
      setting: (k) => this.settings[k],
      readGrants: async () => {
        const d = await this.readDictation();
        if (d?.grants) this.dictation = { ...this.dictation, ...d };
        this.lost = lostOf(d);
        return d?.grants ?? null;
      },
      keyRow: () => {
        const input = h("input", { type: "text", hidden: true });
        const controls = this.keyControls(
          "dictation.hotkey",
          "setup-dictation-hotkey",
          String(this.settings["dictation.hotkey"] ?? ""),
          input,
        );
        const r = row({ label: wordsFor("dictation.hotkey").label }, ...controls);
        return { row: r, input };
      },
      stopKeys: () => this.stopRecording(),
      save: (k, v) => this.saveValue(k, v),
      finish: () => {
        if (this.setup === setup) this.setup = null;
        // Read again, not shown again: the setup saved its own keys, and the switch drawn above
        // it still holds what it held before, which a save of typed fields would send back.
        void this.reread();
      },
    });
    this.setup = setup;
    this.draw();
    setup.start();
  }

  // -------------------------------------------------------------------------
  // Keys

  /**
   * A dictation key as keycaps (its default where it has one, "Not set" where it has none), Change
   * or Set to record another with the recorder (DC-U3), and a way back to the default or to none.
   */
  private keyControls(
    key: string,
    id: string,
    value: string,
    given?: HTMLInputElement,
  ): (Node | null)[] {
    const input = given ?? h("input", { id, type: "text", hidden: true });
    input.value = value;
    input.dataset.key = key;
    const fallback =
      key === "dictation.hotkey"
        ? dictationHotkeyDefault(this.platform)
        : key === "dictation.hotkeyFixLast"
          ? fixLastDefault(
              String(this.settings["dictation.hotkey"] || dictationHotkeyDefault(this.platform)),
            )
          : undefined;
    const r = new KeyRecorder(key, input, this.t, {
      platform: this.platform,
      button: "Change",
      setButton: "Set",
      unset: "Not set",
      fallback,
      label: wordsFor(key).label.toLowerCase(),
      // Fn reaches any key's recorder; the dictation key's row alone offers it as a button.
      fnButton: key === "dictation.hotkey",
      chordsOnly: () => this.chordsOnly(),
      others: (k) => this.otherKeys(k),
      started: (me) => {
        for (const o of this.recorders) if (o !== me) o.stop();
      },
    });
    this.recorders.push(r);
    r.warnSaved();
    const reset = button(fallback ? "Use default" : "Remove", () => {
      input.value = "";
      input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    reset.classList.add("ghost", "key-reset");
    reset.dataset.for = key;
    // Nothing to go back to when the key is its default already.
    const follow = () => {
      reset.hidden = input.value === "" || input.value === fallback;
    };
    input.addEventListener("input", follow);
    input.addEventListener("change", follow);
    follow();
    return [r.root, reset, input];
  }

  /** What the keys do while a dictation listens (DC-S1), where akou can hold them. */
  private whileListening(): HTMLElement | null {
    if (this.mode !== "app") return null;
    const esc = this.mac ? "esc" : "Esc";
    const enter = this.mac ? "↵" : "Enter";
    const shift = this.mac ? "⇧" : "Shift";
    const held = this.dictation?.swallow_keys !== false;
    return row(
      {
        label: "While listening",
        help: held ? undefined : "This computer does not let akou hold these keys yet.",
        id: "dictation-while-listening",
      },
      h(
        "span",
        {
          class: "pg-while",
          attrs: {
            role: "note",
            "aria-label": "Escape cancels, Enter sends, Shift and Enter edit before inserting",
          },
        },
        keycaps([esc]),
        h("span", { class: "pg-value" }, "cancel"),
        keycaps([enter]),
        h("span", { class: "pg-value" }, "send"),
        keycaps([shift, enter]),
        h("span", { class: "pg-value" }, "edit before inserting"),
      ),
    );
  }

  /**
   * Why the recorder takes chords only: on macOS without the Accessibility grant, dictation runs
   * in the clipboard-only fallback with a Carbon hotkey, which binds chords only (DC-N3).
   */
  private chordsOnly(): string | null {
    if (!this.mac || this.grants?.accessibility !== "denied") return null;
    // A grant taken back after the start leaves the tap dead, not the Carbon fallback (DC-N1).
    if (this.lost.includes("accessibility")) return null;
    return "Without Accessibility access the key must be a combination, such as Control+Shift+Space.";
  }

  /**
   * The bindings a dictation key must not take: the record shortcut and the other dictation keys,
   * as their rows hold them, or as saved where the setup shows one key alone.
   */
  private otherKeys(key: string): [string, string][] {
    const appHotkey = this.settings["app.hotkey"];
    const out: [string, string][] = [
      [
        "the record shortcut",
        hotkeyFor(typeof appHotkey === "string" ? appHotkey : "", this.platform),
      ],
    ];
    for (const [k, words] of Object.entries(KEY_SETTINGS)) {
      if (k === key) continue;
      const el = this.col.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(k)}"]`);
      const v = el ? el.value : this.settings[k];
      if (typeof v === "string") out.push([words, v]);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Voice

  /** The languages as chips with a list to add one (akou-5v8); each change saves the whole list. */
  private languagesControl(id: string, value: unknown): HTMLElement {
    const list = Array.isArray(value) ? (value as string[]) : [];
    const hidden = h("textarea", { id, hidden: true });
    hidden.value = list.join("\n");
    hidden.dataset.key = "dictation.languages";
    const chips = new LanguageList(
      list,
      (l) => {
        hidden.value = l.join("\n");
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      },
      "dictation-languages",
      wordsFor("dictation.languages").empty,
    );
    return h("div", { class: "pg-chips" }, chips.root, hidden);
  }

  /**
   * The microphone picked from the inputs `GET /devices` lists, with its live level (DC-U4); where
   * akou gives no list, a field for the device's id and the reason under the label.
   */
  private micControls(id: string, value: string): (Node | null)[] {
    const mics = this.mics;
    // A refused microphone has no level to show; its grant row says why.
    const meter = this.grants && !grantOk(this.grants.mic) ? null : micMeter(this.t);
    this.meter = meter;
    meter?.root.classList.add("pg-lvl");
    if (mics && "inputs" in mics) {
      const probe = h("input", { id });
      const select = micPicker(probe, value, mics.inputs);
      select.classList.add("pg-select");
      select.setAttribute("aria-label", "Microphone");
      return [meter?.root ?? null, select];
    }
    const typed = field({ id, label: "Microphone", value, placeholder: "System default" });
    return [meter?.root ?? null, typed, mics && "error" in mics ? micNote(mics.error) : null];
  }

  // -------------------------------------------------------------------------
  // Engine

  /** True while dictation goes to another computer, or is about to once its address is saved. */
  private remoteOn(): boolean {
    // The file may ask for the remote while the registry refuses it (no address yet, so the
    // engine is the default): its rows show then, with the refusal on the engine's row.
    return this.settings[ENGINE_KEY] === "remote" || this.remotePending;
  }

  /** The file asks for another computer while the registry refuses it, for want of an address. */
  private remoteAsked(): boolean {
    return (
      this.settings[ENGINE_KEY] !== "remote" && /\bremote\b/.test(this.issues.get(ENGINE_KEY) ?? "")
    );
  }

  /**
   * "Words while you speak" (DC-E7): the streaming model they come from, or Parakeet decoding the
   * audio again twice a second while none is downloaded, with Get leading to the Models page.
   */
  private liveWordsRow(): HTMLElement | null {
    if (!(FINAL_KEY in this.schema)) return null;
    const live = this.dictation?.live ?? null;
    const get =
      !live && this.hooks.openModels
        ? button("Get", () => this.hooks.openModels?.(), "dictation-live-get")
        : null;
    return row(
      {
        label: "Words while you speak",
        help: live
          ? "Each word shows as it is heard, and stays."
          : "Get a streaming model to see each word the moment it is heard.",
        id: "dictation-live-words",
      },
      h(
        "span",
        { class: "pg-value", id: "dictation-live-model" },
        live ? modelName({ id: live, job: "" }) : "Parakeet, refreshed twice a second",
      ),
      get,
    );
  }

  /**
   * "Text that gets inserted" (DC-E7): the heading row, which saves `dictation.final`, and one
   * choice per value with a line on what you notice. The checked one is what runs now, as
   * `GET /dictation` says; a pick saves `dictation.engine` with it (`FINAL_ENGINE`), so the two keys
   * never disagree. While another computer turns the voice into text, the choices rest, dimmed.
   */
  private finalRows(): HTMLElement[] | null {
    const spec = this.schema[FINAL_KEY];
    if (!spec) return null;
    const engine = String(this.settings[ENGINE_KEY] ?? "auto");
    const resolved = this.dictation?.final;
    const now =
      resolved === "parakeet" || resolved === "qwen" || resolved === "live"
        ? resolved
        : engine === "fast"
          ? "parakeet"
          : engine === "best"
            ? "qwen"
            : String(this.settings[FINAL_KEY] ?? "live");
    // The control holds what runs now, so any other pick saves, even one the file already says.
    this.shown[FINAL_KEY] = now;
    const held = h("input", { type: "hidden", value: now });
    held.dataset.key = FINAL_KEY;
    const remote = this.remoteOn();
    const head = row(
      {
        label: wordsFor(FINAL_KEY).label,
        help: remote
          ? "The other computer turns your voice into text while it is on."
          : "Decided when you let go of the key.",
        key: FINAL_KEY,
        id: "dictation-final",
      },
      held,
    );
    const live = this.dictation?.live ?? null;
    const lines: Record<string, string> = {
      live: live
        ? "Goes in the moment you let go, exactly as shown. A few more mistakes than Parakeet."
        : "Needs a streaming model; Parakeet puts the text in until you get one.",
      parakeet: "A moment after you let go, reads the whole recording again, with your words.",
      qwen: "The fewest mistakes. Takes a little longer, and keeps a bigger model loaded.",
    };
    const choices = (wordsFor(FINAL_KEY).choices ?? []).filter(([v]) => spec.values?.includes(v));
    const rows = choices.map(([value, label]) => {
      const r = choiceRow({
        name: "dictation-final",
        value,
        label,
        help: lines[value],
        checked: value === now,
        isDefault: value === "live",
        disabled: remote,
      });
      r.dataset.final = value;
      r.querySelector<HTMLInputElement>("input.pg-radio")?.addEventListener("change", (e) => {
        e.stopPropagation();
        const radio = e.target as HTMLInputElement;
        if (!radio.checked) return;
        held.value = value;
        held.dispatchEvent(new Event("change", { bubbles: true }));
      });
      return r;
    });
    return [head, ...rows];
  }

  /**
   * "Use another computer running akou": the engine is `remote` while it is on. The row is
   * `dictation.engine`'s place on the page, its value held for the save; the choice of the text
   * inserted sets its local values.
   */
  private remoteRow(): HTMLElement | null {
    if (this.mode !== "app" || !(ENGINE_KEY in this.schema)) return null;
    if (!this.schema[ENGINE_KEY]?.values?.includes("remote")) return null;
    const sw = toggle({
      id: "dictation-remote-on",
      checked: this.remoteOn(),
      label: "Use another computer running akou",
    });
    sw.addEventListener("change", (e) => {
      e.stopPropagation();
      this.remoteSwitch(sw.checked);
    });
    const held = h("input", { type: "hidden", value: String(this.settings[ENGINE_KEY] ?? "auto") });
    held.dataset.key = ENGINE_KEY;
    this.shown[ENGINE_KEY] = held.value;
    const r = row(
      {
        label: "Use another computer running akou",
        help: "Your voice goes to it instead of being turned into text here.",
        for: "dictation-remote-on",
        id: "dictation-remote-row",
        key: ENGINE_KEY,
      },
      sw,
      held,
    );
    if (this.issues.has(ENGINE_KEY)) {
      r.classList.add("refused");
      r.querySelector(".pg-lbl")?.append(
        h(
          "small",
          { class: "issue" },
          this.remoteAsked()
            ? "Another computer is on, but it has no address yet."
            : inWords(this.issues.get(ENGINE_KEY) ?? "", this.keys()),
        ),
      );
    }
    return r;
  }

  private remoteSwitch(on: boolean): void {
    const url = String(this.settings[REMOTE_URL_KEY] ?? "").trim();
    for (const k of REMOTE_KEYS) {
      const r = this.rowOf(k);
      if (r) r.hidden = !on;
    }
    if (on && url === "") {
      // The registry refuses `remote` with no address: the address comes first and turns it on.
      this.remotePending = true;
      this.rowOf(REMOTE_URL_KEY)?.querySelector<HTMLElement>("input:not([disabled])")?.focus();
      return;
    }
    this.remotePending = false;
    // Off, the engine goes back to what it was here, and the file stops asking for the remote.
    this.issues.delete(ENGINE_KEY);
    void this.saveValue(ENGINE_KEY, on ? "remote" : this.localEngine).then((why) => {
      if (why) toast(`${wordsFor(ENGINE_KEY).label} was not saved: ${why}`);
      else if (this.root.isConnected) this.redraw();
    });
  }

  /** Tidy the text with AI: off, or with the assistant set on the Settings page, named. */
  private formatControl(id: string, value: string): HTMLSelectElement {
    const p = this.status.provider;
    const who =
      p?.id === "harness"
        ? p.harness === "codex"
          ? "Codex"
          : p.harness === "claude"
            ? "Claude Code"
            : "Claude Code or Codex"
        : p?.id === "anthropic"
          ? "the Anthropic API"
          : p?.id === "openai-compatible"
            ? "your OpenAI-compatible server"
            : "your assistant";
    return selectBox({
      id,
      label: wordsFor(FORMAT_KEY).label,
      options: [
        ["off", "Off"],
        ["provider", `With ${who}`],
      ],
      value,
    });
  }

  /** The instructions the tidy follows: Standard, or your own by name. */
  private promptControl(id: string, value: string): HTMLElement {
    const options: [string, string][] = [["default", "Standard"]];
    if (value !== "default") options.push([value, value]);
    const select = selectBox({ id, label: "Instructions", options, value });
    select.append(h("option", { value: "~" }, "Your own, by name…"));
    const typed = field({
      id: `${id}-name`,
      label: "The instructions' name",
      value: "",
      placeholder: "Their name",
    });
    typed.hidden = true;
    const hidden = h("input", { type: "hidden", value });
    hidden.dataset.key = PROMPT_KEY;
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

  // -------------------------------------------------------------------------
  // Rules per app, words, history, review

  /** The rules per app as rows of their panel, with the next dictation's app (DC-U9). */
  private appsRows(key: string, spec: SchemaEntry, value: unknown): HTMLElement {
    const e = appsEditor("set-dictation-apps", value, spec.apiWritable === false, (found, failed) =>
      this.nextApp(found, failed),
    );
    e.input.dataset.key = key;
    this.shown[key] = e.shown;
    const holder = h("div", { class: "pg-apps", attrs: { "data-key": key } }, e.root);
    const issue = this.issues.get(key);
    if (issue) {
      holder.classList.add("refused");
      holder.append(h("small", { class: "issue" }, inWords(issue, this.keys())));
    }
    return holder;
  }

  /**
   * Waits for the next dictation's app for the per-app rules (DC-U9). With dictation off no
   * dictation comes, so the page says so rather than wait for nothing.
   */
  private nextApp(
    found: (app: string, name?: string) => void,
    failed: (why: string) => void,
  ): { stop(): void } {
    this.stopNextApp();
    const on =
      this.col.querySelector<HTMLInputElement>(`input[data-key="${ENABLE_KEY}"]`)?.checked ??
      this.settings[ENABLE_KEY] === true;
    if (!on) {
      failed("Turn dictation on first: the app comes from your next dictation.");
      return { stop: () => {} };
    }
    const w = nextDictatedApp(this.t, found, failed);
    this.waitApp = w;
    return w;
  }

  private historyRow(): HTMLElement {
    const days = this.settings["dictation.retainDays"];
    const value =
      typeof days !== "number"
        ? undefined
        : days === 0
          ? "Only the last one kept"
          : `Kept ${days} day${days === 1 ? "" : "s"}`;
    return linkRow(
      {
        label: "History",
        help: "Your dictations, to copy or insert again.",
        value,
        id: "dictation-history-open",
      },
      () => void this.openSub("history"),
    );
  }

  /** The Words page (sd-a-words): its title and line, then the words' own list and forms. */
  private wordsPage(): HTMLElement[] {
    const words = this.hooks.words;
    return [
      pageHead("Words and replacements", {
        back: this.back(),
        sub: h(
          "div",
          { class: "pg-help" },
          "Spelled your way in every dictation. Words marked Calls too also fix your call transcripts.",
        ),
      }),
      ...(words ? [words.root] : []),
    ];
  }

  /**
   * The History page (sd-a-history): its search on the title's right, how long dictations and
   * their audio are kept, the dictations by day, and Delete all.
   */
  private historyPage(): HTMLElement[] {
    const history = this.hooks.history;
    const rows = HISTORY_KEYS.map((k) => this.keyRow(k)).filter(
      (x): x is HTMLElement => x !== null,
    );
    return [
      pageHead("History", {
        back: this.back(),
        sub: h("div", { class: "pg-help" }, `Your dictations stay on ${this.here}.`),
        right: history ? [history.find] : [],
      }),
      rows.length > 0 ? section("", ...rows) : null,
      history?.root ?? null,
      this.deleteAll(),
    ].filter((x): x is HTMLElement => x !== null);
  }

  /**
   * "Words to review": N words fixed while dictating still wait for an answer (DC-L5, and DC-O4's
   * count with the pill off). Left out where akou keeps no list.
   */
  private reviewRow(): HTMLElement | null {
    const r = this.review;
    if (!r || !this.hooks.words || ("pairs" in r && r.pairs === null)) return null;
    if ("error" in r)
      return row({ label: "Words to review", help: r.error, id: "dictation-review-row" });
    const n = waitingTerms(r.pairs ?? []);
    return row(
      {
        label: "Words to review",
        help: "Words you fixed while dictating, waiting for your answer.",
        id: "dictation-review-row",
      },
      h(
        "span",
        { class: "pg-value", id: "dictation-review-count" },
        n === 0 ? "None waiting" : `${n} waiting`,
      ),
      button("Open", () => void this.openSub("words"), "dictation-review-open"),
    );
  }

  /** Reads the count again, after the words to review answered some, and redraws its row alone. */
  async refreshReview(): Promise<void> {
    if (this.mode !== "app" || !this.hooks.words) return;
    const reads = this.reads;
    const review = await readDictationReview(this.t);
    // A load since then has read its own.
    if (reads !== this.reads) return;
    this.review = review;
    const r = this.reviewRow();
    const old = this.col.querySelector("#dictation-review-row");
    if (old && r) old.replaceWith(r);
    else if (old) old.remove();
    else if (r) this.col.querySelector("section[data-section='Learning'] .pg-grp")?.append(r);
  }

  private advancedRow(): HTMLElement | null {
    const n = ADVANCED_PAGE.groups.flatMap((g) => g.keys).filter((k) => k in this.schema).length;
    if (n === 0) return null;
    return linkRow(
      {
        label: "Advanced",
        help: ADVANCED_PAGE.help,
        value: `${n} setting${n === 1 ? "" : "s"}`,
        id: "dictation-advanced",
      },
      () => void this.openSub("advanced"),
    );
  }

  /** "Delete all dictations…", which asks once more, under the History page's list. */
  private deleteAll(): HTMLElement {
    const b = twoStep(
      {
        class: "pg-textlink",
        label: "Delete all dictations…",
        confirm: "Delete every dictation and its audio?",
        id: "dictations-delete",
        armed: this.armed,
      },
      () =>
        void this.t.request("DELETE", "/dictations").then((r) => {
          if (r.status >= 400) {
            toast(message(r.body, `the dictations were not deleted (HTTP ${r.status})`));
            return;
          }
          toast("Every dictation is deleted.", "info");
          if (this.sub === "history") void this.hooks.history?.load();
        }),
    );
    b.id = "dictations-delete";
    return h("p", { class: "pg-under" }, b);
  }

  // -------------------------------------------------------------------------
  // Notes that follow the settings

  /** What the sounds do now, since `auto` follows the pill (DC-O3). */
  private soundsNow(): void {
    const out = this.col.querySelector<HTMLElement>("#dictation-sounds-now");
    if (!out) return;
    const now = (k: string) =>
      this.col.querySelector<HTMLInputElement>(`input[data-key="${k}"]`)?.value ?? this.settings[k];
    const sounds = now(SOUNDS_KEY);
    const pill = now(PILL_KEY);
    const style = cueStyle(sounds, pill);
    // Only what the help does not already say: silent while the pill shows is Automatic's help.
    out.textContent =
      sounds === "off" && pill === "off"
        ? "Now a dictation neither shows nor sounds."
        : sounds === "auto" && style
          ? "Now soft sounds, since the pill is off."
          : "";
    out.hidden = out.textContent === "";
    helpGives(out);
  }

  /**
   * DC-L2: on macOS the helper reads no field without the Accessibility grant, so a read-back
   * that is on says it waits for it rather than looking as if it worked.
   */
  private readWaits(): HTMLElement | null {
    const g = this.grants?.accessibility;
    if (!this.mac || !g || g === "granted" || g === "not-needed") return null;
    // The controls as they stand, so a change updates the note before the save comes back.
    const readEl = this.col.querySelector<HTMLInputElement>(`input[data-key="${READ_FIELD_KEY}"]`);
    const read = readEl ? readEl.checked : this.settings[READ_FIELD_KEY] === true;
    if (!read) return null;
    // With learning off main asks for no field read at all, so there is nothing to wait for.
    const learn =
      this.col.querySelector<HTMLInputElement>(`input[data-key="${LEARN_KEY}"]`)?.value ??
      this.settings[LEARN_KEY];
    if (learn === "off") return null;
    return h(
      "span",
      { id: "dictation-read-waiting", class: "pg-help" },
      "Waits for Accessibility access.",
    );
  }

  private redrawReadWaits(): void {
    this.col.querySelector("#dictation-read-waiting")?.remove();
    const lbl = this.rowOf(READ_FIELD_KEY)?.querySelector(".pg-lbl");
    const waiting = this.readWaits();
    if (waiting) lbl?.append(waiting);
    const help = lbl?.querySelector<HTMLElement>(":scope > div.pg-help");
    if (help) help.hidden = waiting !== null;
  }

  private serverNotes(): HTMLElement {
    const served = this.served;
    return h(
      "div",
      { class: "dictation-server" },
      window.isSecureContext
        ? null
        : h("p", { id: "dictation-no-mic", class: "pg-sechelp" }, NO_MIC_NOTICE),
      h(
        "p",
        { id: "dictation-served", class: "pg-sechelp", attrs: { role: "status" } },
        typeof served === "number"
          ? `Dictation requests served in the last hour: ${served}`
          : "This server does not report dictation requests yet.",
      ),
      h(
        "p",
        { id: "dictation-jobs-key", class: "pg-sechelp" },
        "Other computers dictate with a jobs key from the Keys page.",
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Saving

  private rowOf(key: string): HTMLElement | null {
    return this.col.querySelector<HTMLElement>(`div[data-key="${CSS.escape(key)}"]`);
  }

  /** A control changed: what follows it on the page, then the save of its key alone. */
  private changed(el: HTMLElement): void {
    const key = el.dataset?.key;
    if (!key) return;
    const holder = this.rowOf(key);
    if (!holder) return;
    if (key === SOUNDS_KEY || key === PILL_KEY) this.soundsNow();
    if (key === READ_FIELD_KEY || key === LEARN_KEY) this.redrawReadWaits();
    if (key === FORMAT_KEY) {
      const prompt = this.rowOf(PROMPT_KEY);
      if (prompt) prompt.hidden = (el as HTMLSelectElement).value !== "provider";
    }
    // The switch turned on with a grant missing runs the setup instead (DC-U2, DC-N3).
    if (key === ENABLE_KEY && el instanceof HTMLInputElement && el.checked && this.missingGrant()) {
      el.checked = false;
      this.runSetup();
      return;
    }
    void this.save(holder);
  }

  /** Saves each row whose control holds what the file does not: the page is left. */
  private async saveTyped(): Promise<void> {
    this.stopRecording();
    const rows = [...this.col.querySelectorAll<HTMLElement>("div[data-key]")].filter(
      (r) => Object.keys(changedSettings(r, this.schema, this.shown)).length > 0,
    );
    await Promise.all(rows.map((r) => this.save(r)));
  }

  /**
   * Saves the one key of this row. The same change already on its way is not sent twice: a field
   * left by a click saves on its blur, and the page left by that click saves what is typed.
   */
  private save(r: HTMLElement): Promise<void> {
    const patch = changedSettings(r, this.schema, this.shown);
    if (Object.keys(patch).length === 0) return Promise.resolve();
    // A choice of the text inserted names its engine too, so neither key overrides the other.
    const final = patch[FINAL_KEY];
    if (typeof final === "string" && FINAL_ENGINE[final] && this.settings[ENGINE_KEY] !== "remote")
      patch[ENGINE_KEY] = FINAL_ENGINE[final];
    const id = JSON.stringify(patch);
    const going = this.saving.get(id);
    if (going) return going;
    const p = this.send(r, patch).finally(() => this.saving.delete(id));
    this.saving.set(id, p);
    return p;
  }

  private async send(r: HTMLElement, patch: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(patch);
    // A request that throws is refused like any save: the row and a toast say why, and a page
    // change that saved first still goes ahead.
    const res = await this.t.request("PATCH", "/config", patch).catch((err: Error) => ({
      status: 599,
      body: { message: `akou is out of reach (${err.message})` },
    }));
    if (res.status >= 400) {
      this.refused(r, keys, res.body);
      return;
    }
    for (const [k, v] of Object.entries(patch)) {
      this.saved(k, v);
      this.issues.delete(k);
      if (!this.schema[k]?.secret) continue;
      // akou has the secret now; the page keeps no copy of it.
      const input = r.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(k)}"]`);
      if (input) {
        input.value = "";
        input.placeholder = v ? "Set, type to replace" : (wordsFor(k).empty ?? "Not set");
      }
      this.shown[k] = "";
    }
    r.classList.remove("refused");
    r.querySelector(".issue")?.remove();
    // A dictation setting applies at once: the reply's note about restarting is not about it.
    toast("Saved.", "info");
    // The address is saved: "Use another computer", turned on before it, now turns it on.
    if (keys.includes(REMOTE_URL_KEY) && this.remotePending && String(patch[REMOTE_URL_KEY]).trim())
      this.remoteSwitch(true);
    if ((keys.includes(ENGINE_KEY) || keys.includes(FINAL_KEY)) && this.root.isConnected)
      this.redraw();
  }

  /** A refused change: the reason under the row's label, in words, and the same in a toast. */
  private refused(r: HTMLElement, keys: string[], body: unknown): void {
    const errors = (body as { errors?: string[] }).errors ?? [message(body, "refused")];
    const lines = errors.map((e) => {
      const key = keys.find((k) => e.startsWith(`${k}:`));
      return key ? e.slice(key.length + 1).trim() : e;
    });
    const why = inWords(lines[0] ?? "", this.keys());
    const text = why.charAt(0).toUpperCase() + why.slice(1);
    r.classList.add("refused");
    r.querySelector(".issue")?.remove();
    // The rules per app have no label of their own: the reason ends their panel, as on load.
    const at = r.classList.contains("pg-apps") ? r : (r.querySelector(".pg-lbl") ?? r);
    at.append(h("small", { class: "issue" }, text));
    toast(`${wordsFor(keys[0] ?? "").label} was not saved: ${why}`);
  }

  /** Saves one key the setup set, not a control: null, or the refusal's words. */
  private async saveValue(key: string, value: unknown): Promise<string | null> {
    const r = await this.t.request<{ errors?: string[] }>("PATCH", "/config", { [key]: value });
    if (r.status >= 400)
      return inWords((r.body?.errors ?? []).join("; ") || message(r.body, "refused"), this.keys());
    this.saved(key, value);
    // The switch drawn above the setup follows, so leaving the page saves nothing back.
    for (const el of this.col.querySelectorAll<HTMLInputElement>(
      `input[data-key="${CSS.escape(key)}"]`,
    )) {
      if (el.type === "checkbox") el.checked = value === true;
      else if (typeof value === "string") el.value = value;
    }
    return null;
  }

  private saved(key: string, value: unknown): void {
    this.settings[key] = value;
    if (key === ENGINE_KEY && typeof value === "string" && value !== "remote")
      this.localEngine = value;
    this.shown[key] = shownValue(this.schema[key], value);
  }

  /** Draws again where the page is, keeping the focus where it was. */
  private redraw(): void {
    const active = document.activeElement as HTMLElement | null;
    const id = active && this.col.contains(active) ? active.id : "";
    const key = (active?.closest?.("div[data-key]") as HTMLElement | null)?.dataset.key;
    const top = this.root.parentElement?.scrollTop ?? 0;
    this.draw();
    this.root.parentElement?.scrollTo?.({ top });
    const same = id ? document.getElementById(id) : null;
    if (same && this.col.contains(same)) same.focus();
    else if (key) this.focusRow(key, false);
  }

  private focusRow(key: string, flash = true): void {
    const r = this.rowOf(key);
    if (!r) return;
    if (flash) {
      r.scrollIntoView({ block: "center" });
      r.classList.add("pg-flash");
      // clock: how long a row's highlight shows.
      setTimeout(() => r.classList.remove("pg-flash"), 1200);
    }
    r.querySelector<HTMLElement>(
      ".pg-ctl input:not([type=hidden]):not([hidden]):not(:disabled), .pg-ctl select, .pg-ctl button",
    )?.focus();
  }

  /** Stops any key recording: the page redrew, or something else wants the keys. */
  stopRecording(): void {
    for (const r of this.recorders) r.stop();
  }

  private stopMeter(): void {
    this.meter?.close();
    this.meter = null;
  }

  private stopNextApp(): void {
    this.waitApp?.stop();
    this.waitApp = null;
  }
}

/** A grant as its row says it: "Allowed", "Not asked yet", "Not needed". */
function grantState(g: Grant): HTMLElement {
  const ok = g === "granted" || g === "not-needed";
  return h(
    "span",
    { class: `pg-state${ok ? " ok" : ""}` },
    g === "granted" ? icon("m3.5 8.5 3 3 6-7") : null,
    g === "granted"
      ? "Allowed"
      : g === "not-needed"
        ? "Not needed"
        : g === "not-asked"
          ? "Not asked yet"
          : "Not allowed",
  );
}

/**
 * The page under this one that `arg` goes to: `#words`, `#history`, or the page holding the
 * setting `arg` names; null for the page itself. A page the window has no list for is none.
 */
function subFor(arg: string | undefined, hooks: DictationHooks): Sub | null {
  if (!arg) return null;
  if (arg === WORDS) return hooks.words ? "words" : null;
  if (arg === HISTORY || HISTORY_KEYS.includes(arg)) return hooks.history ? "history" : null;
  return ADVANCED_PAGE.groups.some((g) => g.keys.includes(arg)) ? "advanced" : null;
}

function lostOf(d: DictationReply | null): string[] {
  return Array.isArray(d?.lost) ? d.lost.filter((x): x is string => typeof x === "string") : [];
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
