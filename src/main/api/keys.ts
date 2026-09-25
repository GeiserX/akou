/**
 * API keys for server mode (docs/ux/SERVER.md SV-K2 to SV-K4): one key per client program, each
 * with its scope, its callback hosts and its own webhook secret.
 *
 * - `akou keys create` prints `ak_<32 random bytes, base64url>` and `whsec_<24 bytes, base64>`
 *   once. The key is kept only as its SHA-256, which is enough for 32 random bytes; the webhook
 *   secret is kept as it is, since akou signs with it.
 * - Both live in `keys.json` in the config folder, written like the token file: atomically, mode
 *   0600 from its creation (`writePrivateFile`). Moving the secrets to the OS keychain is PG-Z3.
 * - The file is the truth. The CLI edits it with no app running (a container's entrypoint, or a
 *   box where the server is down), and the running server reads it again whenever it changes, so
 *   a revoked key gets 401 on its next request.
 * - When a key was last used goes to `keys-used.json`, which only the server writes, at most once a
 *   minute per key, so the server never rewrites the file the CLI edits.
 * - A create or a revoke reads, changes and writes the file under `keys.json.lock`, so two edits
 *   at once cannot write back a list the other changed (a revoked key coming back). An edit that
 *   finds the lock held is refused, never queued.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  acquireLock,
  INSTANCE_ID,
  LockError,
  processAlive,
  readLock,
} from "../../core/log/writer.ts";
import { type Identity, SCOPES, type Scope } from "./access.ts";
import { writePrivateFile } from "./guard.ts";

export const KEYS_FILE = "keys.json";
export const KEYS_USED_FILE = "keys-used.json";
/** `last_used_at` is written at most this often per key. */
export const TOUCH_EVERY_MS = 60_000;

export interface KeyRecord {
  id: string;
  name: string;
  scopes: Scope[];
  callback_hosts: string[];
  created_at: number;
  /** SHA-256 of the `ak_` key, hex. */
  sha256: string;
  /** The webhook signing secret, `whsec_…`. */
  secret: string;
}

/** What `akou keys list` shows: never the hash, never the secret. */
export interface KeyInfo {
  id: string;
  name: string;
  scopes: Scope[];
  callback_hosts: string[];
  created_at: number;
  last_used_at: number | null;
}

export interface CreatedKey {
  id: string;
  name: string;
  scopes: Scope[];
  callback_hosts: string[];
  created_at: number;
  /** Shown once. */
  key: string;
  /** Shown once. */
  secret: string;
}

export class KeyError extends Error {
  override name = "KeyError";
}

