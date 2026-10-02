/**
 * The Models page (docs/ux/design-explorations/sd-a-models.html, direction A; docs/ux/SERVER.md
 * SV-U6, DESKTOP.md DK-E2): a page of the main window beside the sidebar, and the same page on
 * server mode's web page. One column of grouped rows:
 *
 * - **Live transcript** (the app only): the live models as a radio list (`asr.live`), Automatic
 *   first, Voxtral listed and unavailable; "next call" and "this call" mark what runs.
 * - **Second pass** (the app only): Off, Qwen or Parakeet reviewing the finished sentences during
 *   the call (`asr.review.model`), and how often (`asr.review.everySeconds`).
 * - **After the call** (the app) or **Jobs** (server mode): the recognizer that writes the
 *   accurate transcript, the one `asr.final.model` names or the one `auto` runs (`GET /models`
 *   `final`), Qwen with its llama-server; in server mode a radio list of the recognizers a job may
 *   run by default.
 * - **Dictation** (the app): Fast and Best, the engines dictation decodes with.
 * - **Speakers**: who spoke when, a radio list (`asr.diarizer`).
 * - **On this Mac** (or computer, or server): the graphics chip, the unused-days sweep, the size
 *   cap, and what a job's missing model does (server mode).
 *
 * A row above the sections leads to **All models**: every model of the catalog for this machine in
 * four groups, Live transcript, After the call (Jobs in server mode), Speakers and Helpers, the ones
 * on disk first. Each has its size and Download, or its size and Remove; one that does not suit this
 * machine or the call's languages says why in a line under its name and keeps its Download.
 *
 * Each fact is a plain sentence from the numbers in `asr/model-scores.ts` and
 * `asr/live-setups.ts`, each accuracy figure naming its test set (`models-rows.ts`). A model shows
 * its size where the page owns it and "Already here" where another row does; a missing one is one
 * Download away, a downloading one shows its progress and Cancel, and a removable one shows Remove
 * on hover, which asks once more before it acts. The default and a model in use are kept, and say
 * why.
 *
 * Each change saves its key alone through `PATCH /config`; a number saves when its field is left,
 * and leaving the page saves what is still typed. The routes are the ones a script calls:
 * `GET /models`, `POST /models/pull`, `POST /models/cancel`, `DELETE /models/{id}`, `GET` and
 * `PATCH /config`.
 */

import { h, replace, toast } from "./dom.ts";
import { everyChoices } from "./live-options.ts";
import {
  accuracyText,
  afterCallHelp,
  allModelsText,
  autoHelp,
  bestHelp,
  catalogGroups,
  catalogLine,
  DEFAULTS,
  DIARIZERS,
  everyLabel,
  gbText,
  hourText,
  keptText,
  type LiveView,
  liveHelp,
  liveName,
  type ModelRow,
  modelName,
  needsText,
  PRESET_ENGINES,
  percent,
  QWEN_ID,
  RECOGNIZER_ID,
  reasonText,
  removeRefusal,
  roleTitle,
  speakersHelp,
  totalText,
} from "./models-rows.ts";
import { message } from "./notepad.ts";
import type { ModelsInfo, Transport } from "./protocol.ts";
import {
  backLink,
  choiceRow,
  field,
  ICONS,
  icon,
  linkRow,
  pageHead,
  progress,
  row,
  section,
  sectionWith,
  segmented,
  selectBox,
  tag,
  toggle,
  unit,
} from "./rows.ts";
import { twoStep } from "./server-common.ts";
import type { ConfigReply, SchemaEntry } from "./settings.ts";
import { wordsFor } from "./settings-labels.ts";

/** The final pass's model (`GET /models` `final`): the setting, the id it names, what runs next. */
interface FinalView {
  setting: string;
  named: string | null;
  /** Null when no final model is downloaded; `rover-conf(<ids>)` when the pass fuses several. */
  next: string | null;
  /** `asr.final.engines` as ids; empty for one model. Absent from an older app. */
  engines?: string[];
}
type ModelsReply = ModelsInfo & { models?: ModelRow[]; live?: LiveView; final?: FinalView };

/** The numbers of "On this Mac": each field's id, label, help and unit. */
const NUMBERS = [
  {
    key: "server.models_unused_days",
    id: "models-unused-days",
    label: "Delete models unused for",
    help: "The default and anything in use are never deleted. 0 means never.",
    unit: "days",
  },
  {
    key: "server.models_max_gb",
    id: "models-max-gb",
    label: "Keep all models under",
    help: "A download that would pass it is refused. 0 means no limit.",
    unit: "GB",
  },
] as const;

