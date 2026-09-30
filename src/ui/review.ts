/**
 * The words to review (docs/DESIGN.md sections 5.4 and 7): the proposals of the post-call pass and
 * of an agent, each with the lines it rests on, and the workspace's unconfirmed entries. Nothing
 * here changes a vocabulary file until the user presses Approve; approving writes the entry into
 * the workspace file with `source: call:<id>`, rejecting keeps it from being proposed again.
 *
 * The window has no button for the post-call vocabulary pass: a word is fixed once on its line
 * (`POST /calls/{id}/fix`). The pass stays in the API, the CLI (`akou vocab pass`) and its
 * proposals still land here. The words fixed while dictating are on the Words page, under
 * Dictation (`dictation-review.ts`), since they belong to no call.
 */

import { byId, closable, h, openModal, replace, toast } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";

interface ReviewLine {
  id: string;
  time: string;
  speaker: string;
  text: string;
}

interface Proposal {
  id: string;
  term: string;
  heard: string[];
  by: string;
  why?: string;
  lines: ReviewLine[];
}

interface Review {
  proposals: Proposal[];
  unconfirmed: { term: string; heard: string[]; source: string }[];
}

export interface ReviewDeps {
  t: Transport;
  call(): string | null;
  /** Scrolls to a line and plays it. */
  cite(lineId: string): void;
}

export class ReviewPane {
  private readonly dialog = byId<HTMLDialogElement>("review");
  private readonly list = byId("review-list");
  private readonly status = byId("review-status");

  constructor(private readonly d: ReviewDeps) {
    byId("pill-review").addEventListener("click", () => void this.open());
    byId("review-close").addEventListener("click", () => this.dialog.close());
    closable(this.dialog);
  }

  async open(): Promise<void> {
    const call = this.d.call();
    if (!call) return;
    const r = await this.d.t.request<{ review?: Review }>("GET", `/calls/${call}/vocab`);
    if (r.status >= 400 || !r.body.review) {
      toast(message(r.body, "the words to review could not be read"));
      return;
    }
    this.draw(call, r.body.review);
    openModal(this.dialog);
  }

  private draw(call: string, review: Review): void {
    const items = review.proposals.map((p) =>
      h(
        "li",
        { class: "review-item", attrs: { "data-term": p.term } },
        h("strong", {}, p.term),
        p.heard.length > 0 ? ` (heard: ${p.heard.join(", ")})` : "",
        p.why ? h("small", {}, ` · ${p.why}`) : null,
        h("small", {}, ` · proposed by ${p.by === "app" ? "the pass" : p.by}`),
        h(
          "ul",
          { class: "review-lines" },
          ...p.lines.map((l) =>
            h(
              "li",
              {},
              h(
                "button",
                {
                  type: "button",
                  class: "cite",
                  on: {
                    click: () => {
                      this.dialog.close();
                      this.d.cite(l.id);
                    },
                  },
                },
                `[${l.time} ${l.speaker}]`,
              ),
              ` ${l.text}`,
            ),
          ),
        ),
        h(
          "span",
          { class: "bar" },
          h(
            "button",
            {
              type: "button",
              class: "go",
              on: { click: () => void this.decide(call, p.term, "approve") },
            },
            "Approve",
          ),
          h(
            "button",
            { type: "button", on: { click: () => void this.decide(call, p.term, "reject") } },
            "Reject",
          ),
        ),
      ),
    );
    const extra = review.unconfirmed.map((e) =>
      h(
        "li",
        { class: "review-item", attrs: { "data-term": e.term } },
        h("strong", {}, e.term),
        e.heard.length > 0 ? ` (heard: ${e.heard.join(", ")})` : "",
        h("small", {}, ` · in the workspace file, unconfirmed, from ${e.source}`),
        h(
          "span",
          { class: "bar" },
          h(
            "button",
            {
              type: "button",
              class: "go",
              on: { click: () => void this.decide(call, e.term, "approve") },
            },
            "Approve",
          ),
          h(
            "button",
            { type: "button", on: { click: () => void this.decide(call, e.term, "reject") } },
            "Reject",
          ),
        ),
      ),
    );
    if (items.length + extra.length === 0) {
      replace(this.list, h("li", { class: "hint" }, "No words to review."));
      return;
    }
    replace(this.list, ...items, ...extra);
  }

  private async decide(call: string, term: string, action: "approve" | "reject"): Promise<void> {
    const r = await this.d.t.request<{ approved?: string[]; rejected?: string[]; path?: string }>(
      "POST",
      `/vocab/${action}`,
      { terms: [term], call },
    );
    if (r.status >= 400) {
      toast(
        message(r.body, `${term} could not be ${action === "approve" ? "approved" : "rejected"}`),
      );
      return;
    }
    this.status.textContent =
      action === "approve"
        ? `${term} is in the vocabulary now (${r.body.path ?? "the workspace file"}).`
        : `${term} will not be proposed again.`;
    await this.open();
  }
}
