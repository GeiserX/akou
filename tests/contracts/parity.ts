/**
 * Door parity, the one table (docs/TESTING.md TS-13, PRINCIPLES rule 3): every action akou offers,
 * and what each door calls it. `tests/contracts/parity.test.ts` reads the real doors (the CLI's
 * command registry, the API's route table, the tools the MCP server registers and the window's
 * source) and fails when a door named here lacks the action, when a door lacks it and the row
 * gives no reason, or when a door has an action no row maps. PG-A1 and PG-M4 close the gaps the
 * reasons name; CLI-31 renders this table into `docs/cli.md`.
 *
 * A door that has the action lists its names: CLI command names, API routes as `METHOD /path`,
 * MCP tool names, and for the window the source that performs it (a file under `src/` and a
 * piece of its code). A door that lacks it says why in `none`.
 */

export interface None {
  none: string;
}

/** Where the window performs an action: a file under `src/` and a fragment of its code. */
export interface WindowAt {
  file: string;
  has: string;
}

export interface Row {
  action: string;
  cli: readonly string[] | None;
  api: readonly string[] | None;
  mcp: readonly string[] | None;
  window: readonly WindowAt[] | None;
  /** Anything a reader of the table must know that the cells cannot say. */
  note?: string;
}

/**
 * A fragment of window code, written with `#{x}` where the code has `${x}`, so this table holds no
 * string that looks like an unfilled template.
 */
const js = (fragment: string): string => fragment.replaceAll("#{", "${");
const ui = (file: string, has: string): WindowAt => ({ file: `src/ui/${file}`, has: js(has) });
const app = (has: string): WindowAt => ui("app.ts", has);
const rpc = (method: string): WindowAt => ({
  file: "src/ui/window.ts",
  has: `rpc.request.${method}(`,
});

const CLI_ONLY = "touches only akou's own folders or the terminal (docs/ux/CLI.md section 14)";

