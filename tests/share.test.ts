/**
 * Sharing a live call, v1 `local-link` (docs/DESIGN.md section 8.3): a GET-only listener on one
 * chosen address serving the read-only viewer, fed by a filtered, rendered stream. The viewer page
 * itself runs in the headless browser suite; this checks what goes over the wire.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import { sseFrames } from "../src/core/net/sse.ts";
import { chooseBind } from "../src/main/share/local-link.ts";
import { expiryAt, parseExpiry } from "../src/main/share/transport.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { T0 } from "./helpers.ts";

const LONG = 30_000;

const iface = (address: string) => ({
  address,
  family: "IPv4" as const,
  internal: false,
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:00",
  cidr: null,
});

describe("where a share listens", () => {
  const ifaces = { en0: [iface("192.168.1.20")], utun4: [iface("100.101.102.103")] };

  test("the tailnet address by default; the LAN only when asked, with a warning", () => {
    expect(chooseBind(undefined, ifaces)).toEqual({ address: "100.101.102.103", label: "tailnet" });
    const lan = chooseBind("lan", ifaces);
    expect(lan.address).toBe("192.168.1.20");
    expect(lan.warning).toContain("plain HTTP");
  });

  test("no tailnet is a refusal, not a silent fall back to the LAN", () => {
    expect(() => chooseBind("tailnet", { en0: [iface("192.168.1.20")] })).toThrow(/tailnet/);
  });

  test("a typed address is used as typed; anything else is refused", () => {
    expect(chooseBind("127.0.0.1", ifaces).address).toBe("127.0.0.1");
    expect(chooseBind("0.0.0.0", ifaces).warning).toContain("plain HTTP");
    expect(() => chooseBind("example.com", ifaces)).toThrow(/bind/);
  });

  test("expiry: call end, call end plus two hours, or a fixed time", () => {
    expect(parseExpiry(undefined)).toBe("call-end+2h");
    expect(parseExpiry("3h")).toEqual({ minutes: 180 });
    expect(parseExpiry("90m")).toEqual({ minutes: 90 });
    expect(parseExpiry("forever")).toBeNull();
    expect(expiryAt("call-end", 0, null)).toBeNull();
    expect(expiryAt("call-end+2h", 0, 1000)).toBe(1000 + 7_200_000);
    expect(expiryAt({ minutes: 1 }, 5, null)).toBe(60_005);
  });
});

describe("the share link, end to end over the wire", () => {
  let rig: AppRig;
  let id: string;

  beforeAll(async () => {
    rig = await appRig({ settings: { "share.bind": "127.0.0.1", "share.port": 0 } });
    id = await rig.startCall({ title: "Share me" });
    // Two lines on the call side, one of them echo, a name, a correction and a note.
    const seg = (sid: string, text: string, extra: Record<string, unknown> = {}) =>
      rig.app.write(id, {
        type: "seg",
        id: sid,
        rev: 1,
        layer: "live",
        part: 1,
        ch: "call",
        spk: "c2",
        a0: 1,
        a1: 2,
        w0: T0 + Number(sid.slice(1)) * 1000,
        w1: T0 + Number(sid.slice(1)) * 1000 + 900,
        text,
        model: "fake",
        ...extra,
      } as never);
    await seg("l900001", "deploy to hetzna today");
    await seg("l900002", "this is my own voice again", { echo: true });
    await rig.app.write(id, { type: "speaker.name", spk: "c2", name: "Ben", by: "user" });
    await rig.app.write(id, {
      type: "vocab.add",
      id: "v0001",
      rev: 1,
      term: "Hetzner",
      heard: ["hetzna"],
      by: "user",
    });
    await rig.api("POST", `/calls/${id}/notes`, { text: "private note" });
  }, LONG);
  afterAll(() => rig.close());

  async function frames(url: string, n: number, headers: Record<string, string> = {}) {
    const ctl = new AbortController();
    const res = await fetch(`${url}stream`, { headers, signal: ctl.signal });
    const out: { event: string; data: string; id?: string }[] = [];
    const it = sseFrames(res.body as ReadableStream<Uint8Array>);
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      for await (const f of it) {
        if (f.event === "comment") continue;
        out.push(f);
        if (out.length >= n) break;
      }
    } catch {}
    clearTimeout(timer);
    ctl.abort();
    return out;
  }

  test("POST /share starts a link on the chosen address; the log records it", async () => {
    const r = await rig.api("POST", "/share", { call: id });
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{32}\/$/);
    expect(r.body.include).toMatchObject({ transcript: true, notes: false, audio: false });
    const again = await rig.api("POST", "/share", { call: id });
    expect(again.body.url).toBe(r.body.url);
    const events = (await rig.api("GET", `/calls/${id}/events`)).body.events as LogEvent[];
    expect(events.filter((e) => e.type === "share.started")).toHaveLength(1);
    const st = await rig.api("GET", "/status");
    expect(st.body.share.active).toBe(true);
  });

  test("the viewer page is GET only, under the token, with no Referer and a strict CSP", async () => {
    const url = (await rig.api("GET", "/share")).body.shares[0].url as string;
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('src="share.js"');
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await fetch(`${url}share.js`)).status).toBe(200);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    // A wrong token is nothing at all.
    expect((await fetch(url.replace(/[0-9a-f]{32}/, "0".repeat(32)))).status).toBe(404);
    // Never the app's own API.
    expect((await fetch(url.replace(/\/s\/.*$/, "/v1/status"))).status).toBe(404);
  });

  test("the stream shows names and corrections, never echo, raw text or the notepad", async () => {
    const url = (await rig.api("GET", "/share")).body.shares[0].url as string;
    const [snap] = await frames(url, 1);
    expect(snap?.event).toBe("snapshot");
    const d = JSON.parse(snap?.data ?? "{}");
    expect(d.title).toBe("Share me");
    const ours = d.lines.filter((l: { id: string }) => l.id.startsWith("l9"));
    expect(ours).toEqual([
      expect.objectContaining({ id: "l900001", speaker: "Ben", text: "deploy to Hetzner today" }),
    ]);
    const wire = snap?.data ?? "";
    expect(wire).not.toContain("hetzna");
    expect(wire).not.toContain("my own voice");
    expect(wire).not.toContain("private note");
    expect(d.notes).toBeUndefined();
  });

  test("a viewer that reconnects gets only what changed after its last event", async () => {
    const url = (await rig.api("GET", "/share")).body.shares[0].url as string;
    const [snap] = await frames(url, 1);
    const last = snap?.id as string;
    await rig.app.write(id, {
      type: "seg",
      id: "l900003",
      rev: 1,
      layer: "live",
      part: 1,
      ch: "call",
      spk: "c2",
      a0: 3,
      a1: 4,
      w0: T0 + 3_000_000,
      w1: T0 + 3_000_900,
      text: "one more thing",
      model: "fake",
    } as never);
    const got = await frames(url, 1, { "last-event-id": last });
    expect(got[0]?.event).toBe("lines");
    const d = JSON.parse(got[0]?.data ?? "{}");
    expect(d.lines.map((l: { id: string }) => l.id)).toEqual(["l900003"]);
  });

  test("the viewer count follows the open streams", async () => {
    const url = (await rig.api("GET", "/share")).body.shares[0].url as string;
    const ctl = new AbortController();
    const res = await fetch(`${url}stream`, { signal: ctl.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await until(
      async () => (await rig.api("GET", "/share")).body.shares[0].viewers === 1,
      3000,
      "one viewer",
    );
    ctl.abort();
    await until(
      async () => (await rig.api("GET", "/share")).body.shares[0].viewers === 0,
      3000,
      "no viewer",
    );
  });

  test("DELETE /share stops the link and logs it; the address answers nothing after", async () => {
    const url = (await rig.api("GET", "/share")).body.shares[0].url as string;
    const r = await rig.api("DELETE", "/share", { call: id });
    expect(r.status).toBe(200);
    expect(r.body.stopped).toHaveLength(1);
    expect((await rig.api("GET", "/share")).body).toEqual({ active: false, shares: [] });
    const events = (await rig.api("GET", `/calls/${id}/events`)).body.events as LogEvent[];
    // The call is live, so other events may follow; the stop is logged once, after the start.
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "share.stopped")).toHaveLength(1);
    expect(types.lastIndexOf("share.stopped")).toBeGreaterThan(types.lastIndexOf("share.started"));
    await expect(fetch(url)).rejects.toThrow();
  });

  test("with notes: true the notepad is shared too", async () => {
    const r = await rig.api("POST", "/share", { call: id, notes: true });
    const [snap] = await frames(r.body.url, 1);
    expect(JSON.parse(snap?.data ?? "{}").notes).toEqual([
      // The note came in over the API, so it is an agent's, and says so.
      expect.objectContaining({ text: "private note", author: "agent" }),
    ]);
    await rig.api("DELETE", "/share", {});
  });
});
