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
