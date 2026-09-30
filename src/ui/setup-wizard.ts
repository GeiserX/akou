/**
 * The first-run setup (docs/ux/WINDOW.md section 10, DESKTOP.md section 11): the welcome, in the
 * main area beside the sidebar (docs/ux/design-explorations/b2-welcome.png). Its first screen asks
 * what akou is for, calls, dictation or both, and the setup then shows only the steps that use
 * needs, one screen each, with Back, Skip where a step is optional, and the step count:
 *
 * - where calls go: the recordings folder and the first workspace (calls);
 * - dictation: the key, with the recorder the Dictation page uses, the engine and the languages;
 * - the speech models, with the one download (`models-card.ts`), and Qwen3-ASR when dictation
 *   runs on Best (`dictation.engine` best, or automatic on a machine with a GPU);
 * - permissions for what was chosen: the microphone, system audio for calls and Accessibility for
 *   dictation, each with its state and one button to its privacy pane;
 * - the assistant, as the Settings page offers it (the page's own rows, drawn here).
 *
 * Every step writes through the APIs the pages use: `PATCH /config`, `POST /workspaces`,
 * `POST /models/pull`. Finish turns dictation on when it was chosen and lands on Calls or on the
 * Dictation page. The setup runs by itself on a first run, while the speech models are missing and
 * it was never finished; "Run the setup again" on the Settings and Dictation pages opens it with
 * what is set now. With the models missing after the setup, the welcome is the models step alone.
 */

import { dictationHotkeyDefault, hotkeyFor } from "../main/window/hotkey.ts";
import { firstLanguages, LanguageList } from "./dictation-languages.ts";
import { KeyRecorder } from "./dictation-recorder.ts";
import { byId, h, replace, toast } from "./dom.ts";
import type { ModelsCard } from "./models-card.ts";
import { type ModelRow, QWEN_ID, sizeText } from "./models-rows.ts";
import { message } from "./notepad.ts";
import type { SettingsPane, Transport } from "./protocol.ts";
import { button, choiceRow, field, icon, row, section, segmented } from "./rows.ts";
import { inWords, wordsFor } from "./settings-labels.ts";
import { folderName, SettingsPage } from "./settings-page.ts";
import type { WorkspacePicker } from "./workspaces.ts";

export type Use = "calls" | "dictation" | "both";
export type Step = "use" | "calls" | "dictation" | "models" | "permissions" | "assistant";

/** Where the setup keeps whether it was finished and the use chosen, between runs. */
export const SETUP_KEY = "akou.setup";

/** The first workspace a new user is offered. */
export const FIRST_WORKSPACE = "Personal";

/** The steps a use needs, in order. */
export function stepsFor(use: Use): Step[] {
  const out: Step[] = ["use"];
  if (use !== "dictation") out.push("calls");
  if (use !== "calls") out.push("dictation");
  out.push("models", "permissions", "assistant");
  return out;
}

/** Steps whose defaults stand when they are skipped. The use and the models are not. */
const OPTIONAL: ReadonlySet<Step> = new Set(["calls", "dictation", "permissions", "assistant"]);

const TITLES: Record<Step, [title: string, lede: string]> = {
  use: ["Welcome to akou", "What will you use akou for? The next steps set up only that."],
  calls: ["Where calls go", "Each call is a folder with its audio and transcript, in a workspace."],
  dictation: ["Dictation", "Hold a key, speak, and the words go where your cursor is."],
  models: ["Speech models", "akou turns speech into text with these, on this computer."],
  permissions: [
    "Permissions",
    "Your system asks for each the first time akou needs it. You can allow them now.",
  ],
  assistant: [
    "Your assistant",
    "Ask uses it, and dictation can tidy its text with it. Recording and transcripts work without it.",
  ],
};

const USES: readonly [Use, string, string][] = [
  [
    "calls",
    "Calls",
    "Record calls and meetings: a live transcript of who said what, and your notes.",
  ],
  ["dictation", "Dictation", "Hold a key, speak, and the words go where your cursor is."],
  ["both", "Both", "Calls and dictation."],
];

interface Saved {
  done: boolean;
  use: Use;
}

