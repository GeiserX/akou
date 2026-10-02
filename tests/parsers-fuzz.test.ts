/**
 * The parsers that read what another program wrote, fed random, truncated and huge input
 * (docs/TESTING.md TS-22b): the capture helper's stderr NDJSON and its packet stream, the
 * harnesses' stream-JSON, and the hark-viewer importer. None may throw anything but its own typed
 * error; a stderr line it cannot trust is text for the log, a harness event it cannot read adds
 * nothing, and a folder it cannot read is an `ImportError`. Inputs come from seeded generators, and
 * every failing assertion names its seed.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  encodePacket,
  LineSplitter,
  type Packet,
  PacketDecoder,
  ProtocolError,
  parseStderrLine,
} from "../src/main/capture/protocol.ts";
import { ImportError, readHarkViewerFolder } from "../src/main/import/hark-viewer.ts";
import { claudeParser, codexParser } from "../src/main/llm/harness.ts";
import { tempDir } from "./helpers.ts";
import { rng } from "./synth.ts";

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const HUGE = 1 << 20;

type Rand = () => number;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

/** Any JSON value, weighted toward the odd ones: null, -0, 1e308, empty and deep containers. */
function anyJson(r: Rand, keys: readonly string[], depth = 0): unknown {
  switch (Math.floor(r() * 9)) {
    case 0:
      return null;
    case 1:
      return r() < 0.5;
    case 2:
      return pick(r, [0, -0, -1, 0.5, 1e308, -1e308, 2 ** 53 + 1, 42]);
    case 3:
      return pick(r, ["", "mic", "call", "text", "text_delta", "done", "\u0000", "é🙂", "{"]);
    case 4:
      return depth < 3
        ? Array.from({ length: Math.floor(r() * 4) }, () => anyJson(r, keys, depth + 1))
        : [];
    default: {
      if (depth >= 3) return {};
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(r() * 5); i > 0; i--) o[pick(r, keys)] = anyJson(r, keys, depth + 1);
      return o;
    }
  }
}

/** `sample` with one value somewhere inside it replaced by any JSON value. */
function mutate(r: Rand, sample: unknown, keys: readonly string[]): unknown {
  if (typeof sample !== "object" || sample === null || r() < 0.2) return anyJson(r, keys);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(sample)
    ? [...sample]
    : { ...(sample as Record<string, unknown>) };
  const ks = Object.keys(copy);
  if (ks.length === 0) return anyJson(r, keys);
  const k = pick(r, ks);
  (copy as Record<string, unknown>)[k] = mutate(r, (copy as Record<string, unknown>)[k], keys);
  return copy;
}

function randomBytes(r: Rand, n: number): Uint8Array {
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
}

/** Every way a line from another program goes wrong, built from a well-formed one. */
function badLines(r: Rand, good: readonly unknown[], keys: readonly string[]): string[] {
  const out: string[] = [];
  const line = JSON.stringify(pick(r, good));
  out.push(line.slice(0, Math.floor(r() * line.length)));
  out.push(JSON.stringify(mutate(r, pick(r, good), keys)));
  out.push(JSON.stringify(anyJson(r, keys)));
  out.push(new TextDecoder().decode(randomBytes(r, 1 + Math.floor(r() * 200))));
  return out;
}

// --- the capture helper ------------------------------------------------------------------------

const HELPER_MESSAGES: unknown[] = [
  { type: "hello", protocol: "akou-capture/1", version: "0.1.0", caps: ["mic", "call"] },
  {
    type: "capturing",
    mic: { id: "m", name: "Built-in Microphone", rate: 48000 },
    call: { mode: "system", rate: 48000 },
    exclude: [],
    capture_ns: "123456789012345678",
  },
  { type: "first_audio", ch: "mic", capture_ns: 5 },
  { type: "level", mic_dbfs: -30, call_dbfs: -40 },
  { type: "health", ch: "call", state: "ok", silent_for: 0, rebuilds: 0, detail: "" },
  { type: "device", ch: "mic", event: "changed", name: "USB" },
  { type: "warn", code: "w", msg: "m" },
  { type: "stopped", file_seconds: 12.5, reason: "stop" },
];
const HELPER_KEYS = [
  "type",
  "protocol",
  "version",
  "caps",
  "mic",
  "call",
  "exclude",
  "capture_ns",
  "ch",
  "name",
  "rate",
  "mode",
  "state",
  "detail",
  "msg",
  "file_seconds",
  "reason",
];

