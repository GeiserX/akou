/**
 * The hark dialect (`stereo-s16le`, docs/DESIGN.md section 2.4).
 *
 * Two layers: the fake helper in its hark mode runs everywhere, and the real hark binary runs on
 * a generated WAV through its file mode (`-i`) when `AKOU_HARK_BIN` names it. Live capture is never
 * run from a test: it needs permission grants.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEvent } from "../src/core/log/events.ts";
import { CallManager } from "../src/main/call/manager.ts";
import type { CaptureHandlers, ExitInfo } from "../src/main/capture/engine.ts";
import { HarkEngine } from "../src/main/capture/hark.ts";
import type { HelperMessage, Packet } from "../src/main/capture/protocol.ts";
import { ofType, until } from "./capture-helpers.ts";
import { rms, stereoWav, tone } from "./fixtures/audio.ts";
import { TZ, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "..", "scripts", "fake-helper.ts");
const HARK = process.env.AKOU_HARK_BIN;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function collect() {
  const packets: Packet[] = [];
  const messages: HelperMessage[] = [];
  let exit: ExitInfo | null = null;
  const handlers: CaptureHandlers = {
    packet: (p) => packets.push(p),
    message: (m) => messages.push(m),
    exit: (e) => {
      exit = e;
    },
  };
  return { packets, messages, handlers, exit: () => exit };
}

function channel(packets: Packet[], ch: "mic" | "call"): Float32Array {
  const parts = packets.filter((p) => p.ch === ch);
  const out = new Float32Array(parts.reduce((n, p) => n + p.samples.length, 0));
  let o = 0;
  for (const p of parts) {
    expect(p.fileSeconds).toBeCloseTo(o / 16000, 9);
    out.set(p.samples, o);
    o += p.samples.length;
  }
  return out;
}

describe("hark dialect against the fake helper", () => {
  test("stereo s16 on stdout becomes mic and call packets on one clock, with synthesised messages", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const engine = new HarkEngine({
      command: [
        process.execPath,
        FAKE,
        "--dialect",
        "stereo-s16le",
        "--duration",
        "1.5",
        "--speed",
        "0",
      ],
      inputFile: "unused-by-the-fake.wav",
    });
    const c = collect();
    const s = engine.start(
      { part: 1, out: join(dir, "p.opus"), mic: "default", call: "system" },
      c.handlers,
    );
    const exit = await s.exited;
    expect(exit.code).toBe(0);
    expect(c.messages.map((m) => m.type)).toEqual([
      "hello",
      "capturing",
      "first_audio",
      "first_audio",
      "stopped",
    ]);
    const mic = channel(c.packets, "mic");
    const call = channel(c.packets, "call");
    expect(mic.length).toBe(24000);
    expect(call.length).toBe(24000);
    const stopped = c.messages.at(-1);
    expect(stopped).toMatchObject({ type: "stopped", file_seconds: 1.5, reason: "eof" });
    const capturing = c.messages.find((m) => m.type === "capturing");
    const anchor = BigInt((capturing as { capture_ns: string }).capture_ns);
    const last = c.packets.filter((p) => p.ch === "mic").at(-1) as Packet;
    expect(last.captureNs - anchor).toBe(BigInt(Math.round(last.fileSeconds * 1e9)));
  });

  test.skipIf(process.platform === "win32")(
    "through the call manager: 201 at the first byte, stop by SIGINT within the budget (skipped on Windows: no SIGINT to a child)",
    async () => {
      const { dir: root, cleanup } = tempDir();
      cleanups.push(cleanup);
      const events: LogEvent[] = [];
      const mgr = new CallManager({
        root,
        tz: TZ,
        engine: new HarkEngine({ command: [process.execPath, FAKE, "--dialect", "stereo-s16le"] }),
        budgets: { stopMs: 2_000 },
        onEvent: (_, e) => events.push(e),
      });
      const a = await mgr.start({ workspace: "work" });
      expect(a).toMatchObject({ ok: true, part: 1 });
      expect(ofType(events, "part.started")[0]?.capture).toBe("hark unknown");
      await until(() => (mgr.live()?.current?.ingest.fileSeconds ?? 0) > 0.3, 3_000, "audio");
      const t0 = performance.now();
      expect((await mgr.stop("live")).ok).toBe(true);
      expect(performance.now() - t0).toBeLessThan(2_000);
      const ended = ofType(events, "part.ended")[0];
      expect(ended?.reason).toBe("stop");
      expect(ended?.fileSeconds).toBeGreaterThanOrEqual(0.29);
    },
    15_000,
  );
});

describe("hark dialect against the real hark binary, file mode only", () => {
  test.skipIf(!HARK)(
    "a generated stereo WAV through `hark -i`: mic left, call right, every frame once (set AKOU_HARK_BIN to run)",
    async () => {
      const { dir, cleanup } = tempDir();
      cleanups.push(cleanup);
      const wav = join(dir, "in.wav");
      // Left (mic): a 440 Hz tone for 2 s. Right (call): silent for 1 s, then 880 Hz.
      const call = tone(2, 880);
      call.fill(0, 0, 16000);
      writeFileSync(wav, stereoWav(tone(2, 440), call));
      const engine = new HarkEngine({ command: [HARK as string], inputFile: wav });
      const c = collect();
      const s = engine.start(
        {
          part: 1,
          out: join(dir, "p.opus"),
          mic: "default",
          call: "system",
          logPath: join(dir, "hark.log"),
        },
        c.handlers,
      );
      const exit = await s.exited;
      expect(exit.code).toBe(0);
      const mic = channel(c.packets, "mic");
      const right = channel(c.packets, "call");
      expect(mic.length).toBe(32000);
      expect(right.length).toBe(32000);
      expect(rms(mic)).toBeGreaterThan(0.1);
      expect(rms(right, 0, 15000)).toBeLessThan(0.001);
      expect(rms(right, 17000, 32000)).toBeGreaterThan(0.1);
      expect(c.messages.at(-1)).toMatchObject({ type: "stopped", file_seconds: 2 });
    },
    15_000,
  );
});
