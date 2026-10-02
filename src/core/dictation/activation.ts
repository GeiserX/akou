/**
 * How the dictation key starts and ends a session (docs/ux/DICTATION.md DC-A1, DC-A4), as a pure
 * machine over key events. The real helper runs this rule in Rust
 * (`native/akou-capture/src/dictate/activation.rs`) on the thread that answers the key tap; this is
 * a line-for-line port the fake helper runs, held to the same tables as the Rust tests, so the app
 * is tested against the messages the real helper sends.
 *
 * - **Hold-or-toggle** (the default): a press held `HOLD_MS` or longer is push-to-talk and ends at
 *   release; a shorter tap latches, and the next press ends it. **Hold** always ends at release;
 *   **toggle** always latches.
 * - **A modifier-only key** is pending until it is released or held `HOLD_MS`: only then does the
 *   session start, with its audio from the key-down (the ring holds it).
 * - **The interrupt rule**: another key while a modifier-only key is pending means the press was a
 *   shortcut (Right Command+C): no session at all, and the key passes. Another key during a
 *   confirmed hold ends the session as `cancel` and passes. The modifier is never swallowed.
 * - **Keys during a session**: from the press until the insert settles, Escape (cancel), Enter and
 *   Shift+Enter (end as `key`) are swallowed and reported. Outside a session nothing is swallowed.
 * - **Which rule wins**: before a press is a session every other key, Enter included, is the
 *   interrupt rule. Once it is a session, Escape, Enter and Shift+Enter are DC-A4's even while the
 *   modifier is still held, so Enter during a push-to-talk hold ends it and sends instead of
 *   reaching the app as Command+Enter; any other key is still the interrupt rule.
 * - **The other keys** (DC-S3, DC-A5): the draft key presses exactly as the dictation key does, and
 *   its session says so (`draft` before `start`). Fix last and paste last start no session: they
 *   come out as `shortcut`. Either may be a modifier with the modifiers held before it
 *   (`Shift+RightCommand`), which counts at its release under the interrupt rule and is never
 *   swallowed, or a chord, which counts at its key-down and is swallowed. Before a press they win
 *   over the dictation key: Shift then Right Command is fix last, Right Command then Shift the
 *   interrupt.
 */

export const ACTIVATIONS = ["hold-or-toggle", "hold", "toggle"] as const;
export type Activation = (typeof ACTIVATIONS)[number];

/** A press held this long is push-to-talk (Handy's `HoldOrToggle` threshold). */
export const HOLD_MS = 300;
/** The longest the keys stay swallowed after a session ends without the insert settling. */
export const SETTLE_MS = 8000;

type Mod = "Command" | "Option" | "Control" | "Shift" | "Fn";
type Side = "Left" | "Right" | "Either";

const SPELLINGS: Record<string, Mod> = {
  Command: "Command",
  Cmd: "Command",
  Meta: "Command",
  Super: "Command",
  Win: "Command",
  Option: "Option",
  Alt: "Option",
  Control: "Control",
  Ctrl: "Control",
  Shift: "Shift",
  Fn: "Fn",
};

/** `RightCommand` is `[Command, Right]`, `Shift` is `[Shift, Either]`; a non-modifier is null. */
export function modifier(name: string): [Mod, Side] | null {
  const side: Side = name.startsWith("Left")
    ? "Left"
    : name.startsWith("Right")
      ? "Right"
      : "Either";
  const m = SPELLINGS[side === "Either" ? name : name.slice(side.length)];
  if (!m || (m === "Fn" && side !== "Either")) return null;
  return [m, side];
}

export function isModifier(name: string): boolean {
  return modifier(name) !== null;
}

/** One modifier alone (`RightCommand`), or modifiers held while a key goes down. */
export type Hotkey =
  | { kind: "modifier"; key: string }
  | { kind: "chord"; mods: [Mod, Side][]; key: string };

/** `Mouse1` to `Mouse5` as a button number; anything else is null. */
function mouseButton(name: string): number | null {
  const m = /^mouse([1-5])$/i.exec(name);
  return m ? Number(m[1]) : null;
}

/** DC-A6: the left and right buttons would take every click from every app. */
function refuseMouse(name: string): void {
  const b = mouseButton(name);
  if (b === 1 || b === 2)
    throw new Error(
      `Mouse${b} is the ${b === 1 ? "left" : "right"} button, which every app needs; use Mouse3, Mouse4 or Mouse5`,
    );
}

