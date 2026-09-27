/**
 * The words fixed while dictating, in the words to review (docs/ux/DICTATION.md DC-L5): the list's
 * Dictation heading. `GET /vocab?dictation=true` lists each pair the dictation log's
 * `dictation.learn` events name, at its latest status; `POST /vocab/approve` and `/reject` with
 * `dictation: true` answer them by term, as the chip's Learn and Not a word do. Approve writes the
 * term's `scope: dictation` entry for its waiting pairs; reject keeps the term's pairs from being
 * proposed again and takes a learned one back out of the vocabulary.
 *
 * The rows are one per term and state, since the routes answer a term and not one heard form:
 * waiting (`proposed`, or `ignored` when the chip closed unanswered) with Accept and Reject,
 * learned with Forget, and not a word with nothing left to do. An akou without the list (server
 * mode, or an app older than the route) answers without `dictation`, and the heading is left out.
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
  heard: string[];
  ignored: boolean;
}

/** One row per term and state, waiting first, then learned, then not a word, newest first. */
export function reviewRows(pairs: readonly DictationPair[]): Row[] {
  const rows = new Map<string, Row>();
  for (const p of pairs) {
    const bucket: Bucket = WAITING.has(p.status) ? "waiting" : (p.status as Bucket);
    const k = `${bucket}\u0000${p.term}`;
    let row = rows.get(k);
    if (!row) {
      row = { term: p.term, bucket, heard: [], ignored: false };
      rows.set(k, row);
    }
    if (!row.heard.includes(p.heard)) row.heard.push(p.heard);
    if (p.status === "ignored") row.ignored = true;
  }
  const order: Bucket[] = ["waiting", "accepted", "rejected"];
  return [...rows.values()].sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
}

const NOTE: Record<Bucket, (r: Row) => string> = {
  waiting: (r) => (r.ignored ? "the chip closed unanswered" : "waiting for your answer"),
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
  const button = (label: string, term: string, action: "approve" | "reject", go = false) => {
    const forget = label === "Forget";
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
              ? [button("Accept", r.term, "approve", true), button("Reject", r.term, "reject")]
              : [button("Forget", r.term, "reject")]),
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
