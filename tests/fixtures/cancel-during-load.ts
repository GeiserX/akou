/**
 * A job cancelled partway into Parakeet's load, in a process of its own (#408): on a Bun with
 * oven-sh/bun#45252, terminating the job Worker there aborts this whole process. Prints what
 * happened and exits 0 if the process outlived the load.
 *
 *   bun tests/fixtures/cancel-during-load.ts <models dir> <cache dir> <wav> <ms into the load>
 */

import { JobWorker } from "../../src/main/asr/finalize-worker.ts";
import { readUploadAudio } from "../../src/main/server/audio.ts";

const [dir, cacheDir, wav, into] = process.argv.slice(2) as [string, string, string, string];
const intoMs = Number(into);
const w = new JobWorker({ kind: "sherpa", dir, cacheDir });
const samples = await readUploadAudio(wav);
let settled = "";
const job = w.run({ samples, diarize: false, decode: null }).then(
  () => {
    settled = "done";
  },
  (e: Error) => {
    settled = `rejected: ${e.message}`;
  },
);

// The VAD loads in milliseconds and the recognizer in seconds: a load that is still running
// `intoMs` after it started is the recognizer's.
let since = 0;
for (;;) {
  if (settled) {
    console.log(`no load lasted ${intoMs} ms; the job ${settled}`);
    process.exit(2);
  }
  if (!w.loading()) since = 0;
  else if (!since) since = performance.now();
  else if (performance.now() - since >= intoMs) break;
  await Bun.sleep(2);
}
w.cancel();
await job;
console.log(`cancelled ${intoMs} ms into a load; the job ${settled}`);
// The doomed Worker finishes the load, parks and is terminated; this process must still be here.
while (w.loading()) await Bun.sleep(10);
await Bun.sleep(1000);
console.log("alive after the load returned");
