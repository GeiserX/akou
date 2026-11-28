/**
 * The voices akou knows, under Settings > Speakers (docs/DESIGN.md section 3.5): each person akou
 * recognises by voice, with the calls that taught the voice, the seconds of speech it learned
 * from and when it last heard them (`GET /voices`). Never a voiceprint: those stay in voices.yaml
 * on this computer.
 *
 * - **Rename** (`POST /voices/rename`) for every later call. A new name that is already in the list
 *   makes the two one person, so that press asks once more first.
 * - **Forget** one person, what one call taught about them, or every voice
 *   (`POST /voices/forget`). Nothing keeps a copy, so there is no undo: each asks once more first,
 *   as Delete does in the dictation history.
 * - **Off.** With `voices.enabled` off akou learns and names no voice, and the list says so. It
 *   still lists and forgets what akou kept; rename waits until it is on again.
 *
 * A toast says what happened in fixed words: it never carries a person's name.
 */

import { h, replace, toast } from "./dom.ts";
import { dayLabel, localZone, talkTime } from "./model.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";
import { ICONS, icon, row } from "./rows.ts";
import { twoStep } from "./server-common.ts";

export interface Voice {
  name: string;
  /** The calls that taught the voice, newest first. */
  calls: string[];
  /** Seconds of speech akou learned the voice from. */
  secs: number;
  /** When akou last heard them, ISO 8601. */
  lastSeen: string;
}

export interface VoicesHooks {
  /** A call as the calls list knows it, or undefined for one it does not list (trashed, gone). */
  call?: (id: string) => { title: string; createdAt: number } | undefined;
  /** Now, for "last heard Today". */
  now?: () => number;
}

