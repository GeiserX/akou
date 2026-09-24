/**
 * Start at login (docs/DESIGN.md sections 1.1 and 10, the `app.openAtLogin` setting): akou starts
 * with no window when the user logs in, so the tray and the hotkey are always there. The login
 * launch sets `AKOU_HEADLESS=1` in the environment (never an argument, which the launcher drops).
 *
 * - macOS: a LaunchAgent in `~/Library/LaunchAgents`, loaded by launchd at the next login.
 * - Linux: an XDG autostart entry in `~/.config/autostart`.
 * - Windows: the current user's `Run` key, through `reg.exe`.
 *
 * Nothing here needs an administrator, and turning it off removes exactly what turning it on
 * wrote.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOGIN_LABEL = "io.github.geiserx.akou.login";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "akou";
/** What marks a login item file as akou's own: the LaunchAgent label, the autostart name. */
const LOGIN_MARK = [LOGIN_LABEL, "Name=akou"] as const;

export interface LoginItemOptions {
  platform: string;
  home: string;
  /** The program to start: the app's executable inside its bundle. */
  program: string;
  /** Runs a command (Windows); tests pass a fake. */
  run?: (cmd: readonly string[]) => Promise<{ code: number; stdout: string }>;
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The file that holds the login item, or null on Windows (the registry holds it). */
export function loginItemPath(platform: string, home: string): string | null {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${LOGIN_LABEL}.plist`);
  if (platform === "win32") return null;
  return join(home, ".config", "autostart", "akou.desktop");
}

export function launchAgentPlist(program: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LOGIN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(program)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AKOU_HEADLESS</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

export function autostartDesktop(program: string): string {
  // The Exec key quotes per the Desktop Entry spec: backslash, quote, backtick and dollar escaped.
  const quoted = `"${program.replace(/(["`$\\])/g, "\\$1")}"`;
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=akou",
    "Comment=Record calls and question them live",
    `Exec=env AKOU_HEADLESS=1 ${quoted}`,
    "X-GNOME-Autostart-enabled=true",
    "NoDisplay=true",
    "",
  ].join("\n");
}

async function defaultRun(cmd: readonly string[]): Promise<{ code: number; stdout: string }> {
  const p = Bun.spawn([...cmd], { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(p.stdout).text();
  return { code: await p.exited, stdout };
}

export async function isLoginItem(o: LoginItemOptions): Promise<boolean> {
  const path = loginItemPath(o.platform, o.home);
  if (path)
    return (
      existsSync(path) &&
      readFileSync(path, "utf8").includes(LOGIN_MARK[o.platform === "darwin" ? 0 : 1])
    );
  const r = await (o.run ?? defaultRun)(["reg", "query", RUN_KEY, "/v", RUN_VALUE]);
  return r.code === 0 && r.stdout.includes(RUN_VALUE);
}

/** Turns the login item on or off. Returns what changed. */
export async function setLoginItem(enabled: boolean, o: LoginItemOptions): Promise<"on" | "off"> {
  const path = loginItemPath(o.platform, o.home);
  if (path) {
    if (enabled) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        o.platform === "darwin" ? launchAgentPlist(o.program) : autostartDesktop(o.program),
        {
          mode: 0o644,
        },
      );
    } else rmSync(path, { force: true });
    return enabled ? "on" : "off";
  }
  const run = o.run ?? defaultRun;
  const r = enabled
    ? await run([
        "reg",
        "add",
        RUN_KEY,
        "/v",
        RUN_VALUE,
        "/t",
        "REG_SZ",
        "/d",
        `cmd /c "set AKOU_HEADLESS=1&& start "" "${o.program}""`,
        "/f",
      ])
    : await run(["reg", "delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
  if (r.code !== 0 && enabled) throw new Error(`reg add failed (${r.code})`);
  return enabled ? "on" : "off";
}