export class ModelsPage {
  readonly name = "models" as const;
  readonly title = "Models";
  readonly root = h("section", {
    id: "page-models",
    class: "pg",
    attrs: { "aria-label": "Models" },
  });
  private readonly col = h("div", { class: "pg-col" });
  private readonly head = h("div", {});
  private readonly state = h("div", {
    id: "models-state",
    class: "pg-help",
    attrs: { role: "status" },
  });
  private readonly pullAll = h(
    "button",
    { id: "models-download", class: "pg-btn", type: "button", hidden: true },
    icon(...ICONS.download),
    "Download speech models",
  );
  private readonly lists = h("div", { id: "models-lists" });
  private readonly settingsBox = h("div", { id: "models-settings" });
  private info: ModelsInfo | null = null;
  private rows: ModelRow[] = [];
  private live: LiveView | null = null;
  private final: FinalView | null = null;
  private schema: Record<string, SchemaEntry> = {};
  private settings: Record<string, unknown> = {};
  private issues = new Map<string, string>();
  /** What each number field held when drawn, so leaving saves only an edit. */
  private shownNumbers = new Map<string, string>();
  private platform = "";
  /** The All models page is on screen instead of the page itself. */
  private sub = false;
  private readonly armed = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private shown = false;
  /** Bumped by every show and every leave: a show that lands after a newer one draws nothing. */
  private shows = 0;
  /** Bumped by every poll and every show: an older poll's answer never draws over a newer one. */
  private polls = 0;
  /** A show is reading: the page holds its "Reading" line, and a poll leaves it alone. */
  private loading = false;

  constructor(
    private readonly t: Transport,
    /** Server mode: jobs pick the recognizer, and what a missing model does is a choice here. */
    private readonly server: boolean,
  ) {
    this.root.append(this.col);
    this.pullAll.addEventListener("click", () => void this.pullSet());
    this.root.addEventListener("change", (e) => {
      const el = e.target as HTMLElement;
      const key = el.dataset?.key;
      if (key) void this.save(key, el);
    });
  }

  private get here(): string {
    if (this.server) return "this server";
    return this.platform === "darwin" ? "this Mac" : "this computer";
  }

  /** Reads the models and the settings and draws the page; on `key`, goes to that setting. */
  async show(key?: string): Promise<void> {
    // Counted before the save, so a leave during it wins and this show draws nothing.
    const n = ++this.shows;
    // Shown again while on screen (its sidebar row): what is typed is saved before the redraw.
    await this.saveTyped();
    if (n !== this.shows) return;
    this.shown = true;
    // `helpers`, the older name of the page that listed the models no section places.
    this.sub = key === "all" || key === "helpers";
    // The poll stops while the page reads everything; a poll that lands meanwhile draws nothing.
    this.stop();
    this.polls++;
    this.loading = true;
    replace(this.col, h("p", { class: "pg-reading" }, "Reading the models…"));
    const [models, cfg, st] = await Promise.all([
      this.t.request<ModelsReply>("GET", "/models").catch(() => null),
      this.t.request<ConfigReply>("GET", "/config").catch(() => null),
      this.server
        ? null
        : this.t.request<{ app?: { platform?: string } }>("GET", "/status").catch(() => null),
    ]);
    if (n !== this.shows || !this.shown) return;
    this.loading = false;
    if (st && st.status < 400) this.platform = String(st.body?.app?.platform ?? "");
    if (cfg && cfg.status < 400) this.config(cfg.body);
    else toast(message(cfg?.body, "the settings could not be read"));
    if (models && models.status === 200) this.take(models.body);
    this.draw();
    if (key && !this.sub) this.goTo(key);
  }

  /** The page is left: what is still typed into a number is saved, and the page stops following. */
  leave(): void {
    this.shown = false;
    this.shows++;
    this.polls++;
    this.loading = false;
    this.stop();
    void this.saveTyped();
  }

  /** Saves each number whose field holds what was not saved yet. */
  private async saveTyped(): Promise<void> {
    const typed = NUMBERS.map((n) => ({
      key: n.key,
      el: this.settingsBox.querySelector<HTMLInputElement>(`#${n.id}`),
    })).filter((x) => x.el && x.el.value !== this.shownNumbers.get(x.key));
    await Promise.all(typed.map((x) => this.save(x.key, x.el as HTMLInputElement)));
  }

