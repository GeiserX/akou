/**
 * The capture helper's device query (`akou-capture devices`, docs/DESIGN.md section 2.4), as
 * `GET /devices` answers it (PROGRAMMABILITY.md PG-A8): the inputs and outputs the OS lists, read
 * without opening a stream or asking for a permission, with the ids `--mic` and `dictation.mic`
 * take. A helper that refuses (`AKOU_CAPTURE_FILE_ONLY=1`, no audio system) answers its own reason,
 * never an empty list.
 */

import { realClock, withDeadline } from "./engine.ts";
import { parseStderrLine } from "./protocol.ts";

/** One device as the helper lists it. */
export interface Device {
  id: string;
  name: string;
  default: boolean;
}

export interface DeviceList {
  /** The audio system that answered (`coreaudio`, `wasapi`, `pulse`, or a fake's). */
  backend: string;
  inputs: Device[];
  outputs: Device[];
}

export type DevicesAnswer =
  | { ok: true; list: DeviceList }
  | { ok: false; code: string; message: string };

/** The query reads properties only; one that has not answered by then answers nothing. */
export const DEVICES_DEADLINE_MS = 10_000;

const isDevice = (v: unknown): v is Device => {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.id === "string" && typeof d.name === "string" && typeof d.default === "boolean";
};

/** The `devices` line of the helper's stdout, or null when the line is not one. */
export function parseDevices(line: string): DeviceList | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const r = o as Record<string, unknown>;
  if (r.type !== "devices" || typeof r.backend !== "string") return null;
  if (!Array.isArray(r.inputs) || !r.inputs.every(isDevice)) return null;
  if (!Array.isArray(r.outputs) || !r.outputs.every(isDevice)) return null;
  return { backend: r.backend, inputs: r.inputs, outputs: r.outputs };
}

/** Runs `argv` (the helper's command and `devices`) and answers its list or its refusal. */
export async function queryDevices(
  argv: readonly string[],
  deadlineMs = DEVICES_DEADLINE_MS,
): Promise<DevicesAnswer> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    // The environment as it is now, so `AKOU_CAPTURE_FILE_ONLY` set after start still reaches it.
    proc = Bun.spawn([...argv], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
  } catch (err) {
    return {
      ok: false,
      code: "no_helper",
      message: `the capture helper did not start: ${(err as Error).message}`,
    };
  }
  const read = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const r = await withDeadline(realClock, read, deadlineMs);
  if (!r.ok) {
    proc.kill("SIGKILL");
    return { ok: false, code: "timeout", message: "the capture helper did not list its devices" };
  }
  const [out, err, code] = r.value;
  for (const line of out.split("\n")) {
    const list = parseDevices(line.trim());
    if (code === 0 && list) return { ok: true, list };
  }
  for (const line of err.split("\n")) {
    const m = parseStderrLine(line);
    if (m.kind === "msg" && m.msg.type === "warn")
      return { ok: false, code: m.msg.code, message: m.msg.msg };
  }
  return {
    ok: false,
    code: "no_devices",
    message: `the capture helper listed no devices (exit ${code})`,
  };
}
