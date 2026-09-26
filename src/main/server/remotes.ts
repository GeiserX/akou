/**
 * Other akou servers this one hands jobs to (docs/ux/SERVER.md section 14). A client talks to one
 * akou: one URL, one key, one callback secret, one event feed. That akou, the primary, may send a
 * job to a remote akou on the network, for example a Mac mini running `akou serve` with a GPU, and
 * still owns the job: the client sees the primary's job id, feed and webhook, never the remote.
 *
 * - **Which remotes.** `server.remotes` in the config file, one entry per remote:
 *   `<url> <key file> [names]`. The URL is the remote's base, as `AKOU_URL` takes it; the key file
 *   holds a `jobs` key of the remote, read at each request and never written anywhere else, shown
 *   by no route and no log line. `names`, comma-separated, are the presets or model ids that go to
 *   this remote first even when the primary could run them itself (`*` for every job); without
 *   them the remote gets only the jobs the primary cannot run.
 * - **What each offers.** Every remote is probed at start and every `REMOTE_PROBE_MS`:
 *   `GET /v1/server` (no key) for the presets it lists as available and the engines it has, then
 *   `GET /v1/keys/me` with the key. Up, down (no answer, or not an akou server with jobs), or
 *   refused (the key is not accepted, or its file cannot be read).
 * - **The protocol** is the public job API and nothing else: `POST /v1/jobs` with the job's own id
 *   as `Idempotency-Key`, so a retried upload never transcribes twice, then `GET /v1/jobs/{id}?wait`
 *   and `GET /v1/jobs/{id}/result`. The primary sends no `callback_url` and no `metadata`: the
 *   remote needs neither, and the client's metadata stays on the primary. The `Akou-Forwarded`
 *   header marks a forwarded job, and a server never forwards such a job again, so two servers
 *   listing each other cannot pass a job back and forth.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How often every remote is probed, besides at start and after a remote fails a request. */
export const REMOTE_PROBE_MS = 30_000;
/** Jobs one remote holds at once: the one it runs and the next, uploaded while the first runs. */
export const REMOTE_IN_FLIGHT = 2;
/** The long-poll on a remote job, in seconds. */
export const REMOTE_WAIT_S = 30;
/** A probe or a small request that has had no answer by then is a remote that is down. */
export const REMOTE_TIMEOUT_MS = 10_000;
/** The header a forwarded job carries; its server runs it itself or not at all. */
export const FORWARDED_HEADER = "akou-forwarded";

