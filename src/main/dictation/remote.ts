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
import { wavBytes } from "../asr/qwen.ts";
import { parseRemote } from "../server/remotes.ts";
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
     * time; `status`: an answer other than 2xx (`status`, and the remote's `code`).
     */
    readonly kind: "refused" | "unreachable" | "timeout" | "status",
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
  /** The round trip, request to answer, in ms. */
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

/** An answer other than 2xx, as an error naming the remote's code and message, never the key. */
async function refusal(res: Response, what: string): Promise<RemoteDictationError> {
  let code: string | null = null;
  let message = "";
  try {
    const b = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof b.error === "string") code = b.error;
    if (typeof b.message === "string") message = b.message;
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
  form.append("response_format", "verbose_json");
  form.append("interactive", "true");
  const language = o.language?.trim();
  if (language && language !== "auto") form.append("language", language);
  if (o.model?.trim()) form.append("model", o.model.trim());
  for (const k of keywords) form.append("keywords[]", k);
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
  const lang =
    typeof body.language === "string" && body.language !== "unknown" ? body.language : null;
  return {
    text: body.text.trim(),
    language: lang,
    ms: Math.round(performance.now() - t0),
    keywords,
    words: [],
  };
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
