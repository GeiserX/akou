/**
 * What a call teaches the voices file: the voiceprint of a speaker a person named. A pure function
 * over the call's fold; the Host (`host.ts`) runs it on each `speaker.name` and `speaker.centroid`
 * and writes what it returns.
 *
 * A label teaches when all of these hold:
 * - it is a live call label, `c<N>` (never `you`, `c?` or a final label `s<N>`);
 * - it is the root of its merge group, so its centroid is the group's voice;
 * - its name in force is a typed `speaker.name` by `user` or `agent:cli` (the window, its ask box,
 *   the CLI) [VO-5]. An `app` name (an import), an MCP agent's name (`agent:<client>`, which an
 *   agent may have guessed), a name found by voice and an offer never teach;
 * - it has a centroid with `secs` and `cons`, and `secs` is at least `minLearnSec`.
 *
 * The exemplar is keyed by (call, label), so naming the same label again moves it to the new
 * name. The consistency score is recorded and gates nothing.
 */

import type { CallView } from "../../core/log/fold.ts";
import type { Exemplar } from "./store.ts";

/** The authors whose names teach the voices file [VO-5]. */
export const TEACHERS: ReadonlySet<string> = new Set(["user", "agent:cli"]);

/** A label's latest centroid, decoded. */
export interface LabelCentroid {
  vec: Float32Array;
  secs?: number;
  cons?: number;
}

export interface Lesson {
  name: string;
  exemplar: Exemplar;
}

/** What `spk` of `call` teaches now, or null. */
export function lessonFor(input: {
  view: CallView;
  call: string;
  spk: string;
  /** The running speaker embedder's id. */
  model: string;
  centroid: LabelCentroid | undefined;
  minLearnSec: number | null;
  /** When the centroid or the name landed, ISO 8601. */
  at: string;
}): Lesson | null {
  const { view, spk, centroid: c } = input;
  if (!/^c\d+$/.test(spk) || view.resolveSpeaker(spk) !== spk) return null;
  if (!c || c.secs === undefined || c.cons === undefined) return null;
  if (input.minLearnSec === null || c.secs < input.minLearnSec) return null;
  const me = view.roster().find((r) => r.spk === spk);
  if (!me?.name || me.byVoice || !me.namedBy || !TEACHERS.has(me.namedBy)) return null;
  return {
    name: me.name,
    exemplar: {
      model: input.model,
      dim: c.vec.length,
      vec: c.vec,
      secs: c.secs,
      cons: c.cons,
      call: input.call,
      spk,
      at: input.at,
    },
  };
}
