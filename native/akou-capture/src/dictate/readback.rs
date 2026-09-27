//! Learning from edits in the app's own field (docs/ux/DICTATION.md DC-L2), the helper's half.
//!
//! After an insert lands, the worker reads the focused field once (the snapshot) and finds the
//! pasted text in it, keeping up to `ANCHOR` characters on each side as anchors. It reads again
//! on the first of: a commit key reaching the app (Return, keypad Enter, Tab), the target losing
//! the keyboard once `GRACE_MS` have passed, or `WINDOW_MS` after the snapshot. Between the two
//! anchors is the pasted text as the user left it; a word diff against what was inserted gives
//! the hunks. Only the hunks leave the helper, in `edit {id, hunks}`: never the field's text,
//! never the words the user did not change.
//!
//! What is never read: a secure field or anything under Secure Input, a terminal, a field when
//! `read_field` is off or the Accessibility grant is missing. And nothing here writes to another
//! process: the `Targets` trait has no way to set an accessibility flag, so a Chromium or Electron
//! app whose tree is dormant reads as `Unreadable` and the dictation learns nothing from it
//! (`edit.unreadable`).
//!
//! Every read runs on the worker thread, never on the tap's (DC-N1), and the backend bounds each
//! one at 200 ms.

use super::protocol::Target;

/// Characters kept on each side of the pasted text to find it again.
pub const ANCHOR: usize = 16;
/// A focus change this soon after the snapshot is the paste settling, not the user leaving.
pub const GRACE_MS: u64 = 250;
/// How often the target is compared while watching.
pub const FOCUS_POLL_MS: u64 = 250;
/// The watch ends here if nothing else ended it.
pub const WINDOW_MS: u64 = 60_000;
/// Longer texts are not diffed (the diff is quadratic in words).
pub const MAX_WORDS: usize = 2_000;

const MS: u64 = 1_000_000;

/// One read of the focused field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Field {
    /// The value, and the caret as a character index.
    Text { value: String, caret: usize },
    /// A dormant tree, a read that timed out or failed.
    Unreadable,
}

/// One changed run of words: `inserted` (what akou inserted, from its word `at`) is `now` in
/// the field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub inserted: String,
    pub now: String,
    pub at: usize,
}

/// Why a watch ends with no hunks: `unreadable` (the field could not be read), `lost` (the
/// pasted text or its anchors are gone, or the field was cleared), `too-long`. The session adds
/// `not-read` where the rules above forbid the read.
pub type Reason = &'static str;

pub struct Watch {
    pub id: String,
    pub target: Target,
    inserted: String,
    before: String,
    after: String,
    /// Character index where the pasted text began at the snapshot.
    start: usize,
    snap_ns: u64,
    next_poll_ns: u64,
}

fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

impl Watch {
    /// The snapshot right after the insert settled. The pasted text normally ends at the caret;
    /// failing that, its last occurrence in the field.
    pub fn start(
        id: &str,
        inserted: &str,
        target: Target,
        field: Field,
        t_ns: u64,
    ) -> Result<Watch, Reason> {
        let Field::Text { value, caret } = field else {
            return Err("unreadable");
        };
        let v = chars(&value);
        let ins = chars(inserted);
        let n = ins.len();
        let at_caret = caret >= n && caret <= v.len() && v[caret - n..caret] == ins[..];
        let start = if at_caret {
            caret - n
        } else {
            let i = value.rfind(inserted).ok_or("lost")?;
            value[..i].chars().count()
        };
        let end = start + n;
        Ok(Watch {
            id: id.to_string(),
            target,
            inserted: inserted.to_string(),
            before: v[start.saturating_sub(ANCHOR)..start].iter().collect(),
            after: v[end..(end + ANCHOR).min(v.len())].iter().collect(),
            start,
            snap_ns: t_ns,
            next_poll_ns: t_ns + GRACE_MS * MS,
        })
    }

    /// Whether it is time to compare the target (a focus change ends the watch).
    pub fn poll_due(&mut self, t_ns: u64) -> bool {
        if t_ns < self.next_poll_ns {
            return false;
        }
        self.next_poll_ns = t_ns + FOCUS_POLL_MS * MS;
        true
    }

    pub fn expired(&self, t_ns: u64) -> bool {
        t_ns >= self.snap_ns + WINDOW_MS * MS
    }

    /// The second read: the hunks, possibly none (nothing was changed).
    pub fn finish(&self, field: Field) -> Result<Vec<Hunk>, Reason> {
        let Field::Text { value, .. } = field else {
            return Err("unreadable");
        };
        let edited = self.locate(&value).ok_or("lost")?;
        // An empty region is a field the app cleared (a chat after send), not a deleted
        // dictation: there is nothing to learn either way.
        if edited.trim().is_empty() {
            return Err("lost");
        }
        hunks(&self.inserted, &edited)
    }

    /// The text between the anchors, the `before` anchor taken at its occurrence nearest to
    /// where the paste began.
    fn locate(&self, value: &str) -> Option<String> {
        let v = chars(value);
        let before = chars(&self.before);
        let after = chars(&self.after);
        let from = if before.is_empty() {
            Some(0)
        } else {
            (0..=v.len().saturating_sub(before.len()))
                .filter(|&i| v[i..].starts_with(&before))
                .map(|i| i + before.len())
                .min_by_key(|&e| e.abs_diff(self.start))
        }?;
        let to = if after.is_empty() {
            v.len()
        } else {
            (from..=v.len().saturating_sub(after.len())).find(|&i| v[i..].starts_with(&after))?
        };
        Some(v[from..to].iter().collect())
    }
}

