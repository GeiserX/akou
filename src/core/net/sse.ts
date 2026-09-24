/**
 * A Server-Sent Events reader for a fetch body, shared by the app (the window's bridge reads the
 * ask stream) and the page (which follows a call with `fetch`, so it can send its session header
 * and `Last-Event-ID` itself). Comment lines, the keep-alives, are reported too, so a reader can
 * tell a quiet call from a dead connection.
 */

export interface SseFrame {
  /** `message` when the frame names none; `comment` for a `: keep-alive` line. */
  event: string;
  data: string;
  id?: string;
}

export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const dec = new TextDecoder();
  let buf = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let cut = buf.indexOf("\n\n");
      while (cut >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let event = "message";
        let id: string | undefined;
        const data: string[] = [];
        let comment = false;
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) {
            comment = true;
            continue;
          }
          const i = line.indexOf(":");
          const field = i < 0 ? line : line.slice(0, i);
          const val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
          if (field === "event") event = val;
          else if (field === "data") data.push(val);
          else if (field === "id") id = val;
        }
        if (data.length > 0) yield { event, data: data.join("\n"), id };
        else if (comment) yield { event: "comment", data: "" };
        cut = buf.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
