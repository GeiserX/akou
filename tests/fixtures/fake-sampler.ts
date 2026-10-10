#!/usr/bin/env bun
/**
 * Stands in for `/usr/bin/sample` in the watchdog tests (DK-M8), run as the watchdog runs it:
 *
 *   bun tests/fixtures/fake-sampler.ts MODE [MS] PID SECONDS -file FILE
 *
 * - `fail`: exits 3 and writes nothing.
 * - `hang PIDFILE`: writes its own pid to PIDFILE and never ends.
 * - `slow MS`: after MS writes FILE, a cut-down sample whose main thread sits in the run loop,
 *   and exits 0.
 */

import { writeFileSync } from "node:fs";

const [mode, arg] = process.argv.slice(2) as [string, string];
const file = process.argv[process.argv.indexOf("-file") + 1] as string;
const pid = process.argv[process.argv.indexOf("-file") - 2];

const SAMPLE = `Analysis of sampling fixture (pid ${pid}) every 1 millisecond
Process:         fixture [${pid}]

Call graph:
    2346 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)
    + 2346 start  (in dyld) + 6992  [0x18c9ac4e4]
    +   2346 ???  (in bun)  load address 0x100870000 + 0x4a70  [0x100874a70]
    +     2300 -[NSApplication run]  (in AppKit) + 368  [0x19125d13c]
    +     ! 2300 mach_msg  (in libsystem_kernel.dylib) + 24  [0x18cd33fc0]
    +     !   2300 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x18cd3fba8]
    +     46 somewhere_else  (in libother.dylib) + 4  [0x18cd3fbb0]
    2346 Thread_2: Worker
    + 2346 thread_start  (in libsystem_pthread.dylib) + 8  [0x18cd72c1c]
    +   2346 kevent64  (in libsystem_kernel.dylib) + 8  [0x18cd3fba8]
`;

if (mode === "fail") process.exit(3);
else if (mode === "hang") {
  writeFileSync(arg, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  // clock: the sampling this fixture stands in for takes real time.
  setTimeout(() => {
    writeFileSync(file, SAMPLE);
    process.exit(0);
  }, Number(arg));
}
