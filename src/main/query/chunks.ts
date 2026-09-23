/**
 * Speaker-turn chunks and the per-call search index (docs/DESIGN.md section 5.4, "BM25").
 *
 * Documents are speaker turns: consecutive lines of one speaker, 60 to 200 words, with one line of
 * overlap between neighbouring chunks. A turn shorter than 60 words runs on into the next turn, so
 * a chunk is never a lone "yes"; a turn longer than 200 words is split.
 *
 * `ChunkIndex` follows a `CallView` through its change feed. A new line at the end of the call
 * re-chunks only the last chunk or two; a vocabulary correction re-indexes only the chunks holding
 * the corrected lines; a name, a merge or a layer switch rebuilds. Lines are the `best` view with
 * echo and retracted lines left out, in the one sort order of the reader.
 */

import type { CallView, Line } from "../../core/log/fold.ts";
import { compareLines } from "../../core/log/reader.ts";
import { tokenize } from "../../core/vocab/correct.ts";
import { Bm25, type Hit, indexTerms, type QueryTerm, stopwordsFor } from "./bm25.ts";

export const CHUNK_MIN_WORDS = 60;
export const CHUNK_MAX_WORDS = 200;

export interface ChunkLine {
  line: Line;
  /** Words in the raw text: stable under vocabulary corrections. */
  words: number;
}

export interface Chunk {
  doc: number;
  /** Index range [start, end) into the index's lines. */
  start: number;
  end: number;
  ids: string[];
  /** Resolved speaker ids with at least one line in the chunk. */
  speakers: string[];
  w0: number;
  w1: number;
  words: number;
}

/**
 * Chunk boundaries from `start` to the end of `lines`. `overlap` says the line at `start` is the
 * last line of the previous chunk, carried over as context: it does not count toward the 60 words
 * a chunk needs before it may close. The result depends only on the lines from `start` on, which
 * is what lets the index re-chunk a tail.
 */
export function chunkBoundaries(
  lines: readonly { words: number; line: { spk: string } }[],
  start: number,
  overlap = false,
  min = CHUNK_MIN_WORDS,
  max = CHUNK_MAX_WORDS,
): [number, number][] {
  const out: [number, number][] = [];
  let s = start;
  let carried = overlap;
  while (s < lines.length) {
    let e = s;
    let words = 0;
    let own = 0;
    let spk: string | undefined;
    while (e < lines.length) {
      const l = lines[e] as ChunkLine;
      if (e > s) {
        if (own >= min && l.line.spk !== spk) break;
        if (words + l.words > max) break;
      }
      words += l.words;
      if (!(carried && e === s)) own += l.words;
      spk = l.line.spk;
      e++;
    }
    out.push([s, e]);
    if (e >= lines.length) break;
    // One line of overlap, unless the chunk is a single line.
    carried = e - s >= 2;
    s = carried ? e - 1 : e;
  }
  return out;
}

function wordCount(text: string | null): number {
  return text ? tokenize(text).length : 0;
}

export interface ChunkIndexOptions {
  /** Languages whose stopwords are dropped. Default English. */
  languages?: readonly string[];
}

export class ChunkIndex {
  readonly view: CallView;
  private readonly stop: Set<string>;
  private readonly bm25 = new Bm25();
  private lines: ChunkLine[] = [];
  private readonly byId = new Map<string, ChunkLine>();
  private chunks: Chunk[] = [];
  private readonly byDoc = new Map<number, Chunk>();
  private nextDoc = 1;
  private cursor = 0;
  /** Counts work, so tests can prove updates stay incremental. */
  readonly stats = { rebuilds: 0, chunksIndexed: 0 };

  constructor(view: CallView, opts: ChunkIndexOptions = {}) {
    this.view = view;
    this.stop = stopwordsFor(opts.languages ?? ["en"]);
  }

  get stopwords(): ReadonlySet<string> {
    return this.stop;
  }

  /** Pulls the view's changes since the last sync. Cheap when nothing changed. */
  sync(): void {
    const ch = this.view.changesSince(this.cursor);
    this.cursor = ch.cursor;
    if (ch.all) {
      this.rebuild();
      return;
    }
    if (ch.ids.length === 0) return;
    let from = Number.POSITIVE_INFINITY;
    const touched: string[] = [];
    for (const id of ch.ids) {
      const old = this.byId.get(id);
      const line = this.view.visibleIn(id) ? this.view.resolve(id) : null;
      if (old && line && sameShape(old, line)) {
        // Same place, speaker and raw words: only the rendering changed (a correction).
        old.line = line;
        touched.push(id);
        continue;
      }
      if (old) {
        const i = this.indexOf(old);
        this.lines.splice(i, 1);
        this.byId.delete(id);
        from = Math.min(from, i);
      }
      if (line) {
        const entry = { line, words: wordCount(line.raw) };
        const i = this.insertionPoint(line);
        this.lines.splice(i, 0, entry);
        this.byId.set(id, entry);
        from = Math.min(from, i);
      }
    }
    const fresh = from !== Number.POSITIVE_INFINITY ? this.rechunkFrom(from) : new Set<number>();
    const redo = new Set<Chunk>();
    for (const id of touched) {
      for (const c of this.chunksHolding(this.lineIndex(id))) if (!fresh.has(c.doc)) redo.add(c);
    }
    for (const c of redo) this.indexChunk(c);
  }