export function readSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(SETUP_KEY) ?? "{}") as Partial<Saved>;
    const use = s.use === "calls" || s.use === "dictation" ? s.use : "both";
    return { done: s.done === true, use };
  } catch {
    return { done: false, use: "both" };
  }
}

function writeSaved(s: Saved): void {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s));
  } catch {
    // A page without storage asks again on its next first run.
  }
}

type Grants = { mic?: string; accessibility?: string } | null;

/** What the steps read once they open. */
interface Values {
  platform: string;
  settings: Record<string, unknown>;
  schema: Record<string, unknown>;
  /** Qwen's llama-server runs on a GPU here: Automatic dictation picks Best once it is downloaded. */
  gpu: boolean;
  grants: Grants;
}

export interface SetupDeps {
  t: Transport;
  card: ModelsCard;
  workspace: WorkspacePicker;
  /** The speech models' state from the status push; undefined from an older app. */
  modelsState(): string | undefined;
  /** What the setup shows changed: the window draws again. */
  changed(): void;
  /** The setup ended with Finish: the window goes to Calls or to the Dictation page. */
  finish(use: Use): void;
}

/** A grant as the step says it. */
function grantText(g: string | undefined, when: string): { text: string; ok: boolean } {
  if (g === "granted" || g === "not-needed") return { text: "Allowed", ok: true };
  if (g === "denied") return { text: "Not allowed", ok: false };
  return { text: `Asked the first time ${when}`, ok: false };
}

export class SetupWizard {
  /** The setup is open: on a first run, or asked for again. */
  running = false;
  private first = false;
  private started = false;
  private step: Step = "use";
  private use: Use = "both";
  private values: Values | null = null;
  private drawn = "";
  private busy = false;
  private recorder: KeyRecorder | null = null;
  private assistant: SettingsPage | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The step's controls that Continue reads. */
  private read: () => Record<string, unknown> = () => ({});
  private workspaceField: HTMLInputElement | null = null;
  private folderField: HTMLInputElement | null = null;
  private best: ModelRow | null = null;
  private finishing = false;

  constructor(private readonly d: SetupDeps) {
    byId("setup-next").addEventListener("click", () => void this.next());
    byId("setup-back").addEventListener("click", () => this.back());
    byId("setup-skip").addEventListener("click", () => this.go(1));
    // The one download fetches Qwen too when dictation runs on Best.
    byId("models-pull").addEventListener("click", () => void this.pullBest());
  }

  /** On a first run with the models missing, the setup opens by itself, once. */
  wanted(missing: boolean): boolean {
    if (!this.running && !this.started && missing && !readSaved().done) {
      this.started = true;
      void this.start("use", true);
    }
    return this.running;
  }

  /** Opens the setup on `at`, with what is set now. */
  async start(at: Step = "use", first = false): Promise<void> {
    this.started = true;
    this.running = true;
    this.first = first;
    this.use = readSaved().use;
    this.step = at;
    this.values = null;
    this.drawn = "";
    // The window draws on its next turn: this may run while it draws.
    queueMicrotask(() => this.d.changed());
    this.values = await this.load();
    this.drawn = "";
    this.d.changed();
  }

  /** Closes the setup where it is: a new live call takes the window over. */
  cancel(): void {
    if (!this.running) return;
    this.leaveStep();
    this.running = false;
    this.drawn = "";
    this.d.changed();
  }

  /** The readiness row's Set up: the models step, in the setup or alone. */
  toModels(): void {
    if (!this.running || !stepsFor(this.use).includes("models")) return;
    this.leaveStep();
    this.step = "models";
    this.drawn = "";
  }

  /**
   * Draws the welcome: `on` is whether it shows. While the setup runs it is the step on screen;
   * otherwise the speech models step alone.
   */
  paint(on: boolean): void {
    if (!on) {
      if (this.drawn !== "") this.leaveStep();
      this.drawn = "";
      return;
    }
    const key = this.running ? `${this.step}:${this.use}:${this.values ? 1 : 0}` : "models-only";
    if (key === this.drawn) {
      if (this.running) this.nextState();
      return;
    }
    this.leaveStep();
    this.drawn = key;
    this.draw();
  }

