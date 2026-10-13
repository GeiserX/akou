/**
 * The desktop app's history from a phone, end to end (docs/ux/SERVER.md SV-K3, the `network.*`
 * settings): the app in app mode with its keyed network listener on, a `read` key made with
 * `akou keys create` on this desktop install, then what the phone does over that listener: list
 * the calls, read a transcript, fetch a part's audio with `Range`, and be refused a change. The
 * listener binds 127.0.0.1 here, a typed address as `network.bind` allows, so any machine can run
 * it; the tailnet choice is checked with the interfaces the rig hands the app.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { networkInterfaces } from "node:os";
import { join } from "node:path";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { cli } from "./cli-helpers.ts";
import { clip } from "./server-helpers.ts";

setDefaultTimeout(30_000);

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const NETWORK = { "network.enabled": true, "network.bind": "127.0.0.1", "network.port": 0 };

let rig: AppRig;
let net: string;
let call: string;
const key: Record<"read" | "jobs" | "other" | "both", string> = {
  read: "",
  jobs: "",
  other: "",
  both: "",
};

async function create(name: string, ...scopes: string[]): Promise<string> {
  const r = await cli({ ...process.env, ...rig.env }, [
    "keys",
    "create",
    "--name",
    name,
    ...scopes.flatMap((s) => ["--scope", s]),
    "--json",
  ]);
  expect(r.code).toBe(0);
  expect(r.json.scopes).toEqual(scopes);
  return r.json.key as string;
}

/** One request to the network listener. */
async function get(
  path: string,
  bearer: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | FormData } = {},
): Promise<Response> {
  return fetch(`${net}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${bearer}`, ...init.headers },
    body: init.body,
  });
}

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown> & { error?: string };
}

/** A job submitted over the network listener with a key, as a phone uploads a recording. */
async function submit(bearer: string, title: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(clip(["hello", "world"], 2))]), "note.wav");
  form.append("title", title);
  const res = await get("/jobs", bearer, { method: "POST", body: form });
  expect(res.status).toBe(202);
  return (await body(res)).id as string;
}

beforeAll(async () => {
  rig = await appRig({ settings: NETWORK });
  expect(rig.app.mode()).toBe("app");
  expect(rig.app.network).not.toBeNull();
  net = rig.app.network?.url as string;
  key.read = await create("phone", "read");
  key.jobs = await create("recorder", "jobs");
  key.other = await create("other-recorder", "jobs");
  key.both = await create("phone-and-recorder", "jobs", "read");
  // A call with two generated lines on it, then stopped, with a known part file to fetch.
  call = await rig.startCall({ title: "Planning" });
  for (const [sid, text] of [
    ["l900001", "ship the release on monday"],
    ["l900002", "and write the notes after"],
  ] as const) {
    await rig.app.write(call, {
      type: "seg",
      id: sid,
      rev: 1,
      layer: "live",
      part: 1,
      ch: "call",
      spk: "c1",
      a0: 1,
      a1: 2,
      w0: T0 + Number(sid.slice(1)),
      w1: T0 + Number(sid.slice(1)) + 900,
      text,
      model: "fake",
    } as never);
  }
  expect((await rig.api("POST", `/calls/${call}/stop`)).status).toBe(200);
  await until(
    async () => (await rig.api("GET", `/calls/${call}`)).body.state === "ended",
    10_000,
    "the call to end",
  );
}, 60_000);

afterAll(async () => {
  await rig?.close();
});

