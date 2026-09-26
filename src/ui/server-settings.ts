/**
 * The Settings and Models pages of server mode (docs/ux/SERVER.md SV-U2, SV-U6).
 *
 * Settings shows the server's own groups, drawn from the one settings registry (`GET /config`) with
 * the window's field code (`settings.ts`), and nothing of the recorder: no device, hotkey or tray.
 * A key the registry does not have in this version is left out, so a group grows as its settings
 * land. Network settings are shown and never editable here: they are the config file's.
 *
 * Models shows the speech models' state from `GET /models` and offers the download; its size and
 * eviction settings are listed with their values once they exist.
 */

import { h, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { ModelsInfo, Transport } from "./protocol.ts";
import { type ServerScreen, section } from "./server-common.ts";
import { modelsStateText } from "./server-text.ts";
import {
  type ConfigReply,
  changedSettings,
  type SchemaEntry,
  settingField,
  showRefusals,
} from "./settings.ts";

/** The server's settings, in the groups of SV-U2. */
export const SERVER_GROUPS: readonly { title: string; keys: readonly string[]; hint?: string }[] = [
  {
    title: "Engines and presets",
    hint: "What a job runs when its request has no opinion. Telegram-Archive sends preset auto and language auto, and never asks for speaker labels, so these decide for it.",
    keys: ["server.default_model", "server.default_language", "server.default_diarize"],
  },
  {
    title: "Models",
    keys: ["server.auto_download", "server.models_max_gb", "server.models_unused_days"],
  },
  {
    title: "Jobs and retention",
    keys: ["server.retain_days", "server.max_audio_minutes", "server.max_upload_mb"],
  },
  {
    title: "Webhooks",
    hint: "A job's callback URL may name only the hosts its key lists: set them per key, on the Keys page.",
    keys: [],
  },
  {
    title: "Network",
    hint: "Set in the config file; akou reads them when it starts.",
    keys: [
      "api.bind",
      "api.port",
      "server.behind_proxy",
      "server.public_host",
      "server.trusted_proxies",
    ],
  },
];

async function readConfig(t: Transport): Promise<ConfigReply | null> {
  const r = await t.request<ConfigReply>("GET", "/config");
  if (r.status === 200) return r.body;
  toast(message(r.body, `the settings could not be read (HTTP ${r.status})`));
  return null;
}

export class SettingsPage implements ServerScreen {
  readonly name = "settings" as const;
  readonly title = "Settings";
  readonly root: HTMLElement;
  private readonly fields = h("div", { id: "server-settings" });
  private schema: Record<string, SchemaEntry> = {};
  private shown: Record<string, string> = {};

  constructor(private readonly t: Transport) {
    const form = h(
      "form",
      { attrs: { novalidate: "" } },
      this.fields,
      h(
        "div",
        { class: "bar" },
        h("button", { id: "settings-save", class: "go", type: "submit" }, "Save"),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.save();
    });
    this.root = section("Settings", form);
  }

  show(): void {
    void this.load();
  }

  hide(): void {}

  private async load(): Promise<void> {
    const [cfg, server] = await Promise.all([
      readConfig(this.t),
      this.t.request<{ presets?: { name: string }[]; engines?: { id: string }[] }>(
        "GET",
        "/server",
      ),
    ]);
    if (!cfg) return;
    this.schema = cfg.schema;
    this.shown = {};
    const issues = new Map(cfg.issues.map((i) => [i.key, i.message]));
    // The model setting takes a preset name or an engine id: offer both.
    const choices = [
      "auto",
      ...(server.body.presets ?? []).map((p) => p.name),
      ...(server.body.engines ?? []).map((e) => e.id),
    ];
    const models = h(
      "datalist",
      { id: "server-model-choices" },
      ...[...new Set(choices)].map((c) => h("option", { value: c })),
    );
    replace(
      this.fields,
      h("p", { class: "hint" }, `Saved in ${cfg.file}`),
      models,
      ...SERVER_GROUPS.map((g) => {
        const present = g.keys.filter((k) => k in this.schema);
        return h(
          "fieldset",
          { attrs: { "data-group": g.title } },
          h("legend", {}, g.title),
          g.hint ? h("p", { class: "hint" }, g.hint) : null,
          ...present.map((k) => {
            const f = settingField(
              k,
              this.schema[k] as SchemaEntry,
              cfg.settings[k],
              issues.get(k),
            );
            this.shown[k] = f.shown;
            if (k === "server.default_model") f.input.setAttribute("list", "server-model-choices");
            return f.row;
          }),
        );
      }),
    );
  }

  private async save(): Promise<void> {
    const patch = changedSettings(this.fields, this.schema, this.shown);
    if (Object.keys(patch).length === 0) {
      toast("Nothing changed.", "info");
      return;
    }
    const r = await this.t.request<{ note?: string }>("PATCH", "/config", patch);
    if (r.status >= 400) {
      showRefusals(this.fields, r.body);
      return;
    }
    toast(r.body.note ?? "Saved.", "info");
    await this.load();
  }
}

export class ModelsPage implements ServerScreen {
  readonly name = "models" as const;
  readonly title = "Models";
  readonly root: HTMLElement;
  private readonly state = h("p", { id: "models-state", attrs: { role: "status" } });
  private readonly progress = h("progress", { hidden: true, attrs: { max: "1", value: "0" } });
  private readonly pull = h(
    "button",
    { id: "models-download", class: "go", type: "button", hidden: true },
    "Download",
  );
  private readonly limits = h("ul", { id: "models-limits" });
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly t: Transport) {
    this.pull.addEventListener("click", () => void this.download());
    this.root = section(
      "Models",
      this.state,
      h("div", { class: "bar" }, this.progress, this.pull),
      this.limits,
    );
  }

  show(): void {
    void this.read();
    void this.readLimits();
  }

  hide(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private draw(m: ModelsInfo): void {
    this.state.textContent = modelsStateText(m);
    this.pull.hidden = m.state === "ready" || m.state === "downloading";
    this.pull.textContent = m.state === "failed" ? "Try again" : "Download";
    this.progress.hidden = m.state !== "downloading";
    this.progress.value = m.total > 0 ? m.bytes / m.total : 0;
    if (m.state === "downloading") this.timer ??= setInterval(() => void this.read(), 1000);
    else this.stop();
  }

  private async read(): Promise<void> {
    const r = await this.t.request<ModelsInfo>("GET", "/models");
    if (r.status === 200) this.draw(r.body);
  }

  private async download(): Promise<void> {
    const r = await this.t.request<ModelsInfo>("POST", "/models/pull");
    if (r.status >= 400) {
      toast(message(r.body, `the download could not start (HTTP ${r.status})`));
      return;
    }
    this.draw(r.body);
  }

  /** The models' size and eviction settings with their values, those this version has. */
  private async readLimits(): Promise<void> {
    const cfg = await readConfig(this.t);
    if (!cfg) return;
    const keys = (SERVER_GROUPS.find((g) => g.title === "Models")?.keys ?? []).filter(
      (k) => k in cfg.schema,
    );
    replace(
      this.limits,
      ...keys.map((k) => h("li", {}, `${k}: ${JSON.stringify(cfg.settings[k])}`)),
    );
  }
}