  /** Server mode's name for leaving. */
  hide(): void {
    this.leave();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private config(c: ConfigReply): void {
    this.schema = c.schema;
    this.settings = { ...c.settings };
    this.issues = new Map(c.issues.map((i) => [i.key, i.message]));
  }

  private take(m: ModelsReply): void {
    this.info = m;
    this.rows = m.models ?? [];
    this.live = m.live ?? null;
    this.final = m.final ?? null;
    const busy =
      m.state === "downloading" ||
      this.rows.some((r) => r.state === "downloading") ||
      (this.live?.setups.some((s) => s.models.some((x) => x.state === "downloading")) ?? false);
    if (busy && this.shown) this.timer ??= setInterval(() => void this.read(), 1000);
    else this.stop();
  }

  /** Reads the models again and redraws them; the settings' fields are left as they are. */
  private async read(): Promise<void> {
    if (this.loading) return;
    const n = ++this.polls;
    let r: { status: number; body: ModelsReply };
    try {
      r = await this.t.request<ModelsReply>("GET", "/models");
    } catch {
      return;
    }
    if (n !== this.polls || r.status !== 200 || !this.shown || this.loading) return;
    this.take(r.body);
    this.drawModels();
  }

  private draw(): void {
    this.drawSettings();
    this.drawModels();
    replace(this.col, this.head, this.lists, this.sub ? null : this.settingsBox);
    this.root.parentElement?.scrollTo?.({ top: 0 });
  }

  // -------------------------------------------------------------------------
  // The models

  /** Redraws the models, keeping the keyboard on the control it was on (or on its row). */
  private drawModels(): void {
    const at = this.focused();
    this.drawLists();
    if (!at) return;
    const el = at.map((sel) => this.col.querySelector<HTMLElement>(sel)).find((x) => x);
    el?.focus({ preventScroll: true });
  }

  /**
   * Where the keyboard is on the page, as selectors that find the same control after a redraw:
   * the control itself, then its row's first control (a Download that became a Cancel).
   */
  private focused(): string[] | null {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !this.col.contains(el)) return null;
    if (el.id) return [`#${CSS.escape(el.id)}`];
    if (el instanceof HTMLInputElement && el.type === "radio" && el.name)
      return [`input[name="${CSS.escape(el.name)}"][value="${CSS.escape(el.value)}"]`];
    const r = el.closest<HTMLElement>("[data-setup], [data-review], [data-diarizer], [data-model]");
    if (!r) return null;
    const attr = ["data-setup", "data-review", "data-diarizer", "data-model"].find((a) =>
      r.hasAttribute(a),
    );
    const at = `[${attr}="${CSS.escape(r.getAttribute(attr as string) ?? "")}"]`;
    const action = el.dataset.action;
    return [
      ...(action ? [`${at} [data-action="${CSS.escape(action)}"]`] : []),
      `${at} :is(button, input):not(:disabled)`,
    ];
  }

  private drawLists(): void {
    if (this.sub) {
      replace(
        this.head,
        pageHead("All models", {
          back: backLink("Models", () => {
            this.sub = false;
            this.draw();
            this.col.querySelector<HTMLElement>("#models-go-all")?.focus();
          }),
        }),
      );
      replace(this.lists, ...this.allSections());
      return;
    }
    this.drawState();
    replace(this.head, pageHead("Models", { sub: this.state, right: [this.pullAll] }));
    const sections = this.server
      ? [this.jobsSection(), this.speakersSection()]
      : [
          this.liveSection(),
          this.reviewSection(),
          this.afterCallSection(),
          this.dictationSection(),
          this.speakersSection(),
        ];
    const all = section("", this.allRow());
    all.id = "models-all";
    replace(this.lists, all, ...sections);
  }

  /** The line under the title: the total here, or the speech models' download. */
  private drawState(): void {
    const m = this.info;
    this.pullAll.hidden = !m || m.state === "ready" || m.state === "downloading";
    replace(
      this.pullAll,
      icon(...ICONS.download),
      m?.state === "failed" ? "Try again" : "Download speech models",
    );
    if (!m || m.state === "ready") {
      this.state.textContent = totalText(this.rows, this.here, this.server);
      return;
    }
    if (m.state === "downloading") {
      replace(
        this.state,
        progress(
          percent(m.bytes, m.total),
          `Downloading the speech models: ${percent(m.bytes, m.total)} % of ${gbText(m.total)}`,
        ),
      );
      return;
    }
    if (m.state === "failed") {
      const why = reasonText(m.error);
      this.state.textContent = `The download stopped${why ? `: ${why}` : ""}. Files already verified are kept.`;
      return;
    }
    this.state.textContent = `The speech models are not downloaded yet: ${gbText(m.total)}. ${
      this.server ? "Jobs are refused" : "Recording waits"
    } until they are.`;
  }

  private row(id: string): ModelRow | undefined {
    return this.rows.find((r) => r.id === id);
  }

  private rowsOf(ids: readonly string[]): ModelRow[] {
    return ids.map((id) => this.row(id)).filter((r): r is ModelRow => r !== undefined);
  }

