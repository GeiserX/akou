/**
 * The live door of server mode (`GET /v1/live`, docs/server.md "A phone or another live client"):
 * a client streams audio over a WebSocket and gets the streaming model's words back as it speaks.
 * It is a door onto what the desktop's dictation already runs: `LiveAsr.openDictation` on the live
 * Worker, one stream per socket. Nothing of a live session is kept: the client's own recording is
 * the recording of record, and its upload as a job is the transcript of record.
 *
 * The protocol, one socket:
 * - Text frames are JSON control messages. The client sends `hello` first:
 *   `{type: "hello", v: 1, codec: "ogg-opus" | "pcm16", language, model}`; the server answers
 *   `ready` `{engine, lang, tier_ms, load_ms}` once the stream opened. Then `words`
 *   `{tokens: [{text, t, conf}]}` as the engine gives them, append-only, never taken back. The
 *   client sends `stop`; the server sends the last words, then `closed`, and closes with 1000.
 * - Binary frames are audio. With `ogg-opus`, exactly one Ogg page each, the OpusHead page first,
 *   then OpusTags, then audio pages in order. With `pcm16` (test clients, measurements), raw 16 kHz
 *   16-bit little-endian mono samples.
 * - A token's `t` is seconds into the recording: with `ogg-opus` the first audio page's granule
 *   places the session on the recording's timeline (a reconnect that starts mid-file included);
 *   with `pcm16` it counts from the session's first sample.
 * - A refusal is an `error` `{code, message}` frame, then a close: 4400 for a message or page that
 *   is not valid (`bad_message`, `bad_page`, `unknown_model`, `unsupported_language`) or audio
 *   sent more than `MAX_IN_FLIGHT_SECONDS` ahead of the engine (`too_fast`), 4401 when
 *   the key was revoked, 4409 `engine_busy` when another open session runs another engine (the
 *   Worker holds one streaming engine at a time), 4500 `stream_lost`, 4503 `no_live_engine`.
 */

// A type only: the WASM decoder loads at a session's first OpusHead page (`OggOpusIn`), so the
// desktop app and the CLI never load it. A static value import also breaks `bun build --compile`:
// the package says `sideEffects: false`, the bundler drops its Worker class and keeps a line of
// its index that names it, and the compiled CLI throws at start.
import type { OpusDecoder } from "opus-decoder";
import type { Identity } from "../api/access.ts";
import type { SocketHandler } from "../api/http.ts";
import type { LiveToken } from "../asr/engine.ts";
import {
  chooseLiveEngine,
  engineForLanguages,
  isLiveEngine,
  LIVE_ENGINE_IDS,
  LIVE_ENGINES,
  type LiveChoice,
  type LiveEngineId,
} from "../asr/live-engines.ts";
import type { DictationStream } from "../asr/live-worker.ts";
import {
  isOpusTags,
  type OggError,
  type OpusHead,
  opusHead,
  opusSamples48k,
  readOggPage,
} from "./ogg.ts";

/** The protocol's version, `hello.v`. */
export const LIVE_PROTOCOL = 1;
export const LIVE_CODECS = ["ogg-opus", "pcm16"] as const;
export type LiveCodec = (typeof LIVE_CODECS)[number];
const RATE = 16_000 as const;
const LANGUAGE = /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;
/** How often a session checks that its key still exists: on a timer, and at most this often per message. */
const KEY_CHECK_MS = 1_000;
/**
 * The most audio a session may have sent that the engine has not decoded yet, seconds. A client
 * sending faster than the engine decodes is closed with 4400 `too_fast` past it, so its frames
 * never pile up in memory: a client that records sends in real time and stays far below it.
 */
export const MAX_IN_FLIGHT_SECONDS = 30;

/** Each refusal's close code. */
export const CLOSE_CODES = {
  bad_message: 4400,
  bad_page: 4400,
  too_fast: 4400,
  unknown_model: 4400,
  unsupported_language: 4400,
  key_revoked: 4401,
  engine_busy: 4409,
  stream_lost: 4500,
  no_live_engine: 4503,
} as const;
export type LiveErrorCode = keyof typeof CLOSE_CODES;