describe("a phone reads the desktop app's history with a read key", () => {
  test("the listener is up on the address network.bind names, and the log says where", () => {
    expect(net).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(rig.app.network?.port).not.toBe(rig.port);
    expect(rig.logs.some((l) => l.msg.startsWith(`network: listening on ${net}`))).toBe(true);
  });

  test("GET /v1/keys/me names the key and its scopes", async () => {
    const res = await get("/keys/me", key.read);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ name: "phone", scopes: ["read"] });
    expect((await body(await get("/keys/me", key.both))).scopes).toEqual(["jobs", "read"]);
  });

  test("lists the calls and reads one call's transcript", async () => {
    const list = await get("/calls", key.read);
    expect(list.status).toBe(200);
    const calls = (await body(list)).calls as { id: string; title: string }[];
    expect(calls.find((c) => c.id === call)?.title).toBe("Planning");
    const detail = await get(`/calls/${call}`, key.read);
    expect(detail.status).toBe(200);
    const transcript = await get(`/calls/${call}/transcript?format=txt`, key.read);
    expect(transcript.status).toBe(200);
    const text = await transcript.text();
    expect(text).toContain("ship the release on monday");
    expect(text).toContain("and write the notes after");
    for (const path of ["notes", "memo", "enhanced"]) {
      expect(`${path} ${(await get(`/calls/${call}/${path}`, key.read)).status}`).toBe(
        `${path} 200`,
      );
    }
    expect((await get("/workspaces", key.read)).status).toBe(200);
    expect((await get("/dictations", key.read)).status).not.toBe(403);
  });

  test("fetches a part's audio with Range", async () => {
    const detail = (await rig.api("GET", `/calls/${call}`)).body;
    writeFileSync(
      join(detail.folder, detail.parts[0].file),
      Buffer.from(Array.from({ length: 100 }, (_, i) => i)),
    );
    const res = await get(`/calls/${call}/audio/1`, key.read, {
      headers: { range: "bytes=10-19" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  test("a change is refused: PATCH /v1/config is 403, and nothing changed", async () => {
    const before = (await rig.api("GET", "/config")).body.settings["asr.segmentPause"];
    const res = await get("/config", key.read, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "asr.segmentPause": 0.95 }),
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe("forbidden");
    expect((await rig.api("GET", "/config")).body.settings["asr.segmentPause"]).toBe(before);
    for (const [method, path] of [
      ["DELETE", `/calls/${call}`],
      ["POST", `/calls/${call}/notes`],
      ["POST", "/quit"],
    ] as const) {
      const r = await get(path, key.read, {
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(`${method} ${path} ${r.status}`).toBe(`${method} ${path} 403`);
    }
    expect((await rig.api("GET", `/calls/${call}`)).status).toBe(200);
  });

  test("a jobs key reads no call", async () => {
    const res = await get("/calls", key.jobs);
    expect(res.status).toBe(403);
  });
});

describe("the job reads: a read key sees every key's jobs, a jobs key its own", () => {
  let mine: string;
  let theirs: string;

  beforeAll(async () => {
    mine = await submit(key.jobs, "recorder's note");
    theirs = await submit(key.other, "other note");
  });

  test("GET /v1/jobs with a read key lists both keys' jobs; a jobs key only its own", async () => {
    const ids = async (bearer: string) =>
      ((await body(await get("/jobs", bearer))).jobs as { id: string }[]).map((j) => j.id);
    expect(await ids(key.read)).toEqual(expect.arrayContaining([mine, theirs]));
    expect(await ids(key.jobs)).toEqual([mine]);
    expect(await ids(key.other)).toEqual([theirs]);
    expect((await get(`/jobs/${theirs}`, key.read)).status).toBe(200);
    expect((await get(`/jobs/${theirs}`, key.jobs)).status).toBe(404);
  });

  test("a key with jobs and read sees another key's job but cannot rename or delete it", async () => {
    expect((await get(`/jobs/${theirs}`, key.both)).status).toBe(200);
    const rename = await get(`/jobs/${theirs}`, key.both, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "taken" }),
    });
    expect(rename.status).toBe(404);
    const del = await get(`/jobs/${theirs}`, key.both, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect(del.status).toBe(404);
    expect((await body(await get(`/jobs/${theirs}`, key.other))).title).toBe("other note");
    // A read key alone cannot even reach the write routes.
    const readDel = await get(`/jobs/${theirs}`, key.read, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    expect(readDel.status).toBe(403);
  });
});

describe("the listener takes keys only", () => {
  test("the app's own token is 401 there and audited; on 127.0.0.1's API it still works", async () => {
    const res = await get("/calls", rig.token);
    expect(res.status).toBe(401);
    expect(rig.logs.some((l) => l.msg.includes("key.refused (not an akou key)"))).toBe(true);
    expect((await rig.api("GET", "/calls")).status).toBe(200);
  });

  test("any Host is accepted with a key; a browser's request is refused", async () => {
    const port = rig.app.network?.port as number;
    const r = await fetch(`http://127.0.0.1:${port}/v1/keys/me`, {
      headers: { authorization: `Bearer ${key.read}`, host: "my-mac.example.ts.net" },
    });
    expect(r.status).toBe(200);
    const b = await get("/calls", key.read, { headers: { origin: "https://evil.example" } });
    expect(b.status).toBe(403);
    expect((await body(b)).error).toBe("browser_request");
  });
});

describe("network.bind tailnet", () => {
  const ifaces = (address: string) => () =>
    ({
      lo0: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
      en0: [
        {
          address,
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "02:00:00:00:00:01",
          internal: false,
          cidr: `${address}/24`,
        },
      ],
    }) as ReturnType<typeof networkInterfaces>;

  test("no tailnet address: one warning line, no listener, and the app runs on 127.0.0.1", async () => {
    const r = await appRig({
      settings: { "network.enabled": true, "network.port": 0 },
      interfaces: ifaces("192.168.1.20"),
    });
    try {
      expect(r.app.network).toBeNull();
      const warned = r.logs.filter((l) => l.msg.startsWith("network:"));
      expect(warned).toEqual([
        {
          level: "warn",
          msg: "network: no listener; network.bind is tailnet and this machine has no tailnet address",
        },
      ]);
      expect((await r.api("GET", "/keys/me")).status).toBe(200);
    } finally {
      await r.close();
    }
  });

  test("off by default, and server mode ignores it with a warning", async () => {
    const off = await appRig();
    try {
      expect(off.app.network).toBeNull();
      expect(off.logs.some((l) => l.msg.startsWith("network:"))).toBe(false);
    } finally {
      await off.close();
    }
    const server = await appRig({
      settings: { "server.enabled": true, "api.bind": "127.0.0.1", ...NETWORK },
    });
    try {
      expect(server.app.network).toBeNull();
      expect(server.logs.map((l) => l.msg)).toContain(
        "network.enabled applies in the desktop app only; server mode listens on api.bind",
      );
    } finally {
      await server.close();
    }
  });
});
