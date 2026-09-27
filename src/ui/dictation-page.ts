/**
 * The Dictation page (docs/ux/DICTATION.md section 6, DC-U1, DC-G6): one component drawn in both
 * modes. In the desktop window (and the app's browser page) it is the `#dictation` dialog beside
 * Settings, with every group of the section 6 mockup; in server mode it is the Dictation page
 * beside Jobs, Models, Keys and Settings, with the Server group and the count of dictation requests
 * served in the last hour only, since a server has no keyboard to type into.
 *
 * Fields come from the one settings registry (`GET /config`) through the flat pane's field code
 * (`settings.ts`), grouped by the lists below until the registry carries a `group` of its own. A
 * key this version does not have is left out, so a group grows as its settings land. Changing a
 * value saves that key alone through `PATCH /config`; a refusal shows beside it.
 *
 * `dictation.remote.url` decides where dictation audio goes, so it is written from the desktop
 * window or the config file only, never over HTTP: a browser page shows it and cannot change it,
 * and server mode does not show it at all.
 *
 * The page never records: a browser page served over plain http from another machine has no
 * microphone at all (no `getUserMedia` outside a secure context), and says so rather than failing.
 */

import type { Grant } from "../main/dictation/protocol.ts";
import { hotkeyFor } from "../main/window/hotkey.ts";
import { mountHistoryDialog } from "./dictation-history.ts";
import { KEY_SETTINGS, KeyRecorder } from "./dictation-recorder.ts";
import { DictationSetup, grantOk } from "./dictation-setup.ts";
import { h, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";
import { type ServerScreen, section, twoStep } from "./server-common.ts";
import {
  type ConfigReply,
  changedSettings,
  type SchemaEntry,
  settingField,
  shownValue,
  showRefusals,
} from "./settings.ts";

export interface DictationGroup {
  title: string;
  keys: readonly string[];
  hint?: string;
}

/** The grants the dictation helper reports (`GET /dictation`, DC-G1), as its `ready` names them. */
export interface DictationGrants {
  mic: Grant;
  accessibility: Grant;
}

/** The master switch, drawn above the groups. */
export const ENABLE_KEY = "dictation.enabled";

/** Where dictation audio goes: the desktop window or the config file only. */
export const REMOTE_URL_KEY = "dictation.remote.url";

/** The groups of the app-mode page, in the order of the section 6 mockup. */
export const DICTATION_GROUPS: readonly DictationGroup[] = [
  {
    title: "Keys",
    hint: "Hold the dictation key to talk and release it to insert; a short tap latches it. While listening, where akou can hold the keys: Esc cancels, Enter sends, Shift+Enter opens the draft.",
    keys: [
      "dictation.hotkey",
      "dictation.activation",
      "dictation.hotkeyDraft",
      "dictation.hotkeyFixLast",
      "dictation.hotkeyPasteLast",
      "dictation.silenceStopSeconds",
      "dictation.maxMinutes",
    ],
  },
  {
    title: "Microphone",
    keys: ["dictation.mic", "dictation.preferBuiltInOverBluetooth", "dictation.warmMic"],
  },
  {
    title: "Engine",
    hint: "fast picks the language itself; a fixed language applies to best and to a remote akou. A remote akou needs no local model.",
    keys: [
      "dictation.engine",
      "dictation.localTimeoutSeconds",
      REMOTE_URL_KEY,
      "dictation.remote.key",
      "dictation.remote.fallback",
      "dictation.remote.timeoutSeconds",
      "asr.qwenIdleMinutes",
      "dictation.language",
      "dictation.languages",
      "dictation.glossary",
      "dictation.glossaryMax",
    ],
  },
  {
    title: "Insert",
    keys: [
      "dictation.insert",
      "dictation.sendKey",
      "dictation.sendAlways",
      "dictation.restoreClipboard",
      "dictation.smartSpacing",
      "dictation.trailingSpace",
      "dictation.spokenPunctuation",
      "dictation.fillers",
      "dictation.spokenSend",
      "dictation.format",
      "dictation.formatPrompt",
      "dictation.formatTimeoutSeconds",
      "dictation.muteMedia",
    ],
  },
  {
    title: "Learning",
    hint: "Reading the field you dictated into serves both smart spacing and learning. Nothing is learned without your yes unless you choose automatic.",
    keys: ["dictation.learn", "dictation.readField", "dictation.learn.audioCheck"],
  },
  {
    title: "Per app",
    hint: "A rule applies when you dictate into that app; a field left on global follows the settings above. Name the app by its bundle id on macOS, its program name on Windows (chat.exe) or its window class on Linux.",
    keys: ["dictation.apps"],
  },
  {
    title: "Pill and sounds",
    hint: "The pill shows a level meter, never your words, unless you turn the preview on. Sounds on auto play while the pill is off.",
    keys: ["dictation.pill", "dictation.pillPreview", "dictation.sounds"],
  },
  {
    title: "Privacy",
    hint: "History and audio stay on this machine.",
    keys: ["dictation.retainDays", "dictation.keepAudio"],
  },
];

/** The one group of server mode: what the server does for dictating clients. */
export const SERVER_GROUP: DictationGroup = {
  title: "Server",
  hint: "Dictating clients send their audio with a jobs key, listed on the Keys page with its last use.",
  keys: ["server.dictation_slots", "server.dictation_engine"],
};

/** A key the Dictation page shows, so the flat Settings list leaves it out. */
export function onDictationPage(key: string): boolean {
  return key.startsWith("dictation.") || DICTATION_GROUPS.some((g) => g.keys.includes(key));
}

/** The words the server-mode page shows instead of a record button when it has no microphone. */
export const NO_MIC_NOTICE =
  "This page is served over plain http from another machine, so the browser gives it no microphone. Dictate from the akou app, with this server as its remote akou.";

export class DictationSettings {
  readonly root = h("div", { class: "dictation-settings" });
  private schema: Record<string, SchemaEntry> = {};
  private settings: Record<string, unknown> = {};
  private issues = new Map<string, string>();
  private shown: Record<string, string> = {};
  private reads = 0;
  private readonly armed = new Map<string, number>();
  /** The OS akou runs on, from its status: the recorder's keycaps and warnings follow it. */
  private platform = "";
  /** What `GET /dictation` says about the grants; null where it says nothing. */
  private grants: DictationGrants | null = null;
  private recorders: KeyRecorder[] = [];
  /** Dictation's setup (DC-N3), drawn instead of the groups while it runs. */
  private setup: DictationSetup | null = null;

  constructor(
    private readonly t: Transport,
    private readonly mode: "app" | "server",
  ) {}

  async load(): Promise<void> {
    const read = ++this.reads;
    const app = this.mode === "app";
    const [cfg, server, status, grants] = await Promise.all([
      this.t.request<ConfigReply>("GET", "/config"),
      app
        ? Promise.resolve(null)
        : this.t.request<{ dictation?: { served_last_hour?: number } }>("GET", "/server"),
      app ? this.t.request<{ app?: { platform?: string } }>("GET", "/status") : null,
      app ? this.readGrants() : null,
    ]);
    if (read !== this.reads) return;
    this.platform = String(status?.body?.app?.platform ?? "");
    this.grants = grants;
    if (cfg.status !== 200) {
      this.close();
      replace(
        this.root,
        h("p", { class: "hint" }, message(cfg.body, "the settings could not be read")),
      );
      return;
    }
    this.schema = cfg.body.schema;
    this.settings = { ...cfg.body.settings };
    this.issues = new Map(cfg.body.issues.map((i) => [i.key, i.message]));
    this.draw(server?.body?.dictation?.served_last_hour);
  }

  /** The grants the helper reports, as they are now; null where the app says nothing. */
  private async readGrants(): Promise<DictationGrants | null> {
    const r = await this.t.request<{ grants?: DictationGrants }>("GET", "/dictation");
    return r.status < 400 ? (r.body?.grants ?? null) : null;
  }

  private draw(served?: number): void {
    this.stopRecording();
    this.recorders = [];
    this.shown = {};
    const top =
      this.mode === "app" && ENABLE_KEY in this.schema
        ? h(
            "div",
            { class: "dictation-enable" },
            this.field(ENABLE_KEY),
            // The setup's microphone step says it, and knows when the grant arrives.
            this.setup ? null : this.offReason(),
          )
        : null;
    if (this.setup) {
      replace(this.root, top, this.setup.root);
      return;
    }
    const groups = this.mode === "server" ? [SERVER_GROUP] : DICTATION_GROUPS;
    const drawn = groups
      .map((g) => ({ g, keys: g.keys.filter((k) => k in this.schema) }))
      .filter((x) => x.keys.length > 0)
      .map(({ g, keys }) =>
        h(
          "fieldset",
          { attrs: { "data-group": g.title } },
          h("legend", {}, g.title),
          g.hint ? h("p", { class: "hint" }, g.hint) : null,
          ...keys.map((k) => this.field(k)),
          g.title === "Privacy" ? this.deleteAll() : null,
        ),
      );
    replace(
      this.root,
      this.mode === "server" ? this.serverNotes(served) : null,
      top,
      ...drawn,
      drawn.length === 0 && !top
        ? h(
            "p",
            { class: "hint", attrs: { "data-empty": "" } },
            "This akou has no dictation settings yet.",
          )
        : null,
      top ? this.permissions() : null,
    );
  }

  /** One key's row, saving that key alone on change; the dictation keys get their recorder. */
  private field(key: string): HTMLElement {
    const f = settingField(
      key,
      this.schema[key] as SchemaEntry,
      this.settings[key],
      this.issues.get(key),
    );
    this.shown[key] = f.shown;
    if (key === REMOTE_URL_KEY) this.remoteUrl(f.input, f.row);
    if (key in KEY_SETTINGS && f.input instanceof HTMLInputElement) {
      const r = new KeyRecorder(key, f.input, this.t, {
        platform: this.platform,
        chordsOnly: () => this.chordsOnly(),
        others: (k) => this.otherKeys(k),
        started: (me) => {
          for (const o of this.recorders) if (o !== me) o.stop();
        },
      });
      this.recorders.push(r);
      f.input.after(r.root);
    }
    const input = f.input;
    input.addEventListener("change", () => {
      // The switch turned on with a grant missing runs the setup instead (DC-U2, DC-N3).
      if (key === ENABLE_KEY && input instanceof HTMLInputElement && input.checked) {
        if (this.missingGrant()) {
          input.checked = false;
          this.runSetup();
          return;
        }
      }
      void this.save(f.row);
    });
    return f.row;
  }

  /**
   * A grant dictation cannot run without, or has not been set up without: the microphone, and on
   * macOS Accessibility (whose refusal the setup turns into clipboard-only mode).
   */
  private missingGrant(): boolean {
    const g = this.grants;
    if (!g) return false;
    return !grantOk(g.mic) || (this.platform === "darwin" && !grantOk(g.accessibility));
  }

  /** Why the switch stays off: the microphone is refused (DC-N3). */
  private offReason(): HTMLElement | null {
    if (!this.grants || grantOk(this.grants.mic) || this.settings[ENABLE_KEY] === true) return null;
    return h(
      "small",
      { id: "dictation-off-reason", class: "issue" },
      "Dictation stays off: akou has no access to the microphone.",
    );
  }

  /** The grants as the helper reports them, and the way back into the setup. */
  private permissions(): HTMLElement | null {
    const g = this.grants;
    if (!g) return null;
    const word = (x: string) =>
      x === "granted" ? "ok" : x === "not-needed" ? "not needed" : "not granted";
    return h(
      "p",
      { id: "dictation-permissions", class: "hint" },
      `Permissions: Microphone ${word(g.mic)}`,
      this.platform === "darwin"
        ? `, Accessibility ${word(g.accessibility)}${grantOk(g.accessibility) ? "" : " (clipboard only)"}`
        : "",
      ". ",
      h(
        "button",
        { type: "button", id: "dictation-setup-open", on: { click: () => this.runSetup() } },
        "Run the setup again",
      ),
    );
  }

  private runSetup(): void {
    this.setup?.stop();
    const setup = new DictationSetup({
      t: this.t,
      platform: this.platform,
      grants: () => this.grants,
      setting: (k) => this.settings[k],
      readGrants: async () => {
        const g = await this.readGrants();
        if (g) this.grants = g;
        return g;
      },
      keyRow: () => {
        const row = this.field("dictation.hotkey");
        return { row, input: row.querySelector("input") as HTMLInputElement };
      },
      stopKeys: () => this.stopRecording(),
      save: (k, v) => this.saveValue(k, v),
      finish: () => {
        if (this.setup === setup) this.setup = null;
        void this.load();
      },
    });
    this.setup = setup;
    this.draw();
    setup.start();
  }

  /** Stops any key recording: the dialog closed or the page redrew. */
  stopRecording(): void {
    for (const r of this.recorders) r.stop();
  }

  /** The page closed: no recorder holds the keys, and a setup left half way is dropped. */
  close(): void {
    this.stopRecording();
    this.setup?.stop();
    this.setup = null;
  }

  /**
   * Why the recorder takes chords only: on macOS without the Accessibility grant, dictation runs
   * in the clipboard-only fallback with a Carbon hotkey, which binds chords only (DC-N3).
   */
  private chordsOnly(): string | null {
    if (this.platform !== "darwin" || this.grants?.accessibility !== "denied") return null;
    return "without the Accessibility grant akou binds its key as a Carbon hotkey, which takes chords only, such as Control+Shift+Space.";
  }

  /**
   * The bindings a dictation key must not take: the recording hotkey and the other dictation
   * keys, as their fields hold them, or as saved where the setup shows one key alone.
   */
  private otherKeys(key: string): [string, string][] {
    const appHotkey = this.settings["app.hotkey"];
    const out: [string, string][] = [
      [
        "the recording hotkey (app.hotkey)",
        hotkeyFor(typeof appHotkey === "string" ? appHotkey : "", this.platform),
      ],
    ];
    for (const [k, words] of Object.entries(KEY_SETTINGS)) {
      if (k === key) continue;
      const el = this.root.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(k)}"]`);
      const v = el ? el.value : this.settings[k];
      if (typeof v === "string") out.push([`${words} (${k})`, v]);
    }
    return out;
  }

  /** In a browser the remote's address is shown, never changed (the owner's rule). */
  private remoteUrl(
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    row: HTMLElement,
  ): void {
    const window = this.t.kind === "window";
    input.disabled = !window;
    input.title = window ? "" : "set from the akou window or the config file";
    if (!window) row.append(h("small", {}, " (set from the akou window or the config file)"));
  }

  private serverNotes(served: number | undefined): HTMLElement {
    return h(
      "div",
      { class: "dictation-server" },
      window.isSecureContext
        ? null
        : h("p", { id: "dictation-no-mic", class: "notice", role: "note" }, NO_MIC_NOTICE),
      h(
        "p",
        { id: "dictation-served", attrs: { role: "status" } },
        typeof served === "number"
          ? `Dictation requests served in the last hour: ${served}`
          : "This server does not report dictation requests yet.",
      ),
    );
  }

  private deleteAll(): HTMLElement {
    return h(
      "div",
      { class: "bar" },
      twoStep(
        {
          class: "stop",
          label: "Delete all dictations now",
          confirm: "Delete every dictation and its audio?",
          id: "dictations-delete",
          armed: this.armed,
        },
        () =>
          void this.t.request("DELETE", "/dictations").then((r) => {
            if (r.status >= 400)
              toast(message(r.body, `the dictations were not deleted (HTTP ${r.status})`));
            else toast("Every dictation is deleted.", "info");
          }),
      ),
    );
  }

  /** Saves the one key of this row. */
  private async save(row: HTMLElement): Promise<void> {
    const patch = changedSettings(row, this.schema, this.shown);
    if (Object.keys(patch).length === 0) return;
    const r = await this.t.request<{ note?: string }>("PATCH", "/config", patch);
    if (r.status >= 400) {
      showRefusals(this.root, r.body);
      return;
    }
    for (const [k, v] of Object.entries(patch)) {
      this.saved(k, v);
      if (!this.schema[k]?.secret) continue;
      // akou has the secret now; the page keeps no copy of it, as Settings does by reloading.
      const input = row.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(k)}"]`);
      if (input) {
        input.value = "";
        input.placeholder = v ? "set (hidden); type to replace" : "not set";
      }
      this.shown[k] = "";
    }
    row.classList.remove("refused");
    row.querySelector(".issue")?.remove();
    toast("Saved.", "info");
  }

  /** Saves one key the setup set, not a field: null, or the refusal's words. */
  private async saveValue(key: string, value: unknown): Promise<string | null> {
    const r = await this.t.request<{ errors?: string[] }>("PATCH", "/config", { [key]: value });
    if (r.status >= 400) return (r.body?.errors ?? []).join("; ") || message(r.body, "refused");
    this.saved(key, value);
    return null;
  }

  private saved(key: string, value: unknown): void {
    this.settings[key] = value;
    this.shown[key] = shownValue(this.schema[key], value);
  }
}

