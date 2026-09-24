/**
 * The ask box (docs/DESIGN.md sections 5.3, 5.4 and 7): a question about the call, answered by the
 * user's own provider. The matching excerpts come first, as evidence cards, before any model runs;
 * the answer streams in token by token; its wall-clock citations (`[15:41 Ben]`) are buttons that
 * scroll to the line and play it. When no model can answer, the excerpts stay, the reason is said
 * plainly, and "Copy context for my agent" hands the pack to the user's own agent.
 *
 * Presets: "Catch me up", "Was my name mentioned?", "Decisions so far", "Action items", and "What
 * did <speaker> say?" for each named speaker. Everything shown is text, never markup.
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
  private readonly presetsBox = byId("ask-presets");
  private readonly out = byId("ask-out");
  private running: { cancel(): void } | null = null;
  private presetKey = "";

  constructor(private readonly d: AskDeps) {
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.ask(this.input.value);
    });
  }

  reset(): void {
    this.running?.cancel();
    this.running = null;
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
          { class: "preset", type: "button", on: { click: () => this.ask(p.question) } },
          p.label,
        ),
      ),
    );
  }

  ask(question: string): void {
    const q = question.trim();
    const call = this.d.call();
    if (q === "" || !call) return;
    this.running?.cancel();
    this.input.value = "";
    const cards = h("div", { class: "evidence" });
    const answer = h("div", { class: "answer streaming", attrs: { "aria-live": "polite" } });
    const status = h("div", { class: "ask-status" }, "Looking in the call…");
    const block = h(
      "section",
      { class: "qa" },
      h("p", { class: "question" }, q),
      cards,
      status,
      answer,
    );
    this.out.prepend(block);
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
        status.textContent = a.reason
          ? `No answer: ${a.reason}. The excerpts above are what matched.`
          : "No answer.";
        answer.replaceChildren();
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
