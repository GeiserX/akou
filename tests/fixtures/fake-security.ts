/**
 * A stand-in for macOS's `security` command, so no test touches a real Keychain. It keeps generic
 * passwords in the JSON file `FAKE_SECURITY_STORE` names, appends every command line it was given
 * to `<store>.argv` (one JSON array per line, so a test can prove no key was on one), and speaks the
 * three commands akou uses: `find-generic-password -s S -a A -w`, `delete-generic-password -s S
 * -a A`, and `-i` with `add-generic-password -U -s S -a A -X HEX` lines on stdin.
 *
 * `FAKE_SECURITY_REFUSE=add` makes an add a silent no-op, as `security -i` exits 0 when a command
 * in it fails; `=all` makes every command exit 51, as a locked or missing Keychain does; `=hang`
 * never answers, as a Keychain waiting on a prompt nobody sees.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const store = process.env.FAKE_SECURITY_STORE ?? "";
const refuse = process.env.FAKE_SECURITY_REFUSE ?? "";
const args = process.argv.slice(2);
appendFileSync(`${store}.argv`, `${JSON.stringify(args)}\n`);

type Items = Record<string, string>;
const read = (): Items => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {});
const write = (items: Items) => writeFileSync(store, JSON.stringify(items));
const flag = (a: string[], f: string) => a[a.indexOf(f) + 1] ?? "";
const id = (a: string[]) => `${flag(a, "-s")}/${flag(a, "-a")}`;

if (refuse === "all") process.exit(51);
if (refuse === "hang") await Bun.sleep(60_000);

function run(a: string[]): number {
  const items = read();
  if (a[0] === "find-generic-password") {
    const v = items[id(a)];
    if (v === undefined) return 44;
    process.stdout.write(`${v}\n`);
    return 0;
  }
  if (a[0] === "delete-generic-password") {
    if (items[id(a)] === undefined) return 44;
    delete items[id(a)];
    write(items);
    return 0;
  }
  if (a[0] === "add-generic-password") {
    if (refuse === "add") return 0;
    if (items[id(a)] !== undefined && !a.includes("-U")) return 45;
    items[id(a)] = Buffer.from(flag(a, "-X"), "hex").toString("utf8");
    write(items);
    return 0;
  }
  return 2;
}

if (args[0] === "-i") {
  // Interactive mode: one command per stdin line; the exit status stays 0, as the real one's does.
  const input = await Bun.stdin.text();
  for (const line of input.split("\n").filter((l) => l.trim() !== ""))
    run(line.trim().split(/\s+/));
  process.exit(0);
}
process.exit(run(args));
