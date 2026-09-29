/**
 * The user's languages for dictation (akou-5v8, DC-E4, DC-N3): `dictation.languages` drawn as one
 * chip per language with a remove button, and a list to add another. The setup's languages step and
 * the Dictation page's Engine group both use it. `auto` dictation chooses among these, and the
 * language chip on the island and the draft box moves between them, so a bilingual user never picks
 * one before speaking.
 *
 * The languages offered are Qwen3-ASR's, the engine that takes a forced language; `fast` (Parakeet)
 * picks its own.
 */

import { QWEN_LANGUAGE_CODES } from "../main/asr/llama-catalog.ts";
import { h, replace } from "./dom.ts";

/** A language's name in English (`Spanish`), or its code when the browser has no name for it. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The languages the setup starts from: the saved `dictation.languages` as the user ordered them,
 * else the languages of calls (`asr.languages`) with the interface's language first when it is
 * among them, since it is the one most often spoken, else the interface's language alone (English
 * when akou has no engine for it).
 */
export function firstLanguages(
  own: readonly string[],
  asr: readonly string[],
  ui: string,
): string[] {
  if (own.length > 0) return [...own];
  const here = ui.toLowerCase().split(/[-_]/)[0] ?? "";
  if (asr.length === 0) return [QWEN_LANGUAGE_CODES.includes(here) ? here : "en"];
  return asr.includes(here) ? [here, ...asr.filter((c) => c !== here)] : [...asr];
}

/** The chips and the add list; `onChange` hears every change with the whole list. */
export class LanguageList {
  readonly root = h("div", { class: "dictation-languages" });
  private list: string[];

  constructor(
    initial: readonly string[],
    private readonly onChange: (list: string[]) => void,
    private readonly id = "dictation-languages",
  ) {
    this.list = [...new Set(initial)];
    this.root.id = id;
    this.draw();
  }

  value(): string[] {
    return [...this.list];
  }

  private set(next: string[]): void {
    this.list = next;
    this.draw();
    this.onChange(this.value());
  }

  private draw(): void {
    const chips = this.list.map((code) =>
      h(
        "li",
        { class: "language-chip", attrs: { "data-code": code } },
        h("span", {}, languageName(code)),
        h("small", { class: "hint" }, code.toUpperCase()),
        h(
          "button",
          {
            type: "button",
            class: "remove",
            attrs: { "aria-label": `Remove ${languageName(code)}`, title: "Remove" },
            on: { click: () => this.set(this.list.filter((c) => c !== code)) },
          },
          "×",
        ),
      ),
    );
    const left = QWEN_LANGUAGE_CODES.filter((c) => !this.list.includes(c)).sort((a, b) =>
      languageName(a).localeCompare(languageName(b)),
    );
    const add = h(
      "select",
      { id: `${this.id}-add`, attrs: { "aria-label": "Add a language" } },
      h("option", { value: "" }, "+ Add a language"),
      ...left.map((c) => h("option", { value: c }, languageName(c))),
    );
    add.addEventListener("change", () => {
      if (add.value) this.set([...this.list, add.value]);
    });
    replace(this.root, h("ul", { class: "language-chips" }, ...chips), add);
  }
}