/** Reads a binding the way the helper does; throws with the helper's reason. */
export function parseBinding(s: string): Hotkey {
  const parts = s.split("+").map((p) => p.trim());
  if (parts.some((p) => p === "")) throw new Error(`"${s}" is not a key or a chord`);
  if (parts.length === 1) {
    const one = parts[0] as string;
    refuseMouse(one);
    const b = mouseButton(one);
    // A button alone behaves as a chord with no modifier: it starts at button-down and is
    // swallowed, so Mouse4 does not also go back a page (DC-A6).
    if (b !== null) return { kind: "chord", mods: [], key: `Mouse${b}` };
    const m = modifier(one);
    if (m?.[0] === "Fn") return { kind: "modifier", key: "Fn" };
    if (m?.[1] === "Either") throw new Error(`${one} alone needs a side`);
    if (m) return { kind: "modifier", key: one };
    throw new Error(`${one} alone would take the key from every app; add a modifier`);
  }
  const key = parts.at(-1) as string;
  if (isModifier(key)) throw new Error(`the last key of ${s} must not be a modifier`);
  refuseMouse(key);
  const mods: [Mod, Side][] = [];
  for (const p of parts.slice(0, -1)) {
    const m = modifier(p);
    if (!m) throw new Error(`${p} is not a modifier`);
    if (mods.some(([o]) => o === m[0])) throw new Error(`${s} names ${m[0]} twice`);
    mods.push(m);
  }
  return { kind: "chord", mods, key };
}

/**
 * Reads fix last, paste last or the draft key (DC-A5, DC-S3): as `parseBinding`, and also a
 * modifier with the modifiers held before it (`Shift+RightCommand`), which needs its side.
 */
export function parseExtraBinding(s: string): Hotkey {
  const parts = s.split("+").map((p) => p.trim());
  const key = parts.at(-1) as string;
  const m = parts.length > 1 ? modifier(key) : null;
  if (!m) return parseBinding(s);
  if (m[0] !== "Fn" && m[1] === "Either") throw new Error(`${key} after the others needs a side`);
  const mods: [Mod, Side][] = [];
  for (const p of parts.slice(0, -1)) {
    const h = modifier(p);
    if (!h) throw new Error(`${p} is not a modifier`);
    if (h[0] === m[0] || mods.some(([o]) => o === h[0]))
      throw new Error(`${s} names ${h[0]} twice`);
    mods.push(h);
  }
  return { kind: "chord", mods, key };
}

/** A binding's side for a modifier (`Either` takes both) against the side of a held key. */
const sideOk = (want: Side, held: Side): boolean => want === "Either" || held === want;

function pressedBy(h: Hotkey, key: string, held: readonly string[]): boolean {
  if (h.kind === "modifier") return h.key === key;
  return (
    h.key.toLowerCase() === key.toLowerCase() &&
    h.mods.every(([m, side]) =>
      held.some((k) => {
        const hm = modifier(k);
        return hm !== null && hm[0] === m && sideOk(side, hm[1]);
      }),
    )
  );
}

export type EndReason = "release" | "tap" | "key" | "cancel" | "stop";

export type ActivationOut =
  /**
   * The hotkey went down and the press may yet become a session (the helper's `press`, DC-O1);
   * `disarm`: it was not a dictation after all.
   */
  | { type: "arm"; at: number }
  | { type: "disarm" }
  /** A session starts; its audio begins at `at` less the ring. */
  | { type: "start"; at: number }
  | { type: "end"; reason: EndReason }
  /**
   * The session is latched now (tapped on, a chord released before `HOLD_MS`, or `session.start`),
   * so the app may end it after silence (DC-A3). A held session never is.
   */
  | { type: "latched" }
  /** Report `key {name}` to the app. */
  | { type: "key"; name: string }
  /** The session that starts next was pressed with the draft key (DC-S3). */
  | { type: "draft" }
  /** Fix last or paste last was pressed (DC-A5). */
  | { type: "shortcut"; name: ShortcutName };

export type ShortcutName = "fixLast" | "pasteLast";

/** What a key going down presses. */
type Press = "no" | "dictate" | "draft" | { shortcut: ShortcutName };

type State =
  | { s: "idle" }
  /** A modifier-only hotkey is down and no other key went down yet. */
  | { s: "pending"; down: number }
  /** A session runs; `held`: the press that started it is still down. */
  | { s: "listening"; down: number; held: boolean }
  /** The session ended; its text is not inserted yet. */
  | { s: "awaiting"; until: number }
  /** A shortcut whose key is a modifier is down and no other key went down yet (DC-A5). */
  | { s: "shortcut"; name: ShortcutName };