export class LiveRefused extends Error {
  override name = "LiveRefused";
  constructor(
    readonly code: LiveErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the door needs of the app. */
export interface LiveDeps {
  /** Whether a streaming engine's model files are on disk. */
  present(id: LiveEngineId): boolean;
  /** A stream on the live Worker (`LiveAsr.openDictation`). */
  open(
    choice: LiveChoice,
    languages: readonly string[],
    onWords: (tokens: LiveToken[]) => void,
  ): DictationStream;
  /** Whether the key a session was opened with still exists. */
  keyAlive(who: Identity): boolean;
  log(level: "info" | "warn", msg: string): void;
  /** For tests: a clock for the key check. */
  now?(): number;
}

/** The socket a session talks through: Bun's `ServerWebSocket`, or a test's stand-in. */
export type LiveSocket = Parameters<SocketHandler["opened"]>[0];

/** The engines and the open sessions of one server. */
export class LiveService {
  /** Each open session's engine: the Worker holds one streaming engine at a time. */
  private readonly sessions = new Map<LiveSession, string>();

  constructor(private readonly deps: LiveDeps) {}

  /** The streaming engines on disk, in the catalog's order. */
  enginesOnDisk(): LiveEngineId[] {
    return LIVE_ENGINE_IDS.filter((id) => this.deps.present(id));
  }

  /** The engine and stream language a `hello` asks for, among the engines on disk. */
  resolve(language: string, model: string): { choice: LiveChoice; languages: string[] } {
    if (!LANGUAGE.test(language)) {
      throw new LiveRefused("bad_message", `language "${language}" is not auto or a BCP 47 tag`);
    }
    const primary = language.split("-")[0]?.toLowerCase() ?? "auto";
    const languages = primary === "auto" ? [] : [primary];
    const heard = LIVE_ENGINE_IDS.some((id) =>
      (LIVE_ENGINES[id].languages as readonly string[]).includes(primary),
    );
    if (languages.length > 0 && !heard) {
      throw new LiveRefused(
        "unsupported_language",
        `no streaming engine hears ${primary}; send language "auto"`,
      );
    }
    if (model !== "auto" && !isLiveEngine(model)) {
      throw new LiveRefused(
        "unknown_model",
        `model "${model}" is not a streaming engine; send auto or one of ${LIVE_ENGINE_IDS.join(", ")}`,
      );
    }
    const { choice } = chooseLiveEngine(model, languages, (id) => this.deps.present(id));
    if (!choice) {
      const wanted = isLiveEngine(model) ? model : engineForLanguages(languages);
      throw new LiveRefused(
        "no_live_engine",
        `the streaming model ${wanted} is not on this server; \`akou models pull ${wanted}\` fetches it`,
      );
    }
    return { choice, languages };
  }

  /** A new session for an upgraded socket, as the key `who`. */
  session(who: Identity): LiveSession {
    return new LiveSession(this, this.deps, who);
  }

  /** Takes the engine for a session, or refuses when an open session runs another one. */
  claim(s: LiveSession, engine: string): void {
    for (const [other, e] of this.sessions) {
      if (other !== s && e !== engine) {
        throw new LiveRefused(
          "engine_busy",
          `another live session runs ${e}, and the server holds one streaming engine at a time; ask for ${e} or auto with its language, or retry when it ends`,
        );
      }
    }
    this.sessions.set(s, engine);
  }

  release(s: LiveSession): void {
    this.sessions.delete(s);
  }

  /** The open sessions, for `GET /v1/server` and the tests. */
  open(): number {
    return this.sessions.size;
  }
}

/** One codec's audio in: a binary frame to 16 kHz samples, and where they sit in the recording. */
interface AudioIn {
  /** Samples of this frame, possibly none (a header page). */
  push(frame: Uint8Array): Promise<Float32Array>;
  /** Seconds into the recording of the first sample pushed; null before the first audio. */
  readonly offset: number | null;
  close(): void;
}

class Pcm16In implements AudioIn {
  readonly offset = 0;
  async push(frame: Uint8Array): Promise<Float32Array> {
    if (frame.length % 2 !== 0) throw new LiveRefused("bad_page", "pcm16 frames are whole samples");
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const out = new Float32Array(frame.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  }
  close(): void {}
}

/**
 * Ogg Opus in, one page per frame: OpusHead, OpusTags, then audio pages in sequence. Packets are
 * decoded at 16 kHz with libopus (WASM), page by page, as they arrive.
 */
export class OggOpusIn implements AudioIn {
  private serial: number | null = null;
  private head: OpusHead | null = null;
  private tags = false;
  private lastSeq: number | null = null;
  private lastGranule: bigint | null = null;
  /** The pieces of a packet that goes on onto the next page. */
  private partial: Uint8Array[] | null = null;
  private decoder: OpusDecoder<16000> | null = null;
  /** 16 kHz samples still to drop: the pre-skip, at the start of a recording only. */
  private drop = 0;
  offset: number | null = null;

  async push(frame: Uint8Array): Promise<Float32Array> {
    let page: ReturnType<typeof readOggPage>;
    try {
      page = readOggPage(frame);
    } catch (err) {
      throw new LiveRefused("bad_page", (err as Error).message);
    }
    if (this.serial === null) {
      if (!page.bos) throw new LiveRefused("bad_page", "the first page must be the OpusHead page");
      this.serial = page.serial;
    } else if (page.serial !== this.serial) {
      throw new LiveRefused("bad_page", "the page belongs to another Ogg stream (its serial)");
    }
    if (this.head && page.bos) {
      throw new LiveRefused(
        "bad_page",
        "an OpusHead page after the stream began: open a new socket",
      );
    }
    if (!this.head) {
      const head = page.packets[0] ? this.readHead(page.packets[0]) : null;
      if (!head) throw new LiveRefused("bad_page", "the first page holds no OpusHead");
      this.head = head;
      const { OpusDecoder: Decoder } = await import("opus-decoder");
      this.decoder = new Decoder({ sampleRate: RATE, channels: 1, preSkip: 0 });
      await this.decoder.ready;
      return new Float32Array(0);
    }
    if (!this.tags) {
      if (!page.continued && !(page.packets[0] && isOpusTags(page.packets[0]))) {
        throw new LiveRefused("bad_page", "the second page must be the OpusTags page");
      }
      // The comment header may span pages; audio starts on the page after it ends.
      if (!page.open) this.tags = true;
      return new Float32Array(0);
    }
    if (this.lastSeq !== null && page.seq !== this.lastSeq + 1) {
      throw new LiveRefused("bad_page", `page ${page.seq} follows page ${this.lastSeq}`);
    }
    this.lastSeq = page.seq;
    // -1: no packet ends on this page. Any other granule only ever grows (RFC 7845).
    if (page.granule >= 0n) {
      if (this.lastGranule !== null && page.granule < this.lastGranule) {
        throw new LiveRefused(
          "bad_page",
          `page ${page.seq}'s granule ${page.granule} is before the last page's ${this.lastGranule}`,
        );
      }
      this.lastGranule = page.granule;
    }
    const done = this.packets(page);
    if (this.offset === null) {
      if (done.length === 0) return new Float32Array(0);
      // The first decoded packet's place in the recording, from the page's granule (RFC 7845):
      // a recording's first page starts inside the pre-skip, which is dropped; a reconnect's first
      // page starts later and keeps everything.
      const length = done.reduce((n, p) => n + opusSamples48k(p), 0);
      const start = Number(page.granule) - length - (this.head as OpusHead).preSkip;
      this.drop = start < 0 ? Math.round(-start / 3) : 0;
      this.offset = Math.max(0, start) / 48_000;
    }
    return this.decode(done);
  }

  private readHead(packet: Uint8Array): OpusHead {
    let head: OpusHead;
    try {
      head = opusHead(packet);
    } catch (err) {
      throw new LiveRefused("bad_page", (err as OggError).message);
    }
    if (head.channels !== 1) {
      throw new LiveRefused("bad_page", `the stream has ${head.channels} channels; send mono`);
    }
    return head;
  }

  /** The packets that end on this page, a packet begun before this session dropped. */
  private packets(page: ReturnType<typeof readOggPage>): Uint8Array[] {
    const done: Uint8Array[] = [];
    page.packets.forEach((piece, i) => {
      const endsHere = !(i === page.packets.length - 1 && page.open);
      if (i === 0 && page.continued) {
        // The rest of a packet this session never saw the start of: nothing to decode.
        if (this.partial === null) return;
        this.partial.push(piece);
      } else this.partial = [piece];
      if (endsHere) {
        done.push(Buffer.concat(this.partial));
        this.partial = null;
      }
    });
    return done;
  }

  private decode(packets: Uint8Array[]): Float32Array {
    const decoder = this.decoder as OpusDecoder<16000>;
    const parts: Float32Array[] = [];
    for (const p of packets) {
      const r = decoder.decodeFrame(p);
      if (r.errors.length > 0) {
        throw new LiveRefused("bad_page", `an Opus packet did not decode: ${r.errors[0]?.message}`);
      }
      const x = (r.channelData[0] ?? new Float32Array(0)).subarray(0, r.samplesDecoded);
      const cut = Math.min(this.drop, x.length);
      this.drop -= cut;
      if (cut < x.length) parts.push(x.slice(cut));
    }
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  close(): void {
    this.decoder?.free();
    this.decoder = null;
  }
}

/** The fields a `hello` may carry. */
const HELLO_FIELDS = new Set(["type", "v", "codec", "language", "model"]);

/** One socket's session: its `hello`, its stream, its audio and its words. */
export class LiveSession implements SocketHandler {
  private socket: LiveSocket | null = null;
  private input: AudioIn | null = null;
  private stream: DictationStream | null = null;
  /** Messages are handled one at a time, in order: a page's decode may wait for the decoder. */
  private queue: Promise<void> = Promise.resolve();
  private ended = false;
  private keyCheckedAt = Number.NEGATIVE_INFINITY;
  private keyTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly service: LiveService,
    private readonly deps: LiveDeps,
    readonly who: Identity,
  ) {}

  opened(socket: LiveSocket): void {
    this.socket = socket;
    // clock: a revoked key closes a quiet session too, not only at its next message.
    this.keyTimer = setInterval(() => {
      try {
        this.checkKey(true);
      } catch (err) {
        this.fail(err);
      }
    }, KEY_CHECK_MS);
  }

  /** A message from the client, text or binary. */
  message(data: string | Uint8Array): void {
    this.queue = this.queue
      .then(() => (this.ended ? undefined : this.handle(data)))
      .catch((err) => this.fail(err));
  }

  /** The socket closed, from either side. */
  closed(): void {
    this.end();
    this.stream?.cancel();
  }

  private async handle(data: string | Uint8Array): Promise<void> {
    this.checkKey();
    if (typeof data === "string") return this.control(data);
    if (!this.input) throw new LiveRefused("bad_message", "send hello before any audio");
    const samples = await this.input.push(data);
    if (samples.length > 0) this.stream?.push(samples);
    const behind = (this.stream?.pending?.() ?? 0) / RATE;
    if (behind > MAX_IN_FLIGHT_SECONDS) {
      throw new LiveRefused(
        "too_fast",
        `${Math.round(behind)} s of audio are waiting for the engine, past the ${MAX_IN_FLIGHT_SECONDS} s limit; send at the pace you record`,
      );
    }
  }

  private async control(text: string): Promise<void> {
    let m: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      m = parsed;
    } catch {
      throw new LiveRefused("bad_message", "a text frame is one JSON object");
    }
    if (m.type === "hello") return this.hello(m);
    if (m.type === "stop") return this.stop();
    throw new LiveRefused("bad_message", `unknown message type ${JSON.stringify(m.type)}`);
  }

  private async hello(m: Record<string, unknown>): Promise<void> {
    if (this.input) throw new LiveRefused("bad_message", "hello was already sent");
    for (const k of Object.keys(m)) {
      if (!HELLO_FIELDS.has(k)) throw new LiveRefused("bad_message", `unknown field "${k}"`);
    }
    if (m.v !== LIVE_PROTOCOL) {
      throw new LiveRefused("bad_message", `v must be ${LIVE_PROTOCOL}, the protocol's version`);
    }
    if (!(LIVE_CODECS as readonly unknown[]).includes(m.codec)) {
      throw new LiveRefused("bad_message", `codec is one of ${LIVE_CODECS.join(", ")}`);
    }
    for (const k of ["language", "model"] as const) {
      if (m[k] !== undefined && typeof m[k] !== "string") {
        throw new LiveRefused("bad_message", `${k} is a string`);
      }
    }
    // The engine is resolved and claimed before the stream opens: the Worker would replace the
    // engine under another open session that runs a different one.
    const { choice, languages } = this.service.resolve(
      (m.language as string | undefined) ?? "auto",
      (m.model as string | undefined) ?? "auto",
    );
    this.service.claim(this, choice.engine);
    this.input = m.codec === "pcm16" ? new Pcm16In() : new OggOpusIn();
    const stream = this.deps.open(choice, languages, (tokens) => this.words(tokens));
    this.stream = stream;
    void stream.lost.then((err) => this.fail(new LiveRefused("stream_lost", err.message)));
    let opened: LiveChoice & { ms: number };
    try {
      opened = await stream.opened;
    } catch (err) {
      throw new LiveRefused("no_live_engine", (err as Error).message);
    }
    this.deps.log("info", `live: session as key ${this.who.id} on ${opened.engine}`);
    this.send({
      type: "ready",
      engine: opened.engine,
      lang: opened.lang,
      tier_ms: isLiveEngine(opened.engine) ? LIVE_ENGINES[opened.engine].tierMs : null,
      load_ms: opened.ms,
    });
  }

  private words(tokens: LiveToken[]): void {
    if (this.ended || tokens.length === 0) return;
    const offset = this.input?.offset ?? 0;
    this.send({
      type: "words",
      tokens: tokens.map((t) => ({
        text: t.text,
        t: Math.round((t.t + offset) * 1000) / 1000,
        conf: Math.round(t.conf * 1000) / 1000,
      })),
    });
  }

  private async stop(): Promise<void> {
    if (!this.stream) throw new LiveRefused("bad_message", "send hello before stop");
    // The last words come through `words` before `finish` resolves.
    await this.stream.finish();
    this.send({ type: "closed" });
    this.end();
    this.socket?.close(1000, "stop");
  }

  /** A revoked key's session ends at its next message, checked at most once a second. */
  private checkKey(force = false): void {
    const now = this.deps.now?.() ?? performance.now();
    if (!force && now - this.keyCheckedAt < KEY_CHECK_MS) return;
    this.keyCheckedAt = now;
    if (!this.deps.keyAlive(this.who)) {
      throw new LiveRefused("key_revoked", "the key this session was opened with was revoked");
    }
  }

  private fail(err: unknown): void {
    if (this.ended) return;
    const r =
      err instanceof LiveRefused
        ? err
        : new LiveRefused("stream_lost", (err as Error)?.message ?? String(err));
    if (!(err instanceof LiveRefused)) this.deps.log("warn", `live: ${r.message}`);
    this.send({ type: "error", code: r.code, message: r.message });
    this.end();
    this.stream?.cancel();
    this.socket?.close(CLOSE_CODES[r.code], r.code);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.keyTimer !== null) clearInterval(this.keyTimer);
    this.keyTimer = null;
    this.service.release(this);
    this.input?.close();
  }

  private send(m: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(m));
    } catch {
      // A socket that went away is closed through `closed`.
    }
  }
}
