/**
 * Signed callbacks for file jobs (docs/ux/SERVER.md section 6): the Standard Webhooks signature
 * checked by the spec's own reference verifier (SV-T2, SV-E2), the body (SV-E3), the retry schedule
 * and 410 (SV-E4), the outbox that survives a restart (SV-E5), and the address rules with DNS
 * rebinding (SV-E7). Receivers are real HTTP servers on loopback; the schedule is scaled down.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import { join } from "node:path";
import { type FeedEvent, JobStore } from "../src/main/server/store.ts";
import {
  addressRefusal,
  CallbackRefused,
  checkCallbackUrl,
  completedData,
  DELIVERY_TIMEOUT_MS,
  Deliverer,
  INLINE_BODY_BYTES,
  RETRY_SCHEDULE_MS,
  type Resolver,
  resolveCallback,
  sendWebhook,
  signWebhook,
  webhookBody,
  webhookHeaders,
} from "../src/main/server/webhooks.ts";
import { until } from "./capture-helpers.ts";
import {
  Receiver,
  SPEC_VECTOR,
  Webhook,
  WebhookVerificationError,
} from "./fixtures/standard-webhooks.ts";
import { tempDir } from "./helpers.ts";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const OTHER = "whsec_c2VjcmV0LW51bWJlci10d28tMzItYnl0ZXMtbG9uZw==";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Hit {
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** A receiver on loopback answering each hit with the next status of `answers` (the last repeats). */
function receiver(answers: number[] | ((n: number) => number | Promise<never>)) {
  const hits: Hit[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const body = await req.text();
      hits.push({
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body,
      });
      const n = hits.length - 1;
      const status =
        typeof answers === "function"
          ? await answers(n)
          : (answers[Math.min(n, answers.length - 1)] as number);
      return status === 302
        ? new Response(null, { status, headers: { location: "/elsewhere" } })
        : new Response(null, { status });
    },
  });
  cleanups.push(() => server.stop(true));
  return { hits, url: `http://127.0.0.1:${server.port}/hook`, port: server.port as number };
}

function store(): JobStore {
  const t = tempDir("akou-hooks-");
  const s = new JobStore(join(t.dir, "jobs.db"));
  cleanups.push(() => {
    s.close();
    t.cleanup();
  });
  return s;
}

/** A finished job with a delivery to `url`, as the queue writes it. */
function deliveredJob(s: JobStore, url: string, key = "key_a"): FeedEvent {
  const { job } = s.submit({
    key_id: key,
    preset: "fast",
    language: "auto",
    keywords: [],
    diarize: false,
    callback_url: url,
    metadata: { x: 1 },
    idempotency_key: null,
    file_sha256: "0".repeat(64),
    audio: "/nonexistent",
  });
  s.markRunning(job.id);
  const result = { job_id: job.id, status: "done", text: "hello world", metadata: { x: 1 } };
  const e = s.finish(
    job.id,
    { status: "done", result },
    { type: "transcription.completed", data: result, deliverTo: url },
  );
  if (!e) throw new Error("finish wrote nothing");
  return e;
}

function deliverer(s: JobStore, o: Partial<ConstructorParameters<typeof Deliverer>[0]> = {}) {
  const audit: { what: string; detail: string }[] = [];
  const d = new Deliverer({
    store: s,
    secrets: () => [SECRET],
    // Every test key lists its receiver's host by name unless the test says otherwise (SV-K4).
    hostListed: () => true,
    random: () => 0,
    schedule: [0, 20, 20, 20, 20, 20, 20, 20, 20, 20],
    audit: (what, _d, detail) => audit.push({ what, detail }),
    ...o,
  });
  cleanups.push(() => d.close());
  return { d, audit };
}

