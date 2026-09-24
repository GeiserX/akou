/**
 * Speaker labels (docs/DESIGN.md sections 3.2 and 3.3 step 4).
 *
 * Live, in the `live-asr` Worker:
 * - The mic channel is always `you`.
 * - On the call channel, a segment of at least 1 s gets an embedding. It joins the nearest cluster
 *   when the cosine similarity is at least 0.60, else it starts a new cluster `c<N>`. A shorter
 *   segment inherits the previous call speaker when the gap is under 1 s, else it is `c?`.
 * - Centroids go to the log (`speaker.centroid`) every five minutes and at each part end, and are
 *   restored from it, so `c2` in part 3 is the same voice as `c2` in part 1 and a name given to
 *   `c2` keeps rendering (names are `speaker.name` events; readers apply them).
 * - Two clusters whose centroids converge (similarity over 0.8) give one `speaker.merge`; the
 *   merged-away cluster stops taking segments. `speaker.unmerge` brings it back, and that pair is
 *   never merged automatically again. Neither touches a segment or runs the recognizer.
 *
 * Live with a stream diarizer (`asr.diarizer` nemotron, `StreamSpeakers`): the call channel's audio
 * goes to Nemotron as one stream for the whole call, parts included, so a speaker keeps its index
 * and its `c<N>` label across parts. A segment is labelled once the model has decided all of it,
 * with the speaker active longest inside it. The model decides who is who; embeddings only carry
 * a label across a stream that starts over (the app restarted mid-call, a new Worker, a restarted
 * helper), which loses the model's speaker state: segments of 1 s or more still add to the
 * label's centroid, the centroids go to the log as above, and a new stream's speaker takes the
 * label of the nearest centroid the new stream has not given out yet, at 0.60 or more, else the
 * next free number.
 *
 * Final, in the `finalize` Worker: each final cluster maps to the live cluster it overlaps most,
 * jointly across the call (Hungarian assignment). At 60 % overlap or more that is a `speaker.map`;
 * below, a `speaker.suggest` for the user to confirm.
 */

import type { DiarizedSpan, SpeakerTurn } from "./engine.ts";

export const JOIN_SIMILARITY = 0.6;
export const MERGE_SIMILARITY = 0.8;
export const MIN_EMBED_SECONDS = 1;
export const INHERIT_GAP_SECONDS = 1;
export const CENTROID_EVERY_MS = 5 * 60_000;
export const MAP_OVERLAP = 0.6;
/** A centroid restored from the log counts as this many segments, so it does not swing at once. */
const RESTORED_WEIGHT = 10;

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** base64 of the float32 bytes, as `speaker.centroid.vec` stores it. */
export function encodeVec(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}

export function decodeVec(s: string): Float32Array {
  const b = Buffer.from(s, "base64");
  const out = new Float32Array(Math.floor(b.byteLength / 4));
  new Uint8Array(out.buffer).set(b.subarray(0, out.length * 4));
  return out;
}

interface Cluster {
  id: string;
  n: number;
  /** Running mean of the embeddings. */
  sum: Float32Array;
  /** Changed since the centroid was last written. */
  dirty: boolean;
  /** Merged into another cluster: takes no segments. */
  mergedInto?: string;
}

export type SpeakerEvent =
  | { type: "centroid"; spk: string; vec: string }
  | { type: "merge"; from: string; into: string };

export class LiveSpeakers {
  private readonly clusters = new Map<string, Cluster>();
  private readonly unmerged = new Set<string>();
  private next = 1;
  private last: { spk: string; a1: number; part: number } | null = null;
  private lastWrite = 0;

  /** Restores clusters from `speaker.centroid` events and the merge history of the call. */
  restore(state: {
    centroids: readonly { spk: string; vec: string }[];
    merges?: readonly { from: string; into: string }[];
    unmerged?: readonly { from: string; into: string }[];
  }): void {
    for (const c of state.centroids) {
      const vec = decodeVec(c.vec);
      const sum = new Float32Array(vec.length);
      for (let i = 0; i < vec.length; i++) sum[i] = (vec[i] as number) * RESTORED_WEIGHT;
      this.clusters.set(c.spk, { id: c.spk, n: RESTORED_WEIGHT, sum, dirty: false });
      const m = /^c(\d+)$/.exec(c.spk);
      if (m) this.next = Math.max(this.next, Number(m[1]) + 1);
    }
    for (const m of state.merges ?? []) {
      const c = this.clusters.get(m.from);
      if (c) c.mergedInto = m.into;
    }
    for (const u of state.unmerged ?? []) this.unmerge(u.from, u.into);
  }

