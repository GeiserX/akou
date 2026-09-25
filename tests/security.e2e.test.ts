/**
 * The local API's security suite (docs/DESIGN.md section 6.3, TRAPS "API security"), end to end: a
 * headless app capturing from the fake helper, attacked the way a web page or a rebinding DNS name
 * would attack it, with the exact bytes a browser sends.
 *
 * Every refusal has a positive control: the same request against an app whose guard is replaced by
 * `openGuard` must succeed (the predecessor's behaviour), which proves the test can fail and that
 * the guard, not something else, is what refuses.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  ensureToken,
  openGuard,
  othersAllowed,
  rotateToken,
  sddlOf,
  tokenFileAccess,
  tokenMatches,
} from "../src/main/api/guard.ts";
import { DRAIN_BODY_BYTES, DRAIN_BODY_MS, drainBody } from "../src/main/api/http.ts";
import { type AppRig, appRig, type RawResponse, rawRequest } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";

const LONG = 30_000;
const EVIL = "https://evil.example";

let guarded: AppRig;
let open: AppRig;

beforeAll(async () => {
  guarded = await appRig();
  open = await appRig({ guard: openGuard });
});

afterAll(async () => {
  await guarded?.close();
  await open?.close();
});

/** A call is recording on the rig; returns its id. */
async function recording(rig: AppRig): Promise<string> {
  const live = await rig.api("GET", "/calls/live");
  if (live.status === 200 && live.body.state === "recording") return live.body.id;
  return rig.startCall();
}

async function stillRecording(rig: AppRig, id: string): Promise<void> {
  const r = await rig.api("GET", "/calls/live");
  expect(r.status).toBe(200);
  expect(r.body.id).toBe(id);
  expect(r.body.state).toBe("recording");
}

async function stopped(rig: AppRig, id: string): Promise<void> {
  const r = await rig.api("GET", `/calls/${id}`);
  expect(r.body.state).toBe("ended");
}

/** An attack on `POST /calls/live/stop`: refused with `status` by the guard, 200 without it. */
async function attackStop(
  build: (rig: AppRig) => Parameters<typeof rawRequest>[1],
  status: number,
): Promise<{ refused: RawResponse; allowed: RawResponse }> {
  const a = await recording(guarded);
  const refused = await rawRequest(guarded.port, build(guarded));
  expect(refused.status).toBe(status);
  await stillRecording(guarded, a);

  // Positive control: the same bytes, the guard compiled out, and the call stops.
  const b = await recording(open);
  const allowed = await rawRequest(open.port, build(open));
  expect(allowed.status).toBe(200);
  await stopped(open, b);
  return { refused, allowed };
}

