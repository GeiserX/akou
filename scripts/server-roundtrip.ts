/**
 * The job round trip of the server CI job (docs/ux/SERVER.md SV-T1): one voice note per preset,
 * submitted to `POST /v1/jobs` with a callback, read back three ways (the long-poll and the result
 * route, the per-key event feed, the signed webhook to a receiver in this process), and the three
 * compared field by field. The receiver checks every delivery's Standard Webhooks signature; the
 * positive control re-sends a real delivery with one byte of its body changed and requires the
 * receiver to refuse it, so a receiver with the check removed fails the job.
 *
 *   AKOU_URL=http://127.0.0.1:8476 AKOU_API_KEY=ak_... AKOU_WEBHOOK_SECRET=whsec_... \
 *   CALLBACK_HOST=host.docker.internal bun scripts/server-roundtrip.ts note.ogg
 *
 * `fast` is required. `lite` runs when `GET /v1/server` lists it as available, and the summary says
 * plainly when it did not.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// The receiver

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** Standard Webhooks: HMAC-SHA256 over `id.timestamp.body` with the secret's base64 bytes. */
export function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/**
 * True when one `v1,` signature in the header matches and the timestamp is within the tolerance
 * (five minutes, the spec's default) of `now`, in seconds.
 */
export function verifyWebhook(
  secret: string,
  h: WebhookHeaders,
  body: string,
  now = Date.now() / 1000,
  toleranceS = 300,
): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > toleranceS) return false;
  const want = Buffer.from(sign(secret, h.id, h.timestamp, body));
  return h.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

export interface Delivery {
  id: string;
  headers: WebhookHeaders;
  raw: string;
  // biome-ignore lint/suspicious/noExplicitAny: a delivery body is read field by field.
  body: any;
}

export interface Receiver {
  port: number;
  deliveries: Delivery[];
  stop(): void;
}

/** A webhook receiver on `hostname`: 204 for a delivery it accepts, 401 for one it refuses. */
export function startReceiver(o: {
  secret: string;
  verify?: boolean;
  hostname?: string;
}): Receiver {
  const deliveries: Delivery[] = [];
  const server = Bun.serve({
    hostname: o.hostname ?? "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const raw = await req.text();
      const headers: WebhookHeaders = {
        id: req.headers.get("webhook-id"),
        timestamp: req.headers.get("webhook-timestamp"),
        signature: req.headers.get("webhook-signature"),
      };
      if (o.verify !== false && !verifyWebhook(o.secret, headers, raw)) {
        return new Response("bad signature", { status: 401 });
      }
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response("not JSON", { status: 400 });
      }
      deliveries.push({ id: headers.id ?? "", headers, raw, body });
      return new Response(null, { status: 204 });
    },
  });
  return { port: server.port as number, deliveries, stop: () => server.stop(true) };
}

/**
 * The positive control: `delivery` re-sent to the receiver with one byte of its body changed and
 * its headers kept. True when the receiver refused it and recorded nothing.
 */
