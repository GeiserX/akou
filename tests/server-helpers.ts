/**
 * Test support for server mode over HTTP: keys in the rig's key file, a job submitted the way a
 * client does it (multipart, a bearer key), and a request as a key. `tests/jobs.e2e.test.ts`
 * keeps its own copies; the web UI's and the server defaults' tests share these.
 */

import { z } from "zod";
import { KeyStore } from "../src/main/api/keys.ts";
import type { AppRig } from "./api-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav, RATE } from "./fixtures/audio.ts";

export const SERVER = { "server.enabled": true, "api.bind": "127.0.0.1" } as const;

/** A mono clip of `seconds` with the words spoken near its start. */
export function clip(words: string[], seconds: number): Uint8Array {
  const speech = concat(silence(0.4), speak(words));
  return monoWav(concat(speech, silence(Math.max(0, seconds - speech.length / RATE))));
}

export interface Key {
  id: string;
  key: string;
  secret: string;
}

export interface Answer {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: bodies are inspected field by field.
  body: any;
  text: string;
  headers: Headers;
}

/**
 * A key written into the rig's `keys.json` through the `KeyStore` that `akou keys create` uses.
 * Not through the CLI itself: the UI tests import this, and their type check (the DOM library)
 * must not reach the CLI's modules.
 */
export async function newKey(
  rig: AppRig,
  name: string,
  scope: "jobs" | "admin" = "jobs",
  hosts: string[] = [],
): Promise<Key> {
  return new KeyStore(rig.app.configDir).create({ name, scope, callbackHosts: hosts });
}

async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text, headers: res.headers };
}

/** `POST /v1/jobs` as a client sends it: multipart, the key as a bearer. */
export async function submit(
  rig: AppRig,
  key: string,
  file: Uint8Array,
  fields: Record<string, string> = {},
): Promise<Answer> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file)], { type: "audio/wav" }), "note.wav");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1/jobs`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  return answer(res);
}

/** One JSON request as a key. */
export async function asKey(
  rig: AppRig,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${rig.port}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  return answer(res);
}

/** The result of SV-J4, as a schema: no field missing, none extra. */
export const RESULT = z
  .object({
    job_id: z.string().startsWith("job_"),
    status: z.literal("done"),
    text: z.string(),
    language: z.string().nullable(),
    language_confidence: z.number().nullable(),
    duration_s: z.number().nonnegative(),
    words: z.array(
      z
        .object({
          w: z.string(),
          s: z.number().nullable(),
          e: z.number().nullable(),
          c: z.number().min(0).max(1).nullable(),
        })
        .strict(),
    ),
    segments: z.array(
      z
        .object({ s: z.number(), e: z.number(), text: z.string(), speaker: z.string().nullable() })
        .strict(),
    ),
    engine: z
      .object({
        name: z.literal("akou"),
        version: z.string(),
        preset: z.string(),
        models: z.array(z.string()).min(1),
      })
      .strict(),
    confidence: z.number().min(0).max(1).nullable(),
    skipped: z.array(z.object({ s: z.number(), e: z.number(), reason: z.string() }).strict()),
    speakers: z
      .object({ asked: z.boolean(), labelled: z.boolean(), error: z.string().nullable() })
      .strict(),
    warnings: z.array(z.string()),
    metadata: z.unknown(),
  })
  .strict();
