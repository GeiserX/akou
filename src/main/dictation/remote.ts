/**
 * Dictation through a remote akou (docs/ux/DICTATION.md section 7.2): the desktop keeps the key,
 * the mic, the pill and the insert; only the audio goes to another akou, over one synchronous
 * request with a `jobs` key. This is not `server.remotes` (remotes.ts), which queues a job and
 * long-polls: it reuses that file's URL checks and nothing else.
 *
 * - **DC-R1, the request.** The buffer goes as a 16 kHz 16-bit mono WAV to
 *   `POST /v1/audio/transcriptions` on `dictation.remote.url`, with `dictation.remote.key` as the
 *   bearer, `interactive=true` (DC-R2), `response_format=verbose_json`, the language when one is
 *   forced, a model only when the user names one (the remote's `server.dictation_engine` decides
 *   otherwise), and `keywords[]` only when `dictation.glossary` is on, at most the route's 24. The
 *   answer gives the text and the language; its word list is empty by design, so a remote result
 *   carries no word times or confidences.
 * - **DC-R1, where the audio may go.** An `https` URL always passes. An `http` URL passes only when
 *   every address its host resolves to is loopback, RFC 1918, unique-local (fc00::/7) or shared
 *   (100.64.0.0/10), checked at save and again before each request, and the request connects to the
 *   address that was checked, so a name that later resolves elsewhere is refused, never followed.
 * - **DC-R3, the timeout.** `dictation.remote.timeoutSeconds` plus 0.25 s per second of audio. There
 *   is no retry and no other host: a failure is thrown for the caller's fallback.
 * - **DC-R3, the fallback.** `RemoteEngine` is the `remote` engine a dictation session calls. When
 *   the remote gives no transcript, `dictation.remote.fallback` decides: `local` decodes the same
 *   buffer on the local engine and says so (`fallback_from: remote`, `remote down, used fast`);
 *   `error`, or no local engine at all, throws for the error state. A remote down for three
 *   dictations in a row is probed every `REMOTE_PROBE_MS` until it answers again.
 * - **DC-R6, the audio during the hold.** `RemoteEngine.open` starts the same request when the
 *   session starts and sends each packet as it arrives, as a chunked multipart body whose WAV says
 *   "to the end" in place of a length (as `audio.ts` reads a piped WAV), so at release only the
 *   tail is left to send. The remote decodes when the body ends, as for one request. A stream that
 *   fails is a remote that failed: the fallback is the same, and nothing is sent again.
 * - **DC-R4, the test.** `GET /v1/server` and `GET /v1/keys/me` on the remote: its mode, the engine
 *   a dictation runs, its accelerator, whether it will bias, the round trip, and a warning when it
 *   has no interactive lane.
 *
 * The key is never part of a message, a result or a log line.
 */

import { isIP } from "node:net";
import { type Cidr, inCidr, parseCidr } from "../api/net.ts";
import { MAX_KEYWORDS } from "../api/routes/jobs.ts";
import { ASR_RATE } from "../asr/engine.ts";
import type { Decoded } from "../asr/live-worker.ts";
import { wavBytes } from "../asr/qwen.ts";
import { parseRemote, REMOTE_PROBE_MS } from "../server/remotes.ts";
import { type Resolver, systemResolver } from "../server/webhooks.ts";

/** Where cleartext dictation audio may go: loopback, RFC 1918, unique-local and shared. */
const CLEARTEXT_OK: readonly Cidr[] = [
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
  "100.64.0.0/10",
].map((c) => parseCidr(c) as Cidr);

/** The budget before any audio (`dictation.remote.timeoutSeconds`' default). */
export const REMOTE_TIMEOUT_SECONDS = 6;
/** What each second of audio adds to a remote dictation's timeout. */
export const REMOTE_SECONDS_PER_AUDIO_SECOND = 0.25;

