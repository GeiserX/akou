/**
 * The ask box (docs/DESIGN.md sections 5.3, 5.4 and 7): a question about the call, answered by the
 * user's own provider. The matching excerpts come first, as evidence cards, before any model runs;
 * the answer streams in token by token; its wall-clock citations (`[15:41 Ben]`) are buttons that
 * scroll to the line and play it. When no model can answer, the excerpts stay, the reason is said
 * plainly, and "Copy context for my agent" hands the pack to the user's own agent.
 *
 * The box is the top of the side column, always there (WINDOW section 6.2). Under it the column
 * shows one question and its answer card: the last one asked here, or, until one is, the call's
 * last answered question from the log.
 *
 * Presets, in a small menu on the input: "Catch me up", "Was my name mentioned?", "Decisions so
 * far", "Action items", and "What did <speaker> say?" for each named speaker. Everything shown is
 * text, never markup.
 */

import { formatWall } from "../core/log/clock.ts";
import type { CallView } from "../core/log/fold.ts";
import { byId, h, replace, toast } from "./dom.ts";
import { presets, resolveTimeCitation, splitCitations } from "./model.ts";
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
    let label = p.text;
    if (p.kind === "seg" && view) {
      const l = view.resolve(p.id);
      if (l) label = `[${formatWall(l.w0, tz, { seconds: false })} ${l.speaker}]`;
    }
    if (!id) {
      out.push(h("span", { class: "cite missing" }, label));
      continue;
    }
    out.push(
      h(
        "button",
        {
          class: "cite",
          type: "button",
          attrs: { "data-line": id, "aria-label": `Show and play ${label}` },
          on: { click: () => cite(id) },
        },
        label,
      ),
    );
  }
  return out;
}

export class AskPane {
  private readonly form = byId<HTMLFormElement>("ask-form");
  private readonly input = byId<HTMLInputElement>("ask-input");
  private readonly menuButton = byId<HTMLButtonElement>("ask-presets-open");
  private readonly presetsBox = byId("ask-presets");
  private readonly out = byId("ask-out");
  private running: { cancel(): void } | null = null;
  private presetKey = "";
  /** The ask whose answer is on screen when it came from the log, not from a question asked here. */
  private shown: string | null = null;

  constructor(private readonly d: AskDeps) {
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.ask(this.input.value);
    });
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
    this.form.addEventListener("focusout", (e) => {
      if (!this.form.contains(e.relatedTarget as Node | null)) this.menu(false);
    });
  }

  private menu(open: boolean): void {
    this.presetsBox.hidden = !open;
    this.menuButton.setAttribute("aria-expanded", String(open));
    if (open) this.presetsBox.querySelector<HTMLButtonElement>("button")?.focus();
  }

  reset(): void {
    this.running?.cancel();
    this.running = null;
    this.shown = null;
    this.menu(false);
    replace(this.out);
    this.renderPresets();
  }

  /** The presets, with one "What did X say?" per named speaker. */
  renderPresets(): void {
    const v = this.d.view();
    const names = (v?.roster() ?? [])
      .filter((s) => s.spk !== "you" && !s.mergedInto && s.name)
      .map((s) => s.label);
    const k = names.join("\n");
    if (k === this.presetKey && this.presetsBox.childElementCount > 0) return;
    this.presetKey = k;
    replace(
      this.presetsBox,
      ...presets(names).map((p) =>
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
    if (this.running || (this.out.childElementCount > 0 && this.shown === null)) return;
    const v = this.d.view();
    const last = v
      ?.qa()
      .filter((x) => x.answer)
      .at(-1);
    if (!last?.answer || last.ask.id === this.shown) return;
    this.shown = last.ask.id;
    const by = last.ask.by === "user" ? "" : `asked by ${last.ask.by.replace(/^agent:/, "agent ")}`;
    const block = this.block(last.ask.q);
    block.status.textContent = [by, last.answer.model ? `answered by ${last.answer.model}` : ""]
      .filter(Boolean)
      .join(" · ");
    replace(
      block.answer,
      ...citedText(last.answer.text, v ?? null, last.answer.cites, this.d.cite),
    );
    replace(this.out, block.root);
  }

  /** One question and its answer card, with the matching excerpts under it. */
  private block(q: string): {
    root: HTMLElement;
    cards: HTMLElement;
    status: HTMLElement;
    answer: HTMLElement;
  } {
    const cards = h("div", { class: "evidence" });
    const answer = h("div", { class: "answer", attrs: { "aria-live": "polite" } });
    const status = h("span", { class: "ask-status" });
    const root = h(
      "section",
      { class: "qa" },
      h("p", { class: "question" }, q),
      h("div", { class: "a-card" }, h("div", { class: "lbl" }, "Answer", status), answer),
      cards,
    );
    return { root, cards, status, answer };
  }

  ask(question: string): void {
    const q = question.trim();
    const call = this.d.call();
    if (q === "" || !call) return;
    this.running?.cancel();
    this.input.value = "";
    this.shown = null;
    const { root, cards, status, answer } = this.block(q);
    answer.classList.add("streaming");
    status.textContent = "Looking in the call…";
    // The last question and its answer are what the column shows (WINDOW section 6.2).
    replace(this.out, root);
    let streamed = "";
    this.running = this.d.t.ask(call, q, {
      excerpts: (data) => {
        replace(
          cards,
          ...data.excerpts.map((x) =>
            h(
              "article",
              { class: "card" },
              h(
                "div",
                { class: "card-cite" },
                ...citedText(x.citation, this.d.view(), [], this.d.cite),
              ),
              ...x.lines.map((l) => h("p", {}, l)),
            ),
          ),
        );
        status.textContent = "Asking…";
      },
      token: (t) => {
        streamed += t;
        answer.textContent = streamed;
      },
      answer: (a: AskAnswer) => {
        this.running = null;
        answer.classList.remove("streaming");
        if (a.kind === "naming") {
          status.textContent = "";
          replace(answer, h("span", {}, a.text));
          return;
        }
        if (a.answered) {
          status.textContent = a.model ? `answered by ${a.model}` : "";
          replace(answer, ...citedText(a.text, this.d.view(), a.cites, this.d.cite));
          return;
        }
        status.textContent = "No answer";
        answer.replaceChildren(
          h(
            "span",
            {},
            a.reason
              ? `${a.reason}. The excerpts below are what matched.`
              : "The excerpts below are what matched.",
          ),
        );
        if (a.context) {
          const ctx = a.context;
          answer.append(
            h(
              "button",
              {
                class: "copy-context",
                type: "button",
                on: {
                  click: () =>
                    void navigator.clipboard.writeText(ctx).then(
                      () =>
                        toast("The context is on the clipboard: paste it to your agent.", "info"),
                      () => toast("The clipboard is not available here."),
                    ),
                },
              },
              "Copy context for my agent",
            ),
          );
        }
      },
      error: (e) => {
        this.running = null;
        answer.classList.remove("streaming");
        status.textContent = `The question failed: ${e.message}`;
      },
    });
  }
}
