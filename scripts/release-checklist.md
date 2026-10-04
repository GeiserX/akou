# Release checklist

A release is a `v<version>` tag on `main`. The [release workflow](../.github/workflows/release.yml) does the build, the checks and the publishing; this list is what a person does around it. Nothing here opens the app on a build machine: the hardware steps run on a test Mac.

## Before the tag

1. `main` is green on `ci-ok`. The tag runs no tests of its own: it waits for `ci-ok` on the tagged commit and stops unless it passed ([CI-CD](../docs/CI-CD.md) CI-19). If a known flake turned it red, rerun the failed legs of that CI run, then rerun the release's failed jobs.
2. The `TAP_PUSH_TOKEN` secret exists (`gh secret list --repo GeiserX/akou`). The tag's `cask` job pushes the Homebrew cask bump with it and fails without it, because the workflow's own token cannot push to `GeiserX/homebrew-akou` ([CI-CD](../docs/CI-CD.md) CI-25). Make it a fine-grained token with Contents read and write on that repository only. A failed `cask` job leaves the release published: add the secret, then rerun the failed job.
3. `native/akou-capture` is on `main`. Without it the workflow stops: an app without its helper cannot record.
4. Set the version everywhere, from one place:

   ```sh
   bun scripts/stamp-version.ts --set 0.1.0
   bun scripts/stamp-version.ts --check
   bun run check
   ```

   [stamp-version.ts](stamp-version.ts) writes `package.json`, `src/main/app-info.ts`, `skills/akou/SKILL.md`, `skills/akou-vocab/SKILL.md`, and the helper's `Cargo.toml` and `Cargo.lock`. Write the version's section in [CHANGELOG.md](../CHANGELOG.md), headed `## 0.1.0`; `--check` fails without it, and the release notes start with it (CI-20). Commit both (`chore(release): 0.1.0`) and merge it to `main`.
   For a stable version (1.0.0 or later, no prerelease part), `--check` also fails until the evidence is on record ([CI-CD](../docs/CI-CD.md) CI-28). Prereleases skip both lines:
   - The terms check in [docs/providers.md](../docs/providers.md): read the current Anthropic and OpenAI terms and add a row dated after the previous stable release.
   - The gates in [docs/gates/M0-results.md](../docs/gates/M0-results.md): every gate G1 to G8 has a Pass verdict in the summary table.
