# CI and CD

How akou's pipeline runs the tests in [TESTING.md](TESTING.md), protects `main`, and turns a tag into a release. The targets are in [DESIGN §9](DESIGN.md#9-packaging-signing-updates-ci), the manual steps around a release in the [release checklist](../scripts/release-checklist.md). Where DESIGN §9 describes CI jobs or signatures differently, this file is the current design.

Items use the same fields as TESTING.md: an id, a priority (P0 now, P1 this segment, P2 with the feature or milestone; P3 goes to the parking list, not a bead), where it comes from, a check that can pass or fail, and what exists on `main` at `6568058`. This file owns the `CI-` ids.

## 0. The simple version

- The repository is public, so every job runs on GitHub-hosted runners, which are free for public repositories. No self-hosted runner ever runs pull-request code.
- One required check, `ci-ok`, guards `main`. It passes only when every job it depends on passed or was skipped on purpose.
- Pull requests get the fast, deterministic lanes on all three OSes. Real models, time-zone shifts, the accelerated soak and the macOS floor run nightly. Hardware steps run by hand before a release.
- A tag `v*` builds, checks and publishes a release with checksums and build attestations. While the version is 0.x it is a prerelease. It is never a draft. A stable release also needs its evidence on record: the terms check and every M0 gate.
- Every gate has been seen to fail once (a positive control) before we trust it green.

## 1. Today

| Workflow | Trigger | What it runs | Today |
|---|---|---|---|
| `check` | push to `main`, every PR | Biome, `tsc` twice, `bun test` on ubuntu, macos, windows (`-latest`) | moved into `ci.yml` (CI-2), with a floor, a timeout and concurrency |
| `ui` | push to `main`, every PR | Playwright on Chromium over the headless app | moved into `ci.yml` (CI-2); the dead-call banner flake is fixed (TESTING TS-1 e) |
| `capture` | push to `main`, every PR | Rust fmt, clippy, `cargo test`, release and `simulate` builds, the trap e2e against the real binary (a skip fails), PipeWire and PulseAudio rigs, a Windows VB-CABLE exclusion test | moved into `ci.yml` (CI-2); no cargo cache; the helper-crash flake is fixed (TS-1 a) |
| `models` | changes to model pins or loaders, dispatch | downloads the pinned recognizer and transcribes one clip on three OSes | has |
| `release` | tag `v*`, dispatch (dry run), packaging PRs | version check, full `check` again, macOS app through Hutch (ad-hoc signed), three CLI binaries, smoke checks, `SHA256SUMS`, GitHub release | has |
| `diarize` | PR #15 branch only | Nemotron helper checks, cached model, two-voice smoke | pending merge |
| `scratch-stop-trace` | none (branch deleted) | a leftover from debugging, still registered as active | disable after CI-2 merges, with the old `check`, `ui` and `capture` |

Already right: every action pinned by commit SHA with a version comment; `permissions: contents: read`; capture jobs fail on any skip; the Windows job fails when no audio endpoint exists instead of passing; release concurrency never cancels; the tag must equal every version string. Secret scanning and push protection are on.

