/**
 * The dictation settings (docs/ux/DICTATION.md section 6) and the dictation keys (DC-A2, DC-A5):
 * every key of the spec's table is in the registry, each refusal says why, and the rules the
 * registry cannot say by type (the remote's URL is window-only, `remote` needs a URL) hold at `PATCH /config`'s check.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppRule,
  isSettingKey,
  patchConfig,
  redactSettings,
  resolvePaths,
  SETTINGS,
  validateApps,
  validateSetting,
} from "../src/main/config/schema.ts";
import {
  checkDictationHotkey,
  checkExtraHotkey,
  dictationHotkeyDefault,
  FIX_LAST_CHORD,
  fixLastDefault,
  hotkeyWarning,
  parseHotkey,
} from "../src/main/window/hotkey.ts";

const paths = resolvePaths({ AKOU_HOME: "/nonexistent-akou-home" }, "linux");

/** The keys of the section 6 table: every backticked key in its first column. */
function specKeys(): string[] {
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "ux", "DICTATION.md"), "utf8");
  const start = doc.indexOf("| Key | Default | Values | Group | Applies |");
  const table = doc.slice(start, doc.indexOf("\n\n", start));
  const keys: string[] = [];
  for (const row of table.split("\n").slice(2)) {
    const first = row.split("|")[1] ?? "";
    for (const m of first.matchAll(/`([a-zA-Z_.]+)`/g)) keys.push(m[1] as string);
  }
  return keys;
}

/** The spec's keys the registry lacks. */
function missing(keys: readonly string[], has: (k: string) => boolean): string[] {
  return keys.filter((k) => !has(k));
}

describe("the dictation keys of the spec are in the registry", () => {
  test("every key of the section 6 table", () => {
    const keys = specKeys();
    expect(keys.length).toBeGreaterThan(40);
    expect(missing(keys, isSettingKey)).toEqual([]);
  });

  test("positive control: a registry without one of them is caught", () => {
    const keys = specKeys();
    expect(missing(keys, (k) => isSettingKey(k) && k !== "dictation.sounds")).toEqual([
      "dictation.sounds",
    ]);
  });

  test("the defaults of the table", () => {
    expect(SETTINGS["dictation.enabled"].default).toBe(false);
    expect(SETTINGS["dictation.engine"].default).toBe("auto");
    expect(SETTINGS["dictation.silenceStopSeconds"].default).toBe(30);
    expect(SETTINGS["dictation.retainDays"].default).toBe(30);
    // DC-O1: a compositor may give the pill the keyboard, so Linux has none unless asked.
    expect(SETTINGS["dictation.pill"].default).toBe(process.platform === "linux" ? "off" : "top");
    expect(SETTINGS["server.dictation_slots"].default).toBe(1);
    expect(validateSetting("server.dictation_slots", 9).ok).toBe(false);
    expect(validateSetting("server.dictation_slots", 0).ok).toBe(true);
  });
});

