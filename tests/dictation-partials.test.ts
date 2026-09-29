/**
 * DC-E5 (docs/ux/DICTATION.md): while a session listens and a follower asks for them, the end of
 * its audio is decoded again on the preview engine and each answer goes out as a partial; the insert
 * carries the whole-buffer decode, never a partial. The pill's language chip (akou-5v8) forces a
 * language for the session listening, and the decode at the release asks for it.
 *
 * The session is driven message by message, as the helper would drive it, with packets of a flat
 * signal as the mic: no device, no key, no clipboard, no model.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Decoded } from "../src/main/asr/live-worker.ts";
import { CAPTURE_RATE, type Packet } from "../src/main/capture/protocol.ts";
import type { AppToHelper } from "../src/main/dictation/protocol.ts";
import { DictationService } from "../src/main/dictation/service.ts";
import {
  type DictationEngine,
  DictationSession,
  PREVIEW_EVERY_SECONDS,
  PREVIEW_TAIL_SECONDS,
  type PreviewDecode,
  type PreviewPartial,
} from "../src/main/dictation/session.ts";
import { DictationLog } from "../src/main/dictation/store.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const TARGET = { app: "com.example.editor", pid: 1, window: "w1", field: "editable" } as const;
const FINAL = "the words decoded whole";

const decoded = (text: string, language: string | null = "en"): Decoded => ({
  text,
  words: [],
  language,
  model: "stub",
  ms: 1,
  spans: 1,
});

/**
 * A session over a stub engine that answers `FINAL` for the whole buffer, and a preview decoder that
 * answers each call with its own words, so no partial can be mistaken for the final. `gate` holds
 * the preview's answers until it resolves.
 */
function rig(
  o: {
    preview?: boolean;
    gate?: Promise<void>;
    secure?: boolean;
    remote?: boolean;
    /** `dictation.language`. */
    language?: string;
  } = {},
) {
  const t = tempDir("akou-dict-partials-");
  cleanups.push(t.cleanup);
  const log = new DictationLog(t.dir);
  cleanups.push(() => log.close());
  const sent: AppToHelper[] = [];
  const partials: PreviewPartial[] = [];
  const previews: number[] = [];
  const asked: (string | undefined)[] = [];
  /** The request a `remote` engine opened at the press (DC-R6): what happened to it. */
  const hold = { opened: 0, decoded: 0, cancelled: 0 };
  const engine: DictationEngine = {
    name: o.remote ? "remote" : "best",
    decode: async (_s, r) => {
      asked.push(r.language);
      return decoded(FINAL);
    },
    ...(o.remote
      ? {
          open: () => {
            hold.opened++;
            return {
              push: () => {},
              decode: async () => {
                hold.decoded++;
                return decoded(FINAL);
              },
              cancel: () => {
                hold.cancelled++;
              },
            };
          },
        }
      : {}),
  };
  const preview: PreviewDecode = async (samples) => {
    previews.push(samples.length);
    await o.gate;
    return decoded(` partial ${previews.length} `, "es");
  };
  const s = new DictationSession({
    log,
    engine: () => engine,
    send: (c) => sent.push(c),
    bindings: () => ({
      hotkey: "RightCommand",
      draft: "",
      fixLast: "",
      pasteLast: "",
      activation: "hold-or-toggle",
    }),
    now: () => Date.now(),
    preview: () => (o.preview === false ? null : preview),
    onPartial: (p) => partials.push(p),
    language: () => o.language,
  });
  s.onMessage({
    type: "ready",
    protocol: "akou-dictate/1",
    version: "1",
    grants: { mic: "granted", accessibility: "granted" },
    backend: "fake",
    swallow_keys: true,
  });
  s.onMessage({
    type: "session.started",
    id: "1",
    target: o.secure ? { ...TARGET, field: "secure" } : TARGET,
    capture_ns: "0",
  });
  let n = 0;
  /** `seconds` of audio in packets of 100 ms, the preview answering between them. */
  const feed = async (seconds: number) => {
    for (let i = 0; i < seconds * 10; i++) {
      const p: Packet = {
        ch: "mic",
        zeroFilled: false,
        captureNs: 0n,
        fileSeconds: n++ / 10,
        samples: new Float32Array(CAPTURE_RATE / 10).fill(0.1),
      };
      s.onPacket(p);
      await new Promise((res) => setTimeout(res, 0));
    }
  };
  const release = async () => {
    s.onMessage({ type: "session.ended", id: "1", reason: "release" });
    await until(() => sent.some((c) => c.type === "insert"), 5000, "the insert");
  };
  const insert = () => sent.find((c) => c.type === "insert");
  return { s, log, partials, previews, asked, hold, feed, release, insert };
}

