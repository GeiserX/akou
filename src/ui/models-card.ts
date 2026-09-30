/**
 * The welcome (docs/ux/WINDOW.md section 10, docs/ux/design-explorations/README.md): while the
 * speech models are missing, downloading or failed, it replaces the transcript, the side pane and
 * the player, and the sidebar with the calls stays. This card is its speech models step, in the
 * first-run setup (`setup-wizard.ts`) and alone once the setup is done: the rows, the one download
 * (`POST /models/pull`) and its progress. Recording is refused until the models are there
 * (`503 models_missing`), so Record waits with its reason. Once they are there the card says so,
 * and the welcome goes by itself unless the setup is still on screen.
 *
 * Progress arrives on the status push (DESKTOP.md DK-E2). A one-second `GET /models` poll is only
 * the fallback, for a download whose push has gone quiet: an older app that sends no progress, or a
 * reply to the pull that the push never followed.
 */

import { byId, h, replace, toast } from "./dom.ts";
import type { ModelRow } from "./models-rows.ts";
import { modelsCardText, welcomeRows } from "./models-text.ts";
import type { ModelsInfo, Reply, Transport } from "./protocol.ts";

/** Each row's glyph by kind, drawn as SVG paths: a waveform, two people, a pulse. */
const GLYPH: Record<ModelRow["kind"], string[]> = {
  speech: ["M2 8v0M5 5.5v5M8 3v10M11 6v4M14 7.5v1"],
  speakers: [
    "M3.5 5.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0",
    "M1.5 13.5c.5-2.5 2.3-3.8 4.5-3.8s4 1.3 4.5 3.8",
    "M11 3.2a2.5 2.5 0 0 1 0 4.6M12.5 9.9c1 .6 1.7 1.8 2 3.6",
  ],
  helper: ["M2 8h2.5l1.5-3.5 3 7 1.5-3.5H14"],
};
const SVG = "http://www.w3.org/2000/svg";

function glyph(kind: ModelRow["kind"]): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "ico");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of GLYPH[kind]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** How long a download's status push may stay quiet before the page asks `GET /models` itself. */
const QUIET_MS = 3000;

export class ModelsCard {
  private polling: ReturnType<typeof setInterval> | null = null;
  /** When the status push last carried the models. */
  private pushedAt = 0;
  private rows: "none" | "reading" | "read" = "none";
  /** The last models drawn, to draw again when `add` changes the total. */
  private last: ModelsInfo | undefined;
  /** Bytes the setup adds to the one download before it starts (Qwen3-ASR for Best dictation). */
  private extra = 0;
  private readonly changed: () => void;
  /** The models are not there yet: the window shows the welcome unless a call is recording. */
  missing = false;

  constructor(
    private readonly t: Transport,
    o: {
      /** The models changed state: the window redraws what the welcome replaces. */
      changed: () => void;
    },
  ) {
    this.changed = o.changed;
    byId("models-pull").addEventListener("click", () => void this.pull());
  }

  /** The models from the status push (`pushed`), a pull's reply or a poll. */
  update(m: ModelsInfo | undefined, pushed = false): void {
    if (pushed && m) this.pushedAt = Date.now();
    this.last = m;
    const view = modelsCardText(
      m?.state === "missing" && this.extra > 0 ? { ...m, total: m.total + this.extra } : m,
    );
    const was = this.missing;
    this.missing = view !== null;
    if (was !== this.missing) this.changed();
    if (!view) {
      this.stopPolling();
      if (m?.state === "ready") this.ready(m);
      return;
    }
    if (this.rows === "none") void this.readRows();
    byId("models-size").textContent = view.size;
    byId("models-where-text").textContent = view.where;
    byId("models-where").title = m?.dir ?? "";
    const text = byId("models-text");
    text.textContent = view.text;
    text.classList.toggle("failed", view.failed);
    const button = byId<HTMLButtonElement>("models-pull");
    button.hidden = view.button === null;
    byId("models-pull-label").textContent = view.button ?? "";
    const bar = byId<HTMLProgressElement>("models-progress");
    bar.hidden = view.progress === null;
    bar.value = view.progress ?? 0;
    if (m?.state === "downloading") this.startPolling();
    else this.stopPolling();
  }

  /**
   * The models are there: the rows stay, with no button or bar, as the setup shows them when it is
   * run again. The size and where they live read as they did before the download.
   */
  private ready(m: ModelsInfo): void {
    const view = modelsCardText({ ...m, state: "missing" });
    byId("models-size").textContent = view?.size ?? "";
    byId("models-where-text").textContent = view?.where ?? "";
    byId("models-where").title = m.dir;
    const text = byId("models-text");
    text.textContent = "Downloaded, ready to use.";
    text.classList.remove("failed");
    byId("models-pull").hidden = true;
    byId("models-progress").hidden = true;
  }

  /** The setup's one download fetches `bytes` more than the speech set: its total says so. */
  add(bytes: number): void {
    if (bytes === this.extra) return;
    this.extra = bytes;
    if (this.last) this.update(this.last);
  }

  /** The step is on screen: its rows are read, if no update read them yet. */
  shown(): void {
    if (this.rows === "none") void this.readRows();
  }

  /** The rows of the models the download fetches; asked again on the next update if it failed. */
  private async readRows(): Promise<void> {
    this.rows = "reading";
    let rows: ModelRow[] = [];
    try {
      const r = await this.t.request<ModelsInfo & { models?: ModelRow[] }>("GET", "/models");
      if (r.status === 200) rows = r.body.models ?? [];
    } catch {}
    const view = welcomeRows(rows);
    this.rows = view.length > 0 ? "read" : "none";
    replace(
      byId("models-rows"),
      ...view.map((r) =>
        h(
          "li",
          { attrs: { "data-id": r.id } },
          h("span", { class: "glyph" }, glyph(r.kind)),
          h("span", { class: "t" }, h("b", {}, r.title), h("span", {}, r.role)),
          h("span", { class: "sz" }, r.size),
        ),
      ),
    );
    byId("models-rows").hidden = view.length === 0;
  }

  private async pull(): Promise<void> {
    let r: Reply<ModelsInfo & { message?: string }>;
    try {
      r = await this.t.request("POST", "/models/pull");
    } catch (err) {
      toast(`The download could not start: ${(err as Error).message}`);
      return;
    }
    if (r.status >= 400) {
      toast(r.body.message ?? "The download could not start");
      return;
    }
    this.update(r.body);
  }

  /**
   * The fallback: a tick a second that asks only when the push has been quiet for `QUIET_MS`. A
   * tick is skipped while the last is unanswered, and a failed one is dropped.
   */
  private startPolling(): void {
    let inFlight = false;
    this.polling ??= setInterval(async () => {
      if (inFlight || Date.now() - this.pushedAt < QUIET_MS) return;
      inFlight = true;
      try {
        const r = await this.t.request<ModelsInfo>("GET", "/models");
        if (r.status === 200) this.update(r.body);
      } catch {
        // The next tick asks again.
      } finally {
        inFlight = false;
      }
    }, 1000);
  }

  private stopPolling(): void {
    if (this.polling) clearInterval(this.polling);
    this.polling = null;
  }
}
