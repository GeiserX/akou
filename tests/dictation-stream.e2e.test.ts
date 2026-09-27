/**
 * Dictation through a whole app on its event stream and its silence guard (docs/ux/DICTATION.md
 * DC-G2, DC-E6): `GET /v1/dictation/stream` carries the log's events after a cursor, each once, and
 * the mic's level during a session, which is never stored; a clip of room noise comes back empty
 * even from an engine that invents on noise. The app runs the fake helper and the fake engine;
 * nothing opens a device, presses a key or touches the clipboard.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ApiResult, type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { concat, silence, speak } from "./fixtures/asr-fake.ts";
import { monoWav, roomNoise } from "./fixtures/audio.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const INVENTED = "thank you for watching";

function scratch(): string {
  const t = tempDir("akou-dict-stream-");
  cleanups.push(t.cleanup);
  return t.dir;
}

async function rig(o: Parameters<typeof appRig>[0] = {}): Promise<AppRig> {
  const r = await appRig(o);
  cleanups.push(() => r.close());
  return r;
}

async function upload(
  r: AppRig,
  samples: Float32Array,
): Promise<Pick<ApiResult, "status" | "body">> {
  const path = join(scratch(), "clip.wav");
  writeFileSync(path, monoWav(samples));
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path)]), "clip.wav");
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictations`, {
    method: "POST",
    headers: { authorization: `Bearer ${r.token}`, "x-akou-client": "test" },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

const HELLO = concat(silence(0.6), speak(["hello"]), silence(1));

interface Frame {
  id: string | null;
  event: string;
  data: Record<string, unknown>;
}

/** A follower of the dictation stream: every frame read so far, and a way to stop reading. */
function follow(r: AppRig, headers: Record<string, string> = {}, query = "") {
  const ac = new AbortController();
  const frames: Frame[] = [];
  let contentType = "";
  const reading = (async () => {
    const res = await fetch(`http://127.0.0.1:${r.port}/v1/dictation/stream${query}`, {
      headers: { authorization: `Bearer ${r.token}`, ...headers },
      signal: ac.signal,
    });
    contentType = res.headers.get("content-type") ?? "";
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += new TextDecoder().decode(value);
      const parts = text.split("\n\n");
      text = parts.pop() ?? "";
      for (const f of parts) {
        const event = /^event: (.+)$/m.exec(f)?.[1];
        const data = /^data: (.+)$/m.exec(f)?.[1];
        if (event && data)
          frames.push({ id: /^id: (.+)$/m.exec(f)?.[1] ?? null, event, data: JSON.parse(data) });
      }
    }
  })().catch(() => {});
  const stop = async () => {
    ac.abort();
    await reading;
  };
  cleanups.push(stop);
  return { frames, stop, contentType: () => contentType };
}

const events = (frames: Frame[]) => frames.filter((f) => f.event === "event");

describe("DC-G2: GET /v1/dictation/stream", () => {
  test("a follower gets each dictation's events live, and a reconnect with Last-Event-ID gets every later one once", async () => {
    const r = await rig();
    const first = follow(r);
    const a = await upload(r, HELLO);
    expect(a.body.text).toBe("hello");
    await until(() => events(first.frames).length === 3, 5000, "the first dictation's events");
    expect(first.contentType()).toContain("text/event-stream");
    expect(events(first.frames).map((f) => f.data.type)).toEqual([
      "dictation.started",
      "dictation.ended",
      "dictation.text",
    ]);
    expect(events(first.frames).every((f) => f.data.id === a.body.id)).toBe(true);
    // The id of each frame is the event's seq: the cursor a reconnect names.
    expect(events(first.frames).map((f) => Number(f.id))).toEqual([1, 2, 3]);
    await first.stop();

    // While nobody follows, another dictation is written.
    const b = await upload(r, HELLO);
    const again = follow(r, { "last-event-id": "2" });
    await until(() => events(again.frames).length === 4, 5000, "the backlog after the cursor");
    const seqs = events(again.frames).map((f) => Number(f.data.seq));
    expect(seqs).toEqual([3, 4, 5, 6]);
    expect(
      events(again.frames)
        .slice(1)
        .every((f) => f.data.id === b.body.id),
    ).toBe(true);
    // Then live again, with nothing repeated.
    await upload(r, HELLO);
    await until(() => events(again.frames).length === 7, 5000, "the live events");
    const all = events(again.frames).map((f) => Number(f.data.seq));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  test("?after works like Last-Event-ID, and a deleted dictation shows only its tombstone", async () => {
    const r = await rig();
    const a = await upload(r, HELLO);
    await upload(r, HELLO);
    expect((await r.api("DELETE", `/dictations/${a.body.id}`)).status).toBe(200);
    const s = follow(r, {}, "?after=0");
    await until(() => events(s.frames).length === 4, 5000, "the backlog");
    const of = events(s.frames).filter((f) => f.data.id === a.body.id);
    expect(of.map((f) => f.data.type)).toEqual(["dictation.deleted"]);
  });

  test("the mic's level reaches the stream during a session and is never written to the log", async () => {
    const dir = scratch();
    const wav = join(dir, "mic.wav");
    writeFileSync(wav, monoWav(concat(speak(["hello"]), silence(3))));
    const r = await rig({
      helperArgs: ["--wav", wav],
      settings: { "dictation.enabled": true },
    });
    await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
    const s = follow(r);
    expect((await r.api("POST", "/dictation/start")).status).toBe(200);
    // The fake's mic runs in real time from the start: let "hello" be spoken before the stop.
    await Bun.sleep(1000);
    expect((await r.api("POST", "/dictation/stop")).status).toBe(200);
    await until(() => s.frames.some((f) => f.event === "level"), 5000, "a level");
    const level = s.frames.find((f) => f.event === "level");
    expect(level?.id).toBeNull();
    expect(typeof level?.data.rms).toBe("number");
    await until(
      () => r.app.dictation()?.log.items()[0]?.state === "inserted",
      10_000,
      "the dictation",
    );
    const log = readFileSync(r.app.dictation()?.log.path as string, "utf8");
    expect(log).toContain("dictation.inserted");
    expect(log).not.toContain("level");
    expect(log).not.toContain("rms");
  }, 30_000);
});

describe("DC-E6: the silence guard through the app", () => {
  test("a 3 s noise clip on an engine that invents on noise comes back empty", async () => {
    const r = await rig({
      models: {
        kind: "module",
        path: join(import.meta.dir, "fixtures", "asr-fake.ts"),
        model: "fake-parakeet",
        options: { hallucinate: INVENTED },
      },
    });
    const noise = await upload(r, roomNoise(3));
    expect(noise.status).toBe(200);
    expect(noise.body).toMatchObject({ state: "empty", text: null, raw: null });
    // Positive control: the same app still transcribes speech.
    const hello = await upload(r, HELLO);
    expect(hello.body).toMatchObject({ state: "done", text: "hello" });
    const types = r.app
      .dictation()
      ?.log.events()
      .map((e) => e.type);
    expect(types).toContain("dictation.empty");
  });
});
