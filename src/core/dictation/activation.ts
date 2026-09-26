/**
 * How the dictation key starts and ends a session (docs/ux/DICTATION.md DC-A1), as a pure machine
 * over key events. The helper runs this rule in Rust on the thread that answers the key tap; the
 * fake helper runs this module, so the rule is tested here by tables and the Rust side is held to
 * the same tables.
 *
 * - A session starts at the key-down of the dictation key: the audio starts there, less the ring.
 * - `hold-or-toggle` (the default): a press held `HOLD_MS` or longer is push-to-talk and ends at
 *   the release; a shorter tap latches listening on, and the next clean tap ends it.
 * - `hold`: every press ends at its release. `toggle`: a press latches, the next clean tap ends it.
 * - The interrupt rule, for a modifier-only key: any other key pressed while it is held (before it
 *   latched) ends the session as `interrupt` at once and passes that key through, so Right
 *   Command+C stays a copy. The modifier itself is never swallowed.
 * - While latched, a tap of the dictation key with another key in between is a shortcut, not a
 *   tap: the session goes on.
 *
 * Swallowing Escape and Enter during a session is DC-A4's and not here: every key but a chord's
 * own non-modifier key passes through.
 */

export const ACTIVATIONS = ["hold-or-toggle", "hold", "toggle"] as const;
export type Activation = (typeof ACTIVATIONS)[number];

/** A press at least this long is push-to-talk; a shorter one latches (Handy's 300 ms). */
export const HOLD_MS = 300;

const MODIFIERS = new Set([
  "Command",
  "Control",
  "Shift",
  "Option",
  "Alt",
  "Meta",
  "Super",
  "Fn",
  "AltGr",
]);

/** `RightCommand`, `LeftShift`, `Fn`, `Control`: a key that types nothing on its own. */
export function isModifier(key: string): boolean {
  return MODIFIERS.has(key.replace(/^(Left|Right)/, ""));
}

export interface KeyInput {
  /** Milliseconds on any clock that only moves forward. */
  at: number;
  /** The key's name, as the key source reports it (`RightCommand`, `C`, `Escape`). */
  key: string;
  down: boolean;
}

export type ActivationOut =
  | { type: "start"; at: number }
  | { type: "end"; at: number; reason: "release" | "tap" | "interrupt" }
  /** Every key event, with whether the tap swallowed it or passed it to the app under it. */
  | { type: "key"; key: string; down: boolean; swallowed: boolean };

export interface ActivationOptions {
  /** The binding's keys: one for a modifier-only or single key, several for a chord. */
  keys: readonly string[];
  activation: Activation;
}

type State = "idle" | "press" | "latched" | "latch-press";

export class ActivationMachine {
  private readonly keys: Set<string>;
  private readonly modifierOnly: boolean;
  private readonly held = new Set<string>();
  private state: State = "idle";
  private pressAt = 0;
  /** Another key went down during the press that is in progress while latched. */
  private other = false;

  constructor(private readonly o: ActivationOptions) {
    if (o.keys.length === 0) throw new Error("a binding needs at least one key");
    this.keys = new Set(o.keys);
    this.modifierOnly = o.keys.length === 1 && isModifier(o.keys[0] as string);
  }

  /** A session is running (listening). */
  get active(): boolean {
    return this.state !== "idle";
  }

  private triggerDown(): boolean {
    for (const k of this.keys) if (!this.held.has(k)) return false;
    return true;
  }

  feed(e: KeyInput): ActivationOut[] {
    const out: ActivationOut[] = [];
    const mine = this.keys.has(e.key);
    const wasDown = this.triggerDown();
    const repeat = e.down && this.held.has(e.key);
    if (e.down) this.held.add(e.key);
    else this.held.delete(e.key);
    const isDown = this.triggerDown();
    // A chord's own key is taken by the binding; a modifier never is.
    out.push({
      type: "key",
      key: e.key,
      down: e.down,
      swallowed: mine && !this.modifierOnly && !isModifier(e.key),
    });
    if (repeat) return out;
    if (!wasDown && isDown) {
      if (this.state === "idle") {
        this.state = "press";
        this.pressAt = e.at;
        out.push({ type: "start", at: e.at });
      } else if (this.state === "latched") {
        this.state = "latch-press";
        this.other = false;
      }
      return out;
    }
    if (wasDown && !isDown) {
      if (this.state === "press") {
        const long = e.at - this.pressAt >= HOLD_MS;
        const a = this.o.activation;
        if (a === "hold" || (a === "hold-or-toggle" && long)) {
          this.state = "idle";
          out.push({ type: "end", at: e.at, reason: "release" });
        } else {
          this.state = "latched";
        }
      } else if (this.state === "latch-press") {
        if (this.other) this.state = "latched";
        else {
          this.state = "idle";
          out.push({ type: "end", at: e.at, reason: "tap" });
        }
      }
      return out;
    }
    if (e.down && !mine) {
      if (this.state === "press" && this.modifierOnly) {
        this.state = "idle";
        out.push({ type: "end", at: e.at, reason: "interrupt" });
      } else if (this.state === "latch-press") {
        this.other = true;
      }
    }
    return out;
  }

  /** The session ended from outside the keys (Escape, the pill's Stop, the CLI). */
  reset(): void {
    this.state = "idle";
  }
}
