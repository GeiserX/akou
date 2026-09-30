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
 *
 * A read is synchronous (the settings need the key at start); a save or a removal is not, so a
 * Keychain waiting on a password prompt holds only that request, never the rest of the app.
 */

/** The settings kept in the store instead of `config.json`. */
export const STORED_SECRETS = ["provider.apiKey"] as const;
export type StoredSecret = (typeof STORED_SECRETS)[number];

export interface SecretStore {
  /** What the Settings page says the key is saved in. */
  readonly where: "keychain";
  /** The value, or null when the store has none. Throws when the store cannot be read. */
  get(key: StoredSecret): string | null;
  /** Saves the value, then reads it back. Rejects when either fails. */
  set(key: StoredSecret, value: string): Promise<void>;
  /** Removes the value; one that was not there is not an error. Rejects when the store refuses. */
  remove(key: StoredSecret): Promise<void>;
}

/**
 * What a key may be: printable ASCII, no spaces. `security find-generic-password -w` prints any
 * other value as hex, so it could not be read back as it was saved.
 */
export const KEY_TEXT = /^[\x21-\x7e]*$/;

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
  /** How long one `security` run may take, ms; 10 s by default. */
  timeoutMs?: number;
}

/** The macOS Keychain through the `security` command. */
export function keychainStore(o: KeychainOptions = {}): SecretStore {
  const command = o.command ?? ["/usr/bin/security"];
  const service = o.service ?? "akou";
  const at = o.keychain ? [o.keychain] : [];
  const spawnOptions = {
    stdout: "pipe",
    stderr: "pipe",
    env: (o.env ?? process.env) as Record<string, string>,
    // A Keychain that never answers must not hold akou: a killed run is a failed one.
    timeout: o.timeoutMs ?? 10_000,
  } as const;
  const run = (args: string[]) => {
    const p = Bun.spawnSync([...command, ...args], { ...spawnOptions, stdin: "ignore" });
    return { code: p.exitCode ?? -1, out: p.stdout.toString() };
  };
  const runAsync = async (args: string[], stdin?: string) => {
    const p = Bun.spawn([...command, ...args], {
      ...spawnOptions,
      stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    });
    // Both pipes drained, so a chatty `security` never fills one and stalls.
    const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: (await p.exited) ?? -1, out };
  };
  const found = (r: { code: number; out: string }): string | null => {
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`the Keychain could not be read (security exit ${r.code})`);
    return r.out.replace(/\r?\n$/, "");
  };
  const find = (key: StoredSecret) => [
    "find-generic-password",
    "-s",
    service,
    "-a",
    key,
    "-w",
    ...at,
  ];
  const get = (key: StoredSecret): string | null => found(run(find(key)));
  return {
    where: "keychain",
    get,
    async set(key, value) {
      if (value === "") throw new Error("an empty key is removed, not saved");
      if (!KEY_TEXT.test(value)) throw new Error("a key is letters, digits and symbols only");
      const hex = Buffer.from(value, "utf8").toString("hex");
      const where = o.keychain ? ` ${o.keychain}` : "";
      const r = await runAsync(
        ["-i"],
        `add-generic-password -U -s ${service} -a ${key} -X ${hex}${where}\n`,
      );
      // The exit status of `security -i` is its last command's; the read back also proves the
      // Keychain holds this value, byte for byte, and not one it changed or dropped.
      const back =
        r.code === 0
          ? await runAsync(find(key))
              .then(found)
              .catch(() => null)
          : null;
      if (back !== value)
        throw new Error("the Keychain did not keep the key (security refused it)");
    },
    async remove(key) {
      const { code } = await runAsync(["delete-generic-password", "-s", service, "-a", key, ...at]);
      if (code !== 0 && code !== NOT_FOUND)
        throw new Error(`the Keychain did not remove the key (security exit ${code})`);
    },
  };
}

/** The store this OS has: the Keychain on macOS, none elsewhere (the key stays in the file). */
export function systemSecrets(platform: string = process.platform): SecretStore | null {
  return platform === "darwin" ? keychainStore() : null;
}