describe("the capture helper's stderr reader (TS-22b)", () => {
  test("never throws on random, truncated, mutated or huge lines; what it cannot trust is text", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const lines = badLines(r, HELPER_MESSAGES, HELPER_KEYS);
      lines.push(`{"type":"warn","code":"w","msg":"${"x".repeat(HUGE)}"}`, "{".repeat(HUGE));
      for (const line of lines) {
        let got: ReturnType<typeof parseStderrLine> | undefined;
        expect(() => {
          got = parseStderrLine(line);
        }, `seed ${seed}`).not.toThrow();
        expect(["msg", "text"], `seed ${seed}`).toContain(got?.kind ?? "thrown");
      }
    }
  });

  test("positive control: a well-formed message is read as one, a truncated one is text", () => {
    for (const m of HELPER_MESSAGES) {
      const line = JSON.stringify(m);
      expect(parseStderrLine(line).kind).toBe("msg");
      expect(parseStderrLine(line.slice(0, -1)).kind).toBe("text");
    }
  });

  test("lines split into reads anywhere, inside a UTF-8 character too, come out whole", () => {
    const text = `${HELPER_MESSAGES.map((m) => JSON.stringify(m)).join("\n")}\nlog é🙂 line\r\n${"y".repeat(5000)}\nlast`;
    const bytes = new TextEncoder().encode(text);
    const whole = new LineSplitter();
    const want = [...whole.push(bytes), ...whole.flush()];
    for (const seed of SEEDS) {
      const r = rng(seed);
      const s = new LineSplitter();
      const got: string[] = [];
      for (let at = 0; at < bytes.length; ) {
        const n = 1 + Math.floor(r() * 64);
        got.push(...s.push(bytes.subarray(at, at + n)));
        at += n;
      }
      got.push(...s.flush());
      expect(got, `seed ${seed}`).toEqual(want);
    }
  });
});

describe("the capture helper's packet reader (TS-22b)", () => {
  test("random bytes give packets or a ProtocolError, never another error", () => {
    for (const seed of SEEDS) {
      const r = rng(seed);
      const d = new PacketDecoder();
      try {
        d.push(randomBytes(r, 1 + Math.floor(r() * 4096)));
        // A valid magic with random fields after it: the header's numbers are what it checks.
        const head = randomBytes(r, 28);
        head.set(new TextEncoder().encode("AKP1"));
        new PacketDecoder().push(head);
      } catch (err) {
        expect(err, `seed ${seed}`).toBeInstanceOf(ProtocolError);
      }
    }
  });

  test("packets split into reads anywhere come out whole and once", () => {
    const packets: Packet[] = [0, 1, 2, 3].map((i) => ({
      ch: i % 2 === 0 ? "mic" : "call",
      zeroFilled: i === 3,
      captureNs: BigInt(i) * 10_000_000n,
      fileSeconds: i * 0.02,
      samples: Float32Array.from({ length: 320 }, (_, k) => Math.sin(k + i)),
    }));
    const bytes = new Uint8Array(packets.reduce((a, p) => a + 28 + p.samples.length * 4, 0));
    let at = 0;
    for (const p of packets) {
      const b = encodePacket(p);
      bytes.set(b, at);
      at += b.length;
    }
    for (const seed of SEEDS) {
      const r = rng(seed);
      const d = new PacketDecoder();
      const got: Packet[] = [];
      for (let o = 0; o < bytes.length; ) {
        const n = 1 + Math.floor(r() * 700);
        got.push(...d.push(bytes.subarray(o, o + n)));
        o += n;
      }
      expect(got, `seed ${seed}`).toEqual(packets);
      expect(d.pending).toBe(0);
    }
  });
});

// --- the harnesses -----------------------------------------------------------------------------

