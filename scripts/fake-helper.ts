#!/usr/bin/env bun
/**
 * A fake capture helper for tests. It speaks `akou-capture/1` (docs/DESIGN.md section 2.4) and
 * replays a stereo WAV (left = mic, right = call) or a generated speech-like signal as packets,
 * paced in real time or faster. It opens no audio device and plays nothing.
 *
 *   bun scripts/fake-helper.ts run --out FILE --mic default --call system [switches]
 *
 * Switches that simulate the capture traps (docs/TRAPS.md):
 *
 *   --wav FILE                 source audio (16-bit stereo WAV at 16 kHz); default: generated
 *   --speed X                  1 = real time (default); 10 = ten times faster
 *   --packet-ms N              packet length, default 20
 *   --capturing-delay MS       a slow (cold) open before `capturing`
 *   --exit-before-capturing N  exit with code N before `capturing` (77 = permission)
 *   --call-silent              the call side is silent from the start: zero-filled call packets,
 *                              output device not running
 *   --call-omit                call packets are never sent at all (a helper without an aligner)
 *   --call-dead-at S           the call tap stops delivering at S seconds while output keeps
 *                              running (zero-filled packets); the dead-call monitor rebuilds it
 *                              after 1 s
 *   --call-zeros-at S          the call side delivers buffers of zeros from S seconds while output
 *                              keeps running; the dead-call monitor waits 10 s, then rebuilds
 *   --rebuild-heals            a `rebuild_call` brings a dead call side back
 *   --hang-on-stop             `stop` and closing stdin are ignored: a hung teardown
 *   --crash-at S               exit 70 at S seconds, without `stopped`
 *   --stall-at S               stop sending packets at S seconds, stay alive
 *   --sleep-at S --sleep-for S the host clock jumps by the given seconds (machine sleep)
 *   --dialect stereo-s16le     behave like hark instead: raw 16-bit stereo on stdout, no JSON,
 *                              stop on SIGINT; `--duration S` ends at S seconds of audio
 *
 * Times are seconds of audio (the file timeline), so a test at `--speed 20` is deterministic.
 *
 * `dictate` speaks `akou-dictate/1` instead (docs/ux/DICTATION.md section 9, DC-T1), the same
 * lines as `akou-capture dictate` (tests/fixtures/akou-dictate/): scripted keys through the port
 * of the real helper's activation rule (`src/core/dictation/activation.ts`), a WAV as the mic, and
 * a fake inserter. It opens no device, reads no key, types nothing and never touches the clipboard.
 *
 *   bun scripts/fake-helper.ts dictate [switches]
 *
 *   --wav FILE              the mic: a 16 kHz 16-bit WAV (mono, or its channels averaged);
 *                           default silence. Sample 0 is key time 0
 *   --keys FILE             scripted keys, JSON lines `{"at": MS, "key": "RightCommand",
 *                           "down": true}`, played once after the first `rebind`
 *   --speed X               0 = as fast as possible (default); 1 = key times in real time
 *   --grants LIST           the grants `ready` reports as `granted`: `mic,accessibility`
 *                           (default), or fewer; the others are `denied`
 *   --not-asked LIST        of the grants not given, those reported as `not-asked` instead of
 *                           `denied`, as a macOS microphone never asked for (DC-N3)
 *   --backend NAME          the key source `ready` reports (default `fake`)
 *   --probe                 prints the `ready` line and exits, as `akou-capture dictate --probe`
 *   --probe-grants LIST     the grants `--probe` reports instead of `--grants`: a grant given
 *                           after the helper started (DC-U2, DC-N3)
 *   --recorder-keys LIST    the keys reported as `key` when `record_keys {on: true}` arrives, as
 *                           the helper reports every key while the recorder is open (DC-U3)
 *   --no-swallow            `swallow_keys: false`, as the portal and CLI backends (DC-A4): Escape
 *                           and Enter never reach the activation rule, so they pass through to
 *                           the app and are never reported
 *   --field KIND            the target field: editable (default), not-editable, unknown, secure
 *   --target-app ID         the target app (default `com.example.editor`)
 *   --ax FILE               the scripted accessibility tree, the same lines as the real helper's
 *                           `--ax fake FILE`: `<ms> {"app","pid","window","field"}` per line, the
 *                           last line at or before a moment being what has the keyboard then (at
 *                           a key-down, and at the insert, which lands at the key time reached).
 *                           The insert then runs the real helper's guards in its order: a secure
 *                           field gets the clipboard only; another app, pid or window fails it
 *                           `focus-changed`; a field that is not editable fails it `not-editable`,
 *                           an unknown one `field-unknown` (DC-N8, DC-N9). Replaces --field and
 *                           --target-app
 *   --tap-log FILE          every key, JSON lines `{key, down, swallowed}` (or `lost`)
 *   --inserter-log FILE     every `insert`, JSON lines, with the fake's time `at` (ms), and the
 *                           send key it pressed after the receipt, `{"type":"send","key","at"}`
 *                           (DC-S2): never before the target read, never after a clipboard-only
 *                           insert or a refused one
 *   --commands-log FILE     every command the app sent, one JSON line each
 *   --receipt-ms N          the fake target reads the clipboard N ms after the insert (default 5)
 *   --no-receipt            the target never reads it: no `inserted` ever comes, and no send key
 *                           is pressed; `insert.failed` with `no-receipt` follows after
 *                           `--receipt-timeout-ms` (default 8000, the real helper's receipt timeout)
 *   --bind-fail             every `rebind` is refused with `rebind.failed`
 *   --refuse-hotkey KEY     a `rebind` to this hotkey is refused; the binding in force stays (DC-A7)
 *   --play-after-rebinds N  the scripted keys play after the Nth `rebind` (default 1), refused or
 *                           not, so a test can change the key first and then press it
 *
 * The traps (DC-T1), one switch each:
 *
 *   --slow-mic MS           the mic opens MS after the key-down: `session.started` waits for it
 *                           (the readiness gate, DC-N4)
 *   --focus-change          the target lost focus before the insert: `insert.failed` (DC-N9).
 *                           A `focus {target}` (the draft box's Enter) brings the target back:
 *                           from then until the next session, inserts land there
 *   --dormant-tree          the field cannot be read back: `edit.unreadable` after an insert
 *                           with `read_field` (DC-L2)
 *   --edit JSON             the hunks of the user's fix in the field, sent as `edit` right after
 *                           the receipt of an insert with `read_field` (the real helper sends it
 *                           at a commit key or after 60 s); default `[]`, nothing changed. Every
 *                           paste with `read_field` gets exactly one `edit` or `edit.unreadable`
 *   --tap-disabled-at MS    the first key event at or after MS finds the tap disabled and is lost;
 *                           the tap is re-enabled from that callback (DC-N1)
 *   --deaf-start            `session.start` is read and dropped, as the real helper drops it while
 *                           an insert settles: the app must not answer that it is listening
 *
 * A line from the app that asks for a permission prompt (`"prompt": true` anywhere in it) fails the
 * run: a `warn prompting-grant` line and exit 70, so the test that sent it fails. The helper only
 * ever asks the non-prompting checks, and no test may show a permission dialog (DC-N10, DC-N3).
 *
 * `session.start`, `session.stop` and `session.cancel` (the tray's and the CLI's door) run through
 * the same rule: a latched session from the key time reached so far, whose audio lasts as long as
 * the session did in real time.
 *
 * A remote that times out is the remote's trap, not the helper's: lane D's server rig has it.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Activation,
  ActivationMachine,
  type ActivationOut,
  type KeyInput,
  parseBinding,
} from "../src/core/dictation/activation.ts";
import { DeadCallMonitor } from "../src/main/capture/health.ts";
import { CAPTURE_RATE, EXIT, encodePacket, type Packet } from "../src/main/capture/protocol.ts";
import {
  type AppToHelper,
  DICTATE_PROTOCOL,
  type FieldKind,
  parseCommand,
  type Target,
} from "../src/main/dictation/protocol.ts";
import { readUploadAudio } from "../src/main/server/audio.ts";
import { readStereoWav, speechLike } from "../tests/fixtures/audio.ts";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (name: string): number | undefined => {
  const v = opt(name);
  return v === undefined ? undefined : Number(v);
};

const dialect = opt("--dialect") ?? "akou-capture/1";
const speed = num("--speed") ?? 1;
const packetMs = num("--packet-ms") ?? 20;
const frames = Math.round((CAPTURE_RATE * packetMs) / 1000);
const out = opt("--out");
const micMode = opt("--mic") ?? "default";
const callMode = opt("--call") ?? "system";

const src = (() => {
  const wav = opt("--wav");
  if (argv.includes("dictate")) return { mic: new Float32Array(0), call: new Float32Array(0) };
  if (wav) {
    const s = readStereoWav(new Uint8Array(readFileSync(wav)));
    if (s.rate !== CAPTURE_RATE) throw new Error(`fake helper needs a ${CAPTURE_RATE} Hz WAV`);
    return { mic: s.left, call: s.right };
  }
  return { mic: speechLike(30, { f0: 120, seed: 7 }), call: speechLike(30, { f0: 210, seed: 11 }) };
})();

function slice(x: Float32Array, start: number, n: number): Float32Array {
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) r[i] = x[(start + i) % x.length] as number;
  return r;
}

const stdout = Bun.stdout.writer();
const say = (o: Record<string, unknown>) => process.stderr.write(`${JSON.stringify(o)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const hostNs = () => process.hrtime.bigint();

let stopRequested = false;
let paused = false;
let callHealed = false;
let frame = 0; // file timeline, in frames

function finish(reason: string): never {
  if (dialect === "akou-capture/1")
    say({ type: "stopped", file_seconds: frame / CAPTURE_RATE, reason });
  stdout.flush();
  process.exit(EXIT.ok);
}

function onStop(): void {
  if (flag("--hang-on-stop")) {
    // A teardown that never returns: no more audio, no exit.
    stopRequested = true;
    setInterval(() => {}, 1 << 30);
    return;
  }
  stopRequested = true;
}

async function readStdin(): Promise<void> {
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of Bun.stdin.stream()) {
    rest += dec.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines.map((l) => l.trim())) {
      if (line === "stop") onStop();
      else if (line === "pause") paused = true;
      else if (line === "resume") paused = false;
      else if (line === "rebuild_call" && flag("--rebuild-heals")) callHealed = true;
    }
  }
  // Closing stdin means stop.
  onStop();
}

async function runHark(): Promise<void> {
  process.on("SIGINT", () => {
    stopRequested = true;
  });
  const duration = num("--duration");
  const t0 = performance.now();
  while (!stopRequested) {
    if (duration !== undefined && frame >= duration * CAPTURE_RATE) break;
    const n =
      duration !== undefined
        ? Math.min(frames, Math.round(duration * CAPTURE_RATE) - frame)
        : frames;
    const mic = slice(src.mic, frame, n);
    const call = slice(src.call, frame, n);
    const bytes = new Uint8Array(n * 4);
    const v = new DataView(bytes.buffer);
    const s16 = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    for (let i = 0; i < n; i++) {
      v.setInt16(i * 4, s16(mic[i] as number), true);
      v.setInt16(i * 4 + 2, s16(call[i] as number), true);
    }
    stdout.write(bytes);
    stdout.flush();
    frame += n;
    if (speed > 0) await sleep(t0 + ((frame / CAPTURE_RATE) * 1000) / speed - performance.now());
  }
  stdout.flush();
  process.exit(EXIT.ok);
}

async function runAkou(): Promise<void> {
  void readStdin();
  say({ type: "hello", protocol: "akou-capture/1", version: "0.0.0-fake", caps: ["fake"] });
  const delay = num("--capturing-delay");
  if (delay) {
    // A slow open that a stop cancels, as the real helper's open is abandoned on stop.
    const end = performance.now() + delay;
    while (performance.now() < end && !stopRequested) await sleep(10);
  }
  const exitCode = num("--exit-before-capturing");
  if (exitCode !== undefined) {
    say({
      type: "warn",
      code: exitCode === EXIT.permission ? "permission" : "open",
      msg: "fake open failure",
    });
    process.exit(exitCode);
  }
  if (stopRequested && !flag("--hang-on-stop")) finish("stop");
  if (out) writeFileSync(out, "");
  const anchor = hostNs();
  say({
    type: "capturing",
    mic: micMode === "none" ? null : { id: micMode, name: "Fake Microphone", rate: 48000 },
    call: callMode === "none" ? null : { mode: callMode, rate: 48000 },
    exclude: ["akou Graphics and Media"],
    capture_ns: anchor.toString(),
  });

  const callSilent = flag("--call-silent");
  const callOmit = flag("--call-omit");
  const deadAt = num("--call-dead-at");
  const zerosAt = num("--call-zeros-at");
  const crashAt = num("--crash-at");
  const stallAt = num("--stall-at");
  const sleepAt = num("--sleep-at");
  const sleepFor = num("--sleep-for") ?? 0;
  const monitor = new DeadCallMonitor(0);
  const first = { mic: false, call: false };
  let hostOffset = 0n; // paused and slept time on the host clock, beyond the file timeline
  let slept = false;
  let sinceLevel = 0;
  const t0 = performance.now();
  let wallAudio = 0; // seconds of timeline paced so far, pause included

  while (true) {
    if (stopRequested) {
      if (flag("--hang-on-stop")) {
        await sleep(1000);
        continue;
      }
      finish("stop");
    }
    const t = frame / CAPTURE_RATE;
    const step = frames / CAPTURE_RATE;
    wallAudio += step;
    if (speed > 0) await sleep(t0 + (wallAudio * 1000) / speed - performance.now());
    if (paused) {
      hostOffset += BigInt(Math.round(step * 1e9));
      continue;
    }
    if (crashAt !== undefined && t >= crashAt) process.exit(EXIT.software);
    if (stallAt !== undefined && t >= stallAt) {
      hostOffset += BigInt(Math.round(step * 1e9));
      continue;
    }
    if (sleepAt !== undefined && !slept && t >= sleepAt) {
      slept = true;
      hostOffset += BigInt(Math.round(sleepFor * 1e9));
    }
    const captureNs = anchor + BigInt(Math.round(t * 1e9)) + hostOffset;
    const packets: Packet[] = [];
    if (micMode !== "none") {
      packets.push({
        ch: "mic",
        zeroFilled: false,
        captureNs,
        fileSeconds: t,
        samples: slice(src.mic, frame, frames),
      });
    }
    const dead = deadAt !== undefined && t >= deadAt && !callHealed;
    const zeros = zerosAt !== undefined && t >= zerosAt && !callHealed;
    const callDelivered = callMode !== "none" && !callSilent && !dead;
    const callAudible = callDelivered && !zeros;
    if (callMode !== "none" && !callOmit) {
      packets.push({
        ch: "call",
        zeroFilled: !callDelivered,
        captureNs,
        fileSeconds: t,
        samples: callAudible ? slice(src.call, frame, frames) : new Float32Array(frames),
      });
    }
    for (const p of packets) {
      stdout.write(encodePacket(p));
      if (!p.zeroFilled && !first[p.ch]) {
        first[p.ch] = true;
        say({ type: "first_audio", ch: p.ch, capture_ns: captureNs.toString() });
      }
    }
    stdout.flush();
    if (deadAt !== undefined || zerosAt !== undefined) {
      const emit = (a: ReturnType<DeadCallMonitor["tick"]>[number]) => {
        if (a.kind !== "health") return;
        say({
          type: "health",
          ch: "call",
          state: a.state,
          silent_for: a.silentFor,
          rebuilds: a.rebuilds,
          detail: a.detail,
        });
      };
      const tick = {
        t,
        outputRunning: !callSilent,
        heard: callAudible,
        delivered: callDelivered,
      };
      for (const a of monitor.tick(tick)) {
        // The probe runs on the output, which is still playing, so it hears audio.
        if (a.kind === "probe") for (const r of monitor.probeResult(t, true)) emit(r);
        else emit(a);
      }
    }
    sinceLevel += step;
    if (sinceLevel >= 0.25) {
      sinceLevel = 0;
      say({ type: "level", mic_dbfs: -20, call_dbfs: callAudible ? -24 : -120 });
    }
    frame += frames;
  }
}

// ---------------------------------------------------------------------------
// `dictate`: akou-dictate/1

/** Pre-roll kept before the key-down, and post-roll after the release (DC-N4). */
const RING_MS = 500;
const POST_ROLL_MS = 250;

