/**
 * The Models page (docs/ux/SERVER.md SV-U6, DESKTOP.md DK-E2): in the app, first the Live section
 * (`asr.live`, akou-chp.23): each live setup with its accuracy, latency, cores and memory bars, the
 * one the next call runs and the one the live call runs marked, its missing models one Download
 * away, and Use to choose it. Then every catalog model in three
 * sections (speech recognition, speaker labels, and the helpers folded), each with what it is for,
 * its size, state, last use and the date the sweep deletes it, two bars for accuracy and speed with
 * the numbers behind them, and Download, Delete and Set as default. Below, the settings that decide
 * what a missing model does and when an unused one goes.
 *
 * The same page in server mode's web page (`server-page.ts`) and in the desktop window's Models
 * dialog (`app.ts`), over the same routes a script calls: `GET /models`, `POST /models/pull`,
 * `DELETE /models/{id}`, `GET` and `PATCH /config`.
 */

import type { ScoreView } from "../main/server/model-store.ts";
import { h, replace, toast } from "./dom.ts";
import {
  bar,
  deleteRefusal,
  keptText,
  LIVE_BARS,
  type LiveSetupView,
  type LiveView,
  liveHint,
  liveMissing,
  liveModelsText,
  type ModelRow,
  measuredText,
  percent,
  purposeText,
  SECTIONS,
  SORTS,
  type SortBy,
  sizeText,
  sortRows,
} from "./models-rows.ts";
import { message } from "./notepad.ts";
import type { ModelsInfo, Transport } from "./protocol.ts";
import { section, twoStep } from "./server-common.ts";
import { modelsStateText } from "./server-text.ts";
import type { ConfigReply } from "./settings.ts";

type ModelsReply = ModelsInfo & { models?: ModelRow[]; live?: LiveView };

const SORT_KEY = "akou.models.sort";

export class ModelsPage {
  readonly name = "models" as const;
  readonly title = "Models";
  readonly root: HTMLElement;
  private readonly state = h("p", { id: "models-state", attrs: { role: "status" } });
  private readonly progress = h("progress", { hidden: true, attrs: { max: "1", value: "0" } });
  private readonly pullAll = h(
    "button",
    { id: "models-download", class: "go", type: "button", hidden: true },
    "Download",
  );
  private readonly sort = h(
    "select",
    { id: "models-sort", attrs: { "aria-label": "Sort models by" } },
    ...SORTS.map((s) => h("option", { value: s.by }, s.label)),
  );
  private readonly lists = h("div", { id: "models-lists" });
  private readonly liveSection = h("section", {
    id: "models-live",
    class: "models-group",
    hidden: true,
    attrs: { "data-kind": "live" },
  });
  private live: LiveView | null = null;
  private readonly settings = h("form", {
    id: "models-settings",
    attrs: { novalidate: "", "aria-label": "Model settings" },
  });
  private readonly armed = new Map<string, number>();
  private rows: ModelRow[] = [];
  private unusedDays: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private shown = false;
  /** Bumped by every read, so an older answer that lands late never draws over a newer one. */
  private reads = 0;

