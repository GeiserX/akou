/**
 * Positive controls for the G4 drift analysis (`scripts/drift-test.ts`): proof that it reports an
 * offset and a drift when one exists, before its "0 ms per hour" on a real recording is trusted.
 *
 * It needs a recording whose call channel (right) holds both marker trains: the source played its
 * mic side into a device the global tap hears, as in the G3-lite run. From that channel it builds
 * three stereo files, each with a copy of the right channel on the left, so the analysis pairs
 * mic chirps on the left with call chirps on the right exactly as it would with a real mic:
 *
 * - `base`: the copy unchanged. The left-right offset is the fixed gap between the two trains in
 *   the tap, with no drift.
 * - `shift50`: the copy delayed by 50 ms. The left-right offset must move by -50 ms.
 * - `drift75`: the copy sped up by 1/48000, about 20.8 parts per million (`asetrate` 48001 then
 *   `aresample` 48000), which puts each chirp earlier by 75.0 ms per hour. The left-right slope
 *   must move by +75 ms per hour, and each left-channel train's slope by -75. `asetrate` takes a
 *   whole number of hertz, so a fractional rate such as 48001.44 is silently truncated to 48001.
 *
 * Both trains are checked on the left copy: the call train (1.5 to 2.5 kHz, matched at 0.97 or
 * better on this path) and the mic train as the tap heard it (3 to 4.5 kHz, matched as low as 0.5
 * where it is degraded), so the page can say how much a poor match costs.
 *
 *   bun scripts/gates/g4-controls.ts --folder <call folder> --signal <signal.jsonl> [--out result.json]
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const folder = opt("--folder");
const signal = opt("--signal");
if (!folder || !signal) throw new Error("--folder and --signal are required");

const events = readFileSync(join(folder, "events.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.startsWith("{"))
  .map((l) => JSON.parse(l));
const part = events.find((e) => e.type === "part.started");
if (!part) throw new Error("no part.started in the log");
const source = join(folder, part.file);

const variants: Record<string, string> = {
  base: "[b]pan=mono|c0=c1[l]",
  shift50: "[b]pan=mono|c0=c1,adelay=50[l]",
  drift75: "[b]pan=mono|c0=c1,asetrate=48001,aresample=48000[l]",
};

const dir = mkdtempSync(join(tmpdir(), "akou-g4-controls-"));
const drift = join(import.meta.dir, "..", "drift-test.ts");
const results: Record<
  string,
  { leftRight: unknown; micAtLeft: unknown; callAtLeft: unknown; callAtRight: unknown }
> = {};
try {
  for (const [name, left] of Object.entries(variants)) {
    const out = join(dir, `${name}.flac`);
    const graph = `[0:a]asplit=2[a][b];[a]pan=mono|c0=c1[r];${left};[l][r]join=inputs=2:channel_layout=stereo[o]`;
    const ff = Bun.spawnSync(
      ["ffmpeg", "-v", "error", "-y", "-i", source, "-filter_complex", graph, "-map", "[o]"].concat(
        ["-ar", "48000", "-sample_fmt", "s16", out],
      ),
      { stderr: "inherit" },
    );
    if (ff.exitCode !== 0) throw new Error(`ffmpeg failed building ${name}`);
    const run = Bun.spawnSync(
      ["bun", drift, "--folder", folder, "--signal", signal, "--file", out],
      { stderr: "inherit" },
    );
    if (run.exitCode !== 0) throw new Error(`drift-test failed on ${name}`);
    const r = JSON.parse(run.stdout.toString());
    results[name] = {
      leftRight: r.leftRight,
      micAtLeft: r.chirps?.["mic@left"],
      callAtLeft: r.chirps?.["call@left"],
      callAtRight: r.chirps?.["call@right"],
    };
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

type Lr = { offsetMs?: { median: number }; slopeMsPerHour?: number };
type Train = { latencyMs?: { median: number }; slopeMsPerHour?: number };
const lr = (k: string) => (results[k]?.leftRight ?? {}) as Lr;
const train = (k: string, t: "micAtLeft" | "callAtLeft" | "callAtRight") =>
  (results[k]?.[t] ?? {}) as Train;
const nan = Number.NaN;
// The base's left-channel trains are the right channel's own, so the base is the zero point.
const recovered = {
  leftRightOffsetShiftMs:
    (lr("shift50").offsetMs?.median ?? nan) - (lr("base").offsetMs?.median ?? nan),
  callTrainOffsetShiftMs:
    (train("shift50", "callAtLeft").latencyMs?.median ?? nan) -
    (train("base", "callAtLeft").latencyMs?.median ?? nan),
  leftRightSlopeMsPerHour:
    (lr("drift75").slopeMsPerHour ?? nan) - (lr("base").slopeMsPerHour ?? nan),
  callTrainSlopeMsPerHour:
    (train("drift75", "callAtLeft").slopeMsPerHour ?? nan) -
    (train("base", "callAtLeft").slopeMsPerHour ?? nan),
  micTrainSlopeMsPerHour:
    (train("drift75", "micAtLeft").slopeMsPerHour ?? nan) -
    (train("base", "micAtLeft").slopeMsPerHour ?? nan),
};
const expected = {
  leftRightOffsetShiftMs: -50,
  callTrainOffsetShiftMs: 50,
  leftRightSlopeMsPerHour: 75,
  callTrainSlopeMsPerHour: -75,
  micTrainSlopeMsPerHour: -75,
};
/** How far each recovered value may be from the expected one. */
const tolerance = {
  leftRightOffsetShiftMs: 1,
  callTrainOffsetShiftMs: 1,
  leftRightSlopeMsPerHour: 4,
  callTrainSlopeMsPerHour: 1.5,
  micTrainSlopeMsPerHour: 4,
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const keys = Object.keys(expected) as Array<keyof typeof expected>;
const pass = Object.fromEntries(
  keys.map((k) => [k, Math.abs(recovered[k] - expected[k]) <= tolerance[k]]),
);
const result = {
  recovered: Object.fromEntries(keys.map((k) => [k, r2(recovered[k])])),
  expected,
  tolerance,
  pass,
  variants: results,
};
const text = JSON.stringify(result, null, 2);
const out = opt("--out");
if (out) writeFileSync(out, `${text}\n`);
console.log(text);
if (!Object.values(pass).every(Boolean)) process.exit(1);