const CLAUDE_EVENTS: unknown[] = [
  { type: "system", subtype: "init", claude_code_version: "2.1.0" },
  {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
  },
  { type: "assistant", message: { model: "m", content: [{ type: "text", text: "Hi there" }] } },
  { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1 } },
  {
    type: "result",
    result: "Hi there",
    is_error: false,
    usage: { input_tokens: 1, output_tokens: 2 },
  },
];
const CODEX_EVENTS: unknown[] = [
  { type: "item.started", item: { id: "a", type: "agent_message", text: "" } },
  { type: "item.updated", item: { id: "a", type: "agent_message", text: "Hel" } },
  { type: "item.completed", item: { id: "a", type: "agent_message", text: "Hello" } },
  { type: "error", message: "e" },
  { type: "turn.failed", error: { message: "m" } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
];
const HARNESS_KEYS = [
  "type",
  "subtype",
  "event",
  "delta",
  "text",
  "message",
  "content",
  "model",
  "error",
  "result",
  "is_error",
  "usage",
  "item",
  "id",
  "parent_tool_use_id",
  "rate_limit_info",
  "status",
  "resetsAt",
  "api_error_status",
  "input_tokens",
  "output_tokens",
];

describe("the harnesses' stream-JSON parsers (TS-22b)", () => {
  for (const [name, make, good] of [
    ["Claude Code", claudeParser, CLAUDE_EVENTS],
    ["Codex", codexParser, CODEX_EVENTS],
  ] as const) {
    test(`${name}: any event, mutated, random or huge, never throws and adds only text`, () => {
      for (const seed of SEEDS) {
        const r = rng(seed);
        const p = make();
        const feed: unknown[] = [];
        for (let i = 0; i < 30; i++) {
          feed.push(r() < 0.3 ? pick(r, good) : mutate(r, pick(r, good), HARNESS_KEYS));
          feed.push(anyJson(r, HARNESS_KEYS));
        }
        feed.push(mutate(r, pick(r, good), HARNESS_KEYS), {
          type: "result",
          result: "z".repeat(HUGE),
        });
        // A line the reader could not parse never reaches the parser; the rest arrive as values.
        for (const line of badLines(r, good, HARNESS_KEYS)) {
          try {
            feed.push(JSON.parse(line));
          } catch {}
        }
        for (const e of feed) {
          let toks: string[] = [];
          expect(() => {
            toks = p.feed(e);
          }, `seed ${seed}`).not.toThrow();
          for (const t of toks) expect(typeof t, `seed ${seed}`).toBe("string");
        }
        expect(typeof p.report().text, `seed ${seed}`).toBe("string");
      }
    });
  }

  test("positive control: the well-formed streams give their answers", () => {
    const c = claudeParser();
    for (const e of CLAUDE_EVENTS) c.feed(e);
    expect(c.report().text).toBe("Hi there");
    const x = codexParser();
    for (const e of CODEX_EVENTS) x.feed(e);
    expect(x.report().text).toBe("Hello");
  });
});

// --- the hark-viewer importer ------------------------------------------------------------------

const HV_FILES: Record<string, unknown> = {
  "meta.json": {
    started: 1_790_000_000,
    workspace: "work",
    title: "Weekly",
    id: "abc",
    parts: [{ n: 1, audio: "audio.opus", transcript: "transcript.json", started: 1_790_000_000 }],
  },
  "postprocess.json": {
    finished: 1_790_000_900,
    steps: {
      final: { state: "done", skipped_spans: [], warning: "w" },
      languages: { state: "done", languages: { present: ["en"] } },
    },
  },
};
const HV_LINES = [{ start: 0.5, end: 2, text: "hello there", speaker: "You" }];
const HV_KEYS = [
  "started",
  "workspace",
  "title",
  "id",
  "parts",
  "n",
  "audio",
  "transcript",
  "finished",
  "steps",
  "final",
  "state",
  "skipped_spans",
  "warning",
  "languages",
  "present",
  "start",
  "end",
  "text",
  "speaker",
];

describe("the hark-viewer importer (TS-22b)", () => {
  test("a folder of random, truncated, mutated or huge files is read or refused with an ImportError", () => {
    const t = tempDir("akou-hv-fuzz-");
    try {
      for (const seed of SEEDS) {
        const r = rng(seed);
        const dir = join(t.dir, `2026-09-21_153038_call-${seed}`);
        mkdirSync(dir);
        for (const [file, good] of Object.entries(HV_FILES)) {
          const k = r();
          const body =
            k < 0.4
              ? JSON.stringify(mutate(r, mutate(r, good, HV_KEYS), HV_KEYS))
              : k < 0.6
                ? JSON.stringify(good).slice(0, Math.floor(r() * JSON.stringify(good).length))
                : k < 0.8
                  ? new TextDecoder().decode(randomBytes(r, Math.floor(r() * 300)))
                  : JSON.stringify(good);
          writeFileSync(join(dir, file), body);
        }
        const lines = [
          ...HV_LINES.map((l) => JSON.stringify(l)),
          ...badLines(r, HV_LINES, HV_KEYS),
          JSON.stringify({ start: 1, end: 2, text: "w ".repeat(HUGE / 2) }),
        ];
        writeFileSync(join(dir, "transcript.json"), `${lines.join("\n")}\n`);
        writeFileSync(join(dir, "transcript.final.json"), `${lines.reverse().join("\n")}`);
        try {
          const hv = readHarkViewerFolder(dir);
          expect(Number.isFinite(hv.startMs), `seed ${seed}`).toBe(true);
        } catch (err) {
          expect(err, `seed ${seed}: ${(err as Error).message}`).toBeInstanceOf(ImportError);
        }
      }
    } finally {
      t.cleanup();
    }
  });

  test("a state file whose step is not an object reads as one with no step, not a TypeError", () => {
    const t = tempDir("akou-hv-fuzz-");
    try {
      const dir = join(t.dir, "2026-09-21_153038_call");
      mkdirSync(dir);
      writeFileSync(join(dir, "meta.json"), JSON.stringify(HV_FILES["meta.json"]));
      writeFileSync(join(dir, "postprocess.json"), JSON.stringify({ steps: { final: null } }));
      writeFileSync(join(dir, "transcript.json"), `${JSON.stringify(HV_LINES[0])}\n`);
      writeFileSync(join(dir, "transcript.final.json"), `${JSON.stringify(HV_LINES[0])}\n`);
      // As with no `final` step at all: the accurate pass's file is read.
      expect(readHarkViewerFolder(dir).final?.map((l) => l.text)).toEqual(["hello there"]);
    } finally {
      t.cleanup();
    }
  });
});
