/**
 * Voices on the Host: the app feeds it every event of every call (`app.watch`), and it teaches the
 * voices file and names the voices it knows. App mode only; server mode never makes one [VO-8].
 *
 * - **Learn** (`learn.ts`) on each `speaker.name` and `speaker.centroid`: a label a person named
 *   keeps its latest centroid in `voices.yaml` under that name [VO-5]. A label merged into another
 *   loses its exemplar, and the group's root teaches the name the group now shows. An unmerge
 *   teaches both labels again, and one left with no name that teaches loses its exemplar.
 * - **Match** (`match.ts`) on each `speaker.centroid` only: each centroid write of a label is one
 *   decision for that label, in the order the writes land, exactly as the voices evaluation
 *   (`scripts/eval/voices.ts`) drives the same function. People shown on other labels of the call
 *   are left out, and so are people refused on this label or withdrawn from it. A decision writes
 *   `speaker.voice` by `app`: `refused` for a withdrawn name, then `named` or `offered` with the
 *   score to 2 places. A name typed later wins in the fold [VO-1] and teaches. A typed name also
 *   takes its person from any other label that shows that name by voice: that label gets
 *   `refused` by `app` at once.
 * - **Purge** (`VoicePurge`, in every mode): a call deleted for good loses its exemplars; trash and
 *   restore keep them [VO-4]. A purge the file cannot take now (it cannot be read) is kept in
 *   `voices.yaml.forget` and applied at the next step that can.
 *
 * - **Forget and rename** (`forget`, `rename`, the voices routes) run on the same queue, so they
 *   keep their order against teaching in flight, and each leaves a tombstone (`tombstones.ts`),
 *   timed when it was asked for. A name given before a forget that covers it teaches nothing, and
 *   one given before a rename teaches the new name, in every call, after a merge, an unmerge or a
 *   restart [VO-12]: else the label's next centroid would put back what the user was just told is
 *   gone. A newer name lifts them.
 *
 * Every step runs on one queue, so decisions keep the order of the events. A decision reads the
 * fold and writes in the same turn, with nothing awaited in between, so it never acts on a fold a
 * later event changed. Exemplars taught by the call being matched are left out, as the evaluation
 * leaves the call out of its store. With `voices.enabled` off nothing learns or matches, and the
 * file stays as it is. The log gets counts only, never a name or a vector.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { EventDraft, LogEvent } from "../../core/log/events.ts";
import type { CallView } from "../../core/log/fold.ts";
import { decodeVec } from "../asr/speakers.ts";
import { type LabelCentroid, lessonFor, TEACHERS } from "./learn.ts";
import { type LabelState, matchVoice } from "./match.ts";
import type { Person, VoiceStore, VoiceSummary } from "./store.ts";
import type { VoiceThresholds } from "./thresholds.ts";
import { type Tombstone, VoiceTombstones } from "./tombstones.ts";

/** The live speaker embedder: every `speaker.centroid` is TitaNet-small's. */
export const LIVE_EMBEDDER = "titanet-small";

/** One call as the Host reads and writes it. */
export interface VoiceCall {
  view: CallView;
  /** Appends one event at once; null when the log is closed or refuses it. */
  append(draft: EventDraft): LogEvent | null;
}

export interface VoiceHostOptions {
  store: VoiceStore;
  /** `voices.enabled`, read at each event. */
  enabled: () => boolean;
  thresholds: (model: string) => VoiceThresholds;
  /** The call, while it is loaded. */
  call: (id: string) => VoiceCall | undefined;
  log: (level: "info" | "warn", msg: string) => void;
  /** The embedder the centroids come from; `LIVE_EMBEDDER` unless a test passes another. */
  model?: string;
  /** The purges still owed to the file, applied before each step. */
  purge?: VoicePurge;
  /** The forgets and renames; by default read from beside the voices file. */
  tombstones?: VoiceTombstones;
  /** The wall clock the call logs stamp `t` with; `Date.now` by default. */
  now?: () => number;
  /**
   * When the oldest call akou keeps was created (Infinity with none), or null when that is not
   * known now: a tombstone older than it leaves. Absent: none ever leaves.
   */
  oldestCall?: () => Promise<number | null>;
  /** The ids of the calls loaded now; a forget by name looks for the name in them. */
  loaded?: () => Iterable<string>;
}

