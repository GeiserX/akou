/**
 * `GET /devices` (docs/ux/PROGRAMMABILITY.md PG-A8) and the Dictation page's microphone picker it
 * feeds (docs/ux/DICTATION.md DC-U4), through a whole app over the fake helper: the route lists the
 * helper's devices, refuses with the helper's own reason under `AKOU_CAPTURE_FILE_ONLY=1`, and an
 * input it lists, once saved as `dictation.mic` as the picker saves it, reaches the dictation
 * helper as `rebuild_mic`. The picker's drawing of the list is `tests/ui/dictation.test.ts`'s.
 * Nothing opens a device.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

setDefaultTimeout(30_000);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function rig(o: Parameters<typeof appRig>[0] = {}): Promise<AppRig> {
  const r = await appRig(o);
  cleanups.push(() => r.close());
  return r;
}

describe("PG-A8: GET /devices", () => {
  test("lists the helper's inputs and outputs with their ids", async () => {
    const r = await rig();
    const res = await r.api("GET", "/devices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      backend: "fake",
      inputs: [
        { id: "fake-built-in", name: "Built-in Microphone", default: true },
        { id: "fake-usb", name: "USB Microphone", default: false },
      ],
      outputs: [{ id: "fake-speakers", name: "Speakers", default: true }],
    });
  });

  test("with AKOU_CAPTURE_FILE_ONLY=1 it answers the helper's refusal, not an empty list", async () => {
    const r = await rig();
    const was = process.env.AKOU_CAPTURE_FILE_ONLY;
    process.env.AKOU_CAPTURE_FILE_ONLY = "1";
    try {
      const res = await r.api("GET", "/devices");
      expect(res.status).toBe(503);
      // The picker shows the message beside its text box (src/ui/dictation-mic.ts readMics).
      expect(res.body).toMatchObject({
        error: "file-only",
        message: expect.stringContaining("AKOU_CAPTURE_FILE_ONLY=1"),
      });
    } finally {
      if (was === undefined) delete process.env.AKOU_CAPTURE_FILE_ONLY;
      else process.env.AKOU_CAPTURE_FILE_ONLY = was;
    }
  });

  test("a helper that is not there is a refusal with its reason", async () => {
    const r = await rig({ settings: { "capture.helper": ["/nonexistent/akou-capture"] } });
    const res = await r.api("GET", "/devices");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "no_helper" });
  });
});

describe("DC-U4: the picker over the real route", () => {
  test("the picker lists the helper's microphones, and the one chosen reaches the helper", async () => {
    const t = tempDir("akou-devices-");
    cleanups.push(t.cleanup);
    const commands = join(t.dir, "commands.jsonl");
    const r = await rig({
      helperArgs: ["--commands-log", commands],
      settings: { "dictation.enabled": true },
    });
    // What the picker reads (src/ui/dictation-mic.ts readMics): the route's `inputs`.
    const inputs = (await r.api("GET", "/devices")).body.inputs as { id: string; name: string }[];
    expect(inputs.map((d) => d.name)).toEqual(["Built-in Microphone", "USB Microphone"]);
    await until(() => r.app.dictation()?.status().state === "idle", 10_000, "the helper ready");
    const chosen = inputs[1]?.id;
    expect(chosen).toBe("fake-usb");
    expect((await r.api("PATCH", "/config", { "dictation.mic": chosen })).status).toBe(200);
    const rebuilt = () =>
      existsSync(commands)
        ? readFileSync(commands, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { type: string; device?: string })
            .filter((c) => c.type === "rebuild_mic")
            .map((c) => c.device)
        : [];
    await until(() => rebuilt().includes("fake-usb"), 10_000, "rebuild_mic with the choice");
    // After ready the helper got the setting as it was (none: the default), then the choice.
    expect(rebuilt()).toEqual(["default", "fake-usb"]);
  });
});
