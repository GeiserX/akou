/**
 * The keys file an edit must not wipe (docs/TRAPS.md SV-K2), and the private file write that must
 * not rename a cut file over a secret (T4.43).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "../src/main/api/guard.ts";
import { KeyError, KeyStore } from "../src/main/api/keys.ts";
import { runCli } from "../src/main/cli/cli.ts";
import { EXIT } from "../src/main/cli/client.ts";

const dirs: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "akou-keys-file-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("[SV-K2] A key edit over a keys file that does not read", () => {
  // A store made after the file broke, as the CLI's is, holds no keys from it.
  for (const [what, text] of [
    ["not valid JSON", '{"version": 1, "keys": [],}\n'],
    ["JSON with no key list", '{"version": 1}\n'],
  ] as const) {
    test(`[SV-K2] a file that is ${what} is refused and left byte for byte`, () => {
      const d = dir();
      writeFileSync(join(d, "keys.json"), text);
      const store = new KeyStore(d);
      let err: unknown;
      try {
        store.create({ name: "new" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(KeyError);
      expect((err as KeyError).reason).toBe("file");
      expect(readFileSync(join(d, "keys.json"), "utf8")).toBe(text);
      expect(() => store.revoke("key_00000000")).toThrow(KeyError);
      expect(readFileSync(join(d, "keys.json"), "utf8")).toBe(text);
    });
  }

  test("[SV-K2] `akou keys revoke` over a broken file answers bad_key and leaves it byte for byte", async () => {
    const home = dir();
    const configDir = join(home, ".config", "akou");
    mkdirSync(configDir, { recursive: true });
    const text = '{"version": 1, "keys": [],}\n';
    writeFileSync(join(configDir, "keys.json"), text);
    const out: string[] = [];
    const code = await runCli(
      ["keys", "revoke", "key_00000000", "--json"],
      { env: { ...process.env, AKOU_HOME: home }, out: (s) => out.push(s), err: () => {} },
      { launch: null },
    );
    expect(JSON.parse(out.join("")).error).toBe("bad_key");
    expect(code).toBe(EXIT.usage);
    expect(readFileSync(join(configDir, "keys.json"), "utf8")).toBe(text);
  });

  test("[SV-K2] positive control: a valid file keeps its key when another is made", () => {
    const d = dir();
    const first = new KeyStore(d).create({ name: "first" });
    const store = new KeyStore(d);
    store.create({ name: "second" });
    expect(
      store
        .list()
        .map((k) => k.id)
        .includes(first.id),
    ).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  test("[SV-K2] no file at all is a first key, not a refusal", () => {
    const d = dir();
    new KeyStore(d).create({ name: "first" });
    expect(new KeyStore(d).list()).toHaveLength(1);
  });
});

describe("[T4.43] A short write renamed over a private file", () => {
  const text = `${JSON.stringify({ version: 1, keys: [], pad: "x".repeat(10_000) })}\n`;

  test("[T4.43] every byte goes, over as many short writes as the disk takes", () => {
    const d = dir();
    const path = join(d, "keys.json");
    // At most 1000 bytes a call, as a disk filling up and then freeing would take them.
    const write = (fd: number, b: Uint8Array) => writeSync(fd, b.subarray(0, 1000));
    expect(writePrivateFile(path, text, true, write)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("[T4.43] a full disk throws, keeps the old file and leaves no temporary file", () => {
    const d = dir();
    const path = join(d, "keys.json");
    writeFileSync(path, "old\n");
    let calls = 0;
    // The first call takes half, the next nothing: the disk is full.
    const write = (fd: number, b: Uint8Array) =>
      calls++ === 0 ? writeSync(fd, b.subarray(0, b.length >> 1)) : 0;
    expect(() => writePrivateFile(path, text, true, write)).toThrow(/short write/);
    expect(readFileSync(path, "utf8")).toBe("old\n");
    expect(readdirSync(d)).toEqual(["keys.json"]);
  });
});
