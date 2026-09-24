//! Excluding akou's own audio (DESIGN 2.3) and choosing the processes of per-app capture.
//!
//! Excluding the app's own process id excludes nothing on macOS: a WebKit app plays audio from a
//! separate helper process ("<App> Graphics and Media", bundle `com.apple.WebKit.GPU`), and a
//! process that plays nothing has no Core Audio process object at all. So the helper resolves, at
//! every start and every rebuild, each Core Audio process whose *responsible* process is akou's.
//!
//! `--exclude-responsible` names akou by bundle id or pid. The app spawns the helper, so the
//! helper's own responsible process is the app too; with a bundle id, that pid and every audio
//! process carrying the bundle id count as akou.
//!
//! The selection is pure and tested here; reading the process list is in `mod.rs`.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioProc {
    /// The Core Audio process object.
    pub object: u32,
    pub pid: i32,
    pub bundle: String,
    /// The process macOS holds responsible for this one (itself when none).
    pub responsible: i32,
}

impl AudioProc {
    /// How the process is named in `capturing.exclude` and in health lines.
    pub fn label(&self) -> String {
        if self.bundle.is_empty() {
            format!("pid {}", self.pid)
        } else {
            format!("{} (pid {})", self.bundle, self.pid)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Pid(i32),
    Bundle(String),
}

pub fn parse_target(s: &str) -> Target {
    match s.parse::<i32>() {
        Ok(pid) if pid > 0 => Target::Pid(pid),
        _ => Target::Bundle(s.to_string()),
    }
}

/// The processes the global tap leaves out: this helper, and with a target every process that
/// is akou's or that akou is responsible for.
pub fn select_excluded<'a>(
    procs: &'a [AudioProc],
    target: Option<&Target>,
    own_pid: i32,
    own_responsible: i32,
) -> Vec<&'a AudioProc> {
    let mut roots: Vec<i32> = vec![];
    let mut bundle: Option<&str> = None;
    match target {
        Some(Target::Pid(p)) => roots.push(*p),
        Some(Target::Bundle(b)) => {
            bundle = Some(b.as_str());
            if own_responsible > 0 && own_responsible != own_pid {
                roots.push(own_responsible);
            }
            roots.extend(
                procs
                    .iter()
                    .filter(|p| p.bundle.eq_ignore_ascii_case(b))
                    .map(|p| p.pid),
            );
        }
        None => {}
    }
    procs
        .iter()
        .filter(|p| {
            p.pid == own_pid
                || roots.contains(&p.pid)
                || roots.contains(&p.responsible)
                || bundle.is_some_and(|b| p.bundle.eq_ignore_ascii_case(b))
        })
        .collect()
}

/// Per-app capture: processes whose bundle id is one of `ids` or one of their helpers
/// (`<id>.<anything>`), matched case-insensitively, plus every process such a match is
/// responsible for.
pub fn select_apps<'a>(procs: &'a [AudioProc], ids: &[String]) -> Vec<&'a AudioProc> {
    let matches = |b: &str| {
        let b = b.to_ascii_lowercase();
        ids.iter().any(|id| {
            let id = id.to_ascii_lowercase();
            b == id || b.starts_with(&format!("{id}."))
        })
    };
    let roots: Vec<i32> = procs
        .iter()
        .filter(|p| matches(&p.bundle))
        .map(|p| p.pid)
        .collect();
    procs
        .iter()
        .filter(|p| matches(&p.bundle) || roots.contains(&p.responsible))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(object: u32, pid: i32, bundle: &str, responsible: i32) -> AudioProc {
        AudioProc {
            object,
            pid,
            bundle: bundle.into(),
            responsible,
        }
    }

    /// The spike's finding: akou (pid 100, no audio object) plays through the WebKit GPU helper
    /// (pid 101) whose responsible process is akou. Safari's GPU helper has the same bundle id
    /// and must not be excluded.
    fn world() -> Vec<AudioProc> {
        vec![
            p(1, 101, "com.apple.WebKit.GPU", 100),
            p(2, 201, "com.apple.WebKit.GPU", 200),
            p(3, 300, "us.zoom.xos", 300),
            p(4, 301, "us.zoom.xos.ZoomAudioHelper", 300),
            p(5, 400, "com.spotify.client", 400),
        ]
    }

    #[test]
    fn spike_excluding_akou_by_bundle_excludes_its_webkit_gpu_helper_only() {
        let w = world();
        // The helper (pid 500) was spawned by akou (pid 100), so akou is its responsible process.
        let ex = select_excluded(&w, Some(&parse_target("io.github.geiserx.akou")), 500, 100);
        assert_eq!(ex.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![101]);
        let ex = select_excluded(&w, Some(&parse_target("100")), 500, 1);
        assert_eq!(ex.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![101]);
    }

    #[test]
    fn positive_control_matching_on_bundle_id_alone_would_exclude_safari_too() {
        let w = world();
        // Excluding by the GPU helper's bundle id is the wrong rule: it hits both WebKit apps.
        let ex = select_excluded(
            &w,
            Some(&Target::Bundle("com.apple.WebKit.GPU".into())),
            500,
            1,
        );
        assert_eq!(ex.len(), 2);
    }

    #[test]
    fn without_a_target_only_the_helper_itself_is_excluded() {
        let mut w = world();
        w.push(p(9, 500, "", 100));
        let ex = select_excluded(&w, None, 500, 100);
        assert_eq!(ex.iter().map(|p| p.pid).collect::<Vec<_>>(), vec![500]);
    }

    #[test]
    fn per_app_capture_takes_the_app_and_its_helpers_case_insensitively() {
        let w = world();
        let got = select_apps(&w, &["US.ZOOM.XOS".into()]);
        assert_eq!(
            got.iter().map(|p| p.pid).collect::<Vec<_>>(),
            vec![300, 301]
        );
        assert!(select_apps(&w, &["us.zoom".into()]).len() == 2);
        assert!(select_apps(&w, &["com.example.none".into()]).is_empty());
        assert_eq!(parse_target("0"), Target::Bundle("0".into()));
        assert_eq!(w[0].label(), "com.apple.WebKit.GPU (pid 101)");
    }
}
