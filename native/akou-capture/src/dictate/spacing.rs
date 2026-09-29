//! Spacing and case from the text around the cursor (docs/ux/DICTATION.md DC-S4).
//!
//! The helper reads the focused field just before the insert (the same read as DC-L2, behind the
//! same `dictation.readField`) and adjusts the text it is about to put in: a space before it when
//! the character before the cursor is not whitespace or an opening mark, a space after it when
//! the next character is a letter or a digit, and the first word lower-cased when the text before
//! the cursor stops mid-sentence. The field's text never leaves the helper; only the adjusted
//! dictation goes in. Where the field cannot be read (the setting off, no grant, a terminal, a
//! password field, a dormant tree), the only rule is `dictation.trailingSpace`: one space at the
//! end.

/// What the helper read around the cursor: the text before it (the last characters are enough)
/// and the character right after it, none at the end of the field.
#[derive(Clone, Copy, Debug)]
pub struct Around<'a> {
    pub before: &'a str,
    pub after: Option<char>,
}

/// Marks after which the dictation starts with no space.
const OPENING: &[char] = &['(', '[', '{', '¿', '¡', '“', '‘', '«', '„', '/', '@', '#'];
/// Marks a dictation may start with that take no space before them.
const CLOSING: &[char] = &[
    '.', ',', ';', ':', '!', '?', ')', ']', '}', '…', '%', '»', '”', '’',
];
/// Marks after which the text before the cursor still reads mid-sentence.
const MID: &[char] = &[',', ';', ':', '-', '–', '—'];

/// The text to insert. `around` is what was read, or `None` where the field could not be read.
pub fn apply(around: Option<Around<'_>>, text: &str, trailing: bool) -> String {
    if text.trim().is_empty() {
        return text.to_string();
    }
    let Some(a) = around else {
        return if trailing && !text.ends_with(char::is_whitespace) {
            format!("{text} ")
        } else {
            text.to_string()
        };
    };
    let mut out = String::with_capacity(text.len() + 2);
    if lead(a.before, text) {
        out.push(' ');
    }
    if mid_sentence(a.before) {
        out.push_str(&lower_first_word(text));
    } else {
        out.push_str(text);
    }
    if a.after.is_some_and(char::is_alphanumeric) && !text.ends_with(char::is_whitespace) {
        out.push(' ');
    }
    out
}

/// A space goes before the text: something other than whitespace or an opening mark sits right
/// before the cursor, and the text does not open with whitespace or a closing mark.
fn lead(before: &str, text: &str) -> bool {
    let Some(last) = before.chars().last() else {
        return false;
    };
    if last.is_whitespace() || OPENING.contains(&last) || opening_quote(before) {
        return false;
    }
    let first = text.chars().next();
    !first.is_some_and(|c| c.is_whitespace() || CLOSING.contains(&c))
}

/// A straight quote right before the cursor opens a quotation when nothing but whitespace (or
/// the start of the field) comes before it.
fn opening_quote(before: &str) -> bool {
    let mut back = before.chars().rev();
    matches!(back.next(), Some('"' | '\''))
        && back
            .next()
            .is_none_or(|c| c.is_whitespace() || OPENING.contains(&c))
}

/// The text before the cursor stops mid-sentence: on the same line, its last mark is a letter, a
/// digit or a comma-like mark.
fn mid_sentence(before: &str) -> bool {
    let t = before.trim_end_matches([' ', '\t', '\u{a0}']);
    t.chars()
        .last()
        .is_some_and(|c| c.is_alphanumeric() || MID.contains(&c))
}

/// The first word in lower case when it is a capitalised plain word (`Maybe`, `Luego`), so an
/// engine's sentence-start capital goes. `I`, acronyms (`NASA`) and mixed case (`iPhone`,
/// `McDonald`) keep theirs.
fn lower_first_word(text: &str) -> String {
    let lead_ws = text.len() - text.trim_start().len();
    let rest = &text[lead_ws..];
    let end = rest
        .char_indices()
        .find(|&(_, c)| !c.is_alphabetic())
        .map_or(rest.len(), |(i, _)| i);
    let word = &rest[..end];
    let mut cs = word.chars();
    let title = cs.next().is_some_and(char::is_uppercase)
        && word.chars().count() >= 2
        && cs.all(char::is_lowercase);
    if !title {
        return text.to_string();
    }
    format!(
        "{}{}{}",
        &text[..lead_ws],
        word.to_lowercase(),
        &rest[end..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(before: &str, after: Option<char>, text: &str) -> String {
        apply(Some(Around { before, after }), text, false)
    }

    /// DC-S4: the table of (before the cursor, after it, dictated) and what goes in.
    #[test]
    fn dc_s4_spacing_and_case_follow_the_text_around_the_cursor() {
        let table: &[(&str, Option<char>, &str, &str)] = &[
            // An empty field: the text as it came.
            ("", None, "Hello there.", "Hello there."),
            // After a word mid-sentence: a space before, and the engine's capital goes.
            ("I think", None, "Maybe later.", " maybe later."),
            // After a sentence: a space, the capital stays.
            ("Done.", None, "Next step.", " Next step."),
            ("Really?", None, "Yes.", " Yes."),
            // After whitespace: no second space.
            ("Hello ", None, "World", "world"),
            ("Line one.\n", None, "Line two.", "Line two."),
            // After an opening mark: no space, and nothing to lower-case after `(`.
            ("see (", Some(')'), "Appendix", "Appendix"),
            ("¿", Some('?'), "Vienes", "Vienes"),
            // A straight quote opening a quotation, then one closing it.
            ("he said \"", None, "Hi", "Hi"),
            ("he said \"hi\"", None, "Then left", " Then left"),
            // Before a letter: a space after.
            ("", Some('w'), "Hello", "Hello "),
            ("Hi ", Some('t'), "There", "there "),
            ("Price", Some('5'), "Is", " is "),
            // Before whitespace or a mark: nothing after.
            ("", Some(' '), "Hello", "Hello"),
            ("", Some('.'), "Hello", "Hello"),
            // A dictation opening with a closing mark joins the word before.
            ("Hello", None, ", world", ", world"),
            // After a comma: mid-sentence.
            ("Yes,", None, "Of course", " of course"),
            ("Sí,", None, "Claro que sí", " claro que sí"),
            // `I`, acronyms and mixed case keep their case.
            ("and", None, "I agree", " I agree"),
            ("and", None, "I'm in", " I'm in"),
            ("ask", None, "NASA", " NASA"),
            ("buy an", None, "IPhone", " IPhone"),
            ("with", None, "McDonald", " McDonald"),
            // Text that is only whitespace goes in untouched.
            ("word", Some('x'), " ", " "),
        ];
        for &(before, after, text, want) in table {
            assert_eq!(
                read(before, after, text),
                want,
                "{before:?} {after:?} {text:?}"
            );
        }
    }

    /// DC-S4: with the surroundings unknown, only the trailing space rule fires, and only when
    /// asked; the text is never lower-cased or led by a space.
    #[test]
    fn dc_s4_unknown_surroundings_get_only_the_trailing_space() {
        assert_eq!(apply(None, "Maybe later.", false), "Maybe later.");
        assert_eq!(apply(None, "Maybe later.", true), "Maybe later. ");
        assert_eq!(apply(None, "Ends with space ", true), "Ends with space ");
        // Known surroundings ignore the trailing rule: the next character decides.
        assert_eq!(
            apply(
                Some(Around {
                    before: "",
                    after: None
                }),
                "Hi",
                true
            ),
            "Hi"
        );
    }
}
