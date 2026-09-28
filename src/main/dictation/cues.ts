/**
 * Dictation's cues on the system's output (docs/ux/DICTATION.md DC-O3). `Cues`
 * (src/ui/dictation-cues.ts) decides which cue a moment gets and renders it as WAV bytes; this
 * plays those bytes through the OS's own player on the default output device, which follows the
 * system's choice: `afplay` on macOS, `pw-play`, `paplay` or `aplay` on Linux, and
 * `Media.SoundPlayer` through PowerShell on Windows. A cue is never waited on, and a player that
 * fails is logged once, never retried in a loop.
 *
 * Under `bun test` and in CI it plays nothing at all, so no test can open an output device, even
 * one that runs the whole app with the sounds on (the speaker rule of docs/TESTING.md).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CueMoment, CuePlayer } from "../../ui/dictation-cues.ts";

/** Where a cue can never sound: under `bun test` and in CI. */
export function cuesSilenced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || !!env.CI;
}

/**
 * The command that plays WAV file `file` on this OS's default output, or null where no player is
 * found. `which` finds a program on the PATH (Bun.which).
 */
export function cueCommand(
  platform: NodeJS.Platform,
  file: string,
  which: (bin: string) => string | null,
): string[] | null {
  if (platform === "darwin") return ["/usr/bin/afplay", file];
  if (platform === "win32") {
    const quoted = file.replaceAll("'", "''");
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(New-Object Media.SoundPlayer '${quoted}').PlaySync()`,
    ];
  }
  for (const [bin, ...args] of [["pw-play"], ["paplay"], ["aplay", "-q"]] as const) {
    const path = which(bin);
    if (path) return [path, ...args, file];
  }
  return null;
}

export interface SystemCuePlayerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  which?: (bin: string) => string | null;
  /** Starts the player; never awaited. */
  spawn?: (argv: string[]) => void;
  /** Where the cue files go; a fresh temporary folder by default. */
  dir?: () => string;
  onLog?(level: "warn", msg: string): void;
}

/** Plays each cue through the OS's player, from a WAV file written once per cue. */
export class SystemCuePlayer implements CuePlayer {
  private readonly files = new WeakMap<Uint8Array, string>();
  private folder: string | null = null;
  private seq = 0;
  private warned = false;

  constructor(private readonly o: SystemCuePlayerOptions = {}) {}

  play(wav: Uint8Array, moment: CueMoment): void {
    if (cuesSilenced(this.o.env ?? process.env)) return;
    try {
      let file = this.files.get(wav);
      if (!file) {
        this.folder ??= this.o.dir?.() ?? mkdtempSync(join(tmpdir(), "akou-cues-"));
        file = join(this.folder, `${moment}-${++this.seq}.wav`);
        writeFileSync(file, wav);
        this.files.set(wav, file);
      }
      const argv = cueCommand(
        this.o.platform ?? process.platform,
        file,
        this.o.which ?? ((bin) => Bun.which(bin)),
      );
      if (!argv) throw new Error("no sound player found (pw-play, paplay or aplay)");
      (this.o.spawn ?? spawnDetached)(argv);
    } catch (err) {
      if (this.warned) return;
      this.warned = true;
      this.o.onLog?.("warn", `dictation cue not played: ${(err as Error).message}`);
    }
  }
}

function spawnDetached(argv: string[]): void {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  p.unref();
}
