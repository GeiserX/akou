# DC-U8: pausing other audio while dictating

The question from [DICTATION.md](../ux/DICTATION.md) DC-U8. With `dictation.muteMedia` on, music or a video playing while the user dictates should stop for the session and come back after it, without ever starting a player that was not playing and without touching a device's volume. Which OS calls do that, how is it checked, and what is still unmeasured?

Result: partial

## Answer

- The app sends `pause_media {on}` with the setting. While it is on, a session's start pauses every player the OS lists as playing, and the session's end (after the post-roll, or on `cancel`, or on `stop` in the middle of a session) plays again only the players akou paused that are still paused. A player the user played, stopped or closed meanwhile is left as it is. Turning the setting off during a session gives the players back at once ([media.rs](../../native/akou-capture/src/dictate/media.rs), the session side in [session.rs](../../native/akou-capture/src/dictate/session.rs)).
- It never uses a play/pause media key. A key toggles and cannot tell what plays: pressed while nothing plays, it starts the last player, which is how VoiceInk #208 started a music app. Each backend lists the players with their state instead.
- The player calls run on their own thread, and the backend connects only at the first pause, so a helper whose app never turns the setting on never reaches the session bus or the media service, and a player that hangs never delays a session.
- **Linux.** MPRIS on the session bus ([mpris.rs](../../native/akou-capture/src/dictate/mpris.rs)): every `org.mpris.MediaPlayer2.*` name, its `PlaybackStatus`, and `Pause` / `Play`, each call bounded at 500 ms. A player is named by the connection that owns its name, so a player that quit and started again under the same name is not played by mistake.
- **Windows.** The system media transport controls ([win_media.rs](../../native/akou-capture/src/dictate/win_media.rs)): `GlobalSystemMediaTransportControlsSessionManager`'s sessions, their playback status, and `TryPauseAsync` / `TryPlayAsync`. Windows gives a session no id of its own, so a player is its app and its place among that app's sessions.
- **macOS.** No backend. There is no public call that lists or drives another app's player. The private MediaRemote framework used to, through `MRMediaRemoteGetNowPlayingApplicationIsPlaying` and `MRMediaRemoteSendCommand`. Since macOS 15.4 it answers only Apple's own processes, and projects that still read it load it inside `/usr/bin/perl`, which Apple signs. Without the playing state the rule cannot hold, and a blind pause and play would start a paused player, so the setting does nothing on macOS for now. This is hard, not impossible: a small host that Apple signs (the perl route) or a check on a real Mac that shows the calls still answer a third-party process would open it.

## The check

- `cargo test`: the rule on a fake player list ([media.rs](../../native/akou-capture/src/dictate/media.rs)) and through the protocol ([session.rs](../../native/akou-capture/src/dictate/session.rs)), with the setting off as the control; on Linux, the MPRIS backend against fake players served on a private `dbus-daemon` the test starts itself, including a player that quit and came back paused under the same name, which must not be played.
- The `capture-linux` jobs in [ci.yml](../../.github/workflows/ci.yml), on both sound servers: two fake MPRIS players on the job's session bus, one playing and one paused, and the shipping helper running sessions through `session.start` and `session.stop`. With `pause_media` on, the playing one receives `Pause` while the session listens and `Play` after it; `stop` in the middle of a session gives it back too; the paused one receives nothing. The same session without `pause_media` touches neither player.

## Still open

- **Windows with a real player.** The backend is built and wired but has not run against a player on a desktop. The check needs a media session on the CI runner, such as the Media Player or a browser playing to the virtual cable of the `capture-windows` job.
- **macOS**, as above.
- **The app side.** Sending `pause_media` after `ready` and on a change of `dictation.muteMedia`, and the page saying the setting does nothing on macOS.