/** A remote dictation that did not give a transcript, and why; never names the key. */
export class RemoteDictationError extends Error {
  override name = "RemoteDictationError";
  constructor(
    /**
     * `refused`: the URL is not allowed; `unreachable`: no connection; `timeout`: no answer in
     * time; `status`: an answer other than 2xx (`status`, and the remote's `code`); `dropped`: the
     * streamed request was cancelled, finished twice or given a buffer shorter than what it sent,
     * which is the session's mistake and not the remote's, so nothing falls back.
     */
    readonly kind: "refused" | "unreachable" | "timeout" | "status" | "dropped",
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/**
 * The remote's base URL (no trailing slash), or the reason it is refused, by the checks
 * `server.remotes` makes (`parseRemote`): http or https, no user name or password, no query or
 * fragment. The address rule for `http` needs DNS and is `vetRemote`'s.
 */
export function remoteBase(raw: string): string | { error: string } {
  const url = raw.trim();
  if (url === "") return { error: "dictation.remote.url is empty" };
  if (/\s/.test(url)) return { error: `${JSON.stringify(url)} is not a URL` };
  // parseRemote takes a `server.remotes` line; the key file is not ours, so any absolute path does.
  const e = parseRemote(`${url} /`);
  return typeof e === "string" ? { error: e } : e.url;
}

/** The host of a URL, without IPv6 brackets. */
function hostOf(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Where a request goes: the base URL, and for `http` the checked address it connects to. */
export interface RemoteTarget {
  base: string;
  /** The address an `http` request connects to; null for `https`, which is fetched by name. */
  address: string | null;
}

/**
 * The DC-R1 rule, at save and before each request: `https` passes; `http` passes only when every
 * address the host resolves to is loopback, RFC 1918, unique-local or shared. Throws
 * `RemoteDictationError` `refused` with the reason.
 */
export async function vetRemote(
  raw: string,
  resolve: Resolver = systemResolver,
): Promise<RemoteTarget> {
  const base = remoteBase(raw);
  if (typeof base !== "string") throw new RemoteDictationError("refused", base.error);
  const u = new URL(base);
  if (u.protocol === "https:") return { base, address: null };
  const host = hostOf(u);
  let answers: string[];
  try {
    answers = isIP(host) ? [host] : (await resolve(host)).map((a) => a.address);
  } catch (err) {
    throw new RemoteDictationError(
      "unreachable",
      `${host} does not resolve: ${(err as Error).message}`,
    );
  }
  if (answers.length === 0)
    throw new RemoteDictationError("unreachable", `${host} resolves to no address`);
  for (const a of answers) {
    if (!CLEARTEXT_OK.some((c) => inCidr(a, c))) {
      const at = isIP(host) ? a : `${host} resolves to ${a}, which`;
      throw new RemoteDictationError(
        "refused",
        `${at} is not a loopback, private (RFC 1918), unique-local or shared (100.64.0.0/10) address, and dictation audio goes there over https only`,
      );
    }
  }
  return { base, address: answers[0] as string };
}

/** The request's URL and headers for a path on the remote, connected to the checked address. */
function aimed(t: RemoteTarget, path: string): { url: string; host: Record<string, string> } {
  const u = new URL(`${t.base}/v1${path}`);
  if (t.address === null) return { url: u.href, host: {} };
  const host = u.host;
  u.hostname = t.address.includes(":") ? `[${t.address}]` : t.address;
  return { url: u.href, host: { host } };
}

/** The request's timeout: the budget before any audio, plus 0.25 s per second of audio (DC-R3). */
export function remoteTimeoutMs(timeoutSeconds: number, audioSeconds: number): number {
  return Math.round(
    (timeoutSeconds + REMOTE_SECONDS_PER_AUDIO_SECOND * Math.max(0, audioSeconds)) * 1000,
  );
}

export interface RemoteDictation {
  /** `dictation.remote.url`. */
  url: string;
  /** `dictation.remote.key`, a `jobs` key of the remote. */
  key: string;
  /** The buffer, 16 kHz mono. */
  samples: Float32Array;
  /** `dictation.language`; `auto` or absent sends none. */
  language?: string;
  /** A model the user named; absent, the remote's `server.dictation_engine` decides. */
  model?: string;
  /** The glossary's terms while `dictation.glossary` is on; null or absent while it is off. */
  glossary?: readonly string[] | null;
  /** `dictation.remote.timeoutSeconds`. */
  timeoutSeconds?: number;
  /** Test seams: the network and DNS. */
  fetch?: typeof fetch;
  resolve?: Resolver;
}

export interface RemoteResult {
  text: string;
  /** The language the remote reports, or null. */
  language: string | null;
  /** The round trip, request to answer, in ms; release to answer when the audio was streamed (DC-R6). */
  ms: number;
  /** The keywords sent (none while the glossary is off). */
  keywords: string[];
  /** A remote result has no word times or confidences. */
  words: [];
}

/** The glossary as `keywords[]`: trimmed, once each, at most the route's 24. */
export function remoteKeywords(glossary: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const g of glossary ?? []) {
    const t = g.trim();
    if (t === "" || t.length > 100 || out.includes(t)) continue;
    out.push(t);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

/** How much of a remote's own message an error keeps: it reaches the pill, the page and the log. */
export const REMOTE_MESSAGE_CHARS = 200;

/** A remote's text on one line with no control characters, at most `max` characters. */
function oneLine(s: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips.
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** An answer other than 2xx, as an error naming the remote's code and message, never the key. */
async function refusal(res: Response, what: string): Promise<RemoteDictationError> {
  let code: string | null = null;
  let message = "";
  try {
    const b = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof b.error === "string") code = oneLine(b.error, 64) || null;
    if (typeof b.message === "string") message = oneLine(b.message, REMOTE_MESSAGE_CHARS);
  } catch {}
  const why =
    res.status === 401 || res.status === 403
      ? "the key was refused"
      : `${code ?? "error"}${message ? `: ${message}` : ""}`;
  return new RemoteDictationError(
    "status",
    `${what} answered ${res.status}, ${why}`,
    res.status,
    code,
  );
}

/** A failed fetch as a timeout or an unreachable remote. */
function failure(err: unknown, base: string, ms: number): RemoteDictationError {
  const e = err as Error;
  if (e.name === "TimeoutError" || e.name === "AbortError") {
    return new RemoteDictationError("timeout", `${base} gave no answer within ${ms} ms`);
  }
  return new RemoteDictationError("unreachable", `${base} could not be reached: ${e.message}`);
}

/**
 * One dictation on the remote (DC-R1): the transcript and the round trip, or a
 * `RemoteDictationError` for the caller's fallback (DC-R3). The URL is checked again first.
 */
export async function transcribeRemote(o: RemoteDictation): Promise<RemoteResult> {
  const target = await vetRemote(o.url, o.resolve);
  const keywords = remoteKeywords(o.glossary);
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(wavBytes(o.samples))], { type: "audio/wav" }),
    "dictation.wav",
  );
  for (const [k, v] of requestFields(o, keywords)) form.append(k, v);
  const timeout = remoteTimeoutMs(
    o.timeoutSeconds ?? REMOTE_TIMEOUT_SECONDS,
    o.samples.length / ASR_RATE,
  );
  const { url, host } = aimed(target, "/audio/transcriptions");
  const t0 = performance.now();
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${o.key}`, ...host },
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw failure(err, target.base, timeout);
  }
  return answer(res, target, t0, keywords, timeout);
}

/** The text fields of a dictation request, the same whether the audio goes at once or streamed. */
function requestFields(
  o: Pick<RemoteDictation, "language" | "model">,
  keywords: readonly string[],
): [string, string][] {
  const out: [string, string][] = [
    ["response_format", "verbose_json"],
    ["interactive", "true"],
  ];
  const language = o.language?.trim();
  if (language && language !== "auto") out.push(["language", language]);
  if (o.model?.trim()) out.push(["model", o.model.trim()]);
  for (const k of keywords) out.push(["keywords[]", k]);
  return out;
}

/** The remote's answer as the transcript, or the error for the caller's fallback. */
async function answer(
  res: Response,
  target: RemoteTarget,
  t0: number,
  keywords: string[],
  timeout: number,
): Promise<RemoteResult> {
  if (res.status < 200 || res.status > 299) {
    throw await refusal(res, `${target.base} POST /v1/audio/transcriptions`);
  }
  let body: { text?: unknown; language?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw failure(err, target.base, timeout);
  }
  if (typeof body.text !== "string") {
    throw new RemoteDictationError("status", `${target.base} answered with no text`, res.status);
  }
  // `und` is what a server answers when its engine names no language; `unknown` is what older
  // servers answered. Neither is a language.
  const lang =
    typeof body.language === "string" && body.language !== "und" && body.language !== "unknown"
      ? body.language
      : null;
  return {
    text: body.text.trim(),
    language: lang,
    ms: Math.round(performance.now() - t0),
    keywords,
    words: [],
  };
}

// ---------------------------------------------------------------------------
// DC-R6: the audio streamed during the hold

/** A WAV header whose sizes say "to the end of the file", for audio whose length is not known yet. */
function streamedWavHeader(): Uint8Array {
  const h = wavBytes(new Float32Array(0));
  const v = new DataView(h.buffer, h.byteOffset);
  v.setUint32(4, 0xffffffff, true);
  v.setUint32(40, 0xffffffff, true);
  return h;
}

/** Samples as the WAV's 16-bit PCM, converted as `wavBytes` converts them. */
function pcm16(samples: Float32Array): Uint8Array {
  return wavBytes(samples).subarray(44);
}

export type RemoteUploadOptions = Omit<RemoteDictation, "samples">;

/**
 * One dictation's request, opened when the session starts (DC-R6): `push` sends each packet as it
 * arrives, and `finish` sends the tail and waits for the transcript. The URL is checked when it
 * opens, the request's timeout (DC-R3) runs from `finish`, and `ms` is release to answer.
 */
export class RemoteUpload {
  private readonly enc = new TextEncoder();
  private readonly boundary = `akou-${crypto.randomUUID()}`;
  private readonly keywords: string[];
  private readonly abort = new AbortController();
  private body: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** Bytes pushed before the request was open. */
  private early: Uint8Array[] = [];
  private pushed = 0;
  /** Set by `finish` (the body ends once the request is open) and by `cancel`. */
  private done = false;
  /** Set once the request has an answer or an error: audio pushed after that is dropped. */
  private ended = false;
  /** The request's timeout, known at `finish`. */
  private timeoutMs = 0;
  /** The request: the target it went to and the remote's answer, or why there is none. */
  private readonly outcome: Promise<
    { target: RemoteTarget; res: Response } | { error: RemoteDictationError }
  >;

  constructor(private readonly o: RemoteUploadOptions) {
    this.keywords = remoteKeywords(o.glossary);
    this.outcome = this.start().then(
      (r) => {
        this.end();
        return r;
      },
      (err: unknown) => {
        this.end();
        return {
          error:
            err instanceof RemoteDictationError
              ? err
              : new RemoteDictationError("unreachable", (err as Error).message),
        };
      },
    );
  }

  /**
   * The request has its outcome: nothing reads the body any more, so what is held goes and what is
   * pushed later is dropped, rather than growing for the rest of a latched session.
   */
  private end(): void {
    this.ended = true;
    this.early = [];
    try {
      this.body?.error(new Error("the request has ended"));
    } catch {}
  }

  /** Bytes of audio this request holds in memory that the network has not taken yet. */
  get pending(): number {
    let n = 0;
    for (const b of this.early) n += b.byteLength;
    return n + Math.max(0, -(this.body?.desiredSize ?? 0));
  }

  private async start(): Promise<{ target: RemoteTarget; res: Response }> {
    const target = await vetRemote(this.o.url, this.o.resolve);
    const head = [
      ...requestFields(this.o, this.keywords).map(
        ([k, v]) =>
          `--${this.boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
      `--${this.boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ].join("");
    const body = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          c.enqueue(this.enc.encode(head));
          c.enqueue(streamedWavHeader());
          for (const b of this.early) c.enqueue(b);
          this.early = [];
          this.body = c;
          // Released before the URL was checked: everything is queued, so the body ends here.
          if (this.done) c.close();
        },
      },
      // Counted in bytes, so `pending` is what is queued: `desiredSize` is minus the bytes held.
      { highWaterMark: 0, size: (b) => b?.byteLength ?? 0 },
    );
    const { url, host } = aimed(target, "/audio/transcriptions");
    try {
      const res = await (this.o.fetch ?? fetch)(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.o.key}`,
          "content-type": `multipart/form-data; boundary=${this.boundary}`,
          ...host,
        },
        body,
        duplex: "half",
        redirect: "manual",
        signal: this.abort.signal,
      } as RequestInit);
      return { target, res };
    } catch (err) {
      // Aborted by `finish`'s timer (or by `cancel`, which nobody waits on) is a timeout.
      throw failure(err, target.base, this.timeoutMs);
    }
  }

  private send(bytes: Uint8Array): void {
    if (this.ended) return;
    if (this.body === null) {
      this.early.push(bytes);
      return;
    }
    try {
      this.body.enqueue(bytes);
    } catch {
      // The request already ended: its outcome says why.
    }
  }

  /** Sends a packet of the session's audio, 16 kHz mono. */
  push(samples: Float32Array): void {
    if (this.done || samples.length === 0) return;
    this.send(pcm16(samples));
    this.pushed += samples.length;
  }

  /**
   * Sends what `push` has not, given the whole buffer, and waits for the transcript; throws a
   * `RemoteDictationError` for the caller's fallback, as `transcribeRemote` does.
   */
  async finish(samples: Float32Array): Promise<RemoteResult> {
    if (this.done) {
      throw new RemoteDictationError(
        "dropped",
        "this dictation's request was cancelled or has already finished",
      );
    }
    if (samples.length < this.pushed) {
      this.cancel();
      throw new RemoteDictationError(
        "dropped",
        "the buffer is shorter than the audio already sent; the request was dropped",
      );
    }
    if (samples.length > this.pushed) this.send(pcm16(samples.subarray(this.pushed)));
    this.pushed = samples.length;
    this.send(this.enc.encode(`\r\n--${this.boundary}--\r\n`));
    this.done = true;
    if (this.body) {
      try {
        this.body.close();
      } catch {
        // The request already ended: its outcome says why.
      }
    }
    const t0 = performance.now();
    this.timeoutMs = remoteTimeoutMs(
      this.o.timeoutSeconds ?? REMOTE_TIMEOUT_SECONDS,
      samples.length / ASR_RATE,
    );
    // clock: a deadline on a request to another machine.
    const timer = setTimeout(() => this.abort.abort(), this.timeoutMs);
    try {
      const r = await this.outcome;
      if ("error" in r) throw r.error;
      return await answer(r.res, r.target, t0, this.keywords, this.timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drops the request: a cancelled session sends nothing more, and the remote keeps nothing. */
  cancel(): void {
    this.done = true;
    this.early = [];
    this.abort.abort();
    try {
      this.body?.error(new Error("cancelled"));
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// DC-R4: the Test

export interface RemoteTest {
  ok: boolean;
  /** The remote's answer when it refused (401 for a wrong key), else null. */
  status: number | null;
  /** Why it failed, never naming the key; null when ok. */
  error: string | null;
  /** The remote's `mode`, `app` or `server`. */
  mode: string | null;
  /** The engine a dictation runs there: its `server.dictation_engine`, `auto` for its default. */
  engine: string | null;
  /** The GPU API it decodes on, or `cpu`. */
  accelerator: string | null;
  /** "no biasing" while the glossary is off, else how many terms are sent. */
  biasing: string;
  /** Whether it has a dictation lane (`capabilities.interactive`). */
  interactive: boolean;
  /** Set when a dictation there waits behind its queue. */
  warning: string | null;
  /** `GET /v1/server`'s round trip, in ms. */
  round_trip_ms: number | null;
  /** One line for the page: `ok, best on cpu, no biasing, 40 ms`, or the error. */
  summary: string;
}

export interface RemoteTestOptions {
  url: string;
  key: string;
  glossary?: readonly string[] | null;
  timeoutSeconds?: number;
  fetch?: typeof fetch;
  resolve?: Resolver;
}

const OLDER = "this akou is older; dictation will queue";
const NO_SLOTS = "this akou has no dictation slots (server.dictation_slots); dictation will queue";

/** The Test of DC-R4: what the remote is and whether a dictation there works, before the first press. */
export async function testRemote(o: RemoteTestOptions): Promise<RemoteTest> {
  const keywords = remoteKeywords(o.glossary);
  const biasing = keywords.length === 0 ? "no biasing" : `${keywords.length} terms`;
  const failed = (e: RemoteDictationError): RemoteTest => ({
    ok: false,
    status: e.status,
    error: e.message,
    mode: null,
    engine: null,
    accelerator: null,
    biasing,
    interactive: false,
    warning: null,
    round_trip_ms: null,
    summary: e.status !== null ? `${e.status}: ${e.message}` : e.message,
  });
  const timeout = (o.timeoutSeconds ?? REMOTE_TIMEOUT_SECONDS) * 1000;
  const get = async (target: RemoteTarget, path: string, key: boolean) => {
    const { url, host } = aimed(target, path);
    try {
      return await (o.fetch ?? fetch)(url, {
        headers: { ...(key ? { authorization: `Bearer ${o.key}` } : {}), ...host },
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw failure(err, target.base, timeout);
    }
  };
  try {
    const target = await vetRemote(o.url, o.resolve);
    const t0 = performance.now();
    const res = await get(target, "/server", false);
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) throw await refusal(res, `${target.base} GET /v1/server`);
    // biome-ignore lint/suspicious/noExplicitAny: a remote's answer is read field by field.
    const s = (await res.json().catch(() => null)) as any;
    if (s?.name !== "akou") {
      throw new RemoteDictationError("status", `${target.base} is not an akou server`, res.status);
    }
    const me = await get(target, "/keys/me", true);
    if (!me.ok) throw await refusal(me, `${target.base} GET /v1/keys/me`);
    const caps = s.capabilities ?? {};
    const interactive = caps.interactive === true;
    const warning = interactive ? null : "interactive" in caps ? NO_SLOTS : OLDER;
    const engine = typeof s.dictation?.engine === "string" ? s.dictation.engine : "auto";
    const accelerator =
      typeof s.accelerator?.active === "string" && s.accelerator.active !== ""
        ? s.accelerator.active
        : typeof s.gpu === "string"
          ? s.gpu
          : "cpu";
    return {
      ok: true,
      status: null,
      error: null,
      mode: typeof s.mode === "string" ? s.mode : null,
      engine,
      accelerator,
      biasing,
      interactive,
      warning,
      round_trip_ms: ms,
      summary: `ok, ${engine} on ${accelerator}, ${biasing}, ${ms} ms${warning ? `; ${warning}` : ""}`,
    };
  } catch (err) {
    if (err instanceof RemoteDictationError) return failed(err);
    return failed(new RemoteDictationError("unreachable", (err as Error).message));
  }
}

// ---------------------------------------------------------------------------
// DC-R3: the remote engine and its explicit fallback

/** `dictation.remote.fallback` as it applies: `local` needs a local engine, else it is `error`. */
export type RemoteFallback = "local" | "error";

/** The fallback that applies: `local` only when it is set and a local engine is there to run. */
export function remoteFallback(setting: string, hasLocal: boolean): RemoteFallback {
  return setting === "local" && hasLocal ? "local" : "error";
}

/** What a local engine answers for a dictation (the live Worker's `decoded`, DC-E1). */
export type LocalDecoded = Decoded;

/** The engine a fallback decodes on: `fast` or `best` on this machine. */
export interface LocalEngine {
  readonly name: string;
  decode(samples: Float32Array, o: { language?: string }): Promise<LocalDecoded>;
}

/** A remote dictation's result, or the local engine's after a fallback, with what the item records. */
export interface RemoteDecoded extends LocalDecoded {
  /** The engine that decoded it: `remote`, or the local engine's name after a fallback. */
  engine: string;
  /** `remote` when the remote failed and the local engine decoded it. */
  fallback_from?: "remote";
  /** The remote's round trip, request to answer, in ms; absent after a fallback. */
  round_trip_ms?: number;
  /** What the pill says beside the text: `remote down, used fast`; null when nothing went wrong. */
  notice: string | null;
  /** Why the remote gave no transcript, when it fell back; never names the key. */
  remote_error?: string;
}

/** The `dictation.remote.*` settings a dictation reads, read at each press. */
export interface RemoteSettings {
  url: string;
  key: string;
  /** `dictation.remote.fallback`: `local` or `error`. */
  fallback: string;
  timeoutSeconds?: number;
  language?: string;
  model?: string;
  /** The glossary's terms while `dictation.glossary` is on; null while it is off. */
  glossary?: readonly string[] | null;
}

export interface RemoteEngineOptions {
  settings(): RemoteSettings;
  /** The local engine a fallback runs on, or null when no local model is installed. */
  local(): LocalEngine | null;
  onLog?(level: "info" | "warn", msg: string): void;
  /** Test seams: the network, DNS and the down-probe's interval. */
  fetch?: typeof fetch;
  resolve?: Resolver;
  probeMs?: number;
}

/** What the page shows about the remote (DC-R3): down after three dictations in a row. */
export interface RemoteHealth {
  down: boolean;
  /** Dictations in a row the remote was down for. */
  failures: number;
  /** The last failure's reason, never the key; null once the remote answers. */
  error: string | null;
  /** Whether the down-probe is running. */
  probing: boolean;
}

/** A dictation's request opened at the press (DC-R6), as the session drives it. */
export interface RemoteHold {
  /** Sends a packet of the session's audio as it arrives. */
  push(samples: Float32Array): void;
  /** At release, with the whole buffer: the transcript, or the fallback's. */
  decode(samples: Float32Array): Promise<RemoteDecoded>;
  /** A cancelled session: the request is dropped and nothing more is sent. */
  cancel(): void;
}

/** Dictations in a row that fail before the remote counts as down and is probed. */
export const REMOTE_DOWN_AFTER = 3;

/** A failure that says the remote is down, not misconfigured: no answer, or a 5xx. */
function isDown(e: RemoteDictationError): boolean {
  return (
    e.kind === "unreachable" ||
    e.kind === "timeout" ||
    (e.kind === "status" && (e.status ?? 0) >= 500)
  );
}

/**
 * The `remote` engine (DC-R1, DC-R3): one request to the remote per dictation; when it gives no
 * transcript, the fallback is explicit. The local engine decodes the same buffer on this machine,
 * so no request ever leaves for another host.
 */
export class RemoteEngine {
  readonly name = "remote";
  private failures = 0;
  private error: string | null = null;
  private probe: ReturnType<typeof setInterval> | null = null;
  private probing = false;

  constructor(private readonly o: RemoteEngineOptions) {}

  async decode(samples: Float32Array, d: { language?: string } = {}): Promise<RemoteDecoded> {
    const s = this.o.settings();
    const language = d.language ?? s.language;
    return this.settle(s, samples, language, () =>
      transcribeRemote({ ...this.request(s, language), samples }),
    );
  }

  /**
   * DC-R6: opens the dictation's request when the session starts. The session `push`es each
   * packet as it arrives, then calls `decode` with the whole buffer at release (the fallback, if
   * any, decodes that buffer), or `cancel`. Settings are read here, at the press.
   */
  open(d: { language?: string } = {}): RemoteHold {
    const s = this.o.settings();
    const language = d.language ?? s.language;
    const upload = new RemoteUpload(this.request(s, language));
    return {
      push: (samples) => upload.push(samples),
      decode: (samples) => this.settle(s, samples, language, () => upload.finish(samples)),
      cancel: () => upload.cancel(),
    };
  }

  private request(s: RemoteSettings, language: string | undefined): RemoteUploadOptions {
    return {
      url: s.url,
      key: s.key,
      language,
      model: s.model,
      glossary: s.glossary,
      timeoutSeconds: s.timeoutSeconds,
      fetch: this.o.fetch,
      resolve: this.o.resolve,
    };
  }

  /** The remote's transcript, or the explicit fallback when it gives none (DC-R3). */
  private async settle(
    s: RemoteSettings,
    samples: Float32Array,
    language: string | undefined,
    remote: () => Promise<RemoteResult>,
  ): Promise<RemoteDecoded> {
    try {
      const r = await remote();
      this.answered();
      return {
        text: r.text,
        words: r.words,
        language: r.language,
        model: s.model?.trim() || "remote",
        ms: r.ms,
        // The remote decodes the buffer as one request; how it cuts it is its own.
        spans: 1,
        engine: "remote",
        round_trip_ms: r.ms,
        notice: null,
      };
    } catch (err) {
      // A dropped request is the session's doing: the remote is fine and nothing is to insert.
      if (!(err instanceof RemoteDictationError) || err.kind === "dropped") throw err;
      this.failed(err);
      const local = this.o.local();
      if (remoteFallback(s.fallback, local !== null) === "error" || local === null) throw err;
      this.o.onLog?.("warn", `dictation: the remote failed (${err.message}); using ${local.name}`);
      const l = await local.decode(samples, { language });
      return {
        ...l,
        engine: local.name,
        fallback_from: "remote",
        notice: `remote down, used ${local.name}`,
        remote_error: err.message,
      };
    }
  }

  health(): RemoteHealth {
    return {
      down: this.failures >= REMOTE_DOWN_AFTER,
      failures: this.failures,
      error: this.error,
      probing: this.probe !== null,
    };
  }

  /** Stops the down-probe. */
  close(): void {
    if (this.probe) clearInterval(this.probe);
    this.probe = null;
  }

  private answered(): void {
    if (this.failures >= REMOTE_DOWN_AFTER) this.o.onLog?.("info", "dictation: the remote is back");
    this.failures = 0;
    this.error = null;
    this.close();
  }

  private failed(e: RemoteDictationError): void {
    this.error = e.message;
    // A refused key or URL is a setting to fix, not a remote that is down.
    if (!isDown(e)) {
      this.failures = 0;
      this.close();
      return;
    }
    this.failures++;
    if (this.failures >= REMOTE_DOWN_AFTER && this.probe === null) {
      this.o.onLog?.("warn", `dictation: the remote is down (${e.message}); probing it`);
      // clock: probing a remote that went down, real time between machines.
      this.probe = setInterval(() => void this.probeOnce(), this.o.probeMs ?? REMOTE_PROBE_MS);
      this.probe.unref?.();
    }
  }

  /** One down-probe: `GET /v1/server` with no key, as the Test's first request. */
  private async probeOnce(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const s = this.o.settings();
      const target = await vetRemote(s.url, this.o.resolve);
      const { url, host } = aimed(target, "/server");
      const res = await (this.o.fetch ?? fetch)(url, {
        headers: host,
        redirect: "manual",
        signal: AbortSignal.timeout((s.timeoutSeconds ?? REMOTE_TIMEOUT_SECONDS) * 1000),
      });
      const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
      if (res.ok && body?.name === "akou" && this.probe !== null) this.answered();
    } catch {
      // Still down; the next probe tries again.
    } finally {
      this.probing = false;
    }
  }
}
