/**
 * The app's own log, `app.log` in the config folder (DK-M8, docs/troubleshooting.md).
 *
 * The desktop app is started by LaunchServices (Finder, the login item, `open -a` from the CLI), so
 * nothing ever reads its stdout and stderr, and a log that went only there was lost. The app writes
 * this file itself: its start with version and pid, each call's start and end, the model loads, the
 * final passes, every warning and error, the watchdog's lines and the quit. One line each, with the
 * local wall-clock time. Never a transcript line, a note, a title or a name: the messages carry
 * call ids, model names and akou's own folders only.
 *
 * At `APP_LOG_MAX_BYTES` the file is renamed `app.log.1` (replacing the older one) and a new one
 * starts, so the two files together stay under twice that.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const APP_LOG = "app.log";
/** Where a `sample` of a hung app goes, beside the log: by the CLI and by the watchdog. */
export const HANGS_DIR = "hangs";
export const APP_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** `2026-10-01 16:40:13.562 +02:00`: local wall-clock time with its offset. */
// clock: the default of an injected time: a log line is stamped when it is written.
export function logStamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} ${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

export class AppLog {
  private size: number | null = null;

  constructor(
    readonly file: string,
    private readonly maxBytes: number = APP_LOG_MAX_BYTES,
    // clock: the default of an injected clock; tests pass their own.
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Appends one line. Never throws: a log that cannot be written must not stop the app. */
  line(level: "info" | "warn" | "error", msg: string): void {
    const text = `${logStamp(this.now())} ${level} ${msg.replace(/\r?\n/g, " ")}\n`;
    try {
      if (this.size === null) {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        try {
          this.size = statSync(this.file).size;
        } catch {
          this.size = 0;
        }
      }
      // Bytes, not characters: a path or a name with accents is longer on disk than in text.
      const bytes = Buffer.byteLength(text);
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        renameSync(this.file, `${this.file}.1`);
        this.size = 0;
      }
      appendFileSync(this.file, text, { mode: 0o600 });
      this.size += bytes;
    } catch {
      // Measure again next time: another writer (the watchdog) may have rotated or removed it.
      this.size = null;
    }
  }
}
