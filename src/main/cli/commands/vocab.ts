/**
 * The custom vocabulary from the command line (docs/DESIGN.md sections 5.4 and 6.1):
 *
 *   akou vocab list [-w WS] [--call ID] [--unconfirmed]
 *   akou vocab add TERM [--heard a,b] [--call ID | -w WS] [--no-decode] [--note TEXT]
 *   akou vocab remove TERM [-w WS]  |  akou vocab remove --call ID VID
 *   akou vocab approve|reject TERM… [--call ID] [-w WS]
 *   akou vocab suggest [--text TEXT] [--call ID] [-k N]
 *   akou vocab check TERM
 *   akou vocab import FILE [-w WS]
 *   akou vocab pass [CALL]
 *
 * `list --call ID --unconfirmed` is the words to review for that call: its open proposals, with the
 * lines each rests on, and the workspace's unconfirmed entries. `pass` runs the post-call pass on
 * the configured provider (the last call by default) and prints what it corrected and proposed.
 *
 * `add` with `--call` is a call-scoped `vocab.add` (mid-call, applies at once); without it the word
 * goes into the workspace file (or the global one). A term the API refuses exits 65.
 */

import { readFileSync } from "node:fs";
import { bool, int, list, str } from "../args.ts";
import { EXIT } from "../client.ts";
import { api, type Body, type Command, callFlag, enc, finish, ref } from "../context.ts";
import { usage } from "./calls.ts";

function entryLine(e: Body): string {
  const heard = e.heard?.length ? ` (heard: ${e.heard.join(", ")})` : "";
  const flags = [
    e.confirmed === false ? "unconfirmed" : "",
    e.decode === false ? "no decode" : "",
    e.scope ?? "",
  ].filter((x) => x !== "");
  return `${e.term}${heard}${flags.length ? `  [${flags.join(", ")}]` : ""}`;
}

/** The words to review, one block per proposal with the lines it rests on. */
export function reviewText(review: Body | undefined): string {
  const out: string[] = [];
  for (const pr of review?.proposals ?? []) {
    const heard = pr.heard?.length ? ` (heard: ${pr.heard.join(", ")})` : "";
    out.push(`${pr.term}${heard}${pr.why ? `  (${pr.why})` : ""}`);
    for (const l of pr.lines ?? []) out.push(`    ${l.time} ${l.speaker}: ${l.text}`);
  }
  for (const e of review?.unconfirmed ?? [])
    out.push(`${entryLine(e)}  [unconfirmed, ${e.source}]`);
  if (out.length === 0) return "No words to review.";
  out.push(
    "",
    "Approve with `akou vocab approve TERM --call ID`, reject with `akou vocab reject TERM --call ID`.",
  );
  return out.join("\n");
}

function passText(b: Body): string {
  const out: string[] = [];
  for (const c of b.corrections ?? []) {
    out.push(`Corrected "${c.heard}" to ${c.term} in ${c.lines.length} line(s)`);
  }
  for (const pr of b.proposals ?? []) {
    out.push(`Proposed ${pr.term}${pr.heard?.length ? ` (heard: ${pr.heard.join(", ")})` : ""}`);
  }
  if (b.dropped?.length) out.push(`Dropped ${b.dropped.length} item(s) the check refused`);
  if (out.length === 0) out.push("Nothing to correct or propose.");
  if (b.proposals?.length) {
    out.push(`Review them with \`akou vocab list --call ${b.call} --unconfirmed\`.`);
  }
  return out.join("\n");
}

