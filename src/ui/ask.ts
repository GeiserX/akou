/**
 * The ask box (docs/DESIGN.md sections 5.3, 5.4 and 7): a question about the call, answered by the
 * user's own provider. The matching excerpts come first, as evidence cards, before any model runs;
 * the answer streams in token by token; its wall-clock citations (`[15:41 Ben]`) are chips that
 * show the time, name the speaker in their label, and scroll to the line and play it. When no model can answer, the excerpts stay, the reason is said
 * plainly, and "Copy context for my agent" hands the pack to the user's own agent.
 *
 * The box is the top of the side column, always there (WINDOW section 6.2). Under it the column
 * shows one question and its answer card: the last one asked here, or, until one is, the call's
 * last answered question from the log.
 *
 * Presets, in a small menu on the input, come from `GET /presets` (PROGRAMMABILITY PG-F2): the
 * shipped files ("Catch me up", "Was my name mentioned?", "Decisions so far", "Action items", and
 * "What did <speaker> say?" for each named speaker) and the user's own. They are asked again each
 * time the menu opens, so a new file shows without a restart. Everything shown is text, never
 * markup.
 *
 * With no assistant (`provider.kind` none) the box is a search of the call: it reads "Search this
 * call", has no suggested questions, and shows only the lines that match, labelled as excerpts,
 * with no answer card and no reason naming a setting. A search writes nothing to the call. Until
 * the first status says which, the box shows neither Ask's words nor Search's. With an assistant
 * it is Ask again.
 *
 * A question typed here goes first to the agent following the call, when one is (DESIGN 5.5): a
 * muted line under the box names it, the status says it was sent and how long the box waits, and
 * its answer is labelled "answered by <client> (the agent following the call)". With an agent
 * following, the box asks even with no assistant. An answer that arrives later, from the agent or
 * the provider, is added under the first, never replacing it; a call opened later shows them all.
 *
 * With an assistant, focus in the box and typing in it ask the app to get the provider ready
 * (`POST /provider/warm`, at most every `WARM_EVERY_MS`), and so does an answer arriving while the
 * box has focus: the harness then starts while the user types instead of after Enter (#383).
 */

import { formatWall } from "../core/log/clock.ts";
import type { CallView } from "../core/log/fold.ts";
import { parseNaming } from "../main/query/classify.ts";
import { byId, h, replace, toast } from "./dom.ts";
import { askUnavailable, resolveTimeCitation, splitCitations } from "./model.ts";
import type { AskAnswer, Transport } from "./protocol.ts";

export interface AskDeps {
  t: Transport;
  call(): string | null;
  view(): CallView | null;
  /** Scrolls to a line and plays it. */
  cite(lineId: string): void;
}

/** Draws text with its citations as buttons; `cites` are the segment ids the answer names. */
export function citedText(
  text: string,
  view: CallView | null,
  cites: readonly string[],
  cite: (id: string) => void,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  const tz = view?.call?.tz ?? "UTC";
  for (const p of splitCitations(text)) {
    if (p.kind === "text") {
      out.push(h("span", {}, p.text));
      continue;
    }
    const id =
      p.kind === "seg" ? p.id : view ? resolveTimeCitation(view, p.time, p.speaker, cites) : null;
    // The chip shows the time alone, as b2 draws it; its label names the speaker too.
    let label = p.text;
    let time = p.kind === "time" ? p.time : p.text;
    if (p.kind === "seg" && view) {
      const l = view.resolve(p.id);
      if (l) {
        time = formatWall(l.w0, tz, { seconds: false });
        label = `${time} ${l.speaker}`;
      }
    } else if (p.kind === "time") label = `${p.time} ${p.speaker}`;
    if (!id) {
      out.push(h("span", { class: "cite missing" }, p.text));
      continue;
    }
    out.push(
      h(
        "button",
        {
          class: "cite",
          type: "button",
          attrs: { "data-line": id, "aria-label": `Show and play ${label}`, title: label },
          on: { click: () => cite(id) },
        },
        time,
      ),
    );
  }
  return out;
}

/** The box's words when an assistant answers, and when it only searches the call. */
const WORDS = {
  ask: { box: "Ask about this call", field: "Question", go: "Ask" },
  search: { box: "Search this call", field: "Words to find", go: "Search" },
} as const;

