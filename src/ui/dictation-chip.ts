/**
 * The learn chip (docs/ux/DICTATION.md DC-L4), drawn in the pill after a direct insert and in the
 * draft box under the field. One chip at a time, holding every candidate of one dictation, with a
 * checkbox each when there are several. Learn and Not a word; nothing else, and no sound.
 *
 * It closes by itself after 8 s, and ignoring it answers `ignore`, which changes nothing but akou's
 * count. Learn answers `learn` with the ticked terms and leaves `Learned "…" (Undo)` up
 * for 6 s; Undo answers `undo`. With `dictation.learn` `auto` the chip arrives as `learned`: the
 * entries are written already and only the Undo line shows.
 *
 * A chip that arrives while one is up is not shown: the main side sends one per dictation and waits
 * for the answer, so a second one is a bug there, never a reason to drop the first.
 */

import { h, replace } from "./dom.ts";
import type { Chip, ChipAnswer } from "./pill-protocol.ts";

export const CHIP_ASK_MS = 8000;
export const CHIP_UNDO_MS = 6000;

export interface ChipView {
  show(chip: Chip): void;
  /** Something is up (the question or the Undo line). */
  busy(): boolean;
  /** Takes the chip down for the next dictation: an unanswered question answers `ignore`. */
  dismiss(): void;
}

const quoted = (s: string) => `"${s}"`;

/**
 * `changed` hears whenever the chip goes up or down, so the pill can show or hide what holds it.
 */
export function mountChip(
  root: HTMLElement,
  answer: (a: ChipAnswer) => void,
  changed: (up: boolean) => void = () => {},
): ChipView {
  let up: Chip | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drop: (() => void) | null = null;

  const close = () => {
    clearTimeout(timer);
    up = null;
    drop = null;
    root.hidden = true;
    replace(root);
    changed(false);
  };

  const learned = (chip: Chip, terms: string[]) => {
    clearTimeout(timer);
    up = chip;
    drop = close;
    root.dataset.mode = "learned";
    replace(
      root,
      h(
        "span",
        { class: "chip-text" },
        h("span", { class: "chip-q" }, `Learned ${terms.map(quoted).join(", ")}`),
      ),
      h(
        "button",
        {
          id: "chip-undo",
          type: "button",
          on: {
            click: () => {
              answer({ id: chip.id, action: "undo", terms });
              close();
            },
          },
        },
        "Undo",
      ),
    );
    root.hidden = false;
    changed(true);
    // clock: how long the Undo chip stays on screen.
    timer = setTimeout(close, CHIP_UNDO_MS);
  };

  const ask = (chip: Chip) => {
    up = chip;
    root.dataset.mode = "ask";
    drop = () => done("ignore");
    const many = chip.candidates.length > 1;
    const boxes = chip.candidates.map((c) =>
      h(
        "label",
        { class: "chip-candidate" },
        many
          ? h("input", {
              type: "checkbox",
              attrs: { checked: "", "data-term": c.term },
              on: { change: () => untick() },
            })
          : null,
        h(
          "span",
          { class: "chip-label", title: `${c.term} (heard ${c.heard})` },
          `${quoted(c.term)} (heard ${quoted(c.heard)})`,
        ),
      ),
    );
    const only = chip.candidates[0] as Chip["candidates"][number];
    const ticked = () =>
      many
        ? [...root.querySelectorAll<HTMLInputElement>("input[data-term]")]
            .filter((b) => b.checked)
            .map((b) => b.dataset.term as string)
        : chip.candidates.map((c) => c.term);
    // Learn and Not a word answer for the ticked terms, so with none ticked there is nothing to send.
    const untick = () => {
      const none = ticked().length === 0;
      for (const id of ["chip-learn", "chip-reject"])
        root.querySelector<HTMLButtonElement>(`#${id}`)?.toggleAttribute("disabled", none);
    };
    const done = (action: ChipAnswer["action"], terms?: string[]) => {
      answer({ id: chip.id, action, ...(terms ? { terms } : {}) });
      if (action === "learn" && terms && terms.length > 0) learned(chip, terms);
      else close();
    };
    replace(
      root,
      many
        ? h(
            "span",
            { class: "chip-text" },
            h("span", { class: "chip-q" }, "Learn these words?"),
            ...boxes,
          )
        : h(
            "span",
            { class: "chip-text" },
            h("span", { class: "chip-q" }, `Learn ${quoted(only.term)}?`),
            h("span", { class: "chip-w" }, "You changed ", h("s", {}, only.heard)),
          ),
      h(
        "button",
        { id: "chip-learn", type: "button", on: { click: () => done("learn", ticked()) } },
        "Learn",
      ),
      h(
        "button",
        { id: "chip-reject", type: "button", on: { click: () => done("reject", ticked()) } },
        "Not a word",
      ),
    );
    root.hidden = false;
    changed(true);
    // clock: how long the question chip stays on screen.
    timer = setTimeout(() => done("ignore"), CHIP_ASK_MS);
  };

  return {
    show: (chip) => {
      if (up || chip.candidates.length === 0) return;
      if (chip.mode === "learned")
        learned(
          chip,
          chip.candidates.map((c) => c.term),
        );
      else ask(chip);
    },
    busy: () => up !== null,
    dismiss: () => drop?.(),
  };
}
