# Fixing a word on the live line, and telling the agent

Two rules for fixing a word disagree. W9.3 in [WINDOW](../WINDOW.md#9-vocabulary) says a fix on a line only proposes a vocabulary entry, and nothing is written until Approve. What shipped in [#186](https://github.com/GeiserX/akou/pull/186) does the opposite: a fix learns the word at once, spreads it through the call, and offers Undo. This page says what akou does today, lists the choices, and ends with what we decided. It also covers the two things W9.3 never had: fixing a word by clicking it on the live transcript, and telling a following agent when the vocabulary changes.

## What happens today

### Opening the fix

You cannot click a word to fix it. A click on a line's text does nothing, because the transcript's click handler only acts on the speaker chip, the play button and the Fix button (`src/ui/transcript.ts:423`). A line is fixed in one of two ways:

- **The Fix button.** Each committed line has a small Fix button at its right edge (`src/ui/transcript.ts:337`). It is hidden until the pointer is over the line or the line has focus (`src/ui/theme.css:1944`, `src/ui/theme.css:1952`).
- **The line menu.** Right-click, `Shift+F10` or the Menu key, then "Fix this line…" (`src/ui/app.ts:1235`).

If you select a word first, say by double-clicking it, the popover opens with that word already selected in the field (`src/ui/app.ts:1443`). The grey line still being spoken cannot be fixed. It sits in its own box outside the list of lines, and only that list listens for clicks (`src/ui/transcript.ts:197`).

The popover holds the whole line in one field, with the hint "Change what akou got wrong, then press Enter. A name or term is fixed on every line of this call; other words only here." (`src/ui/app.ts:1396`). You edit the text and press Enter. The window sends `POST /calls/{id}/fix {line, text, rev}` (`src/ui/app.ts:1382`). If the in-call rewrite changed the line while the popover was open, the server answers 409 and the popover shows the new text (`src/main/api/routes/fix.ts:219`).

### What gets written

The server lines up your text with the line's raw text, word by word, and turns each change into a pair: heard form and term (`src/main/api/routes/fix.ts:228`, `src/core/vocab/fix.ts:327`). Each pair is either a term or a rewording.

- **A term** is a name, product or jargon word: `versal` to `Vercel`. It is learned with no review step.
  - It goes into the call's vocabulary as a `vocab.add` event in the call log (`src/core/log/events.ts:266`).
  - It goes into the workspace's vocabulary file as a confirmed entry with `source: correction` (`src/main/api/routes/fix.ts:433`, `src/main/api/routes/fix.ts:461`). A call with no workspace writes to the global file. Later calls read the entry and decode with it.
  - When the heard form is not a common word, every line of the call with that form reads corrected at once, and the file keeps the heard form (`src/main/api/routes/fix.ts:280`, `src/core/vocab/fix.ts:359`). When the heard form is a common word, as in `mark` to `Marc`, only that word on that line changes. The term still goes into the file, with no heard form.
- **A rewording** is a change of common words: `to` to `and`, `three` to `3`, `go` to `Go`. It changes only that one word on that line and is never learned into a file.

A rewording always goes into the call's Notes as `Fixed: to -> and`, marked "from a fix" (`src/main/api/routes/fix.ts:320`, `src/main/api/routes/fix.ts:337`, `src/core/log/events.ts:195`). A term goes there too whenever the engine transcribing the call takes no word list (`src/main/index.ts:1836`). That covers the default setup, Parakeet decoding greedy, so on a default install a learned term also leaves a Notes line.

### Undo and taking a fix back

- **The toast.** After a fix, a quiet toast says what happened, for example "Learned Vercel: 4 lines fixed. Added to Notes." (`src/ui/app.ts:1447`, `src/ui/app.ts:1470`). Its Undo button stays for 10 seconds (`src/ui/dom.ts:112`). Undo retracts the call's entries, deletes the note and takes the word, or only the heard form the fix added, back out of the file (`src/ui/app.ts:1481`, `src/main/api/routes/fix.ts:358`).
- **Writing the heard word back.** After the toast is gone, you can open Fix on a corrected line and type the heard word back, `versal` where it reads `Vercel`. That retracts the call's entry and removes the heard form from the file (`src/main/api/routes/fix.ts:233`, `src/main/api/routes/fix.ts:111`). The term itself stays in the file with no heard form (`src/main/api/routes/fix.ts:151`), so later calls still decode with it and still match it loosely.
- **Removing the term for good.** The window cannot do this for a workspace word. The Words page edits only the global file, and a call's workspace words are listed read-only (WINDOW W9.2, `docs/ux/WINDOW.md:321`). What is left is `akou vocab remove` with `-w`, or editing the file by hand.
- **Renaming.** There is no rename. The server aligns against the raw text, not against what the line shows, so fixing `Vercel` to `Vercel.com` adds a second term for `versal`, and the file then holds both (`src/main/api/routes/fix.ts:228`, `src/main/api/routes/fix.ts:433`).

### What an agent sees

- **The agent that made the fix itself.** `akou_vocab_add` with `scope: "call"` goes through the same route, and its answer says what was learned and noted (`src/main/mcp/server.ts:790`).
- **An agent on the event stream**, `GET /calls/{id}/stream`, gets every log event: the `vocab.add` and, when there is one, the fix's note (`src/main/api/routes/follow.ts:289`). It also gets `read` events with the new text of every line the fix changed (`src/main/api/routes/follow.ts:186`, `src/main/api/routes/follow.ts:292`). Nothing on the stream says the word was also written to the workspace file.
- **An agent following with `akou_read` or `akou tail -f`** is not told. `akou_read` returns lines whose own events came after the cursor (`src/main/api/routes/follow.ts:461`, `src/main/mcp/server.ts:511`, `src/main/cli/commands/follow.ts:92`). A `vocab.add` changes how lines render but not when they last changed (`src/core/log/fold.ts:709`, `src/core/log/fold.ts:731`). So the lines the agent already read still say `versal` in its context, new lines arrive as `Vercel`, and nothing says why.
- **An agent asking with `akou_context`** gets lines shown as `Vercel (heard: "versal")`, and a "Vocabulary in these lines" block (`src/main/query/context.ts:635`). It sees the right spelling, but not that the user just taught it.

## What W9.3 asked for, and where #186 disagrees

W9.3 says it this way (`docs/ux/WINDOW.md:322`, bead akou-b6y.50): editing `versal` to `Vercel` on a line adds a pending proposal to "Words to review", and nothing is written to the vocabulary until Approve. It came from how VoiceInk, Descript and Wispr handle it, and it depends on W4.9's inline line edit, bead akou-b6y.17, which is not built.

#186, merged as fc5b837, went the other way on purpose, so that one fix makes the whole call read right. They disagree on three points.

| | W9.3 | Today, after #186 |
|---|---|---|
| The rest of the call | Unchanged until Approve | Corrected at once, when the heard form is not a common word |
| The workspace file | Written on Approve | Written at once, `confirmed`, `source: correction` |
| Where a wrong fix is caught | In the review dialog, before it counts | In the toast (10 s Undo), or later by writing the heard word back |

[DESIGN 5.4](../../DESIGN.md#54-the-live-query-engine) already follows #186, in these words: "a fix on a line (below) is the user's own word and goes in at once, while the post-call pass and the skill write `vocab.propose`" (`docs/DESIGN.md:532`). W9.3 is the only place left that says otherwise.

Dictation works differently. After a fix in the draft box, a chip asks `Learn "Kubernetes"?`, and ignoring it leaves the word in To review. That is DC-L4 and DC-L5 in [DICTATION](../DICTATION.md), `docs/ux/DICTATION.md:381`. The setting `dictation.learn` picks `ask`, the default, or `auto` or `off` (`src/main/config/schema.ts:846`). Dictation keeps asking. The window does not, as decided below.

## The choices

| | What it is | Per fix, the user does | An agent reads | What can go wrong | Size |
|---|---|---|---|---|---|
| **A** | Keep #186 as it is, close W9.3 | Fix, Enter. Undo within 10 s if wrong | Nothing new. On `akou_read`, earlier lines stay wrong in its context | A wrong fix spreads to the whole call and the workspace file, and the only sign is a 10 s toast. The agent keeps using the old spelling | 2 docs, no code |
| **B, chosen** | A, plus a notice: a `vocab.learned` event in the call log and a `learned` field on the next read answer. The toast with Undo stays as it is | The same as A | Every read after the fix says which term was learned or taken back, and that earlier lines changed | A wrong fix still spreads, but the agent sees it and can say so. The agent gets one more line per fix | About 9 source files, 3 docs, 2 test files |
| **C** | W9.3 as written: a fix proposes, Approve writes | Fix, Enter, then open Words to review and press Approve for each term | Nothing until Approve, then the call's vocabulary changes | A queue nobody approves. Until Approve the rest of the call reads wrong, which undoes "fix once". #186's tests assert the opposite and have to be rewritten | About 5 source files, 3 docs, 3 test files |
| **D** | B, plus a setting to choose between add-and-tell (B) and propose (C) | B or C, depending on the setting | As B, or as C | Two behaviours to build, test and document, and a user who forgets which one is on. akou has no per-workspace settings today, so this is either the first one or a global setting shaped like `dictation.learn` | B and C together, plus the setting and its page: the largest |

The sizes are estimates from the files each change would touch, not from a written diff.

## The click flow

The ask is to click the word on the live transcript, type the right form and press Enter, and have the vocabulary change. We open the fix on a double-click.

1. **Double-click a word** on any committed line, live or final. The fix popover opens next to that word, with the line in the field and the double-clicked word already selected. A single click does nothing new, so it still places the cursor and starts a selection. A drag still selects text for copying and opens nothing. The grey line still being spoken stays unclickable until it is committed.
2. **Type the right form** over the selection and press Enter. Esc, or a click outside, closes the popover as it does today.
3. **Everything after that is today's route.** The same `POST /calls/{id}/fix {line, text, rev}`, the same term and rewording rules, the same toast with Undo. The Fix button and the line menu stay for keyboard users.

This is today's fix with one step fewer. Nobody has to select the word and then find the Fix button. It also covers W4.9's inline edit. That row wanted to change a line while keeping the raw text, and a fix already keeps the raw text in the log.

"Modify the vocabulary" from that popover means three things:

- **Add.** A misheard word fixed to a term, as today.
- **Rename.** When the clicked word already reads corrected, say `Vercel` heard as `versal`, the popover says so in one line above the field: `Vercel, heard "versal", learned from a fix`. Typing another spelling renames that term: the call's entry gets a new revision, and the file entry takes the new term and keeps its heard forms. Today this adds a second term instead.
- **Remove.** The same line has a Forget button. It takes the term out of the call and out of the file it was learned into, the way Undo does, whenever you press it. Typing the heard word back keeps working as it does now.

A rewording is not a vocabulary change. It still goes to Notes as `Fixed: to -> and`, as today.

## The notice to the agent

Two pieces. Both follow what the log and the read answers already do.

**A log event, `vocab.learned`.** It is written once for each term a fix learns into a file. It is a log event, not a stream-only one like `partial` or `read`, because an agent that reconnects or compacts has to get it back from the backlog. It reaches every follower the way other log events do: `event: event` on the stream (`src/main/api/routes/follow.ts:289`), and the long-polled `/events`. It follows the pattern of `vocab.add`: an `id` and a `rev`, and a revision with `term: null` retracts it (`src/core/log/events.ts:266`).

```json
{ "type": "vocab.learned", "id": "l3", "rev": 1, "term": "Vercel", "heard": ["versal"],
  "by": "user", "lines": 4, "kept": "workspace", "vocab": ["v12"] }
```

- `kept` is `workspace`, `global` or `call`, meaning where the term will be used from now on.
- `vocab` lists the call's `vocab.add` ids it came with.
- Undo, Forget and writing the heard word back each write a revision with `term: null`. A rename writes a revision with the new `term` and `was: "Vercel"`.

The `vocab.add` already in the log says the call reads the word. What it cannot say is whether the word was kept for later calls, which is why this is a separate event. Without one, the read field below could be built from `vocab.add` alone, but it would not know what was kept.

**A field on read answers.** `GET /calls/{id}/transcript` with `since` is what `akou_read` and `akou tail -f` use. It gains a `learned` field: the `vocab.learned` events after the cursor, newest last. Like `unreviewed`, it is left out when there is nothing to report (`src/main/api/routes/follow.ts:593`).

```json
"learned": [
  { "term": "Vercel", "heard": ["versal"], "by": "user", "time": "15:41:07", "lines": 4, "kept": "workspace" },
  { "term": null, "was": "Hetzner", "heard": ["hetzna"], "by": "user", "time": "15:43:10" }
]
```

The `akou_read` text adds one line per item, built the way `unreviewedNote` builds its line (`src/main/mcp/server.ts:1296`, `src/main/mcp/server.ts:554`):

```
The user taught akou "Vercel" (heard "versal") at 15:41:07: 4 lines now read Vercel, lines you read before included. Spell it that way.
The user took back "Hetzner" at 15:43:10: those lines read "hetzna" again.
```

`akou_context` has no cursor, so it lists the terms learned or taken back from fixes in this call, newest first and at most five. They go in akou's notes to the agent, outside the call text (`src/main/query/context.ts:758`), next to the stale-memo note. `by` stays in each item, so an agent can tell its own `akou_vocab_add` from the user's fix.

The window needs nothing new for the notice. The toast with Undo already tells the person.

## What we decided

We keep what [#186](https://github.com/GeiserX/akou/pull/186) does, and we tell the agent. A fix learns the term at once, spreads it through the call when the heard form is not a common word, and shows the toast with Undo. Nothing waits for an Approve.

We tell the agent in both ways: the `vocab.learned` event in the call log, and the `learned` field on read answers. The event comes back to an agent that reconnects or compacts. The field reaches an agent that follows with `akou_read` or `akou tail`.

A learned term goes to the call and to the workspace file at once, as today. A call with no workspace writes it to the global file.

We closed W9.3 as superseded by this page, along with its bead, akou-b6y.50. One new bead, akou-5e1, carries the notice, the double-click, the rename and Forget.

A double-click on a word opens the fix. A single click does nothing new. The Fix button and the line menu stay for the keyboard.

We would look at the file side again if workspace files come to be shared with other people, since a silent add would then change their calls too. The same goes if wrong terms learned from fixes turn up often enough that Undo and Forget stop being enough.
