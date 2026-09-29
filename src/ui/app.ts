/**
 * The window (docs/DESIGN.md section 7): one page, plain TypeScript and DOM, no framework. It keeps
 * everything hark-viewer did and adds the notepad, the ask box, the Enhanced tab, settings and
 * sharing. This module wires the parts and draws the header: the status dot and label, the title,
 * the pills, the controls, the banner, the final-pass note, the level meters, the list of calls,
 * playback, and the speaker and "Fix this word" menus.
 *
 * Updates arrive pushed: the followed call's events (`follow.ts`) and the app's status after every
 * start, stop, pause or share. Nothing is polled; the one timer redraws the clock and the "for N"
 * durations from what the page already holds.
 */

import { formatZone } from "../core/log/clock.ts";
import type { CallView } from "../core/log/fold.ts";
import { AskPane } from "./ask.ts";
import { mountDictationDialog } from "./dictation-page.ts";
import { dictationReview } from "./dictation-review.ts";
import { byId, closable, closeX, h, openModal, replace, toast } from "./dom.ts";
import { EnhancedPane } from "./enhanced.ts";
import { Follower } from "./follow.ts";
import { type LineAction, LineMenu } from "./line-menu.ts";
import { SmoothMeters } from "./meter.ts";
import {
  banner,
  type CallSummary,
  callHeadMeta,
  callMeta,
  finalNote,
  formatDuration,
  groupCalls,
  HueBook,
  hasRecording,
  languages,
  recordKey,
  speakerTotals,
  stateLabel,
  suggestReopen,
  talkTime,
} from "./model.ts";
import { ModelsCard } from "./models-card.ts";
import { ModelsPage } from "./models-page.ts";
import { recordBlocked } from "./models-text.ts";
import { message, NotepadPane } from "./notepad.ts";
import { Player } from "./player.ts";
import type { AppStatus, Levels, QuitQuestion, Reply, Transport } from "./protocol.ts";
import { ReviewPane } from "./review.ts";
import { SettingsPane } from "./settings.ts";
import { TranscriptPane } from "./transcript.ts";

/** A level above this means someone on the call side is audible. */
const HEARD_DBFS = -60;

let current: App | null = null;

export function boot(t: Transport): void {
  current = new App(t);
  void current.start();
}

/** The page cannot work (no session, the app restarted): say so and what to do. */
export function showFatal(msg: string): void {
  const el = document.getElementById("fatal");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  document.body.classList.add("fatal");
}

/** The tray, the hotkey or `akou open CALL` asks for a call. */
export function showCall(call?: string): void {
  if (!current) return;
  const target = call ?? current.status?.live?.call ?? current.status?.last?.call;
  if (target) current.openCall(target, call !== undefined);
}

/**
 * The quit question (DK-M3), asked here because the SDK's message box would block the main
 * process. Cancel has the focus, so Return and Escape both keep the call, as do its × and a click
 * on the backdrop; true only for the confirm button.
 */
export function askQuit(q: Omit<QuitQuestion, "id">): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = h("button", { type: "button", id: "quit-cancel" }, "Cancel");
    const go = h("button", { type: "button", id: "quit-go" }, q.confirm);
    const dialog = h(
      "dialog",
      { id: "quit-question", class: "question", attrs: { "aria-labelledby": "quit-message" } },
      h("div", { class: "dialog-head" }, h("h2", { id: "quit-message" }, q.message), closeX()),
      h("p", {}, q.detail),
      h("div", { class: "bar" }, cancel, go),
    );
    let done = false;
    const finish = (quit: boolean) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(quit);
    };
    cancel.addEventListener("click", () => finish(false));
    go.addEventListener("click", () => finish(true));
    dialog.addEventListener("close", () => finish(false));
    closable(dialog);
    document.body.append(dialog);
    openModal(dialog);
    cancel.focus();
  });
}

/**
 * The Models dialog (DESKTOP.md DK-E2): the Models page of server mode, the same code, over the
 * app's own `/models`. Read when opened, and it stops following when closed.
 */
