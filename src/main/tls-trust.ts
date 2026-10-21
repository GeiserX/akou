/**
 * The roots akou trusts for outbound TLS: Bun's own, minus the ones that anchor the eight eMudhra
 * (emSign) intermediates whose private keys were recoverable (revoked 2026-10-18 for key
 * compromise, https://emudhra.we-have-a-problem.com/). Anyone can mint a certificate for any name
 * under them, and revocation is never checked, so the only fix on the client is to stop trusting
 * the roots they chain to.
 *
 * Bun has no fix of its own (1.4.2 and 1.4.3 trust the chain with their bundled roots, with
 * `--use-system-ca`, and with `NODE_USE_SYSTEM_CA=1`), and its `fetch` ignores
 * `tls.setDefaultCACertificates`. It does honour a request's own `tls.ca`, so `installTrust` wraps
 * the global `fetch` to pass the filtered list on every request that sets none, and sets the same
 * list as the default for `node:https` and `node:tls`. The list starts from the process's default
 * store, so `NODE_EXTRA_CA_CERTS` and `--use-system-ca` keep working.
 */

import { X509Certificate } from "node:crypto";
import tls from "node:tls";

/** SHA-256 of each distrusted root, upper-case hex without colons. */
export const DISTRUSTED_ROOTS: ReadonlySet<string> = new Set([
  // emSign ECC Root CA - G3: cross-signs emSign Root TLS CA - G3, the intermediates' issuer.
  "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B",
  // emSign Root TLS CA - G3 and emSign Root CS CA - G3, should a store carry them as roots.
  "7DD78D5F4F13459A83DFF9ABBBA62EDBAF6F2D102BF257FD712F4D9F2746ED8D",
  "F2EDAAFF3D9B701FB4D14C9F285F8C0BAD90FC3BCC1FA07D47F4718EDABA34A5",
  // AAA Certificate Services (Sectigo): cross-signs every one of the eight.
  "D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4",
]);

/** `roots` (PEM) without the distrusted ones. */
export function trustedRoots(roots: readonly string[]): string[] {
  return roots.filter(
    (pem) => !DISTRUSTED_ROOTS.has(new X509Certificate(pem).fingerprint256.replaceAll(":", "")),
  );
}

/** `fetch` with `ca` as the trust store of every request that names none. */
export function withTrust(base: typeof fetch, ca: readonly string[]): typeof fetch {
  const wrapped = (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit & { tls?: Record<string, unknown> },
  ) => base(input, { ...init, tls: { ca, ...init?.tls } } as RequestInit);
  return Object.assign(wrapped, base);
}

let installed = false;

/** Applies the filtered store to this process; call it once, before the first connection. */
export function installTrust(): void {
  if (installed) return;
  installed = true;
  const ca = trustedRoots(tls.getCACertificates("default"));
  tls.setDefaultCACertificates(ca);
  globalThis.fetch = withTrust(globalThis.fetch, ca);
}
