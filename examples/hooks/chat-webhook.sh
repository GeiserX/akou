#!/bin/sh
# akou post-call hook: post a call's enhanced notes to a chat incoming webhook (Slack, Mattermost,
# Discord with `/slack` on the URL, or anything else that takes `{"text": "…"}`).
#
# In config.json:
#   "hooks": [{"stage": "enhanced", "command": "/path/to/chat-webhook.sh"}]
#
# The webhook address comes from the environment, never from this file:
#   CHAT_WEBHOOK_URL=https://hooks.example.com/…
# Needs `jq` and `curl`.
set -eu

: "${CHAT_WEBHOOK_URL:?set CHAT_WEBHOOK_URL to the incoming webhook of your chat}"

payload=$(cat)
text=$(printf '%s' "$payload" | jq -r '
  "*" + .call.title + "* (" + .call.start + ", " + (.call.duration_min | tostring) + " min)\n\n"
  + (.enhancedMd // "No enhanced notes yet.")')

jq -n --arg text "$text" '{text: $text}' |
  curl -sS --fail --max-time 20 -H 'Content-Type: application/json' --data-binary @- "$CHAT_WEBHOOK_URL"
echo
