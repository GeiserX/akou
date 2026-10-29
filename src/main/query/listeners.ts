/**
 * Which agents are following a call's questions (docs/DESIGN.md section 5.5): an agent is
 * listening on a call while a long poll of `GET /calls/{id}/events` whose `types` includes `ask`
 * is open, and for `LISTEN_GRACE_MS` after it ends, which covers the gap between two polls (the
 * CLI polls again at once, every 25 s at most). There is no subscribe call and no lease to renew:
 * the long poll is how the question reaches the agent, so it being open is exactly the fact the
 * ask box needs. When the agent's watch dies, the presence ends on its own.
 *
 * In memory only, never in the log: who is following a call says nothing about the call itself.
 */

/** How long a client counts as listening after its last poll ended. */
export const LISTEN_GRACE_MS = 35_000;

interface Presence {
  inFlight: number;
  lastSeen: number;
}

export class Listeners {
  private readonly calls = new Map<string, Map<string, Presence>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = new Map<string, string>();

  constructor(
    private readonly now: () => number,
    /** Called when a call's set of listening clients changes. */
    private readonly onChange?: () => void,
  ) {}

  /** A poll by `client` on `call` began. Returns the function that ends it. */
  open(call: string, client: string): () => void {
    let byClient = this.calls.get(call);
    if (!byClient) {
      byClient = new Map();
      this.calls.set(call, byClient);
    }
    const p = byClient.get(client) ?? { inFlight: 0, lastSeen: this.now() };
    p.inFlight++;
    p.lastSeen = this.now();
    byClient.set(client, p);
    this.changed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      p.inFlight = Math.max(0, p.inFlight - 1);
      p.lastSeen = this.now();
      this.changed();
    };
  }

  /** The asks whose reply was the excerpts, because no model answered: `call/ask`. */
  private readonly excerptsOnly = new Set<string>();

  /** The ask box showed the excerpts for this ask: no model answered it. */
  fellBack(call: string, ask: string): void {
    if (this.excerptsOnly.size > 1000) this.excerptsOnly.clear();
    this.excerptsOnly.add(`${call}/${ask}`);
  }

  /** Whether the reply to this ask was the excerpts. */
  fallback(call: string, ask: string): boolean {
    return this.excerptsOnly.has(`${call}/${ask}`);
  }

  /** The clients listening on `call` now, sorted. */
  listening(call: string): string[] {
    const byClient = this.calls.get(call);
    if (!byClient) return [];
    const now = this.now();
    const out: string[] = [];
    for (const [client, p] of byClient) {
      if (p.inFlight > 0 || now - p.lastSeen < LISTEN_GRACE_MS) out.push(client);
      else byClient.delete(client);
    }
    if (byClient.size === 0) this.calls.delete(call);
    return out.sort();
  }

  /** Tells `onChange` when a call's listeners differ from the last time, and when they expire. */
  private changed(): void {
    if (!this.onChange) return;
    const next = new Map<string, string>();
    let soonest = Number.POSITIVE_INFINITY;
    for (const call of [...this.calls.keys()]) {
      const who = this.listening(call);
      if (who.length > 0) next.set(call, who.join(","));
      for (const p of this.calls.get(call)?.values() ?? []) {
        if (p.inFlight === 0) soonest = Math.min(soonest, p.lastSeen + LISTEN_GRACE_MS);
      }
    }
    const same =
      next.size === this.last.size && [...next].every(([k, v]) => this.last.get(k) === v);
    this.last = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (Number.isFinite(soonest)) {
      // clock: the end of a presence's grace, so the window stops saying an agent follows.
      this.timer = setTimeout(() => this.changed(), Math.max(0, soonest - this.now()) + 50);
      this.timer.unref?.();
    }
    if (!same) this.onChange();
  }
}
