/**
 * Home Assistant's Wyoming protocol (docs/ux/SERVER.md SV-C2): a raw TCP listener on
 * `server.wyoming_port`, on when `server.wyoming` is, bound where the API binds. Wyoming has no key
 * and no TLS, so the port stays on the operator's network.
 *
 * - `describe` answers `info`: one ASR program `akou` with one model per built preset plus `auto`,
 *   each `installed` as `GET /v1/server` calls it available, `languages` from the engine catalog,
 *   `requires_external_vad: true` (Home Assistant finds the end of speech and sends `audio-stop`)
 *   and `supports_transcript_streaming: false`.
 * - `transcribe {language?, name?}` is kept for the utterance; `name` naming a preset or recognizer
 *   picks it, anything else is no opinion.
 * - `audio-start`, `audio-chunk`s, `audio-stop`: the chunks go into a WAV in the job service's
 *   upload folder as they arrive, then one `quiet` job runs it through the queue, as the OpenAI door
 *   does. A request that names nothing runs what a dictation runs (DC-R2): the dictation lane's
 *   engine while the lane has a slot, else the server's default. The answer is
 *   `transcript {text, language?}`, then akou closes the connection, as wyoming-faster-whisper does.
 * - A refusal is `error {text, code}` with akou's error code, then a close. A client that closes
 *   mid-stream leaves no job and no file. A connection with no event for `idleMs` while no job runs
 *   is closed.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FileSink, Socket, TCPSocketListener } from "bun";
import type { Identity } from "../api/access.ts";
import { HttpError } from "../api/http.ts";
import { chooseModel, laneAsk, queueFullError } from "../api/routes/jobs.ts";
import { namesModel } from "../api/routes/openai.ts";
import { modelState } from "../api/routes/server.ts";
import type { ApiApp } from "../api/server.ts";
import { MODELS, WHISPER_LANGUAGES } from "../asr/models.ts";
import type { LoadedConfig } from "../config/schema.ts";
import { streamingWavHeader } from "./audio.ts";
import type { JobService } from "./jobs.ts";
import { PRESET_NAMES, PRESETS } from "./presets.ts";
import { encode, FrameError, FrameReader, type WyomingEvent } from "./wyoming-frame.ts";

/** The caller a Wyoming job runs as: Wyoming has no key, so one stand-in key id for all of it. */
export const WYOMING_IDENTITY: Identity = {
  id: "wyoming",
  name: "wyoming",
  scopes: ["jobs"],
  callbackHosts: [],
};

/** Home Assistant's own pipeline bound (assist_pipeline/const.py), and the idle cut here. */
export const WYOMING_IDLE_MS = 300_000;

/**
 * A job's `language`, as `POST /v1/jobs` checks it (routes/jobs.ts `LANGUAGE`): `auto` or a
 * BCP-47-like tag of a 2-3 letter language.
 */
const WYOMING_LANGUAGE = /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;

const ATTRIBUTION = { name: "akou", url: "https://github.com/GeiserX/akou" };

export interface WyomingDeps {
  hostname: string;
  port: number;
  jobs: JobService;
  app: ApiApp;
  settings: () => LoadedConfig["settings"];
  log: (level: "info" | "warn" | "error", msg: string) => void;
  /** No event for this long while no job runs closes the connection. Default `WYOMING_IDLE_MS`. */
  idleMs?: number;
}

interface Upload {
  path: string;
  sink: FileSink;
  hasher: Bun.CryptoHasher;
  /** Payload bytes so far, the header not counted. */
  bytes: number;
}

interface Session {
  socket: Socket<Session>;
  reader: FrameReader;
  transcribe: { language?: string; name?: string };
  file: Upload | null;
  jobId: string | null;
  abort: AbortController;
  idle: ReturnType<typeof setTimeout> | null;
  /** Bytes the socket did not take yet; sent on `drain`. */
  out: Uint8Array[];
  /** Close once `out` is sent: after a transcript or an error. */
  ending: boolean;
  closed: boolean;
  /** Events are handled one after another, in arrival order. */
  chain: Promise<void>;
}

/** The languages of a catalog entry; `any` (a model that hears no words) is every Whisper code. */
function engineLanguages(id: string | undefined): string[] {
  const m = MODELS.find((x) => x.id === id);
  if (!m) return [];
  return [...(m.languages === "any" ? WHISPER_LANGUAGES : m.languages)];
}