describe("[known bug] Cross-origin POST /stop accepted", () => {
  test(
    "a cross-origin fetch from a web page is refused with 403 and the call keeps recording",
    async () => {
      await attackStop(
        () => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Origin: EVIL,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
        403,
      );
    },
    LONG,
  );

  test(
    "a form POST from another origin is refused with 403",
    async () => {
      await attackStop(
        () => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Origin: EVIL,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "navigate",
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }),
        403,
      );
    },
    LONG,
  );

  test(
    "a no-cors fetch is refused with 403",
    async () => {
      await attackStop(
        () => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Origin: EVIL,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "no-cors",
            "Content-Type": "text/plain;charset=UTF-8",
          },
        }),
        403,
      );
    },
    LONG,
  );

  test(
    "Sec-Fetch-Site alone is enough to refuse, even with a valid token",
    async () => {
      await attackStop(
        (rig) => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Authorization: `Bearer ${rig.token}`,
            "Sec-Fetch-Site": "cross-site",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
        403,
      );
    },
    LONG,
  );

  test(
    "an Origin header alone is enough to refuse, even with a valid token",
    async () => {
      await attackStop(
        (rig) => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: {
            Authorization: `Bearer ${rig.token}`,
            Origin: "http://127.0.0.1:1",
            "Content-Type": "application/json",
          },
          body: "{}",
        }),
        403,
      );
    },
    LONG,
  );

  test("a CORS preflight gets no CORS header back, and no answer carries one", async () => {
    for (const rig of [guarded, open]) {
      const pre = await rawRequest(rig.port, {
        method: "OPTIONS",
        path: "/v1/calls/live/stop",
        headers: {
          Origin: EVIL,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      for (const h of Object.keys(pre.headers)) expect(h.startsWith("access-control-")).toBe(false);
      const ok = await rig.api("GET", "/status");
      for (const [h] of ok.headers) expect(h.startsWith("access-control-")).toBe(false);
    }
    expect(
      (
        await rawRequest(guarded.port, {
          method: "OPTIONS",
          path: "/v1/status",
          headers: { Origin: EVIL },
        })
      ).status,
    ).toBe(403);
  });
});

describe("DNS rebinding: a foreign Host header", () => {
  test(
    "a stop with a valid token but Host evil.example is refused with 403",
    async () => {
      await attackStop(
        (rig) => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          host: `evil.example:${rig.port}`,
          headers: { Authorization: `Bearer ${rig.token}`, "Content-Type": "application/json" },
          body: "{}",
        }),
        403,
      );
    },
    LONG,
  );

  test("reading a transcript through a rebound name is refused; the positive control reads it", async () => {
    const req = (rig: AppRig, host: string) =>
      rawRequest(rig.port, {
        method: "GET",
        path: "/v1/status",
        host,
        headers: { Authorization: `Bearer ${rig.token}` },
      });
    expect((await req(guarded, `evil.example:${guarded.port}`)).status).toBe(403);
    expect((await req(guarded, `127.0.0.1.nip.io:${guarded.port}`)).status).toBe(403);
    // Right name, wrong port: also refused.
    expect((await req(guarded, `127.0.0.1:${guarded.port + 1}`)).status).toBe(403);
    expect((await req(open, `evil.example:${open.port}`)).status).toBe(200);
    // Both loopback names on the right port pass.
    expect((await req(guarded, `127.0.0.1:${guarded.port}`)).status).toBe(200);
    expect((await req(guarded, `localhost:${guarded.port}`)).status).toBe(200);
  });
});