/**
 * The calls deleted for good whose exemplars must leave the voices file [VO-4]. In every mode:
 * server mode keeps no voices, but a file left in its config folder still loses a deleted call's
 * voiceprints. A purge the file cannot take now (it cannot be read) waits in
 * `voices.yaml.forget`, one call id per line, and is applied at the next `flush` that can read
 * it, after a restart too, so a repaired file never brings a deleted call's voices back.
 */
export class VoicePurge {
  readonly file: string;
  private readonly pending: Set<string>;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: VoiceStore,
    private readonly log: (level: "info" | "warn", msg: string) => void,
  ) {
    this.file = `${store.path}.forget`;
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {}
    this.pending = new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    if (this.pending.size > 0) void this.flush();
  }

  /** A call was deleted for good. */
  purged(call: string): void {
    this.pending.add(call);
    this.save();
    void this.flush();
  }

  /** Applies every purge still owed; one that fails stays for the next. */
  flush(): Promise<void> {
    this.queue = this.queue.then(() => this.apply());
    return this.queue;
  }

  idle(): Promise<void> {
    return this.queue;
  }

  private async apply(): Promise<void> {
    for (const call of [...this.pending]) {
      let n: number;
      try {
        n = await this.store.forgetCall(call);
      } catch {
        // The store's message may quote a name, and the log takes none.
        this.log("warn", "voices: voices.yaml cannot be read; a deleted call's voiceprints wait");
        return;
      }
      this.pending.delete(call);
      this.save();
      if (n > 0) this.log("info", `voices: dropped ${n} voiceprint(s) of a deleted call`);
    }
  }

  private save(): void {
    try {
      if (this.pending.size === 0) rmSync(this.file, { force: true });
      else writeFileSync(this.file, `${[...this.pending].join("\n")}\n`, { mode: 0o600 });
    } catch {
      this.log("warn", "voices: the list of deleted calls could not be written");
    }
  }
}

