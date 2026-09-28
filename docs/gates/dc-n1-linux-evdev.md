# DC-N1: the dictation key on Linux through evdev

The question from [DICTATION.md](../ux/DICTATION.md) DC-N1, for Linux: how does `akou-capture dictate` hear its key where the GlobalShortcuts portal is missing, what does it need from the system, and what has been checked on real devices?

Result: partial

## Answer

- The helper reads the kernel's input devices, `/dev/input/event*`, on its own thread ([linux.rs](../../native/akou-capture/src/dictate/linux.rs)). That thread names each key ([evdev_keys.rs](../../native/akou-capture/src/dictate/evdev_keys.rs)), hands it to the gate and goes back to `poll`. It never waits on the mic or anything else.
- A device is classified from `/sys/class/input/eventN/device/capabilities/key`, without opening it. A keyboard (a space bar or a modifier) is read always. A mouse (a middle or side button, no keys) is read only while a mouse button is bound or the recorder is open, since it also reports every move. Anything else, like a power button or a headset's buttons, is never read. The list is read again every 2 s.
- Keys are named by their evdev code, a place on the keyboard: `KEY_A` is the key labelled A on a US keyboard on any layout, as on macOS. The Super keys are the Command family, Alt the Option family. The back button is `Mouse4` and the forward button `Mouse5`, under either code pair a mouse may send.
- evdev cannot hide a key from the apps without grabbing the whole keyboard and replaying every other key through uinput. The helper does neither: `ready.swallow_keys` is false, so the app shows no Enter hint (DC-A4), and a chord's last key also reaches the app under the cursor.
- Events are stamped by the kernel on `CLOCK_MONOTONIC` (`EVIOCSCLOCKID`), the helper's awake clock. When a device's buffer overflows (`SYN_DROPPED`) or the device goes away, the gate is resynced from the keys the kernel says are down (`EVIOCGKEY`), so a hotkey released in the gap does not stick.

## What it needs

The nodes belong to `root:input` with mode `0660`. `grants.accessibility` in `ready` is `granted` when some keyboard node is readable by the helper's user, asked with `access(2)` without opening one, and `denied` otherwise. Two ways give access:

- the `uaccess` tag, which gives the user of the active seat an ACL on the node and takes it away when the seat changes hands. The rule has to sort before `73-seat-late.rules`:

  ```
  # /usr/lib/udev/rules.d/70-akou-dictate.rules
  SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_KEYBOARD}=="1", TAG+="uaccess"
  SUBSYSTEM=="input", KERNEL=="event*", ENV{ID_INPUT_MOUSE}=="1", TAG+="uaccess"
  ```

- the `input` group, which needs a new login and stays in force for every session of that user.

Either one lets any program of that user read every keyboard, which is also what a keylogger needs. That is why the portal comes first where the desktop has one, and evdev only where it does not.

The package does not install the rule yet; that comes with the Linux desktop build (akou-w51.70).

## The check

The `capture-linux` job in [ci.yml](../../.github/workflows/ci.yml), under PipeWire and under PulseAudio, makes a virtual keyboard and a virtual mouse through uinput, and gives the runner's user an ACL on their two nodes, which is what the `uaccess` rule does for the user at the seat. A tone plays into the job's virtual mic. The shipping helper then has to:

1. before the ACL, with the keyboard unreadable, start nothing from a held Right Control: the control, since a check that cannot fail proves nothing;
2. after the ACL, report `"accessibility":"granted"` from `--probe`;
3. start a session from a held Right Control, end it with `reason: release` and write `AKP1` packets on stdout;
4. report `A` while the recorder is open;
5. start a session from the mouse's back button bound as `Mouse4`.

First run: <https://github.com/GeiserX/akou/actions/runs/36360828476> (jobs `capture-linux (pipewire)` and `capture-linux (pulseaudio)`, 2026-09-28), every check passed. Under PipeWire the session started with `"mic":{"transport":"other","why":"default"}`, the tone read at an RMS of 0.17 on every `level` line, and it ended with `reason: release`. An earlier run held the key for 800 ms: under PulseAudio the stream opened (`mic open`) but no session started before the release, while PipeWire's did. DC-N4's readiness gate starts a session only at the first sample, so a cold PulseAudio stream seems to need most of a second to deliver it. The check now holds for 2 s. How long a cold PulseAudio open really takes is not measured; until it is, a short first press with a closed stream (`warmMic: off`, or the first press under `auto`) may start nothing there.

## Still open

- **The GlobalShortcuts portal** (KDE, recent GNOME, Hyprland), which needs no rule and no group, and whose `Activated` and `Deactivated` already run a session on fakes ([tap.rs](../../native/akou-capture/src/dictate/tap.rs)). It needs a real GNOME and KDE session to check.
- **A real desktop.** The check runs on a runner with no display server. Whether a Wayland compositor or X11 changes what evdev sees is not checked; evdev is under both, so no difference is expected.
- **Non-US layouts.** A chord names a place, so `Control+Shift+Z` on a German layout is the key labelled Y. The recorder shows the name the helper reports, so what the user presses is what gets bound.