  /**
   * What a row shows on its right for the models it needs: its size (where the page owns them) or
   * "Already here", Download for what is missing, the progress and Cancel while one downloads, and
   * Remove on hover where they may be removed. `help` is the progress, in place of the row's help,
   * while it downloads.
   */
  private modelSide(
    models: readonly ModelRow[],
    owner: boolean,
  ): { controls: Node[]; help: HTMLElement | null; state: string } {
    if (models.length === 0) return { controls: [], help: null, state: "none" };
    const size = models.reduce((n, r) => n + r.size, 0);
    const downloading = models.filter((r) => r.state === "downloading");
    const missing = models.filter((r) => r.state === "missing");
    if (downloading.length > 0) {
      // The progress of what is still coming, not of the set with what is already here.
      const coming = models.filter((r) => r.state !== "ready");
      const pct = percent(
        coming.reduce((n, r) => n + r.bytes, 0),
        coming.reduce((n, r) => n + r.size, 0),
      );
      if (!owner)
        return {
          controls: [h("span", { class: "pg-value" }, `Downloading, ${pct} %`)],
          help: null,
          state: "downloading",
        };
      const cancel = h(
        "button",
        {
          type: "button",
          class: "pg-btn ghost",
          attrs: { "data-action": "cancel" },
          on: { click: () => void this.cancel(downloading.map((r) => r.id)) },
        },
        "Cancel",
      );
      return {
        controls: [cancel],
        help: progress(pct, `${pct} % of ${gbText(coming.reduce((n, r) => n + r.size, 0))}`),
        state: "downloading",
      };
    }
    if (missing.length > 0) {
      const need = missing.reduce((n, r) => n + r.size, 0);
      const down = h(
        "button",
        {
          type: "button",
          class: "pg-btn",
          attrs: { "data-action": "download" },
          on: { click: () => void this.pull(missing.map((r) => r.id)) },
        },
        icon(...ICONS.download),
        "Download",
      );
      return {
        controls: [h("span", { class: "pg-value" }, gbText(need)), down],
        help: null,
        state: "missing",
      };
    }
    if (!owner)
      return {
        controls: [h("span", { class: "pg-value" }, "Already here")],
        help: null,
        state: "ready",
      };
    const days = Number(this.settings["server.models_unused_days"]);
    const kept = models.find((r) => removeRefusal(r));
    const sizeEl = h(
      "span",
      {
        class: "pg-value",
        title: keptText(kept ?? (models[0] as ModelRow), Number.isFinite(days) ? days : null),
      },
      gbText(size),
    );
    // A kept model draws no Remove; its size's tooltip says why it stays.
    if (kept) return { controls: [sizeEl], help: null, state: "ready" };
    const id = models.map((r) => r.id).join("+");
    const remove = twoStep(
      {
        class: "pg-btn ghost pg-remove",
        label: "Remove",
        confirm: "Remove: sure?",
        id: `remove-${id}`,
        armed: this.armed,
      },
      () => void this.remove(models.map((r) => r.id)),
    );
    remove.dataset.action = "remove";
    return { controls: [sizeEl, remove], help: null, state: "ready" };
  }

  /** A row for models the page owns: its name, its facts, and its models' side. */
  private modelRow(
    label: string,
    help: string,
    models: readonly ModelRow[],
    o: { owner?: boolean } = {},
  ): HTMLElement {
    const side = this.modelSide(models, o.owner !== false);
    const r = row({ label, help: side.help ?? help }, ...side.controls);
    r.dataset.model = models[0]?.id ?? "";
    r.dataset.state = side.state;
    return r;
  }

  private liveSection(): HTMLElement | null {
    const v = this.live;
    if (!v) return null;
    const setting = String(this.settings["asr.live"] ?? v.setting);
    const nextId = v.slots.live.find((e) => e.checked)?.id ?? null;
    const mark = (row: string, id: string | null) => {
      const out: HTMLElement[] = [];
      if (v.runningId && id === v.runningId) out.push(tag("this call", "running"));
      else if (row === (setting === "auto" ? "auto" : nextId)) out.push(tag("next call", "next"));
      return out;
    };
    const auto = choiceRow(
      {
        name: "models-live",
        value: "auto",
        label: liveName("auto"),
        help: autoHelp(v, this.here),
        checked: setting === "auto",
        isDefault: DEFAULTS["asr.live"] === "auto",
      },
      ...mark("auto", setting === "auto" ? nextId : null),
    );
    auto.dataset.setup = "auto";
    const rows: HTMLLabelElement[] = [auto];
    for (const e of v.slots.live) {
      const own = this.row(e.id);
      if (!own) continue;
      const family = e.id.startsWith("nemotron") ? "nemotron" : "parakeet";
      const s = v.setups.find((x) => x.id === family);
      // A streaming Nemotron is this section's own; Parakeet is shown where it belongs.
      const owner = family === "nemotron";
      const side = this.modelSide([own], owner);
      // The family's measured figure belongs to its measured tiers only: a tier nobody measured
      // (`own.accuracy` has no score) says so in its own line and gets no borrowed number.
      const figure = s && own.accuracy.score !== null ? accuracyText(s.accuracy) : null;
      const help = [figure, own.lines.live].filter((x) => x).join(" ");
      const checked =
        setting === e.id ||
        (setting === "nemotron" && family === "nemotron" && e.checked) ||
        (setting === "parakeet" && family === "parakeet");
      const r = choiceRow(
        {
          name: "models-live",
          value: e.id,
          label: own.name ?? e.id,
          help:
            side.help ?? (!owner && own.state !== "ready" ? needsText([own]) : (e.blocked ?? help)),
          checked,
          isDefault: DEFAULTS["asr.live"] === e.id,
          // A model that does not hear the call's languages says why, as the second pass does.
          disabled: e.blocked !== null && !checked,
        },
        ...mark(e.id, e.id),
        ...side.controls,
      );
      r.dataset.setup = e.id;
      r.dataset.state = e.blocked ? "blocked" : side.state;
      rows.push(r);
    }
    const vox = v.setups.find((x) => x.id === "voxtral");
    if (vox) {
      const r = choiceRow({
        name: "models-live",
        value: "voxtral",
        label: vox.title,
        help: liveHelp(vox),
        checked: false,
        disabled: true,
      });
      r.dataset.setup = "voxtral";
      r.dataset.state = "unavailable";
      rows.push(r);
    }
    for (const r of rows) {
      const input = r.querySelector<HTMLInputElement>("input.pg-radio");
      input?.addEventListener("change", () => {
        if (input.checked) void this.patch("asr.live", input.value);
      });
    }
    const s = sectionWith(
      "Live transcript",
      v.running !== null ? "A change applies from the next call." : null,
      ...rows,
    );
    s.id = "models-live";
    return s;
  }

