# PG-K1: where Codex reads the akou skill

The question from [PROGRAMMABILITY.md](../ux/PROGRAMMABILITY.md) PG-K1: akou writes the Codex skill to `$CODEX_HOME/skills`, and Codex's docs name `~/.agents/skills`. Does the pinned Codex load the skill from where akou writes it?

Checked folder: `$CODEX_HOME/skills (default ~/.codex/skills)`
Result: pass

`tests/skill.test.ts` pins `SKILLS_HOME.codex` in `src/main/cli/commands/skill.ts` to the folder on the "Checked folder" line, and fails if either one changes without the other.

## Answer

Codex 0.151.0 loads user skills from both folders. A skill that `akou skill install --harness codex` writes into `$CODEX_HOME/skills` appears in the skill list Codex gives the model, and so does the same skill copied into `~/.agents/skills` alone. So akou's folder is correct, and the other folder is not a failing control: it works too.

akou keeps `$CODEX_HOME/skills`. It follows `CODEX_HOME` when the user moves Codex's home, and it is where Codex's own skill installer writes (the bundled `skill-installer` skill installs into `$CODEX_HOME/skills`, defaulting to `~/.codex/skills`). Writing both folders would list every akou skill twice.

The control that can fail is a folder Codex does not read: the same skills in `~/.codex/skills` while `CODEX_HOME` points somewhere else. They do not appear. A clean home shows no akou skill either.

## The check

- Date: 2026-09-25. akou 0.0.0 from source (`bun src/main/cli/cli.ts`), branch `feat/agents-cli-p0`.
- `codex-cli 0.151.0` on an Apple silicon Mac with macOS 27.0, a development machine rather than the reference Mac mini. Nothing here depends on the hardware, but the run on the reference Mac mini is still open.
- Every case ran in a throwaway `HOME` (`$T/<case>`) with its own `CODEX_HOME`, so no real Codex config was read or changed. The install ran with a `PATH` that has no `codex`, so it registered nothing and only printed the `codex mcp add` line.
- "Shows in Codex's skill list" means the skill is in the prompt Codex builds for the model: `codex debug prompt-input` prints that prompt without calling a model, and its "Available skills" section lists each skill with the file it came from.

The script that reads the list:

```sh
#!/bin/sh
# Usage: check.sh HOME_DIR CODEX_HOME_DIR
# Prints each akou skill in the prompt Codex builds for the model, with the file it names.
mkdir -p "$1/work"
cd "$1/work" && HOME="$1" CODEX_HOME="$2" codex debug prompt-input "hi" | python3 -c '
import re, sys
s = sys.stdin.read().replace("\\n", "\n")
roots = dict(re.findall(r"- `(r\d+)` = `([^`]*)`", s))
for name, root, rest in sorted(set(re.findall(r"- (akou(?:-vocab)?): [^\n]*?\(file: (r\d+)/([^)]*SKILL\.md)\)", s))):
    print(f"{name}: {roots.get(root, root)}/{rest}")
'
```

The cases:

```sh
# A: akou's install, CODEX_HOME unset
HOME=$T/A PATH=/usr/bin:/bin SHELL= bun src/main/cli/cli.ts skill install --harness codex
./check.sh $T/A $T/A/.codex
# B: akou's install with CODEX_HOME set
HOME=$T/B CODEX_HOME=$T/B/ch PATH=/usr/bin:/bin SHELL= bun src/main/cli/cli.ts skill install --harness codex
./check.sh $T/B $T/B/ch
# C (control): the same skills in ~/.codex/skills while CODEX_HOME points elsewhere
mkdir -p $T/C/.codex $T/C/ch && cp -R $T/A/.codex/skills $T/C/.codex/skills
./check.sh $T/C $T/C/ch
# D (baseline): a clean home
mkdir -p $T/D/.codex && ./check.sh $T/D $T/D/.codex
# E (the other folder): the same skills only in ~/.agents/skills
mkdir -p $T/E/.codex $T/E/.agents && cp -R $T/A/.codex/skills $T/E/.agents/skills
./check.sh $T/E $T/E/.codex
```

## Output

The install, case A:

```
$T/A/.codex/skills/akou: installed version 0.0.0
$T/A/.codex/skills/akou-vocab: installed version 0.0.0
Codex was not found; to give it the akou tools, run: codex mcp add akou -- <bun> <checkout>/src/main/cli/cli.ts mcp
```

What Codex listed:

```
== A
akou: $T/A/.codex/skills/akou/SKILL.md
akou-vocab: $T/A/.codex/skills/akou-vocab/SKILL.md
== B
akou: $T/B/ch/skills/akou/SKILL.md
akou-vocab: $T/B/ch/skills/akou-vocab/SKILL.md
== C
== D
== E
akou: $T/E/.agents/skills/akou/SKILL.md
akou-vocab: $T/E/.agents/skills/akou-vocab/SKILL.md
```

An earlier run with two probe skills of different names, one in each folder of the same home, listed both, each with scope `user`, through the app server's `skills/list`.

## Summary

- Codex 0.151.0 reads user skills from `$CODEX_HOME/skills` and from `~/.agents/skills`. akou writes the first, and Codex lists the akou skills from there, with `CODEX_HOME` unset and set.
- The acceptance's control, the other folder, also shows, so it cannot fail. The control that did fail is a copy that ignores `CODEX_HOME`.
- Still open: the same run on the reference Mac mini. Re-run this check when the pinned Codex version changes.
