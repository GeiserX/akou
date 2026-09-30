/**
 * Where akou keeps the provider's API key (docs/providers.md "Keys", PROGRAMMABILITY PG-Z3).
 *
 * On macOS it is a generic password in the login Keychain, service `akou`, account
 * `provider.apiKey`, written and read through Apple's `security` command: `config.json` never holds
 * it. On Windows and Linux there is no store yet (Credential Manager and libsecret come later), so
 * the key stays in `config.json`, which only its owner can read.
 *
 * The key never reaches a command line, where `ps` would show it: it is written by `security -i`,
 * which reads the command from stdin, as hex (`-X`), so nothing in it needs quoting. No error from
 * here carries what `security` printed, since that could be the key.
 */

/** The settings kept in the store instead of `config.json`. */
export const STORED_SECRETS = ["provider.apiKey"] as const;
export type StoredSecret = (typeof STORED_SECRETS)[number];

export interface SecretStore {
  /** What the Settings page says the key is saved in. */
  readonly where: "keychain";
  /** The value, or null when the store has none. Throws when the store cannot be read. */
  get(key: StoredSecret): string | null;
  /** Saves the value, then reads it back. Throws when either fails. */
  set(key: StoredSecret, value: string): void;
  /** Removes the value; one that was not there is not an error. Throws when the store refuses. */
  remove(key: StoredSecret): void;
}

/** `security`'s exit status when no item matches. */
const NOT_FOUND = 44;

export interface KeychainOptions {
  /** The `security` command; tests pass a fake. */
  command?: readonly string[];
  /** The environment it runs with. */
  env?: Record<string, string | undefined>;
  /** A keychain file instead of the default one. */
  keychain?: string;
  service?: string;
}

/** The macOS Keychain through the `security` command. */
export function keychainStore(o: KeychainOptions = {}): SecretStore {
  const command = o.command ?? ["/usr/bin/security"];
  const service = o.service ?? "akou";
  const at = o.keychain ? [o.keychain] : [];
  const run = (args: string[], stdin?: string) => {
    const p = Bun.spawnSync([...command, ...args], {
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: (o.env ?? process.env) as Record<string, string>,
    });
    return { code: p.exitCode ?? -1, out: p.stdout.toString() };
  };
  const get = (key: StoredSecret): string | null => {
    const r = run(["find-generic-password", "-s", service, "-a", key, "-w", ...at]);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`the Keychain could not be read (security exit ${r.code})`);
    return r.out.replace(/\r?\n$/, "");
  };
  return {
    where: "keychain",
    get,
    set(key, value) {
      if (value === "") throw new Error("an empty key is removed, not saved");
      const hex = Buffer.from(value, "utf8").toString("hex");
      const where = o.keychain ? ` ${o.keychain}` : "";
      const r = run(["-i"], `add-generic-password -U -s ${service} -a ${key} -X ${hex}${where}\n`);
      // `security -i` exits 0 when a command in it fails: the read back is the check.
      if (r.code !== 0 || get(key) !== value)
        throw new Error("the Keychain did not keep the key (security refused it)");
    },
    remove(key) {
      const r = run(["delete-generic-password", "-s", service, "-a", key, ...at]);
      if (r.code !== 0 && r.code !== NOT_FOUND)
        throw new Error(`the Keychain did not remove the key (security exit ${r.code})`);
    },
  };
}

/** The store this OS has: the Keychain on macOS, none elsewhere (the key stays in the file). */
export function systemSecrets(platform: string = process.platform): SecretStore | null {
  return platform === "darwin" ? keychainStore() : null;
}
