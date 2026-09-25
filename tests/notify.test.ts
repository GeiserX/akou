/**
 * Notifications (docs/ux/DESKTOP.md section 8, DK-N1, DK-N2, DK-N4) and the failed tray or hotkey
 * start (DK-T5): the policy as a table over `notifyFor`, then the shell over a whole app with the
 * fake `NativeUi`, so a start from an agent, dead capture and a refused start reach the fake the
 * way they would reach Notification Center.
 */

import { describe, expect, test } from "bun:test";
import type { LogEvent } from "../src/core/log/events.ts";
import type { ModelSpecEntry } from "../src/main/asr/models.ts";
import {
  type NotifyEvent,
  notifyFor,
  originOf,
  type StartOrigin,
} from "../src/main/window/notify.ts";
import { modelsCardText } from "../src/ui/models-text.ts";
import { appRig, speechWav } from "./api-helpers.ts";
import { until } from "./capture-helpers.ts";
import { tempDir } from "./helpers.ts";
import { shellOn } from "./shell-helpers.ts";

const LONG = 60_000;

describe("notifyFor", () => {
  const at = (windowFocused: boolean, platform = "darwin") => ({ windowFocused, platform });
  const started = (origin: StartOrigin): NotifyEvent => ({
    type: "started",
    call: "c1",
    origin,
  });

  test("[DK-N1] the rows marked Always notify even with the window in front; the window's own starts never do", () => {
    const rows: [NotifyEvent, ReturnType<typeof at>, { title: string; body: string } | null][] = [
      [started("agent"), at(false), { title: "Recording started", body: "Started by an agent" }],
      [started("agent"), at(true), { title: "Recording started", body: "Started by an agent" }],
      [
        started("cli"),
        at(true),
        { title: "Recording started", body: "Started from the command line" },
      ],
      [
        started("hotkey"),
        at(false),
        { title: "Recording started", body: "Started from the hotkey" },
      ],
      [
        started("tray"),
        at(false),
        { title: "Recording started", body: "Started from the menu bar" },
      ],
      [
        started("tray"),
        at(false, "linux"),
        { title: "Recording started", body: "Started from the tray" },
      ],
      [started("window"), at(true), null],
      [started("window"), at(false), null],
      [
        { type: "refused", origin: "agent", code: "already_recording" },
        at(true),
        { title: "Could not start recording", body: "A call is already recording." },
      ],
      [{ type: "refused", origin: "window", code: "models_missing" }, at(true), null],
      [
        { type: "shared", origin: "agent", call: "c1" },
        at(true),
        { title: "This call is shared live", body: "Stop it from the akou window." },
      ],
      [{ type: "shared", origin: "window", call: "c1" }, at(false), null],
      [
        { type: "capture", call: "c1", ch: "call", state: "dead" },
        at(false),
        { title: "Call side silent", body: "akou is rebuilding the capture." },
      ],
      [
        { type: "capture", call: "c1", ch: "mic", state: "stalled" },
        at(false),
        { title: "Microphone silent", body: "akou is restarting the capture." },
      ],
      [{ type: "capture", call: "c1", ch: "call", state: "dead" }, at(true), null],
      [{ type: "capture", call: "c1", ch: "call", state: "ok" }, at(false), null],
      [{ type: "capture", call: "c1", ch: "call", state: "no-buffers" }, at(false), null],
    ];
    for (const [event, ctx, want] of rows) {
      const got = notifyFor(event, ctx);
      expect(got && { title: got.title, body: got.body }).toEqual(want);
    }
  });

  test("a refusal names what fixes it: the window's download card, or the privacy pane", () => {
    const missing = modelsCardText({
      state: "missing",
      bytes: 0,
      total: 1,
      dir: "/m",
    } as never);
    const models = notifyFor(
      { type: "refused", origin: "tray", code: "models_missing" },
      at(false),
    );
    expect(models?.body).toContain(`"${missing?.button}"`);
    expect(models?.body).toContain("akou window");
    const perm = (platform: string) =>
      notifyFor({ type: "refused", origin: "hotkey", code: "permission" }, at(false, platform))
        ?.body;
    expect(perm("darwin")).toContain("System Settings > Privacy & Security");
    expect(perm("win32")).toContain("Settings > Privacy > Microphone");
    const suspect = notifyFor(
      { type: "capture", call: "c1", ch: "call", state: "permission-suspect" },
      at(false),
    );
    expect(suspect?.title).toBe("Call side silent");
    expect(suspect?.body).toContain("System Audio Recording");
  });

  test("the author of a start names its door", () => {
    expect(originOf("user")).toBe("window");
    expect(originOf("agent:cli")).toBe("cli");
    expect(originOf("agent:claude-code")).toBe("agent");
    expect(originOf("agent:api")).toBe("agent");
  });
});

