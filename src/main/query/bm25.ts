/**
 * Local BM25 over speaker-turn chunks (docs/DESIGN.md section 5.4, "BM25").
 *
 * An in-memory index per call, no dependency. Tokens are Unicode words, lowercase, accent-folded
 * (the same folding as read-time correction), no stemming, with a small stopword list per
 * configured language. Documents are added and removed one at a time, so the index follows the
 * call as segments, revisions, retractions and merges arrive.
 */

import { foldText, tokenize } from "../../core/vocab/correct.ts";

export const K1 = 1.2;
export const B = 0.75;

const words = (list: string): ReadonlySet<string> => new Set(list.split(" ").map(foldText));

/** Small stopword lists, folded. Enough to keep function words out of the scores. */
export const STOPWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: words(
    "a an the and or but if then so of to in on at by for with from as is are was were be been " +
      "being am do does did doing have has had having i me my we our us you your he him his she " +
      "her it its they them their this that these those there here what which who whom whose when " +
      "where why how not no yes just about into over under again very can could would should will " +
      "shall may might must than too also only own same such some any all each both few more most " +
      "other up down out off yeah okay ok um uh oh like well really right gonna wanna",
  ),
  es: words(
    "el la los las un una unos unas y o pero si de del a al en con por para como que es son era " +
      "fue ser estar esta este esto estos estas eso esa ese lo le les se me te nos mi tu su sus yo " +
      "tu el ella ellos ellas nosotros no sí ya muy mas más pues bueno vale entonces hay",
  ),
  fr: words(
    "le la les un une des et ou mais si de du au aux en dans avec par pour que qui est sont " +
      "était être ce cette ces il elle ils elles nous vous je tu me te se ne pas plus oui non donc",
  ),
  de: words(
    "der die das den dem des ein eine einer eines und oder aber wenn von zu in im an am auf mit " +
      "für ist sind war waren sein es er sie wir ihr ich du nicht ja nein also noch schon auch",
  ),
};

export function stopwordsFor(languages: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const lang of languages) for (const w of STOPWORDS[lang] ?? []) out.add(w);
  return out;
}

/** Folded index terms of a text, stopwords removed. Keeps repeats: term frequency counts. */
export function indexTerms(text: string, stop: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const t of tokenize(text)) if (!stop.has(t.folded)) out.push(t.folded);
  return out;
}

export interface QueryTerm {
  term: string;
  /** 1 for a word of the question, less for an expansion. */
  weight: number;
}

export interface Hit {
  doc: number;
  score: number;
}

export class Bm25 {
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly docs = new Map<number, Map<string, number>>();
  private readonly lengths = new Map<number, number>();
  private totalLength = 0;

  get size(): number {
    return this.docs.size;
  }

  has(doc: number): boolean {
    return this.docs.has(doc);
  }

  /** Adds a document, replacing any previous one with the same id. */
  add(doc: number, terms: readonly string[]): void {
    if (this.docs.has(doc)) this.remove(doc);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(doc, tf);
    this.lengths.set(doc, terms.length);
    this.totalLength += terms.length;
    for (const [t, n] of tf) {
      let p = this.postings.get(t);
      if (!p) {
        p = new Map();
        this.postings.set(t, p);
      }
      p.set(doc, n);
    }
  }

  remove(doc: number): void {
    const tf = this.docs.get(doc);
    if (!tf) return;
    for (const t of tf.keys()) {
      const p = this.postings.get(t);
      if (!p) continue;
      p.delete(doc);
      if (p.size === 0) this.postings.delete(t);
    }
    this.totalLength -= this.lengths.get(doc) ?? 0;
    this.docs.delete(doc);
    this.lengths.delete(doc);
  }

  /** Inverse document frequency, BM25+ style so it never goes negative. */
  idf(term: string): number {
    const n = this.docs.size;
    const df = this.postings.get(term)?.size ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * Scores every document containing at least one query term. `boost` multiplies a document's
   * score (a named speaker's turns get 1.5); `accept` filters documents out.
   */
  search(
    query: readonly QueryTerm[],
    opts: { boost?: (doc: number) => number; accept?: (doc: number) => boolean } = {},
  ): Hit[] {
    const n = this.docs.size;
    if (n === 0) return [];
    const avg = this.totalLength / n || 1;
    const scores = new Map<number, number>();
    const seen = new Set<string>();
    for (const q of query) {
      if (seen.has(q.term)) continue;
      seen.add(q.term);
      const p = this.postings.get(q.term);
      if (!p) continue;
      const idf = this.idf(q.term) * q.weight;
      for (const [doc, tf] of p) {
        if (opts.accept && !opts.accept(doc)) continue;
        const len = this.lengths.get(doc) ?? 0;
        const s = (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * len) / avg));
        scores.set(doc, (scores.get(doc) ?? 0) + s);
      }
    }
    const hits: Hit[] = [];
    for (const [doc, score] of scores) {
      hits.push({ doc, score: score * (opts.boost ? opts.boost(doc) : 1) });
    }
    return hits.sort((a, b) => b.score - a.score || a.doc - b.doc);
  }
}
