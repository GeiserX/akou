/**
 * The `bpe.vocab` that decode biasing needs (docs/DESIGN.md section 3, "Custom vocabulary"; TRAPS
 * "The `bpe.vocab` from the upstream recipe" and "Hotwords that silently do nothing").
 *
 * sherpa-onnx turns each hotword into model tokens with its own small tokenizer
 * (`ssentencepiece`): it reads a `piece<TAB>score` file and, per whitespace-separated word, picks
 * the path over `▁word` whose pieces have the highest total score (ties go to the shorter first
 * piece). Parakeet was trained with a BPE tokenizer, which merges by rank and is not a max-score
 * path, so the upstream recipe (every token scored `-rank`) spells most rare words differently from
 * the way the model emits them. The context graph then boosts a token sequence the model never
 * produces, and the hotword does nothing.
 *
 * The method the vocabulary spike proved: a file holding **only the pieces of each listed term's
 * canonical spelling** (from the model's own `tokenizer.json`), each scored -1. The max-score path
 * over those pieces is then the path with the fewest pieces, which is the canonical one, and
 * `checkTerms` proves it per word by running both tokenizers: the real BPE and a byte-for-byte
 * reimplementation of sherpa-onnx's path search. A word whose two spellings differ, or whose pieces
 * are not all in the model's `tokens.txt`, is dropped with a reason and never reaches sherpa-onnx:
 * sherpa would log the failure on stderr and bias a truncated sequence.
 *
 * One more rule the reimplementation found: sherpa-onnx scores a byte position that no piece covers
 * as 0, which beats any real piece (-1), so a path that walks into such a dead end wins and the word
 * comes out with an `<unk>` in it ("Vercel" as `▁V e <unk> cel` once "er" is in the file for another
 * word and "r" is not). Pieces from a longer list make this likelier, which is part of why a long
 * list lost hits in the spike. The file therefore also carries every single-character token of the
 * model at a score of -100: every position stays reachable, and a single character is only ever
 * used where no canonical piece fits, which the check then reports.
 *
 * sherpa-onnx builds its tokenizer once, when the recognizer is created, so the file must already
 * hold the pieces of every word a stream will be given. `coveredBy` tells the live Worker whether a
 * new list fits the file it loaded; a word added mid-call whose pieces are missing needs a new file
 * and a new recognizer (see live-worker.ts).
 */

/** The byte-fallback and special tokens are never pieces of a hotword. */
const SPECIAL = /^<.*>$/;
export const METASPACE = "▁";

// ---------------------------------------------------------------------------
// The model's real tokenizer: HF `tokenizer.json`, BPE with a Metaspace pre-tokenizer

export class BpeTokenizer {
  private readonly ranks = new Map<string, number>();

  private constructor(
    readonly vocab: ReadonlyMap<string, number>,
    merges: readonly (readonly [string, string])[],
    readonly byteFallback: boolean,
  ) {
    merges.forEach(([a, b], i) => {
      const key = `${a} ${b}`;
      if (!this.ranks.has(key)) this.ranks.set(key, i);
    });
  }

  /** Reads a Hugging Face `tokenizer.json` whose model is BPE (Parakeet's is). */
  static fromJson(json: unknown): BpeTokenizer {
    const t = json as { model?: Record<string, unknown>; pre_tokenizer?: { type?: string } };
    const model = t.model;
    if (model?.type !== "BPE") throw new Error("tokenizer.json: model is not BPE");
    const vocab = model.vocab as Record<string, number> | undefined;
    const merges = model.merges as (string | [string, string])[] | undefined;
    if (!vocab || !Array.isArray(merges)) throw new Error("tokenizer.json: no vocab or merges");
    const pairs = merges.map((m): [string, string] => {
      if (Array.isArray(m)) return [m[0], m[1]];
      const i = m.indexOf(" ");
      return [m.slice(0, i), m.slice(i + 1)];
    });
    const pre = t.pre_tokenizer?.type;
    if (pre !== undefined && pre !== "Metaspace") {
      throw new Error(`tokenizer.json: pre-tokenizer ${pre} is not supported`);
    }
    return new BpeTokenizer(new Map(Object.entries(vocab)), pairs, model.byte_fallback === true);
  }

