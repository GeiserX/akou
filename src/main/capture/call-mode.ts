/**
 * What a call records as its call side: `system` (the whole computer), `none`, or
 * `app:<id>[,<id>]`. One parser for every door the value comes through (`capture.call` in the
 * config file, `akou config set`, `PATCH /config`, `POST /calls` `call`), with the same rule as
 * the helper's own (`CallMode::parse` in native/akou-capture/src/source.rs): nothing the helper
 * accepts is refused here, and nothing refused here reaches the helper to fail every start.
 */

export type CallMode = { kind: "system" } | { kind: "none" } | { kind: "apps"; ids: string[] };

export type ParsedCallMode = { ok: true; mode: CallMode } | { ok: false; why: string };

export function parseCallMode(s: string): ParsedCallMode {
  if (s === "system") return { ok: true, mode: { kind: "system" } };
  if (s === "none") return { ok: true, mode: { kind: "none" } };
  if (!s.startsWith("app:")) {
    return {
      ok: false,
      why: `must be system, none or app:<id>[,<id>], not ${JSON.stringify(s)}`,
    };
  }
  const ids = s
    .slice("app:".length)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  if (ids.length === 0) {
    return { ok: false, why: "app: needs at least one id, as in app:us.zoom.xos" };
  }
  return { ok: true, mode: { kind: "apps", ids } };
}
