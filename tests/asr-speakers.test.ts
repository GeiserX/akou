/**
 * Speaker labels (speakers.ts): live clusters, their persistence across parts, merge and unmerge,
 * and the final-to-live mapping.
 */

import { describe, expect, test } from "bun:test";
import {
  CENTROID_EVERY_MS,
  cosine,
  decodeVec,
  encodeVec,
  hungarianMax,
  LiveSpeakers,
  mapFinalToLive,
} from "../src/main/asr/speakers.ts";

const e = (...v: number[]) => Float32Array.from(v);

describe("live clusters", () => {
  test("a segment of 1 s or more joins the nearest cluster at 0.60, else starts c<N>", () => {
    const s = new LiveSpeakers();
    expect(s.assign(1, 0, 2, e(1, 0, 0))).toBe("c1");
    expect(s.assign(1, 3, 5, e(0.9, 0.1, 0))).toBe("c1");
    expect(s.assign(1, 6, 8, e(0, 1, 0))).toBe("c2");
    // Cosine 0.55 to c2: below the join threshold.
    expect(s.assign(1, 9, 11, e(0, 0.55, 0.835))).toBe("c3");
  });

  test("a short segment inherits the previous call speaker within 1 s, else c?", () => {
    const s = new LiveSpeakers();
    expect(s.assign(1, 0, 2, e(1, 0))).toBe("c1");
    expect(s.assign(1, 2.5, 2.9, null)).toBe("c1");
    expect(s.assign(1, 5, 5.5, null)).toBe("c?");
  });

  test("[T2.48, T3.10] Speaker numbers restart per part: centroids carry c2 into the next part", () => {
    const part1 = new LiveSpeakers();
    part1.assign(1, 0, 2, e(1, 0, 0));
    part1.assign(1, 3, 5, e(0, 1, 0));
    const written = part1.centroids(CENTROID_EVERY_MS, true);
    expect(written.map((w) => (w.type === "centroid" ? w.spk : ""))).toEqual(["c1", "c2"]);

    // A new app run restores from the log's speaker.centroid events.
    const part2 = new LiveSpeakers();
    part2.restore({
      centroids: written.flatMap((w) =>
        w.type === "centroid" ? [{ spk: w.spk, vec: w.vec }] : [],
      ),
    });
    expect(part2.assign(2, 0, 2, e(0.05, 1, 0))).toBe("c2");
    // A new voice continues the numbering, it does not restart at c1.
    expect(part2.assign(2, 3, 5, e(0, 0, 1))).toBe("c3");

    // Positive control: without the restore, the same voice is c1 again.
    const fresh = new LiveSpeakers();
    expect(fresh.assign(2, 0, 2, e(0.05, 1, 0))).toBe("c1");
  });

  test("centroids are written every five minutes, and all changed ones at a part end", () => {
    const s = new LiveSpeakers();
    s.assign(1, 0, 2, e(1, 0));
    expect(s.centroids(CENTROID_EVERY_MS)).toHaveLength(1);
    s.assign(1, 3, 5, e(1, 0.1));
    expect(s.centroids(CENTROID_EVERY_MS + 1000)).toEqual([]);
    expect(s.centroids(CENTROID_EVERY_MS + 2000, true)).toHaveLength(1);
    expect(s.centroids(CENTROID_EVERY_MS + 3000, true)).toEqual([]);
  });

  test("a centroid survives the base64 float32 round trip", () => {
    const v = e(0.25, -1.5, 3e-7);
    expect(decodeVec(encodeVec(v))).toEqual(v);
  });
});

describe("[judging] A wrong speaker merge with no way back", () => {
  test("converged clusters merge once; unmerge restores them and they are never merged again", () => {
    const s = new LiveSpeakers();
    s.assign(1, 0, 2, e(1, 0, 0));
    s.assign(1, 3, 5, e(0.45, 0.89, 0)); // cosine 0.45: its own cluster
    expect(s.merges()).toEqual([]);
    // c2 drifts toward c1 until the centroids are over 0.8 similar.
    for (let i = 0; i < 6; i++) s.assign(1, 6 + i * 2, 7.5 + i * 2, e(0.85, 0.53, 0));
    const m = s.merges();
    expect(m).toEqual([{ type: "merge", from: "c2", into: "c1" }]);
    // A merged-away cluster takes no segments.
    expect(s.assign(1, 30, 32, e(0.45, 0.89, 0))).toBe("c1");

    s.unmerge("c2", "c1");
    expect(s.assign(1, 33, 35, e(0.3, 0.95, 0))).toBe("c2");
    expect(s.merges()).toEqual([]);
  });

  test("an unmerged pair from the log is respected after a restore", () => {
    const s = new LiveSpeakers();
    s.restore({
      centroids: [
        { spk: "c1", vec: encodeVec(e(1, 0)) },
        { spk: "c2", vec: encodeVec(e(0.99, 0.1)) },
      ],
      unmerged: [{ from: "c2", into: "c1" }],
    });
    expect(s.merges()).toEqual([]);
    // Positive control: the same clusters with no unmerge history merge at once.
    const t = new LiveSpeakers();
    t.restore({
      centroids: [
        { spk: "c1", vec: encodeVec(e(1, 0)) },
        { spk: "c2", vec: encodeVec(e(0.99, 0.1)) },
      ],
    });
    expect(t.merges()).toHaveLength(1);
  });
});

describe("final clusters to live names", () => {
  test("the assignment is joint: each live cluster is used once, total overlap maximal", () => {
    // Greedy would give s0 -> c1 (10) and leave s1 with c2 (1); joint gives 9 + 9.
    expect(
      hungarianMax([
        [10, 9],
        [9, 1],
      ]),
    ).toEqual([1, 0]);
    expect(hungarianMax([[1, 2, 3]])).toEqual([2]);
    expect(hungarianMax([[5], [7]])).toEqual([-1, 0]);
  });

  test("60 % overlap or more is a map, below is a suggestion", () => {
    const m = mapFinalToLive(
      [
        { spk: "s0", t0: 0, t1: 10 },
        { spk: "s1", t0: 10, t1: 20 },
      ],
      [
        { spk: "c2", t0: 0, t1: 9 },
        { spk: "c1", t0: 10, t1: 15 },
        { spk: "c?", t0: 15, t1: 20 },
      ],
    );
    expect(m).toEqual([
      { final: "s0", live: "c2", overlap: 0.9, confirmed: true },
      { final: "s1", live: "c1", overlap: 0.5, confirmed: false },
    ]);
  });

  test("cosine of a zero vector is 0, never NaN", () => {
    expect(cosine(e(0, 0), e(1, 0))).toBe(0);
  });
});
