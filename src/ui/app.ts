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

import { formatWall, formatZone } from "../core/log/clock.ts";
import type { CallView } from "../core/log/fold.ts";
import { AskPane } from "./ask.ts";
import { byId, h, replace, toast } from "./dom.ts";
import { EnhancedPane } from "./enhanced.ts";
import { Follower } from "./follow.ts";
import { type LineAction, LineMenu } from "./line-menu.ts";
import { banner, finalNote, HueBook, languages, stateLabel, suggestReopen } from "./model.ts";
import { ModelsCard } from "./models-card.ts";
import { message, NotepadPane } from "./notepad.ts";
import { Player } from "./player.ts";
import type { AppStatus, Levels, Transport } from "./protocol.ts";
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

/** The application menu's Settings… opens the settings pane, as its button does. */
export function showSettings(): void {
  document.getElementById("settings-open")?.click();
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
  /** The call this window started, so the window follows it even when another was picked. */
  private startedHere: string | null = null;
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
  private blobs = new Map<string, string>();

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
    new LineMenu(byId("lines"), () => this.lineActions());
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
    const settings = new SettingsPane(
      t,
      () => this.view()?.call?.workspace ?? this.workspaceInput().value,
    );
    this.modelsCard = new ModelsCard(t);
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
    this.wireControls();
    this.wireTabs();
    this.wirePopover();
    const pinned = new URLSearchParams(location.search).get("call");
    if (pinned) this.openCall(pinned, true);
    this.t.watchStatus((s) => this.onStatus(s));
    void this.enhanced.loadTemplates().then((names) => {
      replace(
        byId("template"),
        h("option", { value: "" }, "template: automatic"),
        ...names.map((n) => h("option", { value: n }, n)),
      );
    });
    setInterval(() => this.paint(), 1000);
    this.paint();
  }

  private onStatus(s: AppStatus): void {
    const wasLive = this.status?.live?.call ?? null;
    this.status = s;
    this.modelsCard.update(s.models);
    const live = s.live?.call ?? null;
    if (!this.chosen || (live && live !== wasLive && this.startedHere === live)) {
      const target = live ?? this.callId ?? s.last?.call ?? null;
      if (target && target !== this.callId) this.openCall(target, false);
    }
    void this.loadCalls();
    this.paint();
  }

  /** Shows a call: a new follower, every pane reset. */
  openCall(id: string, chosen: boolean): void {
    this.chosen = chosen;
    if (id === this.callId && this.follower) return;
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
        for (const e of c.events) {
          // A line arriving now counts from now (the page's clock); the backlog from when it was
          // written.
          if (e.type === "seg" && e.rev === 1) {
            this.lastLineAt = animate ? Date.now() : Math.max(this.lastLineAt ?? 0, e.t);
          }
          if (e.type === "note" || e.type === "note.del") notes = true;
          if (e.type.startsWith("speaker.")) speakers = true;
          if (e.type === "enhanced") this.enhanced.refresh();
          // Notes written before the final layer may now be offered a re-enhance.
          if (e.type === "final.done") void this.enhanced.load();
        }
        if (notes) this.notepad.render();
        if (speakers) this.askPane.renderPresets();
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
    for (const li of byId("calls").children as unknown as Iterable<HTMLElement>) {
      li.querySelector("button")?.setAttribute("aria-current", String(li.dataset.id === id));
    }
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
    });
    const body = document.body;
    for (const c of ["ready", "recording", "paused", "saved", "offline", "failed", "other"]) {
      body.classList.toggle(c, c === st.cls);
    }
    byId("state").textContent = st.label;
    byId("meta").textContent = st.meta;
    const call = v?.call;
    byId("title").textContent = call
      ? [call.workspace, call.title].filter(Boolean).join(" · ")
      : "";
    document.title = call ? `${call.title || call.workspace} · akou` : "akou";
    this.pills(v, now);
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

  private pills(v: CallView | null, now: number): void {
    const tz = v?.call?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const clock = byId("pill-clock");
    clock.textContent = formatWall(now, tz);
    clock.title = `Times are local, ${formatZone(tz, now)}`;
    const ws = byId("pill-ws");
    ws.textContent = v?.call?.workspace ? `workspace: ${v.call.workspace}` : "";
    ws.hidden = !v?.call;
    const tpl = byId("pill-template");
    tpl.textContent = `template: ${v?.call?.template ?? "automatic"}`;
    tpl.hidden = !v?.call;
    const p = this.status?.provider;
    const prov = byId("pill-provider");
    prov.hidden = !p;
    if (p) {
      const name = p.harness ?? p.id;
      prov.textContent = `provider: ${name}${p.state === "available" ? "" : ` (${p.state})`}`;
      prov.title = p.detail ?? p.reason ?? "";
      prov.classList.toggle("warn", p.state === "unavailable");
    }
    const models = byId("pill-models");
    const asr = this.status?.asr;
    models.hidden = !asr;
    if (asr) {
      const used = v?.vocabUsed;
      models.textContent = `speech: ${asr.state}${used ? ` · ${used.entries.length} words` : ""}`;
      models.title = [asr.reason ?? "", used ? `Decode list: ${used.entries.join(", ")}` : ""]
        .filter(Boolean)
        .join("\n");
    }
    const review = byId("pill-review");
    const proposed = v?.proposals("proposed").length ?? 0;
    review.hidden = proposed === 0;
    review.textContent = `${proposed} ${proposed === 1 ? "word" : "words"} to review`;
    const langs = v ? languages(v) : [];
    const lang = byId("pill-lang");
    lang.hidden = langs.length === 0;
    lang.textContent = `languages: ${langs.join(", ")}`;
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
    byId<HTMLButtonElement>("stop").textContent =
      other && !mine ? "■ Stop the other call" : "■ Stop";
    const mute = byId<HTMLButtonElement>("mute");
    mute.textContent = v?.muted ? "Unmute mic" : "Mute mic";
    mute.classList.toggle("on", !!v?.muted);
    mute.disabled = !mine;
    const pause = byId<HTMLButtonElement>("pause");
    pause.textContent = v?.state === "paused" ? "Resume" : "Pause";
    pause.classList.toggle("on", v?.state === "paused");
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
    for (const ch of ["mic", "call"] as const) {
      const m = byId<HTMLMeterElement>(`meter-${ch}`);
      m.value = l ? Math.max(-60, Math.min(0, l[ch])) : -60;
      m.title = l ? `${ch}: ${Math.round(l[ch])} dBFS` : `${ch}: no level`;
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
  // The list of calls: by date and title, one open at a time, no search

  private async loadCalls(): Promise<void> {
    type Summary = {
      id: string;
      title: string;
      workspace: string;
      createdAt: number;
      state: string;
    };
    // Failed starts are listed apart by the API; the window shows them in the one list, marked.
    const [ok, failed] = await Promise.all([
      this.t.request<{ calls?: Summary[] }>("GET", "/calls?limit=200"),
      this.t.request<{ calls?: Summary[] }>("GET", "/calls?limit=50&failed=true"),
    ]);
    const calls = [...(ok.body.calls ?? []), ...(failed.body.calls ?? [])].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
    const live = this.status?.live?.call;
    replace(
      byId("calls"),
      ...calls.map((c) => {
        const when = new Date(c.createdAt);
        const date = new Intl.DateTimeFormat("en-CA", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(when);
        const time = new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(when);
        return h(
          "li",
          { attrs: { "data-id": c.id }, class: c.id === live ? "live" : c.state },
          h(
            "button",
            {
              type: "button",
              attrs: { "aria-current": String(c.id === this.callId) },
              on: { click: () => this.openCall(c.id, true) },
            },
            h("span", { class: "when" }, `${date} ${time}`),
            h("span", { class: "what" }, c.title || c.workspace),
            h("span", { class: "ws" }, c.workspace),
          ),
        );
      }),
    );
    const names = [...new Set(["default", ...calls.map((c) => c.workspace)])];
    replace(byId("workspaces"), ...names.map((n) => h("option", { value: n })));
    const ws = this.workspaceInput();
    if (!ws.value) ws.value = calls[0]?.workspace ?? "default";
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
    const btn = byId<HTMLButtonElement>("record");
    btn.disabled = true;
    const template = byId<HTMLSelectElement>("template").value;
    const r = await this.t.request<{ call?: string; error?: string }>("POST", "/calls", {
      workspace: this.workspaceInput().value.trim() || undefined,
      title: byId<HTMLInputElement>("newtitle").value.trim() || undefined,
      ...(template ? { template } : {}),
    });
    btn.disabled = false;
    const call = r.body.call;
    if (r.status === 201 && call) {
      byId<HTMLInputElement>("newtitle").value = "";
      this.startedHere = call;
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
  // Tabs: Notes, Ask, Enhanced

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
    if (this.platform === "linux" && this.view()?.live) {
      // PipeWire cannot keep the window's audio out of the recording (DESIGN 2.3).
      toast("akou does not play audio while a call is recording on Linux.");
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
