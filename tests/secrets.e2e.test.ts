/**
 * The provider's API key in the macOS Keychain (docs/providers.md "Keys", PROGRAMMABILITY PG-Z3):
 * a save writes it there and never to `config.json`, a key already in the file moves there at
 * start and leaves the file, and the assistant reads it from there. Every test drives a fake
 * `security` command (tests/fixtures/fake-security.ts), so no real Keychain is touched.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keychainStore } from "../src/main/config/secrets.ts";
import { Bridge } from "../src/main/window/bridge.ts";
import { type AppRig, appRig } from "./api-helpers.ts";
import { tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-security.ts");
const KEY = "sk-ant-test-4f9c2e";

function fakeKeychain(dir: string, refuse = "", timeoutMs?: number) {
  const store = join(dir, "keychain.json");
  const secrets = keychainStore({
    timeoutMs,
    command: [process.execPath, FAKE],
    env: { ...process.env, FAKE_SECURITY_STORE: store, FAKE_SECURITY_REFUSE: refuse },
  });
  return {
    secrets,
    items: (): Record<string, string> =>
      existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {},
    /** Every command line `security` was given. */
    argv: (): string => (existsSync(`${store}.argv`) ? readFileSync(`${store}.argv`, "utf8") : ""),
  };
}

const configText = (rig: AppRig) => readFileSync(rig.app.config().paths.configFile, "utf8");

async function withRig(
  o: { settings?: Record<string, unknown>; refuse?: string; timeoutMs?: number },
  fn: (rig: AppRig, kc: ReturnType<typeof fakeKeychain>) => Promise<void>,
): Promise<void> {
  const t = tempDir("akou-secrets-");
  const kc = fakeKeychain(t.dir, o.refuse, o.timeoutMs);
  const rig = await appRig({ home: t.dir, settings: o.settings, secrets: kc.secrets });
  try {
    await fn(rig, kc);
  } finally {
    await rig.close();
    t.cleanup();
  }
}

describe("the Keychain store, through the security command", () => {
  test("saves, reads back, replaces and removes a key, never on a command line", () => {
    const t = tempDir("akou-kc-");
    try {
      const kc = fakeKeychain(t.dir);
      expect(kc.secrets.get("provider.apiKey")).toBeNull();
      kc.secrets.set("provider.apiKey", KEY);
      expect(kc.secrets.get("provider.apiKey")).toBe(KEY);
      expect(kc.items()).toEqual({ "akou/provider.apiKey": KEY });
      kc.secrets.set("provider.apiKey", "sk-second key");
      expect(kc.secrets.get("provider.apiKey")).toBe("sk-second key");
      kc.secrets.remove("provider.apiKey");
      expect(kc.secrets.get("provider.apiKey")).toBeNull();
      // Removing one that is not there is not an error.
      kc.secrets.remove("provider.apiKey");
      // `ps` would show a command line: the key went on stdin, as hex, and never on one.
      expect(kc.argv()).not.toContain(KEY);
      expect(kc.argv()).not.toContain(Buffer.from(KEY).toString("hex"));
      // Positive control: the log does record the command lines.
      expect(kc.argv()).toContain("find-generic-password");
    } finally {
      t.cleanup();
    }
  });

  test("a save the Keychain silently drops is an error, since security -i exits 0 anyway", () => {
    const t = tempDir("akou-kc-");
    try {
      const kc = fakeKeychain(t.dir, "add");
      expect(() => kc.secrets.set("provider.apiKey", KEY)).toThrow("did not keep the key");
      const locked = fakeKeychain(t.dir, "all");
      expect(() => locked.secrets.get("provider.apiKey")).toThrow("could not be read");
      // A Keychain that never answers fails after the time limit instead of holding the app.
      const stuck = fakeKeychain(t.dir, "hang", 300);
      const at = Date.now();
      expect(() => stuck.secrets.get("provider.apiKey")).toThrow("could not be read");
      expect(Date.now() - at).toBeLessThan(4000);
    } finally {
      t.cleanup();
    }
  });
});