export async function tamperedRefused(r: Receiver, delivery: Delivery): Promise<boolean> {
  const before = r.deliveries.length;
  const i = delivery.raw.search(/[a-z]/);
  const raw =
    i < 0
      ? `${delivery.raw} `
      : `${delivery.raw.slice(0, i)}${delivery.raw[i] === "a" ? "b" : "a"}${delivery.raw.slice(i + 1)}`;
  const res = await fetch(`http://127.0.0.1:${r.port}/hook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": delivery.headers.id ?? "",
      "webhook-timestamp": delivery.headers.timestamp ?? "",
      "webhook-signature": delivery.headers.signature ?? "",
    },
    body: raw,
  });
  return res.status === 401 && r.deliveries.length === before;
}

// ---------------------------------------------------------------------------
// The round trip

/** The fields every path must agree on (SV-J4). */
// biome-ignore lint/suspicious/noExplicitAny: results are compared field by field.
export function projection(r: any): Record<string, unknown> {
  return {
    job_id: r?.job_id,
    text: r?.text,
    language: r?.language,
    words: r?.words,
    segments: r?.segments,
    engine: r?.engine,
    metadata: r?.metadata,
  };
}

async function main(): Promise<void> {
  const base = (process.env.AKOU_URL ?? "").replace(/\/+$/, "");
  const key = process.env.AKOU_API_KEY ?? "";
  const secret = process.env.AKOU_WEBHOOK_SECRET ?? "";
  const callbackHost = process.env.CALLBACK_HOST ?? "127.0.0.1";
  const note = process.argv[2];
  if (!base || !key || !secret || !note) {
    throw new Error(
      "usage: AKOU_URL=... AKOU_API_KEY=... AKOU_WEBHOOK_SECRET=... bun scripts/server-roundtrip.ts note.ogg",
    );
  }
  const auth = { authorization: `Bearer ${key}` };
  // biome-ignore lint/suspicious/noExplicitAny: API answers are read field by field.
  const get = async (path: string): Promise<any> => {
    const res = await fetch(`${base}${path}`, { headers: auth });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${text}`);
    return JSON.parse(text);
  };

  const server = await (await fetch(`${base}/v1/server`)).json();
  const available = (name: string) =>
    (server.presets ?? []).some(
      (p: { name?: string; available?: boolean }) => p.name === name && p.available === true,
    );
  if (!available("fast"))
    throw new Error(`fast is not available: ${JSON.stringify(server.presets)}`);
  const presets = ["fast", ...(available("lite") ? ["lite"] : [])];
  if (!presets.includes("lite")) console.log("lite: not available on this server, not submitted");

  const receiver = startReceiver({ secret, hostname: "0.0.0.0" });
  let cursor: unknown = 0;
  try {
    for (const preset of presets) {
      const form = new FormData();
      form.set("file", Bun.file(note), "note.ogg");
      form.set("preset", preset);
      form.set("callback_url", `http://${callbackHost}:${receiver.port}/hook`);
      form.set("metadata", JSON.stringify({ ci: preset }));
      const sub = await fetch(`${base}/v1/jobs`, { method: "POST", headers: auth, body: form });
      const job = await sub.json();
      if (sub.status !== 202)
        throw new Error(`${preset}: submit answered ${sub.status} ${JSON.stringify(job)}`);

      // 1. The long-poll, then the result route.
      let state = job;
      for (let i = 0; i < 5 && (state.status === "queued" || state.status === "running"); i++) {
        state = await get(`/v1/jobs/${job.id}?wait=60`);
      }
      if (state.status !== "done") throw new Error(`${preset}: job ended ${JSON.stringify(state)}`);
      const polled = await get(`/v1/jobs/${job.id}/result`);

      // 2. The event feed, from the cursor the previous preset left.
      // biome-ignore lint/suspicious/noExplicitAny: events are read field by field.
      let event: any = null;
      for (let i = 0; i < 10 && !event; i++) {
        const page = await get(`/v1/events?after=${cursor}&wait=10`);
        event = (page.events ?? []).find(
          (e: { type: string; data?: { job_id?: string } }) =>
            e.type === "transcription.completed" && e.data?.job_id === job.id,
        );
        cursor = page.cursor ?? cursor;
      }
      if (!event) throw new Error(`${preset}: no transcription.completed event for ${job.id}`);

      // 3. The webhook.
      const deadline = performance.now() + 60_000;
      let hook: Delivery | undefined;
      while (!hook && performance.now() < deadline) {
        hook = receiver.deliveries.find((d) => d.body?.data?.job_id === job.id);
        if (!hook) await Bun.sleep(250);
      }
      if (!hook) throw new Error(`${preset}: no signed webhook for ${job.id} within 60 s`);

      const a = JSON.stringify(projection(polled));
      const b = JSON.stringify(projection(event.data));
      const c = JSON.stringify(projection(hook.body.data));
      if (a !== b || a !== c) {
        throw new Error(
          `${preset}: the three paths disagree\npoll:  ${a}\nfeed:  ${b}\nhook:  ${c}`,
        );
      }
      const heard = String(polled.text)
        .toLowerCase()
        .replace(/[^a-z ]/g, "");
      if (!heard.includes("ask not what your country")) {
        throw new Error(`${preset}: wrong transcript: ${polled.text}`);
      }
      if (JSON.stringify(polled.metadata) !== JSON.stringify({ ci: preset })) {
        throw new Error(`${preset}: metadata not echoed: ${JSON.stringify(polled.metadata)}`);
      }
      console.log(`${preset}: poll, feed and webhook agree: ${polled.text}`);
    }
    const first = receiver.deliveries[0] as Delivery;
    if (!(await tamperedRefused(receiver, first))) {
      throw new Error("the receiver accepted a delivery whose body was changed");
    }
    console.log("positive control: a tampered delivery was refused");
  } finally {
    receiver.stop();
  }
}

if (import.meta.main) await main();