describe("DC-A2: the dictation key", () => {
  test("a modifier alone with its side is a modifier-only binding", () => {
    expect(parseHotkey("RightCommand")).toEqual({
      kind: "modifier",
      key: "RightCommand",
      with: [],
    });
    expect(parseHotkey("Fn")).toEqual({ kind: "modifier", key: "Fn", with: [] });
    expect(parseHotkey("Control+Shift+Space")).toMatchObject({ kind: "chord", key: "Space" });
  });

  test("a left and a right of one modifier is refused with a message", () => {
    const r = parseHotkey("LeftOption+RightOption");
    expect(r).toEqual({ error: expect.stringContaining("a left and a right of one modifier") });
    expect(validateSetting("dictation.hotkey", "LeftOption+RightOption")).toMatchObject({
      ok: false,
    });
  });

  test("a modifier with no side, or a character key alone, is refused", () => {
    expect(checkDictationHotkey("Shift")).toContain("needs a side");
    expect(checkDictationHotkey("K")).toContain("every app");
    expect(checkDictationHotkey("RightShift")).toBeNull();
    expect(checkDictationHotkey("")).toBeNull();
  });

  test("Shift held first is fix last's form, not a dictation key", () => {
    expect(parseHotkey("Shift+RightCommand")).toEqual({
      kind: "modifier",
      key: "RightCommand",
      with: ["Shift"],
    });
    expect(checkDictationHotkey("Shift+RightCommand")).toContain("fix last");
    expect(checkExtraHotkey("Shift+RightCommand")).toBeNull();
    expect(validateSetting("dictation.hotkeyFixLast", "Shift+RightCommand").ok).toBe(true);
  });

  test("the defaults: Right Command, Right Control, a chord on Linux", () => {
    expect(dictationHotkeyDefault("darwin")).toBe("RightCommand");
    expect(dictationHotkeyDefault("win32")).toBe("RightControl");
    expect(dictationHotkeyDefault("linux")).toBe("Control+Shift+Space");
    for (const p of ["darwin", "win32", "linux"])
      expect(checkDictationHotkey(dictationHotkeyDefault(p))).toBeNull();
  });

  test("macOS warns on Option, which types symbols, and not on Right Command", () => {
    expect(hotkeyWarning("RightOption", "darwin")).toContain("symbol layer");
    expect(hotkeyWarning("Option+K", "darwin")).toContain("symbol layer");
    expect(hotkeyWarning("Alt+Space", "darwin")).toContain("symbol layer");
    expect(hotkeyWarning("RightCommand", "darwin")).toBeNull();
    expect(hotkeyWarning("Option+Command+K", "darwin")).toBeNull();
    expect(hotkeyWarning("Option+F5", "darwin")).toBeNull();
    expect(hotkeyWarning("K", "darwin")).toBeNull();
    // Off macOS the AltGr rule stays as it was.
    expect(hotkeyWarning("RightOption", "linux")).toBeNull();
    expect(hotkeyWarning("Control+Alt+X", "linux")).toContain("AltGr");
  });
});

describe("DC-A5: fix last's default", () => {
  test("Shift held before a modifier-only dictation key", () => {
    expect(fixLastDefault("RightCommand")).toBe("Shift+RightCommand");
    expect(fixLastDefault("RightControl")).toBe("Shift+RightControl");
  });

  test("a chord or a Shift key as the dictation key falls back to the chord", () => {
    expect(fixLastDefault(dictationHotkeyDefault("linux"))).toBe(FIX_LAST_CHORD);
    expect(fixLastDefault("RightShift")).toBe(FIX_LAST_CHORD);
    expect(checkExtraHotkey(FIX_LAST_CHORD)).toBeNull();
  });
});

