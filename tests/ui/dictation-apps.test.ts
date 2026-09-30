/**
 * The wait for the next dictation's app behind "Use the app I dictate into next" (docs/ux/
 * DICTATION.md DC-U9): the edges of `nextDictatedApp` a real dictation rarely reaches, over a fake
 * transport, and the page ending the wait when it closes. Nothing records, types, prompts or plays.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NEXT_APP_LABEL, NEXT_APP_WAITING, nextDictatedApp } from "../../src/ui/dictation-apps.ts";
import { ENABLE_KEY } from "../../src/ui/dictation-page.ts";
import type { Reply, Transport } from "../../src/ui/protocol.ts";
import { tempDir } from "../helpers.ts";
import {
  type DictationFixture,
  dictationFixture,
  UI_TIMEOUT,
  type UiRig,
  uiRig,
  until,
} from "./rig.ts";

/** A transport whose every `GET /dictations` is answered by `answer`, in order. */
function transport(answer: (path: string, n: number) => Promise<Reply>): {
  t: Transport;
  paths: string[];
} {
  const paths: string[] = [];
  const t = {
    kind: "browser",
    request: (_m: string, path: string) => {
      paths.push(path);
      return answer(path, paths.length);
    },
  } as unknown as Transport;
  return { t, paths };
}

/** Waits for `n` ms of real time: the wait polls on a real timer. */
const pause = (n: number) => new Promise((r) => setTimeout(r, n));

describe("DC-U9: waiting for the next dictation's app", () => {
  test("two dictations naming an app in one poll: the older one is the next dictation", async () => {
    const { t } = transport(async (path) =>
      path.includes("limit=1")
        ? { status: 200, body: { items: [{ at: 100, app: "com.example.old" }] } }
        : {
            status: 200,
            // Newest first, as the route lists them.
            body: {
              items: [
                { at: 300, app: "com.example.second" },
                { at: 250, app: "" },
                { at: 200, app: "com.example.first" },
                { at: 150, app: null },
              ],
            },
          },
    );
    const found: string[] = [];
    const failed: string[] = [];
    nextDictatedApp(
      t,
      (a) => found.push(a),
      (w) => failed.push(w),
      5,
    );
    await until(() => found.length > 0, 2000, "an app found");
    expect(found).toEqual(["com.example.first"]);
    expect(failed).toEqual([]);
  });

  test("a request that throws ends the wait with the reason, and nothing polls after", async () => {
    const { t, paths } = transport(async (path) => {
      if (path.includes("limit=1")) return { status: 200, body: { items: [] } };
      throw new Error("the app went away");
    });
    const found: string[] = [];
    const failed: string[] = [];
    nextDictatedApp(
      t,
      (a) => found.push(a),
      (w) => failed.push(w),
      5,
    );
    await until(() => failed.length > 0, 2000, "the failure said");
    expect(failed).toEqual(["the dictations could not be read: the app went away"]);
    const polls = paths.length;
    await pause(60);
    expect(paths.length).toBe(polls);
    expect(found).toEqual([]);
  });

  /** A transport whose polls hang until the test answers them. */
  function held(): { t: Transport; inFlight(): boolean; release(r: Reply): void } {
    let answer: ((r: Reply) => void) | null = null;
    const { t } = transport((path) =>
      path.includes("limit=1")
        ? Promise.resolve({ status: 200, body: { items: [] } })
        : new Promise<Reply>((r) => {
            answer = r;
          }),
    );
    return { t, inFlight: () => answer !== null, release: (r) => answer?.(r) };
  }

  test("a reply landing after stop hands over nothing", async () => {
    const late = { status: 200, body: { items: [{ at: 200, app: "com.example.late" }] } };
    const found: string[] = [];
    const failed: string[] = [];
    const a = held();
    const w = nextDictatedApp(
      a.t,
      (x) => found.push(x),
      (e) => failed.push(e),
      5,
    );
    await until(() => a.inFlight(), 2000, "a poll in flight");
    w.stop();
    a.release(late);
    await pause(30);
    expect(found).toEqual([]);
    expect(failed).toEqual([]);
    // Positive control: the same reply without the stop is handed over.
    const b = held();
    nextDictatedApp(
      b.t,
      (x) => found.push(x),
      (e) => failed.push(e),
      5,
    );
    await until(() => b.inFlight(), 2000, "a poll in flight");
    b.release(late);
    await until(() => found.length > 0, 2000, "the app handed over");
    expect(found).toEqual(["com.example.late"]);
  });
});

describe("DC-U9 on the Dictation page: closing it ends the wait", () => {
  let rig: UiRig;
  let t: ReturnType<typeof tempDir>;
  beforeAll(async () => {
    t = tempDir("akou-ui-dict-apps-wait-");
    rig = await uiRig({ home: t.dir });
  }, UI_TIMEOUT);
  afterAll(async () => {
    await rig?.close();
    t?.cleanup();
  });

  test(
    "leaving the page stops reading the dictation log; reopened, the button waits for nothing",
    async () => {
      let fx: DictationFixture | null = null;
      const page = await rig.open(undefined, {
        before: async (p) => {
          fx = await dictationFixture(p);
          fx.settings[ENABLE_KEY] = true;
        },
      });
      const reads: string[] = [];
      page.on("request", (r) => {
        const u = new URL(r.url());
        if (u.pathname.endsWith("/dictations")) reads.push(u.search);
      });
      await page.click("#dictation-open");
      await page.click("#page-dictation .apps-next");
      expect((await page.textContent("#page-dictation .apps-next-note"))?.trim()).toBe(
        NEXT_APP_WAITING,
      );
      // The newest dictation, then at least one poll after it.
      await until(() => reads.some((q) => q.includes("since=")), 5000, "a poll");
      await page.click("#calls-open");
      const at = reads.length;
      await page.waitForTimeout(2500);
      expect(reads.length).toBe(at);
      await page.click("#dictation-open");
      // The page draws itself again on open, with the button back on its label.
      await page.waitForFunction(
        (label) => document.querySelector("#page-dictation .apps-next")?.textContent === label,
        NEXT_APP_LABEL,
      );
      expect(reads.length).toBe(at);
      expect((fx as unknown as DictationFixture).patches).toHaveLength(0);
    },
    UI_TIMEOUT,
  );
});
