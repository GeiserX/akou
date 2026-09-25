# Command line

The `akou` command is how a person in a terminal, a shell script and an agent without MCP drive akou. This file says how it should behave as a whole: the command tree, how a call is named, what goes to stdout and stderr, the exit codes, the error text, colour, help and completions, the config file, a live view of a call in the terminal, and how the CLI lines up with the API and MCP.

The contracts already built are in [DESIGN.md](../DESIGN.md) section 6.1 (commands) and 6.3 (the local API's security). The rules every door follows are in [PRINCIPLES.md](PRINCIPLES.md). The live event stream, `akou events`, `akou wait`, MCP and the skills are designed in [PROGRAMMABILITY.md](PROGRAMMABILITY.md); this file refers to those lines by id and does not repeat them. The window is [WINDOW.md](WINDOW.md). This file owns the `CLI-` ids and their priorities; the CLI section of [COMPETITOR-MATRIX.md](COMPETITOR-MATRIX.md) lists the same ids and points here. How the tests run is in [TESTING.md](../TESTING.md) and [CI-CD.md](../CI-CD.md).

## 0. The simple version

- **One client.** Every command is a thin client of `http://127.0.0.1:<port>/v1`, the same API the MCP server uses. The CLI never reads a call folder. If the app is not running, a command that needs it launches it headless and waits up to 3 s.
- **One way to name a call.** `-c ID|live|last` works on every command that touches a call. With no `-c`, controls act on the live call only; everything else uses the live call, or the last one when nothing is live, and says so on stderr.
- **Three output modes.** Human text by default. `--json` prints the API's answer as one JSON value, errors included. `tail -f --json` prints one JSON object per line. `events` is the one command with no human form: it always prints one JSON object per line (PG-S3), and the human view of a live call is `tail -f` or `watch`.
- **Exit codes mean one thing each.** 3 is always "there is no call to act on", in every command.
- **Errors say what to do.** One line for what happened, then at most one `try:` line naming a command that exists.
- **`akou watch` is the live call in a terminal.** The transcript scrolls, the in-progress line redraws in place, and what you type is a question for the call. Lines that start with `/` are the same CLI commands, bound to that call. It keeps scrollback and needs no full-screen library.
- **Generated, not hand-written.** Help, completions and the reference page come from the command registry. The settings part comes from the settings registry, and CI fails when either drifts.

## 1. What we do not build

Each of these ships in some CLI we looked at. Each is refused here with the reason, so a later request starts from the decision.

| Not built | Why | What covers the need |
|---|---|---|
| An environment variable for every setting | Two sources for one value is how `config show` came to mislabel `AKOU_HEADLESS` as a default. The config file is the one place | `akou config set`; the three existing variables (section 10) stay because they must work before the file is read |
| Abbreviated commands (`akou st` for `start`) | An abbreviation that works today breaks when a command is added. clig.dev says the same | "Did you mean" (CLI-09) and completions (CLI-08) |
| External subcommands (`akou-foo` on `PATH` run as `akou foo`) | A plugin system with no timeout and no version contract | Hooks and the API |
| A full-screen TUI on the alternate screen | It hides scrollback, breaks copy and paste in some terminals, and needs a layout library. `akou watch` appends to the terminal like `tail -f` and redraws one line | `akou watch` (CLI-24) |
| A built-in pager for `show` | Terminals already have one | `akou show last \| less` |
| Prompts when stdin is not a terminal | A script or agent hangs on a question it cannot see | Every prompt has a flag that answers it (`--yes`, `--force`); with no terminal the command refuses and names the flag |
| An update check in the CLI, or usage telemetry of any kind | The CLI makes no network call the user did not ask for. The one update check is the app's, off until the user switches it on (DK-U1 in [DESKTOP.md](DESKTOP.md)) | `akou status` shows a newer version once the check is on; `akou self-update` for the Linux tarball (DESIGN 6.1) |
| Renaming commands to match MCP tool names | `akou name` reads better than `akou name-speaker` in a terminal, and renaming breaks every script | The generated CLI-to-MCP map (section 14) records each pair |

## 2. Priorities and the shape of a line

Each line below has an id, a priority, where it comes from, a check that can fail, and what akou has today. A line becomes one bead. One item has one id and one priority, held in the doc that owns it:

- The `CLI-` ids are owned here. The matrix mirrors them; where it shows another priority, this file's wins.
- A command whose design lives in a sibling (`events` is PG-S3, `wait` is PG-S5, the capture test is DK-O1) appears here only as a pointer to that id. It has no `CLI-` row and no second bead. The old matrix ids CLI-01 and CLI-02 are those two PROGRAMMABILITY lines.
- A CLI row that needs an API route names the route's owner (PG-A4 for rename and delete). The route and the command are two pieces of work in two doors, so each keeps its bead.

Priorities:

- **P0**: broken today, or it breaks the core loop, privacy or the agent path. Before the next release.
- **P1**: part of the UX milestone.
- **P2**: after the P1 it builds on.
- **P3**: not a bead. Such items sit in the parking list at the end with one line each, so we can show we saw them.

"Today" is **has**, **partial**, **missing** or **bug**, read from `origin/main` and from running the CLI against a scratch app.

## 3. Rules every command follows

These are the contract. Each has a check that runs over the whole command registry, so a new command cannot break them.

1. **Thin client.** A command talks to the API and nothing else, except `token`, `models`, `skill` and `doctor`, which touch only akou's own folders (DESIGN 6.1). *Check:* the CLI e2e suite runs with the recordings root unreadable and every call command still works.
2. **stdout is the result, stderr is everything else.** Progress, notes about which call was used, warnings and error text go to stderr. With `--json`, stdout holds the JSON, errors included, so an agent reads one shape plus the exit code. *Check:* for every command, `--json` stdout parses as exactly one JSON value, or as one JSON value per line for a stream.
3. **Human output is text.** Without `--json` no command prints a raw JSON object. *Check:* CLI-04.
4. **Probes never launch the app, and no hint starts a recording.** `status`, `help`, `--version`, `completion`, `config path` and `token path` run with the app down and leave it down. A message never suggests `akou start` as a way to launch the app, because `start` records the whole computer. *Check:* CLI-17 and CLI-23.
5. **Ctrl-C never stops a recording.** It ends the command you ran. Only `stop`, `quit` and `restart` touch the recording. *Check:* CLI-21.
6. **Times are wall-clock.** Every time printed is a local time of day (`14:32`), never an offset into the call (PRINCIPLES rule 9). Dates in lists are `YYYY-MM-DD`. The CLI keeps that ISO form in every locale on purpose, because its output gets sorted and grepped; the window follows the locale ([WINDOW.md](WINDOW.md)).
7. **Every name in a message exists.** A command, flag or setting named in help, an error or a setting's description resolves in the registries (PRINCIPLES rule 13). *Check:* CLI-17.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-23 | Probes never launch the app: `status`, `help`, `--version`, `completion`, `config path`, `token path` | P1 | clig.dev; rule 4; a probe that starts the app hides whether it was running | With the app down and a fresh `AKOU_HOME`, each probe exits and afterwards no akou app process exists and `runtime.json` is absent. Positive control: `akou tail` in the same setup does launch it | partial: `status` probes; the rest are not checked |

## 4. The command tree

The tree stays flat: one verb per action, with subcommands only where a noun has several actions (`vocab`, `models`, `config`, `share`, `calls`). "Today" says what exists; **new** marks a command this file or a sibling adds.

| Group | Commands | Today |
|---|---|---|
| Record | `start [-w WS] [-t TITLE] [--template T] [--call system\|app:ID\|none] [--mic ID\|none] [--vocab A,B] [--without-models]` · `stop [--discard]` · `pause` · `resume` · `mute` · `unmute` · `restart [--force]` · `extend [MIN]` **new** (REC-03) | has, except `--discard` (CLI-26) and `extend` |
| See | `status` · `watch` **new** (CLI-24) · `open [CALL] [-w WS]` | has, except `watch` and `-w` (CLI-30) |
| Follow and ask | `tail [-f] [--since SEQ] [--last 5m] [--format txt\|md\|json]` · `context "Q" [--budget N]` · `ask "Q"` · `search "Q" [-k N]` · `events [-f] [--type T,…]` **new** (PG-S3) · `wait --for STAGE [--timeout 30m]` **new** (PG-S5) | has, except `events`, `wait` |
| During the call | `name SPK NAME` · `name --merge A B` · `name --unmerge SPK` · `note "TEXT"` · `note --edit ID "TEXT"` · `note --del ID` · `remember "TEXT"` · `remember --del ID` · `mark [LABEL]` **new** (CLI-34) | has, except `mark` |
| Vocabulary | `vocab list\|add\|remove\|approve\|reject\|suggest\|check\|import\|pass` | has |
| After the call | `enhance [--template T]` · `finalize [CALL] [--force] [--engine E]` · `export [CALL] [--to DIR]` · `hooks run CALL [--stage S]` · `hooks test` **new** (PG-H2) · `show CALL [--layer best\|live\|final] [--format md\|json\|txt]` | has, except `--engine` (TRN-16) and `hooks test` |
| Calls | `calls [-w WS] [--limit N] [--failed]` · `calls rename\|move\|delete\|restore CALL …` **new** (CLI-26) · `import hark-viewer DIR… [-w WS]` | has, except the subcommands |
| Share | `share on\|off\|status [--bind tailnet\|lan\|IP] [--notes] [--expires 3h]` | has |
| Setup | `config show\|get\|set\|unset\|path` · `models list\|pull\|import\|select` · `devices` · `apps` · `templates list\|show` **new** (PG-F3) · `token path\|rotate` · `doctor [--grant] [--capture-test]` · `demo [--clean]` **new** (SET-10) · `completion SHELL` **new** (CLI-08) | partial: `devices`, `apps`, `doctor --grant` exit 69 "not built"; no `get`, `path`, `models select` (SET-06), `doctor --capture-test` (DK-O1), `templates`, `demo`, `completion` |
| Agents | `skill install [--harness claude\|codex] [--dir DIR]` · `mcp` · `webhook test` **new** (PG-W2) · `api METHOD PATH` **new** (CLI-11) | has, except `webhook test`, `api` |
| App | `quit` · `self-update` (Linux tarball, M4) · `version` · `help [CMD]` | partial: `help CMD` ignores the command |

### Naming a call

Today the call is named four ways: `show` needs it as a word, `finalize`, `export` and `open` take an optional word that defaults to the last call, and the rest take `--call` and default to the live one. The rule we want has two parts.

**How you name it.** `-c ID|live|last` (long form `--call`) works on every command that touches a call. A command whose object is a call (`show`, `open`, `finalize`, `export`, `hooks run`, `calls rename|move|delete|restore`) also takes it as its first word, so `akou show last` keeps working. Help shows `-c` first.

**What happens when you do not name it.**
- `stop`, `pause`, `resume`, `mute`, `unmute` act on the live call only. With nothing live they exit 3. This matches the API, which refuses `last` on controls so a control can never land on a finished call (DESIGN 6.2).
- Every other call command uses the live call, or the last call when nothing is live. When it falls back it writes one line to stderr: `akou: nothing is live; using "Weekly sync", ended at 15:02`. The JSON body already carries the call id.
- `vocab` keeps its own scopes: no `-c` means the workspace list, `-c` means a call-scoped word.

This is resolved in the CLI from the API's `404 no_live_call {last}` answer, which already names the last call. No new route is needed.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-03 | One way to name a call: `-c/--call` on every call command, the call as first word where it is the object | P1 | Audit: four forms in use | A registry test fails for any command with a call-scoped route that does not declare `call` with short `c`. `akou show -c X` and `akou show X` print the same bytes. The exit-code half of the matrix row moves to CLI-16 | partial |
| CLI-18 | Default call: live, else last, for everything except controls, with the stderr note; `-q/--quiet` drops notes and progress, never errors | P1 | intent: questions after a call are as easy as during it; audit asked for `--quiet` | With one ended call and nothing live, `akou ask "q"` answers from that call and stderr has one line naming its title and end time; with `-q` stderr is empty; `akou mute` exits 3 and prints nothing on stdout, and with `-q` still prints its error | missing: `ask` and `tail` exit 3, `enhance` exits 64 |

## 5. Output

### Human

Short, aligned, readable at a glance, and never JSON. A sample of what `status` should print (CLI-22 adds the provider name):

```
Live: "Weekly sync" in work, recording since 14:31, 1 part, recognizer lag 0.9 s
  mic: ok
  call: ok
Speech: ready
Provider: harness, claude, ready
Share: off
```

`tail` prints one committed line per row as `14:32 Speaker: text`, the same form the window and the export use. `--format md` bolds the time and speaker.

### `--json`

One JSON value on stdout. A success is the API's body, unchanged. An error is the API's error body, `{"error": "<code>", "message": "…"}`, plus one field the CLI adds, `hint` (CLI-19); nothing else changes. Clients ignore fields they do not know; the API's versioning rule covers the CLI's JSON (PROGRAMMABILITY section 3). We do not add a second envelope on top: the API body is the contract, so the CLI, MCP and a `curl` user read the same thing.

### Streams

A command that prints over time prints one JSON object per line: `tail -f` with `--json` (has), and `events` always, with or without `--json` (PG-S3, which has every event type and a server-side filter). An event has no human form, so `events` has no text mode. Each line is flushed as it is written, so `| head -3` exits after three lines. `ask` streams tokens on a terminal; with `--json` it prints the final answer object once.

### Progress

Progress goes to stderr, and only when stderr is a terminal: one line redrawn in place, with bytes, speed and time left for a model pull. When stderr is not a terminal the command prints one line when it starts and one when it ends, never a stream of percentages into a log file.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-04 | Human output is text: `share on\|status`, `vocab suggest`, `vocab check` get human renderings | P1 | Audit | For every command in the registry, run against the fake app without `--json`, stdout does not parse as a JSON object. Snapshot of each human output committed | partial |
| CLI-15 | `tail -f`, `--json` everywhere, typed exit codes, streamed ask | n/a | Minutes, MacWhisper | Already built; the registry-wide `--json` check in rule 2 runs in CI | has |
| CLI-13 | Progress on stderr, only on a terminal, for `models pull` and `finalize` (through `wait`) | P2 | MacWhisper | With stderr piped to a file, `models pull` writes exactly two lines to it; on a pty it redraws one line that shows bytes and time left | partial: pull prints progress, not TTY-aware |
| CLI-22 | `status` names the provider and harness it would use; `doctor` groups what it found and names the fix ("4 models missing, 2.6 GB: run `akou models pull`") | P1 | Audit: "Provider: available" names nothing; doctor prints nine file names on one line | With the harness provider and a fake `claude` on `PATH`, `status` prints `Provider: harness, claude, ready`. With four model files missing, `doctor` prints one models line with the count, the size and the command | partial |

## 6. Exit codes

One meaning per code, the same in every command. The codes are sysexits, which hark used (REQUIREMENTS I1.16), plus three of our own.

| Code | Means | Examples |
|---|---|---|
| 0 | Done | A command succeeded; `tail -f` or `watch` ended by Ctrl-C |
| 3 | There is no call to act on | `akou mute` with nothing live; any call command when there are no calls at all; `-c` names a call that does not exist |
| 64 | The command line is wrong | Unknown command, flag or value; a missing question |
| 65 | A vocabulary term fails validation | `akou vocab add` with a term that fails the checks |
| 69 | Something needed is unavailable | The app cannot be reached or launched; speech models missing; no provider answered (`ask` still prints the excerpts); a command not built yet |
| 70 | akou failed | A bug; a stage that failed, reported by `akou wait` |
| 75 | Already recording | `akou start` while a call is live |
| 77 | Permission | The token is refused; an OS grant is missing |
| 124 | Timed out | `akou wait --timeout` ran out (the GNU `timeout` convention, PG-S5) |
| 130 | Interrupted | Ctrl-C during a one-shot command (`ask`, `wait`, `models pull`) |

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-16 | Exit 3 for "no call to act on" in every command | P0 | split from CLI-03; DESIGN 6.1 promises 3; the audit saw `enhance`, `show`, `finalize` and `export` exit 64 with no calls while `ask`, `tail`, `search` and `note` exit 3 | With a fresh `AKOU_HOME` and no calls, every call command in the registry exits 3; with one ended call and nothing live, every control exits 3. A table in the test lists the commands, and a new command missing from it fails the test | bug |
| CLI-21 | Ctrl-C ends the command, never the recording: follow commands exit 0, one-shot commands exit 130 and cancel their work | P1 | clig.dev; rule 5 | On a pty with a live fake call, Ctrl-C in `tail -f` exits 0 and `akou status --json` still shows the call recording. Ctrl-C during `ask` exits 130 and no provider process is left running | partial: `tail -f` stops on the first Ctrl-C and exits 130 on the second |

## 7. Errors that say what to do

Every error is two lines at most:

```
akou: nothing is live; the last call, "Weekly sync", ended at 15:02 (01JB7…)
  try: akou start -w work -t "Title"   or   akou show last
```

The first line says what happened in plain words, with the call's title and wall time when a call is involved. The second, when there is one, starts with `try:` and names a command that exists and would help. With `--json` the same text goes in `message` and `hint`.

The hints live in one table in the CLI, keyed by the API's error code, so the API stays unchanged and every code has a hint or an explicit "none". The window and MCP draw their own text for their own door (PRINCIPLES rule 13); they share the error codes, not the sentences.

A few of the texts, as they should read:

| Situation | Message | try |
|---|---|---|
| App not running (`status`) | `akou is not running` | `akou open` (starts the app and shows the window; never `akou start`) |
| Speech models missing (`start`) | `the speech models are not downloaded yet (2.6 GB)` | `akou models pull`, or `akou start --without-models` to record audio now and transcribe later |
| Already recording | `already recording "Weekly sync" since 14:31` | `akou stop`, or `akou restart` for a new part |
| No provider answered (`ask`) | `no model answered (usage limit reached); the excerpts above are what matched` | `akou context "Q"` prints what an agent answers from |
| Unknown setting | `unknown setting "asr.segmentPuase"` | `akou config set asr.segmentPause …` (CLI-09) |
| Token refused | `the API refused the token` | `akou token rotate` |

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-17 | Honest text: every `akou …` command, flag or setting named in help, errors, `config show` and setting descriptions exists. No message suggests `akou start` to launch the app. Covers the text half of SET-02; CLI-35 covers the source label | P0 | Audit: `status` says "`akou start` launches it", which starts a recording; a setting error names `akou vocab check --boost`, which does not exist; `capture.mic` points at `akou devices`, which exits 69. PRINCIPLES rule 13 | A test collects every backticked `akou …` string from the CLI sources, the settings schema and the error hint table, parses each against the command registry, and fails on any that does not parse. Positive control: adding `akou vocab check --boost` to a fixture string fails it. A second assertion: no string outside `start`'s own help contains `akou start` as a way to launch | bug |
| CLI-19 | Two-line errors with a `try:` hint from one table keyed by error code; `hint` in the JSON error | P1 | clig.dev "suggest the next step" | Every error code in the API's list (PG-A7) has a row in the hint table, with a hint or an explicit none; a test fails on a code with no row. Each hint parses per CLI-17 | partial: messages are good, no hints |

## 8. Colour, terminals and width

- **Colour only on a terminal.** Colour is on when stdout is a terminal, `NO_COLOR` is unset or empty, and `TERM` is not `dumb`. Nothing else: no `--color` flag and no `FORCE_COLOR` until someone needs colour in a pipe.
- **What gets colour.** Speaker names, in the same hue order the window uses (first speaker first; "you" on the mic keeps its own hue, DESIGN 7). Dim for the in-progress line, ids and "(default)". Health states in `status` and `watch`: red for dead, yellow for quiet or degraded. The text label is always there as well, because state is never shown by colour alone (PRINCIPLES rule 12).
- **Width.** Transcript lines are never wrapped or cut by akou; the terminal wraps them, so a copied line is whole. List output (`calls`) cuts long titles to the terminal width, on a terminal only; piped, every field is whole.
- **Redraws.** Only `watch` and progress redraw a line, and only on a terminal. Piped output is append-only.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-20 | Colour and terminal rules as above | P1 | clig.dev, no-color.org; the window's speaker hues | On a pty, `tail` output contains ANSI colour codes and each speaker keeps one colour across lines; with `NO_COLOR=1`, or piped, the output has no escape byte. A `status` snapshot on a pty with a dead channel shows both the colour and the word `dead` | missing: no colour at all |

## 9. Help, completions and "did you mean"

Help comes from the command registry: each command declares its flags with a one-line description and one example, and the help page is built from that. A flag cannot be parsed without appearing in help. `akou help CMD` and `akou CMD --help` print the same page.

```
akou tail: committed lines with wall times

usage: akou tail [-c CALL] [-f] [--since SEQ] [--last 5m] [--format txt|md|json] [--json]

  -c, --call CALL    live, last or a call id (default: live, else last)
  -f, --follow       keep printing until the call ends
      --since SEQ    lines after this cursor
      --last 5m      lines from the last 90s, 5m or 1h
      --format F     txt (default), md or json (one row per line)
      --json         same as --format json

example: akou tail -f --last 2m
```

`akou` with no arguments prints a short overview: what is live (read with a probe that never launches the app), the five most used commands and `akou help`. It exits 0.

Completions are generated from the same registry for bash, zsh, fish and PowerShell (`akou completion zsh > …`). Values come from a hidden `akou __complete` command that asks the API for call ids (`live`, `last`, then the 20 most recent with their titles), workspaces, templates, the live call's speakers and setting keys. It completes nothing when the app is down, and it never launches it.

On an unknown command, subcommand, flag or setting key, akou suggests the closest name within two edits and runs nothing.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-05 | Help generated from the registry: every flag, a description, an example; `help CMD` works; `-v` prints the version | P1 | Audit: `vocab --help` hides `--heard`, `--no-decode`, `--note`, `--text`, `-k` and `--unconfirmed`; `show --help` omits `--json`; `akou help start` ignores the command | A test over the registry fails for any flag the parser accepts that the command's help does not list, and for any command without an example. `akou help tail` and `akou tail --help` print identical bytes | partial |
| CLI-08 | Completions for four shells, with call ids, workspaces, templates, speakers and setting keys | P2 | gh, Superwhisper | The zsh script, loaded in a pty test, completes `akou show <TAB>` with `live`, `last` and the fake app's call ids. With the app down, completion returns nothing within 300 ms and no app process starts | missing |
| CLI-09 | "Did you mean" on commands, subcommands, flags and setting keys; never runs the guess | P2 | clig.dev | `akou strat` prints `did you mean "start"?` and exits 64; `akou config set asr.segmentPuase 1` names `asr.segmentPause` and changes nothing | missing |
| CLI-32 | `akou` alone prints a probe-based overview and exits 0 | P2 | MacWhisper `mw`, clig.dev | With a live fake call it names the call; with the app down it says so and no app process starts; the exit code is 0 in both cases | partial: prints the full help, exits 64 |

## 10. Config file and environment

Settings live in one JSON file, `config.json` in the config folder, validated by the settings registry (DESIGN 6.1; the registry is the single source, TRAPS T1.39). The CLI is one of three editors of that file, with the window and `PATCH /config`.

| Command | Does |
|---|---|
| `akou config show [KEY…]` | Every setting, or the ones named: the value, where it comes from (`file`, `env AKOU_HEADLESS`, `default`), the default, the allowed values, and when a change applies: the registry's `applies` value (`now`, `next-call`, `next-final` or `restart`, DK-S1) |
| `akou config get KEY` | Only the value, bare, for scripts: `name=$(akou config get user.name)` |
| `akou config set KEY VALUE` | Validates, writes, and prints when this key's change applies, not a generic note |
| `akou config set KEY -` | Reads the value from stdin. Required for the secret keys (`provider.apiKey`, `webhook.secret`), so a key never lands in shell history or `ps` |
| `akou config unset KEY` | Back to the default |
| `akou config path` | The file's path. File-only keys (`hooks`, `webhook.url`, `provider.baseUrl`, `provider.harnessPath`, `capture.helper`) are edited there, and `config show` marks them so |

The environment has three akou variables and no more (section 1): `AKOU_HOME` moves every akou folder (for tests), `AKOU_HEADLESS=1` starts the app with no window, `AKOU_MODELS_DIR` overrides where the models are. The CLI also reads `NO_COLOR` and `TERM`, and it adds the loopback names to `NO_PROXY` for itself and the app it launches, because a proxy on loopback broke both predecessors (DESIGN 6.3 rule 6).

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-10 | `config get KEY` prints the effective value alone | P2 | Audit | `akou config get api.port` prints `8476` and nothing else; an unknown key exits 64 with a CLI-09 suggestion | missing |
| CLI-06 | `config set KEY -` reads stdin; a secret key given on the command line is refused. Owned here; PG-Z2 and DK-S5 describe the same item | P1 | clig.dev "never accept secrets via flags" | `printf 'sk-test' \| akou config set provider.apiKey -` stores the value and `config show` prints `(set)`. `akou config set provider.apiKey sk-test` exits 64, stores nothing, and its `try:` line shows the stdin form | partial: secrets are write-only, but only from argv |
| CLI-35 | `config show` gives source, default, allowed values and when a change applies; `config set` says when this key applies | P1 | Audit: `app.headless` from `AKOU_HEADLESS` shows as "(default)"; every `set` says "takes effect at the next start", which is false for the hotkey and the login item once SET-03 lands. Needs DK-S1 (the registry fields) and PG-A3 (the route) | With `AKOU_HEADLESS=1`, `config show app.headless` names the variable as the source. For every key with a fixed set of values the output lists them. `config set app.hotkey …` prints `applies now`; `config set asr.threads …` prints `applies at restart`, both read from the registry's `applies`. Covers the CLI half of SET-02 and SET-03 | bug |
| CLI-36 | `config path` | P2 | clig.dev | Prints the same path `doctor` reports, with the app down and no app process started | missing |

## 11. `akou watch`: the live call in a terminal

hark had an interactive mode: the transcript in the terminal and a key to copy it. akou moved that to the window (REQUIREMENTS F1.42). For someone who lives in a terminal, or works over SSH on a box where the app runs headless, the window is the wrong door. `akou watch` brings the interactive mode back, built only from commands that already exist.

```
$ akou watch
● Recording "Weekly sync" in work since 14:31 · mic ok · call ok · lag 0.9 s
14:32 you: Can we move the release to Thursday?
14:32 c2: Thursday works if the migration lands tomorrow.
14:33 c3: I can take the migration.
14:33 c2  so the plan is                       ← in progress, dim, redrawn in place
ask> what did we decide about the release?
  The release moves to Thursday, if the migration lands tomorrow (14:32).
  One speaker took the migration (14:33).
ask> /name c3 Platform lead
  c3 is now Platform lead
ask> _
```

How it behaves:

- **Output is append-only.** Committed lines, answers and health changes print above the prompt and stay in scrollback. The only line redrawn is the in-progress line just above the prompt. It works in any terminal, in tmux and over SSH.
- **Typing a question asks the call.** Plain text goes to `ask` for the watched call and the answer streams in, with wall-time citations. With no provider it prints the excerpts and the `akou context` hint, as `ask` does.
- **`/` runs a CLI command bound to this call.** `/note TEXT`, `/mark`, `/remember TEXT`, `/name c2 NAME`, `/mute`, `/unmute`, `/pause`, `/resume`, `/search Q`, `/help`. Each is exactly the CLI command with `-c` set to the watched call, run in the same process, so there is no second command set to keep in step. `/help` lists them from the registry. `/stop` asks "Stop recording "Weekly sync"? [y/N]" first, because one stray Enter must not end a call.
- **Live labels look live.** An unnamed live cluster prints as `c2`; a named one prints the name. When the final pass lands, `watch` prints one line: `15:04 final transcript ready: akou show 01JB7…`.
- **Health is loud.** A health change prints as its own line in its colour and with its word: `14:40 ! call side: no audio for 12 s`.
- **It never stops the recording on exit.** Ctrl-C clears the input line; Ctrl-C on an empty line, Ctrl-D or `/quit` exits 0. The header says how.
- **On a finished call** it prints the header with the end time and the last 20 lines, then the prompt: questions work the same.
- **Only on a terminal.** With stdin or stdout not a terminal it exits 64: `akou watch needs a terminal; akou tail -f prints the same lines to a pipe`.

The window's copy button already has a terminal form that needs nothing new: `akou show last --format md | pbcopy` (or `clip`, `wl-copy`). `/copy` inside `watch` is in the parking list.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-24 | `akou watch` as above | P1 | hark interactive mode (F1.42, F4.14); intent: CLI as good as the window; Buzz presentation window | A pty test against the fake app with a scripted call: committed lines appear in order with wall times; between two renders of the same in-progress segment the raw byte stream holds a carriage return and an erase-line sequence and no newline, and the segment gets its newline only when it commits; typing a question streams an answer from a fake provider; `/note hello` writes a `note` event with `by: user` on the watched call; `/stop` then Enter leaves the call recording; Ctrl-D exits 0 and `status` shows the call still recording. Piped, it exits 64 with the `tail -f` hint | missing |

## 12. Commands to add

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-07 | `akou devices` and `akou apps`, over a devices and apps route on the API (owned by [PROGRAMMABILITY.md](PROGRAMMABILITY.md)), so the window and MCP read the same list | P1 | Audit; `--mic ID` and `--call app:ID` need a way to find the id | Both list the fake helper's devices and apps, one per line with the id first; `--json` gives the route's body; the ids they print are accepted by `akou start --mic` and `--call app:`. The CLI e2e run with the recordings root unreadable (rule 1) still passes | missing: exit 69 |
| CLI-26 | `akou calls rename CALL TITLE`, `calls move CALL -w WS`, `calls delete CALL`, `calls restore CALL` over PG-A4; `akou stop --discard` stops the live call and moves it to the trash before any hand-off runs (the CLI door of REC-05) | P1 | Granola trash, Minutes delete, Superwhisper discard; the way out of every state, including a recording started by mistake | `rename` changes the title in `akou calls` and the export file name; `delete` on a live call exits 75 with a `try: akou stop --discard` hint; `delete` then `restore` gives back an identical `akou show` output. `stop --discard` on a fake call leaves no export and runs no hook, and `calls restore` brings the call back. `delete` and `--discard` ask on a terminal and need `--yes` otherwise | missing |
| CLI-38 | `akou doctor --grant`: checks the microphone and system-audio grants and, on a terminal, asks the OS for each missing one or opens its settings pane; plain `doctor` reports the grants (and the Accessibility grant from DK-K1) without asking | P1 | REQUIREMENTS F0.26 promises it; today it exits 69 "not built" | With a fake grant checker reporting the microphone missing, `doctor --grant` requests it once (the fake records the request) and reports `mic: requested`; with both granted it requests nothing and exits 0; `--json` lists each grant and its state. On macOS, a hardware check with the grant removed is recorded | bug: exits 69 |
| CLI-27 | `akou show --from 14:30 --to 14:45 --speaker NAME` | P2 | the API already filters by time and speaker | On a fixture call, the output holds only lines inside the window and from that speaker; times are wall times in and out | missing |
| CLI-28 | The agent's write path without MCP: `akou memo [show\|put FILE]`, `akou enhance --context [--template T]`, `akou enhanced put FILE` | P2 | a harness without the MCP server registered can still do what `akou_memo_put`, `akou_enhance_context` and `akou_enhanced_put` do | Each command round-trips through the same route as its MCP tool; a test runs the pair and compares the log events they write | missing |
| CLI-29 | `akou edit SEG "TEXT"` and `akou edit SEG --speaker SPK`, over PG-A5 | P2 | DESIGN 7 inline edit | The fold shows the edit, `akou show --format json` keeps `heard` with the raw text, and the log holds both revisions | missing |
| CLI-34 | `akou mark [LABEL]`: mark this moment in the notepad, with the wall time | P2 | Otter, tl;dv, Fathom; PRINCIPLES rule 11 | Writes the same mark event the window's mark key writes ([WINDOW.md](WINDOW.md)), at the current wall time, on the live call; with nothing live it exits 3 | missing |
| CLI-11 | `akou api METHOD PATH [-f key=value] [--input FILE]`: any route with the token added and the proxy bypassed | P2 | `gh api` | `akou api GET /status` answers with `HTTP_PROXY` set to a dead address; `-f` fields become the JSON body on POST; the exit code follows the status as in section 6 | missing |
| CLI-30 | `akou open [-w WS]`: with a headless app, opens the one-time address in the default browser; `-w` puts that workspace first in the call picker, as hark-viewer's `?workspace=` did. Needs `workspace` on `POST /window` | P2 | Audit; hark-viewer carry-over | With a fake `open`/`xdg-open`/`start` on `PATH`, the program receives the URL the API returned; `--print` prints it instead. `akou open -w work` sends `{"workspace": "work"}` to `POST /window` | partial: prints the URL only |
| CLI-33 | `akou skill uninstall [--harness …]` removes everything `skill install` wrote, including any harness registration PG-M1 adds | P2 | the reverse of every state | After install then uninstall on a scratch home, the skills folders and the harness's MCP config are byte-identical to before | missing |

Commands designed in a sibling, listed here so the tree is complete. Each has its bead there, not here:

| Command | Owner |
|---|---|
| `akou events [-f] [--type T,…] [--since SEQ]` (was CLI-01) | PG-S3 |
| `akou wait --for STAGE [--timeout 30m]` (was CLI-02) | PG-S5 |
| `akou doctor --capture-test`, the 3 s test per channel | DK-O1 in [DESKTOP.md](DESKTOP.md) |
| `akou models select`, `akou finalize --engine` | SET-06 and TRN-16; both follow the engine registry, which is not designed yet |
| `akou extend [MIN]` | REC-03 |
| `akou demo [--clean]` | SET-10 |
| `akou templates list\|show` | PG-F3 |
| `akou hooks test`, `akou webhook test` | PG-H2, PG-W2 |
| Registering `akou mcp` with the harness | PG-M1 (matrix AGT-01) |

## 13. Scripting

These run as written once the lines they depend on land; each says which.

Start a call and keep its id (today):

```sh
id=$(akou start -w work -t "Weekly sync" --vocab "Kubernetes,Terraform" --json | jq -r .call)
```

Stop after a fixed time, which replaces hark's `--duration` (REQUIREMENTS F0.12; today):

```sh
akou start -w work -t "Standup" && sleep 900 && akou stop
```

Ring the terminal bell when your name is said (today, with `grep`; PG-S4 adds `akou events --mention` for this):

```sh
me=$(akou config get user.name)                       # CLI-10
akou tail -f | grep --line-buffered -i "$me" | while read -r line; do printf '\a%s\n' "$line"; done
```

Ask from a script and fall back to the excerpts when no model answers (today):

```sh
if answer=$(akou ask "What did we decide about the release date?"); then
  echo "$answer"
else
  case $? in
    69) echo "no model answered; excerpts:"; echo "$answer" ;;
    3)  echo "no call to ask about" ;;
    *)  exit 1 ;;
  esac
fi
```

Save the best transcript once the final pass lands (PG-S5):

```sh
akou stop && akou wait --for final.done --timeout 30m && akou show last --format md > "sync-$(date +%F).md"
```

Re-run the final pass and the export on every call in a workspace, for example after adopting a better engine. This is the akou side of "update every past transcript when a model is definitely better"; updating the user's archive stays their pipeline (PG-S5):

```sh
akou calls -w work --limit 1000 --json | jq -r '.calls[].id' | while read -r id; do
  akou finalize "$id" --force && akou wait -c "$id" --for final.done && akou export "$id"
done
```

Start from PowerShell, where `jq` is usually absent (today):

```powershell
$call = (akou start -w work -t "Weekly sync" --json | ConvertFrom-Json).call
akou tail -f -c $call
```

## 14. Parity with the API, MCP and the window

Every action has the same name and the same effect through every door (PRINCIPLES rule 3). The CLI's part of that is: every API route that acts on a call or on akou has a CLI command, except the few a terminal does not need. There is one parity table, `tests/contracts/parity.ts` (TS-13 in [TESTING.md](../TESTING.md)). Its test fails when a door lacks an action and the table gives no reason. CLI-31 renders that table into `docs/cli.md` and does not keep a second one. The table below is the design-time view of it.

| Action | CLI | API | MCP | Window | Gap |
|---|---|---|---|---|---|
| Start | `start` | `POST /calls` | `akou_start` | Record | MCP lacks `mic`, `withoutModels` (PG-M4); window has no audio-only start (W2.5) |
| Stop, pause, resume, mute, unmute | `stop` … | `POST /calls/{id}/stop` … | `akou_stop` … | header buttons | none |
| Restart | `restart` | `POST …/restart` | `akou_restart` | Restart | none |
| Status | `status` | `GET /status` | `akou_status` | header, tray | none |
| Read the transcript | `tail`, `show` | `GET …/transcript` | `akou_read`, `akou_get_call` | transcript | `show` lacks time and speaker filters (CLI-27) |
| Event stream | `tail -f`, `events -f` | `GET …/stream`, `…/events` | (monitor, PG-K3) | pushed | `events` missing (PG-S3) |
| Wait for a stage | `wait` | long poll on `…/events` | none, by design: an agent is told by the monitor | status | `wait` missing (PG-S5) |
| Context pack | `context` | `POST …/context` | `akou_context` | "Copy context for my agent" | none |
| Ask | `ask` | `POST …/ask` | `akou_ask` (hidden when the client is the provider) | Ask pane | none |
| Search one call | `search` | `GET …/search` | `akou_search` | none | window find is in [WINDOW.md](WINDOW.md) |
| Speakers | `name` | `POST …/speakers…` | `akou_name_speaker`, `akou_merge_speakers`, `akou_unmerge_speaker` | speaker chip | none |
| Notes | `note` | `POST/PATCH/DELETE …/notes` | `akou_add_note`, `akou_get_notes` | notepad | MCP lacks edit and delete (PG-M4) |
| Mark a moment | `mark` | notes route | `akou_add_note` | mark key | `mark` missing (CLI-34) |
| Memory | `remember` | `…/remember` | `akou_remember`, `akou_forget` | none | window: no row yet in [WINDOW.md](WINDOW.md) |
| Memo | none | `GET/PUT …/memo` | `akou_memo_get`, `akou_memo_put` | memo pane | CLI-28 |
| Vocabulary | `vocab …` | `/vocab…`, `…/vocab…` | `akou_vocab_*` | Fix this word, review pill | none |
| Enhance | `enhance` | `POST …/enhance` | `akou_enhance` | Enhanced tab | none |
| Agent-written notes | none | `GET …/enhance/context`, `PUT …/enhanced` | `akou_enhance_context`, `akou_enhanced_put` | none | CLI-28 |
| Final pass | `finalize` | `POST …/finalize` | none | Retry on a failed pass only | MCP lacks it (PG-M4); window has no run-again row yet in [WINDOW.md](WINDOW.md) |
| Export, hooks | `export`, `hooks run` | `POST …/export`, `…/hooks` | `akou_export` | hand-off status | none for the CLI |
| List calls | `calls` | `GET /calls` | `akou_list_calls` | sidebar | none |
| Rename, move, delete, restore a call | `calls rename…` | PG-A4 | PG-M4 | WINDOW.md | all missing (CLI-26) |
| Edit a line | `edit` | PG-A5 | none yet | inline edit | all missing (CLI-29) |
| Share | `share` | `/share` | none | share pill | MCP (PG-M4) |
| Templates | `templates` | `GET /templates` | none | template picker | CLI and MCP (PG-F3) |
| Settings | `config` | `/config` | `akou_config_get`, read-only; writes are left out on purpose, so an agent never changes `provider.kind` or `share.bind` on its own (PG-M4 exclusion list) | Settings | MCP read (PG-M4) |
| Devices, apps | `devices`, `apps` | route to add (CLI-07) | none | device pickers | CLI and route missing (CLI-07) |
| Import | `import hark-viewer` | `POST /import/hark-viewer` | none, by design | none | none |
| Window | `open` | `POST /window` | none | n/a | PG-M4 adds open window |
| Quit | `quit` | `POST /quit` | none, by design | tray Quit | none |
| Token, skill, models, doctor, completion | CLI only | n/a | n/a | models card | these touch only akou's folders or the terminal |

Names differ where a terminal verb is shorter (`name` against `akou_name_speaker`, `tail` against `akou_read`); section 1 says why we keep them. The generated map is the reference for each pair.

| Id | Feature | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CLI-31 | The generated CLI reference (`docs/cli.md`: every command's help page, plus the parity table rendered from TS-13's table) with a drift check | P1 | Minutes "Generated file. Do not edit by hand"; TRAPS T1.39 | CI regenerates the file and fails on a diff. Positive control: adding a flag to a command without regenerating fails the job. Parity gaps are TS-13's test, not a second one here | missing: DESIGN 6.1 is hand-written and already differs from the registry |

## 15. Testing

The CLI already has a process-level e2e suite (`tests/cli.e2e.test.ts`) that runs the real CLI against the headless app with a fake helper. The lines above add four kinds of test, all described in [TESTING.md](../TESTING.md):

- **Registry sweeps.** One test walks every command in the registry and checks the rules in section 3: `--json` parses, human output is not JSON, every flag is in help, every call command takes `-c`, no-call exits 3. A new command is covered the day it is added, and a command missing from a sweep's table fails it.
- **Text honesty.** The scan in CLI-17, with its positive control.
- **Terminal tests.** `watch`, colour, redraws and completions run under a pseudo-terminal, on all three OSes.
- **Snapshots.** The generated reference (CLI-31) doubles as a snapshot of every help page; human output of each command against the fake app is snapshotted per CLI-04.

The jobs that run them and the minimum test counts are in [CI-CD.md](../CI-CD.md).

## P0 list

- **CLI-16** Exit 3 for "no call to act on" in every command; today four commands exit 64 for the same situation.
- **CLI-17** Every command, flag or setting named in a message exists, and nothing tells the user to run `akou start` (which records) just to launch the app.

Not a CLI P0, but the agent path depends on it: PG-M1 in [PROGRAMMABILITY.md](PROGRAMMABILITY.md). The skill tells the agent to use the MCP tools, and nothing registers them today.

## Parking list

These are the P3 items. We looked at each and chose not to build it yet, so none is a bead and none has an acceptance. One gets a row and a check only when someone asks for it.

- **CLI-12** `--jq` built in (gh). `jq` and PowerShell's `ConvertFrom-Json` already read the API body.
- **CLI-14** A capabilities document (Minutes, anarlog). `akou --version` and the API's versioning rule cover it.
- **CLI-25** `/copy` inside `watch` (hark `y`). `akou show last --format md | pbcopy` does the same today.

## Summary

- The CLI stays a thin client of the one local API. The design adds rules, each checked over the whole command registry: one way to name a call (`-c`, and live-else-last by default except for controls), stdout for results, one exit code per meaning, two-line errors with a `try:` hint, colour only on a terminal, and Ctrl-C that never stops a recording.
- New commands are only those an action needs: `watch` (the live call in a terminal, append-only, `/` lines are the existing commands), `devices`, `apps`, call rename, delete and `stop --discard`, `doctor --grant`, `mark`, `api`, `completion`, `open -w`, and the agent write path without MCP. `events`, `wait`, the capture test, engine choice, `extend`, `demo` and the hand-off tests are designed in sibling docs; this file only lists them.
- Refused, with reasons: an env var per setting, abbreviations, external subcommands, a full-screen TUI, a pager, prompts without a terminal, an update check or telemetry in the CLI (the app's check is opt-in), and renaming commands to match MCP.
- This file owns the `CLI-` ids and their priorities. The matrix mirrors them. A command owned by a sibling is a pointer here, with no second bead. P3 items are a parking list with no beads.
- Help and completions are generated from the command registry. The parity table is TS-13's one table, rendered into `docs/cli.md`. CI fails on drift.
- **Next:** the two P0s are small: one is a test table, the other a string scan. The rest become beads under the ids above.