  /** Adds an embedding to the cluster `spk`, creating it (labels chosen by a stream diarizer). */
  addTo(spk: string, embedding: Float32Array): void {
    const c = this.clusters.get(spk);
    if (!c) {
      this.clusters.set(spk, { id: spk, n: 1, sum: Float32Array.from(embedding), dirty: true });
      this.noteId(spk);
      return;
    }
    for (let i = 0; i < c.sum.length; i++)
      c.sum[i] = (c.sum[i] as number) + (embedding[i] as number);
    c.n++;
    c.dirty = true;
  }

  /** The active cluster nearest `embedding` at `JOIN_SIMILARITY` or more, `exclude` left out. */
  nearest(embedding: Float32Array, exclude: ReadonlySet<string>): string | null {
    let best: string | null = null;
    let bestSim = JOIN_SIMILARITY;
    for (const c of this.active()) {
      if (exclude.has(c.id)) continue;
      const sim = cosine(this.centroid(c), embedding);
      if (sim >= bestSim) {
        bestSim = sim;
        best = c.id;
      }
    }
    return best;
  }

  /** Speaker id numbers in use continue after the highest one seen (restored or in segments). */
  noteId(spk: string): void {
    const m = /^c(\d+)$/.exec(spk);
    if (m) this.next = Math.max(this.next, Number(m[1]) + 1);
  }

  private centroid(c: Cluster): Float32Array {
    const v = new Float32Array(c.sum.length);
    for (let i = 0; i < v.length; i++) v[i] = (c.sum[i] as number) / c.n;
    return v;
  }

  private active(): Cluster[] {
    return [...this.clusters.values()].filter((c) => !c.mergedInto);
  }

  /**
   * The speaker of a call-channel segment. `embedding` is given only for segments of at least
   * `MIN_EMBED_SECONDS`; the caller computes it.
   */
  assign(part: number, a0: number, a1: number, embedding: Float32Array | null): string {
    let spk: string;
    if (embedding && a1 - a0 >= MIN_EMBED_SECONDS) {
      let best: Cluster | null = null;
      let bestSim = -1;
      for (const c of this.active()) {
        const s = cosine(this.centroid(c), embedding);
        if (s > bestSim) {
          bestSim = s;
          best = c;
        }
      }
      if (best && bestSim >= JOIN_SIMILARITY) {
        for (let i = 0; i < best.sum.length; i++)
          best.sum[i] = (best.sum[i] as number) + (embedding[i] as number);
        best.n++;
        best.dirty = true;
        spk = best.id;
      } else {
        spk = `c${this.next++}`;
        this.clusters.set(spk, { id: spk, n: 1, sum: Float32Array.from(embedding), dirty: true });
      }
    } else if (this.last && this.last.part === part && a0 - this.last.a1 < INHERIT_GAP_SECONDS) {
      spk = this.last.spk;
    } else {
      spk = "c?";
    }
    this.last = { spk, a1, part };
    return spk;
  }

  /** Pairs of active clusters that converged. Each is merged here and reported once. */
  merges(): SpeakerEvent[] {
    const out: SpeakerEvent[] = [];
    const act = this.active().sort((a, b) => idNum(a.id) - idNum(b.id));
    for (let i = 0; i < act.length; i++) {
      for (let j = i + 1; j < act.length; j++) {
        const into = act[i] as Cluster;
        const from = act[j] as Cluster;
        if (into.mergedInto || from.mergedInto) continue;
        if (this.unmerged.has(`${from.id}>${into.id}`)) continue;
        if (cosine(this.centroid(into), this.centroid(from)) > MERGE_SIMILARITY) {
          from.mergedInto = into.id;
          for (let k = 0; k < into.sum.length; k++)
            into.sum[k] = (into.sum[k] as number) + (from.sum[k] as number);
          into.n += from.n;
          into.dirty = true;
          out.push({ type: "merge", from: from.id, into: into.id });
        }
      }
    }
    return out;
  }

