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

/** Reads a binding the way the helper does; throws with the helper's reason. */
export function parseBinding(s: string): Hotkey {
  const parts = s.split("+").map((p) => p.trim());
  if (parts.some((p) => p === "")) throw new Error(`"${s}" is not a key or a chord`);
  if (parts.length === 1) {
    const one = parts[0] as string;
    const m = modifier(one);
    if (m?.[0] === "Fn") return { kind: "modifier", key: "Fn" };
    if (m?.[1] === "Either") throw new Error(`${one} alone needs a side`);
    if (m) return { kind: "modifier", key: one };
    throw new Error(`${one} alone would take the key from every app; add a modifier`);
  }
  const key = parts.at(-1) as string;
  if (isModifier(key)) throw new Error(`the last key of ${s} must not be a modifier`);
  const mods: [Mod, Side][] = [];
  for (const p of parts.slice(0, -1)) {
    const m = modifier(p);
    if (!m) throw new Error(`${p} is not a modifier`);
    if (mods.some(([o]) => o === m[0])) throw new Error(`${s} names ${m[0]} twice`);
    mods.push(m);
  }
  return { kind: "chord", mods, key };
}

function pressedBy(h: Hotkey, key: string, held: readonly string[]): boolean {
  if (h.kind === "modifier") return h.key === key;
  return (
    h.key.toLowerCase() === key.toLowerCase() &&
    h.mods.every(([m, side]) =>
      held.some((k) => {
        const hm = modifier(k);
        return hm !== null && hm[0] === m && (side === "Either" || hm[1] === side);
      }),
    )
  );
}

export type EndReason = "release" | "tap" | "key" | "cancel" | "stop";

export type ActivationOut =
  /** A session starts; its audio begins at `at` less the ring. */
  | { type: "start"; at: number }
  | { type: "end"; reason: EndReason }
  /** Report `key {name}` to the app. */
  | { type: "key"; name: string };

type State =
  | { s: "idle" }
  /** A modifier-only hotkey is down and no other key went down yet. */
  | { s: "pending"; down: number }
  /** A session runs; `held`: the press that started it is still down. */
  | { s: "listening"; down: number; held: boolean }
  /** The session ended; its text is not inserted yet. */
  | { s: "awaiting"; until: number };

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

  constructor(
    private readonly hotkey: Hotkey,
    private readonly activation: Activation,
  ) {}

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
    const press = pressedBy(this.hotkey, e.key, this.held);
    this.held.push(e.key);
    const swallow = this.keyDown(e.key, press, e.at, out);
    if (swallow) this.swallowed.push(e.key);
    return swallow;
  }

  private enterName(name: string): string | null {
    if (name === "Escape") return "Escape";
    if (name === "Enter" || name === "Return" || name === "KeypadEnter") {
      // A Shift other than the hotkey itself: a held `RightShift` hotkey is not Shift+Enter.
      const shift = this.held.some((k) => modifier(k)?.[0] === "Shift" && k !== this.hotkey.key);
      return shift ? "Shift+Enter" : "Enter";
    }
    return null;
  }

  private keyDown(name: string, press: boolean, at: number, out: ActivationOut[]): boolean {
    const chord = this.hotkey.kind === "chord";
    const st = this.state;
    switch (st.s) {
      case "idle":
        if (!press) return false;
        if (chord) {
          out.push({ type: "start", at });
          this.state = { s: "listening", down: at, held: true };
          return true;
        }
        this.state = { s: "pending", down: at };
        return false;
      case "pending":
        // The interrupt rule: another key while the modifier is held is a shortcut.
        this.state = { s: "idle" };
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
          out.push({ type: "key", name: this.hotkey.key });
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
    if (name !== this.hotkey.key) return false;
    const st = this.state;
    if (st.s !== "pending" && !(st.s === "listening" && st.held)) return false;
    if (st.s === "pending") out.push({ type: "start", at: st.down });
    const tap = at - st.down < HOLD_MS;
    if (this.activation === "toggle" || (this.activation === "hold-or-toggle" && tap)) {
      this.state = { s: "listening", down: st.down, held: false };
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
      out.push({ type: "start", at: st.down });
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
    out.push({ type: "start", at });
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
