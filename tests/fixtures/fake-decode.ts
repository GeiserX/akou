/**
 * A stand-in for `akou-capture decode` (SV-P10), so the app's side of the protocol is tested without
 * a Rust build: `decode --in FILE --info` and `decode --in FILE --from F --frames N`.
 *
 * FILE holds a frame count as text. Frame `i` is `i / 1e6` on the mic and `-i / 1e6` on the call,
 * so a test sees which frames came back on which channel. A FILE reading `broken` exits 74 with a
 * warn line, as the helper does for a file it cannot read. Every run appends its arguments to
 * `FILE.calls`, so a test can count the decodes.
 */

import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
if (argv[0] !== "decode") process.exit(64);
const file = opt("--in") as string;
appendFileSync(`${file}.calls`, `${argv.slice(1).join(" ")}\n`);
const text = readFileSync(file, "utf8").trim();
if (text === "broken") {
  process.stderr.write(
    `${JSON.stringify({ type: "warn", code: "io", msg: "not an Ogg Opus file" })}\n`,
  );
  process.exit(74);
}
const total = Number(text);
if (argv.includes("--info")) {
  console.log(
    JSON.stringify({ type: "decoded", rate: 16000, channels: 2, frames: total, ended: true }),
  );
  process.exit(0);
}
const from = Number(opt("--from") ?? 0);
const end = Math.min(total, from + Number(opt("--frames") ?? total));
const out = new Float32Array(Math.max(0, end - from) * 2);
for (let i = from; i < end; i++) {
  out[2 * (i - from)] = i / 1e6;
  out[2 * (i - from) + 1] = -i / 1e6;
}
process.stdout.write(new Uint8Array(out.buffer));