export const PARITY: readonly Row[] = [
  {
    action: "Start recording",
    cli: ["start"],
    api: ["POST /calls"],
    mcp: ["akou_start"],
    window: [app('"POST", "/calls", {')],
  },
  {
    action: "Stop",
    cli: ["stop"],
    api: ["POST /calls/:id/stop"],
    mcp: ["akou_stop"],
    window: [app('this.control("stop"')],
  },
  {
    action: "Pause and resume",
    cli: ["pause", "resume"],
    api: ["POST /calls/:id/pause", "POST /calls/:id/resume"],
    mcp: ["akou_pause", "akou_resume"],
    window: [app('v?.state === "paused" ? "resume" : "pause"')],
  },
  {
    action: "Mute and unmute",
    cli: ["mute", "unmute"],
    api: ["POST /calls/:id/mute", "POST /calls/:id/unmute"],
    mcp: ["akou_mute", "akou_unmute"],
    window: [app('v?.muted ? "unmute" : "mute"')],
  },
  {
    action: "Restart",
    cli: ["restart"],
    api: ["POST /calls/:id/restart"],
    mcp: ["akou_restart"],
    window: [app('this.control("restart"')],
  },
  {
    action: "Status",
    cli: ["status"],
    api: ["GET /status"],
    mcp: ["akou_status"],
    window: [rpc("status")],
  },
  {
    action: "Read and follow the transcript",
    cli: ["tail", "show"],
    api: ["GET /calls/:id/transcript", "GET /calls/:id/events", "GET /calls/:id/stream"],
    mcp: ["akou_read", "akou_get_call"],
    window: [rpc("follow"), app("/transcript?format=export")],
  },
  {
    action: "One call's record",
    cli: { none: "`show` prints the transcript; no command prints the record itself" },
    api: ["GET /calls/:id"],
    mcp: {
      none: "the tools read it internally (akou_vocab_propose, akou_enhanced_put); none returns it",
    },
    window: { none: "the window builds its view from the call list and the followed log" },
  },
  {
    action: "Context pack",
    cli: ["context"],
    api: ["POST /calls/:id/context"],
    mcp: ["akou_context"],
    window: [ui("ask.ts", '"Copy context for my agent"')],
  },
  {
    action: "Ask",
    cli: ["ask"],
    api: ["POST /calls/:id/ask"],
    mcp: ["akou_ask"],
    window: [rpc("ask")],
    note: "akou_ask is listed only when a provider can answer, and hidden from a harness client when that harness is the provider (src/main/mcp/server.ts askListed)",
  },
  {
    action: "Search one call",
    cli: ["search"],
    api: ["GET /calls/:id/search"],
    mcp: ["akou_search"],
    window: { none: "find in the call is designed in docs/ux/WINDOW.md and not built" },
  },
  {
    action: "Name, merge and unmerge speakers",
    cli: ["name"],
    api: [
      "POST /calls/:id/speakers",
      "POST /calls/:id/speakers/merge",
      "POST /calls/:id/speakers/unmerge",
    ],
    mcp: ["akou_name_speaker", "akou_merge_speakers", "akou_unmerge_speaker"],
    window: [
      app("`/calls/#{call}/speakers`"),
      app("`/calls/#{call}/speakers/merge`"),
      app("`/calls/#{call}/speakers/unmerge`"),
    ],
  },
  {
    action: "Add and read notes",
    cli: ["note"],
    api: ["POST /calls/:id/notes", "GET /calls/:id/notes"],
    mcp: ["akou_add_note", "akou_get_notes"],
    window: [ui("notepad.ts", '"POST", `/calls/#{call}/notes`')],
  },
  {
    action: "Edit and delete a note",
    cli: ["note"],
    api: ["PATCH /calls/:id/notes/:nid", "DELETE /calls/:id/notes/:nid"],
    mcp: { none: "missing: PG-M4 adds note edit and delete" },
    window: [
      ui("notepad.ts", '"PATCH", `/calls/#{call}/notes/'),
      ui("notepad.ts", '"DELETE", `/calls/#{call}/notes/#{id}`'),
    ],
  },
  {
    action: "Memory",
    cli: ["remember"],
    api: ["POST /calls/:id/remember", "DELETE /calls/:id/remember/:rid"],
    mcp: ["akou_remember", "akou_forget"],
    window: { none: "no row for it in docs/ux/WINDOW.md yet" },
  },
  {
    action: "Memo",
    cli: { none: "CLI-28 designs it" },
    api: ["GET /calls/:id/memo", "PUT /calls/:id/memo"],
    mcp: ["akou_memo_get", "akou_memo_put"],
    window: { none: "no memo pane is built" },
  },
  {
    action: "Vocabulary: add, propose, approve, reject, list",
    cli: ["vocab"],
    api: [
      "GET /vocab",
      "POST /vocab",
      "POST /vocab/approve",
      "POST /vocab/reject",
      "GET /calls/:id/vocab",
      "POST /calls/:id/vocab",
    ],
    mcp: [
      "akou_vocab_add",
      "akou_vocab_propose",
      "akou_vocab_approve",
      "akou_vocab_reject",
      "akou_vocab_list",
    ],
    window: [
      app("`/calls/#{call}/vocab`"),
      ui("review.ts", "`/vocab/#{action}`"),
      ui("settings.ts", '"GET", `/vocab'),
    ],
  },
  {
    action: "Vocabulary: remove a word",
    cli: ["vocab"],
    api: ["DELETE /vocab/:term", "DELETE /calls/:id/vocab/:vid"],
    mcp: { none: "no tool yet, and no design item names one" },
    window: { none: "W9.2 designs it (remove in the Words dialog)" },
  },
  {
    action: "Vocabulary: suggest and check",
    cli: ["vocab"],
    api: ["POST /vocab/suggest", "POST /vocab/check"],
    mcp: ["akou_vocab_suggest", "akou_vocab_check"],
    window: {
      none: "the window reviews proposed words; suggestions come from an agent or the CLI",
    },
  },
  {
    action: "Vocabulary pass over a finished call",
    cli: ["vocab"],
    api: ["POST /calls/:id/vocab/pass"],
    mcp: { none: "no tool yet, and no design item names one" },
    window: [ui("review.ts", "`/calls/#{call}/vocab/pass`")],
  },
  {
    action: "Import a vocabulary file",
    cli: ["vocab"],
    api: ["POST /vocab/import"],
    mcp: { none: "no tool yet, and no design item names one" },
    window: { none: "no control yet, and no design item names one" },
  },
  {
    action: "Enhance",
    cli: ["enhance"],
    api: ["POST /calls/:id/enhance", "GET /calls/:id/enhanced"],
    mcp: ["akou_enhance"],
    window: [ui("enhanced.ts", "`/calls/#{call}/enhance`")],
  },
  {
    action: "Agent-written notes",
    cli: { none: "CLI-28 designs it" },
    api: ["GET /calls/:id/enhance/context", "PUT /calls/:id/enhanced"],
    mcp: ["akou_enhance_context", "akou_enhanced_put"],
    window: { none: "an agent writes them; the window shows them in the Enhanced tab" },
  },
  {
    action: "Final pass",
    cli: ["finalize"],
    api: ["POST /calls/:id/finalize"],
    mcp: { none: "missing: PG-M4 adds it" },
    window: { none: "no run-again control yet (docs/ux/WINDOW.md)" },
  },
  {
    action: "Export",
    cli: ["export"],
    api: ["POST /calls/:id/export"],
    mcp: ["akou_export"],
    window: {
      none: "the hand-off runs by itself after every call; the window has no export control",
    },
  },
  {
    action: "Run the hooks again",
    cli: ["hooks"],
    api: ["POST /calls/:id/hooks"],
    mcp: { none: "no tool yet, and no design item names one" },
    window: { none: "no control yet, and no design item names one" },
  },
  {
    action: "List calls",
    cli: ["calls"],
    api: ["GET /calls"],
    mcp: ["akou_list_calls"],
    window: [app('"/calls?limit=200"')],
  },
  {
    action: "Share a live link",
    cli: ["share"],
    api: ["GET /share", "POST /share", "DELETE /share"],
    mcp: { none: "missing: PG-M4 adds share on, off and status" },
    window: [app('"POST", "/share"'), app('"DELETE", "/share"')],
  },
  {
    action: "Templates",
    cli: { none: "missing: PG-F3" },
    api: ["GET /templates"],
    mcp: { none: "missing: PG-F3" },
    window: [ui("enhanced.ts", '"GET", "/templates"')],
  },
  {
    action: "Settings",
    cli: ["config"],
    api: ["GET /config", "PATCH /config"],
    mcp: {
      none: "writes stay off MCP on purpose, so an agent never switches the provider or the share bind; PG-M4 adds the read-only akou_config_get",
    },
    window: [ui("settings.ts", '"GET", "/config"'), ui("settings.ts", '"PATCH", "/config"')],
  },
  {
    action: "Speech models",
    cli: ["models"],
    api: ["GET /models", "POST /models/pull"],
    mcp: { none: "no tool yet; the models card and `akou models` own the download" },
    window: [ui("models-card.ts", '"POST", "/models/pull"')],
  },
  {
    action: "Open the window",
    cli: ["open"],
    api: ["POST /window"],
    mcp: { none: "missing: PG-M4 adds open window" },
    window: { none: "it is the window" },
  },
  {
    action: "Play the audio",
    cli: { none: "playback happens in the window" },
    api: ["GET /calls/:id/audio/:part"],
    mcp: { none: "playback happens in the window" },
    window: [rpc("audio")],
  },
  {
    action: "Quit",
    cli: ["quit"],
    api: ["POST /quit"],
    mcp: { none: "left out on purpose (PG-M4 exclusions)" },
    window: [{ file: "src/main/window/shell.ts", has: 'label: "Quit akou", action: "quit"' }],
  },
  {
    action: "Import from hark-viewer",
    cli: ["import"],
    api: ["POST /import/hark-viewer"],
    mcp: { none: "left out on purpose (PG-M4 exclusions)" },
    window: { none: "a one-time migration; the CLI is enough" },
  },
  {
    action: "Devices and apps",
    cli: ["devices", "apps"],
    api: {
      none: "missing: PG-A8 adds GET /devices and GET /apps; the commands exit 69 until then",
    },
    mcp: { none: "missing: PG-A8" },
    window: { none: "the source picker (W3.3) waits on PG-A8" },
  },
  {
    action: "Update the CLI",
    cli: ["self-update"],
    api: { none: "the CLI replaces its own binary; not built yet" },
    mcp: { none: CLI_ONLY },
    window: { none: "the app's update notice is DK-U1" },
  },
  {
    action: "Token, skill, doctor and the MCP server",
    cli: ["token", "skill", "doctor", "mcp"],
    api: { none: CLI_ONLY },
    mcp: { none: CLI_ONLY },
    window: { none: CLI_ONLY },
  },
];