  /** The second pass: Off, then each model that can review, with what stops it here, and how often. */
  private reviewSection(): HTMLElement | null {
    const v = this.live;
    if (!v) return null;
    const r = v.review;
    const setting = String(this.settings["asr.review.model"] ?? r.setting);
    const kind = (id: string) => (id.startsWith("qwen") ? "qwen" : "parakeet");
    const mark = (id: string) =>
      r.running && r.running.model === kind(id)
        ? [tag("this call", "running")]
        : !r.running && r.next?.model === kind(id)
          ? [tag("next call", "next")]
          : [];
    const off = choiceRow({
      name: "models-review",
      value: "none",
      label: "Off",
      help: "The live lines stay as they were written.",
      checked: setting === "none",
      isDefault: DEFAULTS["asr.review.model"] === "none",
    });
    off.dataset.review = "none";
    const rows: HTMLElement[] = [off];
    for (const e of v.slots.review) {
      const own = this.row(e.id);
      if (!own) continue;
      const models = this.rowsOf(e.models);
      const side = this.modelSide(models, false);
      const missing = models.filter((m) => m.state === "missing");
      const help = missing.length > 0 ? needsText(missing) : (e.blocked ?? own.lines.review ?? "");
      const chosen = setting === e.id || setting === kind(e.id);
      const row = choiceRow(
        {
          name: "models-review",
          value: e.id,
          label: own.name ?? e.id,
          help: side.help ?? help,
          checked: chosen,
          isDefault: DEFAULTS["asr.review.model"] === e.id,
          disabled: e.blocked !== null && !chosen,
        },
        ...mark(e.id),
        ...side.controls,
      );
      row.dataset.review = e.id;
      row.dataset.state = e.blocked ? "blocked" : side.state;
      rows.push(row);
    }
    for (const x of rows) {
      const input = x.querySelector<HTMLInputElement>("input.pg-radio");
      input?.addEventListener("change", () => {
        if (input.checked) void this.patch("asr.review.model", input.value);
      });
    }
    const every = Number(this.settings["asr.review.everySeconds"] ?? r.everySeconds);
    const pick = selectBox({
      id: "models-review-every",
      label: "How often",
      options: everyChoices(every).map((n) => [String(n), everyLabel(n)] as const),
      value: String(every),
    });
    pick.dataset.key = "asr.review.everySeconds";
    pick.dataset.number = "true";
    rows.push(
      this.withIssue(
        row(
          {
            label: "How often",
            help: "The reviewed text lands about this long after the words.",
            key: "asr.review.everySeconds",
            for: pick.id,
          },
          pick,
        ),
        "asr.review.everySeconds",
      ),
    );
    const s = sectionWith(
      "Second pass",
      "Rewrites the finished sentences once during the call, for cleaner lines a little later.",
      ...rows,
    );
    s.id = "models-review";
    return s;
  }

  /**
   * The model After the call shows: the first of `asr.final.engines`, else the one
   * `asr.final.model` names, else the one the next pass runs (`auto`), else Parakeet where the app
   * says neither.
   */
  private afterCallId(): string {
    // Several models after the call: the row shows the first, which breaks their ties.
    return this.final?.engines?.[0] ?? this.final?.named ?? this.final?.next ?? RECOGNIZER_ID;
  }