/**
 * A built preset's languages: its first engine's catalog list, so `fast` has Parakeet's and `best`
 * and `fusion`, which lead with Qwen, have Qwen's.
 */
function presetLanguages(name: string): string[] {
  return engineLanguages(PRESETS.find((x) => x.name === name)?.engines[0]);
}

/** The `info` event (wyoming info.py:63-122): every field written, snake_case, null kept. */
export function info(d: Pick<WyomingDeps, "app" | "jobs">): WyomingEvent {
  const { ready } = modelState(d.app);
  // The same rule as `GET /v1/server`'s `available`, so the two never disagree.
  const offered = (name: string): boolean => {
    const p = PRESETS.find((x) => x.name === name);
    return !!p?.built && (d.app.presetAvailable?.(name) ?? ready);
  };
  const model = (name: string, installed: boolean, languages: string[]) => ({
    name,
    attribution: ATTRIBUTION,
    installed,
    description: null,
    version: null,
    languages,
  });
  const models = PRESETS.filter((p) => p.built).map((p) =>
    model(p.name, offered(p.name), presetLanguages(p.name)),
  );
  let auto: { model: string; preset: string } | null = null;
  try {
    auto = d.jobs.choose({});
  } catch {
    auto = null;
  }
  const builtPreset = auto && (PRESET_NAMES as readonly string[]).includes(auto.preset);
  models.push(
    model(
      "auto",
      auto !== null && (builtPreset ? offered(auto.preset) : d.jobs.obtainable(auto.model)),
      auto === null ? [] : builtPreset ? presetLanguages(auto.preset) : engineLanguages(auto.model),
    ),
  );
  return {
    type: "info",
    data: {
      asr: [
        {
          name: "akou",
          attribution: ATTRIBUTION,
          installed: models.some((m) => m.installed),
          description: "akou transcription server",
          version: d.app.version,
          models,
          supports_transcript_streaming: false,
          requires_external_vad: true,
          prefers_auto_gain_enabled: true,
          prefers_noise_reduction_enabled: true,
        },
      ],
      tts: [],
      handle: [],
      intent: [],
      wake: [],
      mic: [],
      snd: [],
    },
    payload: null,
  };
}

const event = (type: string, data: Record<string, unknown> = {}): WyomingEvent => ({
  type,
  data,
  payload: null,
});

export class WyomingServer {
  private readonly sessions = new Set<Session>();
  private readonly idleMs: number;
  private listener: TCPSocketListener<Session> | null = null;

  private constructor(private readonly d: WyomingDeps) {
    this.idleMs = d.idleMs ?? WYOMING_IDLE_MS;
  }

  /** Listens on `hostname:port`; a port in use throws, naming the port. */
  static listen(d: WyomingDeps): WyomingServer {
    const w = new WyomingServer(d);
    try {
      w.listener = Bun.listen<Session>({
        hostname: d.hostname,
        port: d.port,
        socket: {
          open: (socket) => w.open(socket),
          data: (socket, bytes) => w.data(socket.data, bytes),
          drain: (socket) => w.flush(socket.data),
          close: (socket) => w.closed(socket.data),
          error: (socket, err) => {
            d.log("warn", `wyoming: ${err.message}`);
            w.closed(socket.data);
          },
        },
      });
    } catch (err) {
      throw new Error(
        `the Wyoming listener cannot listen on ${d.hostname}:${d.port} (server.wyoming_port): ${(err as Error).message}`,
      );
    }
    d.log("info", `wyoming: listening on ${d.hostname}:${w.port}`);
    return w;
  }

  get port(): number {
    return this.listener?.port ?? 0;
  }

  /** The address it listens on: the API's (`apiBind`). */
  get hostname(): string {
    return this.listener?.hostname ?? this.d.hostname;
  }

  /** Ends every connection and its job or file, then stops listening. */
  async stop(): Promise<void> {
    const open = [...this.sessions];
    for (const s of open) {
      this.closed(s);
      s.socket.terminate();
    }
    await Promise.allSettled(open.map((s) => s.chain));
    this.listener?.stop(true);
    this.listener = null;
  }

  private open(socket: Socket<Session>): void {
    const s: Session = {
      socket,
      reader: new FrameReader(),
      transcribe: {},
      file: null,
      jobId: null,
      abort: new AbortController(),
      idle: null,
      out: [],
      ending: false,
      closed: false,
      chain: Promise.resolve(),
    };
    socket.data = s;
    this.sessions.add(s);
    this.arm(s);
  }

