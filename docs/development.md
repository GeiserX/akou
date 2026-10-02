# Development

akou is one package: a Bun and TypeScript app with a Rust capture helper. The conventions for anyone working in the repository, person or agent, are in [AGENTS.md](https://github.com/GeiserX/akou/blob/main/AGENTS.md). This page is the short version.

## The stack

- [Bun](https://bun.sh) 1.4.2, pinned in `.bun-version`, and TypeScript in strict mode. [Biome](https://biomejs.dev) lints and formats.
- [ElectroBun](https://github.com/blackboardsh/electrobun) 2.0.1 for the macOS app and its window.
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) for the speech models.
- Rust helpers under [`native/`](https://github.com/GeiserX/akou/tree/main/native): `akou-capture` records the microphone and the call audio, `akou-diarize` labels the speakers.

## Build and test

```sh
git clone https://github.com/GeiserX/akou
cd akou
bun install --frozen-lockfile
bun run check
```

`bun run check` runs, in order, the Bun version check, Biome, `tsc` for the app and for the window, then `bun test` and its floor. CI runs exactly this on macOS, Windows and Linux. It refuses any Bun but the pinned one; to run it without installing that Bun, use `bunx bun@$(cat .bun-version) run check`.

- `bun run format` applies Biome's fixes.
- `bun run test:ui` drives the window in a headless browser. Install the browser once with `bunx playwright-core install --only-shell chromium`.
- `bun run build:ui` builds the window's static bundle into `dist/ui`.

Every CI test job has a floor in `tests/floors.json`: fewer passing tests or more skips fail the job. A skip is only allowed for a missing model, device or operating system, with the reason in the test's name.

Most tests need no microphone, no model and no network. A fake capture helper, [`scripts/fake-helper.ts`](https://github.com/GeiserX/akou/blob/main/scripts/fake-helper.ts), replays a stereo WAV (left the microphone, right the call) as the real helper's packets, opens no audio device and plays nothing. Its switches reproduce the capture traps, such as a silent call side or a slow start. Which suite proves what is in [TESTING.md](https://github.com/GeiserX/akou/blob/main/docs/TESTING.md).

## Building the app

```sh
bun scripts/build-app.ts
```

It builds the capture helper with `cargo build --locked --release`, the window, the recognition Workers and the bundled `akou` command, then the macOS app, ad-hoc signed, and copies the DMG and a zip to `dist/release/`. Nothing in the build opens the app; `scripts/smoke-app.ts` checks what was built.

## Releases

A release is a `v<version>` tag on `main`. `bun scripts/stamp-version.ts --set <version>` writes the version into every file that carries it, and `--check` confirms they agree. The [release workflow](https://github.com/GeiserX/akou/blob/main/.github/workflows/release.yml) then builds the app and the command lines, runs the smoke checks, writes `SHA256SUMS` and publishes the release. Only a version with a prerelease part, such as `0.6.0-rc.1`, is published as a prerelease. What a person does around the tag, including the checks on a real Mac, is in the [release checklist](https://github.com/GeiserX/akou/blob/main/scripts/release-checklist.md), and the pipeline is described in [CI-CD.md](https://github.com/GeiserX/akou/blob/main/docs/CI-CD.md).

## Design notes

The design and its reasoning live beside the code on GitHub, not on this site:

- [DESIGN.md](https://github.com/GeiserX/akou/blob/main/docs/DESIGN.md): the architecture.
- [ROADMAP.md](https://github.com/GeiserX/akou/blob/main/docs/ROADMAP.md): what comes next.
- [TRAPS.md](https://github.com/GeiserX/akou/blob/main/docs/TRAPS.md): the failures we met, each with the test named after it.
- [docs/ux/](https://github.com/GeiserX/akou/tree/main/docs/ux): the window, the command line, dictation and server mode, one design each.

## Contributing and security

Commits follow conventional commits (`feat(log): ...`, `fix(fold): ...`). A change that touches a trap in TRAPS.md adds a test for it first. The repository is public: no private names, machine paths, credentials or real call recordings go into it, and test fixtures are generated.

To report a security problem, follow the [security policy](https://github.com/GeiserX/akou/blob/main/SECURITY.md) and do not open a public issue.
