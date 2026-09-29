/**
 * The Settings page's words (docs/ux/design-explorations/sd-a-settings.html): every setting it
 * shows has a human label, placed on the page or one of its Advanced pages, and no label, help
 * line or choice quotes a setting's key or a value in code quotes.
 */

import { describe, expect, test } from "bun:test";
import { SETTINGS } from "../../src/main/config/schema.ts";
import { dictationKeys, SERVER_GROUPS } from "../../src/ui/dictation-page.ts";
import { WORDS } from "../../src/ui/settings-labels.ts";
import { placedKeys, settingsKeys } from "../../src/ui/settings-page.ts";

const keys = Object.keys(SETTINGS);

describe("the Settings page's words", () => {
  test("every key the page is the home of has a label and a place", () => {
    const home = settingsKeys(SETTINGS);
    expect(home.length).toBeGreaterThan(40);
    // The after-call row says what the file sends where, in words of its own.
    const drawn = new Set(["hooks", "webhook.url"]);
    expect(home.filter((k) => !WORDS[k] && !drawn.has(k))).toEqual([]);
    const placed = placedKeys();
    expect(home.filter((k) => !placed.has(k))).toEqual([]);
  });

  test("every key the Dictation page and its server mode show has a label", () => {
    const shown = [...dictationKeys(), ...SERVER_GROUPS.flatMap((g) => g.keys)];
    expect(shown.length).toBeGreaterThan(40);
    expect(shown.filter((k) => !WORDS[k])).toEqual([]);
    // Every dictation key the registry has is on the page or its Advanced page.
    expect(keys.filter((k) => k.startsWith("dictation.") && !shown.includes(k))).toEqual([]);
  });

  test("no label, help or choice quotes a key or a value in code quotes", () => {
    for (const [key, w] of Object.entries(WORDS)) {
      const text = [w.label, w.help ?? "", w.empty ?? "", ...(w.choices ?? []).map((c) => c[1])];
      for (const t of text) {
        expect(`${key}: ${t.includes("`")}`).toBe(`${key}: false`);
        const quoted = keys.filter((k) => t.includes(k));
        expect({ key, quoted }).toEqual({ key, quoted: [] });
      }
      // One short line of help at most.
      expect({ key, long: (w.help ?? "").length > 110 }).toEqual({ key, long: false });
    }
  });

  test("each choice names a value the registry takes", () => {
    for (const [key, w] of Object.entries(WORDS)) {
      const values = (SETTINGS as Record<string, { values?: readonly string[] }>)[key]?.values;
      if (!w.choices || !values) continue;
      const unknown = w.choices.map(([v]) => v).filter((v) => !values.includes(v));
      expect({ key, unknown }).toEqual({ key, unknown: [] });
    }
  });

  test("each value the registry takes has a choice, so none becomes unreachable", () => {
    let checked = 0;
    for (const [key, w] of Object.entries(WORDS)) {
      const values = (SETTINGS as Record<string, { values?: readonly string[] }>)[key]?.values;
      if (!w.choices || !values) continue;
      checked++;
      const offered = new Set(w.choices.map(([v]) => v));
      const missing = values.filter((v) => !offered.has(v));
      expect({ key, missing }).toEqual({ key, missing: [] });
    }
    expect(checked).toBeGreaterThan(0);
  });
});