  /** (Re)starts the idle cut; none while a job runs or once the session ends. */
  private arm(s: Session): void {
    if (s.idle !== null) clearTimeout(s.idle);
    s.idle = null;
    if (s.closed || s.jobId !== null) return;
    // clock: the connection's own idle bound, `idleMs`.
    s.idle = setTimeout(() => {
      if (s.ending) s.socket.terminate();
      else this.finish(s);
    }, this.idleMs);
  }

  private data(s: Session, bytes: Uint8Array): void {
    // After a transcript or an error the rest is read and dropped, so the close is clean.
    if (s.closed || s.ending) return;
    this.arm(s);
    let events: WyomingEvent[];
    try {
      events = s.reader.push(bytes);
    } catch (err) {
      // As the Python reader: a line it cannot read is the end of the connection.
      if (err instanceof FrameError) this.d.log("warn", `wyoming: ${err.message}; closing`);
      this.closed(s);
      s.socket.terminate();
      return;
    }
    for (const e of events) {
      s.chain = s.chain.then(() => this.handle(s, e)).catch((err) => this.fail(s, err));
    }
  }

  private async handle(s: Session, e: WyomingEvent): Promise<void> {
    if (s.closed || s.ending) return;
    switch (e.type) {
      case "describe":
        this.send(s, info(this.d));
        return;
      case "ping":
        this.send(s, event("pong", typeof e.data.text === "string" ? { text: e.data.text } : {}));
        return;
      case "transcribe": {
        const language = e.data.language;
        if (language !== undefined && language !== null) {
          if (typeof language !== "string" || !WYOMING_LANGUAGE.test(language)) {
            throw new HttpError(
              422,
              "bad_field",
              `language "${String(language)}" is not a language code`,
            );
          }
        }
        const name = typeof e.data.name === "string" ? e.data.name : undefined;
        s.transcribe = {
          ...(typeof language === "string" ? { language } : {}),
          ...(name ? { name } : {}),
        };
        return;
      }
      case "audio-start":
        this.drop(s);
        s.file = this.upload(e.data);
        return;
      case "audio-chunk":
        if (!e.payload) return;
        // A chunk with no audio-start before it opens the file with the chunk's own format.
        s.file ??= this.upload(e.data);
        this.chunk(s.file, e.payload);
        return;
      case "audio-stop":
        await this.transcribe(s);
        return;
      default:
        // Servers drop events they do not know (wyoming README).
        return;
    }
  }

  /** A new upload with a streaming WAV header in the client's format. */
  private upload(data: Record<string, unknown>): Upload {
    const int = (v: unknown, fallback: number) =>
      typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback;
    const rate = int(data.rate, 16000);
    const width = int(data.width, 2);
    const channels = int(data.channels, 1);
    const path = join(this.d.jobs.uploadDir, `${crypto.randomUUID()}.upload`);
    const sink = Bun.file(path).writer();
    const hasher = new Bun.CryptoHasher("sha256");
    const header = streamingWavHeader(rate, width * 8, channels);
    sink.write(header);
    hasher.update(header);
    return { path, sink, hasher, bytes: 0 };
  }

  private chunk(f: Upload, payload: Uint8Array): void {
    f.bytes += payload.byteLength;
    const max = this.d.settings()["server.max_upload_mb"] * 1024 * 1024;
    if (f.bytes > max) {
      throw new HttpError(
        413,
        "body_too_large",
        `the audio passed ${max} bytes (server.max_upload_mb)`,
      );
    }
    f.sink.write(payload);
    f.hasher.update(payload);
  }

  /** Deletes an upload no job owns yet. */
  private drop(s: Session): void {
    const f = s.file;
    s.file = null;
    if (!f) return;
    void Promise.resolve(f.sink.end())
      .catch(() => {})
      .finally(() => rmSync(f.path, { force: true }));
  }

