/**
 * The draft box's entry in ElectroBun (docs/ux/DICTATION.md DC-S1): the page in `draft.ts` over
 * typed RPC to the main process (`dictation-protocol.ts`).
 */

import { Electroview } from "electrobun/view";
import type { DraftOpen, DraftRpc } from "./dictation-protocol.ts";
import { type DraftSink, mountDraft } from "./draft.ts";
import type { Chip } from "./pill-protocol.ts";

let sink: DraftSink | null = null;

const rpc = Electroview.defineRPC<DraftRpc>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      open: (d: DraftOpen) => sink?.open(d),
      chip: (c: Chip) => sink?.chip(c),
    },
  },
});
new Electroview({ rpc });

const quiet = (p: Promise<unknown>) => void p.catch(() => {});
sink = mountDraft({
  insert: (p) => quiet(rpc.request.insert(p)),
  discard: (p) => quiet(rpc.request.discard(p)),
  copy: (p) => quiet(rpc.request.copy(p)),
  retry: (p) => quiet(rpc.request.retry(p)),
  language: (p) => rpc.request.language(p).catch(() => false),
  chip: (a) => quiet(rpc.request.chip(a)),
});
