/**
 * What a route handler asks of the caller (`access.ts`), answered as HTTP errors: the identity it
 * acts for, and whether a callback URL is one the caller's key may name (SV-K4).
 */

import { APP_IDENTITY, callbackAllowed, type Identity } from "./access.ts";
import { HttpError, type Mode } from "./http.ts";

/** `POST /v1/jobs` with a callback the key may not name: 422 `callback_not_allowed`. */
export function requireCallbackAllowed(identity: Identity, url: string): void {
  if (!callbackAllowed(identity, url)) {
    throw new HttpError(
      422,
      "callback_not_allowed",
      "the callback URL's host is not on this key's callback host list",
      { callback_url: url },
    );
  }
}

/**
 * The identity a handler acts for: the guard's, or the app's own in process (the window's bridge).
 * An `open` route reached with no key has none: 401, for a handler that needs one.
 */
export function caller(c: { identity?: Identity | null }): Identity {
  if (c.identity === undefined) return APP_IDENTITY;
  if (c.identity === null) {
    throw new HttpError(401, "unauthorized", "a valid bearer token is required");
  }
  return c.identity;
}

/**
 * Is the caller the user on this computer: the desktop window in process, or the app's own token,
 * which the desktop app takes only on its loopback listener? Never an `ak_` key (the network
 * listener takes nothing else), the window's page in a browser, or server mode. For what decides
 * where transcripts are written: `export.dir` and the export's `to`.
 */
export function isLocalUser(c: {
  identity?: Identity | null;
  browser?: boolean;
  app: { mode?(): Mode };
}): boolean {
  if ((c.app.mode?.() ?? "app") !== "app") return false;
  if (c.identity === undefined) return c.browser !== true;
  return c.identity === APP_IDENTITY;
}
