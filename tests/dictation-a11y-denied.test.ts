/**
 * [T4.36] A dictation key that does nothing, silently: dictation is on and the macOS helper reports
 * Accessibility denied, so it has no key tap. The app asks macOS for its dialog once per install
 * (`ask_accessibility`, which the fake helper only records, so no test shows a dialog), the island
 * says why the key does nothing until the grant arrives, and `akou doctor` reads the grant from the
 * running app instead of printing `unknown`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appGrants, grantStates, withAppGrants } from "../src/main/cli/commands/doctor.ts";
import type { Ctx, Grant } from "../src/main/cli/context.ts";
import { A11Y_ASKED, DictationService } from "../src/main/dictation/service.ts";
import { DICTATION_DIR } from "../src/main/dictation/store.ts";
import { hotkeyLabel } from "../src/main/window/hotkey.ts";
import { type PillDictation, pillRpc } from "../src/main/window/pill.ts";
import { A11Y_OFF, A11Y_STALE_SHORT, type PillState } from "../src/ui/pill-protocol.ts";
import { FAKE_HELPER } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const KEYS = () => ({
  hotkey: "RightCommand",
  draft: "",
  fixLast: "",
  pasteLast: "",
  activation: "hold-or-toggle" as const,
});

/** A service over the fake helper in `dir`, its commands logged to `commands`. */
function service(dir: string) {
  const svc = new DictationService({ configDir: dir, engine: () => null, now: () => Date.now() });
  cleanups.push(() => svc.close());
  return svc;
}

/** Starts the fake helper reporting `grants` as given from `backend`, and waits for its `ready`. */
async function startHelper(
  svc: DictationService,
  o: { backend: string; grants: string; commands: string },
): Promise<void> {
  svc.start(
    [
      process.execPath,
      FAKE_HELPER,
      "dictate",
      "--backend",
      o.backend,
      "--grants",
      o.grants,
      "--commands-log",
      o.commands,
    ],
    KEYS,
  );
  await until(() => svc.status().state === "idle", 10_000, "the helper ready");
  // The commands sent at `ready` (rebind and the rest) are written by now; one rebind is the mark.
  await until(() => commandsOf(o.commands).includes("rebind"), 5000, "the rebind logged");
}

function commandsOf(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => (JSON.parse(l) as { type?: string }).type ?? l);
}

const asks = (file: string) => commandsOf(file).filter((c) => c === "ask_accessibility").length;

describe("[T4.36] the prompting call is asked for once per install", () => {
  test("a macOS helper with Accessibility denied is asked once, and not again on the next start", async () => {
    const t = tempDir("akou-a11y-ask-");
    cleanups.push(t.cleanup);
    const svc = service(t.dir);
    const first = join(t.dir, "first.jsonl");
    await startHelper(svc, { backend: "cgeventtap", grants: "mic", commands: first });
    await until(() => asks(first) === 1, 5000, "the ask sent");
    expect(existsSync(join(t.dir, DICTATION_DIR, A11Y_ASKED))).toBe(true);
    await svc.stop();

    // The same install starts dictation again: the dialog was asked for, so never twice.
    const second = join(t.dir, "second.jsonl");
    await startHelper(svc, { backend: "cgeventtap", grants: "mic", commands: second });
    expect(svc.status().grants?.accessibility).toBe("denied");
    expect(asks(second)).toBe(0);
    expect(asks(first)).toBe(1);
  }, 30_000);

  test("controls: the grant given, or a key source that is not macOS's, is never asked", async () => {
    const t = tempDir("akou-a11y-noask-");
    cleanups.push(t.cleanup);
    const svc = service(t.dir);
    const given = join(t.dir, "given.jsonl");
    await startHelper(svc, { backend: "cgeventtap", grants: "mic,accessibility", commands: given });
    await svc.stop();
    // Linux's evdev reports `accessibility` denied when no keyboard is readable: no macOS dialog.
    const linux = join(t.dir, "linux.jsonl");
    await startHelper(svc, { backend: "evdev", grants: "mic", commands: linux });
    expect(svc.status().grants?.accessibility).toBe("denied");
    expect(asks(given)).toBe(0);
    expect(asks(linux)).toBe(0);
    expect(existsSync(join(t.dir, DICTATION_DIR, A11Y_ASKED))).toBe(false);
  }, 30_000);
});

type Follow = Parameters<PillDictation["follow"]>[0];

/** The pill's main side over a hand-driven dictation whose `ready` said `accessibility`. */
function pill(o: { platform?: string; accessibility: string | null }) {
  const st = { state: "idle", accessibility: o.accessibility };
  const followers = new Set<Follow>();
  const d: PillDictation = {
    status: () => ({
      state: st.state,
      loading: false,
      swallow_keys: false,
      accessibility: st.accessibility,
    }),
    follow: (fn) => {
      followers.add(fn);
      return () => followers.delete(fn);
    },
    control: async () => true,
  };
  const states: PillState[] = [];
  const due: { ms: number; fn: () => void; live: boolean }[] = [];
  const panes: string[] = [];
  const p = pillRpc(
    d,
    () => ({ state: (s) => states.push(s), level: () => {}, preview: () => {}, chip: () => {} }),
    {
      platform: o.platform ?? "darwin",
      hotkey: () => "RightCommand",
      label: hotkeyLabel,
      now: () => 0,
      onVisible: () => {},
      preview: { setting: () => false },
      later: (ms, fn) => {
        const t = { ms, fn, live: true };
        due.push(t);
        return () => {
          t.live = false;
        };
      },
      grant: async () => {
        panes.push("accessibility");
        return true;
      },
    },
  );
  cleanups.push(() => p.close());
  const to = (state: string, accessibility = st.accessibility) => {
    st.state = state;
    st.accessibility = accessibility;
    p.update();
  };
  const run = (ms: number) => {
    for (const t of due.splice(0)) if (t.live && t.ms === ms) t.fn();
  };
  return { p, to, run, states, panes };
}