describe("the bearer token", () => {
  const get = (rig: AppRig, auth?: string) =>
    rawRequest(rig.port, {
      method: "GET",
      path: "/v1/calls",
      headers: auth === undefined ? {} : { Authorization: auth },
    });

  test("a missing token is 401 on GETs too; the positive control reads without one", async () => {
    const r = await get(guarded);
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBe("Bearer");
    expect((await get(open)).status).toBe(200);
  });

  test("a wrong token is 401: same length, a prefix, a longer one, another scheme", async () => {
    const t = guarded.token;
    const wrong = [
      `Bearer ${t.slice(0, -1)}${t.endsWith("0") ? "1" : "0"}`,
      `Bearer ${t.slice(0, 32)}`,
      `Bearer ${t}00`,
      `Basic ${Buffer.from(`akou:${t}`).toString("base64")}`,
      `Bearer  ${t}`,
      t,
    ];
    for (const auth of wrong) expect((await get(guarded, auth)).status).toBe(401);
    expect((await get(guarded, `Bearer ${t}`)).status).toBe(200);
    for (const auth of wrong) expect((await get(open, auth)).status).toBe(200);
  });

  test(
    "a stop without the token is 401 and the call keeps recording",
    async () => {
      await attackStop(
        () => ({
          method: "POST",
          path: "/v1/calls/live/stop",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        401,
      );
    },
    LONG,
  );

  test("the comparison is by digest, whatever the lengths", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abc", "abd")).toBe(false);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "[Token file readable by others] the token file is mode 0600, 32 random bytes (POSIX file modes; skipped on Windows)",
    () => {
      const path = guarded.app.tokenPath;
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(join(guarded.home, ".config", "akou")).mode & 0o077).toBe(0);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a token file others can read is replaced, not trusted; rotation takes effect at once (POSIX file modes; skipped on Windows)",
    async () => {
      const t = tempDir();
      const first = ensureToken(t.dir);
      expect(first.created).toBe(true);
      expect(ensureToken(t.dir)).toMatchObject({ token: first.token, created: false });
      // Positive control for the check: loosen the mode and the token must change.
      chmodSync(first.path, 0o644);
      const second = ensureToken(t.dir);
      expect(second.created).toBe(true);
      expect(second.token).not.toBe(first.token);
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
      // A garbage file is replaced too.
      writeFileSync(first.path, "not a token\n", { mode: 0o600 });
      expect(ensureToken(t.dir).created).toBe(true);
      t.cleanup();

      // Rotating the running app's token: the old one stops working on the next request.
      const old = guarded.token;
      const next = rotateToken(guarded.app.configDir);
      const r1 = await rawRequest(guarded.port, {
        method: "GET",
        path: "/v1/status",
        headers: { Authorization: `Bearer ${old}` },
      });
      expect(r1.status).toBe(401);
      const r2 = await rawRequest(guarded.port, {
        method: "GET",
        path: "/v1/status",
        headers: { Authorization: `Bearer ${next}` },
      });
      expect(r2.status).toBe(200);
      guarded.token = next;
    },
  );

  test.skipIf(process.platform === "win32")(
    "[Token file readable by others] a live token whose file goes loose is burned at once (POSIX file modes; skipped on Windows)",
    async () => {
      const path = guarded.app.tokenPath;
      const old = guarded.token;
      const status = (token: string) =>
        rawRequest(guarded.port, {
          method: "GET",
          path: "/v1/status",
          headers: { Authorization: `Bearer ${token}` },
        });
      expect((await status(old)).status).toBe(200);
      // chmod changes neither mtime nor size: the running app must still notice.
      chmodSync(path, 0o644);
      expect((await status(old)).status).toBe(401);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const next = readFileSync(path, "utf8").trim();
      expect(next).toMatch(/^[0-9a-f]{64}$/);
      expect(next).not.toBe(old);
      expect((await status(next)).status).toBe(200);
      guarded.token = next;
    },
  );
});

describe("the token file on Windows (an ACL for the current user only)", () => {
  const ME = "S-1-5-21-1111-2222-3333-1001";

  test("[Token file readable by others] an ACL is private only when nobody but the user is allowed", () => {
    // SYSTEM and the administrators can read any file anyway: an entry for them lets nobody in.
    expect(othersAllowed(`D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${ME})`, ME)).toBe(false);
    // What a file on a data drive inherits: every signed-in user can read it.
    expect(
      othersAllowed(`D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1301bf;;;AU)(A;ID;FA;;;${ME})`, ME),
    ).toBe(true);
    expect(othersAllowed(`D:PAI(A;;FA;;;${ME})(A;;FA;;;S-1-5-21-1111-2222-3333-1002)`, ME)).toBe(
      true,
    );
    // What akou writes: inheritance removed, the user alone.
    expect(othersAllowed(`D:PAI(A;;FA;;;${ME})`, ME)).toBe(false);
    expect(othersAllowed(`O:BAG:SYD:PAI(A;;FA;;;${ME})S:AI(AU;SA;FA;;;WD)`, ME)).toBe(false);
    expect(othersAllowed(`D:PAI(A;;FA;;;${ME})(A;;FR;;;WD)`, ME)).toBe(true);
    expect(othersAllowed(`D:PAI(A;;FA;;;${ME})(A;;0x1200a9;;;BU)`, ME)).toBe(true);
    // A deny entry or an inherit-only one lets nobody in.
    expect(othersAllowed(`D:PAI(D;;FA;;;WD)(A;;FA;;;${ME})`, ME)).toBe(false);
    expect(othersAllowed(`D:PAI(A;OICIIO;FA;;;WD)(A;;FA;;;${ME})`, ME)).toBe(false);
    // No DACL, or a null one, lets everyone in.
    expect(othersAllowed("D:NO_ACCESS_CONTROL", ME)).toBe(true);
    expect(othersAllowed("O:BAG:SY", ME)).toBe(true);
    // An empty DACL lets nobody in.
    expect(othersAllowed("D:P", ME)).toBe(false);
  });

  test("the SDDL is read from what `icacls /save` writes (UTF-16, a name line first)", () => {
    const text = `token\r\nD:PAI(A;;FA;;;${ME})\r\n`;
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(sddlOf(utf16)).toBe(`D:PAI(A;;FA;;;${ME})`);
    expect(sddlOf(Buffer.from(text, "utf16le"))).toBe(`D:PAI(A;;FA;;;${ME})`);
    expect(sddlOf(Buffer.from("token\r\n"))).toBe(null);
  });

  // Captured from `icacls /save` and `whoami /user` on GitHub's windows-latest runner, whose user is
  // the built-in Administrator (RID 500): SDDL names it `LA`, never by its SID, and the entries an
  // administrator's new file gets are explicit, so `/inheritance:r` leaves SYSTEM and BA in place.
  const RUNNER = "S-1-5-21-3699639565-2515463329-295617607-500";
  const RUNNER_SAVE =
    "74006f006b0065006e000d000a0044003a00500041004900280041003b003b00460041003b003b003b0053005900" +
    "2900280041003b003b00460041003b003b003b00420041002900280041003b003b00460041003b003b003b004c00" +
    "410029000d000a00";

  test("[Token file readable by others] the runner's real ACL: the RID 500 user is `LA`, and private", () => {
    const sddl = sddlOf(Buffer.from(RUNNER_SAVE, "hex"));
    expect(sddl).toBe("D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)");
    expect(othersAllowed(sddl as string, RUNNER)).toBe(false);
    // The folder akou creates there, before any restriction: the same three, inheritable.
    expect(othersAllowed("D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)", RUNNER)).toBe(false);
    // Positive controls: the same file once Everyone, Users or another account can read it.
    expect(othersAllowed(`${sddl}(A;;0x1200a9;;;WD)`, RUNNER)).toBe(true);
    expect(othersAllowed(`${sddl}(A;;0x1200a9;;;BU)`, RUNNER)).toBe(true);
    expect(
      othersAllowed(`${sddl}(A;;FA;;;S-1-5-21-3699639565-2515463329-295617607-1001)`, RUNNER),
    ).toBe(true);
  });

  test.skipIf(process.platform !== "win32")(
    "[Token file readable by others] a token whose ACL cannot be set is never written (Windows ACLs; Windows only)",
    () => {
      const t = tempDir();
      const first = ensureToken(t.dir);
      const root = process.env.SystemRoot;
      // No icacls.exe under this folder: the restriction fails.
      process.env.SystemRoot = t.dir;
      try {
        expect(() => rotateToken(t.dir)).toThrow("could not restrict");
      } finally {
        process.env.SystemRoot = root;
      }
      expect(readFileSync(first.path, "utf8").trim()).toBe(first.token);
      expect(readdirSync(t.dir)).toEqual(["token"]);
      t.cleanup();
    },
  );

  test.skipIf(process.platform !== "win32")(
    "[Token file readable by others] the token is the user's alone; one others can read is replaced (Windows ACLs; Windows only)",
    () => {
      const t = tempDir();
      const first = ensureToken(t.dir);
      expect(tokenFileAccess(first.path)).toBe("private");
      // Positive control: grant Everyone read, and the check must see it and replace the file.
      const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
      const grant = Bun.spawnSync([icacls, first.path, "/grant", "*S-1-1-0:R"]);
      expect(grant.exitCode).toBe(0);
      expect(tokenFileAccess(first.path)).toBe("loose");
      const second = ensureToken(t.dir);
      expect(second.created).toBe(true);
      expect(second.token).not.toBe(first.token);
      expect(tokenFileAccess(second.path)).toBe("private");
      t.cleanup();
    },
  );
});

describe("bodies", () => {
  const post = (rig: AppRig, headers: Record<string, string>, body: string) =>
    rawRequest(rig.port, {
      method: "POST",
      path: "/v1/calls/live/notes",
      headers: { Authorization: `Bearer ${rig.token}`, ...headers },
      body,
    });

  test("a mutation without Content-Type: application/json is 415", async () => {
    await recording(guarded);
    expect((await post(guarded, { "Content-Type": "text/plain" }, '{"text":"x"}')).status).toBe(
      415,
    );
    expect((await post(guarded, {}, '{"text":"x"}')).status).toBe(415);
    expect(
      (await post(guarded, { "Content-Type": "application/json" }, '{"text":"x"}')).status,
    ).toBe(201);
  });

  test("unknown fields are 400, a body over 64 KB is 413", async () => {
    await recording(guarded);
    const j = { "Content-Type": "application/json" };
    const r = await post(guarded, j, '{"text":"x","by":"user"}');
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toMatchObject({ error: "unknown_field", field: "by" });
    const big = JSON.stringify({ text: "x".repeat(70 * 1024) });
    const refused = await post(guarded, j, big);
    expect(refused.status).toBe(413);
    expect(JSON.parse(refused.body)).toMatchObject({ error: "body_too_large" });
  });

  /** A valid note padded with JSON whitespace to exactly `bytes` bytes. */
  const padded = (bytes: number) => {
    const note = '{"text":"x"';
    return `${note}${" ".repeat(bytes - note.length - 1)}}`;
  };

  test("the limit is exactly 64 KB: one byte over is 413, at the limit is accepted", async () => {
    await recording(guarded);
    const j = { "Content-Type": "application/json" };
    const over = await post(guarded, j, padded(64 * 1024 + 1));
    expect(over.status).toBe(413);
    expect(JSON.parse(over.body)).toMatchObject({ error: "body_too_large" });
    // Positive control: the same request one byte shorter is inside the limit and lands.
    expect((await post(guarded, j, padded(64 * 1024))).status).toBe(201);
  });

  test("the 413 reaches the client whole even when the body is still arriving", async () => {
    // The server answers before the body has been sent; if it then closed the socket with the
    // rest unread, the kernel would reset the connection and the client would read ECONNRESET
    // instead of the 413 (measured at 5 to 67 % of requests before the drain, growing with size).
    await recording(guarded);
    const j = { "Content-Type": "application/json" };
    const big = JSON.stringify({ text: "x".repeat(512 * 1024) });
    for (let i = 0; i < 10; i++) {
      const refused = await post(guarded, j, big);
      expect(refused.status).toBe(413);
      expect(JSON.parse(refused.body)).toMatchObject({ error: "body_too_large" });
    }
  });

  test("a chunked body with no Content-Length is cut off at the same 64 KB", async () => {
    await recording(guarded);
    const big = JSON.stringify({ text: "x".repeat(512 * 1024) });
    const refused = await rawRequest(guarded.port, {
      method: "POST",
      path: "/v1/calls/live/notes",
      headers: { Authorization: `Bearer ${guarded.token}`, "Content-Type": "application/json" },
      body: big,
      chunked: true,
    });
    expect(refused.status).toBe(413);
    expect(JSON.parse(refused.body)).toMatchObject({ error: "body_too_large" });
    // Positive control: chunked and inside the limit is an ordinary request.
    const ok = await rawRequest(guarded.port, {
      method: "POST",
      path: "/v1/calls/live/notes",
      headers: { Authorization: `Bearer ${guarded.token}`, "Content-Type": "application/json" },
      body: '{"text":"chunked"}',
      chunked: true,
    });
    expect(ok.status).toBe(201);
  });

  test("the drain is bounded in bytes and in time, so a trickled body cannot hold a refusal open", async () => {
    /** A reader that yields `size` bytes per read and moves a fake clock `tick` ms each time. */
    const trickle = (size: number, tick: number, ends?: number) => {
      let clock = 0;
      let reads = 0;
      let cancelled = false;
      const reader = {
        read: async () => {
          reads++;
          clock += tick;
          if (ends !== undefined && reads > ends) return { done: true as const, value: undefined };
          return { done: false as const, value: new Uint8Array(size) };
        },
        cancel: async () => {
          cancelled = true;
        },
      };
      return { reader, now: () => clock, reads: () => reads, cancelled: () => cancelled };
    };
    // Time: one byte every half second is cut off once the clock passes the bound, not at 1 MB.
    const slow = trickle(1, 500);
    await drainBody(slow.reader, 0, slow.now);
    expect(slow.reads()).toBe(DRAIN_BODY_MS / 500);
    expect(slow.cancelled()).toBe(true);
    // Bytes: a fast firehose is cut off at the cap, with the clock never moving.
    const fast = trickle(256 * 1024, 0);
    await drainBody(fast.reader, 0, fast.now);
    expect(fast.reads()).toBe(DRAIN_BODY_BYTES / (256 * 1024) + 1);
    expect(fast.cancelled()).toBe(true);
    // Positive control: a body that ends inside both bounds is read to its end and never cancelled.
    const short = trickle(1024, 10, 3);
    await drainBody(short.reader, 0, short.now);
    expect(short.reads()).toBe(4);
    expect(short.cancelled()).toBe(false);
  });

  test("any refusal of a request with a large body reaches the client: a bad token is 401", async () => {
    await recording(guarded);
    const big = JSON.stringify({ text: "x".repeat(512 * 1024) });
    const refused = await rawRequest(guarded.port, {
      method: "POST",
      path: "/v1/calls/live/notes",
      headers: { Authorization: "Bearer nope", "Content-Type": "application/json" },
      body: big,
    });
    expect(refused.status).toBe(401);
    expect(JSON.parse(refused.body)).toMatchObject({ error: "unauthorized" });
  });
});

describe("the bind address", () => {
  test("the API listens on 127.0.0.1 only and runtime.json names the port", () => {
    expect(guarded.app.server?.hostname).toBe("127.0.0.1");
    const rt = JSON.parse(readFileSync(guarded.app.runtimeFile, "utf8"));
    expect(rt).toMatchObject({ pid: process.pid, port: guarded.port });
    expect(rt.api).toBe(`http://127.0.0.1:${guarded.port}/v1`);
    if (process.platform !== "win32") {
      expect(statSync(guarded.app.runtimeFile).mode & 0o777).toBe(0o600);
    }
  });

  const refusedOn = (host: string, port: number) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      s.setTimeout(2000);
      s.on("connect", () => {
        s.destroy();
        resolve(false);
      });
      s.on("timeout", () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(true));
    });

  const outward = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address;

  test.skipIf(!outward)(
    "a non-loopback address of this machine is refused (skipped when the machine has none)",
    async () => {
      expect(await refusedOn(outward as string, guarded.port)).toBe(true);
      // Positive control: loopback on the same port connects.
      expect(await refusedOn("127.0.0.1", guarded.port)).toBe(false);
    },
  );

  test("IPv6 loopback is refused: the listener is IPv4 only", async () => {
    expect(await refusedOn("::1", guarded.port)).toBe(true);
  });
});

describe("the guard is the only way in", () => {
  test("no setting reaches the guard: the security suite's positive control is test-only", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "main", "index.ts"), "utf8");
    expect(src).not.toMatch(/openGuard/);
    const server = readFileSync(
      join(import.meta.dir, "..", "src", "main", "api", "server.ts"),
      "utf8",
    );
    expect(server).not.toMatch(/import[^;]*openGuard/);
    expect(existsSync(guarded.app.tokenPath)).toBe(true);
  });
});