export interface KeyInput {
  /** Milliseconds on any clock that only moves forward. */
  at: number;
  /** The key's name, as the key source reports it (`RightCommand`, `C`, `Escape`). */
  key: string;
  down: boolean;
}

export class ActivationMachine {
  private state: State = { s: "idle" };
  /** Keys down now, in the order they went down. */
  private readonly held: string[] = [];
  /** Keys whose down was swallowed, so their up is swallowed too. */
  private readonly swallowed: string[] = [];
  /** The binding of the press in progress: the dictation key's or the draft key's. */
  private active: Hotkey;
  private drafting = false;

  constructor(
    private readonly hotkey: Hotkey,
    private readonly activation: Activation,
    /** The draft key (DC-S3), when bound. */
    private readonly draft: Hotkey | null = null,
    /** Fix last and paste last (DC-A5), each when bound. */
    private readonly shortcuts: readonly [ShortcutName, Hotkey][] = [],
  ) {
    this.active = hotkey;
  }

  get listening(): boolean {
    return this.state.s === "listening";
  }

  /** One key event; the actions go to `out`. Returns whether the key is swallowed. */
  key(e: KeyInput, out: ActivationOut[]): boolean {
    if (!e.down) {
      const i = this.held.indexOf(e.key);
      if (i >= 0) this.held.splice(i, 1);
      const j = this.swallowed.indexOf(e.key);
      if (j >= 0) this.swallowed.splice(j, 1);
      return this.keyUp(e.key, e.at, out) || j >= 0;
    }
    // Auto-repeat: the first down already decided.
    if (this.held.includes(e.key)) return this.swallowed.includes(e.key);
    const press = this.pressed(e.key);
    this.held.push(e.key);
    const swallow = this.keyDown(e.key, press, e.at, out);
    if (swallow) this.swallowed.push(e.key);
    return swallow;
  }

  /** What `key` going down presses; before a press a shortcut or the draft key wins. */
  private pressed(key: string): Press {
    const by = (h: Hotkey | null) => h !== null && pressedBy(h, key, this.held);
    if (this.state.s === "idle") {
      const s = this.shortcuts.find(([, h]) => by(h));
      if (s) return { shortcut: s[0] };
      if (by(this.draft)) return "draft";
    }
    if (by(this.hotkey)) return "dictate";
    return by(this.draft) ? "draft" : "no";
  }

  /** The session starts, its audio from `at`; the draft key's says so first. */
  private startAt(at: number, out: ActivationOut[]): void {
    if (this.drafting) out.push({ type: "draft" });
    out.push({ type: "start", at });
  }

  private enterName(name: string): string | null {
    if (name === "Escape") return "Escape";
    if (name === "Enter" || name === "Return" || name === "KeypadEnter") {
      // A Shift other than the hotkey's own: a held `RightShift` hotkey, or the Shift of a chord
      // such as `Control+Shift+Space` while its press is still down, is not Shift+Enter (DC-A1).
      const h = this.active;
      const chordDown = h.kind === "chord" && this.state.s === "listening" && this.state.held;
      const shift = this.held.some((k) => {
        const km = modifier(k);
        if (km?.[0] !== "Shift" || k === h.key) return false;
        return !(chordDown && h.mods.some(([m, side]) => m === "Shift" && sideOk(side, km[1])));
      });
      return shift ? "Shift+Enter" : "Enter";
    }
    return null;
  }