describe("DC-E5: partials while listening, the whole decode inserted", () => {
  test("partials that differ from the final come every half second; the insert is the final", async () => {
    const r = rig();
    await r.feed(2);
    // One decode for each half second of audio, of the audio so far.
    expect(r.previews).toEqual([0.5, 1, 1.5, 2].map((s) => s * CAPTURE_RATE));
    expect(r.partials).toEqual([1, 2, 3, 4].map((i) => ({ text: `partial ${i}`, language: "es" })));
    await r.release();
    // The insert and the log carry the decode of the whole buffer, never a partial.
    expect(r.insert()).toMatchObject({ text: FINAL });
    expect(r.log.items()[0]).toMatchObject({ text: FINAL, raw: FINAL });
  });

  test("a long dictation decodes only its last PREVIEW_TAIL_SECONDS for the preview", async () => {
    const r = rig();
    await r.feed(PREVIEW_TAIL_SECONDS + 2);
    expect(Math.max(...r.previews)).toBe(PREVIEW_TAIL_SECONDS * CAPTURE_RATE);
    expect(r.previews).toHaveLength((PREVIEW_TAIL_SECONDS + 2) / PREVIEW_EVERY_SECONDS);
  });

  test("with no preview decoder, no partial", async () => {
    const r = rig({ preview: false });
    await r.feed(2);
    expect(r.partials).toEqual([]);
    await r.release();
    expect(r.insert()).toMatchObject({ text: FINAL });
  });

  test("one decode at a time, and one answered after listening ended is dropped", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((res) => {
      open = res;
    });
    const r = rig({ gate });
    await r.feed(2);
    expect(r.previews).toHaveLength(1);
    await r.release();
    open();
    await gate;
    await new Promise((res) => setTimeout(res, 10));
    expect(r.partials).toEqual([]);
  });

  test("a password field's session has no partials (DC-N8)", async () => {
    const r = rig({ secure: true });
    await r.feed(2);
    expect(r.previews).toEqual([]);
    expect(r.partials).toEqual([]);
  });
});

describe("akou-5v8: the language the chip forces for the session", () => {
  test("setLanguage while listening reaches the decode at the release", async () => {
    const r = rig();
    await r.feed(1);
    expect(r.s.setLanguage("es")).toBe(true);
    await r.feed(1);
    await r.release();
    expect(r.asked).toEqual(["es"]);
    expect(r.log.items()[0]).toMatchObject({ language_forced: true });
    // Nothing listens now: the chip has no session to force.
    expect(r.s.setLanguage("en")).toBe(false);
  });

  test("on remote, a language chosen on the chip drops the request opened at the press", async () => {
    const r = rig({ remote: true });
    await r.feed(1);
    expect(r.s.setLanguage("es")).toBe(true);
    await r.feed(1);
    await r.release();
    // That request asked for the language of the press: it is cancelled, never decoded, and the
    // whole buffer goes with the chosen language.
    expect(r.hold).toEqual({ opened: 1, decoded: 0, cancelled: 1 });
    expect(r.asked).toEqual(["es"]);
    expect(r.insert()).toMatchObject({ text: FINAL });
  });

  test("on remote, the chip landing on the language of the press keeps that request", async () => {
    const r = rig({ remote: true, language: "es" });
    await r.feed(1);
    expect(r.s.setLanguage("es")).toBe(true);
    await r.feed(1);
    await r.release();
    expect(r.hold).toEqual({ opened: 1, decoded: 1, cancelled: 0 });
    expect(r.asked).toEqual([]);
  });

  test("positive control: on remote without the chip, the request opened at the press answers", async () => {
    const r = rig({ remote: true });
    await r.feed(1);
    await r.release();
    expect(r.hold).toEqual({ opened: 1, decoded: 1, cancelled: 0 });
    expect(r.asked).toEqual([]);
  });

  test("positive control: without the chip, the decode asks for no language", async () => {
    const r = rig();
    await r.feed(1);
    await r.release();
    expect(r.asked).toEqual([undefined]);
  });
});

describe("the service's side", () => {
  function service(o: { engine?: string; languages?: string[]; language?: string } = {}) {
    const t = tempDir("akou-dict-partials-svc-");
    cleanups.push(t.cleanup);
    const fast: DictationEngine = { name: "fast", decode: async () => decoded("x") };
    const svc = new DictationService({
      configDir: t.dir,
      now: () => Date.now(),
      engine: (name) => (name === "fast" ? fast : { ...fast, name: o.engine ?? "best" }),
      languages: () => o.languages ?? ["en", "es"],
      language: () => o.language,
    });
    cleanups.push(() => svc.close());
    // The decoder the session asks for before each partial.
    const decoder = () =>
      (svc as unknown as { previewDecode(): PreviewDecode | null }).previewDecode();
    return { svc, decoder };
  }

  test("partials are decoded only while a follower asks for them, on the fast engine", async () => {
    const { svc, decoder } = service();
    expect(decoder()).toBeNull();
    const plain = svc.follow(() => {});
    expect(decoder()).toBeNull();
    let wants = true;
    const pill = svc.follow(() => {}, { partials: () => wants });
    expect(await decoder()?.(new Float32Array(10))).toMatchObject({ text: "x" });
    wants = false;
    expect(decoder()).toBeNull();
    wants = true;
    pill();
    expect(decoder()).toBeNull();
    plain();
  });

  test("the chip can switch with two languages on an engine that takes one", () => {
    expect(service().svc.languageChoice()).toEqual({
      languages: ["en", "es"],
      switchable: true,
      language: null,
      chosen: null,
    });
    // The chip starts on dictation.language when it is set.
    expect(service({ language: "es" }).svc.languageChoice().language).toBe("es");
    expect(service({ engine: "fast" }).svc.languageChoice().switchable).toBe(false);
    expect(service({ languages: ["en"] }).svc.languageChoice().switchable).toBe(false);
    // No helper runs, so no session listens for the chip to force.
    expect(service().svc.setLanguage("es")).toBe(false);
  });
});
