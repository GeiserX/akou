/**
 * The outbound trust store (src/main/tls-trust.ts): the eMudhra roots leave Bun's store, nothing
 * else does, and every request that names no store of its own gets the filtered one.
 */

import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import tls from "node:tls";
import { DISTRUSTED_ROOTS, trustedRoots, withTrust } from "../src/main/tls-trust.ts";

const fingerprint = (pem: string) => new X509Certificate(pem).fingerprint256.replaceAll(":", "");
const EMSIGN_ECC_G3 = "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B";

describe("tls trust", () => {
  test("Bun's bundled store carries emSign ECC Root CA - G3 (positive control)", () => {
    expect(tls.rootCertificates.map(fingerprint)).toContain(EMSIGN_ECC_G3);
  });

  test("trustedRoots drops every distrusted root and keeps the rest", () => {
    const roots = tls.getCACertificates("default");
    const kept = trustedRoots(roots);
    const removed = roots.filter((pem) => DISTRUSTED_ROOTS.has(fingerprint(pem)));
    expect(removed.length).toBeGreaterThan(0);
    expect(kept.map(fingerprint)).not.toContain(EMSIGN_ECC_G3);
    expect(kept.length).toBe(roots.length - removed.length);
  });

  test("withTrust passes the store to a request that names none, and keeps the caller's own", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const base = (async (_: unknown, init?: RequestInit & { tls?: Record<string, unknown> }) => {
      seen.push(init?.tls);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const f = withTrust(base, ["ROOTS"]);
    await f("https://example.invalid/");
    await f("https://example.invalid/", { tls: { serverName: "a.example" } } as RequestInit);
    await f("https://example.invalid/", { tls: { ca: ["OWN"] } } as RequestInit);
    expect(seen).toEqual([
      { ca: ["ROOTS"] },
      { ca: ["ROOTS"], serverName: "a.example" },
      { ca: ["OWN"] },
    ]);
  });
});
