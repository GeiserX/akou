/**
 * The keys file an edit must not wipe (docs/TRAPS.md SV-K2).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyError, KeyStore } from "../src/main/api/keys.ts";

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
