/**
 * The provider's API key in the macOS Keychain (docs/providers.md "Keys", PROGRAMMABILITY PG-Z3):
 * a save writes it there and never to `config.json`, a key already in the file moves there at
 * start and leaves the file, and the assistant reads it from there. Every test drives a fake
 * `security` command (tests/fixtures/fake-security.ts), so no real Keychain is touched.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
    /** Makes the Keychain refuse from now on (`add`, `drop`, `hang-add`, …), or "" to stop. */
    refuse: (how: string) => writeFileSync(`${store}.refuse`, how),
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
  test("saves, reads back, replaces and removes a key, never on a command line", async () => {
    const t = tempDir("akou-kc-");
    try {
      const kc = fakeKeychain(t.dir);
      expect(kc.secrets.get("provider.apiKey")).toBeNull();
      await kc.secrets.set("provider.apiKey", KEY);
      expect(kc.secrets.get("provider.apiKey")).toBe(KEY);
      expect(kc.items()).toEqual({ "akou/provider.apiKey": KEY });
      await kc.secrets.set("provider.apiKey", "sk-second!key");
      expect(kc.secrets.get("provider.apiKey")).toBe("sk-second!key");
      await kc.secrets.remove("provider.apiKey");
      expect(kc.secrets.get("provider.apiKey")).toBeNull();
      // Removing one that is not there is not an error.
      await kc.secrets.remove("provider.apiKey");
      // `security -w` prints any other text as hex, so it could not be read back: refused first.
      await expect(kc.secrets.set("provider.apiKey", "sk-clé")).rejects.toThrow("letters, digits");
      await expect(kc.secrets.set("provider.apiKey", "sk a")).rejects.toThrow("letters, digits");
      expect(kc.items()).toEqual({});
      // `ps` would show a command line: the key went on stdin, as hex, and never on one.
      expect(kc.argv()).not.toContain(KEY);
      expect(kc.argv()).not.toContain(Buffer.from(KEY).toString("hex"));
      // Positive control: the log does record the command lines.
      expect(kc.argv()).toContain("find-generic-password");
    } finally {
      t.cleanup();
    }
  });

  test("a save the Keychain refuses or does not keep is an error", async () => {
    const t = tempDir("akou-kc-");
    try {
      const kc = fakeKeychain(t.dir, "add");
      await expect(kc.secrets.set("provider.apiKey", KEY)).rejects.toThrow("did not keep the key");
      // One that says yes and keeps nothing: the read back is the check.
      const dropped = fakeKeychain(t.dir, "drop");
      await expect(dropped.secrets.set("provider.apiKey", KEY)).rejects.toThrow("did not keep");
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
      // A key the Keychain could not give back as it was is refused plainly, and never echoed.
      const odd = await rig.api("PATCH", "/config", { "provider.apiKey": "sk-clé-9" });
      expect(odd.status).toBe(400);
      expect(odd.body.message).toContain("letters, digits and symbols only");
      expect(odd.text).not.toContain("sk-clé-9");
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
      async (rig, kc) => {
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
        // Once the Keychain takes a save of the key, it leaves the file and says so.
        kc.refuse("");
        expect((await rig.api("PATCH", "/config", { "provider.apiKey": "sk-3" })).status).toBe(200);
        expect(kc.items()["akou/provider.apiKey"]).toBe("sk-3");
        expect(configText(rig)).not.toContain(KEY);
        expect(configText(rig)).not.toContain("sk-3");
        expect((await rig.api("GET", "/config")).body.schema["provider.apiKey"].keychain).toBe(
          true,
        );
      },
    );
  });

  test("a save waiting on the Keychain holds only its own request, then fails", async () => {
    await withRig(
      { settings: { "provider.kind": "anthropic" }, timeoutMs: 1500 },
      async (rig, kc) => {
        kc.refuse("hang-add");
        let done = false;
        const save = rig.api("PATCH", "/config", { "provider.apiKey": KEY }).finally(() => {
          done = true;
        });
        // The rest of akou answers while the Keychain has not.
        await Bun.sleep(200);
        const st = await rig.api("GET", "/status");
        expect(st.status).toBe(200);
        expect(done).toBe(false);
        const r = await save;
        expect(r.status).toBe(500);
        expect(configText(rig)).not.toContain(KEY);
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

  test("still reads a key the app moved into the Keychain, until the file has one", async () => {
    const t = tempDir("akou-secrets-");
    const kc = fakeKeychain(t.dir);
    const server = {
      "server.enabled": true,
      "api.bind": "127.0.0.1",
      "provider.kind": "anthropic",
    };
    try {
      // The app moves the key out of the file, then server mode is turned on in the file.
      const app = await appRig({
        home: t.dir,
        settings: { "provider.kind": "anthropic", "provider.apiKey": KEY },
        secrets: kc.secrets,
      });
      await app.close();
      expect(kc.items()["akou/provider.apiKey"]).toBe(KEY);
      const rig = await appRig({ home: t.dir, settings: server, secrets: kc.secrets });
      try {
        expect((await rig.api("GET", "/status")).body.provider.state).toBe("available");
        expect(rig.logs.some((l) => l.msg.includes("is read from the Keychain"))).toBe(true);
        expect(configText(rig)).not.toContain(KEY);
        // A key set in the file there is the one used; nothing goes to the Keychain.
        expect((await rig.api("PATCH", "/config", { "provider.apiKey": "sk-4" })).status).toBe(200);
        expect(configText(rig)).toContain("sk-4");
        expect(kc.items()["akou/provider.apiKey"]).toBe(KEY);
        // And removing it from the file leaves none: the Keychain's is not brought back.
        expect((await rig.api("PATCH", "/config", { "provider.apiKey": null })).status).toBe(200);
        expect((await rig.api("GET", "/status")).body.provider.state).toBe("unavailable");
        expect(JSON.stringify(rig.logs)).not.toContain(KEY);
      } finally {
        await rig.close();
      }
    } finally {
      t.cleanup();
    }
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

// The real `security`, on a keychain file made for the test and deleted after, never the login
// one: only on a macOS CI runner, so it never touches the owner's Keychain.
describe.skipIf(process.platform !== "darwin" || !process.env.CI)(
  "the real security command, on a throwaway keychain (macOS CI only)",
  () => {
    test("saves, reads back, replaces and removes a key; a failing command exits non-zero", async () => {
      const t = tempDir("akou-real-kc-");
      const file = join(t.dir, "akou-test.keychain-db");
      const security = (args: string[], stdin?: string) =>
        Bun.spawnSync(["/usr/bin/security", ...args], {
          stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        }).exitCode;
      try {
        expect(security(["create-keychain", "-p", "akou-test", file])).toBe(0);
        expect(security(["unlock-keychain", "-p", "akou-test", file])).toBe(0);
        const kc = keychainStore({ keychain: file, service: "akou-test" });
        expect(kc.get("provider.apiKey")).toBeNull();
        await kc.set("provider.apiKey", KEY);
        expect(kc.get("provider.apiKey")).toBe(KEY);
        await kc.set("provider.apiKey", "sk-second!key");
        expect(kc.get("provider.apiKey")).toBe("sk-second!key");
        await kc.remove("provider.apiKey");
        expect(kc.get("provider.apiKey")).toBeNull();
        await kc.remove("provider.apiKey");
        // `security -i` exits with its last command's status, so a refused save is seen.
        const missing = `delete-generic-password -s akou-test -a none ${file}\n`;
        expect(security(["-i"], missing)).not.toBe(0);
      } finally {
        security(["delete-keychain", file]);
        t.cleanup();
      }
    });
  },
);
