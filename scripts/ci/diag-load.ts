// Temporary (issue #491): keeps a disk busy, as a build does: 4 MB writes with an fsync each.
import { fsyncSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const f = join(process.argv[2] ?? ".", `akou-load-${process.pid}.bin`);
const buf = new Uint8Array(4 << 20).fill(7);
const end = Date.now() + Number(process.argv[3] ?? 60) * 1000;
let fd = openSync(f, "w");
let n = 0;
while (Date.now() < end) {
  writeSync(fd, buf);
  fsyncSync(fd);
  if (++n % 64 === 0) { closeSync(fd); fd = openSync(f, "w"); }
}
closeSync(fd);
unlinkSync(f);
