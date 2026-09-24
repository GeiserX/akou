// Temporary: replays the token write path on Windows and prints the raw ACL after each step.
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sys = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
const run = (exe: string, args: string[]) => {
  const r = Bun.spawnSync([sys(exe), ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const dump = (label: string, path: string) => {
  const out = join(tmpdir(), `probe-${Math.random().toString(16).slice(2)}`);
  const s = run("icacls.exe", [path, "/save", out]);
  let bytes = Buffer.alloc(0);
  try {
    bytes = readFileSync(out);
  } catch {}
  rmSync(out, { force: true });
  const h = run("icacls.exe", [path]);
  console.log(`== ${label}`);
  console.log(`save exit ${s.code} ${s.err.trim()}`);
  console.log(`save hex ${bytes.toString("hex")}`);
  console.log(`save utf16 ${JSON.stringify(bytes.toString("utf16le"))}`);
  console.log(`human ${JSON.stringify(h.out)}`);
};

const who = run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
console.log(`whoami ${JSON.stringify(who)}`);
console.log(
  `whoami groups ${JSON.stringify(run("whoami.exe", ["/groups", "/fo", "csv", "/nh"]).out)}`,
);
const sid = /S-1-[0-9-]+/.exec(who.out)?.[0] ?? "";
const base = mkdtempSync(join(tmpdir(), "akou-probe-"));
const dir = join(base, ".config", "akou");
mkdirSync(dir, { recursive: true, mode: 0o700 });
dump("dir", dir);
const path = join(dir, "token");
const tmp = `${path}.tmp`;
const fd = openSync(tmp, "wx", 0o600);
dump("tmp created", tmp);
console.log(
  `restrict ${JSON.stringify(run("icacls.exe", [tmp, "/inheritance:r", "/grant:r", `*${sid}:F`]))}`,
);
dump("tmp restricted", tmp);
writeSync(fd, "x\n");
closeSync(fd);
dump("tmp written", tmp);
chmodSync(tmp, 0o600);
dump("tmp chmod", tmp);
linkSync(tmp, path);
dump("linked", path);
rmSync(tmp);
dump("linked, tmp gone", path);
const tmp2 = `${path}.2.tmp`;
const fd2 = openSync(tmp2, "wx", 0o600);
run("icacls.exe", [tmp2, "/inheritance:r", "/grant:r", `*${sid}:F`]);
writeSync(fd2, "y\n");
closeSync(fd2);
chmodSync(tmp2, 0o600);
renameSync(tmp2, path);
dump("renamed", path);
rmSync(base, { recursive: true, force: true });
