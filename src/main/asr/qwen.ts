/**
 * Qwen3-ASR-1.7B as a `FinalEngine` (docs/research/asr-architecture.md ASR-5), over llama-server's
 * OpenAI-style chat route. Checked against llama.cpp b11200 with the Q8_0 GGUF on an M4:
 *
 * - One unit is one request: the audio as a 16-bit WAV `input_audio` part, greedy
 *   (`temperature: 0`), with `logprobs`. The answer is `language <Name><asr_text><text>`.
 * - **The prefix is stripped**, and the language name becomes an ISO code.
 * - **A known language is forced**: Qwen's own prefix for it is sent as the start of the assistant's
 *   answer, and the model writes only the text. Forcing is right when the language is known; on
 *   code-switched Spanish it was 2.3 points better than letting the model choose. The auto decode
 *   runs first all the same: when the model chose that language the forced decode is the same
 *   (greedy), so it costs nothing, and a None answer is never forced.
 * - **lidc**, when the model chooses: an answer in an allowed language (`allowed`, the languages the
 *   user speaks) stands; one outside them is replaced by the forced decode, among the allowed
 *   languages, with the higher mean token log-probability. On auto the model named Chinese,
 *   Cantonese, Portuguese or Malay for 124 of 942 accented English utterances.
 * - **"None" is kept.** A unit with no speech answers `language None`; forcing a language there wrote
 *   31 words on 25 silent clips, so a None answer is empty text and is never re-decoded.
 * - **The glossary is the system prompt** (the model card's "context"): with the decode list there,
 *   name hits rose from 47 to 64 of 67 with no false insertion.
 * - **Word confidence** is exp of the lowest log-probability of the word's tokens, as for sherpa.
 *   Qwen gives no word times.
 *
 * A dropped connection or a 500 restarts the server and retries the unit once; a second failure is
 * `engine_unavailable` and marked `fatal`, so the pass fails the job instead of dropping the text.
 */

import type { FinalEngine, FinalUnit, Hypothesis, WordHyp } from "./engine.ts";
import { ASR_RATE } from "./engine.ts";
import { QWEN_LANGUAGE_CODES } from "./llama-catalog.ts";

/** Qwen3-ASR's language names by ISO code: the names its prefix uses. */
export const QWEN_LANGUAGES: Readonly<Record<string, string>> = {
  zh: "Chinese",
  en: "English",
  yue: "Cantonese",
  ar: "Arabic",
  de: "German",
  fr: "French",
  es: "Spanish",
  pt: "Portuguese",
  id: "Indonesian",
  it: "Italian",
  ko: "Korean",
  ru: "Russian",
  th: "Thai",
  vi: "Vietnamese",
  ja: "Japanese",
  tr: "Turkish",
  hi: "Hindi",
  ms: "Malay",
  nl: "Dutch",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  pl: "Polish",
  cs: "Czech",
  fil: "Filipino",
  fa: "Persian",
  el: "Greek",
  hu: "Hungarian",
  mk: "Macedonian",
  ro: "Romanian",
};

const CODE_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(QWEN_LANGUAGES).map(([code, name]) => [name, code]),
);

if (Object.keys(QWEN_LANGUAGES).length !== QWEN_LANGUAGE_CODES.length) {
  throw new Error("QWEN_LANGUAGES and the catalog's language list disagree");
}

/** Qwen's name for a language tag (`es`, `es-ES`), or undefined when it does not know it. */
export function qwenLanguage(tag: string): string | undefined {
  return QWEN_LANGUAGES[tag.toLowerCase().split(/[-_]/)[0] as string];
}

/** The model's answer split into its language name (`None` for no speech) and the text. */
export function parseAnswer(content: string): { lang: string | null; text: string } {
  const m = /^\s*language\s+([A-Za-z]+)\s*<asr_text>([\s\S]*)$/.exec(content);
  return m
    ? { lang: m[1] as string, text: (m[2] as string).trim() }
    : { lang: null, text: content.trim() };
}

/** 16 kHz 16-bit mono PCM WAV, clipped. */
export function wavBytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, ASR_RATE, true);
  v.setUint32(28, ASR_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] as number));
    v.setInt16(44 + i * 2, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true);
  }
  return out;
}

interface Token {
  token: string;
  logprob: number;
}

interface Answer {
  /** Qwen's language name, `None`, or null when the answer had no prefix. */
  lang: string | null;
  text: string;
  words: WordHyp[];
  /** Mean log-probability of the text's tokens (0 for no text). */
  meanLp: number;
}

/**
 * Words with confidences: the text's tokens are laid over the text, and each word takes the lowest
 * log-probability of the tokens it overlaps. Tokens that do not spell the text (a character split
 * across tokens) give words with no confidence.
 */
function wordsOf(text: string, tokens: readonly Token[]): WordHyp[] {
  const spelled = tokens.map((t) => t.token).join("");
  const lead = spelled.length - spelled.trimStart().length;
  const plain = text.split(/\s+/).filter(Boolean);
  if (spelled.trim() !== text) return plain.map((w) => ({ w }));
  const ends: number[] = [];
  let at = 0;
  for (const t of tokens) {
    at += t.token.length;
    ends.push(at);
  }
  const out: WordHyp[] = [];
  const re = /\S+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const s = m.index + lead;
    const e = s + m[0].length;
    let lp = 0;
    tokens.forEach((t, i) => {
      const t0 = (ends[i] as number) - t.token.length;
      if (t0 < e && (ends[i] as number) > s) lp = Math.min(lp, t.logprob);
    });
    out.push({ w: m[0], conf: Math.min(1, Math.exp(lp)) });
  }
  return out;
}