/** The line under a person's name: `2 calls · 3 min of speech · last heard Today`. */
export function voiceFacts(v: Voice, now: number, tz: string): string {
  const calls = `${v.calls.length} call${v.calls.length === 1 ? "" : "s"}`;
  const heard = Date.parse(v.lastSeen);
  const last = Number.isFinite(heard) ? ` · last heard ${dayLabel(heard, now, tz)}` : "";
  return `${calls} · ${talkTime(v.secs)} of speech${last}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** When a call id (a ULID) was made, in epoch ms, from its first 10 characters; null if it is not one. */
export function ulidTime(id: string): number | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) return null;
  let t = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

/**
 * Whether a typed name differs from a saved one only by case. The store compares names exactly, so
 * `Ben` and `ben` are two people there; the window asks once to join such a name onto the saved
 * spelling, so a name typed in another case does not start a second person by mistake.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export class VoicesList {
  readonly root = h("section", {
    id: "settings-voices",
    class: "pg-section",
    attrs: { "data-section": "Voices" },
  });
  /** Null until the first read lands. */
  private voices: Voice[] | null = null;
  private error: string | null = null;
  /** The file is there but akou cannot read it: Forget all still deletes it. */
  private unreadable = false;
  private enabled = true;
  /** The person whose row is open. */
  private opened: string | null = null;
  private readonly armed = new Map<string, number>();
  private reads = 0;

  constructor(
    private readonly t: Transport,
    private readonly hooks: VoicesHooks = {},
  ) {
    this.draw();
  }

  /** Whether akou learns and names voices now (`voices.enabled`): the list says it when not. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.draw();
  }

  /** Reads the list again and draws it. */
  async load(): Promise<void> {
    const read = ++this.reads;
    const r = await this.t.request<{ voices?: Voice[] }>("GET", "/voices").catch(() => null);
    if (read !== this.reads) return;
    if (!r || r.status >= 400) {
      this.error = message(r?.body, "akou did not answer");
      this.unreadable =
        (r?.body as { error?: string } | undefined)?.error === "voices_file_invalid";
    } else {
      this.error = null;
      this.unreadable = false;
      this.voices = r.body.voices ?? [];
      if (this.opened && !this.voices.some((v) => v.name === this.opened)) this.opened = null;
    }
    this.draw();
  }

  private draw(): void {
    const n = this.voices?.length ?? 0;
    const help = this.enabled
      ? "The people akou names by voice in later calls."
      : "akou is not learning or naming voices now: Recognise voices across calls is off. What it kept is below, until you forget it.";
    const items: HTMLElement[] = [];
    if (this.error !== null) {
      items.push(h("li", {}, row({ label: "The voices could not be read", help: this.error })));
      if (this.unreadable) items.push(this.forgetAllRow());
    } else if (this.voices === null) {
      items.push(h("li", {}, row({ label: "Reading the voices…" })));
    } else if (n === 0) {
      items.push(
        h(
          "li",
          { class: "voices-none" },
          row({
            label: "No voices yet",
            help: this.enabled
              ? "Name a speaker in a call, and akou names that voice in later calls."
              : "akou keeps none.",
          }),
        ),
      );
    } else {
      for (const v of this.voices) items.push(this.person(v));
      items.push(this.forgetAllRow());
    }
    replace(
      this.root,
      h(
        "h2",
        { class: "pg-sec" },
        "Voices",
        n > 0 ? " " : null,
        n > 0 ? h("span", { class: "pg-count" }, String(n)) : null,
      ),
      h("p", { class: "pg-sechelp", attrs: { "data-voices": this.enabled ? "on" : "off" } }, help),
      h("ul", { class: "pg-grp pg-list" }, ...items),
    );
  }

  private person(v: Voice): HTMLElement {
    const open = this.opened === v.name;
    // clock: the page's own clock dates "last heard", unless a test hands it one.
    const now = this.hooks.now?.() ?? Date.now();
    const li = h("li", { class: "voice", attrs: { "data-name": v.name } });
    li.append(
      h(
        "button",
        {
          type: "button",
          class: `pg-row pg-link${open ? " open" : ""}`,
          attrs: { "aria-expanded": String(open) },
          on: {
            click: () => {
              this.opened = open ? null : v.name;
              this.draw();
              this.root
                .querySelector<HTMLElement>(`li[data-name="${CSS.escape(v.name)}"] .pg-link`)
                ?.focus();
            },
          },
        },
        h(
          "span",
          { class: "pg-lbl" },
          h("b", { class: "pg-name" }, v.name),
          h("span", { class: "pg-help" }, voiceFacts(v, now, localZone())),
        ),
        h("span", { class: "pg-ctl" }, h("span", { class: "pg-more" }, icon(...ICONS.chevron))),
      ),
    );
    if (!open) return li;
    if (this.enabled) li.append(this.renameRow(v));
    for (const call of v.calls) li.append(this.callRow(v, call, now));
    li.append(
      row(
        {
          label: "Forget this voice",
          help: "akou stops naming them by voice. Names already shown in calls stay.",
        },
        twoStep(
          {
            class: "pg-btn forget",
            label: "Forget",
            confirm: "Forget: sure?",
            id: `person:${v.name}`,
            armed: this.armed,
          },
          () => void this.forget({ name: v.name }, "Voice forgotten."),
        ),
      ),
    );
    return li;
  }

  /** The person's name in a field; a name already in the list joins the two after one more press. */
  private renameRow(v: Voice): HTMLElement {
    const id = `voice-rename-${(this.voices ?? []).indexOf(v)}`;
    const input = h("input", {
      id,
      class: "pg-input",
      value: v.name,
      attrs: { "aria-label": `New name for ${v.name}`, autocomplete: "off", spellcheck: "false" },
    });
    const go = h("button", { type: "submit", class: "pg-btn rename" }, "Rename");
    let joining = "";
    input.addEventListener("input", () => {
      joining = "";
      go.textContent = "Rename";
      go.classList.remove("armed");
    });
    const form = h(
      "form",
      {
        class: "pg-row voice-rename",
        on: {
          submit: (e) => {
            e.preventDefault();
            const to = input.value.trim();
            if (to === "" || to === v.name) return;
            // The name as typed first: `Ben` and `ben` can both be saved, as two people.
            const rest = (this.voices ?? []).filter((x) => x !== v);
            const other = rest.find((x) => x.name === to) ?? rest.find((x) => sameName(x.name, to));
            // Onto a name akou knows, the two become one person: that is asked once more.
            if (other && joining !== other.name) {
              joining = other.name;
              go.textContent = `Join with ${other.name}?`;
              go.classList.add("armed");
              return;
            }
            // The store matches names exactly: a join goes to the name as it is saved.
            void this.rename(v.name, other ? other.name : to);
          },
        },
      },
      h(
        "span",
        { class: "pg-lbl" },
        h("label", { class: "pg-name", attrs: { for: id } }, "Name"),
        h("span", { class: "pg-help" }, "For every later call."),
      ),
      h("span", { class: "pg-ctl" }, input, go),
    );
    return form;
  }

  /** One call that taught the voice, by its title as the calls list shows it. */
  private callRow(v: Voice, call: string, now: number): HTMLElement {
    const known = this.hooks.call?.(call);
    // A call the window has not loaded is never named by its id: its day comes from the id.
    const at = known?.createdAt ?? ulidTime(call);
    const label = known
      ? `Learned in ${known.title || "Untitled call"}`
      : "Learned in an older call";
    const help = at === null ? undefined : dayLabel(at, now, localZone());
    const r = row(
      { label, help },
      twoStep(
        {
          class: "pg-btn forget-call",
          label: "Forget this call",
          confirm: "Forget this call: sure?",
          id: `call:${v.name}:${call}`,
          armed: this.armed,
        },
        () => void this.forget({ name: v.name, call }, "What that call taught is forgotten."),
      ),
    );
    r.dataset.call = call;
    return r;
  }

  private forgetAllRow(): HTMLElement {
    return h(
      "li",
      { class: "voices-all" },
      row(
        {
          label: "Forget all voices",
          help: "Deletes every voiceprint and voices.yaml. This cannot be undone.",
        },
        twoStep(
          {
            class: "pg-btn forget-all",
            label: "Forget all",
            confirm: "Forget all: sure?",
            id: "all",
            armed: this.armed,
          },
          () => void this.forget({ all: true }, "Every voice is forgotten."),
        ),
      ),
    );
  }

  private async rename(from: string, to: string): Promise<void> {
    const r = await this.t.request("POST", "/voices/rename", { from, to }).catch(() => null);
    if (!r || r.status >= 400) {
      toast(message(r?.body, "the voice was not renamed"));
      return;
    }
    this.opened = to;
    toast("Renamed.", "info");
    await this.load();
  }

  private async forget(
    body: { name?: string; call?: string; all?: true },
    done: string,
  ): Promise<void> {
    const r = await this.t.request("POST", "/voices/forget", body).catch(() => null);
    if (!r || r.status >= 400) {
      toast(message(r?.body, "the voice was not forgotten"));
      return;
    }
    toast(done, "info");
    await this.load();
  }
}
