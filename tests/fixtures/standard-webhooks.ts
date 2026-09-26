/**
 * The Standard Webhooks reference verifier, `libraries/javascript/src/index.ts` of
 * https://github.com/standard-webhooks/standard-webhooks at 7537d2a2d3d52d8f2e0ecd12527af4a9307fd81b
 * (MIT licence, Copyright the Standard Webhooks authors), kept line for line. The only changes: the
 * two `@stablelib` helpers and `fast-sha256` are replaced by `node:crypto` (the same base64 and
 * HMAC-SHA256), and the Deno `timingSafeEqual` by Node's, so the test suite needs no dependency.
 *
 * The spec's own test vector, from `libraries/go/webhook_test.go` of the same commit, is below.
 */

import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

export const SPEC_VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  payload: `{"test": 2432232314}`,
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

const WEBHOOK_TOLERANCE_IN_SECONDS = 5 * 60; // 5 minutes

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return nodeTimingSafeEqual(a, b);
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export class Webhook {
  private static prefix = "whsec_";
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (typeof secret !== "string") {
      throw new Error("Expected secret to be of type string");
    }
    if (secret.startsWith(Webhook.prefix)) {
      secret = secret.substring(Webhook.prefix.length);
    }
    this.key = Buffer.from(secret, "base64");
    if (this.key.length === 0) {
      throw new Error("Secret can't be empty.");
    }
  }

  public verify(payload: string, headers: Record<string, string>): unknown {
    const normalizedHeaders: Record<string, string> = {};
    for (const key of Object.keys(headers)) {
      normalizedHeaders[key.toLowerCase()] = headers[key] as string;
    }

    const msgId = normalizedHeaders["webhook-id"];
    const msgSignature = normalizedHeaders["webhook-signature"];
    const msgTimestamp = normalizedHeaders["webhook-timestamp"];

    if (!msgSignature || !msgId || !msgTimestamp) {
      throw new WebhookVerificationError("Missing required headers");
    }

    const timestamp = this.verifyTimestamp(msgTimestamp);

    const computedSignature = this.sign(msgId, timestamp, payload);
    const expectedSignature = computedSignature.split(",")[1] as string;

    const passedSignatures = msgSignature.split(" ");

    const encoder = new globalThis.TextEncoder();
    for (const versionedSignature of passedSignatures) {
      const [version, signature] = versionedSignature.split(",");
      if (version !== "v1") {
        continue;
      }

      if (timingSafeEqual(encoder.encode(signature), encoder.encode(expectedSignature))) {
        const payloadString = payload.toString();
        if (payloadString === "") {
          return undefined;
        }
        return JSON.parse(payloadString);
      }
    }
    throw new WebhookVerificationError("No matching signature found");
  }

  public sign(msgId: string, timestamp: Date, payload: string): string {
    const timestampNumber = Math.floor(timestamp.getTime() / 1000);
    const toSign = `${msgId}.${timestampNumber}.${payload}`;
    const expectedSignature = createHmac("sha256", this.key).update(toSign).digest("base64");
    return `v1,${expectedSignature}`;
  }

  private verifyTimestamp(timestampHeader: string): Date {
    const now = Math.floor(Date.now() / 1000);
    const timestamp = Number.parseInt(timestampHeader, 10);
    if (Number.isNaN(timestamp)) {
      throw new WebhookVerificationError("Invalid Signature Headers");
    }

    if (now - timestamp > WEBHOOK_TOLERANCE_IN_SECONDS) {
      throw new WebhookVerificationError("Message timestamp too old");
    }
    if (timestamp > now + WEBHOOK_TOLERANCE_IN_SECONDS) {
      throw new WebhookVerificationError("Message timestamp too new");
    }
    return new Date(timestamp * 1000);
  }
}

/**
 * A receiver as the spec asks one to be: the reference verifier, then `webhook-id` as the
 * deduplication key, so a delivery replayed inside the five minutes is refused too.
 */
export class Receiver {
  private readonly seen = new Set<string>();
  private readonly wh: Webhook;

  constructor(secret: string) {
    this.wh = new Webhook(secret);
  }

  /** The parsed body, or throws `WebhookVerificationError`. */
  accept(payload: string, headers: Record<string, string>): unknown {
    const body = this.wh.verify(payload, headers);
    const id = headers["webhook-id"] as string;
    if (this.seen.has(id)) throw new WebhookVerificationError("Message already received");
    this.seen.add(id);
    return body;
  }
}