5. Dry run the workflow on `main` and read every check line:

   ```sh
   gh workflow run release.yml --ref main
   gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

   The `app` job prints one `ok` line per smoke check (both `Info.plist` files, both signatures, the files beside the main process, sherpa-onnx-node loaded from the bundle, the Workers, the helper's `--from-wav` run). The artifacts are on the run page.

5. Before a stable release (1.0.0 or later), on the reference Mac: the 8-hour soak, at real time, with a busy process on every core, through the Rust helper in file mode, which writes a real Opus file and opens no device (TS-24, [TRAPS](../docs/TRAPS.md) T3.8):

   ```sh
   cargo build --release --manifest-path native/akou-capture/Cargo.toml
   bun scripts/soak.ts --speed 1 --minutes 480 --burner \
     --helper native/akou-capture/target/release/akou-capture --out "docs/gates/soak-$(bun -p "require('./package.json').version").json"
   ```

   Every check prints `ok`. The JSON is named after the version step 3 stamped; commit it with the release. A runner job cannot do this: its limit is 6 hours.

## The tag

```sh
git tag -a v0.1.0 -m "akou 0.1.0"
git push origin v0.1.0
```

The workflow checks the tag equals every version string and that `ci-ok` passed on the tagged commit, builds and checks every artifact, attests each one, and publishes the release with `SHA256SUMS`. A 0.x version is published as a prerelease. It is never a draft.

## After the workflow

1. The release page lists the DMG, the zip, four CLI archives, the update manifest and bundle (`stable-macos-arm64-*`) and `SHA256SUMS`, and its notes start with the version's changelog section, then the unsigned first-open step. From a downloaded asset, `gh attestation verify <file> -R GeiserX/akou` passes (CI-21).
   `Casks/akou.rb` in https://github.com/GeiserX/homebrew-akou says this version (CI-25).
   The `update-feed` release holds the same manifest and bundle: the release job replaced them and fetched the manifest back as the app does (CI-23).
2. On a test Mac (never the build machine), from the downloaded DMG:
   - `shasum -a 256 -c SHA256SUMS --ignore-missing` passes.
   - The first open needs the documented step (Control-click Open on macOS 14, Open Anyway on 15 and later) and nothing else; macOS never says the app is damaged.
   - The window shows the models card; the download completes and the card goes away.
   - The first recording asks for the microphone and for system audio, and the prompts name akou.
   - A 60-second call records both channels; the transcript appears live.
   - The real harnesses answer through the packaged app (TS-27). With Claude Code logged in, `akou config set provider.kind harness`, `akou config set provider.harness claude`, then `akou ask "What was said in this call?" --call last --json` about the 60-second call: it prints `"answered": true` and Claude Code's answer. Then the same with Codex logged in and `provider.harness codex`. Put both settings back as they were. CI never runs this: it needs a logged-in subscription.
   - Install the previous release, grant, then update to this one: record 10 s and note whether macOS asked again (expected while builds are ad-hoc signed) and whether both channels have sound after allowing.
   - The Bluetooth probe-click listening test ([TRAPS](../docs/TRAPS.md) "Probe click in Bluetooth headphones").
   - The idle tray item shows its icon in a dark and a light menu bar (System Settings > Appearance). Save both screenshots under `docs/gates/` with the date, the macOS version and the akou version ([DESKTOP](../docs/ux/DESKTOP.md) DK-T1, [TRAPS](../docs/TRAPS.md) "An invisible tray").
   - Record from the tray: the item becomes the mark with a red dot and no text, still in the dark and the light menu bar, and its menu still opens. Stop: the idle icon is back and follows the bar again (DK-T2; on macOS the shell swaps the status item, since ElectroBun's `setImage` drops the template flag).
   - `⌘C` and `⌘V` copy and paste in the notepad and in the ask box, `⌘Z` undoes a typed word and `⇧⌘Z` redoes it, `⌘,` opens Settings with the window closed, `⌘W` closes the window and `⌘Q` quits (DK-M1).
   - During a recording, `⌘Q` asks "A call is recording. Stop it and quit?"; Cancel keeps recording, Stop and quit quits. Close the window, click the Dock icon: the window comes back where it was (DK-M3, DK-M2, DK-M4).
   - The main window has no grey title bar: the traffic lights sit over the sidebar, dragging the empty strip above the rows moves the window, a double-click on it zooms and a second one restores, and dragging on the title field, Template or Record does not move it (DK-M7).
   - On a Mac with no `akou` on PATH, akou menu > Install Command-Line Tool… installs it (a password is asked only if `/usr/local/bin` needs one); in a new terminal `akou --version` prints this release's version; a second run says it is already installed (DK-M6).
   - During a recording, switch to another app: the floating indicator shows the time and both levels, stays above the other app, and never takes its focus; drag it, stop the call, start another: it comes back where it was dragged. With the akou window in front it is hidden (DK-F1).
   - With the meeting app in front and the akou window behind it, speak and play call audio: both of the indicator's bars move with the sound, several times a second, as the window's Mic and Call meters do (DK-F1, W3.18). They move in steps of a quarter second, one per level the capture sends; they must never stand still or jump only once a second.
   - In a dark and a light appearance, look at the indicator while recording, muted (Unmute), paused, and past 10:00: the window ends at the pill's rounded edge, with no darker rectangle or edge to its right or around its corners, Stop is never cut off, and Stop stays where it is when Mute becomes Unmute (DK-F1).
   - With the window closed, `akou start -t "Check title"` shows one "Recording started" notification, "Started from the command line", and the title appears nowhere in it (DK-N1, DK-N4).
3. `akou-cli-<version>-darwin-arm64`: `akou --version`, `akou doctor`, `akou start` against the installed app.
4. On Ubuntu 24.04 with the GNOME AppIndicator extension, once a Linux app build exists: the tray icon shows (DK-T1).
5. Once Windows and Linux app builds exist, at 150 % display scaling (Windows 11; GNOME on Wayland, and X11 with scaling): during a recording the floating indicator ends at the pill's rounded edge, Stop is not cut off, and no dark rectangle shows around it (DK-F1). The window library sizes Windows windows in DIPs, which match the page's CSS pixels; on Linux the GTK path sizes in logical pixels, and whether WebKitGTK's CSS pixels match them under fractional scaling is not settled.

## Signing, when the Developer ID exists

Add these repository secrets; the next run signs with the Developer ID and notarizes, with no code change:

| Secret | Value |
|---|---|
| `MACOS_CERTIFICATE_P12` | The Developer ID Application certificate and key, `.p12`, base64 |
| `MACOS_CERTIFICATE_PASSWORD` | Its password |
| `ELECTROBUN_DEVELOPER_ID` | The identity, `Developer ID Application: <name> (<team id>)` |
| `ELECTROBUN_TEAMID` | The team id |
| `ELECTROBUN_APPLEID`, `ELECTROBUN_APPLEIDPASS` | The Apple ID and an app-specific password, for notarization |

Then check on the first signed run: `codesign --verify --deep --strict` still passes in the smoke check (Hutch patches the plists before it signs, so the order holds), `spctl --assess --type execute` accepts the app on the test Mac, and the grants survive a Developer ID signed update (TRAPS "Permission grant keyed by path"; an ad-hoc signed update may ask again, so it is no test of this). Drop the unsigned first-open step from [docs/getting-started.md](../docs/getting-started.md), the [README](../README.md) and the release notes in the workflow.
