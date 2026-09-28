//! The media players on Linux for DC-U8: MPRIS on the session bus.
//!
//! Every player that speaks MPRIS owns a name `org.mpris.MediaPlayer2.<player>` and serves
//! `org.mpris.MediaPlayer2.Player` at `/org/mpris/MediaPlayer2`, with a `PlaybackStatus` of
//! `Playing`, `Paused` or `Stopped` and the methods `Pause` and `Play`. A player is named here by
//! the unique connection that owns its name (`:1.42`), not by the name: a player that quits and
//! starts again gets a new connection, so akou never plays it again by mistake, and a call to a
//! connection that is gone fails instead of reaching someone else.
//!
//! Every call gives up after `CALL_MS`, so a player that hangs costs the media thread that long
//! and never the session.

use std::time::Duration;

use zbus::blocking::{Connection, Proxy, proxy::Builder};
use zbus::proxy::CacheProperties;

use super::media::{Players, Status};

const PREFIX: &str = "org.mpris.MediaPlayer2.";
const PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
pub const CALL_MS: u64 = 500;

pub struct Mpris {
    conn: Connection,
}

fn text(e: zbus::Error) -> String {
    e.to_string()
}

impl Mpris {
    /// The user's session bus (`DBUS_SESSION_BUS_ADDRESS`).
    pub fn session() -> Result<Mpris, String> {
        let b = zbus::blocking::connection::Builder::session().map_err(text)?;
        Self::build(b)
    }

    /// A bus at `address` (the tests' private bus).
    pub fn at(address: &str) -> Result<Mpris, String> {
        let b = zbus::blocking::connection::Builder::address(address).map_err(text)?;
        Self::build(b)
    }

    fn build(b: zbus::blocking::connection::Builder<'_>) -> Result<Mpris, String> {
        let conn = b
            .method_timeout(Duration::from_millis(CALL_MS))
            .build()
            .map_err(text)?;
        Ok(Mpris { conn })
    }

    fn proxy<'a>(
        &'a self,
        dest: &'a str,
        path: &'a str,
        iface: &'a str,
    ) -> Result<Proxy<'a>, String> {
        Builder::new(&self.conn)
            .destination(dest)
            .and_then(|b| b.path(path))
            .and_then(|b| b.interface(iface))
            .map(|b| b.cache_properties(CacheProperties::No))
            .and_then(|b| b.build())
            .map_err(text)
    }

    fn call(&self, id: &str, method: &str) -> Result<(), String> {
        self.proxy(id, PATH, PLAYER)?
            .call::<_, _, ()>(method, &())
            .map_err(text)
    }
}

impl Players for Mpris {
    fn list(&mut self) -> Result<Vec<(String, Status)>, String> {
        let bus = self.proxy(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
        )?;
        let names: Vec<String> = bus.call("ListNames", &()).map_err(text)?;
        let mut out = Vec::new();
        for name in names.iter().filter(|n| n.starts_with(PREFIX)) {
            // A player that left between the two calls is simply not listed.
            let Ok(owner) = bus.call::<_, _, String>("GetNameOwner", &(name.as_str(),)) else {
                continue;
            };
            let status = self
                .proxy(&owner, PATH, PLAYER)
                .and_then(|p| p.get_property::<String>("PlaybackStatus").map_err(text));
            let status = match status.as_deref() {
                Ok("Playing") => Status::Playing,
                Ok("Paused") => Status::Paused,
                _ => Status::Other,
            };
            if !out.iter().any(|(o, _)| *o == owner) {
                out.push((owner, status));
            }
        }
        Ok(out)
    }

    fn pause(&mut self, id: &str) -> Result<(), String> {
        self.call(id, "Pause")
    }

    fn play(&mut self, id: &str) -> Result<(), String> {
        self.call(id, "Play")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dictate::media::{Media, Pauser};
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Mutex};

