/**
 * The Jobs page of server mode (docs/ux/SERVER.md SV-U4), the page the server opens on: queued and
 * running jobs with their elapsed time, done and failed ones with their error, filtered by key and
 * state; open one to read its fields and its transcript; cancel or delete one.
 *
 * It reads `GET /v1/jobs` twice a second while it is shown, so a job submitted from outside shows
 * within a second. The event feed (SV-E1) carries outcomes only, not a job starting, so it cannot
 * say "running". Rows are updated in place, so a button half-way through its two presses survives
 * the next read.
 */

import { byId, h, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";
import { type ServerScreen, section, took, twoStep, when } from "./server-common.ts";

const POLL_MS = 500;
/** The column of the elapsed time, the one cell that changes while a job runs. */
const TOOK = 7;
const STATES = ["queued", "running", "done", "failed", "cancelled"] as const;

interface JobView {
  id: string;
  status: (typeof STATES)[number];
  key_id?: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  preset: string;
  language: string;
  diarize: boolean;
  metadata: unknown;
  error?: { code?: string; message?: string } | string;
  model?: string;
  model_source?: string;
  waiting_for?: { model: string; bytes: number; total: number };
}

interface KeyInfo {
  id: string;
  name: string;
}

function errorText(e: JobView["error"]): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  return [e.code, e.message].filter(Boolean).join(": ");
}

export class JobsPage implements ServerScreen {
  readonly name = "jobs" as const;
  readonly title = "Jobs";
  readonly root: HTMLElement;
  private readonly status = h(
    "select",
    { id: "jobs-status", attrs: { "aria-label": "State" } },
    h("option", { value: "" }, "every state"),
    ...STATES.map((s) => h("option", { value: s }, s)),
  );
  private readonly key = h(
    "select",
    { id: "jobs-key", attrs: { "aria-label": "Key" } },
    h("option", { value: "" }, "every key"),
  );
  private readonly body = h("tbody");
  private readonly count = h("span", { class: "hint", attrs: { role: "status" } });
  private readonly detail = h("section", { id: "job-detail", hidden: true });
  private readonly armed = new Map<string, number>();
  private names = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private selected: { id: string; status: string } | null = null;

