# DC-N2: Fn or Globe as the dictation key on macOS

The question from [DICTATION.md](../ux/DICTATION.md) DC-N2. A press of Fn alone also runs the key's own action, set in System Settings, Keyboard, "Press fn key to": change the input source, show the emoji picker, start Apple's dictation, or do nothing. The dictation tap never swallows a modifier (DC-A1), so with Fn as the dictation key that action runs as well. What does the helper change, how does the user's value come back, and what is still unmeasured?

Result: partial

## Answer

- The action is the user preference `AppleFnUsageType` in the domain `com.apple.HIToolbox` (current user, any host, the domain `defaults` reads). `0` is Do Nothing. While `Fn` alone is the dictation key, the helper writes `0` there ([globe.rs](../../native/akou-capture/src/dictate/globe.rs), through `CFPreferences` in [mac.rs](../../native/akou-capture/src/dictate/mac.rs)).
- Before writing, it saves the user's value, or the fact that there was none, in akou's own preferences domain, `io.github.geiserx.akou.dictate`, key `globeSavedFnUsageType`. That domain is a file on disk, so it outlives a crash and a reboot.
- The value goes back on `rebind` to another key and on `stop`. After a crash it goes back at the next start bound to another key; a next start still bound to Fn keeps the saved value and owns the key again. The value goes back only while it is still `0`: a choice the user made in System Settings meanwhile stays.
- The helper writes before it says `ready`, so a helper that says it is ready owns the key.
- `cargo test` never touches the real preferences. The tests hold a fake store, in [globe.rs](../../native/akou-capture/src/dictate/globe.rs) and in the session test of [session.rs](../../native/akou-capture/src/dictate/session.rs), and each rule went red when mutated.

## The check

The helper job in [ci.yml](../../.github/workflows/ci.yml) runs the shipping helper on a GitHub macOS runner, the only place a test changes a user preference. It sets `AppleFnUsageType` to `2`, then:

1. starts the helper bound to `Fn`: the value reads `0`;
2. sends `stop`: the value reads `2` again;
3. starts it bound to `Fn` and kills it with `SIGKILL`: the value still reads `0`, which proves the next check is a real repair;
4. starts it bound to `RightCommand`: the value reads `2`, and after `stop` akou's saved copy is gone.

## Still open

- **Whether the system follows the change at once.** The check reads the stored value; it does not press a real Fn key, since a runner has no keyboard. Some `com.apple.HIToolbox` values only take effect after the next login. On a real Mac with an Apple keyboard, bind Fn, press it alone, and check that no emoji picker or input source switch appears; then rebind and check the old action is back. If it needs a login, the helper must also tell the text input system to reload its settings.
- **A third-party keyboard that sends no Fn.** Many do not. The recorder's 2 s test (DC-N2, the page's side) shows the message; checking it needs such a keyboard.