/** An excerpt line as the pack renders it, `#l000031 15:41:07 Ben: text`, without the line id. */
export function excerptLine(line: string): string {
  return line.replace(/^#[lf]\d{6,} /, "");
}

/** The status words for one answer: who answered it. */
export function answerLabel(a: { by?: string; model?: string }): string {
  if (a.by?.startsWith("agent:")) {
    return `answered by ${a.by.slice("agent:".length)} (the agent following the call)`;
  }
  return a.model ? `answered by ${a.model}` : "";
}

/** One answer told apart from the others to the same question: who gave it, and its text. */
function answerKey(a: { by?: string; text: string }): string {
  return `${a.by ?? ""}\n${a.text}`;
}

/** How often the box asks the app to keep the provider ready while it has focus. */
export const WARM_EVERY_MS = 20_000;

export class AskPane {
  private readonly form = byId<HTMLFormElement>("ask-form");
  private readonly input = byId<HTMLInputElement>("ask-input");
  private readonly go = byId<HTMLButtonElement>("ask-go");
  /** No assistant: the box searches the call instead of asking it. Null until the first status. */
  private searching: boolean | null = null;
  private readonly menuButton = byId<HTMLButtonElement>("ask-presets-open");
  private readonly presetsBox = byId("ask-presets");
  private readonly out = byId("ask-out");
  private running: { cancel(): void } | null = null;
  private presetKey = "";
  /** The ask whose answer is on screen when it came from the log, not from a question asked here. */
  private shown: string | null = null;
  /** When the box last asked the app to get the provider ready (`warm`). */
  private warmedAt = 0;
  /**
   * The question asked here whose card is open: how many of the call's answers to it were already
   * there when its card was drawn, and the answer the card itself shows (author and text), which
   * is skipped once if it reaches the call after the card did.
   */
  private open: { ask: string; drawn: number; card: HTMLElement; main: string | null } | null =
    null;
  /** The muted line under the box naming the agents that get its questions first. */
  private readonly route = h("p", { class: "ask-route", attrs: { hidden: "" } });

  constructor(private readonly d: AskDeps) {
    this.form.after(this.route);
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.ask(this.input.value);
    });
    this.input.addEventListener("focus", () => this.warm());
    this.input.addEventListener("input", () => this.warm());
    // The presets are a small menu on the input, not a row of buttons (WINDOW section 6.2).
    this.menuButton.addEventListener("click", () =>
      this.menu(this.presetsBox.hasAttribute("hidden")),
    );
    this.presetsBox.addEventListener("keydown", (e) => {
      const items = [...this.presetsBox.querySelectorAll<HTMLButtonElement>("button")];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (d && items.length > 0) {
        e.preventDefault();
        items[(at + d + items.length) % items.length]?.focus();
      }
    });
    // Escape closes an open menu from anywhere in the ask row, the input included.
    this.form.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || this.presetsBox.hidden) return;
      e.preventDefault();
      const inMenu = this.presetsBox.contains(document.activeElement);
      this.menu(false);
      if (inMenu) this.menuButton.focus();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!this.presetsBox.hidden && !this.form.contains(e.target as Node)) this.menu(false);
    });
    // Focus leaving for a known element outside the row closes the menu. A null target is not
    // enough: WebKit does not focus a clicked button, so a click on a preset or the chevron blurs
    // to nothing between mousedown and click, and closing then would swallow the click. Clicks
    // outside are the pointerdown handler's job.
    this.form.addEventListener("focusout", (e) => {
      if (e.relatedTarget && !this.form.contains(e.relatedTarget as Node)) this.menu(false);
    });
  }

  /** The agents following the call's questions, from the status: named in the muted line. */
  setListening(clients: readonly string[]): void {
    const text =
      clients.length > 0
        ? `Questions go to ${clients.join(" and ")}, which ${clients.length > 1 ? "are" : "is"} following this call.`
        : "";
    if (this.route.textContent === text) return;
    this.route.textContent = text;
    // The line is cut to one line in a narrow pane; the whole sentence stays in its tooltip.
    this.route.title = text;
    this.route.toggleAttribute("hidden", text === "");
  }

  /** Search when no assistant is set up, Ask when one is (the status's `provider.id`). */
  setSearch(on: boolean): void {
    if (on === this.searching) return;
    this.searching = on;
    const w = on ? WORDS.search : WORDS.ask;
    this.form.classList.remove("unset");
    this.form.classList.toggle("search", on);
    this.form.setAttribute("aria-label", w.box);
    this.input.placeholder = w.box;
    this.input.setAttribute("aria-label", w.field);
    this.go.title = `${w.go} (Enter)`;
    const label = this.go.querySelector(".vh");
    if (label) label.textContent = w.go;
    if (on) this.menu(false);
  }

  private menu(open: boolean): void {
    if (open) this.renderPresets();
    this.presetsBox.hidden = !open;
    this.menuButton.setAttribute("aria-expanded", String(open));
    if (open) this.presetsBox.querySelector<HTMLButtonElement>("button")?.focus();
  }

  reset(): void {
    this.running?.cancel();
    this.running = null;
    this.shown = null;
    this.open = null;
    this.menu(false);
    replace(this.out);
    this.renderPresets();
  }

  /**
   * A speaker was named or merged: an open menu asks for its presets again; a closed one asks when
   * it opens, so a rename sends nothing more while the menu is shut.
   */
  speakersChanged(): void {
    if (!this.presetsBox.hidden) this.renderPresets();
  }

  /**
   * The presets filled in for the open call, with one "What did X say?" per named speaker. The
   * menu is redrawn only when they changed, so focus inside an open menu stays put.
   */
  renderPresets(): void {
    const call = this.d.call();
    if (!call) return;
    void this.d.t
      .request<{ presets: { label: string; question: string }[] }>(
        "GET",
        `/presets?call=${encodeURIComponent(call)}`,
      )
      .then(
        (r) => {
          if (r.status === 200 && this.d.call() === call) this.drawPresets(call, r.body.presets);
        },
        () => {},
      );
  }

  private drawPresets(call: string, list: readonly { label: string; question: string }[]): void {
    const k = JSON.stringify([call, list.map((p) => [p.label, p.question])]);
    if (k === this.presetKey) return;
    this.presetKey = k;
    replace(
      this.presetsBox,
      ...list.map((p) =>
        h(
          "button",
          {
            class: "preset",
            type: "button",
            role: "menuitem",
            on: {
              click: () => {
                this.menu(false);
                this.ask(p.question);
              },
            },
          },
          p.label,
        ),
      ),
    );
  }

  /**
   * The call's last answered question, drawn from the log when nothing was asked here yet: a
   * saved call opens on its last cited answer, and an agent's question shows when it lands.
   */
  restore(): void {
    // A question asked here keeps its card; later answers to it are added under it.
    if (this.open && !this.running && this.open.ask !== this.shown) {
      this.more();
      return;
    }
    if (this.running || (this.out.childElementCount > 0 && this.shown === null)) return;
    const v = this.d.view();
    const last = v
      ?.qa()
      .filter((x) => x.answer)
      .at(-1);
    if (!last?.answer) return;
    // The card drawn from the log is open too: an answer that lands later goes under it.
    if (last.ask.id === this.shown) {
      this.more();
      return;
    }
    this.shown = last.ask.id;
    const by = last.ask.by === "user" ? "" : `asked by ${last.ask.by.replace(/^agent:/, "agent ")}`;
    const block = this.block(last.ask.q);
    const [first, ...rest] = last.answers;
    if (!first) return;
    block.status.textContent = [by, answerLabel(first)].filter(Boolean).join(" · ");
    block.status.title = block.status.textContent;
    replace(block.answer, ...citedText(first.text, v ?? null, first.cites, this.d.cite));
    for (const a of rest) block.card.append(this.extra(a));
    replace(this.out, block.root);
    this.open = { ask: last.ask.id, drawn: last.answers.length, card: block.card, main: null };
  }

  /** Answers to the open question that arrived after its card was drawn, added under it. */
  private more(): void {
    const open = this.open;
    const qa = open
      ? this.d
          .view()
          ?.qa()
          .find((x) => x.ask.id === open.ask)
      : undefined;
    if (!open || !qa) return;
    for (const a of qa.answers.slice(open.drawn)) {
      // The answer the card shows can reach the call after the card: it is drawn once, not twice.
      if (open.main !== null && answerKey(a) === open.main) {
        open.main = null;
        continue;
      }
      open.card.append(this.extra(a));
    }
    open.drawn = Math.max(open.drawn, qa.answers.length);
  }

  /** One more answer to a question already answered: its own label, then its cited text. */
  private extra(a: { by?: string; model: string; text: string; cites: string[] }): HTMLElement {
    const label = answerLabel(a);
    return h(
      "div",
      { class: "more-answer" },
      h("span", { class: "ask-status", attrs: { title: label } }, label),
      h("div", { class: "answer" }, ...citedText(a.text, this.d.view(), a.cites, this.d.cite)),
    );
  }

  /** One question and its answer card, with the matching excerpts under it. */
  private block(q: string): {
    root: HTMLElement;
    cards: HTMLElement;
    status: HTMLElement;
    answer: HTMLElement;
    card: HTMLElement;
  } {
    const cards = h("div", { class: "evidence" });
    const answer = h("div", { class: "answer", attrs: { "aria-live": "polite" } });
    const status = h("span", { class: "ask-status" });
    const card = h(
      "div",
      { class: "a-card" },
      h("div", { class: "lbl" }, "Answer", status),
      answer,
    );
    const root = h("section", { class: "qa" }, h("p", { class: "question" }, q), card, cards);
    return { root, cards, status, answer, card };
  }

  /** The excerpts as cards: each with its citation chip, then its lines. */
  private cards(excerpts: readonly { citation: string; lines: string[] }[]): HTMLElement[] {
    return excerpts.map((x) =>
      h(
        "article",
        { class: "card" },
        h("div", { class: "card-cite" }, ...citedText(x.citation, this.d.view(), [], this.d.cite)),
        ...x.lines.map((l) => h("p", {}, excerptLine(l))),
      ),
    );
  }

  /**
   * "Copy context for my agent": the hand-off the app built (the question, then where the agent
   * reads the call), for the user's own agent. Never the pack itself: pasted, it buries the question.
   */
  private copyContext(handoff: string): HTMLElement {
    return h(
      "button",
      {
        class: "copy-context",
        type: "button",
        on: {
          click: () =>
            void navigator.clipboard.writeText(handoff).then(
              () =>
                toast(
                  "The question and where to read the call are on the clipboard: paste them to your agent.",
                  "info",
                ),
              () => toast("The clipboard is not available here."),
            ),
        },
      },
      "Copy context for my agent",
    );
  }

  /**
   * Asks the app to get the provider ready for a question (the harness starts its program now).
   * Only with an assistant, and at most every `WARM_EVERY_MS`; `again` skips the wait, after an
   * answer took the started one.
   */
  private warm(again = false): void {
    if (this.searching !== false) return;
    const now = Date.now(); // clock: the page's own clock, only to space out its requests
    if (!again && now - this.warmedAt < WARM_EVERY_MS) return;
    this.warmedAt = now;
    void this.d.t.request("POST", "/provider/warm", {}).catch(() => {});
  }

  ask(question: string): void {
    const q = question.trim();
    const call = this.d.call();
    if (q === "" || !call) return;
    this.running?.cancel();
    this.input.value = "";
    this.shown = null;
    this.open = null;
    if (this.searching) {
      this.search(call, q);
      return;
    }
    const { root, cards, status, answer, card } = this.block(q);
    answer.classList.add("streaming");
    status.textContent = "Looking in the call…";
    // The last question and its answer are what the column shows (WINDOW section 6.2).
    replace(this.out, root);
    let streamed = "";
    this.running = this.d.t.ask(call, q, {
      excerpts: (data) => {
        replace(cards, ...this.cards(data.excerpts));
        status.textContent = "Asking…";
      },
      routed: (r) => {
        if (r.to === "agent") {
          const who = (r.clients ?? []).join(" and ") || "the agent following the call";
          status.textContent = `Sent to ${who}, waiting up to ${r.waitSeconds ?? 0} s`;
        } else {
          status.textContent = r.why ? `Asking akou's assistant: ${r.why}` : "Asking…";
        }
        status.title = status.textContent;
      },
      token: (t) => {
        streamed += t;
        answer.textContent = streamed;
      },
      answer: (a: AskAnswer) => {
        this.running = null;
        answer.classList.remove("streaming");
        status.title = "";
        // Answers that land later (the agent after the provider, or the other way) go under this one.
        if (a.ask && a.kind !== "naming") {
          // This card shows only its own answer, so every logged answer but that one is still to
          // draw, one that landed while the question ran included (the log follow skips a running
          // card).
          this.open = { ask: a.ask, drawn: 0, card, main: a.answered ? answerKey(a) : null };
          this.more();
        }
        // The question took the harness started early: start the next one for a follow-up.
        if (document.activeElement === this.input) this.warm(true);
        if (a.kind === "naming") {
          status.textContent = "";
          replace(answer, h("span", {}, a.text));
          return;
        }
        if (a.answered) {
          status.textContent = answerLabel(a);
          status.title = status.textContent;
          replace(answer, ...citedText(a.text, this.d.view(), a.cites, this.d.cite));
          return;
        }
        status.textContent = "No answer";
        // One line: which route did not answer and why, never a quiet switch to the excerpts.
        const why = askUnavailable(a.reason, a.errorKind);
        const route = a.route
          ? `${a.route[0]?.toUpperCase()}${a.route.slice(1)} did not answer. `
          : "";
        // Both routes that failed, in one line: the agent following the call, then the provider.
        const agent = a.agentReason
          ? `${a.agentReason[0]?.toUpperCase()}${a.agentReason.slice(1)}. `
          : "";
        answer.replaceChildren(
          h(
            "span",
            {},
            `${agent}${route}${why ? `${why} ` : ""}The excerpts below are what matched.`,
          ),
        );
        if (a.handoff) answer.append(this.copyContext(a.handoff));
      },
      error: (e) => {
        this.running = null;
        answer.classList.remove("streaming");
        status.textContent = `The question failed: ${e.message}`;
      },
    });
  }

  /**
   * No assistant: the words are a search of the call (`GET /calls/{id}/search`), which writes
   * nothing to the call and shows only lines that match, under one muted label, never an answer
   * card. "Speaker 2 is Ben" still names the speaker. "Copy context for my agent" copies the hand-off
   * of `POST /calls/{id}/context`, which changes nothing either.
   */
  private search(call: string, q: string): void {
    const found = h(
      "p",
      { class: "found", attrs: { "aria-live": "polite" } },
      "Looking in the call…",
    );
    const cards = h("div", { class: "evidence" });
    const root = h(
      "section",
      { class: "qa search" },
      h("p", { class: "question" }, q),
      found,
      cards,
    );
    replace(this.out, root);
    const failed = (message: string) => {
      found.textContent = `The search failed: ${message}`;
      found.classList.add("failed");
    };
    if (parseNaming(q)) {
      this.running = this.d.t.ask(call, q, {
        excerpts: () => {},
        token: () => {},
        answer: (a: AskAnswer) => {
          this.running = null;
          found.textContent = a.text;
        },
        error: (e) => {
          this.running = null;
          failed(e.message);
        },
      });
      return;
    }
    let cancelled = false;
    const run = { cancel: () => (cancelled = true) };
    this.running = run;
    const path = `/calls/${encodeURIComponent(call)}`;
    void this.d.t
      .request<{ hits?: { citation: string; lines: string[] }[]; message?: string }>(
        "GET",
        `${path}/search?q=${encodeURIComponent(q)}`,
      )
      .then(
        (r) => {
          if (cancelled) return;
          if (this.running === run) this.running = null;
          if (r.status !== 200 || !r.body?.hits) {
            failed(r.body?.message ?? `HTTP ${r.status}`);
            return;
          }
          const hits = r.body.hits;
          replace(cards, ...this.cards(hits));
          found.textContent =
            hits.length > 0 ? "Excerpts from the call" : "No line has these words.";
          // The pack is fetched now, not on the click: WebKit copies only inside the click itself.
          void this.d.t
            .request<{ handoff?: string }>("POST", `${path}/context`, { question: q })
            .then(
              (c) => {
                if (!cancelled && c.status === 200 && typeof c.body?.handoff === "string")
                  root.append(this.copyContext(c.body.handoff));
              },
              () => {},
            );
        },
        (err: Error) => {
          if (cancelled) return;
          if (this.running === run) this.running = null;
          failed(err.message);
        },
      );
  }
}
