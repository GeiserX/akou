//! The media players on Windows for DC-U8: the system media transport controls.
//!
//! Every app that shows in the volume flyout's media controls (browsers, Spotify, the Media
//! Player) has a session in `GlobalSystemMediaTransportControlsSessionManager`, with its playback
//! status and `TryPauseAsync` / `TryPlayAsync`. This is the player list the spec's "Windows media
//! keys" needs: a media key toggles and cannot tell what plays, so it could start a paused player.
//!
//! Windows gives a session no id of its own, so a player is named by its app
//! (`SourceAppUserModelId`) and its place among that app's sessions (`app#0`, `app#1`). An app
//! that quit and came back while akou held it paused would be played again, and so would the
//! wrong one of two sessions if the app closed one of them during the dictation.

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Playback,
};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

use super::media::{Players, Status};

pub struct Smtc {
    manager: Manager,
}

fn text(e: windows::core::Error) -> String {
    e.message()
}

impl Smtc {
    /// Runs on the media thread, which it joins to the multithreaded apartment first.
    pub fn new() -> Result<Smtc, String> {
        // SAFETY: once, on the media thread, before any WinRT call on it.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let manager = Manager::RequestAsync()
            .and_then(|op| op.join())
            .map_err(text)?;
        Ok(Smtc { manager })
    }

    /// Every session, named `app#n`, with its status.
    fn sessions(&self) -> Result<Vec<(String, Session, Status)>, String> {
        let list = self.manager.GetSessions().map_err(text)?;
        let mut out: Vec<(String, Session, Status)> = Vec::new();
        for i in 0..list.Size().map_err(text)? {
            let s = list.GetAt(i).map_err(text)?;
            let Ok(app) = s.SourceAppUserModelId() else {
                continue;
            };
            let app = app.to_string();
            let n = out
                .iter()
                .filter(|(id, _, _)| id.rsplit_once('#').is_some_and(|(a, _)| a == app))
                .count();
            let status = match s.GetPlaybackInfo().and_then(|p| p.PlaybackStatus()) {
                Ok(p) if p == Playback::Playing => Status::Playing,
                Ok(p) if p == Playback::Paused => Status::Paused,
                Ok(_) => Status::Other,
                Err(_) => Status::Unknown,
            };
            out.push((format!("{app}#{n}"), s, status));
        }
        Ok(out)
    }

    fn call(&self, id: &str, pause: bool) -> Result<(), String> {
        let Some((_, s, _)) = self.sessions()?.into_iter().find(|(i, _, _)| i == id) else {
            return Err(format!("{id} is gone"));
        };
        let done = if pause {
            s.TryPauseAsync().and_then(|op| op.join())
        } else {
            s.TryPlayAsync().and_then(|op| op.join())
        };
        if done.map_err(text)? {
            Ok(())
        } else {
            Err(format!("{id} refused"))
        }
    }
}

impl Players for Smtc {
    fn list(&mut self) -> Result<Vec<(String, Status)>, String> {
        Ok(self
            .sessions()?
            .into_iter()
            .map(|(id, _, status)| (id, status))
            .collect())
    }

    fn pause(&mut self, id: &str) -> Result<(), String> {
        self.call(id, true)
    }

    fn play(&mut self, id: &str) -> Result<(), String> {
        self.call(id, false)
    }
}
