/**
 * Voices across calls from the command line (docs/DESIGN.md section 6.1):
 *
 *   akou voices [list]
 *   akou voices rename OLD NEW
 *   akou voices forget NAME [--call ID]  |  akou voices forget --call ID  |  akou voices forget --all
 *   akou voices refuse SPK [-c CALL]
 *
 * `akou name c2 Ben` names a speaker and teaches akou that voice; these commands look after what it
 * learned. They reach the app on this computer only: an `ak_` key is refused (exit 77), and with
 * `voices.enabled` off they exit 78. No command prints a voiceprint.
 */

import { formatLocalDate, formatWall } from "../../../core/log/clock.ts";
import { bool, str } from "../args.ts";
import { type ApiResponse, EXIT } from "../client.ts";
import { api, type Body, type Command, type Ctx, finish, localZone, ref } from "../context.ts";
import { usage } from "./calls.ts";

/** Seconds as a person reads them: `45 s`, `12 min`. */
function speech(secs: number): string {
  return secs < 60 ? `${Math.round(secs)} s` : `${Math.round(secs / 60)} min`;
}

/** When akou last heard a voice, in local time: `2026-11-27 10:12`. */
function lastHeard(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const tz = localZone();
  return `${formatLocalDate(t, tz)} ${formatWall(t, tz, { seconds: false })}`;
}

function listText(b: Body): string {
  const voices = (b.voices ?? []) as Body[];
  if (voices.length === 0)
    return "akou knows no voice yet. Name a speaker in a call (akou name c2 Ben) to teach it one.";
  return voices
    .map((v) => {
      const n = (v.calls as string[]).length;
      return `${v.name}  ${n} call${n === 1 ? "" : "s"}, ${speech(v.secs)} of speech, last heard ${lastHeard(v.lastSeen)}`;
    })
    .join("\n");
}

/** `finish`, with voice recognition turned off said plainly and exit 78. */
function done(ctx: Ctx, r: ApiResponse, human: (b: Body) => string): number {
  if (r.body?.error === "voices_off") {
    const message =
      "voice recognition is off: turn on voices.enabled (Settings > Speakers, or akou config set voices.enabled true)";
    if (ctx.json) ctx.io.out(JSON.stringify({ error: "voices_off", message }));
    else ctx.io.err(`akou: ${message}`);
    return EXIT.config;
  }
  return finish(ctx, r, human);
}

export const voicesCommand: Command = {
  name: "voices",
  summary: "The voices akou recognises across calls: list, rename, forget, refuse a match",
  usage:
    "akou voices [list] | akou voices rename OLD NEW | akou voices forget NAME [--call ID] | --all | akou voices refuse SPK [-c CALL]   [--json]",
  flags: {
    call: {
      type: "string",
      short: "c",
      value: "CALL",
      desc: "forget: only what this call id taught; refuse: live or a call id (default: live)",
    },
    all: { type: "boolean", desc: "forget: every voice, and delete voices.yaml" },
  },
  notes: [
    "`akou name c2 Ben` names a speaker and teaches akou the voice; a name akou finds by voice in a later call shows as `Ben (voice)` until someone confirms it by naming the speaker the same way.",
    "Voiceprints stay in voices.yaml in akou's config folder on this computer; no command prints one.",
  ],
  examples: [
    "akou voices",
    'akou voices rename Ben "Ben Ortiz"',
    "akou voices forget Ben",
    "akou voices forget Ben --call 01J8Z6Q4M2VX0K7B3D4E5F6G7H",
    "akou voices forget --all",
    "akou voices refuse c2",
  ],
  run: async (ctx, p) => {
    const [sub, ...args] = p.positional;
    const call = str(p, "call");
    switch (sub) {
      case undefined:
      case "list": {
        if (args.length > 0 || call !== undefined || bool(p, "all"))
          return usage(ctx, "voices list takes no arguments");
        const r = await api(ctx, "GET", "/voices");
        return done(ctx, r, listText);
      }
      case "rename": {
        const [from, to] = args;
        if (!from || !to || args.length > 2)
          return usage(ctx, 'voices rename needs the old and the new name: rename Ben "Ben Ortiz"');
        const r = await api(ctx, "POST", "/voices/rename", { body: { from, to } });
        return done(ctx, r, (b) => `${b.from} is ${b.to} from now on`);
      }
      case "forget": {
        const name = args.join(" ").trim();
        if (bool(p, "all")) {
          if (name !== "" || call !== undefined)
            return usage(ctx, "voices forget --all takes no name and no --call");
          const r = await api(ctx, "POST", "/voices/forget", { body: { all: true } });
          return done(ctx, r, () => "Forgot every voice");
        }
        if (name === "" && call === undefined)
          return usage(ctx, "voices forget needs a name, --call ID or --all");
        const r = await api(ctx, "POST", "/voices/forget", {
          body: { ...(name !== "" ? { name } : {}), ...(call !== undefined ? { call } : {}) },
        });
        return done(ctx, r, () =>
          name === ""
            ? `Forgot what call ${call} taught`
            : call === undefined
              ? `Forgot ${name}`
              : `Forgot what call ${call} taught about ${name}`,
        );
      }
      case "refuse": {
        const [spk] = args;
        if (!spk || args.length > 1 || bool(p, "all"))
          return usage(ctx, "voices refuse needs one speaker id: refuse c2");
        const r = await api(ctx, "POST", `/calls/${ref(p)}/speakers/refuse`, { body: { spk } });
        return done(ctx, r, (b) => `${b.spk} is not ${b.name}`);
      }
      default:
        return usage(ctx, `voices needs one of list, rename, forget, refuse (not "${sub}")`);
    }
  },
};
