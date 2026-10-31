// Temporary (issue #491): the event loop's longest wait during a call's folder stage, the old
// synchronous one against the new one, on this machine's disk.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { LogWriter } from "../../src/core/log/writer.ts";
import { createCallFolder, createCallFolderAsync, ulid } from "../../src/main/call/folder.ts";

const base = process.argv[2] ?? "/tmp";
const label = process.argv[3] ?? base;
const n = Number(process.argv[4] ?? 50);
const root = mkdtempSync(join(base, "akou-diag-"));
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const created = (id: string) =>
  ({ type: "call.created", id, schema: 1, workspace: "w", title: "Call", tz, user: "", akou: "0" }) as const;

async function measure(stage: () => Promise<void> | void): Promise<{ stage: number; wait: number }> {
  let last = performance.now();
  let wait = 0;
  const tick = setInterval(() => {
    const t = performance.now();
    wait = Math.max(wait, t - last);
    last = t;
  }, 5);
  await Bun.sleep(12);
  const t0 = performance.now();
  await stage();
  const took = performance.now() - t0;
  await Bun.sleep(12);
  clearInterval(tick);
  return { stage: took, wait };
}

const rows: Record<string, { stage: number[]; wait: number[] }> = { old: { stage: [], wait: [] }, new: { stage: [], wait: [] } };
for (let i = 0; i < n; i++) {
  const o = await measure(() => {
    const dir = createCallFolder(root, "old", Date.now(), tz, `c${i}`);
    const w = LogWriter.open(dir);
    w.append(created(ulid(Date.now())));
    w.close();
  });
  rows.old.stage.push(o.stage);
  rows.old.wait.push(o.wait);
  const m = await measure(async () => {
    const dir = await createCallFolderAsync(root, "new", Date.now(), tz, `c${i}`);
    const { writer } = await LogWriter.create(dir, created(ulid(Date.now())));
    writer.close();
  });
  rows.new.stage.push(m.stage);
  rows.new.wait.push(m.wait);
}
const q = (a: number[], f: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))] ?? 0;
const r = (x: number) => Math.round(x);
for (const [k, v] of Object.entries(rows)) {
  console.log(
    `[${label}] ${k} n=${n} stage p50=${r(q(v.stage, 0.5))} max=${r(Math.max(...v.stage))} | loop wait p50=${r(q(v.wait, 0.5))} p95=${r(q(v.wait, 0.95))} max=${r(Math.max(...v.wait))}`,
  );
}
