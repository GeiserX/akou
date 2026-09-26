/**
 * Speakers, the notepad and agent memory (docs/DESIGN.md sections 5.1, 5.5 and 6.1): `name`,
 * `note`, `remember`. Each write lands on the live call unless `--call` names one.
 */

import { bool, str } from "../args.ts";
import { api, type Command, callFlag, enc, finish, ref } from "../context.ts";
import { usage } from "./calls.ts";

const name: Command = {
  name: "name",
  summary: "Name a speaker, or merge and unmerge speakers",
  usage:
    "akou name SPK NAME… | akou name --merge A B | akou name --unmerge SPK   [-c CALL] [--json]",
  flags: {
    merge: { type: "boolean", desc: "merge speaker A into speaker B" },
    unmerge: { type: "boolean", desc: "undo a merge of this speaker" },
    call: callFlag("live"),
  },
  examples: ["akou name c2 Ben Carter", "akou name --merge c3 c2"],
  run: async (ctx, p) => {
    const [a, ...rest] = p.positional;
    if (bool(p, "merge")) {
      const b = rest[0];
      if (!a || !b || rest.length > 1) return usage(ctx, "name --merge needs two speakers: A B");
      const r = await api(ctx, "POST", `/calls/${ref(p)}/speakers/merge`, {
        body: { from: a, into: b },
      });
      return finish(ctx, r, (x) => `${x.from} merged into ${x.into}`);
    }
    if (bool(p, "unmerge")) {
      if (!a || rest.length > 0) return usage(ctx, "name --unmerge needs one speaker");
      const r = await api(ctx, "POST", `/calls/${ref(p)}/speakers/unmerge`, { body: { spk: a } });
      return finish(ctx, r, () => `${a} unmerged`);
    }
    const who = rest.join(" ").trim();
    if (!a || who === "") return usage(ctx, "name needs a speaker id and a name: name c2 Ben");
    const r = await api(ctx, "POST", `/calls/${ref(p)}/speakers`, { body: { spk: a, name: who } });
    return finish(ctx, r, (x) => `${x.spk} is ${x.name}`);
  },
};

const note: Command = {
  name: "note",
  summary: "Add a line to the call's notepad, or edit or delete one",
  usage: 'akou note "TEXT" | akou note --edit ID "TEXT" | akou note --del ID   [-c CALL] [--json]',
  flags: {
    call: callFlag("live"),
    edit: { type: "string", value: "ID", desc: "replace the text of this note" },
    del: { type: "string", value: "ID", desc: "delete this note" },
  },
  examples: ['akou note "ship on Friday"', 'akou note --edit n0001 "ship on Thursday"'],
  run: async (ctx, p) => {
    const text = p.positional.join(" ").trim();
    const del = str(p, "del");
    const edit = str(p, "edit");
    if (del !== undefined) {
      if (text !== "" || edit !== undefined) return usage(ctx, "note --del takes only the id");
      const r = await api(ctx, "DELETE", `/calls/${ref(p)}/notes/${enc(del)}`);
      return finish(ctx, r, () => `Deleted ${del}`);
    }
    if (text === "") return usage(ctx, "note needs text");
    if (edit !== undefined) {
      const r = await api(ctx, "PATCH", `/calls/${ref(p)}/notes/${enc(edit)}`, { body: { text } });
      return finish(ctx, r, (x) => `Edited ${x.note.id} (rev ${x.note.rev})`);
    }
    const r = await api(ctx, "POST", `/calls/${ref(p)}/notes`, { body: { text } });
    return finish(ctx, r, (x) => `Noted (${x.note.id})`);
  },
};

const remember: Command = {
  name: "remember",
  summary: "Keep a line for the agent's later turns, or retract one with --del",
  usage: 'akou remember "TEXT" | akou remember --del ID   [-c CALL] [--json]',
  flags: {
    del: { type: "string", value: "ID", desc: "retract this line" },
    call: callFlag("live"),
  },
  examples: ['akou remember "Ben owns the deploy"'],
  run: async (ctx, p) => {
    const del = str(p, "del");
    if (del !== undefined) {
      if (p.positional.length > 0) return usage(ctx, "remember --del takes only the id");
      const r = await api(ctx, "DELETE", `/calls/${ref(p)}/remember/${enc(del)}`);
      return finish(ctx, r, () => `Forgot ${del}`);
    }
    const text = p.positional.join(" ").trim();
    if (text === "") return usage(ctx, "remember needs text");
    const r = await api(ctx, "POST", `/calls/${ref(p)}/remember`, { body: { text } });
    return finish(ctx, r, (x) => `Remembered (${x.remember.id})`);
  },
};

export const noteCommands: Command[] = [name, note, remember];