  private keyDown(name: string, pressing: Press, at: number, out: ActivationOut[]): boolean {
    if (this.state.s === "idle") {
      if (pressing === "no") return false;
      if (typeof pressing === "object") {
        const h = this.shortcuts.find(([n]) => n === pressing.shortcut)?.[1];
        if (h && isModifier(h.key)) {
          // Counted at its release, if no other key goes down first.
          this.state = { s: "shortcut", name: pressing.shortcut };
          return false;
        }
        out.push({ type: "shortcut", name: pressing.shortcut });
        return true;
      }
      this.drafting = pressing === "draft";
      this.active = this.drafting && this.draft ? this.draft : this.hotkey;
    }
    const chord = this.active.kind === "chord";
    const press = pressing !== "no";
    const st = this.state;
    switch (st.s) {
      case "shortcut":
        // The interrupt rule: Shift + Right Command + 4 is a screenshot, not fix last.
        this.state = { s: "idle" };
        return false;
      case "idle":
        out.push({ type: "arm", at });
        if (chord) {
          this.startAt(at, out);
          this.state = { s: "listening", down: at, held: true };
          return true;
        }
        this.state = { s: "pending", down: at };
        return false;
      case "pending":
        // The interrupt rule: another key while the modifier is held is a shortcut.
        this.state = { s: "idle" };
        out.push({ type: "disarm" });
        return false;
      case "listening": {
        if (press) {
          if (st.held) return chord;
          out.push({ type: "end", reason: "tap" });
          this.state = this.awaiting(at);
          return chord;
        }
        const k = this.enterName(name);
        if (k === "Escape") {
          out.push({ type: "key", name: "Escape" }, { type: "end", reason: "cancel" });
          this.state = { s: "idle" };
          return true;
        }
        // DC-A4 wins over the interrupt rule once the press is a session.
        if (k !== null) {
          out.push({ type: "key", name: k }, { type: "end", reason: "key" });
          this.state = this.awaiting(at);
          return true;
        }
        if (st.held && !chord) {
          // The interrupt rule during a confirmed hold: cancel, pass through.
          out.push({ type: "end", reason: "cancel" });
          this.state = { s: "idle" };
        }
        return false;
      }
      case "awaiting": {
        if (press) {
          // Still transcribing: refused, never queued; the app flashes the pill.
          out.push({ type: "key", name: this.active.key });
          return chord;
        }
        const k = this.enterName(name);
        if (k === null) return false;
        out.push({ type: "key", name: k });
        return true;
      }
    }
  }

  private keyUp(name: string, at: number, out: ActivationOut[]): boolean {
    const sc = this.state;
    if (sc.s === "shortcut") {
      if (this.shortcuts.some(([n, h]) => n === sc.name && h.key === name)) {
        out.push({ type: "shortcut", name: sc.name });
        this.state = { s: "idle" };
      }
      return false;
    }
    if (name !== this.active.key) return false;
    const st = this.state;
    if (st.s !== "pending" && !(st.s === "listening" && st.held)) return false;
    if (st.s === "pending") this.startAt(st.down, out);
    const tap = at - st.down < HOLD_MS;
    if (this.activation === "toggle" || (this.activation === "hold-or-toggle" && tap)) {
      this.state = { s: "listening", down: st.down, held: false };
      out.push({ type: "latched" });
    } else {
      out.push({ type: "end", reason: "release" });
      this.state = this.awaiting(at);
    }
    return false;
  }

  private awaiting(at: number): State {
    return { s: "awaiting", until: at + SETTLE_MS };
  }

  /**
   * Time passes: a modifier held `HOLD_MS` becomes a push-to-talk session, and an unsettled insert
   * stops holding the keys after `SETTLE_MS`.
   */
  tick(at: number, out: ActivationOut[]): void {
    const st = this.state;
    if (st.s === "pending" && this.activation !== "toggle" && at - st.down >= HOLD_MS) {
      this.startAt(st.down, out);
      this.state = { s: "listening", down: st.down, held: true };
    } else if (st.s === "awaiting" && at >= st.until) {
      this.state = { s: "idle" };
    }
  }

  /** `session.stop` (`tap`), `session.cancel` or `stop` from the app. */
  end(reason: "tap" | "cancel" | "stop", at: number, out: ActivationOut[]): void {
    if (this.state.s !== "listening") return;
    out.push({ type: "end", reason });
    this.state = reason === "cancel" ? { s: "idle" } : this.awaiting(at);
  }

  /** `session.start` from the app: a latched session, as if the key had been tapped. */
  start(at: number, out: ActivationOut[]): void {
    if (this.state.s !== "idle") return;
    this.active = this.hotkey;
    this.drafting = false;
    out.push({ type: "arm", at }, { type: "start", at }, { type: "latched" });
    this.state = { s: "listening", down: at, held: false };
  }

  /** An insert began: the keys stay swallowed until it settles or `SETTLE_MS` passes. */
  insertStarted(at: number): void {
    if (this.state.s === "awaiting") this.state = this.awaiting(at);
  }

  /** The session's text was inserted, failed, or will not be inserted. */
  settled(): void {
    if (this.state.s === "awaiting") this.state = { s: "idle" };
  }
}
