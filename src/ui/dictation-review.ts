/**
 * The words fixed while dictating (docs/ux/DICTATION.md DC-L5): the Words page's "To review"
 * section. `GET /vocab?dictation=true` lists each pair the dictation log's `dictation.learn` events
 * name, at its latest status; `POST /vocab/approve` and `/reject` with `dictation: true` answer them
 * by term, as the chip's Learn and Not a word do. Approve writes the term's `scope: dictation` entry
 * for its waiting pairs; reject keeps the term's pairs from being proposed again and takes a
 * learned one back out of the vocabulary.
 *
 * The rows are one per term, since the routes answer a term and not one heard form: waiting
 * (`proposed`, or `ignored` when the chip closed unanswered) with Learn it and Ignore, learned with
 * Forget, and not a word with nothing left to do, so not listed. A term both learned and waiting
 * again under a new heard form is one waiting row whose Ignore says it forgets the learned form
 * too, as the route does. An app older than the route answers without `dictation`, and the section
 * is left out; server mode has no Words page.
 */

import { h } from "./dom.ts";
import { dayLabel, localZone } from "./model.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";
import { row, section, sectionWith } from "./rows.ts";

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
  /** Epoch ms of the latest of the row's own pairs, if the route said. */
  at?: number;
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
    const times = own.map((p) => p.at).filter((t) => typeof t === "number" && t > 0);
    rows.push({
      term,
      bucket,
      heard: forms(own),
      ignored: waiting.length > 0 && waiting.every((p) => p.status === "ignored"),
      learned: forms(accepted),
      ...(times.length > 0 ? { at: Math.max(...times) } : {}),
    });
  }
  const order: Bucket[] = ["waiting", "accepted", "rejected"];
  return rows.sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket));
}

/** Heard forms as a sentence: “kubernetis” and “cooper netties”. */
export function quotedForms(forms: readonly string[]): string {
  const q = forms.map((f) => `“${f}”`);
  return q.length < 2 ? (q[0] ?? "") : `${q.slice(0, -1).join(", ")} and ${q.at(-1)}`;
}

/** When a fix was made, as the end of a sentence: ` today`, ` on Mon`; nothing if unknown. */
export function when(at: number | undefined, now = Date.now(), tz = localZone()): string {
  if (at === undefined) return "";
  const day = dayLabel(at, now, tz);
  return day === "Today" || day === "Yesterday" ? ` ${day.toLowerCase()}` : ` on ${day}`;
}

/** The row's one line of help, in plain words. */
function note(r: Row): string {
  if (r.bucket === "accepted") return `Learned: dictation writes it for ${quotedForms(r.heard)}.`;
  const said = `You changed ${quotedForms(r.heard)} to this${when(r.at)}${r.ignored ? " and left it unanswered" : ""}.`;
  return r.learned.length > 0
    ? `${said} Ignore also forgets ${quotedForms(r.learned)}, learned before.`
    : said;
}

/**
 * The Words page's "To review" section (sd-a-words): one row per term still waiting, with Learn it
 * and Ignore, then the terms learned while dictating, with Forget. A term answered Not a word has
 * nothing left to do, so it is not listed; with no row left the section is left out. `answered`
 * runs after every answer with the words to say and whether the route took it, so the page can
 * read itself again; after a refusal nothing else changes.
 */
export function dictationReviewSection(
  t: Transport,
  pairs: readonly DictationPair[],
  answered: (said: string, ok: boolean) => void | Promise<void>,
): HTMLElement | null {
  const decide = async (
    term: string,
    action: "approve" | "reject",
    button: HTMLElement,
    forget: boolean,
  ) => {
    for (const b of button.parentElement?.querySelectorAll("button") ?? []) b.disabled = true;
    let said: string;
    let ok = false;
    try {
      const r = await t.request("POST", `/vocab/${action}`, { terms: [term], dictation: true });
      ok = r.status < 400;
      said = !ok
        ? message(
            r.body,
            `${term} could not be ${action === "approve" ? "learned" : "ignored"} (HTTP ${r.status})`,
          )
        : action === "approve"
          ? `${term} is learned: dictation writes it for what you said.`
          : forget
            ? `${term} is out of your words and will not be proposed again.`
            : `${term} will not be proposed again.`;
    } catch (err) {
      said = `${term} could not be answered: ${(err as Error).message}`;
    }
    if (!ok)
      for (const b of button.parentElement?.querySelectorAll("button") ?? []) b.disabled = false;
    await answered(said, ok);
  };
  const button = (
    label: string,
    term: string,
    action: "approve" | "reject",
    o: { ghost?: boolean; forget?: boolean } = {},
  ) => {
    const { ghost = false, forget = false } = o;
    const b: HTMLButtonElement = h(
      "button",
      {
        type: "button",
        class: ghost ? "pg-btn ghost" : "pg-btn",
        attrs: { "data-action": action },
        on: { click: () => void decide(term, action, b, forget) },
      },
      label,
    );
    return b;
  };
  const rows = reviewRows(pairs)
    .filter((r) => r.bucket !== "rejected")
    .map((r) => {
      const el = row(
        { label: r.term, help: note(r) },
        ...(r.bucket === "waiting"
          ? [
              button("Learn it", r.term, "approve"),
              r.learned.length > 0
                ? button("Ignore and forget", r.term, "reject", { ghost: true, forget: true })
                : button("Ignore", r.term, "reject", { ghost: true }),
            ]
          : [button("Forget", r.term, "reject", { ghost: true, forget: true })]),
      );
      el.classList.add("review-item");
      el.dataset.term = r.term;
      el.dataset.state = r.bucket;
      return el;
    });
  if (rows.length === 0) return null;
  const s = section("To review", ...rows);
  s.classList.add("review-dictation");
  return s;
}

/** The section when the list could not be read: its title and the reason. */
export function dictationReviewError(why: string): HTMLElement {
  const s = sectionWith("To review", why);
  s.classList.add("review-dictation");
  s.querySelector(".pg-grp")?.remove();
  return s;
}
