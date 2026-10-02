/**
 * A stand-in for `akou-capture encode` and `decode` on a dictation's kept audio (DC-H2), so the
 * app's side is tested without a Rust build. `encode --out FILE` writes `FAKEOPUS` and the f32
 * samples read from stdin; `decode --in FILE` writes them back as stereo f32, the same on both
 * sides, as the helper decodes a mono file.
 *
 * Switches before the command: `--fail` makes `encode` exit 74 with a warn line, as the helper does
 * for a file it cannot write; `--delay MS` holds `encode` that long before it writes.
 */

import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const MAGIC = new TextEncoder().encode("FAKEOPUS");

if (argv.includes("encode")) {
  const samples = new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
  if (argv.includes("--fail")) {
    process.stderr.write(`${JSON.stringify({ type: "warn", code: "io", msg: "disk full" })}\n`);
    process.exit(74);
  }
  await Bun.sleep(Number(opt("--delay") ?? 0));
  const out = new Uint8Array(MAGIC.length + samples.length);
  out.set(MAGIC);
  out.set(samples, MAGIC.length);
  writeFileSync(opt("--out") as string, out);
  console.log(
    JSON.stringify({ type: "encoded", rate: 16000, channels: 1, frames: samples.length / 4 }),
  );
} else if (argv.includes("decode")) {
  const file = readFileSync(opt("--in") as string);
  const mono = new Float32Array(new Uint8Array(file.subarray(MAGIC.length)).buffer);
  const stereo = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) stereo[2 * i] = stereo[2 * i + 1] = mono[i] as number;
  process.stdout.write(new Uint8Array(stereo.buffer));
} else {
  process.exit(64);
}
