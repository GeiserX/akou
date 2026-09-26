/**
 * Facts about the app that its thin clients (the CLI, the MCP server) need without loading the
 * app itself: the version and the name of the file a running app announces itself in.
 */

/** The one version, stamped from `package.json` at release (DESIGN section 9). */
export const APP_VERSION = "0.2.0";
/** `runtime.json` in the config folder: pid, port and version of the running app, mode 0600. */
export const RUNTIME_FILE = "runtime.json";
/**
 * The macOS bundle id, stable across updates (DESIGN section 9). Once the app is signed with a
 * Developer ID, that keeps the microphone and system-audio grants across updates; while it is ad-hoc
 * signed, macOS keys a grant on each build's own signature, so an update may ask again
 * (docs/install.md, "Permissions"). The capture helper excludes every process this bundle is responsible for,
 * the WebKit GPU helper that plays the window's audio included (DESIGN 2.3).
 */
export const BUNDLE_ID = "io.github.geiserx.akou";