  constructor(
    private readonly t: Transport,
    /** Server mode: jobs from clients exist, so what a missing model does is a choice here. */
    private readonly server: boolean,
  ) {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SORT_KEY);
    } catch {}
    this.sort.value = SORTS.some((s) => s.by === saved) ? (saved as SortBy) : "accuracy";
    this.sort.addEventListener("change", () => {
      try {
        localStorage.setItem(SORT_KEY, this.sort.value);
      } catch {}
      this.drawRows();
    });
    this.pullAll.addEventListener("click", () => void this.download());
    this.settings.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveSettings();
    });
    this.root = section(
      "Models",
      h(
        "p",
        { class: "hint" },
        "Every file comes from the model's own publisher, pinned to one revision and checked against its SHA-256 before it is used. Where each model comes from is on its row.",
      ),
      h("div", { class: "bar models-top" }, this.state, this.progress, this.pullAll),
      this.liveSection,
      h(
        "div",
        { class: "bar models-sort" },
        h("label", { attrs: { for: "models-sort" } }, "Sort by"),
        this.sort,
      ),
      this.lists,
      this.settings,
    );
    this.root.classList.add("models-page");
  }

  show(): void {
    this.shown = true;
    void this.read();
    void this.readSettings();
  }

  hide(): void {
    this.shown = false;
    this.stop();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async read(): Promise<void> {
    const n = ++this.reads;
    let r: { status: number; body: ModelsReply };
    try {
      r = await this.t.request<ModelsReply>("GET", "/models");
    } catch {
      return;
    }
    if (n !== this.reads || r.status !== 200) return;
    this.draw(r.body);
  }

  private draw(m: ModelsReply): void {
    this.state.textContent = modelsStateText(m);
    this.pullAll.hidden = m.state === "ready" || m.state === "downloading";
    this.pullAll.textContent = m.state === "failed" ? "Try again" : "Download";
    this.progress.hidden = m.state !== "downloading";
    this.progress.value = m.total > 0 ? m.bytes / m.total : 0;
    this.rows = m.models ?? [];
    this.drawRows();
    this.live = m.live ?? null;
    this.drawLive();
    const busy =
      m.state === "downloading" ||
      this.rows.some((r) => r.state === "downloading") ||
      (this.live?.setups.some((s) => s.models.some((x) => x.state === "downloading")) ?? false);
    if (busy && this.shown) this.timer ??= setInterval(() => void this.read(), 1000);
    else this.stop();
  }

  private drawRows(): void {
    const by = this.sort.value as SortBy;
    replace(
      this.lists,
      ...SECTIONS.map((s) => {
        const rows = sortRows(
          this.rows.filter((r) => r.kind === s.kind),
          by,
        );
        if (rows.length === 0) return null;
        const body = [
          h("p", { class: "hint" }, s.hint),
          h("ul", { class: "model-list" }, ...rows.map((r) => this.row(r))),
        ];
        if (s.kind === "helper") {
          const d = h(
            "details",
            { class: "models-group", attrs: { "data-kind": s.kind } },
            h("summary", {}, `${s.title} (${rows.length})`),
            ...body,
          );
          return d;
        }
        return h(
          "section",
          { class: "models-group", attrs: { "data-kind": s.kind } },
          h("h3", {}, s.title),
          ...body,
        );
      }),
    );
  }

  private row(r: ModelRow): HTMLElement {
    const badges = [
      r.default ? h("span", { class: "badge ok" }, "default") : null,
      r.in_use ? h("span", { class: "badge" }, "in use") : null,
      r.kind === "speech" && r.streaming ? h("span", { class: "badge" }, "live") : null,
    ];
    const measured = measuredText(r);
    return h(
      "li",
      { class: "model", attrs: { "data-id": r.id, "data-state": r.state } },
      h(
        "div",
        { class: "model-head" },
        h("strong", { class: "model-name" }, r.id),
        ...badges,
        h("span", { class: "model-size" }, sizeText(r.size)),
      ),
      h("p", { class: "model-purpose" }, purposeText(r)),
      h(
        "div",
        { class: "model-bars" },
        this.bar("Accuracy", "accuracy", r),
        this.bar("Speed", "speed", r),
      ),
      measured ? h("p", { class: "model-measured" }, measured) : null,
      h(
        "p",
        { class: "model-kept" },
        keptText(r, this.unusedDays),
        h("span", { class: "model-from" }, ` · from ${r.from.join(", ")}`),
      ),
      this.actions(r),
    );
  }

  private bar(label: string, side: "accuracy" | "speed", r: ModelRow): HTMLElement {
    return this.meter(label, side, r[side], r.id);
  }

  /** One bar: its score, the raw number beside it, and the source in its title. */
  private meter(label: string, side: string, score: ScoreView, of: string): HTMLElement {
    const b = bar(score);
    const fill = h("span", { class: "fill" });
    if (b.value !== null) fill.style.width = `${b.value}%`;
    return h(
      "div",
      {
        class: `mbar ${side}${b.value === null ? " none" : ""}`,
        title: b.title,
        attrs: {
          "data-side": side,
          ...(b.value === null ? {} : { "data-value": String(b.value) }),
        },
      },
      h("span", { class: "mbar-label" }, label),
      h(
        "span",
        {
          class: "track",
          role: "meter",
          attrs: {
            "aria-label": `${label} of ${of}`,
            "aria-valuemin": "0",
            "aria-valuemax": "100",
            ...(b.value === null
              ? { "aria-valuetext": "not measured" }
              : { "aria-valuenow": String(b.value) }),
          },
        },
        fill,
      ),
      h("span", { class: "mbar-value" }, b.label),
    );
  }

  // -------------------------------------------------------------------------
  // The Live section

  private drawLive(): void {
    const v = this.live;
    this.liveSection.hidden = v === null;
    if (!v) return;
    const auto =
      v.setting === "auto"
        ? null
        : h(
            "button",
            {
              type: "button",
              id: "models-live-auto",
              title: "Sets asr.live to auto",
              on: { click: () => void this.useLive("auto") },
            },
            "Back to auto",
          );
    replace(
      this.liveSection,
      h("h3", {}, "Live transcript"),
      h("p", { class: "hint", id: "models-live-hint" }, liveHint(v), auto ? " " : null, auto),
      h("ul", { class: "model-list" }, ...v.setups.map((s) => this.liveRow(s, v))),
    );
  }

  private liveRow(s: LiveSetupView, v: LiveView): HTMLElement {
    const missing = liveMissing(s);
    const state = s.unavailable ? "unavailable" : missing.length > 0 ? "missing" : "ready";
    const models = liveModelsText(s);
    const actions = h("div", { class: "bar model-actions" });
    if (!s.unavailable && missing.length > 0) {
      actions.append(
        h(
          "button",
          {
            class: "go",
            type: "button",
            title: `Downloads ${missing.join(", ")}`,
            attrs: { "data-action": "download" },
            on: { click: () => void this.downloadAll(missing) },
          },
          "Download",
        ),
      );
    }
    if (!s.unavailable && v.setting !== s.id) {
      actions.append(
        h(
          "button",
          {
            type: "button",
            title: `Sets asr.live to ${s.id}`,
            attrs: { "data-action": "use" },
            on: { click: () => void this.useLive(s.id) },
          },
          "Use for calls",
        ),
      );
    }
    return h(
      "li",
      { class: "model live-setup", attrs: { "data-setup": s.id, "data-state": state } },
      h(
        "div",
        { class: "model-head" },
        h("strong", { class: "model-name" }, s.title),
        s.selected
          ? h("span", { class: "badge ok", attrs: { "data-mark": "next" } }, "next call")
          : null,
        s.running
          ? h("span", { class: "badge", attrs: { "data-mark": "running" } }, "this call")
          : null,
        s.unavailable ? h("span", { class: "badge" }, "unavailable") : null,
      ),
      h("p", { class: "model-purpose" }, s.what),
      h(
        "div",
        { class: "model-bars" },
        ...LIVE_BARS.map((b) => this.meter(b.label, b.side, s[b.side], s.title)),
      ),
      s.unavailable ? h("p", { class: "model-kept" }, `Unavailable: ${s.unavailable}`) : null,
      models ? h("p", { class: "model-kept" }, models) : null,
      actions,
    );
  }

  private async downloadAll(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const r = await this.t.request<ModelsReply>("POST", "/models/pull", { model: id });
      if (r.status >= 400) {
        toast(message(r.body, `${id} could not start downloading (HTTP ${r.status})`));
        break;
      }
    }
    await this.read();
  }

  private async useLive(value: string): Promise<void> {
    const r = await this.t.request<{ note?: string }>("PATCH", "/config", { "asr.live": value });
    if (r.status >= 400) {
      toast(message(r.body, `asr.live could not be set (HTTP ${r.status})`));
      return;
    }
    toast(r.body.note ?? `The next call's live transcript: ${value}.`, "info");
    await this.read();
  }

  private actions(r: ModelRow): HTMLElement {
    const out = h("div", { class: "bar model-actions" });
    if (r.state === "downloading") {
      const pct = percent(r);
      out.append(
        h("progress", { attrs: { max: "100", value: String(pct) } }),
        h("span", { class: "hint" }, `${pct} % of ${sizeText(r.size)}`),
      );
      return out;
    }
    if (r.state === "missing") {
      out.append(
        h(
          "button",
          { class: "go", type: "button", on: { click: () => void this.download(r.id) } },
          "Download",
        ),
      );
    } else {
      const refused = deleteRefusal(r);
      const del = twoStep(
        {
          class: "stop",
          label: "Delete",
          confirm: "Delete: sure?",
          id: `delete-${r.id}`,
          armed: this.armed,
        },
        () => void this.remove(r.id),
      );
      del.dataset.action = "delete";
      if (refused) {
        del.disabled = true;
        del.title = `Kept: ${refused}`;
      }
      out.append(del);
    }
    if (r.set_default && !r.default) {
      const d = r.set_default;
      out.append(
        h(
          "button",
          {
            type: "button",
            title: `Sets ${d.key} to ${d.value}`,
            attrs: { "data-action": "default" },
            on: { click: () => void this.makeDefault(d.key, d.value) },
          },
          "Set as default",
        ),
      );
    }
    return out;
  }

  private async download(id?: string): Promise<void> {
    const r = await this.t.request<ModelsReply>(
      "POST",
      "/models/pull",
      id === undefined ? undefined : { model: id },
    );
    if (r.status >= 400) {
      toast(message(r.body, `the download could not start (HTTP ${r.status})`));
      return;
    }
    await this.read();
  }

  private async remove(id: string): Promise<void> {
    const r = await this.t.request<{ bytes?: number }>(
      "DELETE",
      `/models/${encodeURIComponent(id)}`,
    );
    if (r.status >= 400) {
      toast(message(r.body, `${id} could not be deleted (HTTP ${r.status})`));
    } else {
      toast(`Deleted ${id}: ${sizeText(Number(r.body.bytes ?? 0))} freed.`, "info");
    }
    await this.read();
  }

  private async makeDefault(key: string, value: string): Promise<void> {
    const r = await this.t.request<{ note?: string }>("PATCH", "/config", { [key]: value });
    if (r.status >= 400) {
      toast(message(r.body, `${key} could not be set (HTTP ${r.status})`));
      return;
    }
    toast(r.body.note ?? `${key} is ${value}.`, "info");
    await this.read();
  }

  // -------------------------------------------------------------------------
  // The settings: what a missing model does, and when an unused one is deleted

  private async readSettings(): Promise<void> {
    const r = await this.t.request<ConfigReply>("GET", "/config");
    if (r.status !== 200) {
      replace(this.settings, h("p", { class: "hint" }, message(r.body, "settings unreadable")));
      return;
    }
    const v = r.body.settings;
    const days = Number(v["server.models_unused_days"]);
    this.unusedDays = Number.isFinite(days) ? days : null;
    this.drawRows();
    const auto = v["server.auto_download"] !== false;
    const choice = (value: "download" | "reject", label: string, hint: string) =>
      h(
        "label",
        { class: "choice" },
        h("input", {
          type: "radio",
          id: `models-on-demand-${value}`,
          value,
          attrs: {
            name: "models-on-demand",
            ...(auto === (value === "download") ? { checked: "" } : {}),
          },
        }),
        h("span", {}, label, h("small", {}, hint)),
      );
    const number = (key: string, id: string, max: string, step: string) =>
      h("input", {
        id,
        type: "number",
        value: String(v[key] ?? ""),
        attrs: { min: "0", max, step, "data-key": key, inputmode: "numeric" },
      });
    replace(
      this.settings,
      h("h3", {}, "Settings"),
      this.server
        ? h(
            "fieldset",
            { class: "models-on-demand" },
            h("legend", {}, "When a client asks for a model that isn't here"),
            choice(
              "download",
              "Download it and queue the job",
              "The job waits while the model downloads, then runs.",
            ),
            choice(
              "reject",
              "Reject the job",
              "The client gets 409 preset_unavailable and can try later.",
            ),
          )
        : null,
      h(
        "div",
        { class: "models-numbers" },
        h(
          "label",
          { attrs: { for: "models-unused-days" } },
          "Delete models unused for",
          number("server.models_unused_days", "models-unused-days", "3650", "1"),
          "days (0 = never)",
        ),
        h(
          "label",
          { attrs: { for: "models-max-gb" } },
          "Keep the models folder under",
          number("server.models_max_gb", "models-max-gb", "100000", "any"),
          "GB (0 = no cap)",
        ),
      ),
      h(
        "p",
        { class: "hint" },
        "The default model, a model in use and one downloading are never deleted.",
      ),
      h(
        "div",
        { class: "bar" },
        h("button", { id: "models-settings-save", class: "go", type: "submit" }, "Save"),
      ),
    );
    this.settingsShown = {
      "server.auto_download": auto,
      "server.models_unused_days": v["server.models_unused_days"],
      "server.models_max_gb": v["server.models_max_gb"],
    };
  }

  private settingsShown: Record<string, unknown> = {};

  /** True while the settings at the foot hold a change not saved yet. */
  unsaved(): boolean {
    return Object.keys(this.settingsPatch()).length > 0;
  }

  private settingsPatch(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    const reject = this.settings.querySelector<HTMLInputElement>("#models-on-demand-reject");
    if (reject && reject.checked === this.settingsShown["server.auto_download"]) {
      patch["server.auto_download"] = !reject.checked;
    }
    for (const el of this.settings.querySelectorAll<HTMLInputElement>("input[data-key]")) {
      const key = el.dataset.key as string;
      const now = el.value === "" ? null : Number(el.value);
      if (now !== this.settingsShown[key]) patch[key] = now;
    }
    return patch;
  }

  private async saveSettings(): Promise<void> {
    const patch = this.settingsPatch();
    if (Object.keys(patch).length === 0) {
      toast("Nothing changed.", "info");
      return;
    }
    const r = await this.t.request<{ note?: string; errors?: string[] }>("PATCH", "/config", patch);
    if (r.status >= 400) {
      toast((r.body.errors ?? [message(r.body, "refused")]).join("; "));
      return;
    }
    toast("Saved.", "info");
    await this.readSettings();
    await this.read();
  }
}