  /**
   * After the call: the model that writes the final transcript, as the setting says, with Qwen's
   * llama-server in the same Download. A named model that is not here says what writes it until it
   * is.
   */
  private afterCallSection(): HTMLElement | null {
    const r =
      this.row(this.afterCallId()) ??
      this.row(RECOGNIZER_ID) ??
      this.rows.find((x) => x.kind === "speech" && x.default);
    if (!r) return null;
    const models =
      r.id === QWEN_ID
        ? this.rowsOf(this.live?.slots.review.find((e) => e.id === QWEN_ID)?.models ?? [QWEN_ID])
        : [r];
    const next = this.final?.next;
    // A fused pass (`rover-conf(<ids>)`) is no one model to wait for.
    const until =
      next && next !== r.id && !next.startsWith("rover-")
        ? `Until it is downloaded, ${modelName(this.row(next) ?? { id: next, job: "" })} writes it.`
        : "";
    const s = section(
      "After the call",
      this.modelRow(
        modelName(r),
        [afterCallHelp(r, this.here), until].filter((x) => x).join(" "),
        models,
      ),
    );
    s.id = "models-after";
    return s;
  }

  private dictationSection(): HTMLElement | null {
    const fast = this.row(RECOGNIZER_ID);
    const best = this.row(QWEN_ID);
    if (!fast && !best) return null;
    const rows: HTMLElement[] = [];
    // With another model after the call, Fast's Parakeet is a model of its own here.
    if (fast && this.afterCallId() !== RECOGNIZER_ID)
      rows.push(
        this.modelRow(
          `Fast: ${modelName(fast)}`,
          "Parakeet, on the processor: about 0.1 s for 5 s of speech.",
          [fast],
        ),
      );
    else if (fast && fast.state === "ready")
      rows.push(
        this.modelRow(
          `Fast: ${modelName(fast)}`,
          "The same model as after the call, so there is nothing more to download.",
          [fast],
          { owner: false },
        ),
      );
    else if (fast) {
      // Not here yet: After the call downloads it, and Fast has nothing of its own to offer.
      const r = row({ label: `Fast: ${modelName(fast)}`, help: "Downloads with After the call." });
      r.dataset.model = fast.id;
      r.dataset.state = fast.state;
      rows.push(r);
    }
    if (best) rows.push(this.modelRow(`Best: ${modelName(best)}`, bestHelp(best), [best]));
    const s = section("Dictation", ...rows);
    s.id = "models-dictation";
    return s;
  }

  /** Server mode: the recognizer a job runs when it names none, and each one's facts. */
  private jobsSection(): HTMLElement | null {
    const speech = this.rows.filter((r) => r.kind === "speech" && r.after_call);
    if (speech.length === 0) return null;
    const key = "server.default_model";
    const set = String(this.settings[key] ?? DEFAULTS[key]);
    // A preset in the setting marks the recognizer it runs.
    const value = PRESET_ENGINES[set] ?? set;
    const radios: HTMLLabelElement[] = [];
    if (key in this.schema)
      radios.push(
        choiceRow({
          name: "models-jobs",
          value: "auto",
          label: "Automatic",
          help: "Chosen for each job by what this server has.",
          checked: value === "auto",
          isDefault: DEFAULTS[key] === "auto",
        }),
      );
    for (const r of speech) {
      const side = this.modelSide([r], true);
      const help = [accuracyText(r.accuracy), hourText(r, this.here)].filter((x) => x).join(" ");
      const c = choiceRow(
        {
          name: "models-jobs",
          value: r.set_default?.value ?? r.id,
          label: modelName(r),
          help: side.help ?? help,
          checked: value === (r.set_default?.value ?? r.id),
          disabled: !(key in this.schema),
        },
        ...side.controls,
      );
      c.dataset.model = r.id;
      c.dataset.state = side.state;
      radios.push(c);
    }
    for (const r of radios) this.pick(r, key);
    const s = section("Jobs", ...radios);
    s.id = "models-jobs";
    return s;
  }

  private speakersSection(): HTMLElement | null {
    const key = "asr.diarizer";
    const value = String(this.settings[key] ?? DEFAULTS[key]);
    const radios = Object.entries(DIARIZERS)
      .map(([setting, ids]) => {
        const models = this.rowsOf(ids);
        if (models.length === 0) return null;
        const side = this.modelSide(models, true);
        const c = choiceRow(
          {
            name: "models-speakers",
            value: setting,
            label: setting === "nemotron" ? "Nemotron diarization" : "Voice fingerprints",
            help: side.help ?? speakersHelp(setting, models),
            checked: value === setting,
            isDefault: DEFAULTS[key] === setting,
            disabled: !(key in this.schema),
          },
          ...side.controls,
        );
        c.dataset.diarizer = setting;
        c.dataset.model = models[0]?.id ?? "";
        c.dataset.state = side.state;
        this.pick(c, key);
        return c;
      })
      .filter((x): x is HTMLLabelElement => x !== null);
    if (radios.length === 0) return null;
    const s = sectionWith("Speakers", "A change applies the next time akou starts.", ...radios);
    s.id = "models-speakers";
    return s;
  }