  private async load(): Promise<Values> {
    const t = this.d.t;
    const safe = async <T>(path: string): Promise<T | null> => {
      try {
        const r = await t.request<T>("GET", path);
        return r.status < 400 ? r.body : null;
      } catch {
        return null;
      }
    };
    type Config = { settings?: Record<string, unknown>; schema?: Record<string, unknown> };
    const [cfg, status, server, dictation] = await Promise.all([
      safe<Config>("/config"),
      safe<{ app?: { platform?: string } }>("/status"),
      safe<{ gpu?: unknown }>("/server"),
      safe<{ grants?: Grants }>("/dictation"),
    ]);
    return {
      platform: String(status?.app?.platform ?? ""),
      settings: { ...(cfg?.settings ?? {}) },
      schema: cfg?.schema ?? {},
      gpu: server?.gpu != null,
      grants: dictation?.grants ?? null,
    };
  }

  private get here(): string {
    return this.values?.platform === "darwin" ? "this Mac" : "this computer";
  }

  private setting(key: string): unknown {
    return this.values?.settings[key];
  }

  // -------------------------------------------------------------------------
  // Drawing

  private draw(): void {
    const body = byId("setup-step");
    const models = byId("welcome-models");
    const bar = byId("setup-bar");
    this.say(null);
    if (!this.running) {
      byId("welcome-title").textContent = "Speech models";
      byId("setup-lede").textContent =
        "Record needs them. They download while you do anything else.";
      replace(body);
      byId("setup-best").hidden = true;
      models.hidden = false;
      bar.hidden = true;
      this.d.card.shown();
      return;
    }
    const [title, lede] = TITLES[this.step];
    byId("welcome-title").textContent = title;
    byId("setup-lede").textContent = lede
      .replace("this computer", this.here)
      .replace("Your system", this.values?.platform === "darwin" ? "macOS" : "Your system");
    models.hidden = this.step !== "models";
    byId("setup-best").hidden = true;
    bar.hidden = false;
    const steps = stepsFor(this.use);
    const at = steps.indexOf(this.step);
    byId("setup-count").textContent = `Step ${at + 1} of ${steps.length}`;
    const back = byId<HTMLButtonElement>("setup-back");
    back.hidden = at === 0 && this.first;
    back.textContent = at === 0 ? "Cancel" : "Back";
    byId("setup-skip").hidden = !OPTIONAL.has(this.step);
    const next = byId<HTMLButtonElement>("setup-next");
    next.textContent = at === steps.length - 1 ? "Finish" : "Continue";
    // One accent per screen: on the models step it is the download's.
    next.className = this.step === "models" ? "go plain" : "go";
    this.read = () => ({});
    if (!this.values && this.step !== "use") {
      replace(body, h("p", { class: "setup-reading" }, "Reading what is set…"));
      next.disabled = true;
      return;
    }
    replace(body, ...this.stepBody());
    this.nextState();
    (
      body.querySelector<HTMLElement>("input:checked") ??
      body.querySelector<HTMLElement>("input:not([type=hidden]):not([hidden]), select, button")
    )?.focus();
  }

  /** Continue waits on the models step until the download runs or is done. */
  private nextState(): void {
    const next = byId<HTMLButtonElement>("setup-next");
    if (this.busy) {
      next.disabled = true;
      return;
    }
    const state = this.d.modelsState();
    next.disabled =
      (!this.values && this.step !== "use") ||
      (this.step === "models" &&
        state !== undefined &&
        state !== "downloading" &&
        state !== "ready");
    next.title =
      this.step === "models" && next.disabled
        ? "Start the download first: it goes on as you continue."
        : "";
  }

  private stepBody(): HTMLElement[] {
    switch (this.step) {
      case "use":
        return [this.useBody()];
      case "calls":
        return [this.callsBody()];
      case "dictation":
        return [this.dictationBody()];
      case "models":
        this.d.card.shown();
        void this.bestRow();
        return [];
      case "permissions":
        return [this.permissionsBody()];
      case "assistant":
        return [this.assistantBody()];
    }
  }

