/**
 * The learn chip (docs/ux/DICTATION.md DC-L4), drawn in the pill after a direct insert and in the
 * draft box under the field. One chip at a time, holding every candidate of one dictation, with a
 * checkbox each when there are several. Learn, Not a word and a close; nothing else, and no sound.
 *
 * It closes by itself after 8 s, and closing or ignoring it answers `ignore`, which changes nothing
 * but akou's count. Learn answers `learn` with the ticked terms and leaves `Learned "…" (Undo)` up
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
}

const quoted = (s: string) => `"${s}"`;

export function mountChip(root: HTMLElement, answer: (a: ChipAnswer) => void): ChipView {
  let up: Chip | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const close = () => {
    clearTimeout(timer);
    up = null;
    root.hidden = true;
    replace(root);
  };

  const learned = (chip: Chip, terms: string[]) => {
    clearTimeout(timer);
    up = chip;
    root.dataset.mode = "learned";
    replace(
      root,
      h("span", { class: "chip-text" }, `Learned ${terms.map(quoted).join(", ")}`),
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
    timer = setTimeout(close, CHIP_UNDO_MS);
  };

  const ask = (chip: Chip) => {
    up = chip;
    root.dataset.mode = "ask";
    const many = chip.candidates.length > 1;
    const boxes = chip.candidates.map((c) =>
      h(
        "label",
        { class: "chip-candidate" },
        many ? h("input", { type: "checkbox", attrs: { checked: "", "data-term": c.term } }) : null,
        `${quoted(c.term)} (heard ${quoted(c.heard)})`,
      ),
    );
    const ticked = () =>
      many
        ? [...root.querySelectorAll<HTMLInputElement>("input[data-term]")]
            .filter((b) => b.checked)
            .map((b) => b.dataset.term as string)
        : chip.candidates.map((c) => c.term);
    const done = (action: ChipAnswer["action"], terms?: string[]) => {
      answer({ id: chip.id, action, ...(terms ? { terms } : {}) });
      if (action === "learn" && terms && terms.length > 0) learned(chip, terms);
      else close();
    };
    replace(
      root,
      many
        ? h("span", { class: "chip-text" }, "Learn these words?", ...boxes)
        : h("span", { class: "chip-text" }, "Learn ", ...boxes, "?"),
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
      h(
        "button",
        {
          id: "chip-close",
          type: "button",
          attrs: { "aria-label": "Close" },
          on: { click: () => done("ignore") },
        },
        "×",
      ),
    );
    root.hidden = false;
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
  };
}
