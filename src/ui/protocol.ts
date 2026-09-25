/**
 * How the window talks to the app (docs/DESIGN.md sections 6.3 rule 7 and 7). Types only.
 *
 * The page is one bundle with two transports behind one interface:
 *
 * - **The window** (ElectroBun): typed RPC to the main process (`window.ts`). No HTTP at all.
 * - **A browser** (the headless app, the Linux CLI tarball, the UI tests): the page server
 *   (`web.ts`), with a session of its own, never the API token.
 *
 * Both run the API's routes in process through the bridge, as the user. A follower of a call gets
 * every log event after its cursor once and in order, then resumes from the last `seq` it applied
 * after any drop, sleep or freeze.
 */

import type { LogEvent } from "../core/log/events.ts";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface Reply<T = unknown> {
  status: number;
  body: T;
}

/** The line still being spoken: never in the log, gone 3 s after its last update. */
export interface PartialLine {
  ch: "mic" | "call";
  part: number;
  spk?: string;
  text: string;
  w0: number;
  time: string;
  draft: true;
}

export interface Levels {
  mic: number;
  call: number;
}

/**
 * The app's rendering of the lines its vocabulary corrects (DESIGN 5.4). The page folds raw events
 * without the vocabulary files or the word lists, so for these lines it shows the app's text.
 * `rev` is the revision the text belongs to. `all`: every corrected line, replacing what came
 * before; otherwise an update, a line without `heard` having lost its correction.
 */
export interface ReadLine {
  id: string;
  rev: number;
  text: string;
  heard?: string;
}

export interface ReadLines {
  all: boolean;
  lines: ReadLine[];
}

export interface FollowSink {
  /** The stream is open; events follow. */
  open(): void;
  event(e: LogEvent): void;
  partial(lines: PartialLine[]): void;
  level(l: Levels): void;
  read(r: ReadLines): void;
  /** Anything arrived, a keep-alive included: the connection is alive. */
  alive(): void;
  /** The stream ended or failed. The follower reconnects from its cursor. */
  closed(reason: string): void;
}

export interface AskSink {
  excerpts(data: { excerpts: { citation: string; lines: string[] }[] }): void;
  token(t: string): void;
  answer(data: AskAnswer): void;
  error(data: { error: string; message: string }): void;
}

export interface AskAnswer {
  answered: boolean;
  text: string;
  kind: "answer" | "excerpts" | "naming";
  model?: string;
  cites: string[];
  reason?: string;
  context?: string;
}

export interface Transport {
  readonly kind: "window" | "browser";
  request<T = unknown>(method: Method, path: string, body?: unknown): Promise<Reply<T>>;
  /** Opens one stream of a call from `after` (the last `seq` applied). */
  follow(call: string, after: number, sink: FollowSink): { close(): void };
  ask(call: string, question: string, sink: AskSink): { cancel(): void };
  /** A part's audio, for playing a line. */
  audio(call: string, part: number): Promise<Blob>;
  /** The app's status now, and again after every call starts, ends, pauses or is shared. */
  watchStatus(fn: (status: AppStatus) => void): { close(): void };
  /** Opens the system's privacy pane for a grant; false when this surface cannot. */
  openSettingsPane(pane: "microphone" | "system-audio"): Promise<boolean>;
}

/** The parts of `GET /status` the window reads. */
export interface AppStatus {
  app: { version: string; headless: boolean };
  live: {
    call: string;
    title: string;
    workspace: string;
    state: string;
    muted: boolean;
    lag: number;
  } | null;
  last: { call: string; title: string; state: string; endedAt: number | null } | null;
  asr: { state: string; reason?: string; model?: string };
  /** The speech models on disk (`GET /models`); absent from an older app. */
  models?: ModelsInfo;
  provider: { state: string; id: string; harness?: string; detail?: string; reason?: string };
  share: { active: boolean; shares?: ShareInfo[] };
}

export interface ModelsInfo {
  state: "missing" | "downloading" | "ready" | "failed";
  dir: string;
  bytes: number;
  total: number;
  file?: string;
  error?: string;
}

export interface ShareInfo {
  id: string;
  call: string;
  url: string;
  viewers: number;
  bind: string;
  expiresAt: number | null;
  warning?: string;
}

/**
 * The ElectroBun RPC schema, in the shape `RPCSchema` expects: `bun` requests run in the main
 * process and are called by the page; `webview` messages are pushed by the main process.
 */
export interface AkouRpc {
  bun: {
    requests: {
      api: { params: { method: Method; path: string; body?: unknown }; response: Reply };
      follow: {
        params: { stream: string; call: string; after: number };
        response: { ok: boolean };
      };
      unfollow: { params: { stream: string }; response: { ok: boolean } };
      ask: {
        params: { stream: string; call: string; question: string };
        response: { ok: boolean };
      };
      cancelAsk: { params: { stream: string }; response: { ok: boolean } };
      audio: { params: { call: string; part: number }; response: { type: string; base64: string } };
      status: { params: Record<string, never>; response: AppStatus };
      openSettingsPane: { params: { pane: "microphone" | "system-audio" }; response: boolean };
    };
    messages: Record<string, never>;
  };
  webview: {
    requests: Record<string, never>;
    messages: {
      followed: {
        stream: string;
        kind: "open" | "event" | "partial" | "level" | "read" | "alive" | "closed";
        data?: unknown;
      };
      asked: { stream: string; kind: "excerpts" | "token" | "answer" | "error"; data: unknown };
      status: AppStatus;
      /** The tray, the hotkey or `akou open` asks the page to show a call. */
      showCall: { call?: string };
      /** The application menu's Settings… asks the page to open its settings. */
      showSettings: Record<string, never>;
      /** The floating indicator's Ask: the ask box, focused (DK-F1). */
      focusAsk: Record<string, never>;
    };
  };
}
