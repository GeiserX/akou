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
 *
 * Then the dictation trip (docs/ux/DICTATION.md DC-R1, DC-R2, DC-R4): the same note sent the way
 * the desktop app's remote engine sends a dictation, by the app's own client code, after the app's
 * Test of the remote. It must run in the dictation lane: `served_last_hour` rises by one for it and
 * not for a plain request of the same note, which is the control that the lane is what answered.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { testRemote, transcribeRemote } from "../src/main/dictation/remote.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";

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

// biome-ignore lint/suspicious/noExplicitAny: API answers are read field by field.
type Json = any;

/** What the note says, as `plain` reads it. */
const HEARD = "ask not what your country";

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

/** Lower case letters and spaces only, for a transcript check that ignores punctuation. */
function plain(text: unknown): string {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z ]/g, "");
}

export interface DictationTrip {
  /** The server, as `dictation.remote.url` holds it. */
  base: string;
  /** A `jobs` key, as `dictation.remote.key` holds it. */
  key: string;
  /** Any audio file; it is read to 16 kHz mono as the app holds a dictation's buffer. */
  note: string;
  /** Words the transcript must contain, in lower case. */
  heard: string;
  /** `dictation.remote.timeoutSeconds`; the lane loads its model on its first dictation. */
  timeoutSeconds?: number;
  /** Test seam: the network. */
  fetch?: typeof fetch;
}

/**
 * The dictation trip: the Test, a plain request as the control, then the dictation. Returns the
 * lines to print; throws when the server has no lane, the transcript is wrong, or the dictation
 * was not the lane's.
 */
export async function dictationTrip(o: DictationTrip): Promise<string[]> {
  const net = o.fetch ?? fetch;
  const base = o.base.replace(/\/+$/, "");
  const lane = async () => {
    const res = await net(`${base}/v1/server`);
    if (!res.ok) throw new Error(`GET /v1/server: HTTP ${res.status}`);
    const s: Json = await res.json();
    return {
      served: Number(s.dictation?.served_last_hour),
      jobs: Number(s.queue?.jobs_last_hour),
    };
  };
  const tested = await testRemote({
    url: base,
    key: o.key,
    ...(o.timeoutSeconds ? { timeoutSeconds: o.timeoutSeconds } : {}),
    fetch: net,
  });
  if (!tested.ok || !tested.interactive || tested.warning) {
    throw new Error(`dictation: the Test of the remote says: ${tested.summary}`);
  }
  const samples = await readUploadAudio(o.note);
  const wav = new Blob([new Uint8Array(await Bun.file(o.note).arrayBuffer())]);

  // The control: the same note with no `interactive` is the queue's, and the lane does not count it.
  const before = await lane();
  const form = new FormData();
  form.set("file", wav, "note");
  const res = await net(`${base}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`dictation: the plain request answered ${res.status}`);
  const queued = await lane();
  if (queued.served !== before.served || queued.jobs !== before.jobs + 1) {
    throw new Error(
      `dictation: a plain request moved the lane (served ${before.served} -> ${queued.served}, queue jobs ${before.jobs} -> ${queued.jobs})`,
    );
  }

  const r = await transcribeRemote({
    url: base,
    key: o.key,
    samples,
    ...(o.timeoutSeconds ? { timeoutSeconds: o.timeoutSeconds } : {}),
    fetch: net,
  });
  if (!plain(r.text).includes(o.heard)) throw new Error(`dictation: wrong transcript: ${r.text}`);
  const after = await lane();
  if (after.served !== queued.served + 1 || after.jobs !== queued.jobs) {
    throw new Error(
      `dictation: the dictation did not run in the lane (served ${queued.served} -> ${after.served}, queue jobs ${queued.jobs} -> ${after.jobs})`,
    );
  }
  return [
    `dictation: the Test says ${tested.summary}`,
    `dictation: answered by the lane in ${r.ms} ms: ${r.text}`,
  ];
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

  const server: Json = await (await fetch(`${base}/v1/server`)).json();
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
      const job: Json = await sub.json();
      if (sub.status !== 202)
        throw new Error(`${preset}: submit answered ${sub.status} ${JSON.stringify(job)}`);

      // 1. The long-poll, then the result route.
      let state: Json = job;
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
      if (!plain(polled.text).includes(HEARD)) {
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
  for (const line of await dictationTrip({ base, key, note, heard: HEARD, timeoutSeconds: 120 })) {
    console.log(line);
  }
}

if (import.meta.main) await main();