  /** A radio row's pick saves its setting. */
  private pick(r: HTMLLabelElement, key: string): void {
    const input = r.querySelector<HTMLInputElement>("input.pg-radio");
    input?.addEventListener("change", () => {
      if (input.checked) void this.patch(key, input.value);
    });
  }

  /** The row to All models: how many models are here and how many more there are. */
  private allRow(): HTMLElement {
    return linkRow(
      {
        label: "All models",
        help: allModelsText(this.rows, this.here),
        value: String(this.rows.length),
        id: "models-go-all",
      },
      () => {
        this.sub = true;
        this.draw();
        this.col.querySelector<HTMLElement>(".pg-back")?.focus();
      },
    );
  }

  /** The All models page: the whole catalog by what each model does, the ones on disk first. */
  private allSections(): HTMLElement[] {
    const advice = this.live?.advice ?? {};
    return catalogGroups(this.rows).map((g) => {
      const s = section(
        roleTitle(g.role, this.server),
        ...g.rows.map((r) => this.catalogRow(r, advice[r.id] ?? null)),
      );
      s.dataset.role = g.role;
      return s;
    });
  }

  /**
   * One model of All models: its name, what it does, and under that why it does not suit this
   * machine when it does not; on the right its size with Download, or with Remove where allowed.
   */
  private catalogRow(r: ModelRow, why: string | null): HTMLElement {
    const side = this.modelSide([r], true);
    const help =
      side.help ?? h("span", {}, catalogLine(r), why ? h("span", { class: "pg-why" }, why) : null);
    const el = row({ label: modelName(r), help }, ...side.controls);
    el.dataset.model = r.id;
    el.dataset.state = side.state;
    if (why) el.dataset.advice = "";
    return el;
  }

  // -------------------------------------------------------------------------
  // On this Mac

  private drawSettings(): void {
    this.shownNumbers.clear();
    const rows: (HTMLElement | null)[] = [this.acceleratorRow()];
    for (const n of NUMBERS) {
      if (!(n.key in this.schema)) continue;
      const v = String(this.settings[n.key] ?? "");
      this.shownNumbers.set(n.key, v);
      const f = field({ id: n.id, label: n.label, value: v, type: "number", width: "narrow" });
      f.min = "0";
      f.step = n.key === "server.models_max_gb" ? "any" : "1";
      f.dataset.key = n.key;
      rows.push(
        this.withIssue(
          row({ label: n.label, help: n.help, key: n.key, for: n.id }, f, unit(n.unit)),
          n.key,
        ),
      );
    }
    if (this.server && "server.auto_download" in this.schema) {
      const w = wordsFor("server.auto_download");
      const sw = toggle({
        id: "models-auto-download",
        checked: this.settings["server.auto_download"] !== false,
        label: w.label,
      });
      sw.dataset.key = "server.auto_download";
      rows.push(
        this.withIssue(
          row({ label: w.label, help: w.help, key: "server.auto_download", for: sw.id }, sw),
          "server.auto_download",
        ),
      );
    }
    const title = this.server ? "On this server" : `On ${this.here}`;
    replace(this.settingsBox, section(title, ...rows));
  }

  /** "Use the graphics chip": Automatic, On or Off on a Mac; every choice elsewhere. */
  private acceleratorRow(): HTMLElement | null {
    const key = "asr.accelerator";
    if (!(key in this.schema)) return null;
    const value = String(this.settings[key] ?? "auto");
    const id = "models-accelerator";
    const label = "Use the graphics chip";
    let control: HTMLElement;
    if (this.platform === "darwin" && ["auto", "metal", "cpu"].includes(value)) {
      const seg = segmented({
        id,
        label,
        options: [
          ["auto", "Automatic"],
          ["metal", "On"],
          ["cpu", "Off"],
        ],
        value,
      });
      seg.input.dataset.key = key;
      control = seg.root;
    } else {
      const values = this.schema[key]?.values;
      const choices = (wordsFor(key).choices ?? []).filter(([v]) => !values || values.includes(v));
      control = selectBox({ id, label, options: choices, value });
      control.dataset.key = key;
    }
    return this.withIssue(
      row(
        {
          label,
          help: "Qwen3-ASR runs on it. The other models use the processor.",
          key,
          id: "models-accelerator-row",
        },
        control,
      ),
      key,
    );
  }

  private withIssue(r: HTMLElement, key: string): HTMLElement {
    const issue = this.issues.get(key);
    if (issue) {
      r.classList.add("refused");
      r.querySelector(".pg-lbl")?.append(h("small", { class: "issue" }, issue));
    }
    return r;
  }

