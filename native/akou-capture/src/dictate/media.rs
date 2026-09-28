//! Pausing other audio while dictating (docs/ux/DICTATION.md DC-U8, `dictation.muteMedia`).
//!
//! When the app has turned it on (`pause_media {on: true}`), a session's start pauses every media
//! player the OS says is playing, and the session's end plays again only the players akou paused
//! that are still paused. A player that was already paused, or that the user paused, stopped or
//! played again meanwhile, is left as it is: akou never starts a player it did not stop (VoiceInk
//! #208 started a music app), and it never touches an output device's volume (VoiceInk #59 pushed
//! a headset to full). So it goes through the OS's player list, never a media key: a play/pause
//! key toggles, and pressed while nothing plays it starts the last player.
//!
//! The players per OS are behind `Players`: MPRIS on the session bus on Linux (`mpris`), the
//! system media transport controls on Windows (`win_media`). macOS has no public call that lists
//! other apps' players; it has no backend yet, and the setting does nothing there.
//!
//! A player's calls can be slow (a D-Bus peer that hangs, a WinRT call into another process), so
//! the real backends run on their own thread (`Worker`) and the session never waits on them. The
//! worker connects only at the first pause, so a helper whose app never turns the setting on never
//! reaches the session bus or the media service.

use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Playing,
    Paused,
    /// Stopped, or a state the OS names otherwise: never paused, never played.
    Other,
}

/// The OS's media players.
pub trait Players {
    /// Every player listed now, each with an id that names this instance of it (a player that
    /// quit and started again has a new id, so it is never played again by mistake).
    fn list(&mut self) -> Result<Vec<(String, Status)>, String>;
    fn pause(&mut self, id: &str) -> Result<(), String>;
    fn play(&mut self, id: &str) -> Result<(), String>;
}

/// What the session asks for. `pause` at a session's start, `resume` at its end.
pub trait Media {
    fn pause(&mut self);
    fn resume(&mut self);
    /// Waits, bounded, for the calls already asked for: the process is about to exit.
    fn finish(&mut self) {}
}

/// The rule itself, over any `Players`.
pub struct Pauser {
    players: Box<dyn Players>,
    /// The players akou paused and has not played again.
    ours: Vec<String>,
}

impl Pauser {
    pub fn new(players: Box<dyn Players>) -> Pauser {
        Pauser {
            players,
            ours: Vec::new(),
        }
    }
}

impl Media for Pauser {
    fn pause(&mut self) {
        let Ok(list) = self.players.list() else {
            return;
        };
        for (id, status) in list {
            if status == Status::Playing
                && !self.ours.contains(&id)
                && self.players.pause(&id).is_ok()
            {
                self.ours.push(id);
            }
        }
    }

    fn resume(&mut self) {
        let ours = std::mem::take(&mut self.ours);
        if ours.is_empty() {
            return;
        }
        let Ok(list) = self.players.list() else {
            return;
        };
        for (id, status) in list {
            if status == Status::Paused && ours.contains(&id) {
                let _ = self.players.play(&id);
            }
        }
    }
}

/// How long `finish` waits for the calls already asked for.
pub const FINISH_MS: u64 = 2_000;

/// A `Pauser` on its own thread, over players made there at the first pause.
pub struct Worker {
    tx: Option<Sender<bool>>,
    done: Receiver<()>,
}

impl Worker {
    /// `make` runs on the worker's thread at the first pause; `Err` leaves every call a no-op.
    pub fn spawn<F>(make: F) -> Worker
    where
        F: FnOnce() -> Result<Box<dyn Players>, String> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<bool>();
        let (done_tx, done) = mpsc::channel();
        std::thread::spawn(move || {
            let mut make = Some(make);
            let mut pauser: Option<Pauser> = None;
            for pause in rx {
                if pause && let Some(m) = make.take() {
                    pauser = m().ok().map(Pauser::new);
                }
                if let Some(p) = pauser.as_mut() {
                    if pause { p.pause() } else { p.resume() }
                }
            }
            let _ = done_tx.send(());
        });
        Worker { tx: Some(tx), done }
    }
}