describe("SV-T2: a signed round trip against the Standard Webhooks reference verifier", () => {
  test("the spec's own test vector signs to the spec's signature, in akou and in the reference", () => {
    const v = SPEC_VECTOR;
    expect(`v1,${signWebhook(v.secret, v.id, v.timestamp, v.payload)}`).toBe(v.signature);
    expect(new Webhook(v.secret).sign(v.id, new Date(v.timestamp * 1000), v.payload)).toBe(
      v.signature,
    );
  });

  test("a delivery akou sends passes the reference verifier", async () => {
    const r = receiver([204]);
    const s = store();
    const e = deliveredJob(s, r.url);
    deliverer(s).d.kick();
    await until(() => r.hits.length === 1, 3000, "the delivery");
    const hit = r.hits[0] as Hit;
    const body = new Receiver(SECRET).accept(hit.body, hit.headers) as { data: { text: string } };
    expect(body.data.text).toBe("hello world");
    expect(hit.headers["webhook-id"]).toBe(e.id);
  });

  test("the four negatives are refused: wrong secret, edited body, stale timestamp, replayed id", () => {
    const now = Math.floor(Date.now() / 1000);
    const body = webhookBody({ type: "transcription.completed", at: Date.now(), data: { a: 1 } });
    const headers = webhookHeaders([SECRET], "msg_1", now, body);
    expect(() => new Receiver(OTHER).accept(body, headers)).toThrow(WebhookVerificationError);
    const i = body.indexOf("1");
    const edited = `${body.slice(0, i)}2${body.slice(i + 1)}`;
    expect(edited.length).toBe(body.length);
    expect(() => new Receiver(SECRET).accept(edited, headers)).toThrow("No matching signature");
    const stale = webhookHeaders([SECRET], "msg_2", now - 6 * 60, body);
    expect(() => new Receiver(SECRET).accept(body, stale)).toThrow("too old");
    const rx = new Receiver(SECRET);
    expect(rx.accept(body, headers)).toEqual(JSON.parse(body));
    expect(() => rx.accept(body, headers)).toThrow("already received");
  });
});

describe("SV-E2: the Standard Webhooks headers", () => {
  test("a rotated secret signs twice, and a receiver holding either one accepts", () => {
    const now = Math.floor(Date.now() / 1000);
    const h = webhookHeaders([SECRET, OTHER], "msg_r", now, "{}");
    expect(h["webhook-signature"]?.split(" ").length).toBe(2);
    expect(new Webhook(SECRET).verify("{}", h)).toEqual({});
    expect(new Webhook(OTHER).verify("{}", h)).toEqual({});
  });
});

describe("SV-E3: the body", () => {
  test("a voice note's result is inline", () => {
    const result = { job_id: "job_1", status: "done", text: "hi", words: [], segments: [] };
    expect(completedData(result, "job_1")).toEqual(result);
  });

  test("a 3 hour file's result carries result_url and no text, words or segments", () => {
    // Three hours of lines, one every 5 s, as the result of SV-J4 would hold them.
    const segments = Array.from({ length: (3 * 3600) / 5 }, (_, i) => ({
      s: i * 5,
      e: i * 5 + 4.5,
      text: "we should move the build to the new box today",
      speaker: null,
    }));
    const result = {
      job_id: "job_3h",
      status: "done",
      text: segments.map((x) => x.text).join(" "),
      words: [],
      segments,
      duration_s: 10800,
      metadata: { content_hash: "abc" },
    };
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(INLINE_BODY_BYTES);
    const data = completedData(result, "job_3h");
    expect(data.result_url).toBe("/v1/jobs/job_3h/result");
    expect(data).not.toHaveProperty("text");
    expect(data).not.toHaveProperty("words");
    expect(data).not.toHaveProperty("segments");
    expect(data.metadata).toEqual({ content_hash: "abc" });
    expect(data.duration_s).toBe(10800);
  });

  test("the body is {type, timestamp, data} with an ISO time", () => {
    const b = JSON.parse(webhookBody({ type: "transcription.failed", at: 0, data: { x: 1 } }));
    expect(b).toEqual({
      type: "transcription.failed",
      timestamp: "1970-01-01T00:00:00.000Z",
      data: { x: 1 },
    });
  });
});

