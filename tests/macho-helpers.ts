/**
 * The libraries a Mach-O file links, read from its load commands: the names `otool -L` prints after
 * the file's own id. Read in-process because `/usr/bin/otool` is an xcrun shim, and on a fresh CI
 * runner its first lookup took 0.4 to 2.8 s and once more than the 5 s test timeout, where Bun kills
 * the child and the test saw empty output (TRAPS "Native libraries missing from the bundle").
 */

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;

/** The load commands that name a library the file loads (not LC_ID_DYLIB, the file's own name). */
const LOAD_DYLIB_CMDS = new Set([
  0xc, // LC_LOAD_DYLIB
  0x80000018, // LC_LOAD_WEAK_DYLIB
  0x8000001f, // LC_REEXPORT_DYLIB
  0x20, // LC_LAZY_LOAD_DYLIB
  0x80000023, // LC_LOAD_UPWARD_DYLIB
]);

/** Throws on anything but a thin little-endian Mach-O, so a wrong file never reads as "links nothing". */
export function machoLinkedLibs(file: Uint8Array): string[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.byteLength < 28) throw new Error("not a Mach-O file: too short");
  const magic = view.getUint32(0, true);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) {
    throw new Error(`not a thin Mach-O file: magic 0x${magic.toString(16)}`);
  }
  const ncmds = view.getUint32(16, true);
  let at = magic === MH_MAGIC_64 ? 32 : 28;
  const libs: string[] = [];
  for (let i = 0; i < ncmds; i++) {
    if (at + 8 > file.byteLength) throw new Error(`load command ${i} runs past the file`);
    const cmd = view.getUint32(at, true);
    const size = view.getUint32(at + 4, true);
    if (size < 8 || at + size > file.byteLength) throw new Error(`load command ${i}: bad size ${size}`);
    if (LOAD_DYLIB_CMDS.has(cmd)) {
      const start = at + view.getUint32(at + 8, true);
      let end = start;
      while (end < at + size && file[end] !== 0) end++;
      libs.push(new TextDecoder().decode(file.subarray(start, end)));
    }
    at += size;
  }
  return libs;
}

/** A thin 64-bit Mach-O holding an LC_ID_DYLIB and one LC_LOAD_DYLIB per name, for controls. */
export function fakeMachoDylib(id: string, linked: readonly string[]): Uint8Array {
  const cmd = (type: number, name: string): Uint8Array => {
    const bytes = new TextEncoder().encode(name);
    const size = Math.ceil((24 + bytes.length + 1) / 8) * 8;
    const out = new Uint8Array(size);
    const v = new DataView(out.buffer);
    v.setUint32(0, type, true);
    v.setUint32(4, size, true);
    v.setUint32(8, 24, true); // dylib.name.offset; timestamp and versions stay 0
    out.set(bytes, 24);
    return out;
  };
  const cmds = [cmd(0xd, id), ...linked.map((name) => cmd(0xc, name))];
  const body = cmds.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(32 + body);
  const v = new DataView(out.buffer);
  v.setUint32(0, MH_MAGIC_64, true);
  v.setUint32(12, 6, true); // MH_DYLIB
  v.setUint32(16, cmds.length, true);
  v.setUint32(20, body, true);
  let at = 32;
  for (const c of cmds) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
