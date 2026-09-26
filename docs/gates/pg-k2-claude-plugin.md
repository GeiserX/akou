# PG-K2: one Claude Code plugin install gives the skills and the tools

The item from [PROGRAMMABILITY.md](../ux/PROGRAMMABILITY.md) PG-K2: the repository is a Claude Code plugin (`.claude-plugin/plugin.json`, the two skills in `skills/`, an MCP server that runs `akou mcp`) and its own marketplace (`.claude-plugin/marketplace.json`). On a clean config folder, adding the marketplace and installing `akou@akou` should give the `akou` skill and the `akou_*` tools with no other step.

Result: pass from a clone of the branch. The same two commands against `GeiserX/akou` can only run once the plugin is on `main`, so that run is still open.

## The check

- Date: 2026-09-25. Claude Code 2.1.282 on an Apple silicon Mac with macOS 27.0, a development machine.
- A throwaway `CLAUDE_CONFIG_DIR` (`$T/cfg`), so no real Claude Code config was read or changed.
- The marketplace is a `git clone` of the branch at commit `09081a3` (`$T/repo`), which is what `claude plugin marketplace add GeiserX/akou` fetches from GitHub: the committed files, without `node_modules`.
- `akou` on `PATH` is a two-line shim that runs the checkout's CLI with the pinned Bun, standing in for the installed `~/.local/bin/akou`.

```sh
export CLAUDE_CONFIG_DIR=$T/cfg PATH=$T/bin:$PATH
claude mcp list                                # baseline
claude plugin validate $T/repo
claude plugin marketplace add $T/repo
claude plugin install akou@akou
claude plugin list
claude plugin details akou@akou
claude mcp list
```

## Output

```
== baseline: mcp list
No MCP servers configured. Use `claude mcp add` to add a server.
== validate
Validating marketplace manifest: $T/repo/.claude-plugin/marketplace.json

✔ Validation passed
== marketplace add
Adding marketplace…✔ Successfully added marketplace: akou (declared in user settings)
== install
Installing plugin "akou@akou"...✔ Successfully installed plugin: akou@akou (scope: user)
== list

  ❯ akou@akou
    Version: 0.1.0
    Scope: user
    Status: ✔ enabled

== details
akou 0.1.0
  Description: Record your calls locally with akou and question them while they run: the akou skills and the akou_* MCP tools.
  Source: akou@akou

Component inventory
  Skills (2)  akou, akou-vocab
  Agents (0)
  Hooks (0)
  MCP servers (0)
  LSP servers (0)
== mcp list
Checking MCP server health…

plugin:akou:akou: akou mcp - ✔ Connected
```

`plugin details` shows no MCP server for this plugin, while `mcp list` shows its server, declared inline in `plugin.json`, connected. akou keeps the declaration inline on purpose: a `.mcp.json` at the repository root would also be a project MCP server for anyone who opens the repository in Claude Code.

The tools that server lists are `akou mcp`'s, which `tests/mcp.e2e.test.ts` lists over stdio and `tests/mcp-annotations.test.ts` holds to one table.

The control that can fail: the same install with no `akou` on `PATH`.

```
plugin:akou:akou: akou mcp - ✘ Failed to connect — ENOENT: Executable not found in $PATH: "stdio"
```

`claude plugin validate --strict` on `.claude-plugin/plugin.json` reports one warning, that a `CLAUDE.md` at the plugin root is not loaded as plugin context. That file is the repository's guide for contributors, not plugin content, so the warning is expected.

## Still open

- The same commands with `GeiserX/akou` in place of `$T/repo` on a clean config folder, once this is on `main`.
- The monitor PG-K2 names waits for `akou events` (PG-S3) and the monitor's own item (PG-K3).
- One install path for Claude Code. PG-M1 says that once the plugin lands, `akou skill install --harness claude` installs the plugin instead of adding the MCP entry and copying the skills. That switch is not made yet. The plugin comes from the repository's default branch, while `akou skill install` copies skills locked to the installed app's version. So the switch needs the plugin on `main` and a way to pin the plugin to the app's version. Until then, [install.md](../install.md) says to use one path or the other, never both.
- A Claude Code started from the macOS GUI. The plugin's MCP entry runs a bare `akou`, so it depends on the harness's `PATH`, and a GUI-launched Claude Code may not have `~/.local/bin` on it. On the reference Mac, open Claude Code from the Dock with the plugin installed and check `claude mcp list` or `/mcp` for `plugin:akou:akou`. If it fails, the entry needs a launcher that finds the installed `akou`. A shell script would break Windows, where the bare `akou` works.

## Summary

- From a clone of the branch, `claude plugin marketplace add` then `claude plugin install akou@akou` gives Claude Code the `akou` and `akou-vocab` skills and a connected `akou mcp` server, with no other step, provided `akou` is on `PATH`.
- Without `akou` on `PATH` the server fails to connect, which is the control.
- Still open: the run against `GeiserX/akou` after merge, the monitor, switching `akou skill install --harness claude` to the plugin (PG-M1), and a GUI-launched Claude Code finding `akou`.