describe("SV-E4: the retry schedule", () => {
  test("the schedule is the design's, with a 30 s request timeout", () => {
    const m = 60_000;
    const h = 60 * m;
    expect(RETRY_SCHEDULE_MS).toEqual([
      0,
      5_000,
      5 * m,
      30 * m,
      2 * h,
      5 * h,
      10 * h,
      14 * h,
      20 * h,
      24 * h,
    ]);
    expect(DELIVERY_TIMEOUT_MS).toBe(30_000);
  });

  test("jitter adds up to 10 % of each delay, and never makes a delay shorter", () => {
    const s = store();
    expect(
      new Deliverer({ store: s, secrets: () => [], hostListed: () => true, random: () => 0 }).delay(
        1,
      ),
    ).toBe(5_000);
    expect(
      new Deliverer({
        store: s,
        secrets: () => [],
        hostListed: () => true,
        random: () => 0.999,
      }).delay(1),
    ).toBe(5_500);
    expect(
      new Deliverer({ store: s, secrets: () => [], hostListed: () => true }).delay(10),
    ).toBeNull();
  });

  test("a receiver that fails four times and then accepts gets the fifth try, with the same id", async () => {
    const r = receiver([500, 503, 0, 404, 204].map((x) => x || 500));
    const s = store();
    const e = deliveredJob(s, r.url);
    const { audit } = deliverer(s);
    deliverer(s).d.kick();
    await until(() => s.delivery(e.id)?.state === "delivered", 5000, "the fifth try");
    expect(r.hits.length).toBe(5);
    expect(new Set(r.hits.map((h) => h.headers["webhook-id"]))).toEqual(new Set([e.id]));
    expect(s.delivery(e.id)?.attempts).toBe(5);
    // Each try is signed afresh and each one verifies.
    for (const h of r.hits)
      expect(() => new Webhook(SECRET).verify(h.body, h.headers)).not.toThrow();
    expect(audit).toEqual([]);
  });

  test("a receiver answering 410 gets no sixth try", async () => {
    const r = receiver([500, 500, 500, 500, 410, 204]);
    const s = store();
    const e = deliveredJob(s, r.url);
    const { d, audit } = deliverer(s);
    d.kick();
    await until(() => s.delivery(e.id)?.state === "disabled", 5000, "the 410");
    // Past the time every remaining try of the schedule would have run.
    await Bun.sleep(300);
    expect(r.hits.length).toBe(5);
    expect(s.delivery(e.id)).toMatchObject({ attempts: 5, next_at: null, last_status: 410 });
    expect(audit.map((a) => a.what)).toEqual(["webhook.disabled"]);
  });

  test("410 stops every delivery then pending to that URL for that key, and no other key's", async () => {
    const r = receiver([410]);
    const s = store();
    const a = deliveredJob(s, r.url, "key_a");
    const b = deliveredJob(s, r.url, "key_a");
    const c = deliveredJob(s, r.url, "key_b");
    // Only `a` is due: `b` and `c` wait an hour.
    for (const id of [b.id, c.id]) {
      s.recordAttempt(id, {
        attempts: 1,
        state: "pending",
        next_at: Date.now() + 3_600_000,
        status: 500,
        error: "x",
      });
    }
    deliverer(s).d.kick();
    await until(() => s.delivery(a.id)?.state === "disabled", 3000, "the 410");
    expect(s.delivery(b.id)?.state).toBe("disabled");
    expect(s.delivery(c.id)?.state).toBe("pending");
  });

  test("a 3xx is not followed and counts as a failure", async () => {
    const r = receiver([302, 204]);
    const s = store();
    const e = deliveredJob(s, r.url);
    deliverer(s).d.kick();
    await until(() => s.delivery(e.id)?.state === "delivered", 3000, "the retry");
    expect(r.hits.map((h) => h.path)).toEqual(["/hook", "/hook"]);
    expect(s.delivery(e.id)?.attempts).toBe(2);
  });

  test("a receiver that never answers is a failed try after the timeout, then retried", async () => {
    let n = 0;
    const r = receiver((i) => {
      n = i;
      return i === 0 ? new Promise<never>(() => {}) : 204;
    });
    const s = store();
    const e = deliveredJob(s, r.url);
    deliverer(s, { timeoutMs: 200 }).d.kick();
    await until(() => s.delivery(e.id)?.state === "delivered", 5000, "the retry after the timeout");
    expect(n).toBe(1);
    expect(s.delivery(e.id)?.attempts).toBe(2);
  });

  test("a try that outlasts the next delay does not spin the deliverer while it is out", async () => {
    let release = () => {};
    const held = new Promise<number>((r) => {
      release = () => r(500);
    });
    const r = receiver((n) => (n === 0 ? held : 204) as number | Promise<never>);
    const s = store();
    const e = deliveredJob(s, r.url);
    let polls = 0;
    const nextDue = s.nextDue.bind(s);
    s.nextDue = (...a: Parameters<JobStore["nextDue"]>) => {
      polls++;
      return nextDue(...a);
    };
    deliverer(s, { schedule: [0, 20, 60_000] }).d.kick();
    await until(() => r.hits.length === 1, 3000, "the first try to reach the receiver");
    const before = polls;
    // Ten times the next delay, all of it with the first try still out.
    await Bun.sleep(200);
    expect(polls - before).toBeLessThanOrEqual(1);
    release();
    await until(() => s.delivery(e.id)?.state === "delivered", 3000, "the retry");
  });

  test("the next delay runs from the failed try's answer, not from its start", async () => {
    const at: number[] = [];
    const r = receiver((n) => {
      at.push(performance.now());
      return (n === 0 ? Bun.sleep(300).then(() => 500) : 204) as number | Promise<never>;
    });
    const s = store();
    const e = deliveredJob(s, r.url);
    deliverer(s, { schedule: [0, 200, 60_000] }).d.kick();
    await until(() => s.delivery(e.id)?.state === "delivered", 3000, "the retry");
    // The first try answered 300 ms after it arrived; the retry waits its 200 ms after that.
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(490);
  });

  test("after the last try the delivery is failed and audited", async () => {
    const r = receiver([500]);
    const s = store();
    const e = deliveredJob(s, r.url);
    const { d, audit } = deliverer(s, { schedule: [0, 10, 10] });
    d.kick();
    await until(() => s.delivery(e.id)?.state === "failed", 3000, "the last try");
    expect(r.hits.length).toBe(3);
    expect(audit.at(-1)?.what).toBe("webhook.failed");
  });
});