impl Media for Worker {
    fn pause(&mut self) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(true);
        }
    }

    fn resume(&mut self) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(false);
        }
    }

    fn finish(&mut self) {
        if self.tx.take().is_some() {
            let _ = self.done.recv_timeout(Duration::from_millis(FINISH_MS));
        }
    }
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// The players with their status, and every call as `pause <id>` or `play <id>`.
    type State = (Vec<(String, Status)>, Vec<String>);

    /// Players in memory.
    #[derive(Clone, Default)]
    pub struct Board(pub Arc<Mutex<State>>);

    impl Board {
        pub fn with(players: &[(&str, Status)]) -> Board {
            let b = Board::default();
            b.0.lock().unwrap().0 = players.iter().map(|(i, s)| (i.to_string(), *s)).collect();
            b
        }
        pub fn set(&self, id: &str, status: Status) {
            let mut g = self.0.lock().unwrap();
            match g.0.iter_mut().find(|(i, _)| i == id) {
                Some(p) => p.1 = status,
                None => g.0.push((id.to_string(), status)),
            }
        }
        pub fn remove(&self, id: &str) {
            self.0.lock().unwrap().0.retain(|(i, _)| i != id);
        }
        pub fn calls(&self) -> Vec<String> {
            self.0.lock().unwrap().1.clone()
        }
        pub fn status(&self, id: &str) -> Option<Status> {
            let g = self.0.lock().unwrap();
            g.0.iter().find(|(i, _)| i == id).map(|p| p.1)
        }
    }

    impl Players for Board {
        fn list(&mut self) -> Result<Vec<(String, Status)>, String> {
            Ok(self.0.lock().unwrap().0.clone())
        }
        fn pause(&mut self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().1.push(format!("pause {id}"));
            self.set(id, Status::Paused);
            Ok(())
        }
        fn play(&mut self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().1.push(format!("play {id}"));
            self.set(id, Status::Playing);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::Board;
    use super::*;

    /// DC-U8: a session pauses what plays, and its end plays again only what akou paused; a
    /// player already paused is never started, and one stopped is never touched.
    #[test]
    fn dc_u8_the_end_plays_only_what_akou_paused() {
        let b = Board::with(&[
            ("music", Status::Playing),
            ("podcast", Status::Paused),
            ("video", Status::Other),
        ]);
        let mut m = Pauser::new(Box::new(b.clone()));
        m.pause();
        assert_eq!(b.calls(), ["pause music"]);
        m.resume();
        assert_eq!(b.calls(), ["pause music", "play music"]);
        assert_eq!(b.status("podcast"), Some(Status::Paused), "never started");
        // A resume with nothing paused by akou calls nothing, not even the list.
        m.resume();
        assert_eq!(b.calls().len(), 2);
    }

    /// What the user did while akou held a player wins: played again, stopped or quit, akou
    /// leaves it; a player that quit and came back under a new id is not akou's.
    #[test]
    fn dc_u8_a_player_the_user_changed_meanwhile_is_left_alone() {
        let b = Board::with(&[
            ("a", Status::Playing),
            ("b", Status::Playing),
            ("c", Status::Playing),
            ("d", Status::Playing),
        ]);
        let mut m = Pauser::new(Box::new(b.clone()));
        m.pause();
        b.set("a", Status::Playing);
        b.set("b", Status::Other);
        b.remove("c");
        b.set("d2", Status::Paused);
        m.resume();
        let plays: Vec<String> = b
            .calls()
            .into_iter()
            .filter(|c| c.starts_with("play"))
            .collect();
        assert_eq!(plays, ["play d"]);
    }

    /// Two pauses before a resume (a second session while the first's players are still held)
    /// pause each player once, and one resume gives them all back.
    #[test]
    fn dc_u8_a_second_pause_keeps_the_first_ones_players() {
        let b = Board::with(&[("a", Status::Playing)]);
        let mut m = Pauser::new(Box::new(b.clone()));
        m.pause();
        b.set("b", Status::Playing);
        m.pause();
        m.resume();
        assert_eq!(b.calls(), ["pause a", "pause b", "play a", "play b"]);
    }

    /// The worker makes its players only at the first pause, carries the calls out in order on
    /// its own thread, and `finish` waits for them.
    #[test]
    fn the_worker_connects_at_the_first_pause_and_keeps_the_order() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let b = Board::with(&[("a", Status::Playing)]);
        let worker = |made: std::sync::Arc<AtomicBool>| {
            let b = b.clone();
            Worker::spawn(move || {
                made.store(true, Ordering::SeqCst);
                Ok(Box::new(b) as Box<dyn Players>)
            })
        };
        let made = std::sync::Arc::new(AtomicBool::new(false));
        let mut w = worker(made.clone());
        w.resume();
        w.finish();
        assert!(
            !made.load(Ordering::SeqCst),
            "a resume alone never connects"
        );

        let mut w = worker(made.clone());
        w.pause();
        w.resume();
        w.finish();
        assert!(made.load(Ordering::SeqCst));
        assert_eq!(b.calls(), ["pause a", "play a"]);
    }

    /// Players that cannot be reached make every call a no-op.
    #[test]
    fn a_worker_whose_players_fail_does_nothing() {
        let mut w = Worker::spawn(|| Err("no session bus".into()));
        w.pause();
        w.resume();
        w.finish();
    }
}
