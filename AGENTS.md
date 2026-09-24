# AGENTS.md

Conventions for anyone, human or agent, working in this repository. The design is in [docs/DESIGN.md](docs/DESIGN.md); read [docs/INDEX.md](docs/INDEX.md) first.

## Layout

One package. Follow the layout in DESIGN section 10 exactly.

- `src/core/log/`: the event log. `events.ts` (schema v1 types and validator), `writer.ts` (the single writer), `reader.ts` (reading, torn lines, tailing, the one sort order), `clock.ts` (wall clock versus audio offset), `fold.ts` (the only reader of raw events).
- `src/core/vocab/correct.ts`: read-time vocabulary correction, used by the fold.
- `src/main/`, `src/ui/`, `native/akou-capture/`: the app, the window and the capture helper, as the design lays them out.
- `tests/`: `bun test` suites.

## Commands

- `bun install --frozen-lockfile`
- `bun run check`: Biome, `tsc --noEmit`, then `bun test`. CI runs exactly this on macOS, Windows and Linux.
- `bun run format`: apply Biome's fixes.
- `bun run test:ui`: the window in a headless browser (Playwright's Chromium headless shell, installed with `bunx playwright-core install --only-shell chromium`). `bun run check` leaves `tests/ui/` out; the `ui` workflow runs it.
- `bun run build:ui`: the window's static bundle into `dist/ui`.

## Rules

- Bun and TypeScript, strict, ESNext. Biome for lint and format. No new runtime dependency without a reason written in the commit.
- Every trap in [docs/TRAPS.md](docs/TRAPS.md) that a change touches gets a test first, named after the trap id (for example `[F2.50] Torn last line`). Critical invariants carry a positive control: a case proving the check fails when the rule is broken.
- The event log is append-only. Never edit or rewrite an event; a correction is a new event with a higher `rev`.
- Every time shown to a person or a model is local wall-clock time. Never render an offset as a bare `mm:ss`.
- Conventional commits (`feat(log): …`, `fix(fold): …`, `test: …`). Stage exact paths.
- No AI attribution anywhere: no `Co-Authored-By` trailers, no "generated with" lines, in commits, PRs or files.
- This repository is public. Never write private context into it: no employer or colleague names, no local machine paths, no credentials, no real call recordings or transcripts. Test fixtures are generated.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
