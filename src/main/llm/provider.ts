/**
 * The provider interface (docs/DESIGN.md section 5.3): whatever does the thinking for the ask box
 * and Enhance. akou brokers a small context and the provider answers it, token by token.
 *
 * Four providers share this interface: the user's own coding harness (`harness`, the default), an
 * OpenAI-compatible server (`openai-compatible`), the Anthropic API with the user's own key
 * (`anthropic`), and `none`, which answers nothing and leaves the caller to show excerpts.
 *
 * Failures are typed, so a caller can say why and fall back to excerpts instead of showing nothing
 * (TRAPS "Provider unavailable answered with nothing"):
 *
 * - `missing`: nothing to run or reach (no harness found, no server answering, not configured);
 * - `exhausted`: a usage or rate limit; `resetsAt` says until when, when the provider said so;
 * - `auth`: not logged in, a refused key or token;
 * - `cancelled`: the caller aborted (Stop in the ask box, a client that went away);
 * - `other`: anything else, including no answer within the deadline.
 */

export type ProviderId = "harness" | "openai-compatible" | "anthropic" | "none";

export type ProviderErrorKind = "missing" | "exhausted" | "auth" | "cancelled" | "other";

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /** Epoch ms a usage limit lifts, when the provider said. */
    readonly resetsAt?: number,
  ) {
    super(message);
  }
}

export interface CompleteRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  /**
   * Continue a conversation the provider keeps (Claude Code's `--resume`): `resume: false` starts
   * the session `id`, `resume: true` continues it. Only a provider whose `sessions()` is true reads
   * it; the others answer the prompt alone.
   */
  session?: { id: string; resume: boolean };
}

/** Tokens one run spent, as the provider reported them. */
export interface Usage {
  input: number;
  /** Written to the prompt cache. */
  cacheCreation: number;
  /** Read from the prompt cache. */
  cacheRead: number;
  output: number;
}

/** Every token the model processed in a run: the measure session reuse is judged by. */
export function totalTokens(u: Usage): number {
  return u.input + u.cacheCreation + u.cacheRead + u.output;
}

export interface CompleteResult {
  text: string;
  /** Provenance for the log: `claude-code/2.1.281`, `codex/0.151.0`, or the API model id. */
  model: string;
  /** What the run spent, when the provider reports it. */
  usage?: Usage;
}

export type Availability =
  | { ok: true; detail: string }
  | { ok: false; reason: string; kind: ProviderErrorKind };

export interface Provider {
  readonly id: ProviderId;
  available(): Promise<Availability>;
  /** Whether `CompleteRequest.session` is honoured. Absent: it is not. */
  sessions?(): boolean;
  complete(
    req: CompleteRequest,
    onToken: (t: string) => void,
    signal: AbortSignal,
  ): Promise<CompleteResult>;
}

/** The design's deadline for an answer before the caller falls back to excerpts. */
export const ANSWER_TIMEOUT_MS = 60_000;

/**
 * Runs one completion with a deadline. The provider sees one signal that fires on the caller's
 * abort or on the deadline; a deadline becomes `other` ("no answer within 60 s"), a caller's abort
 * becomes `cancelled`, and anything a provider throws that is not a `ProviderError` becomes
 * `other`. Tokens are only forwarded while the run is current.
 */
export async function runProvider(
  provider: Provider,
  req: CompleteRequest,
  onToken: (t: string) => void,
  o: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CompleteResult> {
  const timeoutMs = o.timeoutMs ?? ANSWER_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, deadline.signal]) : deadline.signal;
  let live = true;
  try {
    if (o.signal?.aborted) throw new ProviderError("cancelled", "the question was cancelled");
    return await provider.complete(req, (t) => live && onToken(t), signal);
  } catch (err) {
    if (o.signal?.aborted) throw new ProviderError("cancelled", "the question was cancelled");
    if (deadline.signal.aborted) {
      const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
      throw new ProviderError("other", `no answer within ${limit}`);
    }
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("other", (err as Error)?.message ?? String(err));
  } finally {
    live = false;
    clearTimeout(timer);
  }
}

/**
 * Splits a byte stream into lines as they arrive (JSON lines, Server-Sent Events). A final line
 * with no newline is yielded too.
 */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i = buf.indexOf("\n");
    while (i >= 0) {
      yield buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  }
  buf += dec.decode();
  if (buf !== "") yield buf.replace(/\r$/, "");
}

/**
 * Server-Sent Events from a response body: `{event, data}` per event, `data` joined across its
 * lines. Comments and ids are skipped.
 */
export async function* readSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  let event = "";
  let data: string[] = [];
  for await (const line of readLines(stream)) {
    if (line === "") {
      if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
      event = "";
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
}

/** Maps an HTTP status from a provider's API to a failure kind. */
export function kindOfStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "exhausted";
  if (status === 404) return "missing";
  return "other";
}

/** A fetch that could not connect at all: nothing answers at that address. */
export function isUnreachable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "ConnectionRefused" ||
    e?.code === "ECONNREFUSED" ||
    e?.code === "ENOTFOUND" ||
    /unable to connect|connection refused|ECONNREFUSED|could not resolve/i.test(e?.message ?? "")
  );
}
