/**
 * A synthetic call generator for the query-engine benchmark and the replay evaluation. Everything
 * is generated from a seed: no real recording or transcript is ever used.
 *
 * The call is `hours` long with four speakers (you on the mic, three clusters on the call channel,
 * two of them named), restarted once an hour, so it has several parts on one clock. Planted facts
 * are single segments carrying a made-up codename and a number; they are the gold answers of the
 * evaluation questions.
 */

import { formatWall } from "../src/core/log/clock.ts";
import type { EventDraft, LogEvent } from "../src/core/log/events.ts";

export const SYNTH_T0 = Date.UTC(2026, 8, 23, 20, 36, 12);
export const SYNTH_TZ = "America/Chicago";

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES =
  "ka lo mi ne ru ta shi po ve da ri mo lu sa te ko na fi go be zu ya hi wo pe".split(" ");
const COMMON =
  "the we should move to a and it is that for on this with our about so then build deploy team plan next week review update issue ticket meeting call time idea fix test ship user data".split(
    " ",
  );
const FILLER = "yeah okay right so um well I think maybe".split(" ");

export interface Fact {
  id: string;
  w0: number;
  spk: string;
  speaker: string;
  codename: string;
  number: number;
  topic: string;
  /** Said with a mishearing that the vocabulary corrects. */
  vocab?: { term: string; heard: string };
}

export interface SynthCall {
  events: LogEvent[];
  facts: Fact[];
  /** Events held back to be appended one by one, for live measurements. */
  tail: LogEvent[];
  names: Record<string, string>;
  start: number;
  end: number;
}

const TOPICS = [
  "budget",
  "deadline",
  "launch",
  "migration",
  "contract",
  "hiring",
  "roadmap",
  "pricing",
];
const VOCAB_TERMS: { term: string; heard: string }[] = [
  { term: "Kubernetes", heard: "kubernetis" },
  { term: "Vercel", heard: "versal" },
  { term: "Anika", heard: "annika" },
];

export interface SynthOptions {
  seed?: number;
  hours?: number;
  /** Number of planted facts. */
  facts?: number;
  /** Lines held back at the end for live appends. */
  tailLines?: number;
}

