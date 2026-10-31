// Temporary (issue #491): times each step of a call start's folder stage on this machine's disk.
import { fsyncSync, linkSync, mkdirSync, mkdtempSync, openSync, unlinkSync, writeFileSync, writeSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LogWriter } from "../../src/core/log/writer.ts";
import { createCallFolder, folderName, ulid } from "../../src/main/call/folder.ts";

const base = process.argv[2] ?? process.env.TEMP ?? "/tmp";
const label = process.argv[3] ?? base;
const root = mkdtempSync(join(base, "akou-diag-"));
const ms = (t: number) => Math.round((performance.now() - t) * 100) / 100;

let t = performance.now();
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const intl = ms(t);
t = performance.now();
folderName(Date.now(), tz, "Call");
const fname = ms(t);
console.log(`[${label}] first Intl ${intl} ms, first folderName ${fname} ms`);

for (let i = 1; i <= 6; i++) {
  const row: Record<string, number> = {};
  const step = (name: string, fn: () => void) => {
    const s = performance.now();
    fn();
    row[name] = ms(s);
  };
  const ws = join(root, `ws${i}`);
  const dir = join(ws, folderName(Date.now(), tz, `call ${i}`));
  step("mkdirParent", () => mkdirSync(ws, { recursive: true }));
  step("mkdirCall", () => mkdirSync(dir));
  step("mkdirAudio", () => mkdirSync(join(dir, "audio")));
  step("mkdirLogs", () => mkdirSync(join(dir, "logs")));
  const lock = join(dir, ".akou.lock");
  const tmp = `${lock}.tmp`;
  step("lockWrite", () => writeFileSync(tmp, `${process.pid} x\n`));
  step("lockLink", () => linkSync(tmp, lock));
  step("lockUnlinkTmp", () => unlinkSync(tmp));
  const log = join(dir, "events.jsonl");
  step("exists", () => void existsSync(log));
  let fd = -1;
  step("open", () => {
    fd = openSync(log, "a");
  });
  step("write", () => void writeSync(fd, new TextEncoder().encode(`{"seq":1}\n`)));
  step("fsync", () => fsyncSync(fd));
  step("close", () => closeSync(fd));
  const total = Object.values(row).reduce((a, b) => a + b, 0);
  // The real path, in a second workspace: createCallFolder then the writer's open and first append.
  const s = performance.now();
  const d2 = createCallFolder(root, `real${i}`, Date.now(), tz, "Call");
  const r1 = ms(s);
  const s2 = performance.now();
  const w = LogWriter.open(d2);
  const r2 = ms(s2);
  const s3 = performance.now();
  w.append({ type: "call.created", id: ulid(Date.now()), schema: 1, workspace: "x", title: "Call", tz, user: "", akou: "0.0.0" } as never);
  const r3 = ms(s3);
  w.close();
  console.log(
    `[${label}] #${i} ${Object.entries(row).map(([k, v]) => `${k}=${v}`).join(" ")} sum=${Math.round(total)} | real: folder=${r1} open=${r2} created=${r3}`,
  );
}