/** The matcher's view of one label from the fold, or null when it is merged into another. */
export function labelState(view: CallView, spk: string, secs: number): LabelState | null {
  if (view.resolveSpeaker(spk) !== spk) return null;
  const roster = view.roster();
  const me = roster.find((r) => r.spk === spk);
  const typed = !!me?.name && !me.byVoice;
  const v = typed ? undefined : view.voiceFor(spk);
  const taken = new Set<string>();
  for (const r of roster) {
    if ((r.mergedInto ?? r.spk) === spk) continue;
    if (r.name && !r.byVoice) taken.add(r.name);
    else if (r.voice) taken.add(r.voice.name);
  }
  return {
    spk,
    secs,
    typed,
    voice: v ? { name: v.name, status: v.status } : null,
    taken,
    refused: view.refusedVoices(spk),
  };
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** What a forget takes: one person, one call, one person's lessons from one call, or everyone. */
export type ForgetScope = { all: true } | { name: string; call?: string } | { call: string };

export class VoiceHost {
  readonly model: string;
  private queue: Promise<void> = Promise.resolve();
  /** The people of the file as last read, by the file's identity and the embedding size. */
  private cache: { key: string; dim: number; people: Person[] } | null = null;
  private readFailed: string | null = null;
  /** What the user forgot or renamed [VO-12]. */
  readonly tombstones: VoiceTombstones;
  private readonly now: () => number;

  constructor(private readonly o: VoiceHostOptions) {
    this.model = o.model ?? LIVE_EMBEDDER;
    this.tombstones = o.tombstones ?? new VoiceTombstones(o.store.path, o.log);
    this.now = o.now ?? Date.now;
  }

  /** Every event of every call; only names, merges and centroids do anything. */
  onEvent(call: string, e: LogEvent): void {
    if (
      e.type !== "speaker.centroid" &&
      e.type !== "speaker.name" &&
      e.type !== "speaker.merge" &&
      e.type !== "speaker.unmerge"
    )
      return;
    // A name reaches the Host only as it is written, so it is newer than every stamp so far: when
    // the clock reads at or before one, it is lifted past them [VO-12].
    if (e.type === "speaker.name" && this.tombstones.behind(e.t)) {
      const lift: Tombstone = {
        kind: "lift",
        call,
        seq: e.seq,
        at: this.tombstones.stamp(this.now()),
      };
      this.run(async () => {
        if (!(await this.tombstones.keep(lift)))
          this.o.log("warn", "voices: a name given after a clock change could not be saved");
        await this.handle(call, e);
      });
      return;
    }
    this.run(() => this.handle(call, e));
  }

  /** Resolves when every step queued so far is done. */
  idle(): Promise<void> {
    return this.queue.then(() => this.o.purge?.idle());
  }

  /** The people of the file, with their calls, seconds and last time heard. Never a vector. */
  list(): Promise<VoiceSummary[]> {
    return this.exclusive(() => this.o.store.list());
  }

  /**
   * Forgets voices, after every step queued before it, and leaves a tombstone stamped when it is
   * asked for: a name given before it that it covers never teaches again, and one given after it,
   * even while this waits in the queue, is newer [VO-12]. The tombstone is kept even when the file
   * held nothing, since a call may still hold the name under MIN_LEARN_SEC, or not loaded. `gone`:
   * the file held something in that scope (`all` always); `held`: a loaded call has a teaching
   * name in that scope. Throws `TombstonesError`, with nothing changed, when the tombstone cannot
   * be saved.
   */
  forget(scope: ForgetScope): Promise<{ gone: boolean; held: boolean }> {
    const at = this.tombstones.stamp(this.now());
    return this.exclusive(async () => {
      const name = "name" in scope ? scope.name : undefined;
      const call = "call" in scope ? scope.call : undefined;
      const t: Tombstone =
        "all" in scope
          ? { kind: "forget", all: true, at }
          : {
              kind: "forget",
              ...(name !== undefined ? { name } : {}),
              ...(call !== undefined ? { call } : {}),
              at,
            };
      // Saved before the file is edited, so a forget that is answered always holds.
      await this.tombstones.add(t);
      let gone = true;
      try {
        if ("all" in scope) await this.o.store.forgetAll();
        else if (name === undefined) gone = (await this.o.store.forgetCall(call as string)) > 0;
        else if (call === undefined) gone = await this.o.store.forget(name);
        else gone = (await this.o.store.forgetPersonCall(name, call)) > 0;
      } catch (err) {
        await this.tombstones.remove(t).catch(() => {});
        throw err;
      }
      const held = "all" in scope || this.held(name, call);
      await this.pruneNow();
      return { gone, held };
    });
  }

  /**
   * Renames a person, after every step queued before it, and leaves a tombstone stamped when it
   * is asked for: a name `from` given before it teaches `to` from now on [VO-12]. Null when akou
   * knows no `from`. Throws `TombstonesError`, with nothing changed, when the tombstone cannot be
   * saved.
   */
  rename(from: string, to: string): Promise<{ dropped: number } | null> {
    const at = this.tombstones.stamp(this.now());
    return this.exclusive(async () => {
      const t: Tombstone = { kind: "rename", from: from.trim(), to: to.trim(), at };
      const moves = t.from !== t.to;
      if (moves) await this.tombstones.add(t);
      let out: { dropped: number } | null;
      try {
        out = await this.o.store.rename(from, to);
      } catch (err) {
        if (moves) await this.tombstones.remove(t).catch(() => {});
        throw err;
      }
      if (out === null) {
        if (moves) await this.tombstones.remove(t);
        return null;
      }
      if (moves) await this.pruneNow();
      return out;
    });
  }

  /** Whether a loaded call has a teaching name in the scope: `name`, of call `call`, or both. */
  private held(name: string | undefined, call: string | undefined): boolean {
    const ids = call !== undefined ? [call] : [...(this.o.loaded?.() ?? [])];
    for (const id of ids) {
      const c = this.o.call(id);
      if (!c) continue;
      for (const r of c.view.roster()) {
        if (r.mergedInto || !r.name || r.byVoice || !r.namedBy || !TEACHERS.has(r.namedBy))
          continue;
        if (name === undefined || r.name.trim() === name.trim()) return true;
      }
    }
    return false;
  }

  /** Drops the tombstones no kept call can need, on the queue (a call was deleted for good). */
  prune(): void {
    this.run(() => this.pruneNow());
  }

  private async pruneNow(): Promise<void> {
    const oldest = await this.o.oldestCall?.();
    if (oldest === undefined || oldest === null) return;
    const n = await this.tombstones.prune(oldest);
    if (n > 0) this.o.log("info", `voices: dropped ${n} tombstone(s) no kept call needs`);
  }

  /** Runs `fn` on the queue after every step before it, and answers with what it returns. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(() => this.o.purge?.flush()).then(fn);
    this.queue = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  private run(step: () => Promise<void>): void {
    // The store's message may quote a name, and the log takes none.
    this.queue = this.queue
      .then(() => this.o.purge?.flush())
      .then(step)
      .catch(() => {
        this.o.log(
          "warn",
          "voices: voices.yaml could not be read or written; fix or delete it by hand",
        );
      });
  }

  private async handle(call: string, e: LogEvent): Promise<void> {
    // A merged label's voice is the group's now: its exemplar goes, whatever the switch says, so
    // the group's voice is never kept under the merged label's name.
    if (e.type === "speaker.merge") {
      if (e.from === e.into) return;
      await this.o.store.removeExemplar(call, e.from);
      // The group's root takes the name now shown for the group, which may be the merged label's.
      if (!this.o.enabled()) return;
      const c = this.o.call(call);
      if (c) await this.relearn(c, call, c.view.resolveSpeaker(e.into), e.t, false);
      return;
    }
    if (!this.o.enabled()) return;
    const c0 = this.o.call(call);
    if (!c0) return;
    // Both labels stand alone again: each teaches its own name, and one that teaches nothing now
    // loses the voiceprint it kept while it was the group's root.
    if (e.type === "speaker.unmerge") {
      for (const spk of [e.from, e.into]) await this.relearn(c0, call, spk, e.t, true);
      return;
    }
    if (e.type !== "speaker.centroid" && e.type !== "speaker.name") return;
    if (e.type === "speaker.name") this.release(c0, e.spk);
    const t = this.o.thresholds(this.model);
    const spk = e.spk;
    if (e.type === "speaker.name") {
      // A name on a merged member is the group's name when its root has none: the root teaches it
      // now, not at its next centroid.
      await this.relearn(c0, call, c0.view.resolveSpeaker(spk), e.t, false);
      return;
    }
    const centroid: LabelCentroid = { vec: decodeVec(e.vec), secs: e.secs, cons: e.cons };
    await this.teach(c0, call, spk, centroid, e.t, false);
    const secs = centroid.secs;
    if (!/^c\d+$/.test(spk) || secs === undefined || centroid.cons === undefined) return;
    if (t.minMatchSec === null || secs < t.minMatchSec) return;
    if (t.accept === null && t.offer === null) return;
    const all = await this.people(centroid.vec.length);
    if (!all) return;
    // Leave this call out, as the evaluation scores a call against what every other call taught.
    const people = all
      .map((p) => ({ name: p.name, exemplars: p.exemplars.filter((x) => x.call !== call) }))
      .filter((p) => p.exemplars.length > 0);
    // From here to the writes nothing is awaited: each decision reads the fold as it is now.
    const c = this.o.call(call);
    if (!c || !this.o.enabled()) return;
    // A withdraw writes `refused`, then the label decides again without that person.
    for (let i = 0; i < 4; i++) {
      const label = labelState(c.view, spk, secs);
      if (!label) return;
      const d = matchVoice({
        people,
        model: this.model,
        dim: centroid.vec.length,
        vec: centroid.vec,
        label,
        thresholds: t,
      });
      if (d.kind === "none") return;
      if (d.kind === "withdraw") {
        if (!c.append({ type: "speaker.voice", spk, name: d.name, status: "refused", by: "app" }))
          return;
        continue;
      }
      c.append({
        type: "speaker.voice",
        spk,
        name: d.name,
        status: d.kind === "name" ? "named" : "offered",
        score: round2(d.score),
        by: "app",
      });
      return;
    }
  }

  /** Teaches what `spk` teaches now from the fold's latest centroid of it. */
  private relearn(
    c: VoiceCall,
    call: string,
    spk: string,
    t: number,
    drop: boolean,
  ): Promise<void> {
    const s = c.view.speakerState().centroids.find((x) => x.spk === spk);
    const centroid = s && { vec: decodeVec(s.vec), secs: s.secs, cons: s.cons };
    return this.teach(c, call, spk, centroid, t, drop);
  }

  /**
   * Keeps `spk`'s voiceprint under its name when the learn rule says so. With `drop`, a label that
   * teaches nothing loses the voiceprint it held.
   */
  private async teach(
    c: VoiceCall,
    call: string,
    spk: string,
    centroid: LabelCentroid | undefined,
    t: number,
    drop: boolean,
  ): Promise<void> {
    const lesson = lessonFor({
      view: c.view,
      call,
      spk,
      model: this.model,
      centroid,
      minLearnSec: this.o.thresholds(this.model).minLearnSec,
      at: new Date(t).toISOString(),
    });
    // A forget or a rename the user asked for after this name was given wins over it [VO-12].
    const n = c.view.nameAt(spk);
    const name =
      lesson && n
        ? this.tombstones.teaches(lesson.name, call, this.tombstones.lifted(call, n.seq) ?? n.t)
        : lesson?.name;
    try {
      if (lesson && name) await this.o.store.upsert(name, lesson.exemplar);
      else if (drop) await this.o.store.removeExemplar(call, spk);
    } catch {
      this.o.log("warn", "voices: a voiceprint was not kept in voices.yaml");
    }
  }

  /**
   * A typed name takes its person from every other label showing that name by voice: each gets
   * `refused` by the app now, not at its next centroid, which may never come once the call ended.
   */
  private release(c: VoiceCall, spk: string): void {
    const root = c.view.resolveSpeaker(spk);
    const roster = c.view.roster();
    const me = roster.find((r) => r.spk === root);
    if (!me?.name || me.byVoice) return;
    for (const r of roster) {
      if (r.mergedInto || r.spk === root || (r.name && !r.byVoice)) continue;
      if (c.view.voiceFor(r.spk)?.name !== me.name) continue;
      c.append({ type: "speaker.voice", spk: r.spk, name: me.name, status: "refused", by: "app" });
    }
  }

  /** The people of the running embedder, read again only when the file changed. */
  private async people(dim: number): Promise<Person[] | null> {
    let key = "none";
    try {
      const s = await stat(this.o.store.path);
      key = `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {}
    if (this.cache?.key === key && this.cache.dim === dim) return this.cache.people;
    try {
      const { people } = await this.o.store.load(this.model, dim);
      this.cache = { key, dim, people };
      this.readFailed = null;
      return people;
    } catch {
      // Logged once per version of the file; the store's message may quote a name.
      if (this.readFailed !== key)
        this.o.log("warn", "voices: voices.yaml cannot be read; fix or delete it by hand");
      this.readFailed = key;
      return null;
    }
  }
}
