/**
 * The `akou-dictate/1` contract from the app's side (src/main/dictation/protocol.ts), against the
 * lines in tests/fixtures/akou-dictate/. The Rust helper's test `the_shared_fixture_lines_match_the_app`
 * (native/akou-capture/src/dictate/protocol.rs) writes the same helper lines byte for byte and
 * parses the same app lines, so a name changed on one side only fails one of the two.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppToHelper,
  END_REASONS,
  encodeCommand,
  parseHelperLine,
} from "../src/main/dictation/protocol.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "akou-dictate");
const read = (name: string) =>
  readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);

test("every line the Rust helper writes is a trusted message, never log text", () => {
  const lines = read("helper-lines.jsonl");
  expect(lines.length).toBe(25);
  for (const line of lines) {
    const m = parseHelperLine(line);
    expect({ line, kind: m.kind }).toEqual({ line, kind: "msg" });
  }
  // Every end reason the helper can send is in the fixture, and the app knows each one.
  const reasons = lines
    .map((l) => JSON.parse(l) as { type: string; reason?: string })
    .filter((o) => o.type === "session.ended")
    .map((o) => o.reason);
  expect(reasons).toEqual([...END_REASONS]);
});

test("positive control: a line in the old dialect is only log text", () => {
  for (const line of [
    '{"type":"ready","protocol":"akou-dictate/1","version":"1","backend":"x","swallow_keys":true,"grants":{"mic":true,"accessibility":true}}',
    '{"type":"bound","hotkey":"RightCommand"}',
    '{"type":"session.ended","id":"1","reason":"interrupt"}',
    // A press whose frame has no area, or one that is not a yes or no, is not trusted (DC-O1).
    '{"type":"press","on":true,"frame":{"x":0,"y":0,"width":0,"height":10}}',
    '{"type":"press","on":"yes"}',
  ]) {
    expect(parseHelperLine(line).kind).toBe("text");
  }
});

test("every command the app writes is the fixture's line, which the Rust helper parses", () => {
  const target = { app: "Slack", pid: 7, window: "w1", field: "editable" as const };
  const commands: AppToHelper[] = [
    {
      type: "rebind",
      hotkey: "RightCommand",
      draft: "",
      fixLast: "",
      pasteLast: "",
      activation: "hold-or-toggle",
    },
    {
      type: "insert",
      id: "1",
      text: "hello",
      method: "paste",
      send_key: "none",
      target,
      read_field: true,
    },
    { type: "settled", id: "1" },
    { type: "focus", target: { ...target, field: "secure" } },
    { type: "session.start" },
    { type: "session.stop" },
    { type: "session.cancel" },
    { type: "rebuild_mic", device: "default" },
    { type: "warm", mode: "auto" },
    { type: "record_keys", on: true },
    { type: "meter", on: true },
    { type: "stop" },
  ];
  expect(commands.map((c) => encodeCommand(c).trimEnd())).toEqual(read("app-lines.jsonl"));
});
