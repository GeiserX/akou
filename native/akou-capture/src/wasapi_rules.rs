//! What the Windows front end decides before it calls WASAPI (DESIGN 2.2 and 2.3), as pure
//! functions, so every OS runs their tests.
//!
//! - The call side is process loopback in exclude mode on akou's process tree from build 20348
//!   on, and loopback of the default render device before it. Endpoint loopback cannot exclude
//!   anything, so the part says so with a warning instead of passing off akou's own sounds as
//!   the call.
//! - The app passes its own process id with `--exclude-responsible`; the tree under it holds the
//!   WebView2 processes that play the window's audio, and this helper.
//! - `--call app:<id>` takes a process id or an executable name and captures that process tree
//!   in include mode. It needs process loopback, so it refuses older builds.

use crate::source::{CallMode, OpenError};

/// The first Windows build with `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`.
pub const PROCESS_LOOPBACK_BUILD: u32 = 20_348;

/// One running process, from a process snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    /// The executable's file name, `akou.exe`.
    pub exe: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallSource {
    /// Everything the computer plays except this process and its descendants.
    ExcludeTree(u32),
    /// Only this process and its descendants.
    IncludeTree(u32),
    /// The default render device's loopback: everything, akou's own sounds included.
    Endpoint,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallPlan {
    pub source: CallSource,
    /// What the call side leaves out, for `capturing.exclude`.
    pub exclude: Vec<String>,
    /// The processes of a per-app capture; when every one has exited, the app is told.
    pub tapped: Vec<u32>,
    /// Said once as `warn {code: exclude-unavailable}`.
    pub warn: Option<String>,
}

/// The process whose tree the call side leaves out: the id the app passed, or this helper when
/// it passed none (or something that is not a process id, such as a macOS bundle id).
pub fn exclude_root(arg: Option<&str>, own: u32) -> u32 {
    arg.and_then(|a| a.trim().parse::<u32>().ok())
        .filter(|p| *p != 0)
        .unwrap_or(own)
}

/// `root` and every process below it. A parent id can outlive its process and be reused, so a
/// process is visited once, whatever the snapshot claims.
pub fn tree(procs: &[Proc], root: u32) -> Vec<&Proc> {
    let mut out: Vec<&Proc> = procs.iter().filter(|p| p.pid == root).collect();
    let mut seen: Vec<u32> = vec![root];
    let mut i = 0;
    while i < seen.len() {
        let parent = seen[i];
        for p in procs {
            if p.parent == parent && p.pid != parent && !seen.contains(&p.pid) {
                seen.push(p.pid);
                out.push(p);
            }
        }
        i += 1;
    }
    out
}

/// A process matches an app id when the id is its process id, or its executable name with or
/// without `.exe`, in any case.
pub fn matches(p: &Proc, id: &str) -> bool {
    let id = id.trim();
    if let Ok(pid) = id.parse::<u32>() {
        return p.pid == pid;
    }
    let exe = p.exe.to_ascii_lowercase();
    let id = id.to_ascii_lowercase();
    exe == id || exe.strip_suffix(".exe") == Some(id.as_str())
}

fn names(procs: &[&Proc]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for p in procs {
        if !out.iter().any(|n| n.eq_ignore_ascii_case(&p.exe)) {
            out.push(p.exe.clone());
        }
    }
    out
}

/// The endpoint-loopback plan, with the warning that says what it cannot do.
pub fn endpoint_plan(why: &str) -> CallPlan {
    CallPlan {
        source: CallSource::Endpoint,
        exclude: vec![],
        tapped: vec![],
        warn: Some(format!(
            "{why}; the call side records the default output as a whole, akou's own sounds included"
        )),
    }
}

/// How to open the call side on Windows build `build`.
pub fn plan(
    build: u32,
    mode: &CallMode,
    exclude_arg: Option<&str>,
    own_pid: u32,
    procs: &[Proc],
) -> Result<CallPlan, OpenError> {
    let loopback = build >= PROCESS_LOOPBACK_BUILD;
    match mode {
        CallMode::None => Err(OpenError::unavailable("the call side is off")),
        CallMode::System if !loopback => Ok(endpoint_plan(&format!(
            "Windows build {build} has no process loopback (it arrived in build {PROCESS_LOOPBACK_BUILD})"
        ))),
        CallMode::System => {
            let root = exclude_root(exclude_arg, own_pid);
            let t = tree(procs, root);
            let mut exclude = names(&t);
            if exclude.is_empty() {
                exclude.push(format!("process {root}"));
            }
            Ok(CallPlan {
                source: CallSource::ExcludeTree(root),
                exclude,
                tapped: vec![],
                warn: None,
            })
        }
        CallMode::Apps(ids) => {
            if !loopback {
                return Err(OpenError::unavailable(format!(
                    "capturing one app needs Windows build {PROCESS_LOOPBACK_BUILD} or newer; this is build {build}"
                )));
            }
            let matched: Vec<&Proc> = procs
                .iter()
                .filter(|p| ids.iter().any(|id| matches(p, id)))
                .collect();
            // The top of each matched tree: a match whose parent is not itself a match.
            let roots: Vec<&Proc> = matched
                .iter()
                .copied()
                .filter(|p| !matched.iter().any(|q| q.pid == p.parent && q.pid != p.pid))
                .collect();
            let Some(root) = roots.first() else {
                return Err(OpenError::no_device(format!(
                    "no running app matches {}",
                    ids.join(", ")
                )));
            };
            let warn = (roots.len() > 1).then(|| {
                format!(
                    "{} separate processes match {}; capturing {} (process {}) and the processes it started",
                    roots.len(),
                    ids.join(", "),
                    root.exe,
                    root.pid
                )
            });
            Ok(CallPlan {
                source: CallSource::IncludeTree(root.pid),
                exclude: vec![],
                tapped: tree(procs, root.pid).iter().map(|p| p.pid).collect(),
                warn,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, parent: u32, exe: &str) -> Proc {
        Proc {
            pid,
            parent,
            exe: exe.into(),
        }
    }

    /// The app, its two WebView2 processes and this helper under it; a player elsewhere.
    fn snapshot() -> Vec<Proc> {
        vec![
            p(4, 0, "System"),
            p(100, 4, "explorer.exe"),
            p(200, 100, "akou.exe"),
            p(210, 200, "msedgewebview2.exe"),
            p(211, 210, "msedgewebview2.exe"),
            p(220, 200, "akou-capture.exe"),
            p(300, 100, "ms-teams.exe"),
            p(310, 300, "msedgewebview2.exe"),
        ]
    }

    /// TRAPS "Own audio in the call channel": the whole app tree is left out (the WebView2
    /// processes play the window's audio), not only the helper that records.
    #[test]
    fn own_audio_the_call_side_excludes_the_app_tree_the_app_names() {
        let procs = snapshot();
        let plan = plan(26_100, &CallMode::System, Some("200"), 220, &procs).unwrap();
        assert_eq!(plan.source, CallSource::ExcludeTree(200));
        assert_eq!(
            plan.exclude,
            vec!["akou.exe", "msedgewebview2.exe", "akou-capture.exe"]
        );
        assert_eq!(plan.warn, None);
        // Positive control: the same rule over the helper's own id leaves the window's audio in.
        let own = super::plan(26_100, &CallMode::System, None, 220, &procs).unwrap();
        assert_eq!(own.source, CallSource::ExcludeTree(220));
        assert!(!own.exclude.iter().any(|n| n == "msedgewebview2.exe"));
    }

    #[test]
    fn before_build_20348_the_call_side_is_endpoint_loopback_and_says_it_cannot_exclude() {
        let plan = plan(19_045, &CallMode::System, Some("200"), 220, &snapshot()).unwrap();
        assert_eq!(plan.source, CallSource::Endpoint);
        assert!(plan.exclude.is_empty());
        assert!(plan.warn.unwrap().contains("19045"));
        // The boundary itself has process loopback.
        let at = super::plan(20_348, &CallMode::System, Some("200"), 220, &snapshot()).unwrap();
        assert_eq!(at.source, CallSource::ExcludeTree(200));
    }

    #[test]
    fn a_bundle_id_or_nothing_excludes_the_helper_itself() {
        assert_eq!(exclude_root(Some("io.github.geiserx.akou"), 7), 7);
        assert_eq!(exclude_root(None, 7), 7);
        assert_eq!(exclude_root(Some(" 42 "), 7), 42);
        assert_eq!(exclude_root(Some("0"), 7), 7);
    }

    #[test]
    fn one_app_is_its_tree_by_name_or_id_and_needs_process_loopback() {
        let procs = snapshot();
        let apps = CallMode::Apps(vec!["MS-Teams".into()]);
        let plan = plan(26_100, &apps, None, 220, &procs).unwrap();
        assert_eq!(plan.source, CallSource::IncludeTree(300));
        assert_eq!(plan.tapped, vec![300, 310]);
        let by_pid = super::plan(
            26_100,
            &CallMode::Apps(vec!["300".into()]),
            None,
            220,
            &procs,
        );
        assert_eq!(by_pid.unwrap().source, CallSource::IncludeTree(300));
        let e = super::plan(19_045, &apps, None, 220, &procs).unwrap_err();
        assert_eq!(e.exit, crate::protocol::exit::UNAVAILABLE);
        let e = super::plan(
            26_100,
            &CallMode::Apps(vec!["zoom".into()]),
            None,
            220,
            &procs,
        )
        .unwrap_err();
        assert_eq!(e.code, "no-device");
    }

    #[test]
    fn a_name_matching_a_parent_and_its_child_captures_the_parent_tree_once() {
        // msedgewebview2 matches under two apps: two roots, the first one is captured, and the
        // part is told the others were left out.
        let procs = snapshot();
        let plan = plan(
            26_100,
            &CallMode::Apps(vec!["msedgewebview2".into()]),
            None,
            220,
            &procs,
        )
        .unwrap();
        assert_eq!(plan.source, CallSource::IncludeTree(210));
        assert_eq!(plan.tapped, vec![210, 211]);
        assert!(plan.warn.unwrap().starts_with("2 separate processes"));
    }

    #[test]
    fn a_parent_id_that_points_back_into_the_tree_does_not_loop() {
        let procs = vec![p(1, 2, "a.exe"), p(2, 1, "b.exe")];
        let t: Vec<u32> = tree(&procs, 1).iter().map(|p| p.pid).collect();
        assert_eq!(t, vec![1, 2]);
    }
}