export interface RemoteEntry {
  /** The base URL, without a trailing slash. */
  url: string;
  keyFile: string;
  /** Presets or model ids sent here first, `*` for all; empty: only what this server cannot run. */
  takes: readonly string[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One `server.remotes` entry, or the reason it is refused. */
export function parseRemote(raw: string): RemoteEntry | string {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3 || parts[0] === "") {
    return `${JSON.stringify(raw)} is not "<url> <key file> [presets]"`;
  }
  const [rawUrl, keyFile, names] = parts as [string, string, string | undefined];
  let url: URL | null = null;
  try {
    url = new URL(rawUrl);
  } catch {}
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return `${rawUrl} is not an http or https URL`;
  }
  if (url.username || url.password) {
    return "a remote's URL must not carry a user name or password; its key goes in the key file";
  }
  if (/[?#]/.test(url.href)) return `${rawUrl} must not carry a query or a fragment`;
  if (!keyFile.startsWith("/") && !/^~[\\/]/.test(keyFile) && !/^[A-Za-z]:[\\/]/.test(keyFile)) {
    return `the key file ${keyFile} must be an absolute path, or start with ~/`;
  }
  const takes = names === undefined ? [] : names.split(",").filter((n) => n !== "");
  const bad = takes.find((n) => n !== "*" && !NAME.test(n));
  if (bad !== undefined) return `${bad} is not a preset, a model id or *`;
  return { url: rawUrl.replace(/\/+$/, ""), keyFile, takes };
}

/** The `check` of the `server.remotes` setting. */
export function checkRemotes(v: readonly string[]): string | null {
  for (const r of v) {
    const e = parseRemote(r);
    if (typeof e === "string") return e;
  }
  const urls = v.map((r) => (parseRemote(r) as RemoteEntry).url);
  const twice = urls.find((u, i) => urls.indexOf(u) !== i);
  return twice === undefined ? null : `${twice} is listed twice`;
}

export type RemoteStatus = "unknown" | "up" | "down" | "refused";

/** What `GET /v1/server` shows of a remote: never its key or its key file. */
export interface RemoteView {
  url: string;
  state: RemoteStatus;
  /** The presets it listed as available when it was last up. */
  presets: string[];
  version: string | null;
  checked_at: string | null;
}

/** A remote failed a request: no answer (`down`), its key refused (`refused`), or it said no. */
export class RemoteError extends Error {
  override name = "RemoteError";
  constructor(
    readonly kind: "down" | "refused" | "rejected" | "lost",
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

interface Remote {
  entry: RemoteEntry;
  state: RemoteStatus;
  /** Preset names listed as available, and installed engine ids, when last up. */
  offers: Set<string>;
  presets: string[];
  /** Ever seen up since start: a job it offers may be accepted while it is down. */
  seen: boolean;
  version: string | null;
  checkedAt: number | null;
  error: string | null;
  inFlight: number;
  probing: boolean;
}

export interface RemotesOptions {
  /** `server.remotes` as the settings hold it now. */
  entries(): readonly string[];
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
  probeMs?: number;
  /** Told when a probe changed what a remote offers or whether it is up. */
  onChange?(): void;
  log(level: "info" | "warn" | "error", msg: string): void;
}

/** The fields a remote job is submitted with. */
export interface RemoteJob {
  id: string;
  audio: string;
  preset?: string;
  model?: string;
  language: string;
  keywords: readonly string[];
  diarize: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: a remote's JSON is read field by field.
type Body = any;

export class Remotes {
  private readonly remotes = new Map<string, Remote>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: RemotesOptions) {
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  /** The entries in the settings now, their state kept across a change of the list. */
  private current(): Remote[] {
    const out: Remote[] = [];
    for (const raw of this.o.entries()) {
      const e = parseRemote(raw);
      if (typeof e === "string") continue;
      let r = this.remotes.get(e.url);
      if (!r) {
        r = {
          entry: e,
          state: "unknown",
          offers: new Set(),
          presets: [],
          seen: false,
          version: null,
          checkedAt: null,
          error: null,
          inFlight: 0,
          probing: false,
        };
        this.remotes.set(e.url, r);
      }
      r.entry = e;
      out.push(r);
    }
    return out;
  }

  /** Probes every remote now and then every `probeMs`. */
  start(): void {
    void this.probeAll();
    // clock: a remote that came back is found within one probe period.
    this.timer = setInterval(() => void this.probeAll(), this.o.probeMs ?? REMOTE_PROBE_MS);
  }

  configured(): boolean {
    return this.current().length > 0;
  }

  async probeAll(): Promise<void> {
    await Promise.all(this.current().map((r) => this.probe(r)));
  }

  private key(r: Remote): string {
    const f = r.entry.keyFile;
    const env = this.o.env ?? process.env;
    const path = /^~[\\/]/.test(f) ? join(env.HOME ?? homedir(), f.slice(2)) : f;
    try {
      const key = readFileSync(path, "utf8").trim();
      if (key === "") throw new Error("the file is empty");
      return key;
    } catch (err) {
      throw new RemoteError(
        "refused",
        `cannot read the key file of ${r.entry.url}: ${(err as Error).message}`,
      );
    }
  }

  private async request(
    r: Remote,
    path: string,
    init: RequestInit & { keyed?: boolean; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: Body }> {
    const { keyed = true, timeoutMs = REMOTE_TIMEOUT_MS, ...rest } = init;
    const headers = new Headers(rest.headers);
    if (keyed) headers.set("authorization", `Bearer ${this.key(r)}`);
    let res: Response;
    try {
      res = await this.fetch(`${r.entry.url}/v1${path}`, {
        ...rest,
        headers,
        // A redirect would carry the key to another host: none is followed.
        redirect: "manual",
        signal: rest.signal
          ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (rest.signal?.aborted) throw err;
      throw new RemoteError("down", `no answer from ${r.entry.url}: ${(err as Error).message}`);
    }
    const text = await res.text().catch(() => "");
    let body: Body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, body };
  }

  private async probe(r: Remote): Promise<void> {
    if (r.probing) return;
    r.probing = true;
    const before = JSON.stringify([r.state, [...r.offers]]);
    try {
      const s = await this.request(r, "/server", { keyed: false });
      if (s.status !== 200 || s.body?.name !== "akou" || s.body?.capabilities?.jobs !== true) {
        throw new RemoteError(
          "down",
          `${r.entry.url} is not an akou server with jobs (GET /v1/server answered ${s.status})`,
        );
      }
      const me = await this.request(r, "/keys/me");
      if (me.status === 401 || me.status === 403) {
        throw new RemoteError("refused", `${r.entry.url} refused the key (${me.status})`);
      }
      if (me.status !== 200) {
        throw new RemoteError("down", `${r.entry.url} answered ${me.status} to GET /v1/keys/me`);
      }
      const presets: string[] = (Array.isArray(s.body.presets) ? s.body.presets : [])
        .filter((p: Body) => p?.available === true && typeof p.name === "string")
        .map((p: Body) => p.name as string);
      const engines: string[] = (Array.isArray(s.body.engines) ? s.body.engines : [])
        .filter((e: Body) => e?.installed === true && typeof e.id === "string")
        .map((e: Body) => e.id as string);
      r.offers = new Set([...presets, ...engines]);
      r.presets = presets;
      r.version = typeof s.body.version === "string" ? s.body.version : null;
      r.state = "up";
      r.seen = true;
      r.error = null;
    } catch (err) {
      const e = err instanceof RemoteError ? err : new RemoteError("down", (err as Error).message);
      r.state = e.kind === "refused" ? "refused" : "down";
      r.error = e.message;
    } finally {
      r.probing = false;
    }
    r.checkedAt = this.now();
    if (JSON.stringify([r.state, [...r.offers]]) !== before) {
      this.o.log(
        r.state === "up" ? "info" : "warn",
        r.state === "up"
          ? `remote.up ${r.entry.url} offers ${[...r.offers].join(", ") || "nothing"}`
          : `remote.${r.state} ${r.entry.url}: ${r.error}`,
      );
      this.o.onChange?.();
    }
  }

  /** Marks a remote down after a failed request and probes it again at the next period. */
  failed(url: string, err: RemoteError): void {
    const r = this.remotes.get(url);
    if (!r || err.kind === "rejected" || err.kind === "lost") return;
    const was = r.state;
    r.state = err.kind === "refused" ? "refused" : "down";
    r.error = err.message;
    if (was !== r.state) this.o.log("warn", `remote.${r.state} ${url}: ${err.message}`);
  }

  /** What `GET /v1/server` shows. */
  view(): RemoteView[] {
    return this.current().map((r) => ({
      url: r.entry.url,
      state: r.state,
      presets: r.presets,
      version: r.version,
      checked_at: r.checkedAt === null ? null : new Date(r.checkedAt).toISOString(),
    }));
  }

  /** Has a remote offered one of these names since start? Then a job for it may be accepted. */
  offered(names: readonly string[]): boolean {
    return this.current().some((r) => r.seen && names.some((n) => r.offers.has(n)));
  }

  /** Does a remote's entry send one of these names to it first? */
  listed(names: readonly string[]): boolean {
    return this.current().some((r) => r.entry.takes.some((t) => t === "*" || names.includes(t)));
  }

  /**
   * Where a job for these names goes. `first`: only remotes whose entry lists a name, as a job
   * this server could run itself. `null`: no remote that is up offers them; `busy`: every one
   * that does holds `REMOTE_IN_FLIGHT` jobs already, or a listed one is not probed yet, so the job
   * waits for it.
   */
  pick(names: readonly string[], first: boolean): string | "busy" | null {
    let busy = false;
    for (const r of this.current()) {
      if (first && !r.entry.takes.some((t) => t === "*" || names.includes(t))) continue;
      if (first && r.state === "unknown") {
        busy = true;
        continue;
      }
      if (r.state !== "up" || !names.some((n) => r.offers.has(n))) continue;
      if (r.inFlight >= REMOTE_IN_FLIGHT) {
        busy = true;
        continue;
      }
      return r.entry.url;
    }
    return busy ? "busy" : null;
  }

  /** Is this remote up, and offering one of the names? */
  up(url: string, names: readonly string[]): boolean {
    const r = this.remotes.get(url);
    return !!r && r.state === "up" && names.some((n) => r.offers.has(n));
  }

  hold(url: string): void {
    const r = this.remotes.get(url);
    if (r) r.inFlight++;
  }

  release(url: string): void {
    const r = this.remotes.get(url);
    if (r && r.inFlight > 0) r.inFlight--;
  }

  private remote(url: string): Remote {
    const r = this.remotes.get(url);
    if (!r) throw new RemoteError("down", `${url} is no longer in server.remotes`);
    return r;
  }

  /** Uploads a job; answers the remote's job id. The same job sent twice is one remote job. */
  async submit(url: string, j: RemoteJob, signal?: AbortSignal): Promise<string> {
    const r = this.remote(url);
    const form = new FormData();
    form.append("file", Bun.file(j.audio), "audio");
    if (j.preset) form.append("preset", j.preset);
    if (j.model) form.append("model", j.model);
    form.append("language", j.language);
    for (const k of j.keywords) form.append("keywords[]", k);
    form.append("diarize", j.diarize ? "true" : "false");
    const res = await this.request(r, "/jobs", {
      method: "POST",
      headers: { "idempotency-key": j.id, [FORWARDED_HEADER]: "1" },
      body: form,
      signal,
      // An upload of a long file takes as long as the network does.
      timeoutMs: 3_600_000,
    });
    if ((res.status === 200 || res.status === 202) && typeof res.body?.id === "string") {
      return res.body.id;
    }
    const e = this.refusal(r, "POST /v1/jobs", res);
    // No job route there: not an akou server in server mode, as far as this job can tell.
    throw e.kind === "lost" ? new RemoteError("down", e.message, e.status, e.code) : e;
  }

  private refusal(r: Remote, what: string, res: { status: number; body: Body }): RemoteError {
    const code = typeof res.body?.error === "string" ? res.body.error : null;
    const message = `${r.entry.url} answered ${res.status} to ${what}${
      typeof res.body?.message === "string" ? `: ${res.body.message}` : ""
    }`;
    if (res.status === 401 || res.status === 403) {
      return new RemoteError("refused", message, res.status, code);
    }
    if (res.status === 404) return new RemoteError("lost", message, res.status, code);
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return new RemoteError("down", message, res.status, code);
    }
    return new RemoteError("rejected", message, res.status, code);
  }

  /** The remote job's state, after holding until it ends or `waitS` passes. */
  async job(
    url: string,
    id: string,
    waitS: number,
    signal?: AbortSignal,
  ): Promise<{ status: string; error?: { code: string; message: string } }> {
    const r = this.remote(url);
    const res = await this.request(r, `/jobs/${encodeURIComponent(id)}?wait=${waitS}`, {
      signal,
      timeoutMs: waitS * 1000 + REMOTE_TIMEOUT_MS,
    });
    if (res.status === 200 && typeof res.body?.status === "string") return res.body;
    throw this.refusal(r, `GET /v1/jobs/${id}`, res);
  }

  async result(url: string, id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const r = this.remote(url);
    const res = await this.request(r, `/jobs/${encodeURIComponent(id)}/result`, {
      signal,
      timeoutMs: 60_000,
    });
    if (res.status === 200 && res.body && typeof res.body === "object") return res.body;
    throw this.refusal(r, `GET /v1/jobs/${id}/result`, res);
  }

  /** Deletes a remote job the client deleted here; best effort, a remote that is down keeps it. */
  cancel(url: string, id: string): void {
    const r = this.remotes.get(url);
    if (!r) return;
    void this.request(r, `/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