export const vocab: Command = {
  name: "vocab",
  summary:
    "The custom vocabulary: list, add, remove, approve, reject, suggest, check, import, pass",
  usage:
    "akou vocab list|add|remove|approve|reject|suggest|check|import|pass … [-c CALL] [-w WS] [--json]",
  flags: {
    workspace: { type: "string", short: "w", value: "WS", desc: "the workspace's list" },
    call: {
      ...callFlag("none: the workspace list"),
      desc: "a call's own words instead of the workspace list (live, last or a call id)",
    },
    unconfirmed: { type: "boolean", desc: "list: only the words waiting for your yes" },
    heard: { type: "string", value: "A,B", desc: "add: how the recognizer mishears it" },
    "no-decode": {
      type: "boolean",
      desc: "add: correct it when read, but do not bias the recognizer",
    },
    note: { type: "string", value: "TEXT", desc: "add: a note kept with the entry" },
    text: { type: "string", value: "TEXT", desc: "suggest: propose words from this text" },
    k: { type: "string", short: "k", value: "N", desc: "suggest: at most N words" },
  },
  examples: [
    "akou vocab list -w work",
    "akou vocab list -c last --unconfirmed",
    "akou vocab add Hetzner --heard hetzna,hetsner -w work",
    "akou vocab add Kubernetes -c live",
    "akou vocab remove Hetzner -w work",
    "akou vocab approve Hetzner -c last",
    "akou vocab reject Hetsner -c last",
    'akou vocab suggest --text "we deploy on Hetzner with Terraform" -k 5',
    "akou vocab check Hetzner",
    "akou vocab import glossary.txt -w work",
    "akou vocab pass last",
  ],
  run: async (ctx, p) => {
    const [sub, ...args] = p.positional;
    const ws = str(p, "workspace");
    const call = str(p, "call");
    switch (sub) {
      case "list": {
        const r = call
          ? await api(ctx, "GET", `/calls/${enc(call)}/vocab`)
          : await api(ctx, "GET", "/vocab", {
              query: { workspace: ws, unconfirmed: bool(p, "unconfirmed") || undefined },
            });
        if (call && bool(p, "unconfirmed")) {
          return finish(ctx, r, (b) => reviewText(b.review));
        }
        return finish(ctx, r, (b) => {
          const out: string[] = [];
          for (const e of b.callVocab ?? []) out.push(`${entryLine(e)}  [call, ${e.id}]`);
          for (const pr of b.proposals ?? []) out.push(`${pr.term}  [proposed, ${pr.status}]`);
          for (const e of b.entries ?? []) out.push(entryLine(e));
          return out.length > 0 ? out.join("\n") : "No entries.";
        });
      }
      case "add": {
        const term = args.join(" ").trim();
        if (term === "") return usage(ctx, "vocab add needs a term");
        if (call && ws) return usage(ctx, "vocab add takes --call or -w, not both");
        const heard = list(p, "heard");
        const decode = bool(p, "no-decode") ? false : undefined;
        const r = call
          ? await api(ctx, "POST", `/calls/${enc(call)}/vocab`, { body: { term, heard, decode } })
          : await api(ctx, "POST", "/vocab", {
              body: { term, heard, workspace: ws, decode, note: str(p, "note") },
            });
        return finish(ctx, r, (b) =>
          call ? `Added ${term} to call ${b.call} (${b.vocab.id})` : `Added ${term} to ${b.path}`,
        );
      }
      case "remove": {
        const what = args.join(" ").trim();
        if (what === "")
          return usage(ctx, "vocab remove needs a term (or an entry id with --call)");
        const r = call
          ? await api(ctx, "DELETE", `/calls/${enc(call)}/vocab/${enc(what)}`)
          : await api(ctx, "DELETE", `/vocab/${enc(what)}`, { query: { workspace: ws } });
        return finish(ctx, r, () => `Removed ${what}`);
      }
      case "approve":
      case "reject": {
        if (args.length === 0) return usage(ctx, `vocab ${sub} needs at least one term`);
        const r = await api(ctx, "POST", `/vocab/${sub}`, {
          body: { terms: args, call, workspace: ws },
        });
        return finish(ctx, r, (b) => {
          const done: string[] = b.approved ?? b.rejected ?? [];
          return done.length > 0
            ? `${sub === "approve" ? "Approved" : "Rejected"}: ${done.join(", ")}`
            : "Nothing matched.";
        });
      }
      case "suggest": {
        const r = await api(ctx, "POST", "/vocab/suggest", {
          body: { text: str(p, "text"), call, k: int(p, "k", 1, 200) },
        });
        return finish(ctx, r, (b) => JSON.stringify(b, null, 2));
      }
      case "check": {
        const term = args.join(" ").trim();
        if (term === "") return usage(ctx, "vocab check needs a term");
        const r = await api(ctx, "POST", "/vocab/check", { body: { term } });
        return finish(ctx, r, (b) => JSON.stringify(b, null, 2));
      }
      case "import": {
        const file = args[0];
        if (!file || args.length > 1) return usage(ctx, "vocab import needs one file");
        let text: string;
        try {
          text = readFileSync(file, "utf8");
        } catch (err) {
          ctx.io.err(`akou: cannot read ${file}: ${(err as Error).message}`);
          return EXIT.usage;
        }
        const r = await api(ctx, "POST", "/vocab/import", { body: { text, workspace: ws } });
        return finish(
          ctx,
          r,
          (b) =>
            `Imported ${b.imported} into ${b.path}${b.skipped?.length ? `; skipped ${b.skipped.length}` : ""}`,
        );
      }
      case "pass": {
        const target = args[0] ? enc(args[0]) : ref(p, "last");
        const r = await api(ctx, "POST", `/calls/${target}/vocab/pass`, {
          // A long call is checked batch by batch, one provider call after another.
          timeoutMs: 60 * 60_000,
          signal: ctx.io.signal,
        });
        return finish(ctx, r, passText);
      }
      default:
        return usage(
          ctx,
          `vocab needs one of list, add, remove, approve, reject, suggest, check, import, pass`,
        );
    }
  },
};
