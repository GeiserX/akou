/**
 * The words fixed while dictating, in the words to review (docs/ux/DICTATION.md DC-L5): the list's
 * Dictation heading. `GET /vocab?dictation=true` lists each pair the dictation log's
 * `dictation.learn` events name, at its latest status; `POST /vocab/approve` and `/reject` with
 * `dictation: true` answer them by term, as the chip's Learn and Not a word do. Approve writes the
 * term's `scope: dictation` entry for its waiting pairs; reject keeps the term's pairs from being
 * proposed again and takes a learned one back out of the vocabulary.
 *
 * The rows are one per term, since the routes answer a term and not one heard form: waiting
 * (`proposed`, or `ignored` when the chip closed unanswered) with Accept and Reject, learned with
 * Forget, and not a word with nothing left to do. A term both learned and waiting again under a
 * new heard form is one waiting row whose Reject says it forgets the learned form too, as the
 * route does. An app older than the route answers without `dictation`, and the heading is left
 * out; server mode answers an empty list, and its page never draws the words to review.
 */

import { h } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";

/** One pair as `GET /vocab?dictation=true` lists it. */
export interface DictationPair {
  term: string;
  heard: string;
  status: "proposed" | "ignored" | "accepted" | "rejected";
  evidence?: "audio" | "none";
  /** The dictation whose event last named the pair. */
  id: string;
  /** Epoch ms of that event. */
  at: number;
}

/** What the page read: the pairs, newest first; null where akou keeps no such list. */
export type DictationReview = { pairs: DictationPair[] | null } | { error: string };

const WAITING = new Set(["proposed", "ignored"]);

/** Reads the pairs; a refusal or a failed request is the reason, never a throw. */
export async function readDictationReview(t: Transport): Promise<DictationReview> {
  try {
    const r = await t.request<{ dictation?: unknown }>("GET", "/vocab?dictation=true");
    if (r.status >= 400)
      return { error: message(r.body, `the dictation words could not be read (HTTP ${r.status})`) };
    const list = r.body?.dictation;
    if (list === undefined) return { pairs: null };
    if (!Array.isArray(list)) return { error: "the dictation words came back unreadable" };
    return { pairs: list.filter(isPair) };
  } catch (err) {
    return { error: `the dictation words could not be read: ${(err as Error).message}` };
  }
}

function isPair(x: unknown): x is DictationPair {
  const p = x as Partial<DictationPair> | null;
  return (
    typeof p?.term === "string" &&
    typeof p.heard === "string" &&
    ["proposed", "ignored", "accepted", "rejected"].includes(String(p.status))
  );
}

/** How many terms still wait for an answer: the count beside "Words to review". */
export function waitingTerms(pairs: readonly DictationPair[]): number {
  return new Set(pairs.filter((p) => WAITING.has(p.status)).map((p) => p.term)).size;
}

type Bucket = "waiting" | "accepted" | "rejected";

interface Row {
  term: string;
  bucket: Bucket;
  /** The heard forms of the row's state. */
  heard: string[];
  /** Every waiting pair closed unanswered (none still an open chip). */
  ignored: boolean;
  /** The heard forms already learned; on a waiting row, Reject forgets them too. */
  learned: string[];
}

/**
 * One row per term, as the routes answer: waiting if any pair waits, else learned if any pair is,
 * else not a word. Waiting rows first, then learned, then not a word, each newest first.
 */
export function reviewRows(pairs: readonly DictationPair[]): Row[] {
  const byTerm = new Map<string, DictationPair[]>();
  for (const p of pairs) byTerm.set(p.term, [...(byTerm.get(p.term) ?? []), p]);
  const forms = (ps: DictationPair[]) => [...new Set(ps.map((p) => p.heard))];
  const rows: Row[] = [];
  for (const [term, ps] of byTerm) {
    const waiting = ps.filter((p) => WAITING.has(p.status));
    const accepted = ps.filter((p) => p.status === "accepted");
    const bucket: Bucket =
      waiting.length > 0 ? "waiting" : accepted.length > 0 ? "accepted" : "rejected";
    const own = bucket === "waiting" ? waiting : bucket === "accepted" ? accepted : ps;
    rows.push({
      term,
      bucket,
      heard: forms(own),
      ignored: waiting.length > 0 && waiting.every((p) => p.status === "ignored"),
      learned: forms(accepted),
    });
  }
  const order: Bucket[] = ["waiting", "accepted", "rejected"];
  return rows.sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
}

