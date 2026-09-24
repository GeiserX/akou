/**
 * Facts about the app that its thin clients (the CLI, the MCP server) need without loading the
 * app itself: the version and the name of the file a running app announces itself in.
 */

/** The one version, stamped from `package.json` at release (DESIGN section 9). */
export const APP_VERSION = "0.0.0";
/** `runtime.json` in the config folder: pid, port and version of the running app, mode 0600. */
export const RUNTIME_FILE = "runtime.json";
