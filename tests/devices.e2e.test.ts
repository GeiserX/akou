/**
 * The capture devices and the apps with audio over the API (docs/ux/PROGRAMMABILITY.md PG-A8):
 * `GET /devices` and `GET /apps` answer the capture helper's device query, here the fake helper's
 * (`scripts/fake-helper.ts devices`), with the ids `POST /calls` takes as `mic` and
 * `call: "app:<id>"`; `akou devices` and `akou apps` print them; a helper that refuses
 * (`AKOU_CAPTURE_FILE_ONLY=1`) is answered as a refusal, never as an empty list.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { Router } from "../src/main/api/http.ts";
import { deviceRoutes } from "../src/main/api/routes/devices.ts";
import { type ApiApp, routeRequest } from "../src/main/api/server.ts";
import { type CaptureDevices, queryDevices } from "../src/main/capture/devices.ts";
import { EXIT } from "../src/main/cli/client.ts";
import { type AppRig, appRig, FAKE_HELPER } from "./api-helpers.ts";
import { rigCli } from "./cli-helpers.ts";

let rig: AppRig;

beforeAll(async () => {
  rig = await appRig();
});

afterAll(async () => {
  await rig?.close();
});

/** Runs `fn` with `AKOU_CAPTURE_FILE_ONLY=1` in the environment the helper inherits. */
async function fileOnly<T>(fn: () => Promise<T>): Promise<T> {
  const was = process.env.AKOU_CAPTURE_FILE_ONLY;
  process.env.AKOU_CAPTURE_FILE_ONLY = "1";
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env.AKOU_CAPTURE_FILE_ONLY;
    else process.env.AKOU_CAPTURE_FILE_ONLY = was;
  }
}

describe("[PG-A8] GET /devices and GET /apps", () => {
  test("list the helper's devices and apps, with ids POST /calls takes as mic and call", async () => {
    const devices = await rig.api("GET", "/devices");
    expect(devices.status).toBe(200);
    expect(devices.body.inputs.map((d: { id: string }) => d.id)).toEqual([
      "fake-mic-1",
      "fake-usb-2",
    ]);
    expect(devices.body.outputs).toEqual([
      { id: "fake-out-1", name: "Fake Speakers", default: true },
    ]);
    const apps = await rig.api("GET", "/apps");
    expect(apps.status).toBe(200);
    expect(apps.body.apps[0]).toEqual({ id: "com.example.call", name: "Example Call", pid: 4242 });

    // The ids as they came: the second input, not the default, and the first app.
    const mic = devices.body.inputs[1];
    const id = await rig.startCall({ mic: mic.id, call: `app:${apps.body.apps[0].id}` });
    try {
      const events = (await rig.api("GET", `/calls/${id}/events`)).body.events as LogEvent[];
      const part = events.find((e) => e.type === "part.started") as unknown as {
        mic: string;
        call: { mode: string };
      };
      expect(part.mic).toBe(mic.name);
      expect(part.call.mode).toBe("app:com.example.call");
    } finally {
      expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);
    }
    // Positive control: an app id the helper does not list is refused by the helper.
    const none = await rig.api("POST", "/calls", { call: "app:com.example.none" });
    expect([none.status, none.body.error]).toEqual([503, "capture_failed"]);
    expect(none.body.message).toContain("no running app matches com.example.none");
  });

  test("with AKOU_CAPTURE_FILE_ONLY=1 both routes answer the helper's refusal, not an empty list", async () => {
    await fileOnly(async () => {
      for (const path of ["/devices", "/apps"]) {
        const r = await rig.api("GET", path);
        expect([path, r.status, r.body.error, r.body.helper]).toEqual([
          path,
          503,
          "devices_unavailable",
          "file-only",
        ]);
        expect(r.body.message).toContain("AKOU_CAPTURE_FILE_ONLY=1");
        expect(r.body.inputs).toBeUndefined();
        expect(r.body.apps).toBeUndefined();
      }
    });
    // Positive control: without it the same route lists the devices.
    expect((await rig.api("GET", "/devices")).status).toBe(200);
  });

  test("akou devices and akou apps print the ids, --json is the route's body, a refusal exits 69", async () => {
    const run = rigCli(rig);
    const devices = await run(["devices"]);
    expect(devices.code).toBe(0);
    expect(devices.out).toContain("* Fake Microphone  fake-mic-1");
    expect(devices.out).toContain("  Fake USB Microphone  fake-usb-2");
    expect(devices.out).toContain("Fake Speakers  fake-out-1");
    const json = await run(["devices", "--json"]);
    expect(json.json.inputs).toEqual((await rig.api("GET", "/devices")).body.inputs);
    const apps = await run(["apps"]);
    expect(apps.code).toBe(0);
    expect(apps.out).toContain("Example Call  com.example.call  pid 4242");
    expect((await run(["apps", "--json"])).json.apps.length).toBe(2);
    const refused = await fileOnly(() => run(["devices"]));
    expect(refused.code).toBe(EXIT.unavailable);
    expect(refused.err).toContain("AKOU_CAPTURE_FILE_ONLY=1");
  });
});

describe("[PG-A8] where one app cannot be captured", () => {
  test("the helper says why, and GET /apps answers 501 apps_unavailable with it", async () => {
    const d = await queryDevices([process.execPath, FAKE_HELPER, "--no-apps"]);
    expect(d.apps).toBeNull();
    expect(d.appsUnavailable).toBe("capturing one app is not available on this fake");
    expect(d.inputs.length).toBe(2);

    const r = new Router<ApiApp>();
    deviceRoutes(r);
    const app = (devices: CaptureDevices) =>
      ({ devices: async () => devices }) as unknown as ApiApp;
    const get = async (path: string, devices: CaptureDevices) => {
      const res = await routeRequest(r, app(devices), new Request(`http://127.0.0.1/v1${path}`), {
        by: "user",
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const apps = await get("/apps", d);
    expect([apps.status, apps.body.error, apps.body.message]).toEqual([
      501,
      "apps_unavailable",
      "capturing one app is not available on this fake",
    ]);
    // The devices still list, and with an app list the same route answers it.
    expect((await get("/devices", d)).status).toBe(200);
    const listed = await get("/apps", { ...d, apps: [], appsUnavailable: null });
    expect([listed.status, listed.body.apps]).toEqual([200, []]);
  });
});
