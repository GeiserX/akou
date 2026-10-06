/**
 * `GET /v1/live` (docs/server.md "A phone or another live client"): a WebSocket in server mode
 * that streams a client's audio into the streaming model and its words back. The guard runs before
 * the upgrade like on every route, so a missing, wrong or revoked key gets a 401 answer and never a
 * socket. The protocol is `src/main/server/live.ts`'s.
 */

import { caller } from "../caller.ts";
import { HttpError, type Router } from "../http.ts";
import type { ApiApp } from "../server.ts";

export function liveRoutes(r: Router<ApiApp>): void {
  r.add(
    "GET",
    "/live",
    {
      id: "live.open",
      doc: 'A WebSocket for live words while a client records: open it with `Upgrade: websocket` and a key. Text frames are JSON. Send `{"type":"hello","v":1,"codec":"ogg-opus"|"pcm16","language":"auto"|<BCP 47>,"model":"auto"|<streaming model id>}` first; the answer is `{"type":"ready","engine","lang","tier_ms","load_ms"}`. Then send audio as binary frames: with `ogg-opus` exactly one Ogg page per frame (the OpusHead page, the OpusTags page, then the audio pages in order, mono, at most 64 KB each, and at most 30 s of audio ahead of what the model has decoded); with `pcm16` raw 16 kHz 16-bit little-endian mono samples (for tests). The server sends `{"type":"words","tokens":[{"text","t","conf"}]}` as the model gives them, append-only; `t` is seconds into the recording (an `ogg-opus` session that starts mid-file, a reconnect, is placed by its first page\'s granule). Send `{"type":"stop"}` to end: the last words, then `{"type":"closed"}` and a 1000 close. A refusal is `{"type":"error","code","message"}` then a close: 4400 (`bad_message`, `bad_page`, `too_fast`, `unknown_model`, `unsupported_language`), 4401 (`key_revoked`), 4409 (`engine_busy`: another open session runs another streaming model, and the server holds one at a time), 4500 (`stream_lost`), 4503 (`no_live_engine`). Nothing of a session is kept: upload the recording as a job for the transcript of record. `GET /v1/server` `live` lists the streaming models on disk.',
      access: "jobs",
      modes: ["server"],
      upgrade: "websocket",
      ok: 101,
      errors: { 426: ["upgrade_required"], 503: ["no_live_engine"] },
    },
    (c) => {
      const live = c.app.live?.() ?? null;
      if (!live) {
        throw new HttpError(503, "no_live_engine", "this server has no recognizer for live words");
      }
      if ((c.req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket" || !c.upgrade) {
        throw new HttpError(
          426,
          "upgrade_required",
          "GET /v1/live is a WebSocket: send Upgrade: websocket",
          {},
          { upgrade: "websocket" },
        );
      }
      if (!c.upgrade(live.session(caller(c)))) {
        throw new HttpError(
          426,
          "upgrade_required",
          "the request could not be upgraded to a WebSocket",
        );
      }
      // Bun answers the upgrade itself; this response is never sent.
      return new Response(null, { status: 204 });
    },
  );
}