describe("SV-E5: the outbox survives a restart", () => {
  test("the last try is pending while it is in flight, and failed only after it", async () => {
    let release = () => {};
    const held = new Promise<number>((r) => {
      release = () => r(500);
    });
    const r = receiver((n) => (n === 2 ? held : 500) as number | Promise<never>);
    const s = store();
    const e = deliveredJob(s, r.url);
    const { d } = deliverer(s, { schedule: [0, 10, 10] });
    d.kick();
    await until(() => r.hits.length === 3, 3000, "the last try to reach the receiver");
    expect(s.delivery(e.id)).toMatchObject({ attempts: 3, state: "pending" });
    release();
    await until(() => s.delivery(e.id)?.state === "failed", 3000, "the last try's outcome");
  });

  test("a deliverer closed during a try writes nothing after it", async () => {
    let release = () => {};
    const held = new Promise<number>((r) => {
      release = () => r(500);
    });
    const r = receiver(() => held as unknown as Promise<never>);
    const s = store();
    const e = deliveredJob(s, r.url);
    const { d } = deliverer(s);
    d.kick();
    await until(() => r.hits.length === 1, 3000, "the try to reach the receiver");
    const before = s.delivery(e.id);
    d.close();
    release();
    await Bun.sleep(100);
    expect(s.delivery(e.id)).toEqual(before);
  });

  for (const answer of [500, 204, 410]) {
    test(`a job deleted while its try is out stays failed when the try answers ${answer}`, async () => {
      let release = () => {};
      const held = new Promise<number>((r) => {
        release = () => r(answer);
      });
      const r = receiver((n) => (n === 0 ? held : 204) as number | Promise<never>);
      const s = store();
      const e = deliveredJob(s, r.url);
      const { d, audit } = deliverer(s);
      d.kick();
      await until(() => r.hits.length === 1, 3000, "the try to reach the receiver");
      expect(s.remove(e.job_id)).not.toBeNull();
      expect(s.delivery(e.id)).toMatchObject({
        state: "failed",
        last_error: "the job was deleted",
      });
      release();
      // Past the time every remaining try of the schedule would have run.
      await Bun.sleep(300);
      expect(s.delivery(e.id)).toMatchObject({
        state: "failed",
        last_error: "the job was deleted",
      });
      expect(r.hits.length).toBe(1);
      // A 410 still disables the endpoint for the key's other deliveries: the receiver said so.
      expect(audit.map((a) => a.what)).toEqual(answer === 410 ? ["webhook.disabled"] : []);
    });
  }

  test("killed between try 2 and 3, the delivery goes out once more with the same id on restart", async () => {
    const r = receiver([500, 500, 204]);
    const t = tempDir("akou-outbox-");
    cleanups.push(t.cleanup);
    const path = join(t.dir, "jobs.db");
    const first = new JobStore(path);
    const e = deliveredJob(first, r.url);
    const a = new Deliverer({
      store: first,
      secrets: () => [SECRET],
      hostListed: () => true,
      random: () => 0,
      schedule: [0, 20, 400, 400],
    });
    a.kick();
    await until(() => first.delivery(e.id)?.attempts === 2, 3000, "two tries");
    // The process dies: no close, no flush; the store is simply abandoned.
    a.close();
    const onDisk = new JobStore(path);
    cleanups.push(() => onDisk.close());
    const row = onDisk.delivery(e.id);
    expect(row?.attempts).toBe(2);
    expect(row?.state).toBe("pending");
    expect(row?.next_at).toBeGreaterThan(Date.now());
    const b = new Deliverer({
      store: onDisk,
      secrets: () => [SECRET],
      hostListed: () => true,
      random: () => 0,
      schedule: [0, 20, 400, 400],
    });
    cleanups.push(() => b.close());
    b.kick();
    await until(() => onDisk.delivery(e.id)?.state === "delivered", 3000, "the third try");
    expect(r.hits.length).toBe(3);
    expect(r.hits.map((h) => h.headers["webhook-id"])).toEqual([e.id, e.id, e.id]);
    first.close();
  });

  test("the delivery is on disk, with no try made, in the transaction that ends the job", () => {
    const s = store();
    const e = deliveredJob(s, "https://archive.example/hook");
    expect(s.delivery(e.id)).toMatchObject({
      attempts: 0,
      state: "pending",
      url: "https://archive.example/hook",
    });
  });
});