    /// A private bus for one test, gone with it: `dbus-daemon`, the reference bus, which the
    /// tests start themselves, so the user's own session bus and players are never reached.
    struct Bus {
        child: Child,
        address: String,
    }

    impl Bus {
        fn start() -> Bus {
            let mut child = Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--nopidfile", "--print-address=1"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("dbus-daemon runs (the dbus package); the MPRIS tests need a bus");
            let mut address = String::new();
            BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap();
            Bus {
                child,
                address: address.trim().to_string(),
            }
        }
    }

    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// A player on the bus: its status, and every call it received.
    struct Fake {
        status: Arc<Mutex<String>>,
        calls: Arc<Mutex<Vec<String>>>,
    }

    #[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
    impl Fake {
        fn pause(&mut self) {
            self.calls.lock().unwrap().push("Pause".into());
            *self.status.lock().unwrap() = "Paused".into();
        }
        fn play(&mut self) {
            self.calls.lock().unwrap().push("Play".into());
            *self.status.lock().unwrap() = "Playing".into();
        }
        #[zbus(property)]
        fn playback_status(&self) -> String {
            self.status.lock().unwrap().clone()
        }
    }

    type Log = Arc<Mutex<Vec<String>>>;

    fn player(bus: &Bus, name: &str, status: &str) -> (Connection, Log) {
        let calls: Log = Arc::default();
        let fake = Fake {
            status: Arc::new(Mutex::new(status.into())),
            calls: calls.clone(),
        };
        let conn = zbus::blocking::connection::Builder::address(bus.address.as_str())
            .unwrap()
            .name(format!("{PREFIX}{name}"))
            .unwrap()
            .serve_at(PATH, fake)
            .unwrap()
            .build()
            .unwrap();
        (conn, calls)
    }

    /// DC-U8 on a real bus: a playing player gets `Pause` and then `Play`; a paused one gets
    /// nothing; a name that is not a player is never listed. The listing sees each player once.
    #[test]
    fn dc_u8_mpris_pauses_the_playing_player_and_gives_back_only_it() {
        let bus = Bus::start();
        let (_a, music) = player(&bus, "music", "Playing");
        let (_b, podcast) = player(&bus, "podcast", "Paused");
        let _other = zbus::blocking::connection::Builder::address(bus.address.as_str())
            .unwrap()
            .name("org.example.NotAPlayer")
            .unwrap()
            .build()
            .unwrap();
        let mut m = Mpris::at(&bus.address).unwrap();
        let mut list = m.list().unwrap();
        list.sort_by_key(|(_, s)| *s as u8);
        assert_eq!(
            list.iter().map(|(_, s)| *s).collect::<Vec<_>>(),
            [Status::Playing, Status::Paused],
            "{list:?}"
        );
        assert!(list.iter().all(|(id, _)| id.starts_with(':')), "{list:?}");

        let mut p = Pauser::new(Box::new(m));
        p.pause();
        assert_eq!(*music.lock().unwrap(), ["Pause"]);
        p.resume();
        assert_eq!(*music.lock().unwrap(), ["Pause", "Play"]);
        assert!(
            podcast.lock().unwrap().is_empty(),
            "the paused player was started"
        );
    }

    /// A player that quits while paused is not played, and one that took its name meanwhile is
    /// not akou's: it is left alone.
    #[test]
    fn dc_u8_a_player_that_quit_and_came_back_is_not_played() {
        let bus = Bus::start();
        let (a, music) = player(&bus, "music", "Playing");
        let mut p = Pauser::new(Box::new(Mpris::at(&bus.address).unwrap()));
        p.pause();
        assert_eq!(*music.lock().unwrap(), ["Pause"]);
        a.release_name(format!("{PREFIX}music")).unwrap();
        drop(a);
        let (_again, again) = player(&bus, "music", "Paused");
        p.resume();
        assert!(
            again.lock().unwrap().is_empty(),
            "{:?}",
            again.lock().unwrap()
        );
    }
}
