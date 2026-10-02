/**
 * The event feed's page (docs/ux/SERVER.md SV-E1): a completed event carries its result inline up
 * to 256 KB, so a page is cut by size as well as by count, and never held whole in memory.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FEED_PAGE_BYTES, JobStore } from "../src/main/server/store.ts";
import { tempDir } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function store(): JobStore {
  const t = tempDir("akou-feed-");
  const s = new JobStore(join(t.dir, "jobs.db"));
  cleanups.push(() => {
    s.close();
    t.cleanup();
  });
  return s;
}

/** A done job whose completed event carries `bytes` of text. */
function done(s: JobStore, bytes: number): void {
  const { job } = s.submit({
    key_id: "key_a",
    preset: "fast",
    language: "auto",
    keywords: [],
    diarize: false,
    callback_url: null,
    metadata: null,
    idempotency_key: null,
    file_sha256: "0".repeat(64),
    audio: "/nonexistent",
  });
  s.markRunning(job.id);
  const result = { job_id: job.id, status: "done", text: "x".repeat(bytes) };
  s.finish(job.id, { status: "done", result }, { type: "transcription.completed", data: result });
}

describe("SV-E1: a feed page is cut by size", () => {
  test("positive control: small events all come in one page", () => {
    const s = store();
    for (let i = 0; i < 5; i++) done(s, 1000);
    expect(s.events("key_a", 0, 500).length).toBe(5);
  });

  test("inline results past the page size end the page early, and the next page carries on", () => {
    const s = store();
    const big = Math.ceil(FEED_PAGE_BYTES / 3);
    for (let i = 0; i < 5; i++) done(s, big);
    const pages: number[] = [];
    let cursor = 0;
    for (let page = s.events("key_a", 0, 500); page.length > 0; ) {
      pages.push(page.length);
      cursor = page.at(-1)?.seq as number;
      page = s.events("key_a", cursor, 500);
    }
    // About three results fill a page, so it ends before five, and the pages together hold all.
    expect(pages[0]).toBeLessThan(5);
    expect(pages.reduce((a, b) => a + b, 0)).toBe(5);
  });

  test("one event larger than the page size still comes, alone", () => {
    const s = store();
    done(s, FEED_PAGE_BYTES + 10);
    done(s, 10);
    expect(s.events("key_a", 0, 500).length).toBe(1);
  });
});

/** A queued job of key_a; `quiet` makes it a synchronous call's. */
function queued(s: JobStore, o: { quiet?: boolean; metadata?: unknown } = {}) {
  return s.submit({
    key_id: "key_a",
    preset: "fast",
    language: "auto",
    keywords: [],
    diarize: false,
    callback_url: null,
    metadata: o.metadata ?? null,
    idempotency_key: null,
    file_sha256: "0".repeat(64),
    audio: "/nonexistent",
    quiet: o.quiet,
  }).job;
}

describe("SV-E1: a synchronous call's job writes nothing to the feed", () => {
  test("its end and its cancel add no event, while an ordinary job's do", () => {
    const s = store();
    const end = (id: string) => {
      s.markRunning(id);
      const result = { job_id: id, status: "done", text: "hello" };
      return s.finish(
        id,
        { status: "done", result },
        { type: "transcription.completed", data: result },
      );
    };
    const sync = queued(s, { quiet: true });
    // The end still happened: the job is done, with no event.
    expect(end(sync.id)).toEqual({ event: null });
    expect(s.job(sync.id)?.status).toBe("done");
    s.remove(queued(s, { quiet: true }).id);
    expect(s.events("key_a", 0, 500)).toEqual([]);
    // Positive control: the same two for an ordinary job write two events.
    expect(end(queued(s).id)?.event?.type).toBe("transcription.completed");
    s.remove(queued(s).id);
    expect(s.events("key_a", 0, 500).map((e) => e.type)).toEqual([
      "transcription.completed",
      "transcription.cancelled",
    ]);
  });
});

describe("SV-E3 and SV-J6: a cancelled event's metadata", () => {
  test("it carries the job's metadata until retention, then the id and state only", () => {
    const t = tempDir("akou-feed-");
    let now = 1_000_000;
    const s = new JobStore(join(t.dir, "jobs.db"), () => now);
    cleanups.push(() => {
      s.close();
      t.cleanup();
    });
    const job = queued(s, { metadata: { content_hash: "abc" } });
    s.remove(job.id);
    const data = () => s.events("key_a", 0, 500).map((e) => e.data);
    expect(data()).toEqual([
      { job_id: job.id, status: "cancelled", metadata: { content_hash: "abc" } },
    ]);
    expect(s.scrubCancelled(now)).toBe(0);
    now += 10;
    expect(s.scrubCancelled(now)).toBe(1);
    expect(data()).toEqual([{ job_id: job.id, status: "cancelled", deleted: true }]);
    expect(s.scrubCancelled(now)).toBe(0);
  });
});

describe("SV-E1: the feed's id", () => {
  test("made once with jobs.db: the same when it is opened again, a new one for a new file", () => {
    const t = tempDir("akou-feed-");
    cleanups.push(() => t.cleanup());
    const path = join(t.dir, "jobs.db");
    const first = new JobStore(path);
    const id = first.feedId;
    first.close();
    expect(id).toMatch(/^feed_[0-9a-f]{8}$/);
    const again = new JobStore(path);
    expect(again.feedId).toBe(id);
    again.close();
    const other = new JobStore(join(t.dir, "other.db"));
    expect(other.feedId).not.toBe(id);
    other.close();
  });
});