  constructor(private readonly t: Transport) {
    this.root = section(
      "Jobs",
      h("div", { class: "bar" }, this.status, this.key, this.count),
      h(
        "table",
        { id: "jobs-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            ...[
              "Job",
              "Key",
              "State",
              "Model",
              "Language",
              "Speakers",
              "Submitted",
              "Took",
              "Error",
              "",
            ].map((c) => h("th", {}, c)),
          ),
        ),
        this.body,
      ),
      this.detail,
    );
    this.status.addEventListener("change", () => void this.read());
    this.key.addEventListener("change", () => void this.read());
  }

  show(): void {
    void this.readKeys();
    void this.read();
    this.timer ??= setInterval(() => void this.read(), POLL_MS);
  }

  hide(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async readKeys(): Promise<void> {
    const r = await this.t.request<{ keys: KeyInfo[] }>("GET", "/keys");
    if (r.status !== 200) return;
    this.names = new Map(r.body.keys.map((k) => [k.id, k.name]));
    const chosen = this.key.value;
    replace(
      this.key,
      h("option", { value: "" }, "every key"),
      ...r.body.keys.map((k) => h("option", { value: k.id }, k.name)),
    );
    this.key.value = this.names.has(chosen) ? chosen : "";
  }

  /** One read of the list; a tick is skipped while the last is unanswered. */
  private async read(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const q = new URLSearchParams({ limit: "100" });
      if (this.status.value) q.set("status", this.status.value);
      if (this.key.value) q.set("key", this.key.value);
      const r = await this.t.request<{ jobs: JobView[] }>("GET", `/jobs?${q}`);
      if (r.status !== 200) {
        this.count.textContent = message(r.body, `the jobs could not be read (HTTP ${r.status})`);
        return;
      }
      this.draw(r.body.jobs);
    } catch {
      // The next tick asks again.
    } finally {
      this.inFlight = false;
    }
  }

  private draw(jobs: JobView[]): void {
    const seen = new Set<string>();
    let at: Element | null = this.body.firstElementChild;
    for (const j of jobs) {
      seen.add(j.id);
      let tr = this.body.querySelector<HTMLTableRowElement>(`tr[data-id="${CSS.escape(j.id)}"]`);
      const cells = this.cells(j);
      // A running job's elapsed time changes every read and is written in place; the row is
      // drawn again only when the job, or its button's state, changes.
      const stamp = JSON.stringify([cells.filter((_, i) => i !== TOOK), this.armed.has(j.id)]);
      if (!tr) {
        tr = h("tr", { attrs: { "data-id": j.id } });
        tr.dataset.stamp = "";
      }
      if (tr.dataset.stamp !== stamp) {
        replace(tr, ...cells.map((c) => h("td", {}, c)), h("td", {}, ...this.actions(j)));
        tr.dataset.stamp = stamp;
      } else {
        const td = tr.children[TOOK];
        if (td && td.textContent !== cells[TOOK]) td.textContent = cells[TOOK] ?? "";
      }
      tr.dataset.status = j.status;
      if (tr !== at) this.body.insertBefore(tr, at);
      at = tr.nextElementSibling;
    }
    for (const tr of [...this.body.querySelectorAll<HTMLElement>("tr")]) {
      if (!seen.has(tr.dataset.id as string)) tr.remove();
    }
    this.count.textContent = jobs.length === 1 ? "1 job" : `${jobs.length} jobs`;
    const sel = this.selected;
    if (sel) {
      const now = jobs.find((j) => j.id === sel.id);
      if (now && now.status !== sel.status) void this.open(now.id);
    }
  }

  private cells(j: JobView): string[] {
    const started = j.started_at ? Date.parse(j.started_at) : null;
    const ended = j.finished_at ? Date.parse(j.finished_at) : null;
    const elapsed =
      started === null
        ? ""
        : j.status === "running"
          ? took(Date.now() - started)
          : took((ended ?? started) - started);
    const waiting = j.waiting_for
      ? ` (downloading ${j.waiting_for.model}: ${j.waiting_for.total > 0 ? Math.floor((100 * j.waiting_for.bytes) / j.waiting_for.total) : 0} %)`
      : "";
    const key = j.key_id ? (this.names.get(j.key_id) ?? j.key_id) : "";
    const model = j.model ? `${j.model}${j.model_source ? ` (${j.model_source})` : ""}` : j.preset;
    return [
      j.id,
      key,
      `${j.status}${waiting}`,
      model,
      j.language,
      j.diarize ? "labelled" : "no",
      when(j.created_at),
      elapsed,
      errorText(j.error),
    ];
  }

  private actions(j: JobView): HTMLElement[] {
    const open = h("button", { class: "open", type: "button" }, "Open");
    open.addEventListener("click", () => void this.open(j.id));
    const live = j.status === "queued" || j.status === "running";
    const cancel = twoStep(
      {
        class: "cancel",
        label: live ? "Cancel" : "Delete",
        confirm: live ? "Confirm cancel" : "Confirm delete",
        id: j.id,
        armed: this.armed,
      },
      () => void this.remove(j.id),
    );
    return [open, cancel];
  }

  private async remove(id: string): Promise<void> {
    const r = await this.t.request("DELETE", `/jobs/${encodeURIComponent(id)}`);
    if (r.status >= 400) toast(message(r.body, `the job could not be deleted (HTTP ${r.status})`));
    if (this.selected?.id === id) {
      this.selected = null;
      this.detail.hidden = true;
    }
    await this.read();
  }

  /** The job's fields, and its transcript once it is done. */
  private async open(id: string): Promise<void> {
    const r = await this.t.request<JobView>("GET", `/jobs/${encodeURIComponent(id)}`);
    if (r.status !== 200) {
      toast(message(r.body, `the job could not be read (HTTP ${r.status})`));
      return;
    }
    const j = r.body;
    this.selected = { id: j.id, status: j.status };
    let transcript: HTMLElement | null = null;
    if (j.status === "done") {
      const res = await this.t.request<{ text?: string; engine?: { models?: string[] } }>(
        "GET",
        `/jobs/${encodeURIComponent(id)}/result`,
      );
      if (res.status === 200) {
        transcript = h(
          "div",
          {},
          h("h3", {}, "Transcript"),
          h("p", { id: "job-text" }, res.body.text ?? ""),
          h("p", { class: "hint" }, `Engines: ${(res.body.engine?.models ?? []).join(", ")}`),
        );
      }
    }
    replace(
      this.detail,
      h(
        "div",
        { class: "bar" },
        h("h3", {}, `Job ${j.id}`),
        h(
          "button",
          {
            type: "button",
            on: {
              click: () => {
                this.selected = null;
                this.detail.hidden = true;
              },
            },
          },
          "Close",
        ),
      ),
      h("pre", {}, JSON.stringify(j, null, 2)),
      transcript,
    );
    this.detail.hidden = false;
    byId("job-detail").scrollIntoView({ block: "nearest" });
  }
}