export function newApiKey(): string {
  return `ak_${randomBytes(32).toString("base64url")}`;
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
/** A host name or an address, no scheme, no path, no port; or `*`. */
const HOST = /^(\*|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|[0-9a-f:.]+)$/;

function valid(r: unknown): r is KeyRecord {
  const k = r as KeyRecord;
  return (
    typeof k === "object" &&
    k !== null &&
    typeof k.id === "string" &&
    typeof k.name === "string" &&
    Array.isArray(k.scopes) &&
    k.scopes.every((s) => (SCOPES as readonly string[]).includes(s)) &&
    Array.isArray(k.callback_hosts) &&
    k.callback_hosts.every((h) => typeof h === "string") &&
    typeof k.created_at === "number" &&
    typeof k.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(k.sha256) &&
    typeof k.secret === "string"
  );
}

export class KeyStore {
  readonly path: string;
  readonly usedPath: string;
  private keys: KeyRecord[] = [];
  private stamp = "";
  private used: Record<string, number> = {};
  private usedWritten: Record<string, number> = {};

  constructor(
    readonly configDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(configDir, KEYS_FILE);
    this.usedPath = join(configDir, KEYS_USED_FILE);
    this.used = this.readUsed();
    this.usedWritten = { ...this.used };
  }

  private fileStamp(): string {
    try {
      const s = statSync(this.path);
      return `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`;
    } catch {
      return "";
    }
  }

  /** The keys as the file holds them now. A file that is not ours keeps the last good read. */
  private load(): KeyRecord[] {
    const stamp = this.fileStamp();
    if (stamp === this.stamp) return this.keys;
    this.stamp = stamp;
    if (stamp === "") {
      this.keys = [];
      return this.keys;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { keys?: unknown };
      if (Array.isArray(parsed.keys)) this.keys = parsed.keys.filter(valid);
    } catch {}
    return this.keys;
  }

  private save(keys: KeyRecord[]): void {
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    writePrivateFile(this.path, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, true);
    this.stamp = "";
  }

  /** Runs one read-change-write of the file under its lock, on the file as it is now. */
  private edit<T>(fn: (keys: KeyRecord[]) => T): T {
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    const lock = `${this.path}.lock`;
    try {
      acquireLock(lock, process.pid, processAlive);
    } catch (err) {
      if (err instanceof LockError) {
        throw new KeyError(
          `another edit of the keys (pid ${err.holderPid}) is running; run this again when it ends`,
        );
      }
      throw err;
    }
    try {
      this.stamp = "";
      return fn([...this.load()]);
    } finally {
      const held = readLock(lock);
      if (held?.pid === process.pid && held.id === INSTANCE_ID) {
        try {
          unlinkSync(lock);
        } catch {}
      }
    }
  }

  private readUsed(): Record<string, number> {
    try {
      const o = JSON.parse(readFileSync(this.usedPath, "utf8")) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(o).filter((e): e is [string, number] => typeof e[1] === "number"),
      );
    } catch {
      return {};
    }
  }

  create(o: { name: string; scope?: Scope; callbackHosts?: readonly string[] }): CreatedKey {
    const name = o.name.trim();
    if (!NAME.test(name)) {
      throw new KeyError(
        "a key's name is 1 to 64 letters, digits, spaces, dots, dashes or underscores",
      );
    }
    const scope = o.scope ?? "jobs";
    if (!(SCOPES as readonly string[]).includes(scope)) {
      throw new KeyError(`the scope is one of ${SCOPES.join(", ")}`);
    }
    const hosts = [...new Set((o.callbackHosts ?? []).map((h) => h.trim().toLowerCase()))];
    const bad = hosts.find((h) => !HOST.test(h));
    if (bad !== undefined) {
      throw new KeyError(`"${bad}" is not a host name or an address (no scheme, port or path)`);
    }
    return this.edit((keys) => {
      if (keys.some((k) => k.name === name)) throw new KeyError(`a key named "${name}" exists`);
      let id: string;
      do id = `key_${randomBytes(4).toString("hex")}`;
      while (keys.some((k) => k.id === id));
      const key = newApiKey();
      const secret = newWebhookSecret();
      const record: KeyRecord = {
        id,
        name,
        scopes: [scope],
        callback_hosts: hosts,
        created_at: this.now(),
        sha256: hashKey(key),
        secret,
      };
      this.save([...keys, record]);
      const { sha256: _h, secret: _s, ...info } = record;
      return { ...info, key, secret };
    });
  }

  list(): KeyInfo[] {
    const used = { ...this.readUsed(), ...this.used };
    return this.load().map((k) => ({
      id: k.id,
      name: k.name,
      scopes: [...k.scopes],
      callback_hosts: [...k.callback_hosts],
      created_at: k.created_at,
      last_used_at: used[k.id] ?? null,
    }));
  }

  /** Removes a key by its id, never its name. False when there is none. */
  revoke(id: string): boolean {
    return this.edit((keys) => {
      const next = keys.filter((k) => k.id !== id);
      if (next.length === keys.length) return false;
      this.save(next);
      return true;
    });
  }

  /** The key a bearer value names, as an identity; null for anything else. */
  authenticate(bearer: string): Identity | null {
    if (!bearer.startsWith("ak_")) return null;
    const digest = Buffer.from(hashKey(bearer), "hex");
    let found: KeyRecord | null = null;
    // Every stored hash is compared, in constant time, so the answer's timing names no key.
    for (const k of this.load()) {
      if (timingSafeEqual(digest, Buffer.from(k.sha256, "hex"))) found = k;
    }
    if (!found) return null;
    return {
      id: found.id,
      name: found.name,
      scopes: [...found.scopes],
      created_at: found.created_at,
      callbackHosts: [...found.callback_hosts],
    };
  }

  /** The webhook secret of a key, for signing its deliveries (SV-E2). */
  secretOf(id: string): string | null {
    return this.load().find((k) => k.id === id)?.secret ?? null;
  }

  /** Notes a use of the key; written to `keys-used.json` at most once a minute per key. */
  touch(id: string): void {
    const t = this.now();
    this.used[id] = t;
    if (t - (this.usedWritten[id] ?? 0) < TOUCH_EVERY_MS) return;
    this.usedWritten[id] = t;
    try {
      writePrivateFile(this.usedPath, `${JSON.stringify(this.used)}\n`, true);
    } catch {}
  }
}
