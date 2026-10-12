/**
 * The live recognizer loaded when the app starts (`asr.warmAtStart`, #378), so a call's first lines
 * never wait for a model load. A call loads the models it runs when it starts, and on a busy Mac
 * Parakeet fp32 alone takes several seconds, longer than a first sentence.
 *
 * `auto` loads only with `WARM_MIN_FREE` of memory available, `on` always, `off` never. While the
 * load holds the models, the memory is read every `WARM_CHECK_MS`: below `WARM_RELEASE_FREE` the
 * models are let go if nothing uses them (no call, no dictation open or decoding), so a Mac that
 * gets busy gets the memory back. A call or a dictation then loads what it needs, as without this.
 * Once let go, by this check or by `asr.modelIdleMinutes`, they are not loaded again before a use.
 */

import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import type { Clock } from "../capture/engine.ts";

export const WARM_SETTINGS = ["auto", "on", "off"] as const;
export type WarmSetting = (typeof WARM_SETTINGS)[number];

const GB = 1024 ** 3;
/** `auto` loads at start with at least this much memory available. */
export const WARM_MIN_FREE = 4 * GB;
/** Below this much available memory, models nothing uses are let go. */
export const WARM_RELEASE_FREE = 1.5 * GB;
export const WARM_CHECK_MS = 60_000;

const gb = (bytes: number) => (bytes / GB).toFixed(1);

/**
 * The memory the system can give a process now, bytes. Not `os.freemem()` on macOS: it counts only
 * free pages, which the system keeps near zero by caching files in the rest (0.2 GB on a 24 GB Mac
 * that had 9 GB to give). macOS: the kernel's available percentage (`kern.memorystatus_level`, the
 * figure `memory_pressure` prints). Linux: `MemAvailable`. Elsewhere, and on any failure, freemem.
 */
export function availableMemory(platform: NodeJS.Platform = process.platform): number {
  try {
    if (platform === "darwin") {
      const r = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.memorystatus_level"]);
      const n = r.exitCode === 0 ? fromStatusLevel(r.stdout.toString(), totalmem()) : null;
      if (n !== null) return n;
    } else if (platform === "linux") {
      const n = fromMeminfo(readFileSync("/proc/meminfo", "utf8"));
      if (n !== null) return n;
    }
  } catch {
    // The fallback below.
  }
  return freemem();
}

/** `sysctl -n kern.memorystatus_level`'s answer, a percentage of `total`, in bytes. */
export function fromStatusLevel(out: string, total: number): number | null {
  const pct = Number(out.trim());
  return out.trim() !== "" && pct > 0 && pct <= 100 ? (pct / 100) * total : null;
}

/** `/proc/meminfo`'s `MemAvailable`, in bytes. */
export function fromMeminfo(text: string): number | null {
  const m = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  return m ? Number(m[1]) * 1024 : null;
}

export interface StartWarmDeps {
  setting(): WarmSetting;
  /** Memory available now, bytes (`availableMemory`; tests pass their own). */
  available(): number;
  /** Loads the models; resolves once they are loaded. */
  load(): Promise<void>;
  /** Lets the models go if nothing uses them; answers whether it did. */
  release(why: string): boolean;
  clock: Pick<Clock, "setTimeout" | "clearTimeout">;
  log(level: "info" | "warn", msg: string): void;
}

export class StartWarm {
  private timer: unknown = null;
  private loading = false;
  /** The load ended and nothing has let the models go since. */
  private held = false;

  constructor(private readonly d: StartWarmDeps) {}

  /** Loads the models once, when the setting and the memory allow. Answers whether it started. */
  start(): boolean {
    if (this.loading || this.held) return false;
    const setting = this.d.setting();
    if (setting === "off") return false;
    const free = this.d.available();
    if (setting === "auto" && free < WARM_MIN_FREE) {
      this.d.log(
        "info",
        `the live recognizer is not loaded at start: ${gb(free)} GB of memory available, under ${gb(WARM_MIN_FREE)} GB`,
      );
      return false;
    }
    this.loading = true;
    this.d.load().then(
      () => {
        this.loading = false;
        this.held = true;
        this.arm();
      },
      (err: Error) => {
        this.loading = false;
        this.d.log("warn", `the live recognizer was not loaded at start: ${err.message}`);
      },
    );
    return true;
  }

  /** The models were let go (this check, or `asr.modelIdleMinutes`): nothing is left to watch. */
  released(): void {
    this.held = false;
    this.disarm();
  }

  stop(): void {
    this.released();
  }

  private arm(): void {
    if (this.timer !== null || !this.held) return;
    this.timer = this.d.clock.setTimeout(() => {
      this.timer = null;
      this.check();
    }, WARM_CHECK_MS);
  }

  private disarm(): void {
    if (this.timer !== null) this.d.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private check(): void {
    if (!this.held) return;
    const free = this.d.available();
    const why = `${gb(free)} GB of memory available, under ${gb(WARM_RELEASE_FREE)} GB`;
    if (free < WARM_RELEASE_FREE && this.d.release(why)) {
      this.released();
      return;
    }
    this.arm();
  }
}