export function synthCall(opts: SynthOptions = {}): SynthCall {
  const rand = rng(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const hours = opts.hours ?? 3;
  const pool: string[] = [];
  const seen = new Set<string>();
  while (pool.length < 1500) {
    const n = 2 + Math.floor(rand() * 2);
    let w = "";
    for (let i = 0; i < n; i++) w += pick(SYLLABLES);
    if (!seen.has(w)) {
      seen.add(w);
      pool.push(w);
    }
  }
  // Zipf-ish: early pool words are common.
  const word = () => {
    const r = rand();
    if (r < 0.35) return pick(COMMON);
    if (r < 0.42) return pick(FILLER);
    return pool[Math.floor(pool.length * rand() ** 2.2)] as string;
  };

  const events: LogEvent[] = [];
  let t = SYNTH_T0;
  const add = (draft: EventDraft, at?: number): LogEvent => {
    t = at ?? t + 1;
    const e = { seq: events.length + 1, t, ...draft } as LogEvent;
    events.push(e);
    return e;
  };

  add({
    type: "call.created",
    id: "01J8Z6Q4M2VX0K7B3D4E5F6G7H",
    schema: 1,
    workspace: "work",
    title: "Quarterly planning",
    tz: SYNTH_TZ,
    user: "Ana",
    akou: "0.1.0",
  });

  const names: Record<string, string> = { you: "Ana", c1: "Ben", c2: "Carla", c3: "Speaker 3" };
  const speakers = ["you", "c1", "c2", "c3"];
  const end = SYNTH_T0 + hours * 3600_000;
  const partLen = 3600_000;
  let part = 0;
  let partStart = 0;
  let w = SYNTH_T0;
  let segN = 0;
  const factCount = opts.facts ?? 60;
  const factTimes = new Set<number>();
  // Facts are spread over the call, never in the first minute.
  const totalSegsGuess = Math.floor((hours * 3600) / 5.5);
  while (factTimes.size < factCount) factTimes.add(20 + Math.floor(rand() * (totalSegsGuess - 40)));
  const facts: Fact[] = [];
  const usedCodes = new Set<string>();
  let vocabAdded = false;

  const startPart = () => {
    part++;
    partStart = w;
    add(
      {
        type: "part.started",
        part,
        file: `audio/part-${String(part).padStart(3, "0")}.opus`,
        wallStart: w,
        monoStart: 1_000_000 + (w - SYNTH_T0),
        mic: "Built-in Microphone",
        call: { mode: "system" },
        capture: "akou-capture 0.1.0",
      },
      w,
    );
  };
  startPart();
  add({ type: "speaker.name", spk: "c1", name: "Ben", by: "user" }, w + 30_000);
  add({ type: "speaker.name", spk: "c2", name: "Carla", by: "agent:claude-code" }, w + 45_000);

  while (w < end - 5_000) {
    if (w - partStart >= partLen && w < end - 60_000) {
      add({ type: "part.ended", part, reason: "restart", fileSeconds: (w - partStart) / 1000 }, w);
      startPart();
    }
    const spk = pick(speakers);
    const turnSegs = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < turnSegs && w < end - 5_000; k++) {
      segN++;
      const dur = 2000 + Math.floor(rand() * 9000);
      const nWords = Math.max(2, Math.round((dur / 1000) * (2 + rand())));
      const words: string[] = [];
      for (let i = 0; i < nWords; i++) words.push(word());
      let text = words.join(" ");
      const id = `l${String(segN).padStart(6, "0")}`;
      if (factTimes.has(segN)) {
        let codename = "";
        do {
          codename = `${pick(["zor", "vex", "qui", "jax", "plo", "wub"])}${pick(SYLLABLES)}${pick(["n", "k", "x", "th"])}`;
        } while (usedCodes.has(codename) || seen.has(codename));
        usedCodes.add(codename);
        const topic = pick(TOPICS);
        const number = 10 + Math.floor(rand() * 990);
        const v =
          facts.length % 10 === 3 ? VOCAB_TERMS[facts.length % VOCAB_TERMS.length] : undefined;
        text = `we agreed the ${codename} ${topic} is ${number} ${v ? `on ${v.heard}` : "units"} ${words.slice(0, 4).join(" ")}`;
        facts.push({
          id,
          w0: w,
          spk,
          speaker: names[spk] as string,
          codename,
          number,
          topic,
          vocab: v,
        });
      }
      add(
        {
          type: "seg",
          id,
          rev: 1,
          layer: "live",
          part,
          ch: spk === "you" ? "mic" : "call",
          spk,
          a0: (w - partStart) / 1000,
          a1: (w - partStart + dur) / 1000,
          w0: w,
          w1: w + dur,
          text,
          model: "parakeet-tdt-0.6b-v3-int8",
        },
        w + dur + 400,
      );
      if (!vocabAdded && w - SYNTH_T0 > 20 * 60_000) {
        vocabAdded = true;
        for (const [i, v] of VOCAB_TERMS.entries()) {
          add({
            type: "vocab.add",
            id: `v${i + 1}`,
            rev: 1,
            term: v.term,
            heard: [v.heard],
            by: "user",
          });
        }
      }
      w += dur + 300 + Math.floor(rand() * 900);
    }
  }
  const held = Math.min(opts.tailLines ?? 0, events.length - 10);
  const tail = held > 0 ? events.splice(events.length - held) : [];
  return { events, facts, tail, names, start: SYNTH_T0, end: w };
}

export type Question = { q: string; gold: string[]; kind: string };

/** Evaluation questions with gold segment ids, generated from the planted facts. */
export function synthQuestions(call: SynthCall, seed = 7): Question[] {
  const rand = rng(seed);
  const out: Question[] = [];
  for (const [i, f] of call.facts.entries()) {
    // Harder: no codename, only who and the topic. Any fact by that speaker on that topic answers.
    if (i % 4 === 1) {
      out.push({
        q: `What did ${f.speaker} agree on the ${f.topic}?`,
        gold: call.facts.filter((g) => g.spk === f.spk && g.topic === f.topic).map((g) => g.id),
        kind: "topic",
      });
    }
    switch (i % 5) {
      case 0:
        out.push({ q: `What did we agree about ${f.codename}?`, gold: [f.id], kind: "recall" });
        break;
      case 1:
        out.push({
          q: `What was the ${f.codename} ${f.topic} number?`,
          gold: [f.id],
          kind: "recall",
        });
        break;
      case 2:
        out.push({
          q: `What did ${f.speaker} say about the ${f.codename} ${f.topic}?`,
          gold: [f.id],
          kind: "speaker",
        });
        break;
      case 3:
        out.push({
          q: f.vocab
            ? `When did someone mention ${f.vocab.term}?`
            : `Did anyone say ${f.number} for ${f.codename}?`,
          // Every fact said with that mishearing answers the question.
          gold: f.vocab
            ? call.facts.filter((g) => g.vocab?.term === f.vocab?.term).map((g) => g.id)
            : [f.id],
          kind: f.vocab ? "vocab" : "recall",
        });
        break;
      default:
        out.push({
          q: `What was said around ${formatWall(f.w0 + Math.floor(rand() * 120_000) - 60_000, SYNTH_TZ, { seconds: false })}?`,
          gold: [f.id],
          kind: "time",
        });
    }
  }
  return out;
}
