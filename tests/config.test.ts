/**
 * The settings registry (docs/DESIGN.md section 10, TRAPS "Configuration and documentation").
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultModelsDir } from "../src/main/asr/models.ts";
import {
  buildSettings,
  loadConfig,
  patchConfig,
  resolvePaths,
  SETTING_KEYS,
  settingsReference,
  validateSetting,
} from "../src/main/config/schema.ts";
import { tempDir } from "./helpers.ts";

function home(settings: unknown): { env: Record<string, string>; cleanup: () => void } {
  const t = tempDir();
  const dir = join(t.dir, ".config", "akou");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    typeof settings === "string" ? settings : JSON.stringify(settings),
  );
  return { env: { AKOU_HOME: t.dir }, cleanup: t.cleanup };
}

describe("[T4.9] Ranges bypassed by a hand-edited file", () => {
  test("segmentPause 99 in the file is refused with a message and the default is used", () => {
    const h = home({ "asr.segmentPause": 99, "asr.segmentWindow": 10 });
    const c = loadConfig(h.env);
    expect(c.settings["asr.segmentPause"]).toBe(0.7);
    // The rest of the file still applies.
    expect(c.settings["asr.segmentWindow"]).toBe(10);
    expect(c.issues).toEqual([
      {
        key: "asr.segmentPause",
        source: "file",
        message: "asr.segmentPause: 99 is out of range (0.2 to 5); using the default",
      },
    ]);
    // The same value through the API path is refused the same way.
    const p = patchConfig({}, { "asr.segmentPause": 99 }, c.paths);
    expect(p).toEqual({ ok: false, errors: ["asr.segmentPause: 99 is out of range (0.2 to 5)"] });
    h.cleanup();
  });

  test("positive control: an in-range value from the file is used", () => {
    const h = home({ "asr.segmentPause": 1.5 });
    const c = loadConfig(h.env);
    expect(c.settings["asr.segmentPause"]).toBe(1.5);
    expect(c.issues).toEqual([]);
    h.cleanup();
  });

  test("wrong types, unknown keys, a fractional port, and a pause above the window are refused", () => {
    const h = home({
      "api.port": 80.5,
      "capture.mic": 3,
      "asr.segmentPause": 4,
      "asr.segmentWindow": 3,
      "ui.theme": "dark",
    });
    const c = loadConfig(h.env);
    expect(c.settings["api.port"]).toBe(8476);
    expect(c.settings["capture.mic"]).toBe("default");
    expect(c.settings["asr.segmentPause"]).toBe(0.7);
    expect(c.settings["asr.segmentWindow"]).toBe(12);
    expect(c.issues.map((i) => i.key)).toEqual([
      "api.port",
      "capture.mic",
      "ui.theme",
      "asr.segmentPause",
    ]);
    h.cleanup();
  });

  test("a file that is not a JSON object is refused whole", () => {
    for (const bad of ["{nope", "[1,2]"]) {
      const h = home(bad);
      const c = loadConfig(h.env);
      expect(c.issues[0]?.key).toBe("*");
      expect(c.settings["api.port"]).toBe(8476);
      h.cleanup();
    }
  });

  test("port 0 (any free port) is allowed outside the range; 80 is not", () => {
    expect(validateSetting("api.port", 0).ok).toBe(true);
    expect(validateSetting("api.port", 80).ok).toBe(false);
  });

  test("vocab.languages takes only languages akou has a word list for; empty means all", () => {
    expect(validateSetting("vocab.languages", []).ok).toBe(true);
    expect(validateSetting("vocab.languages", ["es", "en"]).ok).toBe(true);
    const bad = validateSetting("vocab.languages", ["en", "klingon"]);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.error).toMatch(/klingon is not one of en, es/);
  });
});

describe("[spike] The boost is a slider", () => {
  test("a config file with vocab.boost is refused, and the schema has no boost at all", () => {
    const h = home({ "vocab.boost": 5 });
    const c = loadConfig(h.env);
    expect(c.issues[0]?.message).toContain("there is no global boost setting");
    expect(SETTING_KEYS.some((k) => /boost/i.test(k))).toBe(false);
    h.cleanup();
  });
});

describe("the environment", () => {
  test("only AKOU_HEADLESS and AKOU_MODELS_DIR override settings; AKOU_HOME moves the home", () => {
    const h = home({});
    const env = { ...h.env, AKOU_HEADLESS: "1", AKOU_MODELS_DIR: "/models" };
    const c = loadConfig(env);
    expect(c.settings["app.headless"]).toBe(true);
    expect(c.settings["asr.modelsDir"]).toBe("/models");
    expect(c.settings["recordings.root"]).toBe(
      join(h.env.AKOU_HOME as string, "Recordings", "akou"),
    );
    expect(c.paths.configDir).toBe(join(h.env.AKOU_HOME as string, ".config", "akou"));
    expect(loadConfig({ ...h.env, AKOU_HEADLESS: "0" }).settings["app.headless"]).toBe(false);
    const bad = loadConfig({ ...h.env, AKOU_HEADLESS: "maybe" });
    expect(bad.settings["app.headless"]).toBe(false);
    expect(bad.issues[0]?.source).toBe("env");
    // No other variable does anything.
    const noise = loadConfig({ ...h.env, AKOU_PORT: "9", HARK_PORT: "9" });
    expect(noise.settings["api.port"]).toBe(8476);
    h.cleanup();
  });

  test("the default models folder follows LOCALAPPDATA on Windows and XDG_DATA_HOME on Linux", () => {
    const t = tempDir();
    const env: Record<string, string | undefined> = {
      ...process.env,
      LOCALAPPDATA: t.dir,
      XDG_DATA_HOME: t.dir,
      AKOU_MODELS_DIR: undefined,
      AKOU_HOME: undefined,
    };
    // The default is computed when the module loads, so a fresh process reads it.
    const schema = pathToFileURL(join(import.meta.dir, "..", "src", "main", "config", "schema.ts"));
    const r = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const { SETTINGS } = await import(${JSON.stringify(schema.href)}); console.log(SETTINGS["asr.modelsDir"].default);`,
      ],
      { env },
    );
    expect(r.stdout.toString().trim()).toBe(
      defaultModelsDir({ LOCALAPPDATA: t.dir, XDG_DATA_HOME: t.dir }),
    );
    t.cleanup();
  });

  test("on Windows the config folder is under APPDATA unless AKOU_HOME is set", () => {
    expect(resolvePaths({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32").configDir).toBe(
      join("C:\\Users\\a\\AppData\\Roaming", "akou"),
    );
    expect(resolvePaths({ AKOU_HOME: "/t", APPDATA: "x" }, "win32").configDir).toBe(
      join("/t", ".config", "akou"),
    );
  });
});

describe("the speaker-label engine", () => {
  test("Nemotron is the default; embeddings is the other choice; anything else is refused", () => {
    const paths = resolvePaths({ AKOU_HOME: "/t" });
    expect(buildSettings(paths, {}, {}).settings["asr.diarizer"]).toBe("nemotron");
    expect(validateSetting("asr.diarizer", "embeddings").ok).toBe(true);
    expect(validateSetting("asr.diarizer", "pyannote").ok).toBe(false);
    expect(patchConfig({}, { "asr.diarizer": "embeddings" }, paths).ok).toBe(true);
  });
});

describe("the API may not name a program to run", () => {
  test("capture.helper is read from the file but refused over PATCH /config", () => {
    const paths = resolvePaths({ AKOU_HOME: "/t" });
    expect(patchConfig({}, { "capture.helper": ["/bin/sh"] }, paths).ok).toBe(false);
    const c = buildSettings(paths, { "capture.helper": ["/opt/akou-capture"] }, {});
    expect(c.settings["capture.helper"]).toEqual(["/opt/akou-capture"]);
  });

  test("asr.diarizeHelper, like capture.helper, is read from the file but refused over PATCH", () => {
    const paths = resolvePaths({ AKOU_HOME: "/t" });
    expect(patchConfig({}, { "asr.diarizeHelper": ["/bin/sh"] }, paths).ok).toBe(false);
    const c = buildSettings(paths, { "asr.diarizeHelper": ["/opt/akou-diarize"] }, {});
    expect(c.settings["asr.diarizeHelper"]).toEqual(["/opt/akou-diarize"]);
  });

  test("null resets a key to its default", () => {
    const paths = resolvePaths({ AKOU_HOME: "/t" });
    const r = patchConfig({ "asr.threads": 4 }, { "asr.threads": null }, paths);
    expect(r).toEqual({ ok: true, file: {} });
  });
});

test("the reference table is generated from the registry and lists every key", () => {
  const table = settingsReference();
  for (const k of SETTING_KEYS) expect(table).toContain(`\`${k}\``);
});