const DENIED: PillState = {
  state: "notice",
  reason: "grant-denied",
  message: A11Y_OFF,
  detail: A11Y_STALE_SHORT,
  actions: ["grant"],
};

describe("[T4.36] the island says dictation is off while Accessibility is denied", () => {
  test("denied: the line with the pane's button, with no time limit, back after a session", () => {
    const f = pill({ accessibility: "denied" });
    f.to("idle");
    expect(f.p.shown()).toEqual(DENIED);
    expect(A11Y_OFF).toBe("Dictation is off: allow akou under Accessibility");
    // No timer takes it down.
    f.run(10_000);
    expect(f.p.shown()).toEqual(DENIED);
    // The tray's door starts a session: it takes the island, and the line comes back after it.
    f.to("listening");
    expect(f.p.shown().state).toBe("listening");
    f.to("idle");
    expect(f.p.shown()).toEqual(DENIED);
  });

  test("the grant arrives (the helper says ready again): the line goes", () => {
    const f = pill({ accessibility: "denied" });
    f.to("idle");
    expect(f.p.shown()).toEqual(DENIED);
    f.to("idle", "granted");
    expect(f.p.shown()).toEqual({ state: "hidden" });
  });

  test("its button opens the pane and the line stays down until the grant is denied again", async () => {
    const f = pill({ accessibility: "denied" });
    f.to("idle");
    expect(await f.p.handlers.control({ action: "grant" })).toBe(true);
    expect(f.panes).toEqual(["accessibility"]);
    expect(f.p.shown()).toEqual({ state: "hidden" });
    f.to("idle");
    expect(f.p.shown()).toEqual({ state: "hidden" });
    // Given, then taken again: the line is back.
    f.to("idle", "granted");
    f.to("idle", "denied");
    expect(f.p.shown()).toEqual(DENIED);
  });

  test("mutated control: the grant given, unknown, or off macOS shows no line", () => {
    for (const [platform, accessibility] of [
      ["darwin", "granted"],
      ["darwin", null],
      ["linux", "denied"],
      ["win32", "denied"],
    ] as const) {
      const f = pill({ platform, accessibility });
      f.to("idle");
      expect(f.p.shown()).toEqual({ state: "hidden" });
      expect(f.states.some((s) => s.state === "notice")).toBe(false);
    }
  });
});

/** The three grants as `akou doctor` reads them on macOS from the command line: all unknown. */
const MAC_LOCAL: Grant[] = [
  { name: "mic", state: "unknown", detail: "the app's" },
  { name: "system audio", state: "unknown", detail: "the app's" },
  { name: "accessibility", state: "unknown", detail: "the dictation key's" },
];

/** A doctor context whose API answers `GET /dictation` with `grants`, or throws when null. */
function doctorCtx(grants: Record<string, string> | null, env: Record<string, string> = {}) {
  const asked: string[] = [];
  const ctx = {
    io: { env },
    grants: { check: async () => MAC_LOCAL, request: async () => "settings opened" as const },
    client: {
      request: async (method: string, path: string, o: { launch?: boolean } = {}) => {
        asked.push(`${method} ${path} launch=${o.launch}`);
        if (grants === null) throw new Error("akou is not running");
        return { status: 200, body: { enabled: true, grants } };
      },
    },
  } as unknown as Ctx;
  return { ctx, asked };
}

describe("[T4.36] akou doctor reads the grants from the running app", () => {
  test("denied and granted come from GET /v1/dictation, never launching the app", async () => {
    const { ctx, asked } = doctorCtx({ mic: "granted", accessibility: "denied" });
    const out = await grantStates(ctx, false);
    expect(out.map((g) => [g.name, g.state])).toEqual([
      ["mic", "granted"],
      ["system audio", "unknown"],
      ["accessibility", "missing"],
    ]);
    expect(out[2]?.detail).toContain("switch it off and on again");
    expect(asked).toEqual(["GET /dictation launch=false"]);
  });

  test("mutated control: the grant given reads granted", async () => {
    const { ctx } = doctorCtx({ mic: "granted", accessibility: "granted" });
    const out = await grantStates(ctx, false);
    expect(out.find((g) => g.name === "accessibility")?.state).toBe("granted");
  });

  test("no app answering, or a remote akou, leaves the grants unknown", async () => {
    const none = doctorCtx(null);
    expect((await grantStates(none.ctx, false)).map((g) => g.state)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
    const remote = doctorCtx(
      { mic: "granted", accessibility: "granted" },
      { AKOU_URL: "http://192.0.2.1:7123" },
    );
    expect(await appGrants(remote.ctx)).toBeNull();
    expect(remote.asked).toEqual([]);
  });

  test("a grant read here already, or a word the app does not settle, is kept as it is", () => {
    const local: Grant[] = [
      { name: "mic", state: "missing", detail: "registry" },
      { name: "accessibility", state: "unknown", detail: "x" },
    ];
    expect(withAppGrants(local, { mic: "granted", accessibility: "not-asked" })).toEqual(local);
  });
});