export interface QwenServer {
  url(): Promise<string>;
  restart(): Promise<string>;
}

export interface QwenOptions {
  /** The registry id written into `seg.model` and the job's `engine.models`. */
  id: string;
  server: QwenServer & { stop?(): Promise<void> };
  /** ISO codes the model may choose among on `auto` (lidc); empty: whatever it names. */
  allowed?: readonly string[];
  /** One request's limit. Default 120 s. */
  timeoutMs?: number;
  log?(level: "info" | "warn" | "error", msg: string): void;
}

class Unavailable extends Error {
  override name = "EngineUnavailable";
  readonly code = "engine_unavailable";
  readonly fatal = true;
}

export class QwenEngine implements FinalEngine {
  readonly id: string;
  readonly features = { confidence: true, timestamps: false, glossary: true, languageId: true };

  constructor(private readonly o: QwenOptions) {
    this.id = o.id;
  }

  async load(): Promise<void> {
    await this.o.server.url();
  }

  async unload(): Promise<void> {
    await this.o.server.stop?.();
  }

  async decode(unit: FinalUnit): Promise<Hypothesis> {
    const t = performance.now();
    const forced = unit.lang === "auto" ? undefined : qwenLanguage(unit.lang);
    // Auto first, even with a language set: greedy decoding makes the forced decode identical
    // when the model chose that language, and a None answer must never be forced into words.
    let a = await this.ask(unit);
    if (forced && a.lang !== "None" && a.lang !== forced) a = await this.ask(unit, forced);
    const allowed = (this.o.allowed ?? []).filter((c) => qwenLanguage(c));
    if (!forced && a.lang && a.lang !== "None" && allowed.length > 0) {
      const names = allowed.map((c) => qwenLanguage(c) as string);
      if (!names.includes(a.lang)) {
        let best: Answer | null = null;
        for (const name of names) {
          const f = await this.ask(unit, name);
          if (!best || f.meanLp > best.meanLp) best = f;
        }
        a = best as Answer;
      }
    }
    const h: Hypothesis = {
      engine: this.id,
      text: a.lang === "None" ? "" : a.text,
      words: a.lang === "None" ? [] : a.words,
      ms: performance.now() - t,
    };
    const code = a.lang ? CODE_OF[a.lang] : undefined;
    if (code) h.lang = code;
    return h;
  }

  /** One decode, forced into `forced` (Qwen's name) or auto. Retried once on a fresh server. */
  private async ask(unit: FinalUnit, forced?: string): Promise<Answer> {
    const seconds = unit.samples.length / ASR_RATE;
    const messages: unknown[] = [];
    if (unit.glossary.length > 0)
      messages.push({ role: "system", content: unit.glossary.join(", ") });
    messages.push({
      role: "user",
      content: [
        {
          type: "input_audio",
          input_audio: {
            data: Buffer.from(wavBytes(unit.samples)).toString("base64"),
            format: "wav",
          },
        },
      ],
    });
    const prefill = forced ? `language ${forced}<asr_text>` : "";
    if (prefill) messages.push({ role: "assistant", content: prefill });
    const body = JSON.stringify({
      messages,
      temperature: 0,
      // Room for fast speech in any script: 16 tokens a second, never under 64.
      max_tokens: Math.max(64, Math.ceil(seconds * 16)),
      logprobs: true,
    });
    let answer: Response | null = null;
    let why = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const base = attempt === 0 ? await this.o.server.url() : await this.o.server.restart();
        answer = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
        });
        if (answer.status < 500) break;
        why = `HTTP ${answer.status}: ${(await answer.text()).slice(0, 200)}`;
      } catch (err) {
        why = (err as Error).message;
      }
      answer = null;
      this.o.log?.(
        "warn",
        `${this.id}: llama-server failed (${why}); ${attempt === 0 ? "restarting it" : "giving up"}`,
      );
    }
    if (!answer) throw new Unavailable(`${this.id} is unavailable: ${why}`);
    if (!answer.ok) {
      throw new Error(
        `${this.id} refused the unit: HTTP ${answer.status} ${(await answer.text()).slice(0, 200)}`,
      );
    }
    const r = (await answer.json()) as {
      choices?: { message?: { content?: string }; logprobs?: { content?: Token[] } }[];
    };
    const choice = r.choices?.[0];
    const content = choice?.message?.content ?? "";
    // llama-server echoes the prefill in the content; its log-probs cover only generated tokens.
    const parsed = parseAnswer(
      prefill && !content.startsWith(prefill) ? prefill + content : content,
    );
    let tokens = choice?.logprobs?.content ?? [];
    if (!prefill) {
      const k = tokens.findIndex((x) => x.token === "<asr_text>");
      if (k >= 0) tokens = tokens.slice(k + 1);
    }
    const lps = tokens.map((x) => x.logprob);
    return {
      lang: parsed.lang,
      text: parsed.text,
      words: wordsOf(parsed.text, tokens),
      meanLp: lps.length ? lps.reduce((a, b) => a + b, 0) / lps.length : 0,
    };
  }
}
