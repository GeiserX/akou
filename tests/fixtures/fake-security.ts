/**
 * A stand-in for macOS's `security` command, so no test touches a real Keychain. It keeps generic
 * passwords in the JSON file `FAKE_SECURITY_STORE` names, appends every command line it was given
 * to `<store>.argv` (one JSON array per line, so a test can prove no key was on one), and speaks the
 * three commands akou uses: `find-generic-password -s S -a A -w`, `delete-generic-password -s S
 * -a A`, and `-i` with `add-generic-password -U -s S -a A -X HEX` lines on stdin.
 *
 * As the real one: `-i` exits with its last command's status, and `find-generic-password -w`
 * prints a value holding anything but printable ASCII as hex.
 *
 * `FAKE_SECURITY_REFUSE=add` makes an add fail (exit 1); `=drop` makes it exit 0 and keep nothing,
 * a Keychain that says yes and holds something else; `=all` makes every command exit 51, as a
 * locked or missing Keychain does; `=hang` never answers, as a Keychain waiting on a prompt nobody
 * sees; `=hang-add` hangs only the save. The file `<store>.refuse` says the same and wins.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const store = process.env.FAKE_SECURITY_STORE ?? "";
// The file `<store>.refuse`, when there, wins: a test can change it between two commands.
const refuse = existsSync(`${store}.refuse`)
  ? readFileSync(`${store}.refuse`, "utf8").trim()
  : (process.env.FAKE_SECURITY_REFUSE ?? "");
const args = process.argv.slice(2);
appendFileSync(`${store}.argv`, `${JSON.stringify(args)}\n`);

type Items = Record<string, string>;
const read = (): Items => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {});
const write = (items: Items) => writeFileSync(store, JSON.stringify(items));
const flag = (a: string[], f: string) => a[a.indexOf(f) + 1] ?? "";
const id = (a: string[]) => `${flag(a, "-s")}/${flag(a, "-a")}`;

if (refuse === "all") process.exit(51);
if (refuse === "hang" || (refuse === "hang-add" && args[0] === "-i")) await Bun.sleep(60_000);

function run(a: string[]): number {
  const items = read();
  if (a[0] === "find-generic-password") {
    const v = items[id(a)];
    if (v === undefined) return 44;
    const plain = /^[\x20-\x7e]*$/.test(v);
    process.stdout.write(`${plain ? v : Buffer.from(v, "utf8").toString("hex")}\n`);
    return 0;
  }
  if (a[0] === "delete-generic-password") {
    if (items[id(a)] === undefined) return 44;
    delete items[id(a)];
    write(items);
    return 0;
  }
  if (a[0] === "add-generic-password") {
    if (refuse === "add") return 1;
    if (refuse === "drop") return 0;
    if (items[id(a)] !== undefined && !a.includes("-U")) return 45;
    items[id(a)] = Buffer.from(flag(a, "-X"), "hex").toString("utf8");
    write(items);
    return 0;
  }
  return 2;
}

if (args[0] === "-i") {
  // Interactive mode: one command per stdin line; the exit status is the last one's.
  const input = await Bun.stdin.text();
  let code = 0;
  for (const line of input.split("\n").filter((l) => l.trim() !== ""))
    code = run(line.trim().split(/\s+/));
  process.exit(code);
}
process.exit(run(args));
