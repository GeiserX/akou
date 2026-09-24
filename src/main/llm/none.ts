/**
 * No model (docs/DESIGN.md section 5.3): `none` answers nothing, and every other provider falls
 * back to the same thing when it cannot run: the excerpts of the call that matter for the
 * question, labelled as excerpts with the reason, never presented as an answer (TRAPS "Provider
 * unavailable answered with nothing").
 */

import { type Availability, type Provider, ProviderError } from "./provider.ts";

export class NoneProvider implements Provider {
  readonly id = "none" as const;

  async available(): Promise<Availability> {
    return {
      ok: false,
      kind: "missing",
      reason: "no provider is configured (provider.kind is none); akou shows excerpts only",
    };
  }

  async complete(): Promise<never> {
    throw new ProviderError("missing", "no provider is configured");
  }
}

export interface ExcerptBlock {
  /** `[15:41 Ben]` */
  citation: string;
  /** Rendered lines, `#l000031 15:41:07 Ben: …`. */
  lines: string[];
}

/** The first line of every excerpts-only reply: what it is, and why no model answered. */
export function excerptsLabel(reason: string): string {
  return `No model answered (${reason}). These are the parts of the call that match the question, not an answer:`;
}

/** The excerpts-only reply: the label, then each excerpt with its citation. */
export function excerptsText(reason: string, blocks: readonly ExcerptBlock[]): string {
  const body =
    blocks.length === 0
      ? ["(nothing in the call matches the question yet)"]
      : blocks.flatMap((b) => [b.citation, ...b.lines.map((l) => `  ${l}`)]);
  return [excerptsLabel(reason), "", ...body].join("\n");
}
