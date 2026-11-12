/**
 * Where finished calls are exported is the user's own choice on this computer: `export.dir` and
 * the `to` of `POST /calls/{id}/export` are taken from the app's own token on the desktop app's
 * loopback listener (`akou config set export.dir`, `akou export --to`) and from the desktop
 * window, never from an `ak_` key, the network listener, the window's page in a browser or server
 * mode. Each refused door is checked at the route, with the CLI's own path as the control.
 */

import { describe, expect, test } from "bun:test";
import { APP_IDENTITY, type Identity } from "../src/main/api/access.ts";
import { errorResponse, HttpError, type Mode } from "../src/main/api/http.ts";
import { type ApiApp, buildRouter } from "../src/main/api/server.ts";
import {
  buildSettings,
  type LoadedConfig,
  patchConfig,
  resolvePaths,
  type SettingKey,
  type SettingValue,
} from "../src/main/config/schema.ts";

/** An admin `ak_` key: what the network listener and server mode's keys resolve to. */
const ADMIN_KEY: Identity = { id: "k_admin", name: "laptop", scopes: ["admin"], callbackHosts: [] };

/** A handler's answer, with a thrown refusal turned into its response as the server does. */
async function answer(run: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    throw err;
  }
}

interface Caller {
  identity?: Identity | null;
  browser?: boolean;
  mode?: Mode;
}

