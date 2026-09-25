# Release checklist

A release is a `v<version>` tag on `main`. The [release workflow](../.github/workflows/release.yml) does the build, the checks and the publishing; this list is what a person does around it. Nothing here opens the app on a build machine: the hardware steps run on a test Mac.

## Before the tag

1. `main` is green on `check`, `ui` and `capture`.
2. `native/akou-capture` is on `main`. Without it the workflow stops: an app without its helper cannot record.
3. Set the version everywhere, from one place:

   ```sh
   bun scripts/stamp-version.ts --set 0.1.0
   bun scripts/stamp-version.ts --check
   bun run check
   ```

   [stamp-version.ts](stamp-version.ts) writes `package.json`, `src/main/app-info.ts`, `skills/akou/SKILL.md`, `skills/akou-vocab/SKILL.md`, and the helper's `Cargo.toml` and `Cargo.lock`. Commit it (`chore(release): 0.1.0`) and merge it to `main`.
4. Dry run the workflow on `main` and read every check line:

   ```sh
   gh workflow run release.yml --ref main
   gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

   The `app` job prints one `ok` line per smoke check (both `Info.plist` files, both signatures, the files beside the main process, sherpa-onnx-node loaded from the bundle, the Workers, the helper's `--from-wav` run). The artifacts are on the run page.

## The tag

```sh
git tag -a v0.1.0 -m "akou 0.1.0"
git push origin v0.1.0
```

The workflow checks the tag equals every version string, builds and checks everything again, and publishes the release with `SHA256SUMS`. A 0.x version is published as a prerelease. It is never a draft.

## After the workflow

1. The release page lists the DMG, the zip, three CLI archives and `SHA256SUMS`, and its notes start with the unsigned first-open step.
2. On a test Mac (never the build machine), from the downloaded DMG:
   - `shasum -a 256 -c SHA256SUMS --ignore-missing` passes.
   - The first open needs the documented step (Control-click Open on macOS 14, Open Anyway on 15 and later) and nothing else; macOS never says the app is damaged.
   - The window shows the models card; the download completes and the card goes away.
   - The first recording asks for the microphone and for system audio, and the prompts name akou.
   - A 60-second call records both channels; the transcript appears live.
   - Install the previous release, grant, then update to this one: record 10 s and note whether macOS asked again (expected while builds are ad-hoc signed) and whether both channels have sound after allowing.
   - The Bluetooth probe-click listening test ([TRAPS](../docs/TRAPS.md) "Probe click in Bluetooth headphones").
   - The idle tray item shows its icon in a dark and a light menu bar (System Settings > Appearance). Save both screenshots under `docs/gates/` with the date, the macOS version and the akou version ([DESKTOP](../docs/ux/DESKTOP.md) DK-T1, [TRAPS](../docs/TRAPS.md) "An invisible tray").
   - `⌘C` and `⌘V` copy and paste in the notepad and in the ask box, and `⌘Z` undoes a typed word (DK-M1).
   - With the window closed, `akou start -t "Check title"` shows one "Recording started" notification, "Started from the command line", and the title appears nowhere in it (DK-N1, DK-N4).
3. `akou-cli-<version>-darwin-arm64`: `akou --version`, `akou doctor`, `akou start` against the installed app.
4. On Ubuntu 24.04 with the GNOME AppIndicator extension, once a Linux app build exists: the tray icon shows (DK-T1).

## Signing, when the Developer ID exists

Add these repository secrets; the next run signs with the Developer ID and notarizes, with no code change:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE_P12` | The Developer ID Application certificate and key, `.p12`, base64 |
| `MACOS_CERTIFICATE_PASSWORD` | Its password |
| `ELECTROBUN_DEVELOPER_ID` | The identity, `Developer ID Application: <name> (<team id>)` |
| `ELECTROBUN_TEAMID` | The team id |
| `ELECTROBUN_APPLEID`, `ELECTROBUN_APPLEIDPASS` | The Apple ID and an app-specific password, for notarization |

Then check on the first signed run: `codesign --verify --deep --strict` still passes in the smoke check (Hutch patches the plists before it signs, so the order holds), `spctl --assess --type execute` accepts the app on the test Mac, and the grants survive an update (TRAPS "Permission grant keyed by path"). Drop the unsigned first-open step from [docs/install.md](../docs/install.md), the [README](../README.md) and the release notes in the workflow.
