/**
 * Dictation's cues on the system's output (docs/ux/DICTATION.md DC-O3). `Cues`
 * (src/ui/dictation-cues.ts) decides which cue a moment gets and renders it as WAV bytes; this
 * plays those bytes through the OS's own player on the default output device, which follows the
 * system's choice: `afplay` on macOS, `pw-play`, `paplay` or `aplay` on Linux, and
 * `Media.SoundPlayer` through PowerShell on Windows. A cue is never waited on. A player that exits
 * with an error (`pw-play` with no PipeWire running) is logged once, and on Linux the next player
 * found plays that cue and the ones after it; none is retried in a loop. `close` removes the cue
 * files.
 *
 * Under `bun test` and in CI it plays nothing at all, so no test can open an output device, even
 * one that runs the whole app with the sounds on (the speaker rule of docs/TESTING.md).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CueMoment, CuePlayer } from "../../ui/dictation-cues.ts";

/** Where a cue can never sound: under `bun test` and in CI. */
export function cuesSilenced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || !!env.CI;
}

/**
 * The commands that can play WAV file `file` on this OS's default output, best first: one on
 * macOS and Windows, every player found on Linux, none where none is. `which` finds a program on
 * the PATH (Bun.which).
 */
export function cueCommands(
  platform: NodeJS.Platform,
  file: string,
  which: (bin: string) => string | null,
): string[][] {
  if (platform === "darwin") return [["/usr/bin/afplay", file]];
  if (platform === "win32") {
    const quoted = file.replaceAll("'", "''");
    return [
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(New-Object Media.SoundPlayer '${quoted}').PlaySync()`,
      ],
    ];
  }
  const out: string[][] = [];
  for (const [bin, ...args] of [["pw-play"], ["paplay"], ["aplay", "-q"]] as const) {
    const path = which(bin);
    if (path) out.push([path, ...args, file]);
  }
  return out;
}

/** The best command of `cueCommands`, or null where no player is found. */
export function cueCommand(
  platform: NodeJS.Platform,
  file: string,
  which: (bin: string) => string | null,
): string[] | null {
  return cueCommands(platform, file, which)[0] ?? null;
}

export interface SystemCuePlayerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  which?: (bin: string) => string | null;
  /** Starts the player; its exit code is read once it ends, never awaited by the cue. */
  spawn?: (argv: string[]) => Promise<number>;
  /** Where the cue files go; a fresh temporary folder by default. */
  dir?: () => string;
  onLog?(level: "warn", msg: string): void;
}

/** Plays each cue through the OS's player, from a WAV file written once per cue. */
export class SystemCuePlayer implements CuePlayer {
  private files = new WeakMap<Uint8Array, string>();
  private folder: string | null = null;
  private seq = 0;
  private warned = false;
  /**
   * Players that exited with an error are skipped from then on: how many of the list. The last
   * one is never skipped, so one failed play does not silence every later cue.
   */
  private failed = 0;

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
      this.run(file, this.failed);
    } catch (err) {
      this.warn((err as Error).message);
    }
  }

  /** Removes the cue files; a later cue writes them again. */
  close(): void {
    if (this.folder) rmSync(this.folder, { recursive: true, force: true });
    this.folder = null;
    this.files = new WeakMap();
  }

  /** Plays `file` with the `i`th player; one that exits with an error hands the cue to the next. */
  private run(file: string, i: number): void {
    const all = cueCommands(
      this.o.platform ?? process.platform,
      file,
      this.o.which ?? ((bin) => Bun.which(bin)),
    );
    const argv = all[i];
    if (!argv) {
      if (all.length === 0) throw new Error("no sound player found (pw-play, paplay or aplay)");
      return;
    }
    void (this.o.spawn ?? spawnDetached)(argv).then(
      (code) => {
        if (code === 0) return;
        this.warn(`${argv[0]} exited with ${code}`);
        if (!all[i + 1]) return;
        if (this.failed === i) this.failed = i + 1;
        try {
          this.run(file, i + 1);
        } catch (err) {
          this.warn((err as Error).message);
        }
      },
      (err: Error) => this.warn(err.message),
    );
  }

  private warn(why: string): void {
    if (this.warned) return;
    this.warned = true;
    this.o.onLog?.("warn", `dictation cue not played: ${why}`);
  }
}

function spawnDetached(argv: string[]): Promise<number> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  p.unref();
  return p.exited;
}