async function runDictate(): Promise<void> {
  const wav = opt("--wav");
  const mic = wav ? await readUploadAudio(wav) : new Float32Array(0);
  const keysFile = opt("--keys");
  const keys: KeyInput[] = keysFile
    ? readFileSync(keysFile, "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as KeyInput)
    : [];
  const log = (file: string | undefined, o: unknown) => {
    if (file) appendFileSync(file, `${JSON.stringify(o)}\n`);
  };
  const grants = (opt("--grants") ?? "mic,accessibility").split(",");
  const field = (opt("--field") ?? "editable") as FieldKind;
  const target: Target = {
    app: opt("--target-app") ?? "com.example.editor",
    pid: 4242,
    window: "w1",
    field,
  };
  const axFile = opt("--ax");
  const ax = axFile ? parseAx(readFileSync(axFile, "utf8")) : null;
  /** What has the keyboard at key time `ms`: the tree's last line at or before it. */
  const targetAt = (ms: number): Target =>
    ax ? (ax.findLast((l) => l.at <= ms)?.target ?? UNKNOWN_TARGET) : target;
  /** The sessions' targets captured at key-down, by session id, for the insert's guards. */
  const captured = new Map<string, Target>();
  /** What a `focus` brought forward: it has the keyboard until the next session. */
  let focused: Target | null = null;
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const receiptMs = num("--receipt-ms") ?? 5;
  const slowMic = num("--slow-mic") ?? 0;
  const tapDisabledAt = num("--tap-disabled-at");
  let tapDisabled = tapDisabledAt !== undefined;
  let played = false;
  let rebinds = 0;
  const playAfter = num("--play-after-rebinds") ?? 1;
  let sessions = 0;
  let stopping = false;
  const noSwallow = flag("--no-swallow");

  const sessionAudio = (from: number, to: number): number => {
    // The ring holds the half second before the key-down; the post-roll runs past the release.
    const a = Math.max(0, Math.round(((from - RING_MS) * CAPTURE_RATE) / 1000));
    const b = Math.max(a, Math.round(((to + POST_ROLL_MS) * CAPTURE_RATE) / 1000));
    let sent = 0;
    for (let at = a; at < b; at += frames) {
      const n = Math.min(frames, b - at);
      const samples = new Float32Array(n);
      samples.set(mic.subarray(Math.min(at, mic.length), Math.min(at + n, mic.length)));
      stdout.write(
        encodePacket({
          ch: "mic",
          zeroFilled: false,
          captureNs: BigInt(Math.round((at / CAPTURE_RATE) * 1e9)),
          // As the real helper: a session's audio is numbered from 0.
          fileSeconds: (at - a) / CAPTURE_RATE,
          samples,
        }),
      );
      sent += n;
      let s2 = 0;
      for (const x of samples) s2 += x * x;
      say({ type: "level", rms: Math.sqrt(s2 / Math.max(1, n)) });
    }
    stdout.flush();
    return sent;
  };

  let machine: ActivationMachine | null = null;
  let open: { id: string; at: number } | null = null;
  /** A session started by `session.start`: its key time, and the real time it began. */
  let started: { at: number; real: number } | null = null;
  /** The key time the script has reached, ms. */
  let clock = 0;
  const act = async (outs: ActivationOut[]) => {
    for (const o of outs) {
      if (o.type === "key") say({ type: "key", name: o.name });
      else if (o.type === "start") {
        if (slowMic > 0) await sleep(slowMic);
        open = { id: String(++sessions), at: o.at };
        captured.set(open.id, targetAt(o.at));
        focused = null;
        say({
          type: "session.started",
          id: open.id,
          target: targetAt(o.at),
          capture_ns: String(BigInt(Math.round(o.at)) * 1_000_000n),
        });
      } else if (open) {
        // A cancel or a stop ends at once; anything else runs the post-roll.
        const cut = o.reason === "cancel" || o.reason === "stop";
        sessionAudio(open.at, cut ? clock - POST_ROLL_MS : clock);
        say({ type: "session.ended", id: open.id, reason: o.reason });
        open = null;
      }
    }
  };

  /** Plays the scripted keys through the binding in force at each key. */
  const play = async () => {
    const tStart = performance.now();
    for (const k of keys) {
      if (speed > 0) await sleep(tStart + k.at / speed - performance.now());
      clock = k.at;
      if (tapDisabled && tapDisabledAt !== undefined && k.at >= tapDisabledAt) {
        // The event that finds the tap disabled is lost; the callback re-enables the tap.
        tapDisabled = false;
        log(opt("--tap-log"), { key: k.key, down: k.down, lost: true });
        continue;
      }
      // A key source that cannot swallow never shows the rule Escape or Enter (DC-A4).
      if (noSwallow && PASS_THROUGH.has(k.key)) {
        log(opt("--tap-log"), { key: k.key, down: k.down, swallowed: false });
        continue;
      }
      // Time passes before the key, as the helper's tick does: a held modifier becomes a session.
      const m = machine as ActivationMachine;
      const outs: ActivationOut[] = [];
      m.tick(k.at, outs);
      const swallowed = m.key(k, outs);
      log(opt("--tap-log"), { key: k.key, down: k.down, swallowed });
      await act(outs);
    }
  };

  const handle = (c: AppToHelper) => {
    switch (c.type) {
      case "rebind": {
        rebinds++;
        const playNow = () => {
          if (!played && machine && rebinds >= playAfter) {
            played = true;
            void play();
          }
        };
        let m: ActivationMachine;
        try {
          if (flag("--bind-fail")) throw new Error("fake refusal");
          if (c.hotkey === opt("--refuse-hotkey"))
            throw new Error(`the fake cannot bind ${c.hotkey}`);
          m = new ActivationMachine(parseBinding(c.hotkey), c.activation as Activation);
        } catch (err) {
          say({ type: "rebind.failed", hotkey: c.hotkey, reason: (err as Error).message });
          playNow();
          return;
        }
        machine = m;
        say({ type: "rebound", hotkey: c.hotkey });
        playNow();
        return;
      }
      case "settled":
        machine?.settled();
        return;
      case "record_keys":
        if (c.on)
          for (const name of opt("--recorder-keys")?.split(",") ?? []) say({ type: "key", name });
        return;
      case "focus":
        focused = c.target;
        return;
      case "insert": {
        log(opt("--inserter-log"), { ...c, at: now() });
        if (flag("--no-receipt")) {
          // The real inserter gives up on a target that never read: no send key, then the failure.
          setTimeout(() => {
            machine?.settled();
            say({ type: "insert.failed", id: c.id, reason: "no-receipt" });
          }, num("--receipt-timeout-ms") ?? 8000);
          return;
        }
        // The guards look at the tree now, when the insert arrives, not after the receipt.
        // The app's target is the one to compare (the draft box names the session's).
        const cap = c.target ?? captured.get(c.id) ?? target;
        const refused = ax ? axRefusal(cap, focused ?? targetAt(clock)) : null;
        setTimeout(() => {
          machine?.settled();
          const failed = flag("--focus-change") && !focused ? "focus-changed" : refused;
          if (failed && c.method !== "clipboard" && failed !== "secure") {
            say({ type: "insert.failed", id: c.id, reason: failed });
            return;
          }
          if (failed === "secure") {
            say({ type: "inserted", id: c.id, method: "clipboard", receipt_ms: 0 });
            return;
          }
          // The send key only after the target read the text, and before the receipt is
          // reported, as the real inserter (DC-S2): whoever sees `inserted` sees the send too.
          if (c.method !== "clipboard" && c.send_key !== "none")
            log(opt("--inserter-log"), { type: "send", key: c.send_key, at: now() });
          say({ type: "inserted", id: c.id, method: c.method, receipt_ms: receiptMs });
          // DC-L2's read-back: one answer per paste that asked for it, never after the clipboard.
          if (c.read_field === true && c.method !== "clipboard") {
            if (flag("--dormant-tree"))
              say({ type: "edit.unreadable", id: c.id, reason: "unreadable" });
            else say({ type: "edit", id: c.id, hunks: JSON.parse(opt("--edit") ?? "[]") });
          }
        }, receiptMs);
        return;
      }
      case "session.start": {
        // The tray's and the CLI's door: a latched session, as if the key were tapped. Its audio
        // runs on the key clock from here, as long as the session lasts in real time.
        if (flag("--deaf-start")) return;
        const outs: ActivationOut[] = [];
        machine?.start(clock, outs);
        if (outs.length > 0) started = { at: clock, real: now() };
        void act(outs);
        return;
      }
      case "session.stop":
      case "session.cancel": {
        if (started && open) clock = Math.max(clock, started.at + (now() - started.real));
        started = null;
        const outs: ActivationOut[] = [];
        machine?.end(c.type === "session.stop" ? "tap" : "cancel", clock, outs);
        void act(outs);
        return;
      }
      case "stop": {
        stopping = true;
        const outs: ActivationOut[] = [];
        machine?.end("stop", clock, outs);
        void act(outs);
        return;
      }
      default:
        return;
    }
  };

  const given = flag("--probe") ? (opt("--probe-grants")?.split(",") ?? grants) : grants;
  const notAsked = opt("--not-asked")?.split(",") ?? [];
  const grant = (name: string) =>
    given.includes(name) ? "granted" : notAsked.includes(name) ? "not-asked" : "denied";
  say({
    type: "ready",
    protocol: DICTATE_PROTOCOL,
    version: "0.0.0-fake",
    backend: opt("--backend") ?? "fake",
    swallow_keys: !flag("--no-swallow"),
    grants: { mic: grant("mic"), accessibility: grant("accessibility") },
  });
  if (flag("--probe")) process.exit(EXIT.ok);
  const dec = new TextDecoder();
  let rest = "";
  for await (const chunk of Bun.stdin.stream()) {
    rest += dec.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (asksToPrompt(line)) {
        log(opt("--commands-log"), line);
        say({
          type: "warn",
          code: "prompting-grant",
          msg: "the app asked for a permission prompt; the helper only asks without prompting",
        });
        process.exit(EXIT.software);
      }
      const c = parseCommand(line);
      log(opt("--commands-log"), c ?? line);
      if (c) handle(c);
    }
    if (stopping) break;
  }
  // Closing stdin means stop. Inserts still waiting for their receipt are let go.
  stdout.flush();
  say({ type: "stopped", reason: "stop" });
  process.exit(EXIT.ok);
}