  /** Throws the index away and builds it again from the view. */
  rebuild(): void {
    this.cursor = this.view.changesSince(this.cursor).cursor;
    this.stats.rebuilds++;
    for (const c of this.chunks) this.bm25.remove(c.doc);
    this.chunks = [];
    this.byDoc.clear();
    this.byId.clear();
    this.lines = this.view.lines("best").map((line) => ({ line, words: wordCount(line.raw) }));
    for (const l of this.lines) this.byId.set(l.line.id, l);
    this.rechunkFrom(0);
  }

  /** Lines of the `best` view, in order. The index owns the array; do not change it. */
  allLines(): readonly ChunkLine[] {
    return this.lines;
  }

  allChunks(): readonly Chunk[] {
    return this.chunks;
  }

  chunk(doc: number): Chunk | undefined {
    return this.byDoc.get(doc);
  }

  lineIndex(id: string): number {
    const l = this.byId.get(id);
    return l ? this.indexOf(l) : -1;
  }

  /** First line index with `w0 >= w`. */
  firstAtOrAfter(w: number): number {
    let lo = 0;
    let hi = this.lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.lines[mid] as ChunkLine).line.w0 < w) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** BM25 over the chunks. */
  search(
    query: readonly QueryTerm[],
    opts: { boost?: (c: Chunk) => number; accept?: (c: Chunk) => boolean } = {},
  ): { chunk: Chunk; score: number }[] {
    const get = (doc: number) => this.byDoc.get(doc) as Chunk;
    const hits: Hit[] = this.bm25.search(query, {
      boost: opts.boost ? (d) => (opts.boost as (c: Chunk) => number)(get(d)) : undefined,
      accept: opts.accept ? (d) => (opts.accept as (c: Chunk) => boolean)(get(d)) : undefined,
    });
    return hits.map((h) => ({ chunk: get(h.doc), score: h.score }));
  }

  terms(text: string): string[] {
    return indexTerms(text, this.stop);
  }

  // -------------------------------------------------------------------------

  private indexOf(entry: ChunkLine): number {
    // Binary search on the sort key; seq is unique, so the match is exact.
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cur = this.lines[mid] as ChunkLine;
      const c = compareLines(cur.line, entry.line);
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return this.lines.indexOf(entry);
  }

  private insertionPoint(line: Line): number {
    let lo = 0;
    let hi = this.lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareLines((this.lines[mid] as ChunkLine).line, line) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private chunksHolding(i: number): Chunk[] {
    const out: Chunk[] = [];
    for (let k = this.chunkAtOrAfterEnd(i); k < this.chunks.length; k++) {
      const c = this.chunks[k] as Chunk;
      if (c.start > i) break;
      if (i < c.end) out.push(c);
    }
    return out;
  }

  /** Index of the first chunk whose end is at or after `i`. */
  private chunkAtOrAfterEnd(i: number): number {
    let lo = 0;
    let hi = this.chunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.chunks[mid] as Chunk).end < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Re-chunks from the first chunk that can see line `from`: a chunk whose last line or whose
   * closing decision (the line at its end) is at or after `from`. Earlier chunks are untouched.
   */
  private rechunkFrom(from: number): Set<number> {
    const fresh = new Set<number>();
    const k = this.chunkAtOrAfterEnd(from);
    const start = k < this.chunks.length ? (this.chunks[k] as Chunk).start : this.tailStart();
    const prev = this.chunks[k - 1];
    const overlap = prev !== undefined && prev.end - prev.start >= 2 && start === prev.end - 1;
    for (const c of this.chunks.splice(k)) {
      this.bm25.remove(c.doc);
      this.byDoc.delete(c.doc);
    }
    for (const [s, e] of chunkBoundaries(this.lines, start, overlap)) {
      const c = this.makeChunk(s, e);
      this.chunks.push(c);
      this.byDoc.set(c.doc, c);
      this.indexChunk(c);
      fresh.add(c.doc);
    }
    return fresh;
  }

  /** Where chunking resumes after the last kept chunk. */
  private tailStart(): number {
    const last = this.chunks[this.chunks.length - 1];
    if (!last) return 0;
    return last.end - last.start >= 2 ? last.end - 1 : last.end;
  }

  private makeChunk(s: number, e: number): Chunk {
    const ids: string[] = [];
    const speakers = new Set<string>();
    let words = 0;
    for (let i = s; i < e; i++) {
      const l = this.lines[i] as ChunkLine;
      ids.push(l.line.id);
      speakers.add(l.line.spk);
      words += l.words;
    }
    const first = (this.lines[s] as ChunkLine).line;
    const last = (this.lines[e - 1] as ChunkLine).line;
    return {
      doc: this.nextDoc++,
      start: s,
      end: e,
      ids,
      speakers: [...speakers],
      w0: first.w0,
      w1: last.w1,
      words,
    };
  }

  /** Corrected and raw tokens are both indexed, so a question finds either spelling. */
  private indexChunk(c: Chunk): void {
    const terms: string[] = [];
    for (let i = c.start; i < c.end; i++) {
      const l = (this.lines[i] as ChunkLine).line;
      terms.push(...indexTerms(l.text, this.stop));
      for (const corr of l.corrections) terms.push(...indexTerms(corr.heard, this.stop));
    }
    this.bm25.add(c.doc, terms);
    this.stats.chunksIndexed++;
  }
}

function sameShape(old: ChunkLine, line: Line): boolean {
  const o = old.line;
  return (
    o.w0 === line.w0 &&
    o.ch === line.ch &&
    o.seq === line.seq &&
    o.spk === line.spk &&
    o.raw === line.raw
  );
}