/** What each door offers today, read from the code. */
export interface Doors {
  cli: ReadonlySet<string>;
  api: ReadonlySet<string>;
  mcp: ReadonlySet<string>;
  /** The source of a file under the repository, or null when it does not exist. */
  source(file: string): string | null;
}

const isNone = (c: unknown): c is None =>
  typeof c === "object" && c !== null && !Array.isArray(c) && "none" in c;

/** Every way the table and the doors disagree; empty when they match. */
export function parityProblems(table: readonly Row[], doors: Doors): string[] {
  const out: string[] = [];
  const mapped = { cli: new Set<string>(), api: new Set<string>(), mcp: new Set<string>() };
  for (const row of table) {
    for (const door of ["cli", "api", "mcp"] as const) {
      const cell = row[door];
      if (isNone(cell)) {
        if (cell.none.trim().length < 10)
          out.push(`${row.action}: the ${door} door lacks it and gives no reason`);
        continue;
      }
      if (cell.length === 0)
        out.push(`${row.action}: the ${door} cell is empty; name it or give a reason`);
      for (const name of cell) {
        mapped[door].add(name);
        if (!doors[door].has(name)) out.push(`${row.action}: the ${door} door has no ${name}`);
      }
    }
    const w = row.window;
    if (isNone(w)) {
      if (w.none.trim().length < 10)
        out.push(`${row.action}: the window lacks it and gives no reason`);
    } else {
      if (w.length === 0)
        out.push(`${row.action}: the window cell is empty; name it or give a reason`);
      for (const at of w) {
        const src = doors.source(at.file);
        if (src === null) out.push(`${row.action}: the window's ${at.file} does not exist`);
        else if (!src.includes(at.has))
          out.push(`${row.action}: the window no longer does it (${at.file} lacks ${at.has})`);
      }
    }
  }
  for (const door of ["cli", "api", "mcp"] as const)
    for (const name of doors[door])
      if (!mapped[door].has(name)) out.push(`the ${door} door has ${name}, which no row maps`);
  return out;
}
