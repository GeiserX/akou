/**
 * The capture helper's device query (docs/DESIGN.md section 2.4, docs/ux/PROGRAMMABILITY.md
 * PG-A8): `akou-capture devices` prints one JSON line with the inputs, the outputs and the apps
 * with audio, and `GET /devices` and `GET /apps` answer from it. The ids are the ones `POST /calls`
 * takes as `mic` and as `call: "app:<id>"`.
 *
 * A helper that refuses (`AKOU_CAPTURE_FILE_ONLY=1`, no audio service) or is not there throws
 * `DevicesRefused` with its reason: the routes answer it, never an empty list.
 */

import { parseStderrLine } from "./protocol.ts";

/** How long the query may take: it opens no stream, but an audio service can be slow to answer. */
export const DEVICES_TIMEOUT_MS = 15_000;

export interface CaptureDevice {
  /** What `mic` takes (an input), or the output's id. */
  id: string;
  name: string;
  default: boolean;
}

export interface AudioApp {
  /** What `call: "app:<id>"` takes. */
  id: string;
  name: string;
  pid: number;
}

export interface CaptureDevices {
  backend: string;
  inputs: CaptureDevice[];
  outputs: CaptureDevice[];
  /** The apps with audio, or null where one app cannot be captured (`appsUnavailable` says why). */
  apps: AudioApp[] | null;
  appsUnavailable: string | null;
}

export class DevicesRefused extends Error {
  override name = "DevicesRefused";
  constructor(
    message: string,
    /** The helper's own code (`file-only`, `unavailable`, ...), or `no-helper`, `bad-answer`. */
    readonly helperCode: string,
  ) {
    super(message);
  }
}

const isDevice = (d: unknown): d is CaptureDevice => {
  const o = d as Record<string, unknown> | null;
  return typeof o?.id === "string" && typeof o.name === "string" && typeof o.default === "boolean";
};

const isApp = (d: unknown): d is AudioApp => {
  const o = d as Record<string, unknown> | null;
  return typeof o?.id === "string" && typeof o.name === "string" && typeof o.pid === "number";
};

/** The helper's `devices` line, checked; throws `DevicesRefused` on anything else. */
export function parseDevicesLine(line: string): CaptureDevices {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    throw new DevicesRefused("the capture helper's device list is not JSON", "bad-answer");
  }
  const inputs = o?.inputs;
  const outputs = o?.outputs;
  if (
    o?.type !== "devices" ||
    typeof o.backend !== "string" ||
    !Array.isArray(inputs) ||
    !inputs.every(isDevice) ||
    !Array.isArray(outputs) ||
    !outputs.every(isDevice)
  ) {
    throw new DevicesRefused(
      "the capture helper's device list is not one akou reads",
      "bad-answer",
    );
  }
  const apps = Array.isArray(o.apps) ? o.apps.filter(isApp) : null;
  const why =
    typeof o.apps_unavailable === "string"
      ? o.apps_unavailable
      : apps === null
        ? "this capture helper lists no apps; update akou"
        : null;
  return { backend: o.backend, inputs, outputs, apps, appsUnavailable: why };
}

/**
 * Runs `<command> devices` and reads its answer. The helper inherits akou's environment, so
 * `AKOU_CAPTURE_FILE_ONLY=1` reaches it and it refuses.
 */
export async function queryDevices(
  command: readonly string[],
  o: { timeoutMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<CaptureDevices> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...command, "devices"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: o.env ?? process.env,
    });
  } catch (err) {
    throw new DevicesRefused(
      `the capture helper ${command[0]} could not start: ${(err as Error).message}`,
      "no-helper",
    );
  }
  const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? DEVICES_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (proc.signalCode) {
      throw new DevicesRefused("the capture helper did not list the devices in time", "timeout");
    }
    if (code !== 0) {
      // The helper says why on stderr, as a `warn` line: the refusal is that, word for word.
      for (const line of err.split("\n").reverse()) {
        const l = parseStderrLine(line);
        if (l.kind === "msg" && l.msg.type === "warn")
          throw new DevicesRefused(l.msg.msg, l.msg.code);
      }
      throw new DevicesRefused(
        `the capture helper could not list the devices (exit ${code})`,
        "unavailable",
      );
    }
    const line = out.split("\n").find((l) => l.trim() !== "");
    if (line === undefined) {
      throw new DevicesRefused("the capture helper answered nothing", "bad-answer");
    }
    return parseDevicesLine(line);
  } finally {
    clearTimeout(timer);
  }
}
