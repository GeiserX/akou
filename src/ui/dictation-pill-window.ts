/**
 * The dictation pill's entry in ElectroBun (docs/ux/DICTATION.md DC-O1): the page in `pill.ts` over
 * typed RPC to the main process, which sends it only the shapes in `pill-protocol.ts`.
 */

import { Electroview } from "electrobun/view";
import { mountPill, type PillSink } from "./pill.ts";
import type { Chip, PillRpc, PillState } from "./pill-protocol.ts";

let sink: PillSink | null = null;

const rpc = Electroview.defineRPC<PillRpc>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      state: (s: PillState) => sink?.state(s),
      level: (l: { db: number }) => sink?.level(l),
      preview: (p: { text: string }) => sink?.preview(p),
      chip: (c: Chip) => sink?.chip(c),
    },
  },
});
new Electroview({ rpc });

sink = mountPill({
  control: (action) => void rpc.request.control({ action }).catch(() => {}),
  chip: (a) => void rpc.request.chip(a).catch(() => {}),
});

// A state sent before the handlers above existed is lost: pull the one in force now.
void rpc.request
  .state({})
  .then((s: unknown) => {
    if (typeof (s as { state?: unknown } | null)?.state === "string") sink?.state(s as PillState);
  })
  .catch(() => {});
