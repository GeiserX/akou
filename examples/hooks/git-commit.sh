#!/bin/sh
# akou post-call hook: commit a call's export into the Git repository that holds it.
#
# In config.json:
#   "hooks": [{"stage": "final.done", "command": "/path/to/git-commit.sh"},
#             {"stage": "enhanced", "command": "/path/to/git-commit.sh"}]
#
# akou gives the call as JSON on stdin. This reads `paths.exportMd` from it, so `export.dir` must
# be inside a Git repository. Needs `jq`. Set AKOU_GIT_PUSH=1 to push after committing.
set -eu

payload=$(cat)
md=$(printf '%s' "$payload" | jq -r '.paths.exportMd // empty')
title=$(printf '%s' "$payload" | jq -r '.call.title')
stage=${AKOU_STAGE:-$(printf '%s' "$payload" | jq -r '.stage')}

if [ -z "$md" ]; then
  echo "no export for this call (is export.dir set?); nothing to commit"
  exit 0
fi

dir=$(dirname "$md")
repo=$(git -C "$dir" rev-parse --show-toplevel)
name=$(basename "$md" .md)

git -C "$repo" add -- "$md" "$dir/attachments/$name"
if git -C "$repo" diff --cached --quiet; then
  echo "nothing changed"
  exit 0
fi
git -C "$repo" commit -m "call: $title ($stage)"
if [ "${AKOU_GIT_PUSH:-0}" = "1" ]; then
  git -C "$repo" push
fi