/** A registry whose one file is not on disk, so every start is refused `models_missing`. */
const MISSING: ModelSpecEntry[] = [
  {
    id: "tiny",
    job: "test",
    licence: "MIT",
    source: "test",
    files: [{ name: "a.onnx", url: "http://127.0.0.1:9/a.onnx", sha256: "0".repeat(64), size: 1 }],
  },
];

describe("the shell's notifications over a whole app", () => {
  test(
    "[DK-N1] an agent's POST /calls with the window closed notifies once; the same start from the focused window does not",
    async () => {
      const rig = await appRig();
      const { shell, f, bridge } = await shellOn(rig);
      const r = await rig.api("POST", "/calls", {});
      expect(r.status).toBe(201);
      await until(() => f.notices.length > 0, 5000, "the notification");
      await Bun.sleep(300);
      expect(f.notices).toEqual([{ title: "Recording started", body: "Started by an agent" }]);
      expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);

      // Positive control: the window is open and in front, and starts the call itself.
      shell.show();
      const w = await bridge.json("POST", "/calls", {});
      expect(w.status).toBe(201);
      await Bun.sleep(300);
      expect(f.notices).toHaveLength(1);
      expect((await rig.api("POST", "/calls/live/stop")).status).toBe(200);

      // The command line is announced even with the window in front.
      const cli = await rig.api("POST", "/calls", {}, { "x-akou-client": "cli" });
      expect(cli.status).toBe(201);
      await until(() => f.notices.length > 1, 5000, "the second notification");
      expect(f.notices[1]).toEqual({
        title: "Recording started",
        body: "Started from the command line",
      });
      await rig.api("POST", "/calls/live/stop");
      await shell.close();
      await rig.close();
    },
    LONG,
  );

  test("[DK-N2] dead capture with the window closed notifies once, and again only after a minute", async () => {
    let now = Date.now();
    // The call side dies 1 s into every part; a part dead for 10 s is restarted, and its new
    // part dies again: a second `health {state: dead}` for the same call within the minute.
    const rig = await appRig({
      helperArgs: ["--call-dead-at", "1", "--speed", "5"],
      settings: { "capture.deadRestartSeconds": 10 },
    });
    const { shell, f } = await shellOn(rig, { now: () => now });
    const id = await rig.startCall();
    const silent = () => f.notices.filter((n) => n.title === "Call side silent");
    const deads = async () =>
      (await rig.app.events(id, 0)).filter(
        (e: LogEvent) => e.type === "health" && e.state === "dead",
      ).length;
    await until(async () => (await deads()) >= 2, 40_000, "a second dead health event");
    await Bun.sleep(200);
    expect(silent()).toEqual([
      { title: "Call side silent", body: "akou is rebuilding the capture." },
    ]);
    // Positive control for the once-a-minute rule: a minute on, the next one notifies.
    now += 61_000;
    const seen = await deads();
    await until(async () => (await deads()) > seen, 40_000, "the next dead health event");
    await until(() => silent().length === 2, 2000, "the notification a minute later");
    await rig.api("POST", "/calls/live/stop");
    await shell.close();
    await rig.close();
  }, 120_000);

  test(
    "[DK-T5] a tray start refused for missing models says why once, naming the download card, and opens the window on it",
    async () => {
      const rig = await appRig({ modelRegistry: MISSING });
      const { shell, f } = await shellOn(rig);
      expect(f.log.filter((l) => l.startsWith("window"))).toEqual([]);
      f.tray("record");
      await until(() => f.notices.length > 0, 5000, "the notification");
      await until(() => f.log.includes("show"), 5000, "the window");
      await Bun.sleep(300);
      expect(f.notices).toHaveLength(1);
      expect(f.notices[0]?.title).toBe("Could not start recording");
      // The card the window shows while the models are missing, by the words on its button.
      const models = (await rig.api("GET", "/models")).body;
      expect(models.state).toBe("missing");
      const card = modelsCardText(models);
      expect(card?.button).toBe("Download speech models");
      expect(f.notices[0]?.body).toContain(`"${card?.button}"`);
      // The hotkey's refusal says the same, once.
      await (f.shortcuts.get("Alt+Command+R") as () => Promise<void>)();
      await Bun.sleep(300);
      expect(f.notices.map((n) => n.title)).toEqual([
        "Could not start recording",
        "Could not start recording",
      ]);
      await shell.close();
      await rig.close();
    },
    LONG,
  );
});

