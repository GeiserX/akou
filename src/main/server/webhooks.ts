/**
 * Signed callbacks for file jobs (docs/ux/SERVER.md section 6), per the Standard Webhooks spec,
 * so any receiver library verifies akou with no code of its own.
 *
 * - **Signing** (SV-E2): `webhook-id` (the event's `msg_…` id, the same on every retry),
 *   `webhook-timestamp` (unix seconds, of this try), and `webhook-signature: v1,<base64>`, the
 *   HMAC-SHA256 of `{id}.{timestamp}.{body}` keyed with the base64 bytes after `whsec_`. The header
 *   is a space-separated list, one `v1,` entry per secret, so a rotated secret can sign twice.
 * - **Body** (SV-E3): `{type, timestamp, data}`; a result is inline up to 256 KB of body, else
 *   `data.result_url` stands in for `text`, `words` and `segments`.
 * - **Schedule** (SV-E4): at once, then 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h and 24 h after
 *   each failure, each with up to 10 % of jitter. Only a 2xx is a delivery; a 3xx is not followed;
 *   `410 Gone` stops every pending delivery to that URL for that key. 30 s per request.
 * - **Outbox** (SV-E5): each try is written to the job store's `outbox` before it is made, with
 *   the time of the next one, so a server killed mid-try resumes the schedule where it stopped.
 * - **Addresses** (SV-E7): `http` and `https` only. Link-local and metadata addresses are refused at
 *   submit and again after DNS at delivery. Cleartext `http` reaches loopback, RFC 1918 and
 *   unique-local addresses only, so a transcript never crosses the internet unencrypted. The
 *   request goes to the exact address that passed the check, with no second lookup (DNS
 *   rebinding cannot swap one in), while `https` still verifies the certificate against the
 *   callback's host name, which is also the SNI.
 */

import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { addressBytes, type Cidr, inCidr, isNonPublicHost, parseCidr } from "../api/net.ts";
import type { Delivery, FeedEvent, JobStore } from "./store.ts";

/** The delay before each try, after the one before it failed (the first is at once). */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  0,
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  5 * 3_600_000,
  10 * 3_600_000,
  14 * 3_600_000,
  20 * 3_600_000,
  24 * 3_600_000,
];

/** Up to this share of a delay is added at random, so retries of many deliveries spread out. */
export const JITTER = 0.1;
export const DELIVERY_TIMEOUT_MS = 30_000;
/** Past this a completed event carries `result_url` instead of the text. */
export const INLINE_BODY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Signing

/** The base64 HMAC-SHA256 of `{id}.{timestamp}.{body}` with the secret's bytes (SV-E2). */
export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/** The three headers for one try: one `v1,` signature per secret, space-separated. */
export function webhookHeaders(
  secrets: readonly string[],
  id: string,
  timestamp: number,
  body: string,
): Record<string, string> {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": secrets.map((s) => `v1,${signWebhook(s, id, timestamp, body)}`).join(" "),
  };
}

// ---------------------------------------------------------------------------
// The body

/**
 * What an event carries as `data` (SV-E3), for the feed and the webhook alike: a completed job's
 * result inline when the whole body fits in 256 KB, else the result without `text`, `words` and
 * `segments`, with `result_url` naming where they are.
 */
export function completedData(
  result: Record<string, unknown>,
  jobId: string,
): Record<string, unknown> {
  const inline = {
    type: "transcription.completed",
    timestamp: new Date(0).toISOString(),
    data: result,
  };
  if (Buffer.byteLength(JSON.stringify(inline)) <= INLINE_BODY_BYTES) return result;
  const { text: _t, words: _w, segments: _s, ...rest } = result;
  return { ...rest, result_url: `/v1/jobs/${jobId}/result` };
}

/** The webhook body of an event: `{type, timestamp, data}`. */
export function webhookBody(e: Pick<FeedEvent, "type" | "at" | "data">): string {
  return JSON.stringify({ type: e.type, timestamp: new Date(e.at).toISOString(), data: e.data });
}

// ---------------------------------------------------------------------------
// Addresses

const cidrs = (list: string[]) => list.map((c) => parseCidr(c) as Cidr);

/** Never a callback's destination: link-local, the metadata addresses, and "this host". */
const FORBIDDEN = cidrs([
  "169.254.0.0/16",
  "fe80::/10",
  "fd00:ec2::254/128",
  "0.0.0.0/8",
  "::/128",
]);
/** Where plain `http` may go: loopback, RFC 1918 and unique-local (the owner's decision on SV-E7). */
const CLEARTEXT_OK = cidrs([
  "127.0.0.0/8",
  "::1/128",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
]);

export class CallbackRefused extends Error {
  override name = "CallbackRefused";
}

