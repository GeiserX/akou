/**
 * The webhook (docs/DESIGN.md section 8.2, item 3), off by default: a `POST` of the same JSON the
 * hooks get, at the same stages.
 *
 * - `X-Akou-Event`: the stage, which is the event type name (`call.ended`, `final.done`,
 *   `enhanced`).
 * - `X-Akou-Signature: sha256=<hex>`: HMAC-SHA256 of the exact body bytes with `webhook.secret`.
 *   The webhook stays off until a secret is set, so an unsigned delivery is never sent.
 * - Three retries after the first attempt, with backoff, on a network error, a timeout, 408, 429
 *   or any 5xx. Any other answer is final.
 * - The outcome becomes `webhook.done {url, status, attempts}`; `status` is 0 when no answer came.
 *   The URL is recorded without its path and query, which is where chat services keep the secret.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { EventDraft } from "../../core/log/events.ts";
import type { HookStage } from "../config/schema.ts";

export const WEBHOOK_RETRIES = 3;
export const WEBHOOK_BACKOFF_MS = [2_000, 10_000, 30_000] as const;
export const WEBHOOK_TIMEOUT_MS = 15_000;

/** `sha256=<hex>` over the exact bytes sent. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** The address as the log may keep it: scheme, host and port only. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" && u.search === "" ? u.origin : `${u.origin}/…`;
  } catch {
    return "(invalid url)";
  }
}

/** Why the webhook cannot run, or null when it can. */
export function webhookProblem(url: string, secret: string): string | null {
  if (url === "") return "webhook.url is not set";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "webhook.url is not a valid address";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "webhook.url must be http or https";
  if (secret === "") return "webhook.secret is not set, and akou never sends an unsigned webhook";
  return null;
}

function retryable(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export interface WebhookOptions {
  url: string;
  secret: string;
  stage: HookStage;
  /** The JSON document, already serialised: the signature covers these bytes. */
  body: string;
  version: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: readonly number[];
  timeoutMs?: number;
}

export interface WebhookResult {
  status: number;
  attempts: number;
  error?: string;
}

/** Delivers one webhook with its retries. Never throws. */
export async function sendWebhook(o: WebhookOptions): Promise<WebhookResult> {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = o.backoffMs ?? WEBHOOK_BACKOFF_MS;
  const headers = {
    "content-type": "application/json",
    "user-agent": `akou/${o.version}`,
    "x-akou-event": o.stage,
    "x-akou-signature": signBody(o.secret, o.body),
    // The same id on every attempt, so a receiver can drop a retried delivery it already has.
    "x-akou-delivery": randomUUID(),
  };
  let status = 0;
  let error: string | undefined;
  let attempts = 0;
  for (let i = 0; i <= WEBHOOK_RETRIES; i++) {
    if (i > 0) await sleep(backoff[Math.min(i - 1, backoff.length - 1)] as number);
    attempts++;
    try {
      const res = await doFetch(o.url, {
        method: "POST",
        headers,
        body: o.body,
        redirect: "manual",
        signal: AbortSignal.timeout(o.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
      });
      status = res.status;
      error = undefined;
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      status = 0;
      error = (err as Error).message;
    }
    if (!retryable(status)) break;
  }
  return error !== undefined ? { status, attempts, error } : { status, attempts };
}

export function webhookDoneDraft(url: string, r: WebhookResult): EventDraft {
  return { type: "webhook.done", url: redactUrl(url), status: r.status, attempts: r.attempts };
}