function wireModelsDialog(t: Transport): void {
  const dialog = byId<HTMLDialogElement>("models");
  const page = new ModelsPage(t, false);
  byId("models-body").append(page.root);
  // A change to the models' settings not saved yet keeps the dialog open on a backdrop click.
  closable(dialog, () => page.unsaved());
  byId("models-open").addEventListener("click", () => {
    openModal(dialog);
    page.show();
  });
  byId("models-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => page.hide());
}

/** The application menu's Settings… opens the settings pane, as its button does. */
export function showSettings(): void {
  document.getElementById("settings-open")?.click();
}

/** ElectroBun's drag regions: its preload moves the window on a mousedown inside one. */
const DRAG = "electrobun-webkit-app-region-drag";
const NO_DRAG = "electrobun-webkit-app-region-no-drag";

/**
 * The macOS window draws no title bar (docs/ux/DESKTOP.md DK-M7): the shell opens it hidden-inset
 * (`titleBarStyle` in `src/main/window/shell.ts`), so the traffic lights float over the sidebar's
 * top and the page leaves them a strip (`body.inset`, `--titlebar` in theme.css). The strip and the
 * top rows under it move the window, and a double-click on them zooms it, as a title bar does; the
 * controls in them stay controls. Windows and Linux keep their native frame, and a browser tab has
 * no window to move.
 */
function titleBar(inset: boolean): void {
  if (document.body.classList.contains("inset") === inset) return;
  document.body.classList.toggle("inset", inset);
  for (const el of document.querySelectorAll("#sidebar .brand, #composer, #ask-row"))
    el.classList.toggle(DRAG, inset);
  for (const el of document.querySelectorAll("#controls > *, #ask-form"))
    el.classList.toggle(NO_DRAG, inset);
}

/** True when the event lands in a drag region and not on a control inside it. */
function onTitleBar(e: Event): boolean {
  const el = e.target instanceof Element ? e.target : null;
  return !!el?.closest(`.${DRAG}`) && !el.closest(`.${NO_DRAG}`);
}

function platform(): "mac" | "windows" | "linux" {
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  return p.includes("mac") ? "mac" : p.includes("win") ? "windows" : "linux";
}

class App {
  status: AppStatus | null = null;
  callId: string | null = null;
  /** The user picked the call on screen; otherwise the window follows the live or last call. */
  private chosen = false;
  /** The last live call the window saw, so each new one takes the window over once. */
  private seenLive: string | null = null;
  private follower: Follower | null = null;
  private hues = new HueBook();
  private disconnectedSince: number | null = null;
  private levelAt: number | null = null;
  /** When the follow of the call on screen first opened, so a call joined late is not "dead". */
  private followedAt: number | null = null;
  private callHeardAt: number | null = null;
  private lastLineAt: number | null = null;
  private readonly platform = platform();
  private readonly transcript: TranscriptPane;
  private readonly notepad: NotepadPane;
  private readonly askPane: AskPane;
  private readonly enhanced: EnhancedPane;
  private readonly review: ReviewPane;
  private readonly modelsCard: ModelsCard;
  private readonly player: Player;
  private readonly levels = new SmoothMeters((ch, db) => {
    byId<HTMLMeterElement>(`meter-${ch}`).value = db;
  });
  private blobs = new Map<string, string>();
  /** A start is on its way: Record waits for the answer. */
  private starting = false;
  /** The calls as `GET /calls` last listed them, and the workspaces the user folded. */
  private calls: CallSummary[] = [];
  private folded = new Set<string>();
  /** What the calls list was last drawn from, so an unchanged list is not redrawn. */
  private drawnCalls = "";
  /** The title is being edited: the header leaves it alone until the edit closes. */
  private renaming = false;
  /** Closes the open title field without saving; null when none is open. */
  private closeTitle: (() => void) | null = null;

  constructor(readonly t: Transport) {
    const view = () => this.view();
    const call = () => this.callId;
    this.transcript = new TranscriptPane({
      view,
      read: (id) => this.follower?.read.get(id),
      hue: (spk) => this.hues.hue(spk),
      play: (id) => void this.play(id),
      speakerMenu: (spk, anchor) => this.speakerMenu(spk, anchor),
      fixWord: (id, anchor, sel) => this.fixWord(id, anchor, sel),
    });
    new LineMenu(byId("lines"), byId("scroller"), () => this.lineActions());
    this.player = new Player({
      view,
      mayPlay: () => this.mayPlay(),
      playing: (id, running) => this.transcript.playing(id, running),
      stopped: () => this.transcript.playing(null, false, false),
    });
    this.notepad = new NotepadPane({
      t,
      call,
      view,
      jumpTo: (w) => {
        const id = this.transcript.lineAt(w);
        if (id) this.cite(id);
      },
    });
    const cite = (id: string) => this.cite(id);
    this.askPane = new AskPane({ t, call, view, cite });
    const dictation = mountDictationDialog(
      t,
      () => this.view()?.call?.workspace,
      () => this.review.open(),
    );
    const settings = new SettingsPane(
      t,
      () => void dictation.open(),
      () => void dictation.dictionary.open(),
    );
    this.modelsCard = new ModelsCard(t, {
      changed: () => this.paint(),
      openAgentSettings: () => void settings.open("provider.kind"),
      mac: this.platform === "mac",
    });
    wireModelsDialog(t);
    this.enhanced = new EnhancedPane({
      t,
      call,
      view,
      cite,
      openSettings: (key) => void settings.open(key),
    });
    this.review = new ReviewPane({
      t,
      call,
      cite,
      more: dictationReview(t),
      ended: () => {
        const v = this.view();
        return !!v?.call && !v.live;
      },
    });
  }

  view(): CallView | null {
    return this.follower?.view ?? null;
  }

  private workspaceInput(): HTMLInputElement {
    return byId<HTMLInputElement>("workspace");
  }

  async start(): Promise<void> {
    document.body.dataset.transport = this.t.kind;
    document.addEventListener("dblclick", (e) => {
      if (onTitleBar(e)) this.t.zoomWindow?.();
    });
    this.wireControls();
    this.wireSidebar();
    byId("title-text").addEventListener("click", () => this.editTitle());
    this.wireTabs();
    this.wirePopover();
    const pinned = new URLSearchParams(location.search).get("call");
    if (pinned) this.openCall(pinned, true);
    this.t.watchStatus((s) => this.onStatus(s));
    void this.enhanced.loadTemplates().then((names) => {
      replace(
        byId("template"),
        h("option", { value: "" }, "Template: automatic"),
        ...names.map((n) => h("option", { value: n }, n)),
      );
    });
    setInterval(() => this.paint(), 1000);
    this.paint();
  }

  /**
   * A live call the window has not shown yet takes it over, whichever door started it (the window,
   * the CLI, an agent, the hotkey, the API) and whatever call the user picked before (W3.17). The
   * user may pick another call afterwards; the next new live call takes over again, and a call that
   * ends stays on screen. The one exception is a call already live when the page opens on a call it
   * was asked for (`akou open CALL`, `?call=`): the page keeps what it was asked to show.
   */
  private onStatus(s: AppStatus): void {
    const first = this.status === null;
    this.status = s;
    titleBar(this.t.kind === "window" && s.app.platform === "darwin");
    this.modelsCard.update(s.models, true);
    const live = s.live?.call ?? null;
    const fresh = live !== null && live !== this.seenLive && !(first && this.chosen);
    if (live) this.seenLive = live;
    if (fresh || !this.chosen) {
      const target = live ?? this.callId ?? s.last?.call ?? null;
      if (target && target !== this.callId) this.openCall(target, false);
      else if (fresh) this.chosen = false;
    }
    void this.loadCalls();
    this.paint();
  }

  /** Shows a call: a new follower, every pane reset. */
  openCall(id: string, chosen: boolean): void {
    this.chosen = chosen;
    if (id === this.callId && this.follower) {
      // Picked again: the call may be behind the welcome, which the pick now lifts.
      this.paint();
      return;
    }
    // A title being edited is saved to its own call before another one is shown, and the field
    // closes, so it can never rename this call while another one is on screen.
    document.getElementById("title-input")?.blur();
    this.closeTitle?.();
    this.follower?.stop();
    this.callId = id;
    this.hues = new HueBook();
    this.levelAt = null;
    this.followedAt = null;
    this.disconnectedSince = null;
    this.callHeardAt = null;
    this.lastLineAt = null;
    this.transcript.reset();
    this.notepad.reset();
    this.askPane.reset();
    this.enhanced.reset();
    this.player.stop();
    this.meters(null);
    this.drawPeople(null);
    if (this.t.kind === "browser")
      history.replaceState(null, "", `?call=${encodeURIComponent(id)}`);
    const f = new Follower(this.t, id, {
      changed: (c) => {
        if (f !== this.follower) return;
        const animate = c.events.length < 20;
        // The final pass ending makes every live speaker label solid (W4.2): each row may change.
        const done = c.events.some((e) => e.type === "final.done");
        this.transcript.update(done ? { all: true, ids: [] } : c, animate);
        let notes = c.all;
        let speakers = c.all;
        let asked = c.all;
        for (const e of c.events) {
          // A line arriving now counts from now (the page's clock); the backlog from when it was
          // written.
          if (e.type === "seg" && e.rev === 1) {
            this.lastLineAt = animate ? Date.now() : Math.max(this.lastLineAt ?? 0, e.t);
          }
          if (e.type === "note" || e.type === "note.del") notes = true;
          if (e.type.startsWith("speaker.")) speakers = true;
          if (e.type === "ask" || e.type === "answer") asked = true;
          if (e.type === "enhanced") this.enhanced.refresh();
          // Notes written before the final layer may now be offered a re-enhance.
          if (e.type === "final.done") void this.enhanced.load();
        }
        if (notes) this.notepad.render();
        if (speakers) this.askPane.renderPresets();
        if (asked) this.askPane.restore();
        // The talk times follow the lines and the names, not the one-second tick.
        const lines = c.events.some((e) => e.type === "seg" || e.type.startsWith("final."));
        if (speakers || lines) this.drawPeople(f.view);
        document.body.dataset.cursor = String(f.cursor);
        document.body.dataset.reconnects = String(f.stats.reconnects);
        document.body.dataset.duplicates = String(f.stats.duplicates);
        this.paint();
      },
      partial: (p) => {
        if (f === this.follower) this.transcript.setPartial(p);
      },
      level: (l) => {
        if (f === this.follower) this.meters(l);
      },
      connection: (state) => {
        if (f !== this.follower) return;
        if (state === "open") {
          this.disconnectedSince = null;
          this.followedAt ??= Date.now();
        } else this.disconnectedSince ??= Date.now();
        document.body.dataset.connection = state;
        this.paint();
      },
    });
    this.follower = f;
    this.askPane.renderPresets();
    this.enhanced.paint();
    this.drawCalls();
    this.paint();
  }

  // ---------------------------------------------------------------------------
  // Drawing

  private paint(): void {
    const v = this.view();
    const now = Date.now();
    const s = this.status;
    this.enhanced.paint();
    this.review.paint();
    const st = stateLabel({
      view: v,
      status: s,
      // A reconnect that takes more than 3 s is worth saying; a quick one is not.
      disconnected: this.disconnectedSince !== null && now - this.disconnectedSince > 3000,
      now,
      lastLineAt: this.lastLineAt,
      levelAt: this.levelAt,
      followedAt: this.followedAt,
      reopen: suggestReopen(this.t.kind, this.disconnectedSince, now),
      lines: this.transcript.count,
      setup: this.welcoming(),
    });
    const body = document.body;
    for (const c of ["ready", "recording", "paused", "saved", "offline", "failed", "other"]) {
      body.classList.toggle(c, c === st.cls);
    }
    const state = byId("state");
    state.textContent = st.label;
    // With no call open the transcript header is gone, so what the state adds is its tooltip.
    state.title = st.meta;
    const call = v?.call;
    document.title = call ? `${call.title || call.workspace} · akou` : "akou";
    this.welcome();
    this.callHead(v, now, st.meta);
    this.pills(v);
    this.controls(v);
    this.drawBanner(v, now);
    this.drawHealth(v);
    this.drawFinal(v);
    const empty = byId("empty");
    const shown = this.transcript.count > 0 || !byId("partial").hidden;
    empty.hidden = shown;
    empty.textContent = v?.live
      ? "Listening. A line appears each time someone pauses."
      : v?.call
        ? "No transcript lines in this call."
        : "Press Record to start a call.";
  }

  /**
   * Readiness drives the shell (WINDOW section 10): with the speech models missing the welcome
   * replaces the transcript, the side pane and the player; the sidebar stays. A call recording
   * anyway (one started without models from the CLI) keeps the workspace, so it is never hidden,
   * and so does a call the user picked from the list; the readiness row brings the welcome back.
   */
  private welcoming(): boolean {
    return this.modelsCard.missing && !this.status?.live && !this.chosen;
  }

  private welcome(): void {
    const missing = this.modelsCard.missing;
    const on = this.welcoming();
    byId("welcome").hidden = !on;
    for (const id of ["scroller", "side"]) byId(id).hidden = on;
    // The transcript header goes with the transcript, and needs a call to describe.
    byId("call-head").hidden = on || !this.view()?.call;
    // The player exists only when the open call has a recording to play (WINDOW section 5). A bar
    // that goes away takes its audio with it: Restart on a saved call must not leave it playing.
    const bar = byId("player-bar");
    const noBar = on || !hasRecording(this.view());
    if (noBar && !bar.hidden) this.player.stop();
    bar.hidden = noBar;
    document.body.classList.toggle("welcoming", on);
    // The readiness row (WINDOW section 13): what is missing, and the page that fixes it.
    const s = this.status;
    byId("readiness").dataset.state = !s ? "none" : missing ? "missing" : "ready";
    byId("readiness-text").textContent = !s
      ? ""
      : !missing
        ? "Ready"
        : s.models?.state === "downloading"
          ? "Downloading models"
          : s.models?.state === "failed"
            ? "Download failed"
            : "Models missing";
    byId("readiness-setup").hidden = !missing;
    const where = byId("readiness-where");
    where.hidden = !s || missing;
    where.textContent = this.platform === "mac" ? "Runs on this Mac" : "Runs on this computer";
    byId("models-pip").hidden = !missing;
  }

  /**
   * The transcript header (WINDOW section 3.1): the call's title, the line under it (day and start,
   * length, workspace, template, then what the state adds) and who spoke for how long.
   */
  private callHead(v: CallView | null, now: number, note: string): void {
    const call = v?.call;
    if (!this.renaming) byId("title-text").textContent = call ? call.title || "Untitled call" : "";
    const meta = byId("meta");
    if (!v || !call) {
      meta.textContent = "";
      meta.title = "";
      return;
    }
    const seconds = v.live
      ? null
      : v.parts().reduce((sum, p) => sum + (p.ended?.fileSeconds ?? 0), 0);
    meta.textContent = callHeadMeta({
      createdAt: call.t,
      tz: call.tz,
      now,
      seconds,
      workspace: call.workspace,
      template: call.template,
      note,
    });
    const tz = call.tz;
    const used = v.vocabUsed;
    meta.title = [
      `Times are local, ${formatZone(tz, now)}`,
      used?.entries.length ? `Words this call listens for: ${used.entries.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Renaming the open call from its title (WINDOW 3.1), live or saved, the way a note is edited:
   * a click or Enter opens the field, Enter or leaving it saves, Escape keeps the old name. An
   * empty or unchanged title saves nothing. The save is a `call.renamed` through `PATCH`; the
   * header, the sidebar row, its search and the window title follow from the log and the status
   * push that event causes, from this window or any other door.
   */
  private editTitle(): void {
    const id = this.callId;
    const call = this.view()?.call;
    if (!id || !call || this.renaming) return;
    const shown = byId("title-text");
    const old = call.title;
    const input = h("input", {
      id: "title-input",
      value: old,
      attrs: { "aria-label": "Call title", maxlength: "200", autocomplete: "off" },
    });
    shown.hidden = true;
    shown.after(input);
    input.focus();
    input.select();
    this.renaming = true;
    let open = true;
    const close = () => {
      open = false;
      if (this.closeTitle === close) this.closeTitle = null;
      this.renaming = false;
      input.remove();
      shown.hidden = false;
    };
    this.closeTitle = close;
    const done = async (keep: boolean) => {
      if (!open) return;
      open = false;
      const title = input.value.replace(/\s+/g, " ").trim();
      if (keep && title !== "" && title !== old) {
        const r = await this.t
          .request<{ title?: string }>("PATCH", `/calls/${encodeURIComponent(id)}`, { title })
          .catch(() => null);
        if (!r || r.status >= 400) toast(message(r?.body, "the call was not renamed"));
        // Another call was opened meanwhile, which closed this field: nothing left to show.
        if (!input.isConnected) return;
        if (!r || r.status >= 400) {
          // The field stays open with its text, to try again.
          open = true;
          return;
        }
        // Shown at once; the event on the stream brings the same title a moment later.
        shown.textContent = r.body.title ?? title;
      }
      close();
      if (document.activeElement === document.body) shown.focus();
    };
    input.addEventListener("keydown", (e) => {
      // Enter or Escape inside an IME composition belongs to the composition, not the edit.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      void done(e.key === "Enter");
    });
    input.addEventListener("blur", () => void done(true));
  }

  /** The speaker chips under the title: each voice's colour and its time, the most first. */
  private drawPeople(v: CallView | null): void {
    const totals = v?.call
      ? speakerTotals(v.lines(), {
          named: new Set(
            v
              .roster()
              .filter((s) => s.name)
              .map((s) => s.spk),
          ),
          finalDoneSeq: v.final.done?.seq,
        })
      : [];
    const people = byId("people");
    people.hidden = totals.length === 0;
    replace(
      people,
      ...totals.map((t) => {
        const dot = h("i", { attrs: { "aria-hidden": "true" } });
        dot.style.setProperty("--h", String(this.hues.hue(t.spk)));
        return h(
          "li",
          { attrs: { "data-spk": t.spk } },
          dot,
          h("span", { class: "who" }, t.label),
          h("span", { class: "len" }, talkTime(t.seconds)),
        );
      }),
    );
  }

  private pills(v: CallView | null): void {
    const review = byId("pill-review");
    const proposed = v?.proposals("proposed").length ?? 0;
    review.hidden = proposed === 0;
    review.textContent = `${proposed} ${proposed === 1 ? "word" : "words"} to review`;
    const langs = v ? languages(v) : [];
    const lang = byId("pill-lang");
    lang.hidden = langs.length === 0;
    lang.textContent = `languages: ${langs.join(", ")}`;
    // The live setup this call runs (asr.live), while it records.
    const running = this.status?.live;
    const setup = running && running.call === this.callId ? running.setup : null;
    const livePill = byId("pill-live");
    livePill.hidden = !setup;
    livePill.textContent = setup ? `live: ${setup}` : "";
    livePill.title = setup && running?.engine ? running.engine : "";
    const share = this.status?.share.shares?.find((x) => x.call === this.callId);
    const pill = byId("pill-share");
    pill.hidden = !share;
    if (share) {
      byId("share-text").textContent =
        `Shared live · ${share.viewers} ${share.viewers === 1 ? "viewer" : "viewers"}`;
      pill.title = `${share.url}${share.warning ? `\n${share.warning}` : ""}`;
    }
    byId("share-start").hidden = !!share || !v?.call;
    byId("copy-transcript").hidden = !v?.call;
  }

  private controls(v: CallView | null): void {
    const live = this.status?.live ?? null;
    const mine = !!v?.live;
    const other = !!live && live.call !== this.callId;
    const body = document.body;
    body.classList.toggle("busy", mine || other);
    byId("stop-label").textContent = other && !mine ? "Stop the other call" : "Stop";
    // Record waits for the speech models with its reason, so the page never sends a start that
    // the app refuses with 503 models_missing.
    const blocked = recordBlocked(this.status?.models);
    const record = byId<HTMLButtonElement>("record");
    record.disabled = this.starting || blocked !== null;
    record.title = blocked ?? "";
    // The global hotkey, which records and stops from any app, where a shell registers one.
    const key = byId("record-key");
    key.textContent = recordKey(this.status?.app);
    key.hidden = key.textContent === "";
    // How long the call on screen has recorded, beside its Stop.
    const elapsed = byId("elapsed");
    const first = mine ? v?.parts()[0]?.wallStart : undefined;
    elapsed.hidden = first === undefined;
    if (first !== undefined) {
      byId("elapsed-text").textContent = formatDuration((Date.now() - first) / 1000);
    }
    // Quiet icon buttons: the label is their name for a screen reader and their tooltip.
    const muteLabel = v?.muted ? "Unmute mic" : "Mute mic";
    const mute = byId<HTMLButtonElement>("mute");
    byId("mute-label").textContent = muteLabel;
    mute.title = muteLabel;
    mute.classList.toggle("on", !!v?.muted);
    mute.setAttribute("aria-pressed", String(!!v?.muted));
    mute.disabled = !mine;
    const paused = v?.state === "paused";
    const pause = byId<HTMLButtonElement>("pause");
    byId("pause-label").textContent = paused ? "Resume" : "Pause";
    pause.title = paused ? "Resume" : "Pause";
    pause.classList.toggle("on", paused);
    pause.disabled = !mine;
    const ended = ["ended", "failed", "crashed", "interrupted"].includes(v?.state ?? "");
    byId("restart").hidden = !(mine || (ended && !live));
  }

  private drawBanner(v: CallView | null, now: number): void {
    const b = banner({
      view: v,
      now,
      lastLineAt: this.lastLineAt,
      callHeardAt: this.callHeardAt,
      levelAt: this.levelAt,
      platform: this.platform,
    });
    const el = byId("banner");
    el.className = b ? b.kind : "";
    el.hidden = !b;
    byId("banner-text").textContent = b?.text ?? "";
    const act = byId<HTMLButtonElement>("banner-action");
    act.hidden = !b?.action;
    act.dataset.action = b?.action ?? "";
    act.textContent = b?.action === "open-settings" ? "Open System Settings" : "↻ Restart";
  }

  private drawFinal(v: CallView | null): void {
    const n = v ? finalNote(v) : null;
    const el = byId("final");
    const hand = v?.handoff();
    const bits: string[] = [];
    const exp = hand?.exports.at(-1);
    if (exp) bits.push(`exported to ${exp.path}`);
    for (const k of hand?.hooks ?? [])
      bits.push(`hook ${k.name}: ${k.exit === 0 ? "ok" : `exit ${k.exit}`}`);
    const wh = hand?.webhooks.at(-1);
    if (wh) bits.push(`webhook: ${wh.status}`);
    el.hidden = !n && bits.length === 0;
    el.className = n?.state ?? "";
    byId("final-text").textContent = n?.text ?? "";
    const bar = byId<HTMLProgressElement>("final-progress");
    bar.hidden = n?.state !== "running";
    if (n?.progress !== undefined) bar.value = n.progress;
    byId("handoff").textContent = bits.join("  ·  ");
  }

  private meters(l: Levels | null): void {
    const now = Date.now();
    if (l) {
      this.levelAt = now;
      if (l.call > HEARD_DBFS) this.callHeardAt = now;
    }
    if (l) this.levels.set(l);
    else this.levels.reset();
    for (const ch of ["mic", "call"] as const) {
      byId(`meter-${ch}`).title = l ? `${ch}: ${Math.round(l[ch])} dBFS` : `${ch}: no level`;
    }
    this.drawHealth(this.view());
  }

  /**
   * The health dots. Drawn with the banner on every view update, so a health event turns both red
   * at once, and again on each level packet, which is what turns a dot from none to ok.
   */
  private drawHealth(v: CallView | null): void {
    for (const ch of ["mic", "call"] as const) {
      const hState = v?.channelHealth(ch)?.state ?? (this.levelAt !== null ? "ok" : "none");
      const dot = byId(`health-${ch}`);
      dot.dataset.state = hState;
      dot.title = `${ch}: ${hState}`;
    }
  }

  // ---------------------------------------------------------------------------
  // The list of calls (WINDOW section 13): by workspace, newest first, one open at a time, and a
  // search over titles and workspaces, never over what was said

  private async loadCalls(): Promise<void> {
    // Failed starts are listed apart by the API; the window shows them in the one list, marked.
    const [ok, failed] = await Promise.all([
      this.t.request<{ calls?: CallSummary[] }>("GET", "/calls?limit=200"),
      this.t.request<{ calls?: CallSummary[] }>("GET", "/calls?limit=50&failed=true"),
    ]);
    this.calls = [...(ok.body.calls ?? []), ...(failed.body.calls ?? [])].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    this.drawCalls();
    const names = [...new Set(["default", ...this.calls.map((c) => c.workspace)])];
    replace(byId("workspaces"), ...names.map((n) => h("option", { value: n })));
    const ws = this.workspaceInput();
    if (!ws.value) ws.value = this.calls[0]?.workspace ?? "default";
  }

  private wireSidebar(): void {
    const search = byId<HTMLInputElement>("calls-search");
    search.addEventListener("input", () => this.drawCalls());
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !search.value) return;
      e.preventDefault();
      search.value = "";
      this.drawCalls();
    });
    byId("readiness-setup").addEventListener("click", () => {
      // Back to the welcome, unless a call is recording: then the Models dialog.
      this.chosen = false;
      this.paint();
      if (byId("welcome").hidden) byId("models-open").click();
      else byId("models-pull").focus();
    });
  }

  private drawCalls(): void {
    const query = byId<HTMLInputElement>("calls-search").value;
    const live = this.status?.live?.call ?? null;
    const now = Date.now();
    const key = JSON.stringify([
      this.calls,
      query,
      live,
      this.callId,
      [...this.folded],
      new Date(now).toDateString(),
    ]);
    if (key === this.drawnCalls) return;
    this.drawnCalls = key;
    const list = byId("calls");
    // Redrawing must not take the keyboard away from the row or the group it is on.
    const had = document.activeElement as HTMLElement | null;
    const focus = had && list.contains(had) ? (had.dataset.ws ?? had.dataset.id) : undefined;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const groups = groupCalls(this.calls, query, live);
    if (groups.length === 0) {
      replace(
        list,
        query.trim()
          ? h("p", { class: "none" }, `No call title or workspace has “${query.trim()}”.`)
          : this.groupEl({ workspace: "default", calls: [] }, 0, "", now, tz),
      );
    } else {
      replace(list, ...groups.map((g, i) => this.groupEl(g, i, query, now, tz, live)));
    }
    if (focus === undefined) return;
    for (const el of list.querySelectorAll<HTMLElement>("button[data-ws], button[data-id]")) {
      if ((el.dataset.ws ?? el.dataset.id) === focus) {
        el.focus();
        break;
      }
    }
  }

  /** One workspace: a header that folds it, with its count, then its calls. */
  private groupEl(
    g: { workspace: string; calls: CallSummary[] },
    i: number,
    query: string,
    now: number,
    tz: string,
    live: string | null = null,
  ): HTMLElement {
    // A search shows every call it finds, folded or not.
    const open = !this.folded.has(g.workspace) || query.trim() !== "";
    const id = `calls-ws-${i}`;
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("class", "ico");
    chevron.setAttribute("viewBox", "0 0 16 16");
    chevron.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m4 6 4 4 4-4");
    chevron.append(path);
    const head = h(
      "button",
      {
        type: "button",
        class: "ws-head",
        attrs: { "aria-expanded": String(open), "aria-controls": id, "data-ws": g.workspace },
        on: {
          click: () => {
            if (this.folded.has(g.workspace)) this.folded.delete(g.workspace);
            else this.folded.add(g.workspace);
            this.drawCalls();
          },
        },
      },
      chevron,
      h("span", { class: "ws-name" }, g.workspace),
      g.calls.length > 0 && h("span", { class: "cnt" }, String(g.calls.length)),
    );
    const body =
      g.calls.length === 0
        ? h("p", { class: "none", id, hidden: !open }, "No calls yet")
        : h(
            "ul",
            { id, hidden: !open },
            ...g.calls.map((c) =>
              h(
                "li",
                { attrs: { "data-id": c.id }, class: c.id === live ? "live" : c.state },
                h(
                  "button",
                  {
                    type: "button",
                    attrs: { "aria-current": String(c.id === this.callId), "data-id": c.id },
                    on: { click: () => this.openCall(c.id, true) },
                  },
                  h("span", { class: "what" }, c.title || "Untitled call"),
                  h("span", { class: "when" }, callMeta(c, now, tz, c.id === live)),
                ),
              ),
            ),
          );
    return h(
      "section",
      { class: "ws-group", attrs: { "data-workspace": g.workspace } },
      head,
      body,
    );
  }

  // ---------------------------------------------------------------------------
  // Controls

  private liveTarget(): string | null {
    const v = this.view();
    if (v?.live && this.callId) return this.callId;
    return this.status?.live?.call ?? null;
  }

  private async control(name: string, id: string | null, body: unknown = {}): Promise<boolean> {
    if (!id) return false;
    const r = await this.t.request<{ error?: string }>("POST", `/calls/${id}/${name}`, body);
    if (r.status >= 400) {
      if (r.body.error === "stale_restart") {
        this.confirm(
          "The last audio of this call is over an hour old. Restart it anyway?",
          "Restart anyway",
          () => void this.control("restart", id, { force: true }),
        );
        return false;
      }
      toast(message(r.body, `${name} failed (${r.status})`));
      return false;
    }
    return true;
  }

  private wireControls(): void {
    byId("record").addEventListener("click", () => void this.record());
    byId("stop").addEventListener("click", () => void this.control("stop", this.liveTarget()));
    byId("mute").addEventListener("click", () => {
      const v = this.view();
      void this.control(v?.muted ? "unmute" : "mute", v?.live ? this.callId : null);
    });
    byId("pause").addEventListener("click", () => {
      const v = this.view();
      void this.control(v?.state === "paused" ? "resume" : "pause", v?.live ? this.callId : null);
    });
    byId("restart").addEventListener("click", () => void this.control("restart", this.callId));
    byId("banner-action").addEventListener("click", (e) => {
      const action = (e.currentTarget as HTMLElement).dataset.action;
      if (action === "restart") void this.control("restart", this.callId);
      else if (action === "open-settings") {
        const pane =
          this.view()?.channelHealth("call")?.state === "permission-suspect"
            ? "system-audio"
            : "microphone";
        void this.t.openSettingsPane(pane).then((ok) => {
          if (!ok) toast("Open the privacy settings yourself: this window cannot open them here.");
        });
      }
    });
    byId("share-start").addEventListener("click", () => void this.share());
    const copy = byId("copy-transcript");
    copy.title += this.platform === "mac" ? " (⌘⇧C)" : " (Ctrl+Shift+C)";
    copy.addEventListener("click", () => void this.copyTranscript());
    document.addEventListener("keydown", (e) => {
      const mod = this.platform === "mac" ? e.metaKey : e.ctrlKey;
      // The letter on the key, or the C key's place when the layout has no Latin letters.
      const k = e.key.toLowerCase();
      const c = k === "c" || (!/^[a-z]$/.test(k) && e.code === "KeyC");
      if (!mod || !e.shiftKey || e.altKey || !c) return;
      // The key's scope is the window (WINDOW 14), text fields included; Settings keeps its own.
      if ((e.target as HTMLElement | null)?.closest("dialog")) return;
      e.preventDefault();
      void this.copyTranscript();
    });
    byId("share-stop").addEventListener("click", () => {
      void this.t.request("DELETE", "/share", { call: this.callId }).then((r) => {
        if (r.status >= 400) toast(message(r.body, "the share could not be stopped"));
      });
    });
  }

  private async record(): Promise<void> {
    if (this.starting || recordBlocked(this.status?.models) !== null) return;
    this.starting = true;
    this.paint();
    const template = byId<HTMLSelectElement>("template").value;
    let r: Reply<{ call?: string; error?: string }>;
    try {
      r = await this.t.request("POST", "/calls", {
        workspace: this.workspaceInput().value.trim() || undefined,
        title: byId<HTMLInputElement>("newtitle").value.trim() || undefined,
        ...(template ? { template } : {}),
      });
    } finally {
      this.starting = false;
      this.paint();
    }
    const call = r.body.call;
    if (r.status === 201 && call) {
      byId<HTMLInputElement>("newtitle").value = "";
      this.openCall(call, false);
      this.consent();
      return;
    }
    toast(message(r.body, `the call did not start (${r.status})`));
    if (r.body.error === "already_recording" && call) this.openCall(call, true);
  }

  private async share(): Promise<void> {
    const r = await this.t.request<{ url?: string; warning?: string }>("POST", "/share", {
      call: this.callId,
    });
    if (r.status >= 400 || !r.body.url) {
      toast(message(r.body, "the call could not be shared"));
      return;
    }
    const url = r.body.url;
    this.confirm(
      `Read-only link: ${url}${r.body.warning ? ` (${r.body.warning})` : ""}`,
      "Copy the link",
      () =>
        void navigator.clipboard
          .writeText(url)
          .catch(() => toast("The clipboard is not available here.")),
    );
  }

  /**
   * Copy transcript so far (WINDOW W12.2): the export's `## Transcript` section as the app renders
   * it, names and vocabulary applied; the final layer once the final pass is done. The text is
   * handed to the clipboard as a promise, so WebKit still counts the click or key as the gesture
   * that allows the write.
   */
  private async copyTranscript(): Promise<void> {
    const call = this.callId;
    if (!call || !this.view()?.call) return;
    const text = this.t
      .request<string>("GET", `/calls/${encodeURIComponent(call)}/transcript?format=export`)
      .then((r) => {
        if (r.status >= 400 || typeof r.body !== "string") {
          throw new Error(message(r.body, `the transcript could not be read (${r.status})`));
        }
        return r.body;
      });
    try {
      if (typeof ClipboardItem === "function") {
        const blob = text.then((s) => new Blob([s], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      } else await navigator.clipboard.writeText(await text);
      toast("Transcript copied.", "info");
    } catch {
      const failed = await text.then(
        () => null,
        (e: Error) => e.message,
      );
      toast(failed ?? "The clipboard is not available here.");
    }
  }

  /** The consent reminder, once per call started here, with notice text to copy. */
  private consent(): void {
    const notice = "Heads up: I'm recording this call on my own computer to take notes.";
    this.confirm(
      "Remember to tell the others you are recording.",
      "Copy a notice",
      () =>
        void navigator.clipboard
          .writeText(notice)
          .catch(() => toast("The clipboard is not available here.")),
    );
  }

  /**
   * A row under the header with one action and a dismiss button. Each message gets its own row, so
   * a second one (the share link) never hides the first (the consent reminder).
   */
  private confirm(text: string, action: string, run: () => void): void {
    const bar = byId("confirm");
    const close = () => {
      row.remove();
      bar.hidden = bar.childElementCount === 0;
    };
    const row = h(
      "div",
      { class: "confirm-row" },
      h("span", {}, text),
      h(
        "button",
        {
          type: "button",
          class: "go",
          on: {
            click: () => {
              close();
              run();
            },
          },
        },
        action,
      ),
      h("button", { type: "button", on: { click: close } }, "Dismiss"),
    );
    bar.append(row);
    bar.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Tabs: Notes and Enhanced. Ask sits above them and is never a tab (WINDOW section 6).

  private wireTabs(): void {
    const tabs = [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    const select = (tab: HTMLButtonElement) => {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        byId(t.getAttribute("aria-controls") as string).hidden = !on;
      }
    };
    for (const [i, tab] of tabs.entries()) {
      tab.addEventListener("click", () => select(tab));
      tab.addEventListener("keydown", (e) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        const next = tabs[(i + d + tabs.length) % tabs.length] as HTMLButtonElement;
        select(next);
        next.focus();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Citations and playback

  private cite(id: string): void {
    this.transcript.scrollTo(id);
    void this.play(id);
  }

  private async play(id: string): Promise<void> {
    const v = this.view();
    const call = this.callId;
    const line = v?.resolve(id);
    if (!v || !call || !line || !this.mayPlay()) return;
    const k = `${call}:${line.part}`;
    let url = this.blobs.get(k);
    if (!url) {
      try {
        url = URL.createObjectURL(await this.t.audio(call, line.part));
      } catch (err) {
        toast((err as Error).message);
        return;
      }
      this.blobs.set(k, url);
      // Another call opened while the audio downloaded: it stays cached, and does not play.
      if (call !== this.callId) return;
    }
    this.player.load(url, line.part, line.a0, id);
  }

  private mayPlay(): boolean {
    if (this.view()?.live) {
      // A recording call has no player (WINDOW section 5), so nothing may start audio it could not
      // pause. On Linux there is a second reason: PipeWire cannot keep the window's audio out of
      // the recording (DESIGN 2.3).
      toast(
        this.platform === "linux"
          ? "akou does not play audio while a call is recording on Linux."
          : "Audio plays once the call is saved.",
      );
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // A line's actions (W4.4): the line menu lists these, and a line's own buttons run the same code

  private lineActions(): LineAction[] {
    return [
      { id: "line.play", label: "Play from here", run: (id) => void this.play(id) },
      { id: "line.copy", label: "Copy line", run: (id) => this.copyLine(id, false) },
      {
        id: "line.copy-cited",
        label: "Copy with time and speaker",
        run: (id) => this.copyLine(id, true),
      },
      {
        id: "speaker.name",
        label: "Name this speaker…",
        run: (id, anchor) => {
          const spk = this.view()?.resolve(id)?.spk;
          if (spk) this.speakerMenu(spk, anchor);
        },
      },
      {
        id: "line.fix-word",
        label: "Fix a word…",
        run: (id, anchor) => {
          const sel = getSelection()?.toString().trim() ?? "";
          this.fixWord(id, anchor, sel.length <= 60 ? sel : "");
        },
      },
    ];
  }

  /** One line as shown, alone or as `[15:41:07 Ben] text`, the export's citation form. */
  private copyLine(id: string, cited: boolean): void {
    const l = this.transcript.shown(id);
    if (!l) return;
    const text = cited ? `[${l.time} ${l.speaker}] ${l.text}` : l.text;
    void navigator.clipboard
      .writeText(text)
      .then(() => toast("Line copied.", "info"))
      .catch(() => toast("The clipboard is not available here."));
  }

  // ---------------------------------------------------------------------------
  // The popover: speaker chips (rename, merge, unmerge) and "Fix this word"

  private wirePopover(): void {
    const pop = byId("popover");
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.hidden) this.closePopover();
    });
    document.addEventListener("mousedown", (e) => {
      if (
        !pop.hidden &&
        !pop.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest(".who, .fix")
      ) {
        this.closePopover();
      }
    });
  }

  private popoverFrom: HTMLElement | null = null;

  private openPopover(anchor: HTMLElement, label: string, ...children: HTMLElement[]): void {
    const pop = byId("popover");
    replace(pop, h("h3", {}, label), ...children);
    pop.setAttribute("aria-label", label);
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(innerWidth - 340, r.left))}px`;
    pop.style.top = `${Math.min(innerHeight - 40, r.bottom + 6)}px`;
    this.popoverFrom = anchor;
    (pop.querySelector("input, select, button") as HTMLElement | null)?.focus();
  }

  private closePopover(): void {
    byId("popover").hidden = true;
    this.popoverFrom?.focus();
    this.popoverFrom = null;
  }

  private speakerMenu(spk: string, anchor: HTMLElement): void {
    const v = this.view();
    const call = this.callId;
    if (!v || !call) return;
    const roster = v.roster();
    const label = v.speakerLabel(spk);
    const after = async (p: Promise<{ status: number; body: unknown }>) => {
      const r = await p;
      if (r.status >= 400) toast(message(r.body, "that did not work"));
      else this.closePopover();
    };
    const name = h("input", {
      value: roster.find((s) => s.spk === spk)?.name ?? "",
      placeholder: "Name",
      attrs: { "aria-label": `Name for ${label}` },
    });
    const rename = h(
      "form",
      {
        class: "pop-row",
        on: {
          submit: (e) => {
            e.preventDefault();
            if (name.value.trim() === "") return;
            void after(
              this.t.request("POST", `/calls/${call}/speakers`, { spk, name: name.value.trim() }),
            );
          },
        },
      },
      name,
      h("button", { type: "submit", class: "go" }, "Save name"),
    );
    const others = roster.filter((s) => !s.mergedInto && s.spk !== spk && s.spk !== "you");
    const into = h(
      "select",
      { attrs: { "aria-label": `Merge ${label} into` } },
      ...others.map((s) => h("option", { value: s.spk }, `${s.label} (${s.spk})`)),
    );
    const merge =
      spk !== "you" && others.length > 0
        ? h(
            "div",
            { class: "pop-row" },
            into,
            h(
              "button",
              {
                type: "button",
                on: {
                  click: () =>
                    void after(
                      this.t.request("POST", `/calls/${call}/speakers/merge`, {
                        from: spk,
                        into: into.value,
                      }),
                    ),
                },
              },
              "Merge into",
            ),
          )
        : null;
    const members = roster.filter((s) => s.mergedInto === spk);
    const unmerge = members.map((m) =>
      h(
        "button",
        {
          type: "button",
          class: "unmerge",
          on: {
            click: () =>
              void after(this.t.request("POST", `/calls/${call}/speakers/unmerge`, { spk: m.spk })),
          },
        },
        `Split off ${m.spk.replace(/^c(\d+)$/, "Speaker $1")} (${m.spk})`,
      ),
    );
    this.openPopover(anchor, `${label} (${spk})`, rename, ...(merge ? [merge] : []), ...unmerge);
  }

  private fixWord(lineId: string, anchor: HTMLElement, selected: string): void {
    const v = this.view();
    const call = this.callId;
    const line = v?.resolve(lineId);
    if (!v || !call || !line) return;
    const heard = h("input", {
      value: selected,
      placeholder: "what akou wrote",
      attrs: { "aria-label": "What akou heard" },
    });
    const said = h("input", {
      placeholder: "what was said",
      attrs: { "aria-label": "What was said" },
    });
    const note = h("p", { class: "hint" }, `In the line: ${line.raw ?? line.text}`);
    const after = h("div", { class: "pop-row", hidden: true });
    const form = h(
      "form",
      {
        class: "pop-col",
        on: {
          submit: (e) => {
            e.preventDefault();
            const term = said.value.trim();
            const h1 = heard.value.trim();
            if (term === "" || h1 === "") return;
            void this.t
              .request("POST", `/calls/${call}/vocab`, { term, heard: [h1], segs: [lineId] })
              .then((r) => {
                if (r.status >= 400) {
                  note.textContent = message(r.body, "that word could not be added");
                  return;
                }
                note.textContent = `Fixed in this line. Use it more widely?`;
                replace(
                  after,
                  h(
                    "button",
                    {
                      type: "button",
                      on: {
                        click: () =>
                          void this.t
                            .request("POST", `/calls/${call}/vocab`, { term, heard: [h1] })
                            .then((x) => {
                              note.textContent =
                                x.status >= 400
                                  ? message(x.body, "not added")
                                  : "Fixed everywhere in this call.";
                            }),
                      },
                    },
                    "Everywhere in this call",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      on: {
                        click: () =>
                          void this.t
                            .request("POST", "/vocab", {
                              term,
                              heard: [h1],
                              workspace: v.call?.workspace,
                            })
                            .then((x) => {
                              note.textContent =
                                x.status >= 400
                                  ? message(x.body, "not added")
                                  : "Added to the workspace vocabulary.";
                            }),
                      },
                    },
                    "Add to the workspace vocabulary",
                  ),
                );
                after.hidden = false;
              });
          },
        },
      },
      heard,
      said,
      h("button", { type: "submit", class: "go" }, "Fix this word"),
    );
    this.openPopover(anchor, "Fix this word", note, form, after);
  }
}