/** The markers found in any notification's title or body (case-insensitive). */
function leaks(notices: { title: string; body: string }[], markers: string[]): string[] {
  const text = notices.map((n) => `${n.title}\n${n.body}`.toLowerCase()).join("\n");
  return markers.filter((m) => text.includes(m.toLowerCase()));
}

describe("notifications carry no call content", () => {
  test(
    "[DK-N4] Lock-screen leaks: no notification carries the call's title, workspace, names, notes or words",
    async () => {
      const wav = tempDir();
      const rig = await appRig({
        helperArgs: ["--wav", speechWav(wav.dir), "--call-dead-at", "1.5"],
      });
      const { shell, f } = await shellOn(rig);
      const title = "Qz9 Titlemarker";
      const workspace = "wsmarker7";
      const name = "Zelda Markerton";
      const note = "notemarker-42";
      const term = "Vocabmarker";
      const r = await rig.api("POST", "/calls", { title, workspace, vocab: [term] });
      expect(r.status).toBe(201);
      const id = r.body.call as string;
      // Every row an agent's call can reach: started, refused, shared, capture dead.
      expect((await rig.api("POST", "/calls", { title })).status).toBe(409);
      expect((await rig.api("POST", "/share", {})).status).toBe(201);
      const events = () => rig.app.events(id, 0);
      await until(
        async () => (await events()).some((e) => e.type === "seg"),
        20_000,
        "a transcript line",
      );
      expect((await rig.api("POST", `/calls/${id}/speakers`, { spk: "c1", name })).status).toBe(
        200,
      );
      expect((await rig.api("POST", `/calls/${id}/notes`, { text: note })).status).toBe(201);
      await until(
        async () => (await events()).some((e) => e.type === "health" && e.state === "dead"),
        20_000,
        "capture dead",
      );
      await until(() => f.notices.length >= 4, 5000, "a notification per row");
      expect(new Set(f.notices.map((n) => n.title))).toEqual(
        new Set([
          "Recording started",
          "Could not start recording",
          "This call is shared live",
          "Call side silent",
        ]),
      );
      const words = (await events())
        .filter((e) => e.type === "seg")
        .map((e) => ((e as { text?: string | null }).text ?? "").trim())
        .filter((t) => t !== "");
      expect(words.length).toBeGreaterThan(0);
      const markers = [title, workspace, name, note, term, id, ...words];
      expect(leaks(f.notices, markers)).toEqual([]);
      // Positive control: a notification that carried the title is caught.
      expect(leaks([...f.notices, { title: "Recording started", body: title }], markers)).toEqual([
        title,
      ]);
      await rig.api("DELETE", "/share", {});
      await rig.api("POST", "/calls/live/stop");
      await shell.close();
      await rig.close();
      wav.cleanup();
    },
    LONG,
  );
});