describe("the app keeps the API key in the Keychain", () => {
  test("a key in config.json moves to the Keychain at start, leaves the file, and still answers", async () => {
    await withRig(
      { settings: { "provider.kind": "anthropic", "provider.apiKey": KEY, "user.name": "Ana" } },
      async (rig, kc) => {
        expect(kc.items()["akou/provider.apiKey"]).toBe(KEY);
        const file = configText(rig);
        expect(file).not.toContain(KEY);
        expect(file).not.toContain("provider.apiKey");
        // The rest of the file is as it was.
        expect(JSON.parse(file)["user.name"]).toBe("Ana");
        // The assistant reads the key from the Keychain: it is ready, not "not set".
        const st = await rig.api("GET", "/status");
        expect(st.body.provider).toMatchObject({ id: "anthropic", state: "available" });
        const cfg = await rig.api("GET", "/config");
        expect(cfg.body.settings["provider.apiKey"]).toBe("(set)");
        expect(cfg.body.set["provider.apiKey"]).toBe("(set)");
        expect(cfg.body.schema["provider.apiKey"].keychain).toBe(true);
        expect(cfg.body.schema["provider.model"].keychain).toBeUndefined();
        expect(JSON.stringify(cfg.body)).not.toContain(KEY);
        expect(JSON.stringify(rig.logs)).not.toContain(KEY);
        expect(rig.logs.some((l) => l.msg.includes("into the Keychain"))).toBe(true);
      },
    );
  });

  test("PATCH /config writes the key to the Keychain, never to the file; null removes it", async () => {
    await withRig({ settings: { "provider.kind": "anthropic" } }, async (rig, kc) => {
      expect((await rig.api("GET", "/status")).body.provider.state).toBe("unavailable");
      const set = await rig.api("PATCH", "/config", { "provider.apiKey": KEY });
      expect(set.status).toBe(200);
      expect(JSON.stringify(set.body)).not.toContain(KEY);
      expect(kc.items()["akou/provider.apiKey"]).toBe(KEY);
      expect(configText(rig)).not.toContain(KEY);
      expect((await rig.api("GET", "/status")).body.provider.state).toBe("available");
      // Another setting's save leaves the key where it is, and out of the file.
      expect((await rig.api("PATCH", "/config", { "provider.model": "claude-x" })).status).toBe(
        200,
      );
      expect(configText(rig)).not.toContain(KEY);
      expect(kc.items()["akou/provider.apiKey"]).toBe(KEY);
      // The desktop window's saves go the same way.
      const win = await new Bridge(rig.app).json("PATCH", "/config", { "provider.apiKey": "sk-2" });
      expect(win.status).toBe(200);
      expect(kc.items()["akou/provider.apiKey"]).toBe("sk-2");
      expect(configText(rig)).not.toContain("sk-2");
      const off = await rig.api("PATCH", "/config", { "provider.apiKey": null });
      expect(off.status).toBe(200);
      expect(kc.items()["akou/provider.apiKey"]).toBeUndefined();
      expect((await rig.api("GET", "/config")).body.settings["provider.apiKey"]).toBe("");
      expect((await rig.api("GET", "/status")).body.provider.state).toBe("unavailable");
      expect(kc.argv()).not.toContain(KEY);
      expect(JSON.stringify(rig.logs)).not.toContain(KEY);
    });
  });

  test("a Keychain that refuses a save refuses the change, and the file never takes the key", async () => {
    await withRig({ settings: { "provider.kind": "anthropic" }, refuse: "add" }, async (rig) => {
      const r = await rig.api("PATCH", "/config", { "provider.apiKey": KEY });
      expect(r.status).toBe(500);
      expect(r.body.message).toContain("Keychain");
      expect(r.text).not.toContain(KEY);
      expect(configText(rig)).not.toContain(KEY);
    });
  });

  test("a Keychain that refuses the move at start leaves the key in the file, where it still works", async () => {
    await withRig(
      { settings: { "provider.kind": "anthropic", "provider.apiKey": KEY }, refuse: "add" },
      async (rig) => {
        expect(configText(rig)).toContain(KEY);
        expect((await rig.api("GET", "/status")).body.provider.state).toBe("available");
        expect(rig.logs.some((l) => l.msg.includes("stays in the config file"))).toBe(true);
        // Settings must not say "Saved in Keychain" for a key that is in the file.
        const schema = (await rig.api("GET", "/config")).body.schema["provider.apiKey"];
        expect(schema.keychain).toBeUndefined();
        expect(JSON.stringify(rig.logs)).not.toContain(KEY);
        // A later save of another setting keeps it there: it is never dropped from both.
        expect((await rig.api("PATCH", "/config", { "provider.model": "claude-x" })).status).toBe(
          200,
        );
        expect(configText(rig)).toContain(KEY);
      },
    );
  });
});

describe("server mode", () => {
  test("keeps the key in the config file, since a server has no login Keychain", async () => {
    await withRig(
      {
        settings: {
          "server.enabled": true,
          "api.bind": "127.0.0.1",
          "provider.kind": "anthropic",
          "provider.apiKey": KEY,
        },
      },
      async (rig, kc) => {
        expect(configText(rig)).toContain(KEY);
        expect(kc.items()).toEqual({});
        expect((await rig.api("GET", "/config")).body.schema["provider.apiKey"].keychain).toBe(
          undefined,
        );
      },
    );
  });
});

describe("the assistant's server address", () => {
  test("the desktop window sets it; an HTTP client cannot", async () => {
    await withRig({}, async (rig) => {
      const url = { "provider.baseUrl": "http://127.0.0.1:11434/v1" };
      const http = await rig.api("PATCH", "/config", url);
      expect(http.status).toBe(400);
      expect(http.body.message).toContain("akou window");
      const win = await new Bridge(rig.app).json("PATCH", "/config", url);
      expect(win.status).toBe(200);
      expect(JSON.parse(configText(rig))["provider.baseUrl"]).toBe(url["provider.baseUrl"]);
      const schema = (await rig.api("GET", "/config")).body.schema["provider.baseUrl"];
      expect(schema).toMatchObject({ apiWritable: false, windowWritable: true });
    });
  });
});