  private useBody(): HTMLElement {
    const rows = USES.map(([value, label, help]) => {
      const c = choiceRow({ name: "setup-use", value, label, help, checked: value === this.use });
      c.dataset.use = value;
      c.querySelector("input")?.addEventListener("change", () => {
        this.use = value;
        // The step count follows the use at once.
        byId("setup-count").textContent = `Step 1 of ${stepsFor(value).length}`;
      });
      return c;
    });
    return section("", ...rows);
  }

  private callsBody(): HTMLElement {
    const root = String(this.setting("recordings.root") ?? "");
    const f = folderName(root);
    const shown = h(
      "span",
      { id: "setup-folder", class: "pg-value", attrs: { title: root } },
      f.parent ? `${f.name} in ${f.parent}` : f.name,
    );
    const typed = field({
      id: "setup-folder-path",
      label: "Folder",
      value: root,
      placeholder: "The folder's full path",
    });
    typed.classList.add("wide");
    typed.hidden = true;
    const change = button("Change", () => {
      shown.hidden = true;
      change.hidden = true;
      typed.hidden = false;
      typed.focus();
      typed.select();
    });
    change.id = "setup-folder-change";
    typed.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      typed.value = root;
      typed.hidden = true;
      shown.hidden = false;
      change.hidden = false;
      change.focus();
    });
    this.folderField = typed;
    const now = this.d.workspace.value();
    const name = field({
      id: "setup-workspace",
      label: "First workspace",
      value: readSaved().done && now !== "default" ? now : FIRST_WORKSPACE,
    });
    name.maxLength = 64;
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        void this.next();
      }
    });
    this.workspaceField = name;
    return section(
      "",
      row(
        { label: "Folder", help: "Each workspace is a folder in it.", for: "setup-folder-change" },
        shown,
        change,
        typed,
      ),
      row(
        {
          label: "First workspace",
          help: "New calls go in it. Add others from the Record row or the sidebar.",
          for: "setup-workspace",
        },
        name,
      ),
    );
  }

  private dictationBody(): HTMLElement {
    const platform = this.values?.platform ?? "";
    const mac = platform === "darwin";
    const saved = String(this.setting("dictation.hotkey") ?? "");
    const input = h("input", { id: "setup-hotkey", type: "text", hidden: true });
    input.value = saved;
    input.dataset.key = "dictation.hotkey";
    const recorder = new KeyRecorder("dictation.hotkey", input, this.d.t, {
      platform,
      button: "Change",
      fallback: dictationHotkeyDefault(platform),
      label: "dictation key",
      fnButton: true,
      chordsOnly: () =>
        mac && this.values?.grants?.accessibility === "denied"
          ? "Without Accessibility access the key must be a combination, such as Control+Shift+Space."
          : null,
      others: () => [
        ["the record shortcut", hotkeyFor(String(this.setting("app.hotkey") ?? ""), platform)],
      ],
    });
    this.recorder = recorder;
    const rows: HTMLElement[] = [
      row(
        { label: wordsFor("dictation.hotkey").label, help: wordsFor("dictation.activation").help },
        recorder.root,
        input,
      ),
    ];
    const engine = String(this.setting("dictation.engine") ?? "auto");
    let seg: { root: HTMLElement; input: HTMLInputElement } | null = null;
    // Dictation that goes to another computer keeps its engine: the Dictation page sets that.
    if (engine !== "remote") {
      const w = wordsFor("dictation.engine");
      seg = segmented({
        id: "setup-engine",
        label: w.label,
        options: (w.choices ?? []).filter(([v]) => v !== "remote"),
        value: engine,
      });
      rows.push(
        row(
          {
            label: w.label,
            help: `Fast is instant. Best makes fewer mistakes. Automatic picks ${this.values?.gpu ? "Best" : "Fast"} on ${this.here}.`,
          },
          seg.root,
        ),
      );
    }
    const asr = this.setting("asr.languages");
    const own = this.setting("dictation.languages");
    const list = new LanguageList(
      firstLanguages(
        Array.isArray(own) ? (own as string[]) : [],
        Array.isArray(asr) ? (asr as string[]) : [],
        navigator.language,
      ),
      () => {},
      "setup-languages",
      wordsFor("dictation.languages").empty,
    );
    rows.push(
      row(
        {
          label: wordsFor("dictation.languages").label,
          help: "Automatic chooses among these as you speak.",
        },
        h("div", { class: "pg-chips" }, list.root),
      ),
    );
    this.read = () => {
      const out: Record<string, unknown> = {};
      if (input.value !== saved) out["dictation.hotkey"] = input.value;
      if (seg && seg.input.value !== engine) out["dictation.engine"] = seg.input.value;
      const langs = list.value();
      if (JSON.stringify(langs) !== JSON.stringify(own ?? [])) out["dictation.languages"] = langs;
      return out;
    };
    return section("", ...rows);
  }

  private permissionsBody(): HTMLElement {
    const box = h("div", {});
    const draw = () => {
      const v = this.values;
      const mac = v?.platform === "darwin";
      const g = v?.grants;
      const rows: HTMLElement[] = [];
      const one = (
        id: string,
        label: string,
        pane: SettingsPane,
        state: { text: string; ok: boolean },
        help: string,
      ) => {
        const open = button(mac ? "Open System Settings" : "Open Settings", () => {
          void this.d.t.openSettingsPane(pane).then((ok) => {
            if (!ok)
              toast("Open the privacy settings yourself: this window cannot open them here.");
          });
        });
        open.hidden = state.ok;
        const r = row(
          { label, help, id: `setup-grant-${id}` },
          h("span", { class: `pg-value setup-state${state.ok ? " ok" : ""}` }, state.text),
          open,
        );
        rows.push(r);
      };
      one(
        "mic",
        "Microphone",
        "microphone",
        grantText(g?.mic, this.use === "dictation" ? "you dictate" : "you record"),
        "Your voice, for calls and dictation.",
      );
      if (mac && this.use !== "dictation")
        one(
          "system-audio",
          "System audio",
          "system-audio",
          grantText(undefined, "you record a call"),
          "The other people on a call.",
        );
      if (mac && this.use !== "calls")
        one(
          "accessibility",
          "Accessibility",
          "accessibility",
          grantText(g?.accessibility, "you dictate"),
          "Lets the dictation key work in any app and paste the words.",
        );
      replace(box, section("", ...rows));
    };
    draw();
    // A grant given in System Settings shows here without a click.
    this.timer = setInterval(async () => {
      try {
        const r = await this.d.t.request<{ grants?: Grants }>("GET", "/dictation");
        if (r.status < 400 && this.values && box.isConnected) {
          const before = JSON.stringify(this.values.grants);
          this.values.grants = r.body.grants ?? null;
          if (JSON.stringify(this.values.grants) !== before) draw();
        }
      } catch {
        // The next tick asks again.
      }
    }, 1000);
    return box;
  }

  private assistantBody(): HTMLElement {
    this.assistant ??= new SettingsPage(this.d.t, {
      only: {
        id: "setup-assistant",
        layout: [{ title: "", items: ["provider.kind", "#assistant-use"] }],
      },
    });
    void this.assistant.show();
    return this.assistant.root;
  }

  /** The Best dictation row: Qwen3-ASR, when the use and the engine need it. */
  private async bestRow(): Promise<void> {
    const list = byId("setup-best");
    const engine = String(this.setting("dictation.engine") ?? "auto");
    const wants =
      this.use !== "calls" &&
      (engine === "best" || (engine === "auto" && this.values?.gpu === true));
    this.best = null;
    if (!wants) return;
    let rows: ModelRow[] = [];
    try {
      const r = await this.d.t.request<{ models?: ModelRow[] }>("GET", "/models");
      rows = r.status < 400 ? (r.body.models ?? []) : [];
    } catch {}
    const best = rows.find((m) => m.id === QWEN_ID) ?? null;
    if (!best || this.step !== "models" || !this.running) return;
    this.best = best;
    const done = best.state === "ready";
    const size =
      best.state === "downloading"
        ? `${sizeText(best.bytes)} of ${sizeText(best.size)}`
        : done
          ? "Downloaded"
          : sizeText(best.size);
    // With the speech models there already, the one download is this row's.
    const own = !done && best.state !== "downloading" && this.d.modelsState() === "ready";
    const get = own
      ? h("button", { type: "button", class: "go", id: "setup-best-pull" }, "Download")
      : null;
    get?.addEventListener("click", () => void this.pullBest());
    replace(
      list,
      h(
        "li",
        { attrs: { "data-id": best.id } },
        h("span", { class: "glyph" }, icon("M2 8v0M5 5.5v5M8 3v10M11 6v4M14 7.5v1")),
        h(
          "span",
          { class: "t" },
          h("b", {}, "Best dictation"),
          h("span", {}, "Qwen3-ASR 1.7B, fewer mistakes"),
        ),
        h("span", { class: "sz" }, size),
        get,
      ),
    );
    list.hidden = false;
    if (best.state === "downloading" && !this.timer) {
      this.timer = setInterval(() => {
        if (this.step === "models" && this.running) void this.bestRow();
      }, 1000);
    } else if (best.state !== "downloading" && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pullBest(): Promise<void> {
    if (this.best?.state !== "missing") return;
    try {
      const r = await this.d.t.request("POST", "/models/pull", { model: this.best.id });
      if (r.status >= 400)
        toast(`Qwen3-ASR could not start downloading: ${message(r.body, `HTTP ${r.status}`)}`);
    } catch (err) {
      toast(`Qwen3-ASR could not start downloading: ${(err as Error).message}`);
    }
    await this.bestRow();
  }

  // -------------------------------------------------------------------------
  // Moving

  /** What the step on screen started stops: its recorder, its reads, the assistant's typing. */
  private leaveStep(): void {
    this.recorder?.stop();
    this.recorder = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.step === "assistant") this.assistant?.leave();
  }

  private go(by: number): void {
    const steps = stepsFor(this.use);
    const at = steps.indexOf(this.step) + by;
    if (at >= steps.length) {
      void this.finish();
      return;
    }
    this.leaveStep();
    this.step = steps[Math.max(0, at)] as Step;
    this.drawn = "";
    this.d.changed();
  }

  private back(): void {
    if (this.step === "use") {
      this.cancel();
      return;
    }
    this.go(-1);
  }

  private say(why: string | null): void {
    const el = byId("setup-issue");
    el.textContent = why ?? "";
    el.hidden = !why;
  }

  private async patch(body: Record<string, unknown>): Promise<string | null> {
    if (Object.keys(body).length === 0) return null;
    try {
      const r = await this.d.t.request("PATCH", "/config", body);
      if (r.status >= 400)
        return inWords(message(r.body, `not saved (${r.status})`), Object.keys(body));
    } catch (err) {
      return `not saved: ${(err as Error).message}`;
    }
    if (this.values) Object.assign(this.values.settings, body);
    return null;
  }

  /** Saves the step on screen, then the next one. */
  private async next(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.nextState();
    let why: string | null = null;
    try {
      why = await this.save();
    } finally {
      this.busy = false;
    }
    this.nextState();
    if (why) {
      this.say(why);
      return;
    }
    if (this.step === "use") writeSaved({ ...readSaved(), use: this.use });
    this.go(1);
  }

  private async save(): Promise<string | null> {
    if (this.step === "calls") {
      const root = this.folderField?.value.trim() ?? "";
      if (root !== "" && root !== String(this.setting("recordings.root") ?? "")) {
        const why = await this.patch({ "recordings.root": root });
        if (why) return why;
      }
      const name = this.workspaceField?.value.trim() ?? "";
      if (name !== "") return this.d.workspace.choose(name);
      return null;
    }
    return this.patch(this.read());
  }

  private async finish(): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    try {
      await this.end();
    } finally {
      this.finishing = false;
    }
  }

  private async end(): Promise<void> {
    if (this.use !== "calls" && this.setting("dictation.enabled") !== true) {
      const why =
        "dictation.enabled" in (this.values?.schema ?? {})
          ? await this.patch({ "dictation.enabled": true })
          : null;
      if (why) {
        this.say(why);
        return;
      }
    }
    writeSaved({ done: true, use: this.use });
    this.leaveStep();
    this.running = false;
    this.drawn = "";
    this.d.finish(this.use);
  }
}
