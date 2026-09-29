/**
 * The remote akou on the Dictation page (docs/ux/DICTATION.md section 7.2), drawn in the Engine
 * section in app mode while "Use another computer running akou" is on:
 *
 * - DC-R4, the Test button: `GET /dictation/remote-test` asks the remote in `dictation.remote.url`
 *   with the saved key, and its one summary line is shown as it came: `ok, best on cpu, no
 *   biasing, 40 ms`, the queue warning of an akou with no dictation lane, or the refusal (a wrong
 *   key shows `401: ...`; the answer never carries the key).
 * - DC-R3, the remote's standing from `GET /dictation` while `dictation.engine` is `remote`: that
 *   the fallback resolves to `error` because no local model is installed, and that the remote is
 *   down after three dictations in a row, with the reason, until it answers again.
 *
 * The page never talks to the remote itself: both requests go to this akou, which alone knows the
 * key and checks the address before any request leaves.
 */

import type { RemoteTest } from "../main/dictation/remote.ts";
import { h, replace } from "./dom.ts";
import { message } from "./notepad.ts";
import type { Transport } from "./protocol.ts";

/** What `GET /dictation` says about the remote while `dictation.engine` is `remote`. */
export interface RemoteReply {
  /** `dictation.remote.fallback` as it applies: `error` with no local model to fall back to. */
  fallback?: "local" | "error" | null;
  remote?: { url: string; down: boolean; failures: number; error: string | null } | null;
}

/** What the page shows about the remote's standing, or null when there is nothing to say. */
export function remoteStanding(reply: RemoteReply | null, fallbackSetting: unknown): string | null {
  const remote = reply?.remote;
  if (!remote) return null;
  const lines: string[] = [];
  if (remote.down) {
    const why = remote.error ? `: ${remote.error}` : "";
    lines.push(
      `The remote akou is down: ${remote.failures} dictations in a row failed${why}. akou checks it every 30 s and clears this once it answers.`,
    );
  }
  if (reply?.fallback === "error" && fallbackSetting === "local") {
    lines.push(
      "No local model is installed, so a dictation the remote akou does not answer ends in an error instead of falling back.",
    );
  }
  return lines.length > 0 ? lines.join(" ") : null;
}

/**
 * The Test button, its result and the remote's standing, for the page to place: the button beside
 * the time limit, the result and the standing under it.
 */
export function remoteParts(
  t: Transport,
  fallbackSetting: () => unknown,
  /** Text from akou in the page's words: a setting it names by its key gets its label. */
  words: (text: string) => string = (x) => x,
): { test: HTMLButtonElement; result: HTMLElement; standing: HTMLElement } {
  const result = h("output", {
    id: "dictation-remote-result",
    class: "pg-help",
    attrs: { role: "status" },
  });
  const standing = h("p", { id: "dictation-remote-standing", class: "issue", hidden: true });
  const readStanding = async () => {
    const r = await t.request<RemoteReply>("GET", "/dictation");
    const line = r.status < 400 ? remoteStanding(r.body ?? null, fallbackSetting()) : null;
    standing.textContent = line ?? "";
    standing.hidden = line === null;
  };
  const test = h(
    "button",
    {
      type: "button",
      id: "dictation-remote-test",
      class: "pg-btn",
      on: {
        click: async () => {
          test.disabled = true;
          result.className = "pg-help";
          replace(result, "Testing the other computer...");
          try {
            const r = await t.request<RemoteTest>("GET", "/dictation/remote-test");
            const ok = r.status === 200 && r.body?.ok === true;
            result.className = ok ? "pg-help" : "issue";
            replace(
              result,
              words(
                r.status === 200 && typeof r.body?.summary === "string"
                  ? r.body.summary
                  : message(r.body, `the test could not run (HTTP ${r.status})`),
              ),
            );
            // A test that reached the remote is as fresh as the standing gets.
            void readStanding();
          } finally {
            test.disabled = false;
          }
        },
      },
    },
    "Test",
  );
  void readStanding();
  return { test, result, standing };
}
