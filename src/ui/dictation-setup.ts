/**
 * Dictation's setup (docs/ux/DICTATION.md DC-N3), run by the master switch when a grant is
 * missing (DC-U2) or by the page's "Run the setup again". Four steps:
 *
 * 1. The microphone, with a live meter that proves audio arrives.
 * 2. Accessibility, on macOS only, with a button that opens its pane.
 * 3. The dictation key, with the recorder (DC-U3) and the current key filled in.
 * 4. "Try it": dictation is turned on, and a field in the page takes the first dictation.
 *
 * The page never asks the OS for a grant. It reads what the helper reports (`GET /dictation`,
 * from the helper's own checks, which never prompt) once a second while a grant step waits, and
 * goes on by itself when the grant arrives. A refused microphone leaves dictation off and says so.
 * A refused Accessibility grant leaves dictation usable in clipboard-only mode: akou copies each
 * dictation and the user pastes it, and the key is a Carbon hotkey, which binds chords only, so a
 * key held alone becomes `Control+Shift+Space`.
 */

import type { DictationGrants } from "./dictation-page.ts";
import { isAlone, keycaps } from "./dictation-recorder.ts";
import { h, replace, toast } from "./dom.ts";
import type { Transport } from "./protocol.ts";

export type SetupStep = "mic" | "accessibility" | "key" | "try";

/** How often a waiting grant step reads the grants again. */
export const GRANT_POLL_MS = 1000;

/** A level above this is a voice, not a quiet room: the meter says akou hears you. */
export const HEARD_DB = -50;

/** The key of the clipboard-only fallback, which binds chords only (DC-N3). */
export const FALLBACK_HOTKEY = "Control+Shift+Space";

/** A grant the helper has, or one the OS does not ask for. */
export const grantOk = (g: string | undefined): boolean => g === "granted" || g === "not-needed";

/** What the setup needs from the page it runs on. */
export interface SetupHost {
  readonly t: Transport;
  /** The OS akou runs on, from its status. */
  readonly platform: string;
  grants(): DictationGrants | null;
  /** A setting's value as saved. */
  setting(key: string): unknown;
  /** Reads the grants again (`GET /dictation`). */
  readGrants(): Promise<DictationGrants | null>;
  /** The dictation key's row, with its recorder; it saves on its own when a key is recorded. */
  keyRow(): { row: HTMLElement; input: HTMLInputElement };
  /** Stops the key's recorder, so the next step's field gets the keys. */
  stopKeys(): void;
  /** Saves one key alone: null, or the refusal's words. */
  save(key: string, value: unknown): Promise<string | null>;
  /** The setup ended, dictation on or left as it was: the page draws its settings again. */
  finish(): void;
}

export class DictationSetup {
  readonly root = h("section", {
    class: "dictation-setup",
    attrs: { "aria-label": "Set up dictation" },
  });
  private step: SetupStep = "mic";
  private timer: ReturnType<typeof setInterval> | null = null;
  private meter: { close(): void } | null = null;
  /** Accessibility refused and clipboard-only chosen: akou copies, and the key is a chord. */
  private clipboardOnly = false;

  constructor(private readonly host: SetupHost) {}

  start(): void {
    this.clipboardOnly = false;
    this.go("mic");
  }

  /** Stops the grant reads and the meter: the setup ended or the page closed. */
  stop(): void {
    this.host.stopKeys();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.meter?.close();
    this.meter = null;
  }

  private get mac(): boolean {
    return this.host.platform === "darwin";
  }

  private go(step: SetupStep): void {
    this.stop();
    this.step = step;
    if (step === "mic" || step === "accessibility") {
      this.timer = setInterval(() => void this.poll(), GRANT_POLL_MS);
    }
    this.draw();
  }

  /** Reads the grants again while a grant step waits; a change redraws or moves on. */
  private async poll(): Promise<void> {
    const before = this.host.grants();
    const g = await this.host.readGrants();
    if (!this.timer || !g) return;
    if (this.step === "mic" && grantOk(g.mic) !== grantOk(before?.mic)) this.draw();
    if (this.step === "accessibility" && grantOk(g.accessibility)) this.go("key");
  }

  /** The step after the microphone: Accessibility where macOS asks for it, else the key. */
  private afterMic(): void {
    const a = this.host.grants()?.accessibility;
    this.go(this.mac && !grantOk(a) ? "accessibility" : "key");
  }

  private draw(): void {
    const n = { mic: 1, accessibility: 2, key: 3, try: 4 }[this.step];
    const body =
      this.step === "mic"
        ? this.micStep()
        : this.step === "accessibility"
          ? this.accessibilityStep()
          : this.step === "key"
            ? this.keyStep()
            : this.tryStep();
    replace(
      this.root,
      h("h3", {}, `Set up dictation, step ${n} of 4`),
      ...body,
      this.step === "try"
        ? null
        : h(
            "button",
            {
              type: "button",
              id: "dictation-setup-cancel",
              on: { click: () => this.leave() },
            },
            "Cancel",
          ),
    );
    this.root.dataset.step = this.step;
  }

  private leave(): void {
    this.stop();
    this.host.finish();
  }

  /** A button that opens a privacy pane, or says to open it by hand where this surface cannot. */
  private paneButton(pane: "microphone" | "accessibility", label: string): HTMLElement {
    return h(
      "button",
      {
        type: "button",
        id: `dictation-setup-open-${pane}`,
        on: {
          click: () =>
            void this.host.t.openSettingsPane(pane).then((ok) => {
              if (!ok)
                toast("Open the privacy settings yourself: this window cannot open them here.");
            }),
        },
      },
      label,
    );
  }

