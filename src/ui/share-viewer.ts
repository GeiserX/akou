/**
 * The read-only viewer of a share link (docs/DESIGN.md section 8.3): `/s/<token>/` on the share
 * listener. It shows the call as the app renders it (names and vocabulary applied, echo removed),
 * the grey line still being spoken, and the notepad when the share includes it. It has no
 * controls and sends nothing but GETs. It reads like the window: it follows new lines only while
 * the reader is at the bottom (Back to live once scrolled up), `+` and `-` size the text, and a
 * row's time says how far into the call it was on hover.
 *
 * It follows with `EventSource`, which reconnects by itself and names the last event it got
 * (`Last-Event-ID`); the listener then sends only what changed since. Everything is drawn as text.
 */

import { h, replace } from "./dom.ts";
import { HueBook } from "./model.ts";
import { FontKeys, fillRow, intoTheCall, rowElement, ScrollPin } from "./transcript.ts";

interface SharedLine {
  id: string;
  seq: number;
  w0: number;
  ch: "mic" | "call";
  spk: string;
  speaker: string;
  time: string;
  text: string;
}

interface SharedNote {
  id: string;
  time: string;
  text: string;
  author: "human" | "agent";
}

const hues = new HueBook();
const rows = new Map<string, { el: HTMLElement; line: SharedLine }>();
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const pin = new ScrollPin($("scroller"), $("jump"));
new FontKeys();
/** When the call's first part started, for the time tooltip; null until the call has one. */
let start: number | null = null;

function order(a: SharedLine, b: SharedLine): number {
  if (a.w0 !== b.w0) return a.w0 - b.w0;
  if (a.ch !== b.ch) return a.ch === "mic" ? -1 : 1;
  return a.seq - b.seq;
}

function put(line: SharedLine): void {
  const cur = rows.get(line.id);
  const el = cur?.el ?? rowElement();
  fillRow(
    el,
    { ...line, timeTitle: start !== null ? intoTheCall(line.w0, start) : undefined },
    hues.hue(line.spk),
  );
  el.querySelector(".who")?.setAttribute("disabled", "");
  rows.set(line.id, { el, line });
  if (cur) return;
  // New lines almost always go last: walk back from the end to the one sort order's place.
  let at = $("lines").lastElementChild as HTMLElement | null;
  while (at && order(line, (rows.get(at.dataset.id ?? "") as { line: SharedLine }).line) < 0) {
    at = at.previousElementSibling as HTMLElement | null;
  }
  if (at) at.after(el);
  else $("lines").prepend(el);
}

function relabel(): void {
  let prev: string | undefined;
  for (const el of $("lines").children as unknown as Iterable<HTMLElement>) {
    el.classList.toggle("turn", el.dataset.spk !== prev);
    prev = el.dataset.spk;
  }
  $("empty").hidden = rows.size > 0;
  pin.follow();
}

function notes(list: SharedNote[] | undefined): void {
  const box = $("share-notes");
  box.hidden = !list;
  if (!list) return;
  replace(
    box,
    h("h2", {}, "Notes"),
    h(
      "ul",
      {},
      ...list.map((n) =>
        h(
          "li",
          { class: `note ${n.author}` },
          h("span", { class: "gutter" }, n.time),
          h("span", {}, n.text),
        ),
      ),
    ),
  );
}

function state(s: { state: string; live: boolean; start?: number | null }): void {
  if (start === null && typeof s.start === "number") {
    start = s.start;
    for (const { line } of [...rows.values()]) put(line);
  }
  document.body.classList.toggle("recording", s.live);
  document.body.classList.toggle("saved", !s.live);
  $("state").textContent = s.live ? "live" : s.state === "ended" ? "ended" : s.state;
}

const es = new EventSource("stream");
es.addEventListener("snapshot", (e) => {
  const d = JSON.parse((e as MessageEvent).data) as {
    title: string;
    zone: string;
    state: string;
    live: boolean;
    start?: number | null;
    lines: SharedLine[];
    notes?: SharedNote[];
  };
  start = typeof d.start === "number" ? d.start : null;
  rows.clear();
  $("lines").replaceChildren();
  $("title").textContent = d.title;
  $("meta").textContent = `Times are local, ${d.zone}. Read only.`;
  document.title = `${d.title} · akou (shared)`;
  for (const l of d.lines) put(l);
  relabel();
  notes(d.notes);
  state(d);
});
es.addEventListener("lines", (e) => {
  const d = JSON.parse((e as MessageEvent).data) as { lines: SharedLine[]; removed: string[] };
  for (const id of d.removed) {
    rows.get(id)?.el.remove();
    rows.delete(id);
  }
  for (const l of d.lines) put(l);
  relabel();
});
es.addEventListener("state", (e) => state(JSON.parse((e as MessageEvent).data)));
es.addEventListener("notes", (e) => notes(JSON.parse((e as MessageEvent).data).notes));
es.addEventListener("partial", (e) => {
  const list = JSON.parse((e as MessageEvent).data) as {
    ch: string;
    spk: string;
    speaker: string;
    time: string;
    text: string;
  }[];
  const box = $("partial");
  replace(
    box,
    ...list.map((p) => {
      const r = rowElement();
      r.classList.add("draft", "turn");
      fillRow(
        r,
        {
          id: `draft-${p.ch}`,
          time: p.time,
          spk: p.spk,
          speaker: p.speaker,
          text: p.text,
          ch: p.ch,
        },
        hues.hue(p.spk),
      );
      return r;
    }),
  );
  box.hidden = list.length === 0;
});
es.addEventListener("open", () => document.body.classList.remove("offline"));
es.addEventListener("error", () => {
  document.body.classList.add("offline");
  if (es.readyState === EventSource.CLOSED) $("state").textContent = "share ended";
});