const NOTE: Record<Bucket, (r: Row) => string> = {
  waiting: (r) =>
    [
      r.ignored ? "the chip closed unanswered" : "waiting for your answer",
      ...(r.learned.length > 0
        ? [`learned for ${r.learned.join(", ")}: Reject forgets that too`]
        : []),
    ].join(" · "),
  accepted: () => "learned: dictation writes it for what you said",
  rejected: () => "not a word: never proposed again",
};

/**
 * The words to review's `more` (`review.ts`): the Dictation heading with its rows, the heading with
 * the reason when the list could not be read, and nothing where akou keeps no such list.
 */
export function dictationReview(
  t: Transport,
): (answered: (said: string) => Promise<void>) => Promise<HTMLElement | null> {
  return async (answered) => {
    const r = await readDictationReview(t);
    if ("error" in r)
      return h(
        "li",
        { class: "review-dictation" },
        h("h3", {}, "Dictation"),
        h("p", { class: "hint" }, r.error),
      );
    return r.pairs ? dictationReviewSection(t, r.pairs, answered) : null;
  };
}

/**
 * The Dictation heading and its rows. `answered` runs after the route took an answer, with the
 * words to say, so the list can read itself again; a refusal is said and nothing else changes.
 */
export function dictationReviewSection(
  t: Transport,
  pairs: readonly DictationPair[],
  answered: (said: string) => void | Promise<void>,
): HTMLElement {
  const decide = async (
    term: string,
    action: "approve" | "reject",
    button: HTMLElement,
    forget: boolean,
  ) => {
    for (const b of button.parentElement?.querySelectorAll("button") ?? []) b.disabled = true;
    let said: string;
    try {
      const r = await t.request("POST", `/vocab/${action}`, { terms: [term], dictation: true });
      said =
        r.status >= 400
          ? message(
              r.body,
              `${term} could not be ${action === "approve" ? "learned" : "rejected"} (HTTP ${r.status})`,
            )
          : action === "approve"
            ? `${term} is learned: dictation writes it for what you said.`
            : forget
              ? `${term} is out of the vocabulary and will not be proposed again.`
              : `${term} will not be proposed again.`;
    } catch (err) {
      said = `${term} could not be answered: ${(err as Error).message}`;
    }
    await answered(said);
  };
  const button = (
    label: string,
    term: string,
    action: "approve" | "reject",
    o: { go?: boolean; forget?: boolean } = {},
  ) => {
    const { go = false, forget = false } = o;
    const b: HTMLButtonElement = h(
      "button",
      {
        type: "button",
        ...(go ? { class: "go" } : {}),
        attrs: { "data-action": action },
        on: { click: () => void decide(term, action, b, forget) },
      },
      label,
    );
    return b;
  };
  const rows = reviewRows(pairs).map((r) =>
    h(
      "li",
      { class: "review-item", attrs: { "data-term": r.term, "data-state": r.bucket } },
      h("strong", {}, r.term),
      ` (heard: ${r.heard.join(", ")})`,
      h("small", {}, ` · ${NOTE[r.bucket](r)}`),
      r.bucket === "rejected"
        ? null
        : h(
            "span",
            { class: "bar" },
            ...(r.bucket === "waiting"
              ? [
                  button("Accept", r.term, "approve", { go: true }),
                  r.learned.length > 0
                    ? button("Reject and forget", r.term, "reject", { forget: true })
                    : button("Reject", r.term, "reject"),
                ]
              : [button("Forget", r.term, "reject", { forget: true })]),
          ),
    ),
  );
  return h(
    "li",
    { class: "review-dictation" },
    h("h3", {}, "Dictation"),
    h(
      "ul",
      {},
      ...(rows.length > 0 ? rows : [h("li", { class: "hint" }, "No words fixed while dictating.")]),
    ),
  );
}