  private async transcribe(s: Session): Promise<void> {
    const f = s.file;
    s.file = null;
    if (f) await f.sink.end();
    if (s.closed) {
      if (f) rmSync(f.path, { force: true });
      return;
    }
    // No audio at all: an empty transcript, as the reference server answers.
    if (!f || f.bytes === 0) {
      if (f) rmSync(f.path, { force: true });
      this.send(s, event("transcript", { text: "" }));
      this.finish(s);
      return;
    }
    const jobs = this.d.jobs;
    // An utterance is a dictation in every way that matters: short, and someone is waiting.
    const interactive = jobs.interactive(true);
    let choice: ReturnType<typeof chooseModel>;
    try {
      const ask = s.transcribe.name ? { model: s.transcribe.name } : {};
      choice = chooseModel(
        jobs,
        interactive && !namesModel(jobs, ask.model) ? laneAsk(jobs, {}) : ask,
        { diarize: false },
        true,
      );
    } catch (err) {
      rmSync(f.path, { force: true });
      throw err;
    }
    const submitted = jobs.submit({
      key_id: WYOMING_IDENTITY.id,
      preset: choice.preset,
      model: choice.model,
      model_source: choice.source,
      language: s.transcribe.language ?? this.d.settings()["server.default_language"],
      keywords: [],
      languages: [],
      diarize: false,
      callback_url: null,
      metadata: null,
      title: null,
      idempotency_key: null,
      interactive,
      // The client has the answer on its connection; the feed never hears of the job (SV-E1).
      quiet: true,
      file_sha256: f.hasher.digest("hex"),
      audio: f.path,
    });
    // The job owns the file from here (a refused submit already deleted it).
    if ("full" in submitted) throw queueFullError(submitted.full);
    if ("conflict" in submitted) throw new Error("a job with no idempotency key cannot conflict");
    const id = submitted.job.id;
    s.jobId = id;
    this.arm(s);
    try {
      let job = jobs.get(WYOMING_IDENTITY, id);
      while (!s.closed && job && (job.status === "queued" || job.status === "running")) {
        await jobs.wait(WYOMING_IDENTITY, id, 60_000, s.abort.signal);
        job = jobs.get(WYOMING_IDENTITY, id);
      }
      if (s.closed) return;
      if (!job) throw new HttpError(409, "cancelled", "the job was deleted before it finished");
      if (job.status !== "done") {
        const e = job.error ?? { code: "transcription_failed", message: `the job ${job.status}` };
        throw new HttpError(500, e.code, e.message);
      }
      const r = (job.result ?? {}) as { text?: unknown; language?: unknown };
      this.send(
        s,
        event("transcript", {
          text: typeof r.text === "string" ? r.text : "",
          ...(typeof r.language === "string" && r.language !== "" ? { language: r.language } : {}),
        }),
      );
      this.finish(s);
    } finally {
      // The client has the only copy it asked for; akou keeps none (SV-J6).
      jobs.remove(WYOMING_IDENTITY, id);
      s.jobId = null;
    }
  }

  /** A refusal as an `error` event, then the close. */
  private fail(s: Session, err: unknown): void {
    this.drop(s);
    if (s.closed) return;
    const known = err instanceof HttpError;
    const code = known ? err.code : "internal";
    const text = (err as Error)?.message ?? String(err);
    this.d.log(known ? "warn" : "error", `wyoming: ${code}: ${text}`);
    this.send(s, event("error", { text, code }));
    this.finish(s);
  }

  private send(s: Session, e: WyomingEvent): void {
    if (s.closed) return;
    s.out.push(encode(e));
    this.flush(s);
  }

  /** Writes what the socket takes; the rest waits for `drain`. Ends once all is out and asked. */
  private flush(s: Session | undefined): void {
    if (!s || s.closed) return;
    while (s.out.length > 0) {
      const head = s.out[0] as Uint8Array;
      const n = s.socket.write(head);
      if (n < head.byteLength) {
        s.out[0] = head.subarray(Math.max(0, n));
        return;
      }
      s.out.shift();
    }
    if (s.ending) s.socket.end();
  }

  /** Closes the connection once what is queued is sent; further input is read and dropped. */
  private finish(s: Session): void {
    s.ending = true;
    this.flush(s);
    this.arm(s);
  }

  /** The connection is gone: its job is removed and its file deleted. */
  private closed(s: Session | undefined): void {
    if (!s || s.closed) return;
    s.closed = true;
    if (s.idle !== null) clearTimeout(s.idle);
    s.idle = null;
    s.abort.abort();
    if (s.jobId !== null) this.d.jobs.remove(WYOMING_IDENTITY, s.jobId);
    this.drop(s);
    this.sessions.delete(s);
  }
}