  /** Goes to a setting's row on the page and focuses its control. */
  private goTo(key: string): void {
    const r = this.col.querySelector<HTMLElement>(`.pg-row[data-key="${CSS.escape(key)}"]`);
    const target =
      r ??
      (key === "asr.live"
        ? this.col.querySelector<HTMLElement>("#models-live")
        : key === "asr.review.model"
          ? this.col.querySelector<HTMLElement>("#models-review")
          : key === "asr.diarizer"
            ? this.col.querySelector<HTMLElement>("#models-speakers")
            : null);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    const input = target.querySelector<HTMLElement>("input:checked, input, select, button");
    input?.focus();
    if (r) {
      r.classList.add("pg-flash");
      setTimeout(() => r.classList.remove("pg-flash"), 1600);
    }
  }

  // -------------------------------------------------------------------------
  // Saving, downloading, removing

  /** Saves the setting a field of "On this Mac" holds. */
  private async save(key: string, el: HTMLElement): Promise<void> {
    if (el instanceof HTMLInputElement && el.type === "number") {
      const was = this.shownNumbers.get(key);
      if (el.value === was) return;
      // Marked saved before the answer, so a blur and a leave at once send it once.
      this.shownNumbers.set(key, el.value);
      const ok = await this.patch(key, el.value === "" ? null : Number(el.value));
      if (!ok && was !== undefined) this.shownNumbers.set(key, was);
      return;
    }
    const value =
      el instanceof HTMLInputElement && el.type === "checkbox"
        ? el.checked
        : el.dataset.number
          ? Number((el as HTMLSelectElement).value)
          : (el as HTMLInputElement | HTMLSelectElement).value;
    await this.patch(key, value);
  }

  /** One key through `PATCH /config`; a refusal shows under its row and in a toast. */
  private async patch(key: string, value: unknown): Promise<boolean> {
    const r = await this.t.request<{ note?: string; errors?: string[] }>("PATCH", "/config", {
      [key]: value,
    });
    const at = this.col.querySelector<HTMLElement>(`.pg-row[data-key="${CSS.escape(key)}"]`);
    at?.classList.remove("refused");
    at?.querySelector(".issue")?.remove();
    if (r.status >= 400) {
      const why = (r.body.errors ?? [message(r.body, "refused")])
        .map((e) => (e.startsWith(`${key}:`) ? e.slice(key.length + 1).trim() : e))
        .join("; ");
      at?.classList.add("refused");
      at?.querySelector(".pg-lbl")?.append(h("small", { class: "issue" }, why));
      toast(`Not saved: ${why}`);
      if (
        key === "asr.live" ||
        key === "asr.review.model" ||
        key === "asr.diarizer" ||
        key === "server.default_model"
      )
        this.drawModels();
      return false;
    }
    this.settings[key] = value;
    this.issues.delete(key);
    toast(
      key.startsWith("asr.live") || key.startsWith("asr.review")
        ? "The next call uses this."
        : "Saved.",
      "info",
    );
    if (!key.startsWith("server.models_")) await this.read();
    return true;
  }

  private async pull(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const r = await this.t.request<ModelsReply>("POST", "/models/pull", { model: id });
      if (r.status >= 400) {
        toast(this.failed(id, "could not start downloading", r.body));
        break;
      }
    }
    await this.read();
  }

  /** The first-run set, in one download. */
  private async pullSet(): Promise<void> {
    const r = await this.t.request<ModelsReply>("POST", "/models/pull");
    if (r.status >= 400) {
      const why = reasonText(message(r.body, ""));
      toast(`The download could not start${why ? `: ${why}` : ""}.`);
    }
    await this.read();
  }

  private async cancel(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const r = await this.t.request("POST", "/models/cancel", { model: id });
      // Already finished or stopped: the read below shows where it is.
      if (r.status >= 400 && r.status !== 404)
        toast(this.failed(id, "could not be stopped", r.body));
    }
    await this.read();
  }

  private async remove(ids: readonly string[]): Promise<void> {
    let bytes = 0;
    for (const id of ids) {
      const r = await this.t.request<{ bytes?: number }>(
        "DELETE",
        `/models/${encodeURIComponent(id)}`,
      );
      if (r.status >= 400 && r.status !== 404) {
        toast(this.failed(id, "could not be removed", r.body));
        await this.read();
        return;
      }
      bytes += Number(r.body?.bytes ?? 0);
    }
    toast(`Removed: ${gbText(bytes)} freed.`, "info");
    await this.read();
  }

  /** "Qwen3-ASR 1.7B could not be removed: it is in use." The server's reason in plain words. */
  private failed(id: string, what: string, body: unknown): string {
    const why = reasonText(message(body, ""));
    const name = modelName(this.row(id) ?? { id, job: "" });
    return `${name} ${what}${why ? `: ${why}` : ""}.`;
  }
}