function hostOf(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * Why an address may not receive this callback, or null when it may. `forbidden` wins over the
 * cleartext rule, so the IPv6 metadata address inside the unique-local block is still refused.
 */
export function addressRefusal(addr: string, protocol: "http:" | "https:"): string | null {
  if (!addressBytes(addr)) return `${addr} is not an address`;
  if (FORBIDDEN.some((c) => inCidr(addr, c))) {
    return `${addr} is a link-local, metadata or unspecified address`;
  }
  if (protocol === "http:" && !CLEARTEXT_OK.some((c) => inCidr(addr, c))) {
    return `${addr} is a public address, and a transcript goes there over https only`;
  }
  return null;
}

/**
 * The check at submit (SV-E7): the scheme, and the host when it is an address. A host name is
 * checked again after DNS at delivery. Throws `CallbackRefused` with the reason.
 */
export function checkCallbackUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CallbackRefused("the callback URL is not a URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new CallbackRefused("a callback URL is http or https");
  }
  if (u.username !== "" || u.password !== "") {
    throw new CallbackRefused("a callback URL carries no user name or password");
  }
  const host = hostOf(u);
  if (isIP(host)) {
    const why = addressRefusal(host, u.protocol);
    if (why) throw new CallbackRefused(why);
  }
  return u;
}

export type Resolver = (host: string) => Promise<{ address: string }[]>;

export const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/**
 * The one address a delivery connects to: the host's own when it is an address, else DNS's. Any
 * forbidden address among the answers refuses the lot, since the next lookup could pick it. With
 * `publicOnly` (the key reaches this host through its `*` entry, not by name: SV-K4) any
 * loopback, RFC 1918, shared or unique-local answer refuses it too.
 */
export async function resolveCallback(
  u: URL,
  resolve: Resolver,
  publicOnly = false,
): Promise<string> {
  const host = hostOf(u);
  const protocol = u.protocol as "http:" | "https:";
  const answers = isIP(host) ? [host] : (await resolve(host)).map((a) => a.address);
  if (answers.length === 0) throw new CallbackRefused(`${host} resolves to no address`);
  for (const a of answers) {
    if (FORBIDDEN.some((c) => inCidr(a, c))) {
      throw new CallbackRefused(`${host} resolves to ${a}, a link-local or metadata address`);
    }
    if (publicOnly && isNonPublicHost(a)) {
      throw new CallbackRefused(
        `${host} resolves to ${a}, a private address, which a key's * callback host never reaches; list the host on the key`,
      );
    }
  }
  const addr = answers[0] as string;
  const why = addressRefusal(addr, protocol);
  if (why) throw new CallbackRefused(isIP(host) ? why : `${host} resolves to ${why}`);
  return addr;
}

// ---------------------------------------------------------------------------
// One try

export interface SendOptions {
  fetch?: typeof fetch;
  resolve?: Resolver;
  timeoutMs?: number;
  /** The key reaches this host by its `*` entry only: public addresses only (SV-K4). */
  publicOnly?: boolean;
}

/**
 * Posts one signed body to `url`, connected to the address `resolveCallback` chose. Answers the
 * HTTP status (a 3xx is returned as it is, never followed), or throws: `CallbackRefused` for an
 * address the rules refuse, anything else for a network failure or the timeout.
 */
export async function sendWebhook(
  url: string,
  headers: Record<string, string>,
  body: string,
  o: SendOptions = {},
): Promise<number> {
  const u = checkCallbackUrl(url);
  const addr = await resolveCallback(u, o.resolve ?? systemResolver, o.publicOnly ?? false);
  const host = hostOf(u);
  const target = new URL(u.href);
  target.hostname = addr.includes(":") ? `[${addr}]` : addr;
  const init: RequestInit & { tls?: Record<string, unknown> } = {
    method: "POST",
    headers: { "content-type": "application/json", host: u.host, ...headers },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(o.timeoutMs ?? DELIVERY_TIMEOUT_MS),
  };
  if (u.protocol === "https:" && !isIP(host)) {
    // The certificate is checked against the callback's name, not the address dialled.
    init.tls = {
      serverName: host,
      checkServerIdentity: (_: string, cert: PeerCertificate) => checkServerIdentity(host, cert),
    };
  }
  const res = await (o.fetch ?? fetch)(target.href, init);
  await res.body?.cancel();
  return res.status;
}

// ---------------------------------------------------------------------------
// The outbox, delivered

export interface DelivererOptions extends SendOptions {
  store: JobStore;
  /** The key's webhook secrets, newest first; none means the delivery cannot be signed. */
  secrets(keyId: string): string[];
  /**
   * Does the key list this callback host by name? When it does not (it reached the host through
   * `*`), the delivery goes to a public address only (SV-K4).
   */
  hostListed(keyId: string, host: string): boolean;
  now?: () => number;
  random?: () => number;
  schedule?: readonly number[];
  /** Audit lines: `webhook.done`, `webhook.failed`, `webhook.disabled`, `webhook.refused`. */
  audit?(what: string, d: Delivery, detail: string): void;
}