  private where(pane: string): string {
    return this.mac
      ? `System Settings, Privacy & Security, ${pane}`
      : `Settings, Privacy & security, ${pane}`;
  }

  private micStep(): HTMLElement[] {
    this.meter?.close();
    this.meter = null;
    const g = this.host.grants();
    if (!grantOk(g?.mic)) {
      // Linux has no microphone grant to turn on: akou hears whatever PipeWire or PulseAudio gives.
      const linux = this.host.platform === "linux";
      return [
        h("h4", {}, "Microphone"),
        h(
          "p",
          { id: "dictation-setup-note", class: "notice", role: "note" },
          linux
            ? "akou cannot open the microphone, so dictation stays off. Check that PipeWire or PulseAudio is running and a microphone is connected; this step goes on by itself once akou hears it."
            : `akou has no access to the microphone, so dictation stays off. Turn akou on in ${this.where("Microphone")}; this step goes on by itself once you do.`,
        ),
        linux ? null : this.paneButton("microphone", "Open Microphone settings"),
      ].filter((x) => x !== null);
    }
    const meter = h("meter", {
      id: "dictation-setup-level",
      attrs: { min: "-60", max: "0", low: "-50", value: "-60", "aria-label": "Microphone level" },
    });
    const heard = h(
      "p",
      { id: "dictation-setup-heard", attrs: { role: "status" } },
      this.host.t.dictationLevels
        ? "Say something: the bar moves when akou hears you."
        : "The level shows in the akou window.",
    );
    this.meter =
      this.host.t.dictationLevels?.((db) => {
        // The meter holds a level to its range itself; a non-number would throw.
        if (!Number.isFinite(db)) return;
        meter.value = db;
        if (db > HEARD_DB) heard.textContent = "akou hears you.";
      }) ?? null;
    return [
      h("h4", {}, "Microphone"),
      h("p", {}, "akou can use the microphone."),
      meter,
      heard,
      h(
        "button",
        {
          type: "button",
          class: "go",
          id: "dictation-setup-next",
          on: { click: () => this.afterMic() },
        },
        "Continue",
      ),
    ];
  }

  private accessibilityStep(): HTMLElement[] {
    return [
      h("h4", {}, "Accessibility"),
      h(
        "p",
        { id: "dictation-setup-note", class: "notice", role: "note" },
        `akou needs Accessibility to hear its key in every app and to paste where you are typing. Turn akou on in ${this.where("Accessibility")}; this step goes on by itself once you do.`,
      ),
      this.paneButton("accessibility", "Open Accessibility settings"),
      h(
        "p",
        { class: "hint" },
        "Without it dictation still works: akou copies what you say and you paste it, and the key must be a chord.",
      ),
      h(
        "button",
        {
          type: "button",
          id: "dictation-setup-clipboard",
          on: {
            click: () => {
              this.clipboardOnly = true;
              this.go("key");
            },
          },
        },
        "Use clipboard only",
      ),
    ];
  }

  private keyStep(): HTMLElement[] {
    const { row, input } = this.host.keyRow();
    let note = "Hold it to talk and release it to insert; a short tap latches it.";
    if (this.clipboardOnly && isAlone(input.value)) {
      // The key held alone cannot be bound without the grant; the chord takes its place.
      input.value = FALLBACK_HOTKEY;
      input.dispatchEvent(new Event("input"));
      note = `Without Accessibility akou binds its key as a Carbon hotkey, which takes chords only, so your key is ${FALLBACK_HOTKEY}. Record another chord if you like.`;
    }
    const issue = h("p", { id: "dictation-setup-issue", class: "issue", attrs: { role: "alert" } });
    issue.hidden = true;
    const on = async () => {
      const wrong =
        (input.value !== String(this.host.setting("dictation.hotkey") ?? "")
          ? await this.host.save("dictation.hotkey", input.value)
          : null) ?? (await this.host.save("dictation.enabled", true));
      if (wrong) {
        issue.textContent = wrong;
        issue.hidden = false;
        return;
      }
      this.go("try");
    };
    return [
      h("h4", {}, "Your dictation key"),
      h("p", { id: "dictation-setup-note" }, note),
      row,
      issue,
      h(
        "button",
        { type: "button", class: "go", id: "dictation-setup-next", on: { click: () => void on() } },
        "Turn dictation on",
      ),
    ];
  }

  private tryStep(): HTMLElement[] {
    const key = String(this.host.setting("dictation.hotkey") ?? "");
    const caps = keycaps(key, this.host.platform).join(" ");
    const paste = this.mac ? "⌘V" : "Ctrl+V";
    return [
      h("h4", {}, "Try it"),
      h(
        "p",
        { id: "dictation-setup-note" },
        this.clipboardOnly
          ? `Click in the field, hold ${caps}, say a few words and let go. akou copies what you said: press ${paste} to paste it here. It does the same in every app.`
          : `Click in the field, hold ${caps}, say a few words and let go. The text lands here, and the same key works in every app.`,
      ),
      h("textarea", {
        id: "dictation-try",
        attrs: { rows: "3", "aria-label": "Try dictation here" },
      }),
      h(
        "button",
        {
          type: "button",
          class: "go",
          id: "dictation-setup-done",
          on: { click: () => this.leave() },
        },
        "Done",
      ),
    ];
  }
}
