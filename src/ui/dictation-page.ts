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

import { h, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";
import { type ServerScreen, section, twoStep } from "./server-common.ts";
import {
  type ConfigReply,
  changedSettings,
  type SchemaEntry,
  settingField,
  showRefusals,
} from "./settings.ts";

export interface DictationGroup {
  title: string;
  keys: readonly string[];
  hint?: string;
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
  private shown: Record<string, string> = {};
  private reads = 0;
  private readonly armed = new Map<string, number>();

  constructor(
    private readonly t: Transport,
    private readonly mode: "app" | "server",
  ) {}

  async load(): Promise<void> {
    const read = ++this.reads;
    const [cfg, server] = await Promise.all([
      this.t.request<ConfigReply>("GET", "/config"),
      this.mode === "server"
        ? this.t.request<{ dictation?: { served_last_hour?: number } }>("GET", "/server")
        : Promise.resolve(null),
    ]);
    if (read !== this.reads) return;
    if (cfg.status !== 200) {
      replace(
        this.root,
        h("p", { class: "hint" }, message(cfg.body, "the settings could not be read")),
      );
      return;
    }
    this.schema = cfg.body.schema;
    this.shown = {};
    const issues = new Map(cfg.body.issues.map((i) => [i.key, i.message]));
    const field = (key: string) => {
      const f = settingField(
        key,
        this.schema[key] as SchemaEntry,
        cfg.body.settings[key],
        issues.get(key),
      );
      this.shown[key] = f.shown;
      if (key === REMOTE_URL_KEY) this.remoteUrl(f.input, f.row);
      const save = () => void this.save(f.row);
      f.input.addEventListener("change", save);
      return f.row;
    };
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
          ...keys.map(field),
          g.title === "Privacy" ? this.deleteAll() : null,
        ),
      );
    const top =
      this.mode === "app" && ENABLE_KEY in this.schema
        ? h("div", { class: "dictation-enable" }, field(ENABLE_KEY))
        : null;
    replace(
      this.root,
      this.mode === "server" ? this.serverNotes(server?.body?.dictation?.served_last_hour) : null,
      top,
      ...drawn,
      drawn.length === 0 && !top
        ? h(
            "p",
            { class: "hint", attrs: { "data-empty": "" } },
            "This akou has no dictation settings yet.",
          )
        : null,
    );
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
      this.shown[k] = Array.isArray(v) ? v.join("\n") : String(v ?? "");
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
}

/** The window's `#dictation` dialog, opened by its button, by `#dictation` in the address, or by Settings. */
export function mountDictationDialog(t: Transport): { open(): Promise<void> } {
  const dialog = document.getElementById("dictation") as HTMLDialogElement;
  const body = document.getElementById("dictation-fields") as HTMLElement;
  const page = new DictationSettings(t, "app");
  body.append(page.root);
  const open = async () => {
    await page.load();
    if (!dialog.open) dialog.showModal();
  };
  document.getElementById("dictation-open")?.addEventListener("click", () => void open());
  document.getElementById("dictation-close")?.addEventListener("click", () => dialog.close());
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