/**
 * Delivers the outbox: every pending delivery when it is due, on a timer set for the next one,
 * and at once when `kick` says a new one was written. A try is recorded before it is made (the
 * attempt count and the time of the next try), and its outcome after.
 */
export class Deliverer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Set<string>();
  private closed = false;
  private readonly now: () => number;
  private readonly schedule: readonly number[];

  constructor(private readonly o: DelivererOptions) {
    this.now = o.now ?? Date.now;
    this.schedule = o.schedule ?? RETRY_SCHEDULE_MS;
  }

  /** The delay before try `n` (0-based), with its jitter; null when there is no try `n`. */
  delay(n: number): number | null {
    const base = this.schedule[n];
    if (base === undefined) return null;
    return Math.round(base * (1 + JITTER * (this.o.random ?? Math.random)()));
  }

  /** Runs every due delivery now, then sets the timer for the next. */
  kick(): void {
    if (this.closed) return;
    for (const d of this.o.store.due(this.now())) {
      if (this.inFlight.has(d.event_id)) continue;
      this.inFlight.add(d.event_id);
      void this.attempt(d).finally(() => {
        this.inFlight.delete(d.event_id);
        this.arm();
      });
    }
    this.arm();
  }

  private arm(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.o.store.nextDue();
    if (next === null) return;
    // clock: the outbox's next due time; a restart reads it again from the store.
    this.timer = setTimeout(
      () => this.kick(),
      Math.max(0, Math.min(next - this.now(), 2 ** 31 - 1)),
    );
  }

  private async attempt(d: Delivery): Promise<void> {
    const { store } = this.o;
    const event = store.event(d.event_id);
    const n = d.attempts;
    const after = this.delay(n + 1);
    const nextAt = after === null ? null : this.now() + after;
    // On disk before the try: a server killed while it waits for the receiver tries again then.
    // The last try has no next one, so it is resumed once, after its own timeout, if the process
    // dies during it; it is marked failed only when its answer is in.
    store.recordAttempt(d.event_id, {
      attempts: n + 1,
      state: "pending",
      next_at: nextAt ?? this.now() + (this.o.timeoutMs ?? DELIVERY_TIMEOUT_MS),
      status: d.last_status,
      error: d.last_error,
    });
    const secrets = this.o.secrets(d.key_id);
    if (!event || secrets.length === 0) {
      const why = event ? "the key has no webhook secret (it was revoked)" : "the event is gone";
      store.recordAttempt(d.event_id, {
        attempts: n + 1,
        state: "failed",
        next_at: null,
        status: null,
        error: why,
      });
      this.o.audit?.("webhook.failed", d, why);
      return;
    }
    const body = webhookBody(event);
    const headers = webhookHeaders(secrets, event.id, Math.floor(this.now() / 1000), body);
    let status: number | null = null;
    let error: string | null = null;
    try {
      const host = hostOf(new URL(d.url));
      const publicOnly = !this.o.hostListed(d.key_id, host);
      status = await sendWebhook(d.url, headers, body, { ...this.o, publicOnly });
    } catch (err) {
      // Closed while the try was out: the store may be closed too, and the next process owns it.
      if (this.closed) return;
      if (err instanceof CallbackRefused) {
        store.recordAttempt(d.event_id, {
          attempts: n + 1,
          state: "refused",
          next_at: null,
          status: null,
          error: err.message,
        });
        this.o.audit?.("webhook.refused", d, err.message);
        return;
      }
      error = (err as Error).message;
    }
    if (this.closed) return;
    if (status !== null && status >= 200 && status < 300) {
      store.recordAttempt(d.event_id, {
        attempts: n + 1,
        state: "delivered",
        next_at: null,
        status,
        error: null,
      });
      this.o.audit?.("webhook.done", d, `status ${status} on try ${n + 1}`);
      return;
    }
    if (status === 410) {
      store.recordAttempt(d.event_id, {
        attempts: n + 1,
        state: "disabled",
        next_at: null,
        status,
        error: "410 Gone",
      });
      store.disableEndpoint(d.key_id, d.url);
      this.o.audit?.("webhook.disabled", d, "the receiver answered 410 Gone");
      return;
    }
    const why = error ?? `status ${status}`;
    store.recordAttempt(d.event_id, {
      attempts: n + 1,
      state: nextAt === null ? "failed" : "pending",
      next_at: nextAt,
      status,
      error: why,
    });
    if (nextAt === null) this.o.audit?.("webhook.failed", d, `${why}, after ${n + 1} tries`);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