describe("SV-E7: address rules for callback URLs", () => {
  test("a link-local or metadata callback is refused at submit", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.1.1/",
      "http://[fe80::1]/",
      "https://[fd00:ec2::254]/",
      "http://0.0.0.0:8080/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      expect(() => checkCallbackUrl(url), url).toThrow(CallbackRefused);
    }
  });

  test("only http and https, and no credentials in the URL", () => {
    expect(() => checkCallbackUrl("ftp://archive.lan/x")).toThrow("http or https");
    expect(() => checkCallbackUrl("https://u:p@archive.example/x")).toThrow("user name");
    expect(() => checkCallbackUrl("not a url")).toThrow("not a URL");
  });

  test("plain http reaches loopback, RFC 1918 and unique-local only; https reaches public addresses", () => {
    for (const ok of [
      "http://127.0.0.1:8080/",
      "http://10.0.0.5/",
      "http://172.16.3.4/",
      "http://192.168.10.2/",
      "http://[fd12::5]/",
      "http://[::1]/",
      "https://203.0.113.9/",
      "https://archive.example/",
      "http://archive.lan/",
    ]) {
      expect(() => checkCallbackUrl(ok), ok).not.toThrow();
    }
    for (const bad of [
      "http://203.0.113.9/",
      "http://8.8.8.8/",
      "http://100.64.1.2/",
      "http://[2001:db8::1]/",
    ]) {
      expect(() => checkCallbackUrl(bad), bad).toThrow("https only");
    }
    // The metadata address inside the unique-local block is still refused.
    expect(addressRefusal("fd00:ec2::254", "https:")).toContain("metadata");
  });

  test("a name that resolves to 169.254.1.1 at delivery is logged as webhook.refused and not sent", async () => {
    const r = receiver([204]);
    const s = store();
    const url = `http://archive.example:${r.port}/hook`;
    const e = deliveredJob(s, url);
    const resolve: Resolver = async () => [{ address: "169.254.1.1" }];
    const { d, audit } = deliverer(s, { resolve });
    d.kick();
    await until(() => s.delivery(e.id)?.state === "refused", 3000, "the refusal");
    expect(audit.map((a) => a.what)).toEqual(["webhook.refused"]);
    expect(audit[0]?.detail).toContain("169.254.1.1");
    expect(r.hits.length).toBe(0);
  });

  test("positive control: the same name resolving to loopback is delivered", async () => {
    const r = receiver([204]);
    const s = store();
    const e = deliveredJob(s, `http://archive.example:${r.port}/hook`);
    const { d } = deliverer(s, { resolve: async () => [{ address: "127.0.0.1" }] });
    d.kick();
    await until(() => s.delivery(e.id)?.state === "delivered", 3000, "the delivery");
    expect(r.hits.length).toBe(1);
    // The receiver saw the callback's own host name, not the address dialled.
    expect(r.hits[0]?.headers.host).toBe(`archive.example:${r.port}`);
  });

  test("a name with a link-local address among its answers is refused, whichever comes first", async () => {
    await expect(
      resolveCallback(new URL("http://archive.lan/x"), async () => [
        { address: "127.0.0.1" },
        { address: "169.254.1.1" },
      ]),
    ).rejects.toThrow("169.254.1.1");
  });

  test("plain http to a name that resolves to a public address is refused at delivery", async () => {
    await expect(
      resolveCallback(new URL("http://archive.example/x"), async () => [
        { address: "203.0.113.7" },
      ]),
    ).rejects.toThrow("https only");
    expect(
      await resolveCallback(new URL("https://archive.example/x"), async () => [
        { address: "203.0.113.7" },
      ]),
    ).toBe("203.0.113.7");
  });

  /** A TCP listener on loopback that counts connections: a TLS client reaching it is counted. */
  function tcpCounter() {
    const n = { connections: 0 };
    const server = createServer((sock) => {
      n.connections++;
      sock.destroy();
    });
    return new Promise<{ n: typeof n; port: number }>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
        resolve({ n, port: (server.address() as AddressInfo).port });
      }),
    );
  }

  test("DNS rebinding: a name that is public at the check and 127.0.0.1 after is never dialled on loopback", async () => {
    const { n, port } = await tcpCounter();
    let calls = 0;
    const resolve: Resolver = async () => {
      calls++;
      return [{ address: calls === 1 ? "203.0.113.10" : "127.0.0.1" }];
    };
    await expect(
      sendWebhook(`https://rebind.example:${port}/hook`, {}, "{}", { resolve, timeoutMs: 300 }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(n.connections).toBe(0);
  });

  test("positive control: when the checked answer is 127.0.0.1, that is where the request goes", async () => {
    const { n, port } = await tcpCounter();
    await expect(
      sendWebhook(`https://rebind.example:${port}/hook`, {}, "{}", {
        resolve: async () => [{ address: "127.0.0.1" }],
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
    expect(n.connections).toBe(1);
  });

  test("https dials the checked address with the host name as SNI and certificate name", async () => {
    let seen: { url: string; init: RequestInit & { tls?: Record<string, unknown> } } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const status = await sendWebhook("https://archive.example/api/cb?x=1", { a: "b" }, "{}", {
      fetch: fake,
      resolve: async () => [{ address: "203.0.113.7" }],
    });
    expect(status).toBe(204);
    const s = seen as unknown as {
      url: string;
      init: RequestInit & { tls?: Record<string, unknown> };
    };
    expect(s.url).toBe("https://203.0.113.7/api/cb?x=1");
    expect((s.init.headers as Record<string, string>).host).toBe("archive.example");
    expect(s.init.tls?.serverName).toBe("archive.example");
    expect(s.init.redirect).toBe("manual");
  });
});

describe("SV-K4: a callback-host wildcard reaches public addresses only, at delivery too", () => {
  for (const addr of ["10.0.0.5", "127.0.0.1"]) {
    test(`a key with only * cannot deliver to a name that resolves to ${addr}`, async () => {
      const r = receiver([204]);
      const s = store();
      const e = deliveredJob(s, `http://archive.example:${r.port}/hook`);
      const listed: string[] = [];
      const { d, audit } = deliverer(s, {
        resolve: async () => [{ address: addr }],
        hostListed: (key, host) => {
          listed.push(`${key} ${host}`);
          return false;
        },
      });
      d.kick();
      await until(() => s.delivery(e.id)?.state === "refused", 3000, "the refusal");
      expect(listed).toEqual(["key_a archive.example"]);
      expect(audit.map((a) => a.what)).toEqual(["webhook.refused"]);
      expect(audit[0]?.detail).toContain(addr);
      expect(r.hits.length).toBe(0);
    });
  }

  test("the same key with the host listed by name delivers there", async () => {
    const r = receiver([204]);
    const s = store();
    const e = deliveredJob(s, `http://archive.example:${r.port}/hook`);
    const { d } = deliverer(s, {
      resolve: async () => [{ address: "127.0.0.1" }],
      hostListed: (_key, host) => host === "archive.example",
    });
    d.kick();
    await until(() => s.delivery(e.id)?.state === "delivered", 3000, "the delivery");
    expect(r.hits.length).toBe(1);
  });

  test("a wildcard still reaches a public address over https", async () => {
    expect(
      await resolveCallback(
        new URL("https://archive.example/x"),
        async () => [{ address: "203.0.113.7" }],
        true,
      ),
    ).toBe("203.0.113.7");
    await expect(
      resolveCallback(
        new URL("https://archive.example/x"),
        async () => [{ address: "100.64.0.9" }],
        true,
      ),
    ).rejects.toThrow("100.64.0.9");
  });
});