  /** Canonical tokens of one word (no spaces), with the leading `▁`. */
  encodeWord(word: string): string[] {
    let parts: string[] = [];
    for (const ch of METASPACE + word) {
      if (this.vocab.has(ch)) parts.push(ch);
      else if (this.byteFallback) {
        for (const b of new TextEncoder().encode(ch))
          parts.push(`<0x${b.toString(16).toUpperCase().padStart(2, "0")}>`);
      } else parts.push("<unk>");
    }
    // Merge the lowest-ranked adjacent pair, leftmost first, until none is left.
    for (;;) {
      let best = -1;
      let bestRank = Number.POSITIVE_INFINITY;
      for (let i = 0; i + 1 < parts.length; i++) {
        const r = this.ranks.get(`${parts[i]} ${parts[i + 1]}`);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      const merged = (parts[best] as string) + (parts[best + 1] as string);
      parts = [...parts.slice(0, best), merged, ...parts.slice(best + 2)];
    }
    return parts;
  }

  /** Canonical tokens of a term, one word at a time, as the model emits them. */
  encode(term: string): string[] {
    return words(term).flatMap((w) => this.encodeWord(w));
  }
}

/** Whitespace-separated words, the way sherpa-onnx splits a hotword line. */
export function words(term: string): string[] {
  return term.split(/\s+/).filter((w) => w !== "");
}

// ---------------------------------------------------------------------------
// sherpa-onnx's tokenizer for hotwords: max-score path over bytes

export type ScoreVocab = ReadonlyMap<string, number>;

/**
 * The pieces sherpa-onnx's `ssentencepiece` produces for one word, reimplemented byte for byte:
 * the path search runs over the UTF-8 bytes of `▁word`; on a tie the candidate ending first wins;
 * a position no piece covers scores 0 and becomes `<unk>`, one byte at a time.
 */
export function ssentencepieceEncode(vocab: ScoreVocab, word: string): string[] {
  const enc = new TextEncoder();
  const bytes = enc.encode(METASPACE + word);
  const n = bytes.length;
  // Candidate pieces by their first byte, as the trie's prefix search would find them.
  const byFirst = new Map<number, { bytes: Uint8Array; score: number; piece: string }[]>();
  for (const [piece, score] of vocab) {
    const b = enc.encode(piece);
    if (b.length === 0) continue;
    const list = byFirst.get(b[0] as number) ?? [];
    list.push({ bytes: b, score, piece });
    byFirst.set(b[0] as number, list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => a.bytes.length - b.bytes.length);

  const score = new Float64Array(n + 1);
  const next = new Int32Array(n + 1).fill(-1);
  const pieceAt: string[] = new Array(n + 1).fill("");
  next[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let max = Number.NEGATIVE_INFINITY;
    let maxIdx = -1;
    let piece = "";
    for (const c of byFirst.get(bytes[i] as number) ?? []) {
      const end = i + c.bytes.length;
      if (end > n) continue;
      let match = true;
      for (let k = 1; k < c.bytes.length; k++) {
        if (bytes[i + k] !== c.bytes[k]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const s = c.score + (score[end] as number);
      if (s > max || (s === max && maxIdx >= end)) {
        max = s;
        maxIdx = end;
        piece = c.piece;
      }
    }
    score[i] = max === Number.NEGATIVE_INFINITY ? 0 : max;
    next[i] = maxIdx;
    pieceAt[i] = piece;
  }
  const out: string[] = [];
  for (let i = 0; i < n; ) {
    const j = next[i] as number;
    if (j === -1) {
      out.push("<unk>");
      i += 1;
    } else {
      out.push(pieceAt[i] as string);
      i = j;
    }
  }
  return out;
}

/** What sherpa-onnx turns a hotword into: each word encoded on its own. */
export function sherpaEncode(vocab: ScoreVocab, term: string): string[] {
  return words(term).flatMap((w) => ssentencepieceEncode(vocab, w));
}

// ---------------------------------------------------------------------------
// Building the file and checking the words

/** Score of a canonical piece. */
export const PIECE_SCORE = -1;
/** Score of a single-character token, the path of last resort (see the module comment). */
export const CHAR_SCORE = -100;

export interface BuiltVocab {
  /** The file body: `<unk>\t0`, one `piece\t-1` per canonical piece, then `char\t-100` lines. */
  text: string;
  pieces: ScoreVocab;
  /** Terms whose pieces are in the file. */
  terms: string[];
}

/**
 * The canonical-pieces `bpe.vocab` for a set of terms. sherpa-onnx exits the process on a line it
 * cannot read as `token score`, so a piece holding whitespace is never written (none exists in a
 * Metaspace vocabulary; the guard keeps it that way).
 */
export function buildBpeVocab(tok: BpeTokenizer, terms: Iterable<string>): BuiltVocab {
  const pieces = new Map<string, number>();
  const kept: string[] = [];
  for (const term of new Set(terms)) {
    const canon = tok.encode(term);
    if (canon.length === 0 || canon.some((p) => SPECIAL.test(p) || /\s/.test(p))) continue;
    for (const p of canon) pieces.set(p, PIECE_SCORE);
    kept.push(term);
  }
  for (const t of tok.vocab.keys()) {
    if ([...t].length === 1 && !SPECIAL.test(t) && !/\s/.test(t) && !pieces.has(t))
      pieces.set(t, CHAR_SCORE);
  }
  const lines = ["<unk>\t0", ...[...pieces].map(([p, s]) => `${p}\t${s}`)];
  return { text: `${lines.join("\n")}\n`, pieces, terms: kept };
}

/** Reads a `bpe.vocab` body back (for a file built earlier). */
export function parseBpeVocab(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\S+)\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const piece = m[1] as string;
    if (piece === "<unk>") continue;
    out.set(piece, Number(m[2]));
  }
  return out;
}

/** The model's symbol table (`tokens.txt`: `piece id` per line). */
export function parseTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const t = line.replace(/\r$/, "");
    const i = t.lastIndexOf(" ");
    if (i > 0) out.add(t.slice(0, i));
  }
  return out;
}

