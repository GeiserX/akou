/**
 * The notification policy (docs/ux/DESKTOP.md section 8): which events reach Notification Center,
 * the toast or the Linux notification daemon, with what words. One pure function, so it is
 * table-tested; the shell calls it and shows what it returns.
 *
 * - **Only information.** ElectroBun's notifications have no buttons; every action is in the tray,
 *   the window or the CLI.
 * - **No call content, ever** (DK-N4). Notifications show on the lock screen and in screenshots, so
 *   a title and a body are fixed strings chosen by the event's kind. No title, workspace, name,
 *   note or transcript word reaches this function, and nothing here would print one.
 * - **Quiet while the window is in front**, except the rows marked Always: a call started from
 *   anything but the window, a refused start, a share an agent started. An unseen start is a
 *   privacy hole; a banner in the window already says the rest.
 * - **Once a minute** at most per event and call: `key` is what the shell deduplicates on. A new
 *   capture state is a new event, so a `permission-suspect` right after a `dead` still shows.
 */

/** The door a start came through. The window writes as `user`; agents, the CLI included, as `agent:<client>`. */
export type StartOrigin = "window" | "tray" | "hotkey" | "cli" | "agent";

export type NotifyEvent =
  | { type: "started"; call: string; origin: StartOrigin }
  | { type: "refused"; code: string; origin: StartOrigin }
  | { type: "shared"; call: string; origin: StartOrigin }
  | { type: "capture"; call: string; ch: "mic" | "call"; state: string };

export interface NotifyContext {
  /** The main window exists and has focus. */
  windowFocused: boolean;
  platform: string;
}

export interface Notice {
  title: string;
  body: string;
  /** The same key within `DEDUP_MS` notifies once. */
  key: string;
}

export const DEDUP_MS = 60_000;

/** The window's download card, by the words on its button (`src/ui/models-text.ts`). */
const MODELS_BUTTON = "Download speech models";

/** Which door an author's start came through. */
export function originOf(by: string): StartOrigin {
  if (by === "user") return "window";
  return by === "agent:cli" ? "cli" : "agent";
}

function startedBy(origin: StartOrigin, platform: string): string {
  switch (origin) {
    case "agent":
      return "Started by an agent";
    case "cli":
      return "Started from the command line";
    case "hotkey":
      return "Started from the hotkey";
    default:
      return platform === "darwin" ? "Started from the menu bar" : "Started from the tray";
  }
}

/** Where the privacy switches are, in the words each OS uses. */
function privacyPane(platform: string, what: string): string {
  if (platform === "darwin") return `System Settings > Privacy & Security > ${what}`;
  if (platform === "win32") return "Settings > Privacy > Microphone";
  return "your system's sound settings";
}

/** Why a start was refused, naming what fixes it. Fixed strings: nothing from the call. */
function refusal(code: string, platform: string): string {
  switch (code) {
    case "models_missing":
      return `The speech models are not downloaded yet. Use "${MODELS_BUTTON}" in the akou window.`;
    case "permission": {
      // Two panes on macOS, and the refusal does not say which channel it was.
      const where =
        platform === "darwin"
          ? "System Settings > Privacy & Security, under Microphone and under System Audio Recording"
          : privacyPane(platform, "Microphone");
      return `akou is not allowed to record. Allow it in ${where}.`;
    }
    case "already_recording":
      return "A call is already recording.";
    case "capture_failed":
      return "The audio capture did not start. Press Record in the akou window to try again.";
    case "quitting":
      return "akou is quitting.";
    default:
      // A refusal code is a fixed word from the app, never call content.
      return /^[a-z_]+$/.test(code)
        ? `akou refused the start (${code}).`
        : "akou refused the start.";
  }
}

/** Capture states that mean nothing is being recorded on that channel. */
const SILENT: Readonly<Record<string, (platform: string, ch: "mic" | "call") => string>> = {
  dead: () => "akou is rebuilding the capture.",
  stalled: () => "akou is restarting the capture.",
  "permission-suspect": (platform, ch) =>
    `Check that akou is allowed in ${privacyPane(platform, ch === "call" ? "System Audio Recording" : "Microphone")}.`,
};

/** What to show for an event, or null for nothing. */
export function notifyFor(e: NotifyEvent, ctx: NotifyContext): Notice | null {
  switch (e.type) {
    case "started":
      if (e.origin === "window") return null;
      return {
        title: "Recording started",
        body: startedBy(e.origin, ctx.platform),
        key: `started:${e.call}`,
      };
    case "refused":
      // The window says it in place.
      if (e.origin === "window") return null;
      return {
        title: "Could not start recording",
        body: refusal(e.code, ctx.platform),
        key: `refused:${e.origin}:${e.code}`,
      };
    case "shared":
      if (e.origin === "window") return null;
      return {
        title: "This call is shared live",
        body: "Stop it from the akou window.",
        key: `shared:${e.call}`,
      };
    case "capture": {
      const body = SILENT[e.state];
      if (!body || ctx.windowFocused) return null;
      return {
        title: e.ch === "call" ? "Call side silent" : "Microphone silent",
        body: body(ctx.platform, e.ch),
        key: `capture:${e.call}:${e.ch}:${e.state}`,
      };
    }
  }
}
