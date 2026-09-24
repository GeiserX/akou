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