/// Word-level diff (longest common subsequence) of what was inserted against what is there now;
/// each run of changed words is one hunk. Words added before the first inserted word or after
/// the last one are not a correction but the user typing on (at the end of a chat box there is
/// no anchor after the paste, so that is everything typed until Enter): they never leave the
/// helper. A word added between two inserted words is a correction.
pub fn hunks(inserted: &str, edited: &str) -> Result<Vec<Hunk>, Reason> {
    let a: Vec<&str> = inserted.split_whitespace().collect();
    let b: Vec<&str> = edited.split_whitespace().collect();
    if a.len() > MAX_WORDS || b.len() > MAX_WORDS {
        return Err("too-long");
    }
    // lcs[i][j]: the common length of a[i..] and b[j..].
    let w = b.len() + 1;
    let mut lcs = vec![0u16; (a.len() + 1) * w];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i * w + j] = if a[i] == b[j] {
                lcs[(i + 1) * w + j + 1] + 1
            } else {
                lcs[(i + 1) * w + j].max(lcs[i * w + j + 1])
            };
        }
    }
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    let mut open: Option<(usize, Vec<&str>, Vec<&str>)> = None;
    let mut close = |open: &mut Option<(usize, Vec<&str>, Vec<&str>)>| {
        if let Some((at, inserted, now)) = open.take() {
            out.push(Hunk {
                inserted: inserted.join(" "),
                now: now.join(" "),
                at,
            });
        }
    };
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            close(&mut open);
            i += 1;
            j += 1;
        } else if j < b.len() && (i == a.len() || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j]) {
            open.get_or_insert((i, Vec::new(), Vec::new())).2.push(b[j]);
            j += 1;
        } else {
            open.get_or_insert((i, Vec::new(), Vec::new())).1.push(a[i]);
            i += 1;
        }
    }
    close(&mut open);
    out.retain(|h| !(h.inserted.is_empty() && (h.at == 0 || h.at == a.len())));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str, caret: usize) -> Field {
        Field::Text {
            value: value.into(),
            caret,
        }
    }

    fn hunk(at: usize, inserted: &str, now: &str) -> Hunk {
        Hunk {
            inserted: inserted.into(),
            now: now.into(),
            at,
        }
    }

    #[test]
    fn hunks_are_the_changed_runs_only() {
        assert_eq!(
            hunks("tell the cooper netties team", "tell the Kubernetes team").unwrap(),
            vec![hunk(2, "cooper netties", "Kubernetes")]
        );
        assert_eq!(hunks("a b c", "a b c").unwrap(), vec![]);
        assert_eq!(
            hunks("ping me at noon", "ping me at noon today").unwrap(),
            vec![],
            "typed on after the dictation"
        );
        assert_eq!(
            hunks("ping me at noon", "Dear all, ping me at noon").unwrap(),
            vec![],
            "typed before it"
        );
        assert_eq!(
            hunks("ping me at noon", "ping me today at noon").unwrap(),
            vec![hunk(2, "", "today")],
            "a word added inside the dictation is a correction"
        );
        assert_eq!(
            hunks("one two three four", "one 2 three for").unwrap(),
            vec![hunk(1, "two", "2"), hunk(3, "four", "for")]
        );
        let long = "w ".repeat(MAX_WORDS + 1);
        assert_eq!(hunks(&long, "w"), Err("too-long"));
    }

    /// The pasted text is found at the caret with its anchors, and found again after edits
    /// around it and inside it; text outside the anchors never reaches the hunks.
    #[test]
    fn the_pasted_text_is_found_again_between_its_anchors() {
        let field = "Hi team, the cooper netties rollout is on Thursday. See you";
        let caret = "Hi team, the cooper netties rollout".chars().count();
        let w = Watch::start(
            "1",
            "cooper netties rollout",
            Target::default(),
            text(field, caret),
            0,
        )
        .unwrap();
        let later = "Hello all, the Kubernetes rollout is on Thursday. See you";
        assert_eq!(
            w.finish(text(later, 0)),
            Err("lost"),
            "the anchor before it was rewritten"
        );
        let later = "Hi team, the Kubernetes rollout is on Thursday. See you soon";
        assert_eq!(
            w.finish(text(later, 0)).unwrap(),
            vec![hunk(0, "cooper netties", "Kubernetes")]
        );
        assert_eq!(w.finish(Field::Unreadable), Err("unreadable"));
        assert_eq!(w.finish(text("", 0)), Err("lost"), "a cleared field");
    }

    /// Not at the caret (an app that moved the caret after the paste): its last occurrence.
    #[test]
    fn a_paste_not_at_the_caret_is_found_by_its_text() {
        let w = Watch::start(
            "1",
            "héllo",
            Target::default(),
            text("héllo héllo end", 0),
            0,
        )
        .unwrap();
        assert_eq!(
            w.finish(text("héllo hello end", 0)).unwrap(),
            vec![hunk(0, "héllo", "hello")]
        );
        assert_eq!(
            Watch::start("1", "gone", Target::default(), text("nothing", 3), 0).err(),
            Some("lost")
        );
        assert_eq!(
            Watch::start("1", "x", Target::default(), Field::Unreadable, 0).err(),
            Some("unreadable")
        );
    }

    #[test]
    fn the_watch_polls_after_the_grace_and_expires_after_the_window() {
        let mut w = Watch::start("1", "a", Target::default(), text("a", 1), 0).unwrap();
        assert!(!w.poll_due(100 * MS));
        assert!(w.poll_due(GRACE_MS * MS));
        assert!(!w.poll_due((GRACE_MS + 10) * MS));
        assert!(!w.expired((WINDOW_MS - 1) * MS));
        assert!(w.expired(WINDOW_MS * MS));
    }
}
