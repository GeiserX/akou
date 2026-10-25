/**
 * A Bun Worker that is terminated, or that dies of an uncaught error, never runs its native
 * finalizers: the models it held stay in the process until it exits (Parakeet is about 2.2 GB).
 * Measured on Bun 1.4.2, Linux: 2.2 GB of RssAnon left after a terminate, and after a Worker died
 * of a thrown error, an unhandled rejection or `process.exit`; 18 MB once it released first.
 *
 * So a Worker that may hold models is retired, never just stopped: asked to free them, and
 * terminated on its answer, or after a bounded wait without one (a decode stuck in a native call
 * answers nothing). And a Worker never dies of an uncaught error: `reportCrashes` keeps it alive
 * and tells the host, which retires it like any other.
 */

import { inNativeLoad, type NativeFlag, stopWorker } from "./native-guard.ts";

/** Asks a Worker to free its models; it answers `released` once they are freed. */
export const RELEASE = { type: "release" } as const;

/** The Worker's answer to `release`. */
export const RELEASED = "released";

/** The message a Worker posts instead of dying of an uncaught error. */
export const CRASHED = "crashed";

/** How long a retired Worker gets to free its models before it is terminated as it is. */
export const RELEASE_MS = 15_000;

/**
 * The Worker side: an uncaught error or an unhandled rejection is posted as `crashed` and the
 * Worker lives on, so its host can still have it free its models. Bun closes a Worker on either,
 * and its models then stay in the process for good.
 */
export function reportCrashes(post: (m: { type: typeof CRASHED; error: string }) => void): void {
  const crashed = (err: unknown) =>
    post({ type: CRASHED, error: err instanceof Error ? err.message : String(err) });
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
}

export interface RetireOptions {
  /** How long to wait for `released` before terminating the Worker as it is. */
  ms?: number;
  /** Every other message the Worker sends until it goes (its logs, its children, its job's end). */
  onMessage?(m: { type?: unknown }): void;
  /** Runs once, right before the terminate. */
  onEnd?(): void;
  /** Posts `release` only when the caller says so (`retired.release()`), once the work stopped. */
  later?: boolean;
}

/**
 * Retires `w`: asks it to free its models, unless `later`, and terminates it on its `released`,
 * when it dies, or after `ms`. A Worker inside a model load when the time is up is given the time
 * again, so the load returns, its work stops and it frees what it loaded: terminating it there
 * would keep the model just loaded (and is never done mid-load, #408). Takes over the Worker's
 * `onmessage` and `onerror`.
 */
export function retireWorker(w: Worker, f: NativeFlag, o: RetireOptions = {}): { release(): void } {
  const ms = o.ms ?? RELEASE_MS;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = (dead = false) => {
    if (ended) return;
    if (!dead && inNativeLoad(f)) {
      // clock: a real-time cap on a Worker that may never answer.
      timer = setTimeout(() => end(), ms);
      return;
    }
    ended = true;
    clearTimeout(timer);
    w.onmessage = null;
    w.onerror = null;
    o.onEnd?.();
    stopWorker(w, f);
  };
  // clock: a real-time cap on a Worker that may never answer.
  timer = setTimeout(() => end(), ms);
  w.onmessage = (e: MessageEvent) => {
    const m = (e.data ?? {}) as { type?: unknown };
    if (m.type === RELEASED) return end();
    o.onMessage?.(m);
  };
  // Its thread is gone: nothing can answer any more.
  w.onerror = () => end(true);
  const release = () => {
    if (!ended) w.postMessage(RELEASE);
  };
  if (!o.later) release();
  return { release };
}
