/**
 * The webhook receiver of the server CI job's round trip (docs/ux/SERVER.md SV-T1): it verifies
 * Standard Webhooks signatures, and its positive control, a real delivery re-sent with one byte of
 * the body changed, is refused. With the check removed the same control fails, which is what makes
 * the CI step a check that can fail.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type Receiver,
  sign,
  startReceiver,
  tamperedRefused,
  verifyWebhook,
} from "../scripts/server-roundtrip.ts";

// The example in the Standard Webhooks specification.
const SPEC = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: "1614265330",
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

const receivers: Receiver[] = [];
afterEach(() => {
  for (const r of receivers.splice(0)) r.stop();
});

async function deliver(r: Receiver, secret: string, body: string): Promise<number> {
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`http://127.0.0.1:${r.port}/hook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${sign(secret, id, timestamp, body)}`,
    },
    body,
  });
  return res.status;
}

describe("[SV-T1] the round trip's webhook receiver", () => {
  test("the specification's own example verifies; a changed byte, a stale timestamp and a wrong secret do not", () => {
    const h = { id: SPEC.id, timestamp: SPEC.timestamp, signature: SPEC.signature };
    const at = Number(SPEC.timestamp);
    expect(verifyWebhook(SPEC.secret, h, SPEC.body, at)).toBe(true);
    expect(verifyWebhook(SPEC.secret, h, SPEC.body.replace("2", "3"), at)).toBe(false);
    expect(verifyWebhook(SPEC.secret, h, SPEC.body, at + 301)).toBe(false);
    expect(verifyWebhook("whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", h, SPEC.body, at)).toBe(false);
    // A rotated secret signs twice: any one match is enough.
    const both = { ...h, signature: `v1,bm90IGl0 ${SPEC.signature}` };
    expect(verifyWebhook(SPEC.secret, both, SPEC.body, at)).toBe(true);
  });

  test("a signed delivery is accepted, and the same delivery with one byte changed is refused", async () => {
    const r = startReceiver({ secret: SPEC.secret });
    receivers.push(r);
    expect(
      await deliver(r, SPEC.secret, '{"type":"transcription.completed","data":{"text":"hi"}}'),
    ).toBe(204);
    expect(r.deliveries).toHaveLength(1);
    expect(await tamperedRefused(r, r.deliveries[0] as NonNullable<(typeof r.deliveries)[0]>)).toBe(
      true,
    );
    expect(r.deliveries).toHaveLength(1);
  });

  test("positive control: with the signature check removed, the tampered delivery is accepted and the control fails", async () => {
    const r = startReceiver({ secret: SPEC.secret, verify: false });
    receivers.push(r);
    expect(
      await deliver(r, SPEC.secret, '{"type":"transcription.completed","data":{"text":"hi"}}'),
    ).toBe(204);
    expect(await tamperedRefused(r, r.deliveries[0] as NonNullable<(typeof r.deliveries)[0]>)).toBe(
      false,
    );
  });
});