/** The keys a key source without `swallow_keys` never holds back (DC-A4). */
const PASS_THROUGH: ReadonlySet<string> = new Set(["Escape", "Enter", "Return", "KeypadEnter"]);

/** A line with `"prompt": true` at any depth: a request for a permission dialog (DC-N10). */
function asksToPrompt(line: string): boolean {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return false;
  }
  const walk = (v: unknown): boolean =>
    typeof v === "object" &&
    v !== null &&
    Object.entries(v).some(([k, x]) => (k === "prompt" && x === true) || walk(x));
  return walk(o);
}

/** An `--ax` script: `<ms> {target}` per line; blank lines and `#` lines are skipped. */
function parseAx(text: string): { at: number; target: Target }[] {
  const out: { at: number; target: Target }[] = [];
  text.split("\n").forEach((raw, n) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(\d+)\s+(\{.*\})$/.exec(line);
    if (!m) throw new Error(`ax line ${n + 1}: expected \`<ms> {...}\``);
    out.push({ at: Number(m[1]), target: JSON.parse(m[2] as string) as Target });
  });
  return out;
}

/** Before the tree's first line nothing is known about the keyboard, as the real helper says. */
const UNKNOWN_TARGET: Target = { app: "", pid: 0, window: "", field: "unknown" };

/**
 * The real helper's guards before an insert (native/akou-capture/src/dictate/insert.rs), from the
 * target the session captured and the one that has the keyboard now: `secure` means the clipboard
 * only; any other answer fails the insert. Null: insert.
 */
function axRefusal(cap: Target, now: Target): string | null {
  if (cap.field === "secure" || now.field === "secure") return "secure";
  if (cap.app !== now.app || cap.pid !== now.pid || cap.window !== now.window)
    return "focus-changed";
  if (now.field === "not-editable") return "not-editable";
  if (now.field !== "editable") return "field-unknown";
  return null;
}

if (argv.includes("dictate")) {
  await runDictate();
} else {
  // Switches may come before `run` too, so a configured command prefix (`capture.helper`) can
  // carry them: `bun fake-helper.ts --wav x.wav run --out ...`.
  if (!argv.includes("run") && dialect === "akou-capture/1") {
    process.stderr.write("usage: fake-helper.ts run --out FILE --mic M --call C [switches]\n");
    process.exit(EXIT.usage);
  }
  await (dialect === "stereo-s16le" ? runHark() : runAkou());
}