export interface TermCheck {
  term: string;
  ok: boolean;
  /** The model's spelling. */
  canonical: string[];
  /** What sherpa-onnx would pass to the context graph. */
  sherpa: string[];
  reason?: string;
}

/**
 * The tokenization check: a term is usable as a hotword only if sherpa-onnx spells it exactly as
 * the model's tokenizer does and every piece is a model token.
 */
export function checkTerm(
  tok: BpeTokenizer,
  vocab: ScoreVocab,
  tokens: ReadonlySet<string>,
  term: string,
): TermCheck {
  const canonical = tok.encode(term);
  const sherpa = sherpaEncode(vocab, term);
  const base = { term, canonical, sherpa };
  if (term.normalize("NFKC") !== term) return { ...base, ok: false, reason: "not in NFKC form" };
  if (canonical.some((p) => SPECIAL.test(p))) {
    return { ...base, ok: false, reason: "the model spells it with unknown or byte tokens" };
  }
  const missing = sherpa.filter((p) => !tokens.has(p));
  if (missing.length > 0) {
    return { ...base, ok: false, reason: `pieces not in the model: ${missing.join(" ")}` };
  }
  if (sherpa.join(" ") !== canonical.join(" ")) {
    return {
      ...base,
      ok: false,
      reason: `sherpa-onnx spells it "${sherpa.join(" ")}", the model "${canonical.join(" ")}"`,
    };
  }
  return { ...base, ok: true };
}

export function checkTerms(
  tok: BpeTokenizer,
  vocab: ScoreVocab,
  tokens: ReadonlySet<string>,
  terms: readonly string[],
): TermCheck[] {
  return terms.map((t) => checkTerm(tok, vocab, tokens, t));
}

/** Whether every canonical piece of every term is in a loaded file as a canonical piece. */
export function coveredBy(tok: BpeTokenizer, vocab: ScoreVocab, terms: readonly string[]): boolean {
  return terms.every((t) => tok.encode(t).every((p) => vocab.get(p) === PIECE_SCORE));
}

export interface HotwordPlan {
  /** The terms of a new vocabulary file to load before decoding, or null to keep the loaded one. */
  reload: string[] | null;
  /** The file the decode will use (the loaded one, or the one to build). */
  vocab: ScoreVocab;
  /** Terms that pass the check under that file. */
  keep: string[];
  dropped: { term: string; reason: string }[];
  checks: TermCheck[];
}

/**
 * Decides what a decode list needs: the loaded file if it already holds every canonical piece of
 * every usable term and spoils none that a file of its own would spell right, else a new file for
 * exactly this list (a smaller file leaves fewer ways for one word's pieces to spoil another's
 * path). Then checks every term under the file that will be in force, so a term sherpa-onnx would
 * spell differently never reaches it.
 */
export function planHotwords(
  tok: BpeTokenizer,
  tokens: ReadonlySet<string>,
  loaded: ScoreVocab | null,
  terms: readonly string[],
): HotwordPlan {
  const usable = terms.filter((t) => !tok.encode(t).some((p) => SPECIAL.test(p)));
  const fresh = () => buildBpeVocab(tok, usable).pieces;
  let vocab: ScoreVocab;
  let reload: string[] | null = null;
  let checks: TermCheck[];
  if (loaded && coveredBy(tok, loaded, usable)) {
    vocab = loaded;
    checks = checkTerms(tok, vocab, tokens, terms);
    // Pieces left from an earlier list can spoil a term's path. If a file for exactly this list
    // spells a failing term right, load that one instead of dropping the term for the call.
    const failing = checks.filter((c) => !c.ok && usable.includes(c.term)).map((c) => c.term);
    if (failing.length > 0) {
      const own = fresh();
      if (checkTerms(tok, own, tokens, failing).some((c) => c.ok)) {
        vocab = own;
        reload = [...usable];
        checks = checkTerms(tok, vocab, tokens, terms);
      }
    }
  } else {
    vocab = fresh();
    reload = [...usable];
    checks = checkTerms(tok, vocab, tokens, terms);
  }
  return {
    reload,
    vocab,
    keep: checks.filter((c) => c.ok).map((c) => c.term),
    dropped: checks
      .filter((c) => !c.ok)
      .map((c) => ({ term: c.term, reason: c.reason ?? "tokenization check failed" })),
    checks,
  };
}