/**
 * The window's `#dictation` dialog, opened by its button, by `#dictation` in the address, or by
 * Settings; its History button opens the history (DC-H1) over it.
 */
export function mountDictationDialog(t: Transport): { open(): Promise<void> } {
  const dialog = document.getElementById("dictation") as HTMLDialogElement;
  const body = document.getElementById("dictation-fields") as HTMLElement;
  const page = new DictationSettings(t, "app");
  body.append(page.root);
  const open = async () => {
    await page.load();
    if (!dialog.open) dialog.showModal();
  };
  // A recorder left open would keep every key press of the window, and a setup its grant reads.
  dialog.addEventListener("close", () => page.close());
  document.getElementById("dictation-open")?.addEventListener("click", () => void open());
  document.getElementById("dictation-close")?.addEventListener("click", () => dialog.close());
  const history = mountHistoryDialog(t);
  document.getElementById("dictation-history-open")?.addEventListener("click", () => {
    // A live recorder would take every key typed into the history's search.
    page.stopRecording();
    void history.open();
  });
  const fromHash = () => {
    if (location.hash === "#dictation") void open();
  };
  window.addEventListener("hashchange", fromHash);
  fromHash();
  return { open };
}

/** Server mode's Dictation page. */
export class DictationPage implements ServerScreen {
  readonly name = "dictation" as const;
  readonly title = "Dictation";
  readonly root: HTMLElement;
  private readonly page: DictationSettings;

  constructor(t: Transport) {
    this.page = new DictationSettings(t, "server");
    this.root = section("Dictation", this.page.root);
  }

  show(): void {
    void this.page.load();
  }

  hide(): void {}
}
