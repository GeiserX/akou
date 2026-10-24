/**
 * macOS keeps the large blocks a process frees in a cache of its own, and gives them back only
 * under memory pressure: after a model is released, `akou serve` kept about 560 MB of it for good.
 * `MallocLargeCache=0` in the environment turns the cache off, but libmalloc reads it only when
 * the process starts, and no call clears the cache later (`malloc_zone_pressure_relief` returns 0
 * and frees none of it). The app gets the variable from its bundle and its login item; a server
 * started any other way (a LaunchDaemon written before the variable was documented, a shell)
 * does not. So `akou serve` on macOS without it starts itself again, once, with it: `execve`
 * keeps the pid, the open files and the arguments, so launchd, a supervisor and the server lock
 * see the same process.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

/** The program and arguments to run again, or null when nothing needs to change. */
export function largeCacheReexec(o: {
  platform: string;
  env: Record<string, string | undefined>;
  argv: readonly string[];
  /** Bun's own flags before the entry (`--smol`), which `argv` does not carry. */
  execArgv?: readonly string[];
  execPath: string;
  compiled: boolean;
}): { path: string; args: string[]; env: string[] } | null {
  if (o.platform !== "darwin" || o.env.MallocLargeCache === "0") return null;
  if (o.argv[2] !== "serve") return null;
  // A compiled program's argv[1] is its own virtual entry, which `execve` must not pass on.
  const args = [
    o.execPath,
    ...(o.execArgv ?? []),
    ...(o.compiled ? [] : o.argv.slice(1, 2)),
    ...o.argv.slice(2),
  ];
  const env = Object.entries({ ...o.env, MallocLargeCache: "0" }).flatMap(([k, v]) =>
    v === undefined ? [] : [`${k}=${v}`],
  );
  return { path: o.execPath, args, env };
}

/** Replaces this process with `path args` under `env`. Returns only when that failed. */
export function execve(path: string, args: readonly string[], env: readonly string[]): number {
  const keep: unknown[] = [];
  const cstr = (s: string) => {
    const b = Buffer.from(`${s}\0`, "utf8");
    keep.push(b);
    return ptr(b);
  };
  const list = (xs: readonly string[]) => {
    const a = new BigUint64Array(xs.length + 1);
    xs.forEach((x, i) => {
      a[i] = BigInt(cstr(x));
    });
    keep.push(a);
    return ptr(a);
  };
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const r = libc.symbols.execve(cstr(path), list(args), list(env));
  // The strings had to outlive the call; on success nothing returns here at all.
  keep.length = 0;
  libc.close();
  return r;
}