  /** A `speaker.unmerge`: the cluster takes segments again and the pair is never auto-merged. */
  unmerge(from: string, into: string): void {
    this.unmerged.add(`${from}>${into}`);
    const f = this.clusters.get(from);
    const t = this.clusters.get(into);
    if (f?.mergedInto === into) {
      f.mergedInto = undefined;
      if (t && t.n > f.n) {
        for (let k = 0; k < t.sum.length; k++)
          t.sum[k] = (t.sum[k] as number) - (f.sum[k] as number);
        t.n -= f.n;
      }
    }
  }

  /** Centroids to write: every `CENTROID_EVERY_MS`, or all changed ones when `force` (part end). */
  centroids(nowMs: number, force = false): SpeakerEvent[] {
    if (!force && nowMs - this.lastWrite < CENTROID_EVERY_MS) return [];
    this.lastWrite = nowMs;
    const out: SpeakerEvent[] = [];
    for (const c of this.clusters.values()) {
      if (!c.dirty) continue;
      c.dirty = false;
      out.push({ type: "centroid", spk: c.id, vec: encodeVec(this.centroid(c)) });
    }
    return out;
  }

  get size(): number {
    return this.clusters.size;
  }
}

/** The highest `c<N>` among `ids`, or 0. */
export function highestLabel(ids: Iterable<string>): number {
  let n = 0;
  for (const id of ids) {
    const m = /^c(\d+)$/.exec(id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n;
}

/** Who speaks when on one stream, from a stream diarizer's turns (samples on its timeline). */
export class StreamSpeakers {
  private turns: SpeakerTurn[] = [];
  private decidedTo = 0;

  constructor(private readonly rate = 16000) {}

  get decided(): number {
    return this.decidedTo;
  }

  add(turns: readonly SpeakerTurn[], decided: number): void {
    for (const t of turns) if (t.end > t.start) this.turns.push({ ...t });
    this.decidedTo = Math.max(this.decidedTo, decided);
  }

  /**
   * The speaker of `[s0, s1)`: the one active longest inside it, else the one of a turn within
   * `INHERIT_GAP_SECONDS`, else -1. Null while the model has not decided all of it.
   */
  speakerAt(s0: number, s1: number): number | null {
    if (this.decidedTo < s1) return null;
    const active = new Map<number, number>();
    for (const t of this.turns) {
      const o = Math.min(s1, t.end) - Math.max(s0, t.start);
      if (o > 0) active.set(t.speaker, (active.get(t.speaker) ?? 0) + o);
    }
    let best = -1;
    let most = 0;
    for (const [k, v] of active) {
      if (v > most || (v === most && k < best)) {
        most = v;
        best = k;
      }
    }
    if (best < 0) {
      let gap = INHERIT_GAP_SECONDS * this.rate;
      for (const t of this.turns) {
        const d = Math.max(t.start - s1, s0 - t.end);
        if (d < gap) {
          gap = d;
          best = t.speaker;
        }
      }
    }
    return best;
  }

  /** Forgets turns that end before `pos`. */
  prune(pos: number): void {
    const keep = pos - INHERIT_GAP_SECONDS * this.rate;
    this.turns = this.turns.filter((t) => t.end >= keep);
  }
}

/** Turns shorter than this are dropped before the final pass cuts at them, seconds. */
export const MIN_TURN_SECONDS = 0.2;
/** A speaker's turns closer than this are one turn, seconds. */
export const MIN_TURN_GAP_SECONDS = 0.5;

/**
 * Frame-level turns made fit to cut at, the way pyannote's `minDurationOff` and `minDurationOn`
 * do: one speaker's turns less than `minGap` apart are joined, then turns shorter than `minOn` are
 * dropped. Turns of different speakers may still overlap. Sorted by start.
 */
export function smoothTurns(
  spans: readonly DiarizedSpan[],
  minGap = MIN_TURN_GAP_SECONDS,
  minOn = MIN_TURN_SECONDS,
): DiarizedSpan[] {
  const bySpk = new Map<number, DiarizedSpan[]>();
  for (const s of spans) {
    if (!(s.end > s.start)) continue;
    const list = bySpk.get(s.speaker) ?? [];
    list.push({ start: s.start, end: s.end, speaker: s.speaker });
    bySpk.set(s.speaker, list);
  }
  const out: DiarizedSpan[] = [];
  for (const list of bySpk.values()) {
    list.sort((a, b) => a.start - b.start);
    const joined: DiarizedSpan[] = [];
    for (const s of list) {
      const last = joined[joined.length - 1];
      if (last && s.start - last.end < minGap) last.end = Math.max(last.end, s.end);
      else joined.push(s);
    }
    for (const s of joined) if (s.end - s.start >= minOn) out.push(s);
  }
  return out.sort((a, b) => a.start - b.start || a.speaker - b.speaker);
}

function idNum(spk: string): number {
  const m = /^c(\d+)$/.exec(spk);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// Final clusters to live names

export interface TimedLabel {
  spk: string;
  /** Wall-clock or file seconds; both sides must use the same timeline. */
  t0: number;
  t1: number;
}

export interface SpeakerMapping {
  final: string;
  live: string;
  /** Fraction of the final cluster's speech that overlaps the live cluster. */
  overlap: number;
  confirmed: boolean;
}

/**
 * Maps final clusters to live clusters by time overlap, jointly (each live cluster at most once),
 * maximising the total overlap. `confirmed` when the overlap is at least `MAP_OVERLAP`.
 */
export function mapFinalToLive(
  finals: readonly TimedLabel[],
  lives: readonly TimedLabel[],
): SpeakerMapping[] {
  const fIds = [...new Set(finals.map((f) => f.spk))].sort();
  const lIds = [...new Set(lives.map((l) => l.spk).filter((s) => s !== "c?"))].sort();
  if (fIds.length === 0 || lIds.length === 0) return [];
  const total = new Map<string, number>();
  for (const f of finals) total.set(f.spk, (total.get(f.spk) ?? 0) + (f.t1 - f.t0));
  const ov: number[][] = fIds.map(() => lIds.map(() => 0));
  for (const f of finals) {
    const i = fIds.indexOf(f.spk);
    for (const l of lives) {
      const j = lIds.indexOf(l.spk);
      if (j < 0) continue;
      const o = Math.min(f.t1, l.t1) - Math.max(f.t0, l.t0);
      if (o > 0) (ov[i] as number[])[j] = ((ov[i] as number[])[j] as number) + o;
    }
  }
  const assign = hungarianMax(ov);
  const out: SpeakerMapping[] = [];
  assign.forEach((j, i) => {
    if (j < 0) return;
    const f = fIds[i] as string;
    const o = (ov[i] as number[])[j] as number;
    if (o <= 0) return;
    const frac = o / Math.max(1e-9, total.get(f) ?? 0);
    out.push({
      final: f,
      live: lIds[j] as string,
      overlap: round3(frac),
      confirmed: frac >= MAP_OVERLAP,
    });
  });
  return out;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Maximum-weight assignment of rows to columns (the Hungarian method on a square cost matrix).
 * Returns, per row, the assigned column or -1.
 */
export function hungarianMax(w: readonly (readonly number[])[]): number[] {
  const rows = w.length;
  const cols = rows === 0 ? 0 : (w[0] as readonly number[]).length;
  const n = Math.max(rows, cols);
  let max = 0;
  for (const r of w) for (const x of r) max = Math.max(max, x);
  // Minimise (max - w) on an n x n matrix padded with max (weight 0).
  const cost = (i: number, j: number) =>
    i < rows && j < cols ? max - ((w[i] as readonly number[])[j] as number) : max;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1);
  const way = new Int32Array(n + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0] as number;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - (u[i0] as number) - (v[j] as number);
        if (cur < (minv[j] as number)) {
          minv[j] = cur;
          way[j] = j0;
        }
        if ((minv[j] as number) < delta) {
          delta = minv[j] as number;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j] as number] = (u[p[j] as number] as number) + delta;
          v[j] = (v[j] as number) - delta;
        } else minv[j] = (minv[j] as number) - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0] as number;
      p[j0] = p[j1] as number;
      j0 = j1;
    } while (j0);
  }
  const out = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= n; j++) {
    const i = (p[j] as number) - 1;
    if (i >= 0 && i < rows && j - 1 < cols) out[i] = j - 1;
  }
  return out;
}
