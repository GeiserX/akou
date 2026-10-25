/**
 * Bun 1.3.13 through at least 1.4.4 aborts the whole process when a Worker is terminated while it
 * is inside a native call that builds an object: the call returns into a torn-down N-API env and
 * node-addon-api calls `napi_fatal_error` ("NAPI FATAL ERROR: Error::Error napi_define_properties",
 * oven-sh/bun#45252, issue #408). A model load sits in such a call for a second, or for minutes on
 * a starved disk, so a job cancelled while Parakeet loads took the server down with it.
 *
 * So a Worker never gets terminated inside a native load. The Worker counts itself in and out of
 * each load on a flag it shares with the host. A host that wants the Worker gone sets the flag's
 * stop bit: a Worker outside a load is terminated at once, as before; one inside a load parks
 * itself in JS the moment the load returns, says so, and only then is terminated. Nothing polls on
 * a timer, so the terminate never lands in the native calls that follow a load (a decode).
 *
 * Remove this once the pinned Bun carries the upstream fix (oven-sh/bun#45615).
 */

const DEPTH = 0;
const STOP = 1;

/** Shared between a host and its Worker: [loads in progress, stop requested]. */
export type NativeFlag = Int32Array;

/** The message a Worker posts once it is parked in JS, out of every native load. */
export const NATIVE_PARKED = "native.parked";

export function nativeFlag(): NativeFlag {
  return new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
}

/** Whether the Worker holding `f` is inside a native load now. */
export function inNativeLoad(f: NativeFlag | null | undefined): boolean {
  return !!f && Atomics.load(f, DEPTH) > 0;
}

// ---------------------------------------------------------------------------
// The Worker side

let workerFlag: NativeFlag | null = null;

/** Called by a Worker entry with the flag its host sent; absent (in-thread, tests), no guard. */
export function useNativeFlag(f: NativeFlag | undefined): void {
  if (f) workerFlag = f;
}

/** Posts that the Worker is parked, then waits in JS, never returning, for the host's terminate. */
function parkForever(f: NativeFlag): never {
  (globalThis as unknown as { postMessage(m: unknown): void }).postMessage({ type: NATIVE_PARKED });
  // Short waits in a loop: between two of them the Worker is in plain JS, where a terminate lands.
  for (;;) Atomics.wait(f, STOP, 1, 50);
}

/**
 * Runs `load`, a native constructor, counted on the flag. A stop asked before it starts skips it;
 * one asked during it parks the Worker as soon as it returns. Without a flag it just runs `load`.
 * `park` is for tests.
 */
export function nativeLoad<T>(
  load: () => T,
  f: NativeFlag | null = workerFlag,
  park: (f: NativeFlag) => never = parkForever,
): T {
  if (!f) return load();
  // In before reading stop, as the host sets stop before reading the count: one of the two always
  // sees the other, so a load never starts unseen under a terminate.
  Atomics.add(f, DEPTH, 1);
  try {
    if (Atomics.load(f, STOP) === 0) return load();
  } finally {
    Atomics.sub(f, DEPTH, 1);
    if (Atomics.load(f, STOP) === 1) park(f);
  }
  return park(f);
}

/**
 * `nativeLoad` for a load that resolves later (transcribe-cpp's `TranscribeModel.load`): counted on
 * the flag until it settles. A stop asked before it starts skips it; one asked during it disposes
 * the model it got, which the parked Worker would otherwise hold until the process exits, then
 * parks. Without a flag it just runs `load`. `park` is for tests.
 */
export async function nativeLoadAsync<T>(
  load: () => Promise<T>,
  dispose: (model: T) => void,
  f: NativeFlag | null = workerFlag,
  park: (f: NativeFlag) => never = parkForever,
): Promise<T> {
  if (!f) return load();
  Atomics.add(f, DEPTH, 1);
  let got: { model: T } | null = null;
  try {
    if (Atomics.load(f, STOP) === 0) got = { model: await load() };
  } finally {
    Atomics.sub(f, DEPTH, 1);
    if (Atomics.load(f, STOP) === 1) {
      if (got) {
        try {
          dispose(got.model);
        } catch {
          // Its memory is lost either way; the Worker still parks.
        }
      }
      park(f);
    }
  }
  return got ? got.model : park(f);
}

// ---------------------------------------------------------------------------
// The host side

/** What `stopWorker` needs of a Worker. */
export interface Stoppable {
  terminate(): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
  addEventListener(type: "error", fn: () => void): void;
}

/**
 * Terminates `w` now if it is outside every native load, or as soon as it parks after the load it
 * is in. Returns whether it terminated now. A load that never returns leaves its Worker thread
 * behind instead of aborting the process.
 */
export function stopWorker(w: Stoppable, f: NativeFlag): boolean {
  Atomics.store(f, STOP, 1);
  if (Atomics.load(f, DEPTH) === 0) {
    w.terminate();
    return true;
  }
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    w.terminate();
  };
  w.addEventListener("message", (e: MessageEvent) => {
    if ((e.data as { type?: unknown } | null)?.type === NATIVE_PARKED) end();
  });
  w.addEventListener("error", end);
  return false;
}