History since the repository started: 31 failed runs out of 187 completed. Most were real bugs caught before merge. Four were a date bomb (fixed), five were timing or load flakes ([TESTING TS-1](TESTING.md#41-keeping-the-suite-honest)), and `main` is red now on two of those. The fix for a third is open as PR #19.

## 2. The pipeline we want

### 2.1 Pull requests and `main`: `ci.yml`

`check`, `ui` and `capture` (and `diarize` once PR #15 lands) move into one workflow. One aggregate job can then be the required check, and a docs-only change can skip the heavy legs without leaving a required check pending forever.

```
changes ─┬─ lint ──────────────────────────────┐
         ├─ unit (ubuntu x64 + arm, macos, win) ┤
         ├─ ui (chromium, webkit) ──────────────┤
         ├─ capture (7 legs) ───────────────────┼─ ci-ok
         ├─ diarize (3 legs) ───────────────────┤
         └─ release-dry (packaging) ────────────┘
```

- `changes` decides which legs a PR needs from the paths it touches. A docs-only PR runs `lint` only.
- `lint` runs Biome, both `tsc`, `cargo fmt --check`, `cargo clippy -D warnings`, the generated-reference drift checks ([TESTING §4.3](TESTING.md#43-contracts-the-three-doors-stay-equal): settings, MCP, the CLI reference of CLI-31, the OpenAPI file of PG-A2, the parity table), `scripts/trap-coverage.ts`, `scripts/ci/clock-lint.ts`, and actionlint and zizmor on `.github/`.
- `unit` runs `bun test` with the JUnit reporter and the floor check, and `cargo test`. Coverage with its threshold runs on the Linux x64 leg only. The Linux arm64 leg covers the arm64 CLI DESIGN §9 ships, on a runner that is free on public repositories.
- `ci-ok` has `needs:` on every job and `if: always()`, and fails when any needed job failed or was cancelled. Skipped is fine; that is the point of `changes`.

`models.yml` stays separate. It downloads gigabytes, so it keeps its path filter and is not required.

### 2.2 Nightly: `nightly.yml`

Scheduled once a day on `main`, plus dispatch.

- `models-nightly` on three OSes: every engine in the registry with the five-engine floor, the evaluation sets, WER, diarization error, language id, streaming numbers, latency percentiles, the replay recall floor, the vocabulary evaluation with its positive control ([TESTING §4.5](TESTING.md#45-speech-many-engines-fusion-streaming-language-diarization)). Speed budgets gate the default engines only.
- `clock-shift`: the unit and e2e suites a year in the future and in two unusual time zones.
- `soak`: the fake helper at 10x speed for one runner hour.
- `macos-floor`: unit and helper-load legs on `macos-14` (CI-9).
- `audit`: `bun audit` and `cargo audit`.

A red night shows in the job summary, and GitHub emails the person who last changed the schedule when a scheduled run fails. That is enough at our size; no bot opens issues. GitHub turns off scheduled workflows after 60 days without repository activity, so the release checklist confirms the schedule is still on.

### 2.3 Release: `release.yml`

On a `v*` tag: check that the tagged commit already has a green `ci-ok` instead of running `check` a second time; for a stable version, check the evidence (CI-28); stamp and check versions; build per OS on its own runner (ElectroBun cannot cross-compile); smoke each artifact without opening it; write `SHA256SUMS`; attest every artifact; publish.

## 3. The items

### 3.1 Protecting `main`

| # | Item | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CI-1 | Protect `main` and keep history linear | P0 | intent (CI/CD properly set up); PR titles become commit messages | `gh api repos/GeiserX/akou/rulesets` shows a ruleset on `main` that requires `ci-ok`, blocks force pushes and deletion, and requires a PR. Repository settings allow squash merges only, with `delete_branch_on_merge: true`, and the merged branches left today are removed. Proven by a test PR with a failing job that cannot be merged | missing: no ruleset; merge, rebase and squash all allowed; branches kept |
| CI-2 | One workflow, one required check, `ci-ok` | P0 | the path-filter problem of required checks; PR #14 ran three full sets at once | `check`, `ui` and `capture` move into `ci.yml` with the aggregate job. A PR where one leg fails shows `ci-ok` red; a docs-only PR shows it green with the heavy legs skipped. `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }`, so a second push to a PR cancels the first run and two pushes to `main` both complete. The leftover `scratch-stop-trace` workflow is deleted and no longer listed as active by `gh api repos/GeiserX/akou/actions/workflows` | partial: `ci.yml` with `ci-ok` and the concurrency above; after merge, `scratch-stop-trace` and the old `check`, `ui` and `capture` stay listed as active until disabled (`gh api -X PUT repos/GeiserX/akou/actions/workflows/<id>/disable`); `main` has no ruleset yet, so nothing requires `ci-ok` until CI-1 |
| CI-4 | CodeRabbit review on every PR | P1 | intent (review on every PR) | A `.coderabbit.yaml` with path instructions pointing reviewers at TRAPS.md and AGENTS.md; `lint` fails if the file is missing. The review itself is a manual check: the PR template has a line for it, and the person merging confirms a CodeRabbit review exists, or posts `@coderabbitai review` once its hourly window allows. Advisory, never a required check | missing: no `.coderabbit.yaml` |
| CI-29 | Repository files and security settings | P1 | audit (no community files); anarlog and Meetily ship them | `CONTRIBUTING.md` pointing at [AGENTS.md](../AGENTS.md); `SECURITY.md` with private vulnerability reporting turned on; a PR template asking for the trap id, the positive control and the CodeRabbit line. Secret scanning validity checks turned on (scanning and push protection already are) | partial: scanning and push protection on; no files |

CI-3 (squash only) is now part of CI-1. CI-6 (remove the leftover workflow) and CI-7 (cancel superseded runs) are now part of CI-2.

### 3.2 Running jobs well

| # | Item | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CI-5 | A timeout on every job | P1 | audit (`check` has none; the default is 6 hours) | A small check in `lint`: every job in every workflow has `timeout-minutes`. A job without one fails `lint` | partial |
| CI-8 | Pinned runner images | P1 | DESIGN §9 (ubuntu-24.04, macos-15, windows-2025) | Every job uses a pinned label: `ubuntu-24.04`, `ubuntu-24.04-arm`, `macos-15`, `windows-2025`, `macos-14` for the floor leg. `lint` fails on any `-latest` label | missing (all `-latest`, which is macOS 26 today against a 14.4 floor) |
| CI-9 | A macOS floor leg | P1 | DESIGN §9 and install.md claim macOS 14.4 as the minimum; no job tests it | Unit and helper-load legs on `macos-14` in `nightly.yml`, so the floor claim has a job that can fail without spending a PR's macOS slots | missing |
| CI-10 | Rust build cache | P1 | audit (helper builds from scratch, up to 303 s per OS) | A cargo cache keyed on `Cargo.lock`, the runner image version and the feature set, so an image rotation never reuses a stale `target/` (Minutes was bitten by this). A second run on the same commit builds the helper in under a minute | missing |
| CI-11 | Model cache | P1 | nightly downloads several engines per OS | Cache keyed by each model's SHA-256; a cache miss downloads and verifies the checksum. Eviction under the repository cache limit only costs time | partial (diarize model on PR #15) |
| CI-12 | macOS job budget | P1 | the free plan runs at most 5 macOS jobs at once | One push to a PR starts at most 3 macOS jobs (unit and capture); the model, floor and release legs start on their own triggers | partial |

### 3.3 Supply chain and workflow security

| # | Item | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CI-13 | Dependabot, grouped and weekly | P1 | audit (disabled); Minutes groups by ecosystem | `.github/dependabot.yml` for `bun`, `cargo` and `github-actions`: minor and patch grouped in one PR per ecosystem per week, majors alone, each ignore with its reason. Dependabot alerts and security updates turned on. Squash-merged with an explicit subject and body so no trailer is added | missing |
| CI-14 | Audits beyond alerts | P2 | alerts miss advisories that `audit` finds | Nightly `bun audit` and `cargo audit`; a high or critical finding fails the night | missing |
| CI-15 | CodeQL | P1 | audit (no code scanning) | Code scanning default setup on, first analysis visible under the Security tab | missing |
| CI-16 | Workflow lint and security scan | P1 | Minutes (actionlint), anarlog (zizmor); public repo | actionlint and zizmor run in `lint` on any `.github/` change; zizmor findings at medium or above fail. zizmor's `unpinned-uses` audit runs with a hash-pin policy for every action, so an action referenced by tag fails; `dangerous-triggers` fails on `pull_request_target`; `artipacked` requires `persist-credentials: false` on every checkout that does not push. One more line in `lint` fails on `secrets.` referenced by any job a `pull_request` event can run. A job may read secrets only when its `if:` limits it to a tag push or `workflow_dispatch`, so a packaging dry run on a pull request builds unsigned. Positive controls: a scratch workflow using `actions/checkout@v4` by tag fails `lint`, and so does a job that reads `secrets.` with a `pull_request` trigger and no such `if:` | partial: SHA pins and no `pull_request_target`; nothing enforces them, and the release workflow's pull-request dry run does not meet the secrets rule yet |

CI-17 (no secrets on PR code) and CI-18 (actions pinned by SHA) are now part of CI-16, which enforces both.

### 3.4 Releases

| # | Item | P | From | Acceptance | Today |
|---|---|---|---|---|---|
| CI-19 | Release gated on the tested commit | P2 | Minutes binds promotion to the reviewed SHA | The release job looks up `ci-ok` for the tagged SHA and stops if it is not green, instead of re-running `check` | missing (runs `check` again) |
| CI-28 | A stable release needs its evidence | P1 | [providers.md](providers.md) ("before each release we read the current terms"); ROADMAP M0 (G3 partial, G4 failed as run) | For a version outside 0.x, `stamp-version.ts --check` fails unless (a) the newest row of the terms table in providers.md has a date later than the previous stable tag, and (b) every gate G1 to G8 has a Pass verdict in the summary table of [gates/M0-results.md](gates/M0-results.md). Prereleases are not blocked, so development never waits on a gate. Positive control: a `v1.0.0` dry run fails today on both counts: the terms row says "not yet checked", G1, G2 and G7 have no row, and G3 and G4 are not Pass. The release checklist carries the same two lines | missing |
| CI-20 | A changelog | P1 | intent (a release updates the changelog) | `CHANGELOG.md` gets a section per version in the version-bump PR; `stamp-version.ts --check` fails when the section for the version is missing. The release notes start with that section, then the generated PR list | missing (`--generate-notes` only) |
| CI-21 | Build attestations, the one signature | P1 | DESIGN §9 | `actions/attest-build-provenance` on every artifact (`id-token: write`, `attestations: write` in the release job only). `gh attestation verify <file> -R GeiserX/akou` passes on a downloaded asset. Attestations replace the cosign signature DESIGN 6.1 and §9 name for the CLI tarball: one keyless mechanism, no key to guard. How `akou self-update` checks them is designed with self-update | missing |
| CI-22 | Artifacts per OS as milestones land | P2 | DESIGN §9, ROADMAP M3 and M4 | Linux: AppImage, `.deb`, CLI tarball for x64 and arm64. Windows: the ElectroBun installer. Each built on its own runner and listed in `SHA256SUMS`. Each is smoke-started headless (`AKOU_HEADLESS=1`, `akou status` answers). On Linux the installed package also runs the PipeWire capture rig against its own helper, and opens its window under Xvfb, which is the first test of the packaged webview | macOS app and three CLIs only |
| CI-23 | Update feed | P1 | DESIGN §9 updater; the desktop research (no updater wired) | The release uploads the ElectroBun update files, and `release.baseUrl` points at the release download URL. A smoke test fetches the feed for the new version. The feed is the only update source: the update notice (DK-U1 in [DESKTOP.md](ux/DESKTOP.md)) reads it through the updater's `checkForUpdate()`, never through a second poll of the GitHub API. The app never applies an update during a call or a final pass ([TRAPS](TRAPS.md), "Updater replaces the app mid-call") | missing |
| CI-25 | Homebrew cask bump | P2 | DESIGN §9, [T4.12] | With `TAP_PUSH_TOKEN` set, a tag pushes the cask bump to the tap; a dry run without the secret fails loudly | missing |

### 3.5 Tests the pipeline runs

These are specified in [TESTING.md](TESTING.md); this is where each runs.

| Test item | Lane |
|---|---|
| TS-1 flake fixes, TS-2 floors and no focused tests, TS-15 hidden-means-hidden | `ci.yml`, every PR (P0) |
| TS-4 clock lint, TS-6 trap coverage, TS-9 to TS-13 generated references and parity | `lint` |
| TS-8 coverage | `unit`, Linux x64 leg |
| TS-14 WebKit, TS-15b accessibility | `ui` |
| TS-16 to TS-18 deterministic fusion, streaming, language id | `unit` |
| TS-5 clock shift, TS-16c to TS-20 real models, TS-23 budgets, TS-24 accelerated soak | `nightly.yml` |
| TS-21 real-call evaluation, TS-27 real harness and AI fuser, long soak, grants, drift | the reference Mac, by hand, before a release |

## 4. What we will not build

- A self-hosted runner for this repository. Pull-request code from anyone would run on our hardware, and GitHub-hosted runners cost nothing here.
- Automatic retries or a quarantine list ([TESTING §5](TESTING.md#5-flake-policy)).
- A second CI system, a release bot, or a changelog generator. The version-bump PR and the tag are enough at our size.
- A bot that opens issues for red nights, and a nightly job on `-latest` images. Pinned labels plus the scheduled-run email cover both until an image rotation actually bites.
- A cosign key next to the attestations (CI-21).
- A `CODEOWNERS` file. With one maintainer it routes every review to the same person.
- Gating on a pixel diff before the DOM assertions miss something real.

## Parking list

Seen and worth keeping in mind, not beads until someone needs them.

- Signing: Developer ID and notarization on macOS, a signed Windows installer. We ship unsigned for now; ad-hoc signed macOS builds, and the SmartScreen step documented for Windows. The workflow already reads the Developer ID secrets when they exist.
- A beta channel: a scheduled prerelease from `main` that the updater offers when the user opts in (Granola and anarlog have a staging channel).
- An SBOM: an SPDX file per artifact, attached to the attestation.
- Issue templates, once issues arrive.

## P0

1. CI-2: `ci.yml` with the aggregate `ci-ok`, superseded PR runs cancelled, the leftover workflow deleted.
2. CI-1: a ruleset on `main` that requires `ci-ok`, squash-only merges, branches deleted on merge.

CI-2 comes first because CI-1 needs the check to exist.

## Summary

- Today akou runs 841 Bun tests, 131 Rust tests, 43 UI tests and real virtual-device capture on every PR across three OSes, with actions pinned by SHA and a working tag-to-prerelease path. Nothing protects `main`, `main` is red on two flakes, runners float on `-latest`, and there is no nightly, coverage, dependency update, code scanning or attestation.
- P0 is two items: one workflow with one aggregate check, `ci-ok`, then a ruleset that requires it with squash-only merges. Everything else in the old P0 list (timeouts, SHA pins, no secrets on PR code) is either folded into those two or enforced at P1 by zizmor and a timeout check.
- P1 adds pinned images with a Linux arm64 unit leg, a nightly macOS 14 floor leg, caches, Dependabot, CodeQL, CodeRabbit as a manual advisory check, community files, the nightly model and clock-shift jobs, a changelog, attestations as the one signature, the update feed as the one update source, and a gate that stops a stable release until the terms check and every M0 gate are on record.
- P2 and later follow the milestones: Linux and Windows packages with a packaged-webview smoke, the cask bump, the release gate on the tested commit. Signing, a beta channel and an SBOM are parked.
