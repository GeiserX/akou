/**
 * The dictation pill's entry in ElectroBun (docs/ux/DICTATION.md DC-O1): the page in `pill.ts` over
 * typed RPC to the main process, which sends it only the shapes in `pill-protocol.ts`.
 */

import { Electroview } from "electrobun/view";
import { mountPill, type PillSink } from "./pill.ts";
import type { Chip, PillRpc, PillState } from "./pill-protocol.ts";

let sink: PillSink | null = null;
/** A state was pushed: it is newer than any answer to the boot-time pull still on its way. */
let pushed = false;

const rpc = Electroview.defineRPC<PillRpc>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      state: (s: PillState) => {
        pushed = true;
        sink?.state(s);
      },
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
  size: (height) => void rpc.request.size({ height }).catch(() => {}),
});

// The edge the window was opened on: the page mirrors at the bottom (H-11).
void rpc.request
  .layout({})
  .then((l: unknown) => {
    const edge = (l as { edge?: unknown } | null)?.edge;
    if (typeof edge === "string") sink?.layout({ edge });
  })
  .catch(() => {});

// A state sent before the handlers above existed is lost: pull the one in force now, unless a
// newer one is pushed while the answer is on its way.
void rpc.request
  .state({})
  .then((s: unknown) => {
    if (pushed) return;
    if (typeof (s as { state?: unknown } | null)?.state === "string") sink?.state(s as PillState);
  })
  .catch(() => {});