describe("the rules the type cannot say", () => {
  test("DC-O2: pillPreview is on by default, both values pass, and the doc names the screen share", () => {
    expect(SETTINGS["dictation.pillPreview"].default).toBe(true);
    expect(validateSetting("dictation.pillPreview", true).ok).toBe(true);
    expect(validateSetting("dictation.pillPreview", false).ok).toBe(true);
    expect(validateSetting("dictation.pillPreview", "yes").ok).toBe(false);
    expect(SETTINGS["dictation.pillPreview"].doc).toContain("screen share");
  });

  test("DC-E2: every engine of the spec passes, best included; another name is refused", () => {
    for (const e of ["auto", "fast", "best", "remote"])
      expect(validateSetting("dictation.engine", e).ok).toBe(true);
    expect(validateSetting("dictation.engine", "slow").ok).toBe(false);
  });

  test("DC-E3: remote with no URL is refused at save; with one it passes", () => {
    const bare = patchConfig({}, { "dictation.engine": "remote" }, paths);
    expect(bare).toMatchObject({ ok: false });
    expect((bare as { errors: string[] }).errors.join()).toContain("dictation.remote.url");
    const withUrl = patchConfig(
      { "dictation.remote.url": "https://akou.example" },
      { "dictation.engine": "remote" },
      paths,
    );
    expect(withUrl.ok).toBe(true);
  });

  test("the remote's URL takes the URL checks of server.remotes", () => {
    expect(validateSetting("dictation.remote.url", "https://akou.example").ok).toBe(true);
    expect(validateSetting("dictation.remote.url", "http://10.0.0.5:8476").ok).toBe(true);
    expect(validateSetting("dictation.remote.url", "ftp://akou.example").ok).toBe(false);
    const creds = validateSetting("dictation.remote.url", "https://u:p@akou.example");
    expect(creds).toMatchObject({ ok: false, error: expect.stringContaining("remote.key") });
  });

  test("owner rule: the remote's URL is refused over HTTP and taken from the window", () => {
    const patch = { "dictation.remote.url": "https://akou.example" };
    const http = patchConfig({}, patch, paths);
    expect(http).toMatchObject({ ok: false });
    expect((http as { errors: string[] }).errors[0]).toContain("akou window");
    expect(patchConfig({}, patch, paths, { inProcess: true })).toMatchObject({
      ok: true,
      file: patch,
    });
  });

  test("positive control: the window cannot write a file-only key", () => {
    const hooks = [{ stage: "call.ended", command: "true" }];
    expect(patchConfig({}, { hooks }, paths, { inProcess: true }).ok).toBe(false);
    expect(patchConfig({}, { "capture.helper": ["x"] }, paths, { inProcess: true }).ok).toBe(false);
  });

  test("DC-G4: the remote key is a secret, never shown back", () => {
    expect(SETTINGS["dictation.remote.key"].secret).toBe(true);
    const shown = redactSettings({ "dictation.remote.key": "k-remote-1" });
    expect(shown["dictation.remote.key"]).toBe("(set)");
    expect(JSON.stringify(shown)).not.toContain("k-remote-1");
  });

  test("the languages are ISO 639 codes, and auto", () => {
    expect(validateSetting("dictation.language", "auto").ok).toBe(true);
    expect(validateSetting("dictation.language", "es").ok).toBe(true);
    expect(validateSetting("dictation.language", "Spanish").ok).toBe(false);
    expect(validateSetting("dictation.languages", ["en", "es"]).ok).toBe(true);
    expect(validateSetting("dictation.languages", ["english"]).ok).toBe(false);
  });
});

describe("DC-U9: the apps setting type", () => {
  const rule: AppRule = {
    app: "com.example.chat",
    mode: "draft-send",
    insert: "type",
    sendKey: "Enter",
  };

  test("a rule with known fields passes, and keeps only what it said", () => {
    expect(validateApps([rule])).toEqual({ ok: true, value: [rule] });
    expect(validateSetting("dictation.apps", [rule])).toMatchObject({ ok: true, value: [rule] });
  });

  test("an unknown field in a rule is refused", () => {
    expect(validateApps([{ ...rule, colour: "red" }])).toEqual({
      ok: false,
      error: 'rule 1: unknown field "colour"',
    });
  });

  test("a bad value, a missing app, two rules for one app and a non-list are refused", () => {
    expect(validateApps([{ ...rule, mode: "shout" }])).toMatchObject({ ok: false });
    expect(validateApps([{ mode: "draft" }])).toMatchObject({ ok: false });
    expect(validateApps([rule, rule])).toMatchObject({ ok: false });
    expect(validateApps({ app: "x" })).toMatchObject({ ok: false });
    expect(validateApps([{ app: "x", language: "Spanish" }])).toMatchObject({ ok: false });
  });

  test("a rule may carry the app's name to be shown by (akou-qx2), and nothing else of it", () => {
    const named = { ...rule, name: "Example Chat" };
    expect(validateApps([named])).toEqual({ ok: true, value: [named] });
    expect(validateApps([{ ...rule, name: 7 }])).toMatchObject({ ok: false });
    expect(validateApps([{ ...rule, name: "x".repeat(201) }])).toMatchObject({ ok: false });
  });

  test("PATCH /config refuses a rule the validator refuses", () => {
    const r = patchConfig({}, { "dictation.apps": [{ ...rule, colour: "red" }] }, paths);
    expect(r).toMatchObject({ ok: false });
  });
});