/** One `PATCH /v1/config` through the route, on a config file held in memory. */
async function patch(who: Caller, body: Record<string, unknown>, start = {}) {
  const paths = resolvePaths({ AKOU_HOME: "/t" });
  let file: Partial<Record<SettingKey, SettingValue>> = { ...start };
  const loaded = (): LoadedConfig => ({ ...buildSettings(paths, file, {}), file });
  const app = {
    mode: () => who.mode ?? "app",
    config: loaded,
    saveConfig: async (change: (f: typeof file) => typeof file) => {
      file = change(file);
      return loaded();
    },
  } as unknown as ApiApp;
  const router = buildRouter(who.mode ?? "app");
  const url = new URL("http://127.0.0.1/v1/config");
  const m = router.match("PATCH", "/config");
  if ("status" in m) throw new Error("no config route");
  const req = new Request(url.href, { method: "PATCH", body: JSON.stringify(body) });
  const res = await answer(() =>
    m.handler({
      req,
      url,
      params: m.params,
      app,
      by: "agent:test",
      identity: who.identity,
      browser: who.browser,
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, file };
}

/** One `POST /v1/calls/c1/export` through the route; answers the folders the export was given. */
async function exportTo(who: Caller, body: Record<string, unknown>) {
  const asked: (string | undefined)[] = [];
  const app = {
    mode: () => who.mode ?? "app",
    manager: { resolve: (ref: string) => ({ ok: true, id: ref }) },
    exportCall: async (_id: string, o: { to?: string }) => {
      asked.push(o.to);
      return { ok: true, path: "/x.md", written: true, draft: null };
    },
  } as unknown as ApiApp;
  const url = new URL("http://127.0.0.1/v1/calls/c1/export");
  const m = buildRouter("app").match("POST", "/calls/c1/export");
  if ("status" in m) throw new Error("no export route");
  const req = new Request(url.href, { method: "POST", body: JSON.stringify(body) });
  const res = await answer(() =>
    m.handler({
      req,
      url,
      params: m.params,
      app,
      by: "agent:test",
      identity: who.identity,
      browser: who.browser,
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, asked };
}

const DIR = { "export.dir": "/exports" };
const SHARE = { "export.dir": "\\\\host.example\\drop" };

describe("[EXP-1] The export folder set by an API key", () => {
  test("an admin ak_ key's PATCH of export.dir is 400 and the file keeps the user's folder", async () => {
    const r = await patch({ identity: ADMIN_KEY }, SHARE, DIR);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_setting");
    expect(String(r.body.message)).toContain("export.dir");
    expect(r.file).toEqual(DIR);
  });

  test("an admin ak_ key's PATCH of recordings.root is 400 too: every later call is recorded there", async () => {
    const ROOT = { "recordings.root": "/calls" };
    const SHARED = { "recordings.root": "\\\\host.example\\drop" };
    const r = await patch({ identity: ADMIN_KEY }, SHARED, ROOT);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_setting");
    expect(String(r.body.message)).toContain("recordings.root");
    expect(r.file).toEqual(ROOT);
    // Positive control: `akou config set recordings.root` (the app token on loopback) still sets it.
    const cli = await patch({ identity: APP_IDENTITY }, { "recordings.root": "/notes" }, ROOT);
    expect(cli.status).toBe(200);
    expect(cli.file).toEqual({ "recordings.root": "/notes" });
  });

  test("the app's own token in server mode is refused too", async () => {
    const r = await patch({ identity: APP_IDENTITY, mode: "server" }, SHARE, DIR);
    expect(r.status).toBe(400);
    expect(r.file).toEqual(DIR);
  });

  test("the window's page in a browser is refused, as for the window-only keys", async () => {
    const r = await patch({ browser: true }, SHARE, DIR);
    expect(r.status).toBe(400);
    expect(r.file).toEqual(DIR);
  });

  test("positive control: `akou config set export.dir` (the app token on loopback) and the desktop window still set it", async () => {
    const cli = await patch({ identity: APP_IDENTITY }, { "export.dir": "/notes" }, DIR);
    expect(cli.status).toBe(200);
    expect(cli.file).toEqual({ "export.dir": "/notes" });
    const window = await patch({}, { "export.dir": "/notes" }, DIR);
    expect(window.status).toBe(200);
    expect(window.file).toEqual({ "export.dir": "/notes" });
  });

  test("positive control: the same key still writes a setting that sends nothing anywhere", async () => {
    const r = await patch({ identity: ADMIN_KEY }, { "asr.threads": 4 });
    expect(r.status).toBe(200);
    expect(r.file).toEqual({ "asr.threads": 4 });
  });

  test("patchConfig takes export.dir only from the user on this computer", () => {
    const paths = resolvePaths({ AKOU_HOME: "/t" });
    expect(patchConfig({}, SHARE, paths)).toMatchObject({ ok: false });
    expect(patchConfig({}, SHARE, paths, { local: true })).toMatchObject({ ok: true, file: SHARE });
    expect(patchConfig({}, SHARE, paths, { inProcess: true })).toMatchObject({
      ok: true,
      file: SHARE,
    });
  });
});

describe("[EXP-2] An export folder named by an API key", () => {
  test("an admin ak_ key's `to` is 400 and nothing is exported", async () => {
    const r = await exportTo({ identity: ADMIN_KEY }, { to: "\\\\host.example\\drop" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("bad_field");
    expect(r.asked).toEqual([]);
    const posix = await exportTo({ identity: ADMIN_KEY }, { to: "/net/host.example/drop" });
    expect(posix.status).toBe(400);
    expect(posix.asked).toEqual([]);
  });

  test("the window's page in a browser cannot name one either", async () => {
    const r = await exportTo({ browser: true }, { to: "/elsewhere" });
    expect(r.status).toBe(400);
    expect(r.asked).toEqual([]);
  });

  test("positive control: `akou export --to` (the app token on loopback) and the desktop window still name one", async () => {
    const cli = await exportTo({ identity: APP_IDENTITY }, { to: "/elsewhere" });
    expect(cli.status).toBe(200);
    expect(cli.asked).toEqual(["/elsewhere"]);
    const window = await exportTo({}, { to: "/elsewhere" });
    expect(window.status).toBe(200);
    expect(window.asked).toEqual(["/elsewhere"]);
  });

  test("positive control: the key still exports into the folder the user set", async () => {
    const r = await exportTo({ identity: ADMIN_KEY }, {});
    expect(r.status).toBe(200);
    expect(r.asked).toEqual([undefined]);
  });
});
