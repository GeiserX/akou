//! A small JSON writer for the stderr lines. The protocol needs objects, strings, numbers and
//! arrays of strings, always on one line; a serializer crate would be more code than this.

use std::fmt::Write as _;

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// Written with Rust's shortest round-trip formatting: `12.0` as `12`, `-20.5` as `-20.5`.
    /// A non-finite value is written as `null`, because JSON has no such number.
    Num(f64),
    Int(i64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(&'static str, Json)>),
}

impl Json {
    pub fn str(s: impl Into<String>) -> Json {
        Json::Str(s.into())
    }

    pub fn obj(fields: Vec<(&'static str, Json)>) -> Json {
        Json::Obj(fields)
    }

    pub fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Num(n) => {
                if n.is_finite() {
                    // `{}` on f64 prints `-0` for negative zero; JSON accepts it, but 0 reads better.
                    let v = if *n == 0.0 { 0.0 } else { *n };
                    let _ = write!(out, "{v}");
                } else {
                    out.push_str("null");
                }
            }
            Json::Int(i) => {
                let _ = write!(out, "{i}");
            }
            Json::Str(s) => write_str(s, out),
            Json::Arr(items) => {
                out.push('[');
                for (i, it) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    it.write(out);
                }
                out.push(']');
            }
            Json::Obj(fields) => {
                out.push('{');
                for (i, (k, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_str(k, out);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }

    pub fn to_line(&self) -> String {
        let mut s = String::new();
        self.write(&mut s);
        s
    }
}

fn write_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_strings_and_nesting() {
        let j = Json::obj(vec![
            ("a", Json::Num(12.0)),
            ("b", Json::Num(-20.5)),
            ("c", Json::Num(f64::NAN)),
            ("d", Json::str("q\"\\\n\u{1}")),
            (
                "e",
                Json::Arr(vec![Json::str("x"), Json::Null, Json::Bool(true)]),
            ),
            ("f", Json::Int(-3)),
            ("g", Json::Num(-0.0)),
        ]);
        assert_eq!(
            j.to_line(),
            r#"{"a":12,"b":-20.5,"c":null,"d":"q\"\\\n\u0001","e":["x",null,true],"f":-3,"g":0}"#
        );
    }
}
